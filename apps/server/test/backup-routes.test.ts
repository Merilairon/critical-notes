/** Admin backup endpoints (Task M3.4, docs/design/backup.md 10, 13, 14, 19 "HTTP"). */
import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupListDto, BackupStartedDto, BackupTicketDto } from '@cn/shared';
import { createApp, createServices } from '../src/app';
import { internalAuth } from '../src/auth/session';
import { users } from '../src/db/schema';
import { hashPassword } from '../src/lib/password';
import { isAllowed } from '../src/mcp/api';
import { BackupError, BackupService, BackupZipError, backupNameFor, failureCode, type BackupServiceOptions } from '../src/services/backups';
import { MAX_CONCURRENT_DOWNLOADS, FAILURE_TEXT, downloadLimits } from '../src/routes/backups';
import { createFixture, TestClient, type Fixture, type TestApp } from './helpers';

const PW = 'correct horse battery';
const PW2 = 'another long password';
const NAME = 'backup-20260101T000000Z.zip';
const MiB = 1024 * 1024;

let fx: Fixture;
let app: TestApp;
let services: ReturnType<typeof createApp>['services'];
let admin: TestClient;
let adminId: string;
let events: Record<string, unknown>[];
let infoSpy: ReturnType<typeof vi.spyOn>;
let service: BackupService;
const bdir = () => fx.config.backupDir;

/** A fresh app (fresh limiters and tickets) with its own BackupService (options for hooks and config). */
function boot(opts: Partial<BackupServiceOptions> = {}, keep?: number, cfg: Partial<typeof fx.config> = {}) {
  const config = { ...fx.config, ...(keep === undefined ? {} : { backupKeep: keep }), ...cfg };
  service = new BackupService({ db: fx.db, config, warn: () => undefined, opsLog: false, ...opts });
  const deps = { config, indexDb: fx.indexDb, db: fx.db };
  ({ app, services } = createApp(deps, { ...createServices(deps), backups: service }));
}

async function login(username: string, password = PW) {
  const c = new TestClient(app);
  expect((await c.post('/api/auth/login', { username, password })).status).toBe(200);
  return c;
}

/** Raw request that keeps the body as bytes (TestClient parses non-JSON bodies as text). */
const raw = (c: TestClient, path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  app.request(`http://localhost${path}`, { ...init, headers: { host: 'localhost', origin: 'http://localhost', cookie: c.cookie, ...init.headers } });

const seedFile = (name: string, data: Buffer) => writeFileSync(join(bdir(), name), data, { mode: 0o600 });
const ticketFor = async (c: TestClient, name = NAME, pw = PW) => {
  const r = await c.post(`/api/admin/backups/${name}/ticket`, { currentPassword: pw });
  return { ...r, ticket: (r.body as BackupTicketDto).ticket };
};
/** Downloads that succeed are read to the end, as a browser does (an unread body would hold its lease). */
const okDl = async (c: TestClient, name: string, ticket: string) => {
  const res = await dl(c, name, ticket);
  await res.arrayBuffer();
  return res.status;
};
const dl = (c: TestClient, name: string, ticket: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  raw(c, `/api/admin/backups/${name}?ticket=${encodeURIComponent(ticket)}`, init);
const auditOf = (event: string) => events.filter((e) => e.event === event);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  fx = await createFixture();
  // first-run setup creates the admin 'dm'
  const { app: a } = createApp({ config: fx.config, indexDb: fx.indexDb, db: fx.db });
  expect((await new TestClient(a).post('/api/auth/setup', { username: 'dm', displayName: 'DM', password: PW })).status).toBe(201);
  adminId = fx.db.select().from(users).get()!.id;
  fx.db.insert(users).values({ id: 'admin2', username: 'boss', displayName: 'Boss', passwordHash: await hashPassword(PW2), isAdmin: true }).run();
  fx.db.insert(users).values({ id: 'pat', username: 'pat', displayName: 'Pat', passwordHash: await hashPassword(PW2), isAdmin: false }).run();
});
afterAll(() => fx.cleanup());

