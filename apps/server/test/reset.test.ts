import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { hashToken } from '../src/auth/session';
import { passwordResets, sessions, users } from '../src/db/schema';
import { hashPassword } from '../src/lib/password';
import { isAllowed } from '../src/mcp/api';
import { createResetLink, purgeOldResets } from '../src/services/users';
import { createFixture, createSignedInApp, TestClient, type Fixture, type TestApp } from './helpers';

const PW = 'another long password';
const NEW = 'brand new password';
let fx: Fixture;
let app: TestApp;

const tokenOf = (url: string) => url.split('#')[1]!;
const userRow = (id: string) => fx.db.select().from(users).where(eq(users.id, id)).get()!;
const sessionCount = (id: string) => fx.db.select().from(sessions).where(eq(sessions.userId, id)).all().length;
const link = (userId: string, opts: { now?: number } = {}) => tokenOf(createResetLink(fx.db, userId, null, 'http://localhost', opts).url);
const get = (t: string, c = new TestClient(app)) => c.get(`/api/auth/reset/${t}`);
const post = (t: string, body: unknown = { newPassword: NEW }, c = new TestClient(app)) => c.post(`/api/auth/reset/${t}`, body);
async function signIn(username: string, pw = PW) {
  const c = new TestClient(app);
  expect((await c.post('/api/auth/login', { username, password: pw })).status).toBe(200);
  return c;
}

beforeAll(async () => {
  fx = await createFixture();
  await createSignedInApp(fx);
});
afterAll(() => fx.cleanup());

beforeEach(async () => {
  for (const u of fx.db.select().from(users).all()) if (u.username !== 'dm') fx.db.delete(users).where(eq(users.id, u.id)).run();
  fx.db.delete(passwordResets).run();
  fx.db.insert(users).values({ id: 'pat', username: 'pat', displayName: 'Pat', passwordHash: await hashPassword(PW) }).run();
  fx.db.insert(users).values({ id: 'kim', username: 'kim', displayName: 'Kim', passwordHash: await hashPassword(PW) }).run();
  fx.db.insert(users).values({ id: 'sam', username: 'sam', displayName: 'Sam', passwordHash: await hashPassword(PW) }).run();
  app = createApp({ config: fx.config, indexDb: fx.indexDb, db: fx.db }).app; // fresh limiters
});

describe('uniform failure', () => {
  it('answers expired, used, unknown, superseded and disabled-user tokens identically', async () => {
    const used = link('pat');
    expect((await post(used)).status).toBe(200);
    const superseded = link('sam');
    link('sam');
    const disabled = link('kim');
    fx.db.update(users).set({ disabledAt: Date.now() }).where(eq(users.id, 'kim')).run();
    // Last link of its user, so expiry is the only reason it is dead.
    const expired = link('pat', { now: Date.now() - 25 * 3600_000 });
    const cases = [expired, used, superseded, disabled, 'nonsense', 'x'.repeat(500)];
    for (const method of ['GET', 'POST'] as const) {
      const seen = new Set<string>();
      for (const t of cases) {
        const r = method === 'GET' ? await get(t) : await post(t);
        expect(r.status, `${method} ${t.slice(0, 8)}`).toBe(404);
        const headers = [...r.res.headers.entries()].sort().join('|');
        seen.add(`${JSON.stringify(r.body)}#${headers}`);
        expect(r.res.headers.get('cache-control')).toBe('no-store');
      }
      expect(seen.size, method).toBe(1);
    }
    expect(userRow('pat').passwordHash).not.toContain(NEW);
  });

  it('answers 400 for a weak or malformed password before any token lookup', async () => {
    const live = link('pat');
    for (const t of ['garbage', live]) {
      const weak = await post(t, { newPassword: 'short' });
      expect(weak.status).toBe(400);
      expect(weak.res.headers.get('cache-control')).toBe('no-store');
      expect((await post(t, {})).status).toBe(400);
      expect((await post(t, { newPassword: NEW, extra: 1 })).status).toBe(400);
    }
    expect((await post('garbage')).status).toBe(404);
    // a 400 burns neither the link nor the budget
    expect((await get(live)).status).toBe(200);
  });
});

describe('GET', () => {
  it('names the account and never consumes the link', async () => {
    const t = link('pat');
    for (let i = 0; i < 3; i++) {
      const r = await get(t);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ username: 'pat', displayName: 'Pat' });
      expect(typeof r.body.expiresAt).toBe('number');
      expect(Object.keys(r.body).sort()).toEqual(['displayName', 'expiresAt', 'username']);
    }
    expect(fx.db.select().from(passwordResets).get()!.usedAt).toBeNull();
    expect((await post(t)).status).toBe(200);
  });
});

