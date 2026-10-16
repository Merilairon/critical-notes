import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { internalAuth, SESSION_COOKIE } from '../src/auth/session';
import { sessions, users } from '../src/db/schema';
import { hashPassword } from '../src/lib/password';
import { createClientKey, RateLimiter } from '../src/lib/rate-limit';
import { createFixture, createSignedInApp, TestClient, type Fixture, type TestApp } from './helpers';
import { makeToken, mcpClient } from './mcp-client';

const PW = 'another long password';
let fx: Fixture;
let app: TestApp;

async function addUser(id: string, username: string) {
  fx.db.insert(users).values({ id, username, displayName: username, passwordHash: await hashPassword(PW), isAdmin: false }).run();
}
async function signIn(username: string, a: TestApp = app) {
  const c = new TestClient(a);
  expect((await c.post('/api/auth/login', { username, password: PW })).status).toBe(200);
  return c;
}
const sessionCount = (userId: string) => fx.db.select().from(sessions).where(eq(sessions.userId, userId)).all().length;

beforeAll(async () => {
  fx = await createFixture();
  ({ app } = await createSignedInApp(fx));
});
afterAll(() => fx.cleanup());

describe('PATCH /api/auth/me', () => {
  it('changes the display name only', async () => {
    await addUser('p1', 'pat');
    const pat = await signIn('pat');
    const res = await pat.patch('/api/auth/me', { displayName: '  Patricia  ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: { id: 'p1', username: 'pat', displayName: 'Patricia', isAdmin: false } });
    expect((await pat.get('/api/auth/me')).body.user.displayName).toBe('Patricia');
  });

  it('refuses other fields, blank and long names, and anonymous callers', async () => {
    await addUser('p2', 'quinn');
    const quinn = await signIn('quinn');
    expect((await quinn.patch('/api/auth/me', { displayName: 'Q', isAdmin: true })).status).toBe(400);
    expect((await quinn.patch('/api/auth/me', { username: 'root' })).status).toBe(400);
    expect((await quinn.patch('/api/auth/me', { displayName: '   ' })).status).toBe(400);
    expect((await quinn.patch('/api/auth/me', { displayName: 'x'.repeat(81) })).status).toBe(400);
    expect((await new TestClient(app).patch('/api/auth/me', { displayName: 'Q' })).status).toBe(401);
    const row = fx.db.select().from(users).where(eq(users.id, 'p2')).get()!;
    expect(row).toMatchObject({ username: 'quinn', isAdmin: false });
  });

  it('is closed to API tokens, like the password route', async () => {
    const userId = 'p2';
    for (const scope of ['read', 'write'] as const) {
      const patch = await app.request('http://internal/api/auth/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Hax' }) }, internalAuth({ userId, scope }));
      expect(patch.status).toBe(403);
    }
    const pw = await app.request('http://internal/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: PW, newPassword: 'brand new password' }) }, internalAuth({ userId, scope: 'write' }));
    expect(pw.status).toBe(403);
    expect(fx.db.select().from(users).where(eq(users.id, userId)).get()!.displayName).toBe('quinn');
  });
});