beforeEach(async () => {
  rmSync(bdir(), { recursive: true, force: true });
  events = [];
  infoSpy = vi.spyOn(console, 'info').mockImplementation((line: unknown) => {
    try {
      events.push(JSON.parse(String(line)));
    } catch {
      /* not an audit line */
    }
  });
  boot();
  admin = await login('dm');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('access', () => {
  const calls: [string, string, unknown?][] = [
    ['GET', '/api/admin/backups'],
    ['POST', '/api/admin/backups', {}],
    ['POST', `/api/admin/backups/${NAME}/ticket`, { currentPassword: PW }],
    ['GET', `/api/admin/backups/${NAME}?ticket=x`],
  ];

  it('anonymous callers get 401, non-admins 403', async () => {
    const anon = new TestClient(app);
    const pat = await login('pat', PW2);
    for (const [m, p, b] of calls) {
      expect((await anon.request(m, p, b)).status, `anon ${m} ${p}`).toBe(401);
      expect((await pat.request(m, p, b)).status, `pat ${m} ${p}`).toBe(403);
    }
    expect(service.isRunning()).toBe(false);
  });

  it('an admin API token (either scope) gets 403 on every route, and no backup is started', async () => {
    for (const scope of ['read', 'write'] as const) {
      for (const [m, p, b] of calls) {
        const res = await app.request(`http://internal${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }, internalAuth({ userId: adminId, scope }));
        expect(res.status, `${scope} ${m} ${p}`).toBe(403);
      }
    }
    expect(auditOf('backup.created')).toHaveLength(0);
  });

  it('is unreachable from the MCP allowlist, for every route and every method', () => {
    const concrete = (p: string) => p.replace(/:[a-zA-Z]+/g, NAME).replace(/\*/g, 'x');
    const mine = app.routes.filter((r) => r.path.startsWith('/api/admin/backups'));
    expect([...new Set(mine.map((r) => `${r.method} ${r.path}`))].sort()).toEqual(
      ['GET /api/admin/backups', 'GET /api/admin/backups/:name', 'POST /api/admin/backups', 'POST /api/admin/backups/:name/ticket'].sort(),
    );
    for (const r of mine) for (const m of ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE']) expect(isAllowed(m, concrete(r.path)), `${m} ${r.path}`).toBe(false);
    for (const p of ['/api/admin/backups', `/api/admin/backups/${NAME}`, `/api/admin/backups/${NAME}/ticket`, '/api/admin/backups/restore'])
      for (const m of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) expect(isAllowed(m, p), `${m} ${p}`).toBe(false);
    expect(isAllowed('GET', '/api/campaigns')).toBe(true); // the check can say yes
  });

  it('has no delete route and no restore route', async () => {
    seedFile(NAME, Buffer.from('x'));
    for (const [m, p] of [
      ['DELETE', `/api/admin/backups/${NAME}`],
      ['PUT', `/api/admin/backups/${NAME}`],
      ['PATCH', `/api/admin/backups/${NAME}`],
      ['POST', `/api/admin/backups/${NAME}`],
      ['POST', '/api/admin/backups/restore'],
      ['POST', `/api/admin/backups/${NAME}/restore`],
      ['POST', `/api/admin/backups/${NAME}/delete`],
      ['DELETE', '/api/admin/backups'],
    ] as const) {
      const res = await admin.request(m, p, {});
      expect(res.status, `${m} ${p}`).toBe(404);
    }
    expect((await fsp.readdir(bdir())).includes(NAME)).toBe(true);
  });

  it('the POST routes enforce the origin and content-type check (CSRF)', async () => {
    const post = (path: string, headers: Record<string, string>, body = '{}') =>
      app.request(`http://localhost${path}`, { method: 'POST', headers: { host: 'localhost', cookie: admin.cookie, 'content-length': String(body.length), ...headers }, body });
    for (const path of ['/api/admin/backups', `/api/admin/backups/${NAME}/ticket`]) {
      expect((await post(path, { origin: 'https://evil.example', 'content-type': 'application/json' }, JSON.stringify({ currentPassword: PW }))).status, `origin ${path}`).toBe(403);
      expect((await post(path, { origin: 'http://localhost', 'content-type': 'text/plain' }, JSON.stringify({ currentPassword: PW }))).status, `type ${path}`).toBe(403);
    }
    expect(auditOf('backup.created')).toHaveLength(0);
    expect(auditOf('backup.ticket_issued')).toHaveLength(0);
    expect(service.isRunning()).toBe(false);
  });
});

describe('create and list', () => {
  it('the list carries the schedule: null when off, the interval (and the next run once started) when on', async () => {
    expect(((await admin.get('/api/admin/backups')).body as BackupListDto).schedule).toBeNull();
    boot({}, undefined, { backupEveryHours: 3 });
    admin = await login('dm');
    expect(((await admin.get('/api/admin/backups')).body as BackupListDto).schedule).toEqual({ everyHours: 3, nextRunAt: null });
    services.backupScheduler.start();
    try {
      await vi.waitFor(async () => {
        const sch = ((await admin.get('/api/admin/backups')).body as BackupListDto).schedule;
        expect(sch?.everyHours).toBe(3);
        expect(Date.parse(sch!.nextRunAt!)).toBeGreaterThan(Date.now());
      });
    } finally {
      await services.backupScheduler.stop();
    }
  });

  it('POST starts a backup as trigger api with the admin id as actor, and the list shows it with manifest facts', async () => {
    const res = await admin.post('/api/admin/backups');
    expect(res.status).toBe(202);
    expect(res.res.headers.get('cache-control')).toBe('no-store');
    const started = res.body as BackupStartedDto;
    expect(['running', 'done']).toContain(started.status);
    await vi.waitFor(() => expect(service.isRunning()).toBe(false));
    const list = (await admin.get('/api/admin/backups')).body as BackupListDto;
    expect(list.running).toBeNull();
    expect(list.lastError).toBeNull();
    expect(list.backups).toHaveLength(1);
    const b = list.backups[0]!;
    expect(b.name).toMatch(/^backup-\d{8}T\d{6}Z\.zip$/);
    expect(b.trigger).toBe('api');
    expect(b.size).toBeGreaterThan(0);
    expect(b.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(b.migrationLevel).toMatch(/^\d{4}_/);
    expect(b.appVersion).toEqual(expect.any(String));
    expect(b.counts).toEqual({ users: 3, campaigns: 0, uploads: 0 });
    expect(b.missingUploads).toBe(0);
    const created = auditOf('backup.created');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ actor: adminId, trigger: 'api', name: b.name }); // the id, not the username
    expect(JSON.stringify(list)).not.toContain(fx.root); // no absolute path anywhere
  });

  it('nothing in the request can set the trigger', async () => {
    const res = await app.request('http://localhost/api/admin/backups?trigger=cli', {
      method: 'POST',
      headers: { host: 'localhost', origin: 'http://localhost', cookie: admin.cookie, 'content-type': 'application/json', 'x-trigger': 'scheduler' },
      body: JSON.stringify({ trigger: 'cli', actor: 'someone' }),
    });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(service.isRunning()).toBe(false));
    const b = ((await admin.get('/api/admin/backups')).body as BackupListDto).backups[0]!;
    expect(b.trigger).toBe('api');
    expect(auditOf('backup.created')[0]).toMatchObject({ actor: adminId, trigger: 'api' });
  });

  it('answers 202 while the backup runs, 409 to a second request, and the list shows running and then the file', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    boot({ hooks: { beforeSnapshot: () => gate } });
    admin = await login('dm');
    const first = await admin.post('/api/admin/backups');
    expect(first.status).toBe(202);
    expect((first.body as BackupStartedDto).status).toBe('running');
    expect((first.body as BackupStartedDto).name).toMatch(/^backup-/);
    const second = await admin.post('/api/admin/backups');
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'A backup is already running' });
    const mid = (await admin.get('/api/admin/backups')).body as BackupListDto;
    expect(mid.running).toMatchObject({ name: (first.body as BackupStartedDto).name });
    expect(mid.backups).toHaveLength(0);
    open();
    // create() publishes, prunes and only then clears `running`: both are eventually consistent, so wait for both
    await vi.waitFor(async () => {
      const l = (await admin.get('/api/admin/backups')).body as BackupListDto;
      expect(l.backups).toHaveLength(1);
      expect(l.running).toBeNull();
    });
  });

  it('answers 409 with the documented message when the web page already made 3 x keep recent backups', async () => {
    boot({}, 1);
    admin = await login('dm');
    mkdirSync(bdir(), { recursive: true });
    const now = Date.now();
    for (let i = 1; i <= 3; i++) seedFile(backupNameFor(now - i * 60_000), Buffer.from('not a zip')); // unreadable manifest: classed api
    const res = await admin.post('/api/admin/backups');
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Too many recent backups were made from the web page (3)');
    expect(res.body.error).toContain('node dist/admin.mjs backup');
    expect(service.isRunning()).toBe(false);
    expect((await fsp.readdir(bdir())).filter((n) => n.startsWith('backup-'))).toHaveLength(3);
  });

  it('refuses while a restore marker exists (409, fixed text)', async () => {
    writeFileSync(join(fx.config.dataDir, '.restore-in-progress'), '{}');
    try {
      const res = await admin.post('/api/admin/backups');
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/restore is running or was interrupted/);
    } finally {
      rmSync(join(fx.config.dataDir, '.restore-in-progress'), { force: true });
    }
  });

  it('disk shortage is a fixed 507 text without the directory path', async () => {
    boot({ hooks: { freeBytes: () => 0 } });
    admin = await login('dm');
    const res = await admin.post('/api/admin/backups');
    expect(res.status).toBe(507);
    expect(res.body.error).toMatch(/Not enough free disk space/);
    expect(JSON.stringify(res.body)).not.toContain(fx.root);
    expect(JSON.stringify(res.body)).not.toMatch(/MiB/);
  });

  it('a failed backup is reported by the list as a fixed sentence, never raw error text or a path', async () => {
    boot({
      hooks: {
        beforeVerify: () => {
          throw new Error(`EACCES: permission denied, open '${fx.root}/secret/path.zip'`);
        },
      },
    });
    admin = await login('dm');
    const res = await admin.post('/api/admin/backups');
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(service.isRunning()).toBe(false));
    const list = (await admin.get('/api/admin/backups')).body as BackupListDto;
    expect(list.lastError).toBe(FAILURE_TEXT.failed);
    expect(JSON.stringify(list)).not.toMatch(/EACCES|secret|\/tmp/);
    expect(list.backups).toHaveLength(0);
    expect(auditOf('backup.failed')[0]).toMatchObject({ actor: adminId }); // the server log keeps the detail
  });

  it('limits starts to 3 per admin per 10 minutes', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await admin.post('/api/admin/backups');
      expect(r.status).toBe(202);
      await vi.waitFor(() => expect(service.isRunning()).toBe(false));
    }
    const res = await admin.post('/api/admin/backups');
    expect(res.status).toBe(429);
    expect(res.res.headers.get('retry-after')).toBeTruthy();
  });

  it('the list ignores foreign files, a corrupt zip is classed api and has no details', async () => {
    mkdirSync(bdir(), { recursive: true });
    seedFile('notes.txt', Buffer.from('hi'));
    seedFile('backup-x.zip', Buffer.from('hi'));
    seedFile(NAME, Buffer.from('corrupt'));
    const list = (await admin.get('/api/admin/backups')).body as BackupListDto;
    expect(list.backups).toEqual([{ name: NAME, size: 7, createdAt: '2026-01-01T00:00:00.000Z', trigger: 'api', appVersion: null, migrationLevel: null, counts: null, missingUploads: null }]);
  });
});