describe('POST', () => {
  it('sets the password, signs in with a fresh session and ends every other session', async () => {
    const other = await signIn('pat');
    const other2 = await signIn('pat');
    const sam = await signIn('sam');
    const t = link('pat');
    const browser = new TestClient(app);
    const r = await post(t, { newPassword: NEW }, browser);
    expect(r.status).toBe(200);
    expect(sessionCount('pat')).toBe(1);
    expect((await other.get('/api/auth/me')).body.user).toBeNull();
    expect((await other2.get('/api/auth/me')).body.user).toBeNull();
    expect((await browser.get('/api/auth/me')).body.user.username).toBe('pat');
    expect((await sam.get('/api/auth/me')).body.user.username).toBe('sam'); // other users untouched
    expect((await new TestClient(app).post('/api/auth/login', { username: 'pat', password: PW })).status).toBe(401);
    expect((await new TestClient(app).post('/api/auth/login', { username: 'pat', password: NEW })).status).toBe(200);
  });

  it('removes the incoming cookie session row even when it belongs to another user', async () => {
    const sam = await signIn('sam');
    const samSession = hashToken(sam.cookie.split('=')[1]!);
    expect(fx.db.select().from(sessions).where(eq(sessions.id, samSession)).get()).toBeTruthy();
    expect((await post(link('pat'), { newPassword: NEW }, sam)).status).toBe(200);
    expect(fx.db.select().from(sessions).where(eq(sessions.id, samSession)).get()).toBeUndefined();
    expect((await sam.get('/api/auth/me')).body.user.username).toBe('pat'); // new cookie replaced it
  });

  it('is single use: exactly one of concurrent POSTs wins', async () => {
    const t = link('pat');
    const rs = await Promise.all(Array.from({ length: 6 }, () => post(t)));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 404, 404, 404, 404, 404]);
    expect(sessionCount('pat')).toBe(1);
    expect((await post(t)).status).toBe(404);
  });

  it('a lost race or a user disabled mid-flight changes nothing and burns nothing', async () => {
    const t = link('pat');
    const before = userRow('pat').passwordHash;
    const { redeemReset } = await import('../src/services/users');
    fx.db.update(users).set({ disabledAt: Date.now() }).where(eq(users.id, 'pat')).run();
    expect(redeemReset(fx.db, t, 'hash')).toBeNull();
    expect(userRow('pat').passwordHash).toBe(before);
    expect(fx.db.select().from(passwordResets).get()!.usedAt).toBeNull(); // rolled back
    fx.db.update(users).set({ disabledAt: null }).where(eq(users.id, 'pat')).run();
    expect((await post(t)).status).toBe(200);
  });

  it('other open links of the user die with the reset', async () => {
    const t = link('pat');
    expect((await post(t)).status).toBe(200);
    expect(fx.db.select().from(passwordResets).all().every((r) => r.usedAt !== null)).toBe(true);
  });

  it('does not touch API tokens and logs no token', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = link('pat');
    await get(t);
    await post(t);
    await post('wrong-token-value');
    const logged = [...info.mock.calls, ...warn.mock.calls].flat().join('\n');
    info.mockRestore();
    warn.mockRestore();
    expect(logged).toContain('password.reset');
    expect(logged).not.toContain(t);
    expect(logged).not.toContain('wrong-token-value');
    expect(logged).not.toContain(NEW);
  });
});

describe('failed-lookup budget', () => {
  it('429s after 30 failures, but never blocks or counts a live token', async () => {
    const live = link('pat');
    for (let i = 0; i < 30; i++) expect((await get(`bad${i}`)).status).toBe(404);
    const blocked = await get('bad-again');
    expect(blocked.status).toBe(429);
    expect(blocked.res.headers.get('cache-control')).toBe('no-store');
    expect(Number(blocked.res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await post('bad-post')).status).toBe(429);
    // a live token still works, from the exhausted key
    expect((await get(live)).status).toBe(200);
    expect((await post(live)).status).toBe(200);
  });

  it('valid GETs (prefetch) never burn the budget', async () => {
    const live = link('pat');
    for (let i = 0; i < 100; i++) expect((await get(live)).status).toBe(200);
    expect((await get('nope')).status).toBe(404);
  });

  it('keys on the socket address, so a spoofed X-Forwarded-For does not bypass it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 30; i++) {
      const c = new TestClient(app);
      await c.request('GET', `/api/auth/reset/bad${i}`);
    }
    const res = await app.request('http://localhost/api/auth/reset/bad-x', { headers: { 'x-forwarded-for': '9.9.9.9', origin: 'http://localhost', host: 'localhost' } });
    expect(res.status).toBe(429);
    vi.restoreAllMocks();
  });
});

describe('placement', () => {
  it('needs no sign-in, is behind originCheck, and is unreachable from MCP', async () => {
    const t = link('pat');
    const cross = await app.request(`http://localhost/api/auth/reset/${t}`, { method: 'POST', headers: { origin: 'http://evil.example', host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify({ newPassword: NEW }) });
    expect(cross.status).toBe(403);
    expect(fx.db.select().from(passwordResets).get()!.usedAt).toBeNull();
    // an API-token (internal) caller gets no special path either way
    for (const m of ['GET', 'POST']) expect(isAllowed(m, `/api/auth/reset/${t}`)).toBe(false);
  });
});

describe('purge', () => {
  it('removes expired and used rows at start-up, keeps live ones', () => {
    link('pat', { now: Date.now() - 48 * 3600_000 });
    const used = link('sam');
    fx.db.update(passwordResets).set({ usedAt: Date.now() }).where(eq(passwordResets.tokenHash, hashToken(used))).run();
    const liveTok = link('sam'); // supersedes the earlier sam link
    purgeOldResets(fx.db);
    const rows = fx.db.select().from(passwordResets).all();
    expect(rows.map((r) => r.tokenHash)).toEqual([hashToken(liveTok)]);
  });
});