describe('password change', () => {
  it('signs out other browsers but not the current one', async () => {
    await addUser('p3', 'rhea');
    const laptop = await signIn('rhea');
    const phone = await signIn('rhea');
    expect(sessionCount('p3')).toBe(2);
    const before = laptop.cookie;
    const res = await laptop.post('/api/auth/password', { currentPassword: PW, newPassword: 'a brand new password' });
    expect(res.status).toBe(200);
    expect(laptop.cookie).toBe(before);
    expect(sessionCount('p3')).toBe(1);
    expect((await laptop.get('/api/auth/me')).body.user).toMatchObject({ username: 'rhea' });
    expect((await phone.get('/api/auth/me')).body.user).toBeNull();
    // the new password works, the old one does not
    expect((await new TestClient(app).post('/api/auth/login', { username: 'rhea', password: PW })).status).toBe(401);
    expect((await new TestClient(app).post('/api/auth/login', { username: 'rhea', password: 'a brand new password' })).status).toBe(200);
  });

  it('leaves other users sessions alone, and a wrong current password changes nothing', async () => {
    await addUser('p4', 'sol');
    const sol = await signIn('sol');
    const other = sessionCount('p3');
    expect((await sol.post('/api/auth/password', { currentPassword: 'wrong wrong', newPassword: 'a brand new password' })).status).toBe(401);
    expect(sessionCount('p4')).toBe(1);
    expect(sessionCount('p3')).toBe(other);
  });

  it('is rate limited per user, not per address', async () => {
    await addUser('p5', 'tess');
    const tess = await signIn('tess');
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await tess.post('/api/auth/password', { currentPassword: 'wrong wrong', newPassword: 'a brand new password' })).status);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429, 429]);
    const res = await tess.post('/api/auth/password', { currentPassword: PW, newPassword: 'a brand new password' });
    expect(res.status).toBe(429);
    expect(Number(res.res.headers.get('retry-after'))).toBeGreaterThan(0);
    // another user is not affected
    await addUser('p6', 'uma');
    const uma = await signIn('uma');
    expect((await uma.post('/api/auth/password', { currentPassword: PW, newPassword: 'a brand new password' })).status).toBe(200);
  });
});