describe('download ticket', () => {
  beforeEach(() => {
    mkdirSync(bdir(), { recursive: true });
    seedFile(NAME, Buffer.from('zip bytes'));
  });

  it('needs the admin password: a wrong one is 403, audited, issues nothing', async () => {
    const res = await admin.post(`/api/admin/backups/${NAME}/ticket`, { currentPassword: 'nope nope nope' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Your password is wrong' });
    expect(auditOf('backup.ticket_denied')[0]).toMatchObject({ actor: adminId, name: NAME, reason: 'wrong_password' });
    expect(auditOf('backup.ticket_issued')).toHaveLength(0);
    expect((await admin.post(`/api/admin/backups/${NAME}/ticket`, {})).status).toBe(400); // password missing
    expect((await admin.post(`/api/admin/backups/${NAME}/ticket`, { currentPassword: PW, extra: 1 })).status).toBe(400);
  });

  it('issues a no-store ticket that is audited without logging the ticket or the password', async () => {
    const r = await ticketFor(admin);
    expect(r.status).toBe(200);
    expect(r.res.headers.get('cache-control')).toBe('no-store');
    expect(r.body.expiresInSec).toBe(60);
    expect(r.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(auditOf('backup.ticket_issued')[0]).toMatchObject({ actor: adminId, name: NAME });
    const res = await dl(admin, NAME, r.ticket);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    const logged = infoSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(logged).not.toContain(r.ticket);
    expect(logged).not.toContain(PW);
    expect(logged).not.toContain('zip bytes');
  });

  it('a malformed name is a 404 before the password is checked or counted', async () => {
    for (const bad of ['..', 'notes.txt', 'backup-x.zip', `${NAME}%0A`, '%2e%2e']) {
      const res = await admin.post(`/api/admin/backups/${bad}/ticket`, { currentPassword: 'wrong wrong wrong' });
      expect(res.status, bad).toBe(404);
    }
    expect(auditOf('backup.ticket_denied')).toHaveLength(0);
  });

  it('is limited to 5 per admin per minute, counting every attempt (the budget is spent before the password is checked)', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => admin.post(`/api/admin/backups/${NAME}/ticket`, { currentPassword: PW })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(3);
    expect(auditOf('backup.ticket_denied').filter((e) => e.reason === 'rate_limited')).toHaveLength(3);
  });

  it('wrong passwords spend the same budget', async () => {
    for (let i = 0; i < 5; i++) expect((await admin.post(`/api/admin/backups/${NAME}/ticket`, { currentPassword: 'wrong wrong wrong' })).status).toBe(403);
    expect((await admin.post(`/api/admin/backups/${NAME}/ticket`, { currentPassword: PW })).status).toBe(429);
  });
});

describe('download', () => {
  const body = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 31 + 7) % 251));
  beforeEach(() => {
    mkdirSync(bdir(), { recursive: true });
    seedFile(NAME, body);
  });

  it('streams the file with the safe headers, ignores Range, skips compression, audits the download', async () => {
    const { ticket } = await ticketFor(admin);
    const res = await dl(admin, NAME, ticket, { headers: { range: 'bytes=10-20', 'accept-encoding': 'gzip, br' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${NAME}"`);
    expect(res.headers.get('content-length')).toBe(String(body.length));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('accept-ranges')).toBe('none');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-range')).toBeNull();
    expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
    expect(auditOf('backup.downloaded')[0]).toMatchObject({ actor: adminId, name: NAME });
    expect(JSON.stringify(events)).not.toContain(ticket);
  });

  it('a ticket is single use: the replay is refused and audited', async () => {
    const { ticket } = await ticketFor(admin);
    expect(await okDl(admin, NAME, ticket)).toBe(200);
    const again = await dl(admin, NAME, ticket);
    expect(again.status).toBe(404);
    expect(auditOf('backup.ticket_denied').at(-1)).toMatchObject({ actor: adminId, reason: 'invalid_ticket' });
  });

  it('a ticket expires after 60 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { ticket } = await ticketFor(admin);
    vi.setSystemTime(Date.now() + 59_000);
    const { ticket: second } = await ticketFor(admin);
    vi.setSystemTime(Date.now() + 2_000); // 61 s after the first, 2 s after the second
    expect((await dl(admin, NAME, ticket)).status).toBe(404);
    expect(await okDl(admin, NAME, second)).toBe(200);
  });

  it('a ticket is bound to the file name', async () => {
    const other = 'backup-20260102T000000Z.zip';
    seedFile(other, Buffer.from('other'));
    const { ticket } = await ticketFor(admin);
    expect((await dl(admin, other, ticket)).status).toBe(404);
    expect((await dl(admin, NAME, ticket)).status).toBe(404); // burnt by the wrong-name attempt
  });

  it('a ticket is bound to the admin', async () => {
    const boss = await login('boss', PW2);
    const { ticket } = await ticketFor(admin);
    expect((await dl(boss, NAME, ticket)).status).toBe(404);
    expect((await dl(admin, NAME, ticket)).status).toBe(404); // burnt
  });

  it('a ticket is bound to the session: the same admin in another session cannot use it', async () => {
    const other = await login('dm');
    expect(other.cookie).not.toBe(admin.cookie);
    const { ticket } = await ticketFor(admin);
    expect((await dl(other, NAME, ticket)).status).toBe(404);
    const { ticket: t2 } = await ticketFor(admin);
    expect(await okDl(admin, NAME, t2)).toBe(200);
  });

  it('a ticket alone is worth nothing: anonymous, non-admin and token callers are refused', async () => {
    const { ticket } = await ticketFor(admin);
    expect((await raw(new TestClient(app), `/api/admin/backups/${NAME}?ticket=${ticket}`)).status).toBe(401);
    const pat = await login('pat', PW2);
    expect((await dl(pat, NAME, ticket)).status).toBe(403);
    const tokenRes = await app.request(`http://internal/api/admin/backups/${NAME}?ticket=${ticket}`, {}, internalAuth({ userId: adminId, scope: 'write' }));
    expect(tokenRes.status).toBe(403);
    expect(await okDl(admin, NAME, ticket)).toBe(200); // the ticket survived all of that
  });

  it('missing or garbage tickets, and unknown files, all give the same uniform 404', async () => {
    const { ticket } = await ticketFor(admin);
    const unknown = 'backup-20260303T000000Z.zip';
    const { ticket: tUnknown } = await ticketFor(admin, unknown); // a ticket may be issued for any well-formed name
    const responses = [
      await raw(admin, `/api/admin/backups/${NAME}`),
      await dl(admin, NAME, 'garbage'),
      await dl(admin, NAME, 'x'.repeat(5000)),
      await dl(admin, unknown, tUnknown),
      await dl(admin, '..', ticket),
    ];
    const bodies = await Promise.all(responses.map(async (r) => [r.status, await r.text()]));
    for (const b of bodies) expect(b).toEqual([404, JSON.stringify({ error: 'Not found' })]);
  });

  it('refuses traversal and malformed names before any file system call or ticket check', async () => {
    const { ticket } = await ticketFor(admin);
    const open = vi.spyOn(services.backups, 'openForDownload');
    const names = [
      '..',
      '%2e%2e',
      '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '..%2fapp.sqlite',
      `..%5c${NAME}`,
      `%5c${NAME}`,
      encodeURIComponent(`${NAME}\n`),
      encodeURIComponent(`x\n${NAME}`),
      `${NAME}%00`,
      'a'.repeat(5000),
      NAME.replace('.zip', ''),
      NAME.replace('2026', '26'),
      NAME.toUpperCase(),
      `${NAME}.bak`,
      '.partial-0123456789ab.zip',
      '.lock',
    ];
    for (const n of names) {
      const res = await dl(admin, n, ticket);
      expect(res.status, n).toBe(404);
    }
    expect(open).not.toHaveBeenCalled();
    expect(auditOf('backup.downloaded')).toHaveLength(0);
    // none of that burnt the ticket: it never reached the ticket check
    expect(await okDl(admin, NAME, ticket)).toBe(200);
  });

  it('refuses a symlink named like a backup, and a directory named like one', async () => {
    const secret = join(fx.root, 'secret.txt');
    writeFileSync(secret, 'TOP SECRET');
    const link = 'backup-20260201T000000Z.zip';
    const dir = 'backup-20260202T000000Z.zip';
    symlinkSync(secret, join(bdir(), link));
    mkdirSync(join(bdir(), dir));
    for (const n of [link, dir]) {
      const { ticket } = await ticketFor(admin, n);
      const res = await dl(admin, n, ticket);
      expect(res.status, n).toBe(404);
      expect(await res.text()).not.toContain('SECRET');
    }
    const list = (await admin.get('/api/admin/backups')).body as BackupListDto;
    expect(list.backups.map((b) => b.name)).toEqual([NAME]); // the list does not show them either
  });

  it('streams without buffering: bytes read from disk follow the reader, and a cancelled download frees its lease', async () => {
    const big = 'backup-20260110T000000Z.zip';
    seedFile(big, Buffer.alloc(48 * MiB, 7));
    const probe = await fsp.open(join(bdir(), big));
    const proto = Object.getPrototypeOf(probe) as { read: (...a: unknown[]) => Promise<{ bytesRead: number }> };
    await probe.close();
    let read = 0;
    const orig = proto.read;
    const spy = vi.spyOn(proto, 'read').mockImplementation(async function (this: unknown, ...a: unknown[]) {
      const r = await orig.apply(this, a);
      read += r.bytesRead;
      return r;
    });
    const { ticket } = await ticketFor(admin, big);
    const res = await dl(admin, big, ticket);
    expect(res.status).toBe(200);
    expect(Number(res.headers.get('content-length'))).toBe(48 * MiB);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.value!.length).toBeGreaterThan(0);
    await sleep(150);
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(4 * MiB); // 48 MiB file, nobody is reading: a buffering implementation would be at 48 MiB
    expect((service as unknown as { leases: Map<string, number> }).leases.has(big)).toBe(true);
    await reader.cancel();
    await vi.waitFor(() => expect((service as unknown as { leases: Map<string, number> }).leases.has(big)).toBe(false));
    expect(read).toBeLessThan(8 * MiB);
    spy.mockRestore();
  });

  it('reads the whole large file when the client keeps reading', async () => {
    const big = 'backup-20260111T000000Z.zip';
    seedFile(big, Buffer.alloc(20 * MiB, 9));
    const { ticket } = await ticketFor(admin, big);
    const res = await dl(admin, big, ticket);
    let n = 0;
    let max = 0;
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      max = Math.max(max, value.length);
    }
    expect(n).toBe(20 * MiB);
    expect(max).toBeLessThanOrEqual(256 * 1024); // chunks, never the whole file
  });

  it('allows 3 downloads at a time per process, then 429; finishing one frees a slot', async () => {
    const held = [];
    for (let i = 0; i < MAX_CONCURRENT_DOWNLOADS; i++) {
      const { ticket } = await ticketFor(admin);
      const res = await dl(admin, NAME, ticket);
      expect(res.status).toBe(200);
      held.push(res);
    }
    const { ticket } = await ticketFor(admin);
    expect((await dl(admin, NAME, ticket)).status).toBe(429);
    await held[0]!.body!.cancel();
    await vi.waitFor(async () => {
      const { ticket: t } = await ticketFor(admin);
      expect(await okDl(admin, NAME, t)).toBe(200);
    });
    for (const h of held.slice(1)) await h.body!.cancel();
  });

  it('pruning while a download streams does not break that download (the open descriptor survives)', async () => {
    const { ticket } = await ticketFor(admin);
    const res = await dl(admin, NAME, ticket);
    const reader = res.body!.getReader();
    const first = await reader.read();
    await fsp.unlink(join(bdir(), NAME)); // what a prune by another process does
    const parts: Buffer[] = [Buffer.from(first.value!)];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
    }
    expect(Buffer.concat(parts).equals(body)).toBe(true);
  });
});

