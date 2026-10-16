import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { hashToken, internalAuth } from '../src/auth/session';
import {
  apiTokens,
  campaignInvites,
  campaignMembers,
  campaigns,
  homebrewSources,
  homebrewSourceShares,
  passwordResets,
  sessions,
  templates,
  users,
} from '../src/db/schema';
import { RateLimiter } from '../src/lib/rate-limit';
import { hashPassword } from '../src/lib/password';
import { isAllowed } from '../src/mcp/api';
import { createResetLink } from '../src/services/users';
import { createFixture, createSignedInApp, TestClient, type Fixture, type TestApp } from './helpers';

const ADMIN_PW = 'correct horse battery';
const PW = 'another long password';
let fx: Fixture;
let app: TestApp;
let services: ReturnType<typeof createApp>['services'];
let admin: TestClient;

async function addUser(id: string, opts: { admin?: boolean } = {}) {
  fx.db.insert(users).values({ id, username: id, displayName: id.toUpperCase(), passwordHash: await hashPassword(PW), isAdmin: opts.admin === true }).run();
}
async function signIn(username: string, pw = PW) {
  const c = new TestClient(app);
  const res = await c.post('/api/auth/login', { username, password: pw });
  expect(res.status).toBe(200);
  return c;
}
const userRow = (id: string) => fx.db.select().from(users).where(eq(users.id, id)).get();
const addCampaign = (id: string, members: Record<string, 'dm' | 'codm' | 'player'>) => {
  fx.db.insert(campaigns).values({ id, name: `Camp ${id}`, ruleset: '2014' }).run();
  for (const [userId, role] of Object.entries(members)) fx.db.insert(campaignMembers).values({ campaignId: id, userId, role }).run();
};
const roles = (campaignId: string) =>
  fx.db.select().from(campaignMembers).where(eq(campaignMembers.campaignId, campaignId)).all().map((m) => `${m.userId}:${m.role}`).sort();
const dmRows = (campaignId: string) => fx.db.select().from(campaignMembers).where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.role, 'dm'))).all();

const createServices2 = () => createApp({ config: fx.config, indexDb: fx.indexDb, db: fx.db });

beforeAll(async () => {
  fx = await createFixture();
  ({ app, services } = await createSignedInApp(fx));
});
afterAll(() => fx.cleanup());

let adminId: string;
beforeEach(async () => {
  // Fresh world: only the first-run admin ('dm') survives; a fresh app so rate limiters start empty.
  adminId = fx.db.select().from(users).where(eq(users.username, 'dm')).get()!.id;
  for (const u of fx.db.select().from(users).all()) if (u.id !== adminId) fx.db.delete(users).where(eq(users.id, u.id)).run();
  fx.db.delete(campaigns).run();
  fx.db.delete(homebrewSources).run();
  fx.db.delete(templates).run();
  fx.db.delete(passwordResets).run();
  fx.db.update(users).set({ isAdmin: true, disabledAt: null }).where(eq(users.id, adminId)).run();
  ({ app, services } = createServices2());
  admin = new TestClient(app);
  expect((await admin.post('/api/auth/login', { username: 'dm', password: ADMIN_PW })).status).toBe(200);
});

const url = (id: string, tail = '') => `/api/admin/users/${id}${tail}`;