describe('disabled users', () => {
  it('get 401 on every path: cookie, login, API token and in-process MCP', async () => {
    await addUser('p7', 'vik');
    const vik = await signIn('vik');
    const token = await makeToken(vik);
    const mcp = await mcpClient(app, token);
    expect((await vik.get('/api/auth/tokens')).status).toBe(200);
    await expect(mcp.listTools()).resolves.toBeTruthy();

    fx.db.update(users).set({ disabledAt: Date.now() }).where(eq(users.id, 'p7')).run();

    // cookie path: the session row is still there, the user is not resolved
    expect(sessionCount('p7')).toBe(1);
    expect((await vik.get('/api/auth/tokens')).status).toBe(401);
    expect((await vik.get('/api/auth/me')).body.user).toBeNull();
    expect((await vik.patch('/api/auth/me', { displayName: 'x' })).status).toBe(401);

    // API-token path
    const viaMcp = await app.request('http://localhost/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(viaMcp.status).toBe(401);
    await expect(mcpClient(app, token)).rejects.toThrow();

    // in-process path, as the MCP tools call the app (also an already-open session)
    for (const scope of ['read', 'write'] as const) {
      expect((await app.request('http://internal/api/campaigns', {}, internalAuth({ userId: 'p7', scope }))).status).toBe(401);
    }
  });

  it('cannot sign in; the message appears only after the right password', async () => {
    const c = new TestClient(app);
    const wrong = await c.post('/api/auth/login', { username: 'vik', password: 'not the password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('Wrong username or password');
    const right = await c.post('/api/auth/login', { username: 'vik', password: PW });
    expect(right.status).toBe(403);
    expect(c.cookie).toBe('');
    expect(sessionCount('p7')).toBe(1);
  });

  it('can sign in again once enabled', async () => {
    const before = sessionCount('p7');
    fx.db.update(users).set({ disabledAt: null }).where(eq(users.id, 'p7')).run();
    const vik = await signIn('vik');
    expect((await vik.get('/api/auth/tokens')).status).toBe(200);
    expect(sessionCount('p7')).toBe(before + 1);
    expect(vik.cookie.startsWith(SESSION_COOKIE)).toBe(true);
  });
});

describe('login limits', () => {
  it('rotating X-Forwarded-For does not bypass the limit when the proxy is not trusted', async () => {
    await addUser('p8', 'wren');
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await app.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { origin: 'http://localhost', host: 'localhost', 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${i}` },
        body: JSON.stringify({ username: 'wren', password: 'nope nope' }),
      });
      codes.push(res.status);
    }
    expect(codes.slice(0, 8).every((s) => s === 401)).toBe(true);
    expect(codes.slice(8)).toEqual([429, 429]);
  });

  it('with TRUST_PROXY, rotation beats the per-address budget but not the per-username one', async () => {
    const trusted = createApp({ config: { ...fx.config, trustProxy: true }, indexDb: fx.indexDb, db: fx.db }).app;
    const attempt = (i: number, password = 'nope nope') =>
      trusted.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { origin: 'http://localhost', host: 'localhost', 'content-type': 'application/json', 'x-forwarded-for': `10.1.${Math.floor(i / 250)}.${i % 250}` },
        body: JSON.stringify({ username: 'wren', password }),
      });
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await attempt(i)).status);
    expect(codes.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(codes.slice(30)).toEqual([429, 429]);
    const blocked = await attempt(99, PW);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // another username is unaffected
    const other = await trusted.request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { origin: 'http://localhost', host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'pat', password: PW }),
    });
    expect(other.status).toBe(200);
  });
});

describe('RateLimiter', () => {
  it('counts per key, expires with the window and reports Retry-After', () => {
    let now = 1_000;
    const l = new RateLimiter(2, 10_000, { now: () => now });
    l.hit('a');
    l.hit('a');
    expect(() => l.hit('a')).toThrowError(expect.objectContaining({ status: 429, retryAfterSec: 10 }));
    l.hit('b');
    now += 10_001;
    expect(() => l.hit('a')).not.toThrow();
    l.clear('a');
    expect(l.size).toBe(1);
  });

  it('assert does not count, fail does', () => {
    const l = new RateLimiter(2, 10_000);
    for (let i = 0; i < 5; i++) l.assert('k');
    l.fail('k');
    l.fail('k');
    expect(() => l.assert('k')).toThrow();
  });

  it('prunes expired keys first, then the oldest, and stays under the cap', () => {
    let now = 0;
    const l = new RateLimiter(5, 1_000, { maxKeys: 100, now: () => now });
    for (let i = 0; i < 100; i++) l.fail(`old${i}`);
    expect(l.size).toBe(100);
    now = 2_000;
    l.fail('fresh');
    expect(l.size).toBe(1);
    for (let i = 0; i < 1_000; i++) l.fail(`flood${i}`);
    expect(l.size).toBeLessThanOrEqual(100);
    // the newest keys survive, the oldest were dropped
    for (let i = 0; i < 4; i++) l.fail('flood999');
    expect(() => l.assert('flood999')).toThrow();
    expect(() => l.assert('fresh')).not.toThrow();
  });
});

describe('createClientKey (TRUST_PROXY)', () => {
  const keyOf = async (fn: ReturnType<typeof createClientKey>, headers: Record<string, string>, remoteAddress?: string) => {
    const probe = new Hono();
    let out = '';
    probe.get('/', (c) => ((out = fn(c)), c.text('ok')));
    await probe.request('/', { headers }, remoteAddress ? { incoming: { socket: { remoteAddress } } } : undefined);
    return out;
  };

  it('ignores X-Forwarded-For by default and warns once', async () => {
    const warn = vi.fn();
    const fn = createClientKey(false, warn);
    expect(await keyOf(fn, { 'x-forwarded-for': '1.1.1.1' }, '9.9.9.9')).toBe('9.9.9.9');
    expect(await keyOf(fn, { 'x-forwarded-for': '2.2.2.2' }, '9.9.9.9')).toBe('9.9.9.9');
    expect(await keyOf(fn, {}, undefined)).toBe('local');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('TRUST_PROXY=1');
  });

  it('does not warn without the header', async () => {
    const warn = vi.fn();
    await keyOf(createClientKey(false, warn), {}, '9.9.9.9');
    expect(warn).not.toHaveBeenCalled();
  });

  it('uses the rightmost entry the proxy appended when trusted, and falls back to the socket', async () => {
    const warn = vi.fn();
    const fn = createClientKey(true, warn);
    expect(await keyOf(fn, { 'x-forwarded-for': 'spoofed, 3.3.3.3' }, '9.9.9.9')).toBe('3.3.3.3');
    expect(await keyOf(fn, {}, '9.9.9.9')).toBe('9.9.9.9');
    expect(warn).not.toHaveBeenCalled();
  });
});