describe('hardening (review round 1)', () => {
  beforeEach(() => {
    mkdirSync(bdir(), { recursive: true });
    seedFile(NAME, Buffer.from('zip bytes'));
  });
  afterEach(() => {
    downloadLimits.idleMs = 60_000;
  });
  const leases = () => (service as unknown as { leases: Map<string, number> }).leases;

  it('a stalled reader is cut off after the idle time: its slot and lease are freed', async () => {
    downloadLimits.idleMs = 200;
    const big = 'backup-20260120T000000Z.zip';
    seedFile(big, Buffer.alloc(8 * MiB, 3));
    const held = [];
    for (let i = 0; i < MAX_CONCURRENT_DOWNLOADS; i++) {
      const { ticket } = await ticketFor(admin, big);
      const res = await dl(admin, big, ticket);
      expect(res.status).toBe(200);
      held.push(res); // never read
    }
    expect(leases().has(big)).toBe(true);
    const { ticket: blocked } = await ticketFor(admin, big);
    expect((await dl(admin, big, blocked)).status).toBe(429);
    await vi.waitFor(() => expect(leases().has(big)).toBe(false), { timeout: 3000 });
    expect(await okDl(admin, big, blocked)).toBe(200); // slots are back, and the 429 did not burn the ticket
    // the stalled reader gets an error, not a silent hang
    await expect(held[0]!.arrayBuffer()).rejects.toThrow();
  });

  it('a 429 on the slot check does not burn the ticket', async () => {
    const held = [];
    for (let i = 0; i < MAX_CONCURRENT_DOWNLOADS; i++) {
      const { ticket } = await ticketFor(admin);
      held.push(await dl(admin, NAME, ticket));
    }
    const { ticket } = await ticketFor(admin);
    expect((await dl(admin, NAME, ticket)).status).toBe(429);
    await held[0]!.body!.cancel();
    await vi.waitFor(async () => expect((await Promise.resolve(dl(admin, NAME, ticket)).then((r) => (r.status === 200 ? r.body!.cancel().then(() => 200) : r.status)))).toBe(200));
    for (const h of held.slice(1)) await h.body!.cancel();
  });

  it('a FIFO named like a backup is refused without hanging', async () => {
    const fifo = 'backup-20260121T000000Z.zip';
    execFileSync('mkfifo', [join(bdir(), fifo)]);
    const { ticket } = await ticketFor(admin, fifo);
    const res = await Promise.race([dl(admin, fifo, ticket), sleep(3000).then(() => 'hung' as const)]);
    expect(res).not.toBe('hung');
    expect((res as Response).status).toBe(404);
    expect((await admin.get('/api/admin/backups')).status).toBe(200); // the list does not hang on it either
  });

  it('a hard link to another file is refused', async () => {
    const other = join(fx.root, 'other-file.bin');
    writeFileSync(other, 'NOT A BACKUP');
    const linked = 'backup-20260122T000000Z.zip';
    linkSync(other, join(bdir(), linked));
    const { ticket } = await ticketFor(admin, linked);
    const res = await dl(admin, linked, ticket);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('NOT A BACKUP');
    expect(leases().size).toBe(0);
  });

  it('HEAD sends no bytes, is not audited as a download and does not burn the ticket', async () => {
    const { ticket } = await ticketFor(admin);
    const head = await dl(admin, NAME, ticket, { method: 'HEAD' });
    expect(head.status).toBe(405);
    expect(await head.text()).toBe('');
    expect(auditOf('backup.downloaded')).toHaveLength(0);
    expect(auditOf('backup.ticket_denied')).toHaveLength(0);
    expect(leases().size).toBe(0);
    expect(await okDl(admin, NAME, ticket)).toBe(200); // the ticket is still good for the real GET
    expect(auditOf('backup.downloaded')).toHaveLength(1);
  });

  it('audit lines carry the client address (ticket issued and denied, downloaded, created)', async () => {
    await admin.post(`/api/admin/backups/${NAME}/ticket`, { currentPassword: 'wrong wrong wrong' });
    const { ticket } = await ticketFor(admin);
    await okDl(admin, NAME, ticket);
    await Promise.resolve(dl(admin, NAME, 'bad')).then((r) => r.text());
    await admin.post('/api/admin/backups');
    await vi.waitFor(() => expect(auditOf('backup.created')).toHaveLength(1));
    for (const e of ['backup.ticket_issued', 'backup.ticket_denied', 'backup.downloaded', 'backup.created']) {
      for (const line of auditOf(e)) expect(line.ip, e).toBe('local');
    }
  });

  it('the address honours TRUST_PROXY (the rightmost X-Forwarded-For entry), and is ignored without it', async () => {
    boot({}, undefined, { trustProxy: true });
    admin = await login('dm');
    const r = await app.request(`http://localhost/api/admin/backups/${NAME}/ticket`, {
      method: 'POST',
      headers: { host: 'localhost', origin: 'http://localhost', cookie: admin.cookie, 'content-type': 'application/json', 'x-forwarded-for': '1.1.1.1, 203.0.113.9' },
      body: JSON.stringify({ currentPassword: PW }),
    });
    expect(r.status).toBe(200);
    expect(auditOf('backup.ticket_issued').at(-1)!.ip).toBe('203.0.113.9');
  });

  it('other routes keep Referrer-Policy: same-origin; only the download says no-referrer', async () => {
    const health = await app.request('http://localhost/api/health');
    expect(health.headers.get('referrer-policy')).toBe('same-origin');
    expect(health.headers.get('content-security-policy')).toBeTruthy();
    expect((await admin.get('/api/admin/backups')).res.headers.get('referrer-policy')).toBe('same-origin');
    const { ticket } = await ticketFor(admin);
    const res = await dl(admin, NAME, ticket);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toBeTruthy();
    await res.arrayBuffer();
  });

  it('every failure code maps to its own fixed sentence on the list, and the service derives the code from the error', async () => {
    for (const code of Object.keys(FAILURE_TEXT) as (keyof typeof FAILURE_TEXT)[]) {
      vi.spyOn(service, 'status').mockReturnValueOnce({ running: null, lastError: `/secret/${code} raw`, lastErrorCode: code, lastWarnings: [] });
      const list = (await admin.get('/api/admin/backups')).body as BackupListDto;
      expect(list.lastError, code).toBe(FAILURE_TEXT[code]);
      expect(JSON.stringify(list)).not.toContain('/secret');
    }
    expect(new Set(Object.values(FAILURE_TEXT)).size).toBe(Object.keys(FAILURE_TEXT).length);
    const errno = Object.assign(new Error('x'), { code: 'ENOSPC' });
    expect(failureCode(new BackupError('disk', 'm'))).toBe('disk');
    expect(failureCode(new BackupError('too-many-files', 'm'))).toBe('too-many-files');
    expect(failureCode(new BackupError('db-timeout', 'm'))).toBe('db-timeout');
    expect(failureCode(new BackupError('invalid-dir', 'm'))).toBe('failed');
    expect(failureCode(new BackupZipError('invalid', 'd'))).toBe('verify');
    expect(failureCode(errno)).toBe('no-space');
    expect(failureCode(new Error('whatever'))).toBe('failed');
    expect(failureCode('weird')).toBe('failed');
  });
});

