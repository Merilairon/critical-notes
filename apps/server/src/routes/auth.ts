import { count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { changePasswordInput, loginInput, registerWithInviteInput, setupInput, type MeDto } from '@cn/shared';
import type { AppDb } from '../db';
import { users } from '../db/schema';
import { createSession, destroySession, requireUser, type AppEnv } from '../auth/session';
import { badRequest, HttpError, unauthorized, validate } from '../lib/http';
import { newId } from '../lib/ids';
import { hashPassword, verifyPassword } from '../lib/password';

/** Small fixed-window limiter for login attempts (per IP + username). */
class AttemptLimiter {
  private readonly hits = new Map<string, { n: number; reset: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  check(key: string) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.reset < now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return;
    }
    entry.n++;
    if (entry.n > this.max) throw new HttpError(429 as never, 'Too many attempts, try again in a minute');
  }
  clear(key: string) {
    this.hits.delete(key);
  }
}

/** Invite handling the auth routes need (implemented by the campaign service). */
export interface InviteGate {
  assertInviteUsable(token: string): void;
  acceptInvite(token: string, userId: string): string;
}

export function authRoutes(db: AppDb, opts: { secureCookies: boolean; invites?: InviteGate }) {
  const app = new Hono<AppEnv>();
  const limiter = new AttemptLimiter(8, 60_000);
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
    const key = `${c.req.header('x-forwarded-for') ?? 'local'}|${username.toLowerCase()}`;
    limiter.check(key);
    const user = db.select().from(users).where(eq(users.username, username.toLowerCase())).get();
    // Always verify against a hash to keep timing similar for unknown users
    const ok = await verifyPassword(user?.passwordHash ?? '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$0000000000000000000000000000000000000000000', password);
    if (!user || !ok) throw unauthorized('Wrong username or password');
    limiter.clear(key);
    createSession(db, c, user.id, opts.secureCookies);
    return c.json({ ok: true });
  });

  /** Creates an account through a campaign invite link (there is no open sign-up), signs in and joins. */
  app.post('/register', validate('json', registerWithInviteInput), async (c) => {
    const { token, username, displayName, password } = c.req.valid('json');
    limiter.check(`${c.req.header('x-forwarded-for') ?? 'local'}|register`);
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

  app.post('/password', requireUser, validate('json', changePasswordInput), async (c) => {
    const me = c.get('user')!;
    const { currentPassword, newPassword } = c.req.valid('json');
    const user = db.select().from(users).where(eq(users.id, me.id)).get();
    if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) throw unauthorized('Current password is wrong');
    db.update(users).set({ passwordHash: await hashPassword(newPassword), updatedAt: Date.now() }).where(eq(users.id, me.id)).run();
    return c.json({ ok: true });
  });

  return app;
}
