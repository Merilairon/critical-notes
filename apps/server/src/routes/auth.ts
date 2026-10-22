import { and, count, eq, ne } from 'drizzle-orm';
import { Hono } from 'hono';
import { changePasswordInput, loginInput, redeemResetInput, registerWithInviteInput, setupInput, updateMeInput, type MeDto, type ResetInfoDto } from '@cn/shared';
import type { AppDb } from '../db';
import { sessions, users } from '../db/schema';
import { createSession, destroySession, endUserSessions, hashToken, rejectTokenScope, requireUser, SESSION_COOKIE, type AppEnv } from '../auth/session';
import { getCookie } from 'hono/cookie';
import { HttpError, badRequest, forbidden, unauthorized, validate } from '../lib/http';
import { newId } from '../lib/ids';
import { hashPassword, verifyPassword } from '../lib/password';
import { createClientKey, RateLimiter } from '../lib/rate-limit';
import { audit } from '../lib/audit';
import { findLiveReset, redeemReset } from '../services/users';

/** Invite handling the auth routes need (implemented by the campaign service). */
export interface InviteGate {
  assertInviteUsable(token: string): void;
  acceptInvite(token: string, userId: string): string;
}

export function authRoutes(db: AppDb, opts: { secureCookies: boolean; trustProxy?: boolean; invites?: InviteGate }) {
  const app = new Hono<AppEnv>();
  /** Per caller address + username, 8 a minute. */
  const limiter = new RateLimiter(8, 60_000);
  /** Failures per username whatever the address, so rotating addresses (or a spoofed header) does not help. */
  const userBudget = new RateLimiter(30, 15 * 60_000);
  const passwordLimiter = new RateLimiter(5, 60_000);
  /** Failed reset lookups only (a token that is not live), 30 per 10 minutes per caller key. A live token is never refused or counted. */
  const resetBudget = new RateLimiter(30, 10 * 60_000);
  const clientKey = createClientKey(opts.trustProxy === true);
  const userCount = () => db.select({ n: count() }).from(users).get()?.n ?? 0;

  app.get('/me', (c) => c.json<MeDto>({ user: c.get('user'), setupRequired: userCount() === 0 }));

  /** First-run: create the admin account. Only works while there are no users. */
  app.post('/setup', validate('json', setupInput), async (c) => {
    if (userCount() > 0) throw badRequest('Setup has already been completed');
    const input = c.req.valid('json');
    const id = newId();
    db.insert(users)
      .values({ id, username: input.username.toLowerCase(), displayName: input.displayName, passwordHash: await hashPassword(input.password), isAdmin: true })
      .run();
    createSession(db, c, id, opts.secureCookies);
    return c.json({ ok: true }, 201);
  });

  app.post('/login', validate('json', loginInput), async (c) => {
    const { username, password } = c.req.valid('json');
    const name = username.toLowerCase();
    const key = `${clientKey(c)}|${name}`;
    limiter.hit(key);
    userBudget.assert(name);
    const user = db.select().from(users).where(eq(users.username, username.toLowerCase())).get();
    // Always verify against a hash to keep timing similar for unknown users
    const ok = await verifyPassword(user?.passwordHash ?? '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$0000000000000000000000000000000000000000000', password);
    if (!user || !ok) {
      userBudget.fail(name);
      throw unauthorized('Wrong username or password');
    }
    // Only after the right password, so this reveals nothing to someone who does not have it.
    if (user.disabledAt !== null) throw forbidden('This account is disabled. Ask the host.');
    limiter.clear(key);
    userBudget.clear(name);
    createSession(db, c, user.id, opts.secureCookies);
    return c.json({ ok: true });
  });

  /** Creates an account through a campaign invite link (there is no open sign-up), signs in and joins. */
  app.post('/register', validate('json', registerWithInviteInput), async (c) => {
    const { token, username, displayName, password } = c.req.valid('json');
    limiter.hit(`${clientKey(c)}|register`);
    if (!opts.invites) throw badRequest('Sign-up is not available');
    opts.invites.assertInviteUsable(token);
    const name = username.toLowerCase();
    if (db.select({ id: users.id }).from(users).where(eq(users.username, name)).get()) throw badRequest('That username is taken');
    const id = newId();
    db.insert(users).values({ id, username: name, displayName, passwordHash: await hashPassword(password), isAdmin: false }).run();
    const campaignId = opts.invites.acceptInvite(token, id);
    createSession(db, c, id, opts.secureCookies);
    return c.json({ campaignId }, 201);
  });

  app.post('/logout', (c) => {
    destroySession(db, c);
    return c.json({ ok: true });
  });

  /** Display name only: username and admin flag are not settable here. */
  app.patch('/me', requireUser, rejectTokenScope, validate('json', updateMeInput), (c) => {
    const me = c.get('user')!;
    const { displayName } = c.req.valid('json');
    db.update(users).set({ displayName, updatedAt: Date.now() }).where(eq(users.id, me.id)).run();
    return c.json({ user: { ...me, displayName } });
  });

  /** Changes the password and signs out every other browser; the current session stays. */
  app.post('/password', requireUser, rejectTokenScope, validate('json', changePasswordInput), async (c) => {
    const me = c.get('user')!;
    passwordLimiter.hit(me.id);
    const { currentPassword, newPassword } = c.req.valid('json');
    const user = db.select().from(users).where(eq(users.id, me.id)).get();
    if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) throw unauthorized('Current password is wrong');
    const passwordHash = await hashPassword(newPassword);
    const cookie = getCookie(c, SESSION_COOKIE);
    // No await between these statements: they run as one step in this single-writer process.
    db.update(users).set({ passwordHash, updatedAt: Date.now() }).where(eq(users.id, me.id)).run();
    endUserSessions(db, me.id, cookie ? hashToken(cookie) : undefined);
    passwordLimiter.clear(me.id);
    return c.json({ ok: true });
  });

  /** Signs out every other browser of the caller without a password change; the current session stays. Browser session only. */
  app.post('/sessions/end-others', requireUser, rejectTokenScope, (c) => {
    const me = c.get('user')!;
    const cookie = getCookie(c, SESSION_COOKIE);
    if (!cookie) throw unauthorized('Sign in again');
    const current = hashToken(cookie);
    const others = db.select({ n: count() }).from(sessions).where(and(eq(sessions.userId, me.id), ne(sessions.id, current))).get()?.n ?? 0;
    endUserSessions(db, me.id, current);
    audit('auth.sessions_ended', { actor: me.id, count: others });
    return c.json({ ended: others });
  });

  // Password reset by link (Task M2.5, design 4.1). Outside any auth requirement; the token is the credential.
  app.use('/reset/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  /** One answer for unknown, expired, used, superseded and disabled-user links. */
  const invalidReset = () => new HttpError(404, 'This reset link is not valid');
  /** Budget gate for a token that is not live: refuse when spent, else count one failure; then the uniform 404. */
  const rejectReset = (key: string) => {
    resetBudget.assert(key);
    resetBudget.fail(key);
    return invalidReset();
  };

  app.get('/reset/:token', (c) => {
    const live = findLiveReset(db, c.req.param('token'));
    if (!live) throw rejectReset(clientKey(c));
    return c.json<ResetInfoDto>({ username: live.username, displayName: live.displayName, expiresAt: live.expiresAt });
  });

  app.post('/reset/:token', validate('json', redeemResetInput), async (c) => {
    const token = c.req.param('token');
    const key = clientKey(c);
    const { newPassword } = c.req.valid('json');
    if (!findLiveReset(db, token)) throw rejectReset(key);
    const passwordHash = await hashPassword(newPassword);
    const cookie = getCookie(c, SESSION_COOKIE);
    const userId = redeemReset(db, token, passwordHash, cookie ? hashToken(cookie) : undefined);
    if (!userId) throw invalidReset();
    createSession(db, c, userId, opts.secureCookies);
    audit('password.reset', { target: userId, ip: key });
    return c.json({ ok: true });
  });

  return app;
}