describe('DownloadTickets (unit)', () => {
  it('each binding is checked on its own, a ticket is burnt by the first presentation, the map is bounded', async () => {
    const { DownloadTickets } = await import('../src/lib/download-tickets');
    let now = 1_000;
    const t = new DownloadTickets({ now: () => now, max: 3 });
    const mk = () => t.issue('a1', 's1', NAME);
    expect(t.redeem(mk(), 'a1', 's1', NAME)).toBe(true);
    expect(t.redeem(mk(), 'a2', 's1', NAME)).toBe(false); // same session id string, other admin
    expect(t.redeem(mk(), 'a1', 's2', NAME)).toBe(false);
    expect(t.redeem(mk(), 'a1', 's1', 'backup-20260102T000000Z.zip')).toBe(false);
    const x = mk();
    expect(t.redeem(x, 'a1', 's1', NAME)).toBe(true);
    expect(t.redeem(x, 'a1', 's1', NAME)).toBe(false);
    const y = mk();
    now += 60_000;
    expect(t.redeem(y, 'a1', 's1', NAME)).toBe(false); // exactly at the end of its 60 s
    expect(t.redeem('never issued', 'a1', 's1', NAME)).toBe(false);
    for (let i = 0; i < 50; i++) mk();
    expect(t.size).toBeLessThanOrEqual(3);
  });

  it('when full, the oldest ticket is dropped first (expired ones go before that)', async () => {
    const { DownloadTickets } = await import('../src/lib/download-tickets');
    let now = 1_000;
    const t = new DownloadTickets({ now: () => now, max: 3 });
    const [a, b, c] = [t.issue('a', 's', NAME), t.issue('a', 's', NAME), t.issue('a', 's', NAME)];
    const d = t.issue('a', 's', NAME); // full: a (the oldest) goes
    expect(t.redeem(a, 'a', 's', NAME)).toBe(false);
    expect(t.redeem(b, 'a', 's', NAME)).toBe(true);
    expect(t.redeem(c, 'a', 's', NAME)).toBe(true);
    expect(t.redeem(d, 'a', 's', NAME)).toBe(true);
    // expired entries are swept before a live one is evicted
    const e1 = t.issue('a', 's', NAME);
    now += 59_000;
    const e2 = t.issue('a', 's', NAME);
    const e3 = t.issue('a', 's', NAME);
    now += 2_000; // e1 expired, e2 and e3 live
    const e4 = t.issue('a', 's', NAME);
    expect(t.redeem(e1, 'a', 's', NAME)).toBe(false);
    for (const x of [e2, e3, e4]) expect(t.redeem(x, 'a', 's', NAME)).toBe(true);
  });
});

describe('startup (design 11)', () => {
  it('the server refuses to start on an invalid BACKUP_DIR, before touching the data directory', async () => {
    const { spawnSync } = await import('node:child_process');
    const dir = mkdtempSync(join(fx.root, 'start-'));
    const run = (backupDir: string) =>
      spawnSync(process.execPath, ['--import', 'tsx', join(import.meta.dirname, '..', 'src', 'main.ts')], {
        cwd: join(import.meta.dirname, '..'),
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, CN_SKIP_DOTENV: '1', DATA_DIR: dir, BACKUP_DIR: backupDir, PORT: '0', FIVETOOLS_SRC_PATH: join(dir, 'nope'), FIVETOOLS_IMG_PATH: join(dir, 'nope2') },
      });
    for (const bad of [dir, join(dir, 'uploads'), join(dir, 'uploads', 'sub')]) {
      const r = run(bad);
      expect(r.status, bad).toBe(1);
      expect(r.stderr).toMatch(/Refusing to start: BACKUP_DIR/);
      expect(await fsp.readdir(dir), 'nothing created').toEqual([]);
    }
  }, 120_000);
});