describe('access', () => {
  it('answers 403 to non-admins on every route, 401 to anonymous callers', async () => {
    await addUser('pat');
    const pat = await signIn('pat');
    const anon = new TestClient(app);
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/admin/users'],
      ['GET', url('pat', '/owned-campaigns')],
      ['POST', url('pat', '/reset-link'), { currentPassword: PW }],
      ['PATCH', url('pat'), { disabled: true, currentPassword: PW }],
      ['POST', url('pat', '/delete'), { currentPassword: PW, campaigns: [] }],
    ];
    for (const [m, p, b] of calls) {
      expect((await pat.request(m, p, b)).status, `${m} ${p}`).toBe(403);
      expect((await anon.request(m, p, b)).status, `${m} ${p}`).toBe(401);
    }
    expect(userRow('pat')).toBeTruthy();
    expect(userRow('pat')!.disabledAt).toBeNull();
  });

  it('answers 403 to an admin API token, read and write, on every route', async () => {
    await addUser('pat');
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/admin/users'],
      ['GET', url('pat', '/owned-campaigns')],
      ['POST', url('pat', '/reset-link'), { currentPassword: ADMIN_PW }],
      ['PATCH', url('pat'), { disabled: true, currentPassword: ADMIN_PW }],
      ['POST', url('pat', '/delete'), { currentPassword: ADMIN_PW, campaigns: [] }],
    ];
    for (const scope of ['read', 'write'] as const) {
      for (const [m, p, b] of calls) {
        const res = await app.request(`http://internal${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }, internalAuth({ userId: adminId, scope }));
        expect(res.status, `${scope} ${m} ${p}`).toBe(403);
      }
    }
    expect(userRow('pat')).toBeTruthy();
  });

  it('is unreachable from the MCP allowlist', () => {
    const concrete = (p: string) => p.replace(/:[a-zA-Z]+/g, 'x').replace(/\*/g, 'x');
    const guarded = app.routes.filter((r) => r.path.startsWith('/api/admin') || r.path.startsWith('/api/auth'));
    expect(guarded.length).toBeGreaterThan(8);
    expect(guarded.some((r) => r.path.startsWith('/api/admin'))).toBe(true);
    for (const r of guarded) for (const m of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) expect(isAllowed(m, concrete(r.path)), `${m} ${r.path}`).toBe(false);
    // sanity: the check can say yes
    expect(isAllowed('GET', '/api/campaigns')).toBe(true);
  });

  it('lists users with their owned campaign count', async () => {
    await addUser('pat');
    addCampaign('c1', { pat: 'dm' });
    addCampaign('c2', { pat: 'dm', [adminId]: 'player' });
    const res = await admin.get('/api/admin/users');
    expect(res.status).toBe(200);
    const pat = res.body.users.find((u: { id: string }) => u.id === 'pat');
    expect(pat).toMatchObject({ username: 'pat', isAdmin: false, disabledAt: null, ownedCampaignCount: 2 });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain('argon2');
  });
});

describe('reset links', () => {
  it('shows the link once, stores only its hash, and the newest link supersedes older ones', async () => {
    await addUser('pat');
    const first = await admin.post(url('pat', '/reset-link'), { currentPassword: ADMIN_PW });
    expect(first.status).toBe(201);
    expect(first.res.headers.get('cache-control')).toBe('no-store');
    expect(first.body.url).toMatch(/^http:\/\/localhost:4200\/reset#[A-Za-z0-9_-]{43}$/);
    expect(first.body.expiresAt).toBeGreaterThan(Date.now() + 23 * 3600_000);
    const token1 = first.body.url.split('#')[1];
    let rows = fx.db.select().from(passwordResets).where(eq(passwordResets.userId, 'pat')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tokenHash: hashToken(token1), createdBy: adminId, usedAt: null });
    expect(JSON.stringify(rows)).not.toContain(token1);

    const second = await admin.post(url('pat', '/reset-link'), { currentPassword: ADMIN_PW });
    const token2 = second.body.url.split('#')[1];
    expect(token2).not.toBe(token1);
    rows = fx.db.select().from(passwordResets).where(eq(passwordResets.userId, 'pat')).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.tokenHash === hashToken(token1))!.usedAt).not.toBeNull();
    expect(rows.find((r) => r.tokenHash === hashToken(token2))!.usedAt).toBeNull();
    // never listed again
    expect(JSON.stringify((await admin.get('/api/admin/users')).body)).not.toContain(token2);
  });

  it('createResetLink is pure: command-line shape, trailing slash tolerated, no actor', async () => {
    await addUser('pat');
    const r = createResetLink(fx.db, 'pat', null, 'https://notes.example/', {});
    expect(r.url).toMatch(/^https:\/\/notes\.example\/reset#[A-Za-z0-9_-]{43}$/);
    expect(fx.db.select().from(passwordResets).where(eq(passwordResets.userId, 'pat')).get()!.createdBy).toBeNull();
    expect(() => createResetLink(fx.db, 'nobody', null, 'http://x')).toThrow(/not found/i);
  });

  it('revokeTokens revokes the user API tokens; without it they stay', async () => {
    await addUser('pat');
    const pat = await signIn('pat');
    const t = await pat.post('/api/auth/tokens', { name: 'ai', scope: 'write', expiresInDays: 30 });
    expect(t.status).toBe(201);
    await admin.post(url('pat', '/reset-link'), { currentPassword: ADMIN_PW });
    expect(fx.db.select().from(apiTokens).where(and(eq(apiTokens.userId, 'pat'), isNull(apiTokens.revokedAt))).all()).toHaveLength(1);
    await admin.post(url('pat', '/reset-link'), { currentPassword: ADMIN_PW, revokeTokens: true });
    expect(fx.db.select().from(apiTokens).where(and(eq(apiTokens.userId, 'pat'), isNull(apiTokens.revokedAt))).all()).toHaveLength(0);
  });

  it('refuses a disabled user, an unknown user, a wrong password and unknown fields; nothing is written', async () => {
    await addUser('pat');
    expect((await admin.post(url('ghost', '/reset-link'), { currentPassword: ADMIN_PW })).status).toBe(404);
    expect((await admin.post(url('pat', '/reset-link'), { currentPassword: 'nope nope nope' })).status).toBe(403);
    expect((await admin.post(url('pat', '/reset-link'), {})).status).toBe(400);
    expect((await admin.post(url('pat', '/reset-link'), { currentPassword: ADMIN_PW, extra: 1 })).status).toBe(400);
    expect(fx.db.select().from(passwordResets).all()).toHaveLength(0);
    fx.db.update(users).set({ disabledAt: Date.now() }).where(eq(users.id, 'pat')).run();
    const res = await admin.post(url('pat', '/reset-link'), { currentPassword: ADMIN_PW });
    expect(res.status).toBe(409);
    expect(fx.db.select().from(passwordResets).all()).toHaveLength(0);
  });

  it('limits wrong step-up passwords to 5 a minute per admin, then 429 with Retry-After', async () => {
    await addUser('pat');
    for (let i = 0; i < 5; i++) expect((await admin.post(url('pat', '/reset-link'), { currentPassword: 'wrong wrong' })).status).toBe(403);
    const blocked = await admin.post(url('pat', '/reset-link'), { currentPassword: ADMIN_PW });
    expect(blocked.status).toBe(429);
    expect(blocked.res.headers.get('retry-after')).toBeTruthy();
    expect(fx.db.select().from(passwordResets).all()).toHaveLength(0);
  });
});

describe('step-up rate limit atomicity', () => {
  it('counts concurrent wrong guesses before the verification finishes: 5 get 403, the rest 429', async () => {
    await addUser('pat');
    const results = await Promise.all(Array.from({ length: 12 }, () => admin.post(url('pat', '/reset-link'), { currentPassword: 'wrong wrong' })));
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 403)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(7);
    expect(fx.db.select().from(passwordResets).all()).toHaveLength(0);
  });

  it('a correct password gives back only its own attempt: 4 failures stay counted', async () => {
    await addUser('pat');
    for (let i = 0; i < 4; i++) expect((await admin.post(url('pat', '/reset-link'), { currentPassword: 'wrong wrong' })).status).toBe(403);
    expect((await admin.post(url('pat', '/reset-link'), { currentPassword: ADMIN_PW })).status).toBe(201);
    // 4 counted: one more wrong guess is allowed, then the budget is used up
    expect((await admin.post(url('pat', '/reset-link'), { currentPassword: 'wrong wrong' })).status).toBe(403);
    expect((await admin.post(url('pat', '/reset-link'), { currentPassword: ADMIN_PW })).status).toBe(429);
  });

  it('RateLimiter.give takes back exactly one, never below zero', () => {
    const l = new RateLimiter(2, 60_000);
    l.give('k');
    l.fail('k');
    l.fail('k');
    l.give('k');
    expect(() => l.assert('k')).not.toThrow();
    l.fail('k');
    expect(() => l.assert('k')).toThrow();
    l.give('k');
    l.give('k');
    l.give('k');
    expect(l.size).toBe(0);
    l.fail('k');
    l.fail('k');
    expect(() => l.assert('k')).toThrow();
  });
});

describe('disable and enable', () => {
  it('enabling an admin needs the password; enabling a non-admin does not', async () => {
    await addUser('bo', { admin: true });
    await addUser('pat');
    fx.db.update(users).set({ disabledAt: Date.now() }).where(eq(users.id, 'bo')).run();
    fx.db.update(users).set({ disabledAt: Date.now() }).where(eq(users.id, 'pat')).run();
    const missing = await admin.patch(url('bo'), { disabled: false });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/password/i);
    expect(userRow('bo')!.disabledAt).not.toBeNull();
    expect((await admin.patch(url('bo'), { disabled: false, currentPassword: 'wrong wrong' })).status).toBe(403);
    expect(userRow('bo')!.disabledAt).not.toBeNull();
    const ok = await admin.patch(url('bo'), { disabled: false, currentPassword: ADMIN_PW });
    expect(ok.status).toBe(200);
    expect(userRow('bo')!.disabledAt).toBeNull();
    expect((await admin.patch(url('pat'), { disabled: false })).status).toBe(200);
    expect(userRow('pat')!.disabledAt).toBeNull();
  });

  it('ends sessions, revokes tokens and open links; enable restores nothing', async () => {
    await addUser('pat');
    const pat = await signIn('pat');
    await pat.post('/api/auth/tokens', { name: 'ai', scope: 'read', expiresInDays: 30 });
    await admin.post(url('pat', '/reset-link'), { currentPassword: ADMIN_PW });
    const res = await admin.patch(url('pat'), { disabled: true, currentPassword: ADMIN_PW });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: 'pat', disabledAt: expect.any(Number) });
    expect(fx.db.select().from(sessions).where(eq(sessions.userId, 'pat')).all()).toHaveLength(0);
    expect(fx.db.select().from(apiTokens).where(and(eq(apiTokens.userId, 'pat'), isNull(apiTokens.revokedAt))).all()).toHaveLength(0);
    expect(fx.db.select().from(passwordResets).where(and(eq(passwordResets.userId, 'pat'), isNull(passwordResets.usedAt))).all()).toHaveLength(0);
    expect((await pat.get('/api/auth/me')).body.user).toBeNull();

    // enabling needs no password and brings back no token
    const on = await admin.patch(url('pat'), { disabled: false });
    expect(on.status).toBe(200);
    expect(on.body.user.disabledAt).toBeNull();
    expect(fx.db.select().from(apiTokens).where(and(eq(apiTokens.userId, 'pat'), isNull(apiTokens.revokedAt))).all()).toHaveLength(0);
  });

  it('combined PATCH: enabling plus granting admin needs the password; enabling plus demoting an admin does not', async () => {
    await addUser('pat');
    fx.db.update(users).set({ disabledAt: Date.now() }).where(eq(users.id, 'pat')).run();
    expect((await admin.patch(url('pat'), { disabled: false, isAdmin: true })).status).toBe(400);
    expect(userRow('pat')).toMatchObject({ isAdmin: false });
    expect(userRow('pat')!.disabledAt).not.toBeNull();
    expect((await admin.patch(url('pat'), { disabled: false, isAdmin: true, currentPassword: ADMIN_PW })).status).toBe(200);
    expect(userRow('pat')).toMatchObject({ isAdmin: true, disabledAt: null });
    // a disabled admin enabled and demoted in one request ends as a non-admin (the schema asks for the password anyway)
    await addUser('bo', { admin: true });
    fx.db.update(users).set({ disabledAt: Date.now() }).where(eq(users.id, 'bo')).run();
    const res = await admin.patch(url('bo'), { disabled: false, isAdmin: false, currentPassword: ADMIN_PW });
    expect(res.status).toBe(200);
    expect(userRow('bo')).toMatchObject({ isAdmin: false, disabledAt: null });
  });

  it('needs the password to disable, and refuses unknown or empty bodies', async () => {
    await addUser('pat');
    expect((await admin.patch(url('pat'), { disabled: true })).status).toBe(400);
    expect((await admin.patch(url('pat'), { disabled: true, currentPassword: 'wrong wrong' })).status).toBe(403);
    expect((await admin.patch(url('pat'), { currentPassword: ADMIN_PW })).status).toBe(400);
    expect((await admin.patch(url('pat'), { isAdmin: true })).status).toBe(400);
    expect((await admin.patch(url('pat'), { disabled: true, currentPassword: ADMIN_PW, username: 'x' })).status).toBe(400);
    expect((await admin.patch(url('ghost'), { disabled: true, currentPassword: ADMIN_PW })).status).toBe(404);
    expect(userRow('pat')!.disabledAt).toBeNull();
  });

  it('forbids self-disable even with another admin', async () => {
    await addUser('bo', { admin: true });
    const res = await admin.patch(url(adminId), { disabled: true, currentPassword: ADMIN_PW });
    expect(res.status).toBe(409);
    expect(userRow(adminId)!.disabledAt).toBeNull();
  });

  it('refuses to disable the last enabled admin (a disabled admin does not count)', async () => {
    await addUser('bo', { admin: true });
    expect((await admin.patch(url('bo'), { disabled: true, currentPassword: ADMIN_PW })).status).toBe(200);
    // bo is now disabled: the acting admin is the only enabled admin and cannot be disabled by anyone else here;
    // a second enabled admin appears, disables the first... which is then the last.
    await addUser('cy', { admin: true });
    const cy = await signIn('cy');
    expect((await cy.patch(url(adminId), { disabled: true, currentPassword: PW })).status).toBe(200);
    expect(userRow(adminId)!.disabledAt).not.toBeNull();
    // cy is the last enabled admin: nobody (not even cy) may take that away
    expect((await cy.patch(url('cy'), { disabled: true, currentPassword: PW })).status).toBe(409);
    expect((await cy.patch(url('cy'), { isAdmin: false, currentPassword: PW })).status).toBe(409);
    expect((await cy.post(url('cy', '/delete'), { currentPassword: PW, campaigns: [] })).status).toBe(409);
  });

  it('refuses revoke+disable of the last admin in one request, and leaves the row untouched', async () => {
    await addUser('bo');
    fx.db.update(users).set({ isAdmin: true }).where(eq(users.id, 'bo')).run();
    fx.db.update(users).set({ disabledAt: Date.now() }).where(eq(users.id, 'bo')).run();
    const res = await admin.patch(url(adminId), { isAdmin: false, currentPassword: ADMIN_PW });
    expect(res.status).toBe(409);
    expect(userRow(adminId)!.isAdmin).toBe(true);
  });
});

describe('grant and revoke admin', () => {
  it('grants and revokes with the password, and the effect is immediate', async () => {
    await addUser('pat');
    const pat = await signIn('pat');
    expect((await pat.get('/api/admin/users')).status).toBe(403);
    expect((await admin.patch(url('pat'), { isAdmin: true })).status).toBe(400);
    expect((await admin.patch(url('pat'), { isAdmin: true, currentPassword: ADMIN_PW })).body.user.isAdmin).toBe(true);
    expect((await pat.get('/api/admin/users')).status).toBe(200);
    expect((await admin.patch(url('pat'), { isAdmin: false, currentPassword: ADMIN_PW })).body.user.isAdmin).toBe(false);
    expect((await pat.get('/api/admin/users')).status).toBe(403);
  });

  it('self-demote works only while another enabled admin exists', async () => {
    expect((await admin.patch(url(adminId), { isAdmin: false, currentPassword: ADMIN_PW })).status).toBe(409);
    expect(userRow(adminId)!.isAdmin).toBe(true);
    await addUser('bo', { admin: true });
    expect((await admin.patch(url(adminId), { isAdmin: false, currentPassword: ADMIN_PW })).status).toBe(200);
    expect(userRow(adminId)!.isAdmin).toBe(false);
    expect((await admin.get('/api/admin/users')).status).toBe(403);
  });
});

describe('last admin under races', () => {
  for (const order of ['A first', 'B first'] as const) {
    it(`two admins demoting each other at once leave exactly one (${order})`, async () => {
      await addUser('bo', { admin: true });
      const bo = await signIn('bo');
      const demoteB = () => admin.patch(url('bo'), { isAdmin: false, currentPassword: ADMIN_PW });
      const demoteA = () => bo.patch(url(adminId), { isAdmin: false, currentPassword: PW });
      const results = await Promise.all(order === 'A first' ? [demoteB(), demoteA()] : [demoteA(), demoteB()]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 403]);
      const admins = fx.db.select().from(users).where(and(eq(users.isAdmin, true), isNull(users.disabledAt))).all();
      expect(admins).toHaveLength(1);
    });
  }

  it('a demoted actor is refused inside the transaction (stale actor), for every write', () => {
    fx.db.insert(users).values({ id: 'ex', username: 'ex', displayName: 'ex', passwordHash: 'x', isAdmin: false }).run();
    fx.db.insert(users).values({ id: 'pat', username: 'pat', displayName: 'pat', passwordHash: 'x', isAdmin: false }).run();
    const svc = services.userAdmin;
    // 'ex' passed requireAdmin earlier, then lost the flag before the write: modelled by calling the service directly
    expect(() => svc.createResetLink('ex', 'pat', 'http://x', false)).toThrow(/admins only/i);
    expect(() => svc.update('ex', 'pat', { isAdmin: true })).toThrow(/admins only/i);
    expect(() => svc.update('ex', 'pat', { disabled: true })).toThrow(/admins only/i);
    expect(() => svc.remove('ex', 'pat', [])).toThrow(/admins only/i);
    // a disabled admin is refused too
    fx.db.update(users).set({ isAdmin: true, disabledAt: Date.now() }).where(eq(users.id, 'ex')).run();
    expect(() => svc.update('ex', 'pat', { isAdmin: true })).toThrow(/admins only/i);
    expect(userRow('pat')).toMatchObject({ isAdmin: false, disabledAt: null });
    expect(fx.db.select().from(passwordResets).all()).toHaveLength(0);
  });

  it('transaction callbacks are synchronous (no await can open a gap)', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/services/users.ts', import.meta.url), 'utf8'));
    expect(src).not.toMatch(/transaction\(\s*async/);
  });
});

describe('delete', () => {
  const del = (id: string, campaigns: unknown[] = [], pw = ADMIN_PW) => admin.post(url(id, '/delete'), { currentPassword: pw, campaigns });

  it('refuses self-delete, a wrong password, an unknown user', async () => {
    await addUser('bo', { admin: true });
    expect((await del(adminId)).status).toBe(409);
    await addUser('pat');
    expect((await del('pat', [], 'wrong wrong')).status).toBe(403);
    expect((await del('ghost')).status).toBe(404);
    expect(userRow('pat')).toBeTruthy();
  });

  it('refuses without a plan, with a missing or extra campaign, a non-member target, or archive without a co-DM', async () => {
    await addUser('pat');
    await addUser('quinn');
    addCampaign('c1', { pat: 'dm', quinn: 'player' });
    addCampaign('c2', { pat: 'dm' });
    addCampaign('other', { quinn: 'dm' });

    const none = await del('pat');
    expect(none.status).toBe(400);
    expect(none.body.details.missing.map((m: { campaignId: string }) => m.campaignId).sort()).toEqual(['c1', 'c2']);
    const partial = await del('pat', [{ campaignId: 'c1', action: 'transfer', toUserId: 'quinn' }]);
    expect(partial.status).toBe(400);
    expect(partial.body.details.missing).toEqual([{ campaignId: 'c2', name: 'Camp c2' }]);
    const extra = await del('pat', [
      { campaignId: 'c1', action: 'transfer', toUserId: 'quinn' },
      { campaignId: 'c2', action: 'archive' },
      { campaignId: 'other', action: 'archive' },
    ]);
    expect(extra.status).toBe(400);
    expect(extra.body.details.extra).toEqual(['other']);
    const solo = await del('pat', [
      { campaignId: 'c1', action: 'transfer', toUserId: 'quinn' },
      { campaignId: 'c2', action: 'archive' },
    ]);
    expect(solo.status).toBe(400);
    expect(solo.body.error).toMatch(/co-DM/);
    const stranger = await del('pat', [
      { campaignId: 'c1', action: 'transfer', toUserId: adminId },
      { campaignId: 'c2', action: 'transfer', toUserId: 'quinn' },
    ]);
    expect(stranger.status).toBe(400);
    const dup = await del('pat', [
      { campaignId: 'c1', action: 'transfer', toUserId: 'quinn' },
      { campaignId: 'c1', action: 'transfer', toUserId: 'quinn' },
      { campaignId: 'c2', action: 'transfer', toUserId: 'quinn' },
    ]);
    expect(dup.status).toBe(400);
    // nothing changed: all-or-nothing
    expect(userRow('pat')).toBeTruthy();
    expect(roles('c1')).toEqual(['pat:dm', 'quinn:player']);
    expect(roles('c2')).toEqual(['pat:dm']);
  });

  it('a solo campaign cannot be orphaned or archived; the admin disables instead', async () => {
    await addUser('pat');
    addCampaign('solo', { pat: 'dm' });
    expect((await del('pat', [{ campaignId: 'solo', action: 'archive' }])).status).toBe(400);
    expect((await del('pat', [{ campaignId: 'solo', action: 'transfer', toUserId: 'pat' }])).status).toBe(400);
    expect(dmRows('solo')).toHaveLength(1);
    expect((await admin.patch(url('pat'), { disabled: true, currentPassword: ADMIN_PW })).status).toBe(200);
  });

  it('rejects a transfer to a disabled member, rolls the whole plan back, and flags disabled members', async () => {
    await addUser('pat');
    await addUser('quinn');
    await addUser('rho');
    addCampaign('t1', { pat: 'dm', quinn: 'player' });
    addCampaign('t2', { pat: 'dm', rho: 'player' });
    fx.db.update(users).set({ disabledAt: Date.now() }).where(eq(users.id, 'rho')).run();
    const owned = await admin.get(url('pat', '/owned-campaigns'));
    const members = (id: string) => owned.body.campaigns.find((c: { campaignId: string }) => c.campaignId === id).members;
    expect(members('t1').find((m: { userId: string }) => m.userId === 'quinn').disabled).toBe(false);
    expect(members('t2').find((m: { userId: string }) => m.userId === 'rho').disabled).toBe(true);
    const res = await del('pat', [
      { campaignId: 't1', action: 'transfer', toUserId: 'quinn' },
      { campaignId: 't2', action: 'transfer', toUserId: 'rho' },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disabled/i);
    expect(userRow('pat')).toBeTruthy();
    expect(roles('t1')).toEqual(['pat:dm', 'quinn:player']);
    expect(roles('t2')).toEqual(['pat:dm', 'rho:player']);
  });

  it('transfers to a member and archives with a co-DM: one owner per transferred campaign', async () => {
    await addUser('pat');
    await addUser('quinn');
    await addUser('rho');
    addCampaign('t1', { pat: 'dm', quinn: 'player', rho: 'player' });
    addCampaign('t2', { pat: 'dm', rho: 'codm' });
    addCampaign('a1', { pat: 'dm', rho: 'codm', quinn: 'player' });
    addCampaign('untouched', { quinn: 'dm' });
    const res = await del('pat', [
      { campaignId: 't1', action: 'transfer', toUserId: 'quinn' },
      { campaignId: 't2', action: 'transfer', toUserId: 'rho' },
      { campaignId: 'a1', action: 'archive' },
    ]);
    expect(res.status).toBe(204);
    expect(userRow('pat')).toBeUndefined();
    expect(roles('t1')).toEqual(['quinn:dm', 'rho:player']);
    expect(roles('t2')).toEqual(['rho:dm']);
    expect(dmRows('t1')).toHaveLength(1);
    expect(dmRows('t2')).toHaveLength(1);
    expect(dmRows('untouched')).toHaveLength(1);
    // archived: the co-DM stays, status archived. The design leaves it without an owner (see report).
    expect(fx.db.select().from(campaigns).where(eq(campaigns.id, 'a1')).get()!.status).toBe('archived');
    expect(roles('a1')).toEqual(['quinn:player', 'rho:codm']);
    expect(fx.db.select().from(campaigns).where(eq(campaigns.id, 't1')).get()!.status).toBe('active');
  });

  it('ends the deleted user data access: sessions and tokens go, invites are revoked, the username is free', async () => {
    await addUser('pat');
    await addUser('quinn');
    addCampaign('c1', { pat: 'dm', quinn: 'player' });
    const pat = await signIn('pat');
    await pat.post('/api/auth/tokens', { name: 'ai', scope: 'read', expiresInDays: 30 });
    fx.db.insert(campaignInvites).values({ id: 'inv', campaignId: 'c1', tokenHash: 'h1', role: 'player', createdBy: 'pat' }).run();
    expect((await del('pat', [{ campaignId: 'c1', action: 'transfer', toUserId: 'quinn' }])).status).toBe(204);
    expect(fx.db.select().from(sessions).where(eq(sessions.userId, 'pat')).all()).toHaveLength(0);
    expect(fx.db.select().from(apiTokens).where(eq(apiTokens.userId, 'pat')).all()).toHaveLength(0);
    const inv = fx.db.select().from(campaignInvites).where(eq(campaignInvites.id, 'inv')).get()!;
    expect(inv.revokedAt).not.toBeNull();
    expect((await pat.get('/api/auth/me')).body.user).toBeNull();
  });

  it('hands shared homebrew to the acting admin; private sources and user templates stay ownerless without crashing readers', async () => {
    await addUser('pat');
    await addUser('quinn');
    addCampaign('c1', { pat: 'dm', quinn: 'player' });
    const src = (id: string, scope: string, extra: Record<string, unknown> = {}) =>
      fx.db.insert(homebrewSources).values({ id, jsonId: `J${id}`, jsonIdLower: `j${id}`, abbreviation: id.slice(0, 4).toUpperCase(), fullName: `Source ${id}`, edition: 'any', scope, ownerUserId: 'pat', ...extra }).run();
    src('priv', 'private');
    src('shared', 'campaigns');
    src('inst', 'instance');
    src('camp', 'campaign', { campaignId: 'c1' });
    fx.db.insert(homebrewSourceShares).values({ sourceId: 'shared', campaignId: 'c1' }).run();
    fx.db.insert(templates).values({ id: 'tpl', kind: 'block', scope: 'user', ownerUserId: 'pat', name: 'Mine', definition: { schemaVersion: 1, blocks: [] } }).run();
    expect((await del('pat', [{ campaignId: 'c1', action: 'transfer', toUserId: 'quinn' }])).status).toBe(204);
    const owner = (id: string) => fx.db.select().from(homebrewSources).where(eq(homebrewSources.id, id)).get()!.ownerUserId;
    expect(owner('shared')).toBe(adminId);
    expect(owner('inst')).toBe(adminId);
    expect(owner('camp')).toBe('quinn');
    expect(owner('priv')).toBeNull();
    expect(fx.db.select().from(templates).where(eq(templates.id, 'tpl')).get()!.ownerUserId).toBeNull();

    // readers with null owners: nobody crashes, the orphans are invisible
    const quinn = await signIn('quinn');
    for (const c of [admin, quinn]) {
      const hb = await c.get('/api/homebrew/sources');
      expect(hb.status).toBe(200);
      const ids = hb.body.sources.map((s: { id: string }) => s.id);
      expect(ids).not.toContain('priv');
      expect((await c.get('/api/templates')).status).toBe(200);
      expect((await c.get('/api/homebrew/sources/priv')).status).toBe(404);
      expect((await c.get('/api/templates/tpl')).status).toBe(404);
    }
    const mine = (await admin.get('/api/homebrew/sources')).body.sources.map((s: { id: string }) => s.id);
    expect(mine).toEqual(expect.arrayContaining(['shared', 'inst']));
    const tpls = (await quinn.get('/api/templates')).body;
    expect(JSON.stringify(tpls)).not.toContain('Mine');
  });
});

describe('audit', () => {
  it('logs one line per event without tokens, links or passwords', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await addUser('pat');
      const link = await admin.post(url('pat', '/reset-link'), { currentPassword: ADMIN_PW });
      await admin.post(url('pat', '/reset-link'), { currentPassword: ADMIN_PW });
      await admin.patch(url('pat'), { disabled: true, currentPassword: ADMIN_PW });
      await admin.patch(url('pat'), { disabled: false });
      await admin.patch(url('pat'), { isAdmin: true, currentPassword: ADMIN_PW });
      await admin.patch(url('pat'), { isAdmin: false, currentPassword: ADMIN_PW });
      await admin.post(url('pat', '/delete'), { currentPassword: ADMIN_PW, campaigns: [] });
      const lines = info.mock.calls.map((c) => JSON.parse(String(c[0])) as { event: string; actor: string; target: string; targetIsAdmin: boolean });
      expect(lines.map((l) => l.event)).toEqual([
        'reset_link.created',
        'reset_link.created',
        'reset_link.superseded',
        'user.disabled',
        'user.enabled',
        'admin.granted',
        'admin.revoked',
        'user.deleted',
      ]);
      expect(lines.every((l) => l.actor === adminId && l.target === 'pat' && typeof l.targetIsAdmin === 'boolean')).toBe(true);
      const all = info.mock.calls.map((c) => String(c[0])).join('\n');
      expect(all).not.toContain(link.body.url.split('#')[1]);
      expect(all).not.toContain(ADMIN_PW);
    } finally {
      info.mockRestore();
    }
  });
});
