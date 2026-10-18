/**
 * Restore drill (Task M3.3, docs/design/backup.md 19 "Container drill"): backup -> wipe -> restore -> start -> verify over HTTP.
 *
 *   node scripts/restore-drill.mjs [--mode dist|src] [--keep]
 *
 * `dist` (default) runs the built bundle (`pnpm --filter @cn/server build` first): `dist/main.mjs` and `dist/admin.mjs`, exactly
 * what the Docker image runs. `src` runs the sources through tsx (what the vitest wrapper uses, so the test needs no build).
 * Everything happens in a temp directory; the real `var/` and `5etools-data/` are never read or written.
 *
 * What it proves: a backup taken from a RUNNING server, the data directory wiped, `restore` onto the wiped instance, the server
 * started again: same users and campaign and page, the image byte for byte, the search index rebuilt, old sessions gone,
 * work done after the backup gone, a login with the old password works. Exit 0 = passed, 1 = failed (with the reason).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'dist';
const keep = args.includes('--keep');
if (!['dist', 'src'].includes(mode)) {
  console.error('Usage: restore-drill.mjs [--mode dist|src] [--keep]');
  process.exit(64);
}

const root = mkdtempSync(join(tmpdir(), 'cn-drill-'));
const dataDir = join(root, 'data');
const backupDir = join(root, 'backups');
const children = new Set();
let step = 'setup';
const log = (m) => console.error(`[drill] ${m}`);

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const entry = (name) => (mode === 'dist' ? [join(SERVER_DIR, 'dist', `${name}.mjs`)] : ['--import', 'tsx', join(SERVER_DIR, 'src', name === 'main' ? 'main.ts' : 'cli/admin.ts')]);
const baseEnv = (port) => ({
  ...process.env,
  CN_SKIP_DOTENV: '1',
  NODE_ENV: 'development',
  DATA_DIR: dataDir,
  BACKUP_DIR: backupDir,
  PORT: String(port),
  PUBLIC_URL: `http://127.0.0.1:${port}`,
  FIVETOOLS_SRC_PATH: join(root, 'no-5etools-src'),
  FIVETOOLS_IMG_PATH: join(root, 'no-5etools-img'),
  WEB_DIST_DIR: join(root, 'no-web'),
});

function admin(argv, port) {
  const r = spawnSync(process.execPath, [...entry('admin'), ...argv], { cwd: SERVER_DIR, env: baseEnv(port), encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

async function startServer(port) {
  const child = spawn(process.execPath, entry('main'), { cwd: SERVER_DIR, env: baseEnv(port), stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server exited with ${child.exitCode} before it was ready:\n${output.slice(-2000)}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`the server did not become ready in 120 s:\n${output.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    output: () => output,
    async stop() {
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      children.delete(child);
    },
  };
}

class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }
  async req(method, path, body, raw) {
    const headers = { origin: this.base, ...(this.cookie ? { cookie: this.cookie } : {}) };
    let payload = body;
    if (body !== undefined && !(body instanceof FormData)) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${this.base}${path}`, { method, headers, body: payload });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) if (c.startsWith('cn_session') || c.includes('=')) this.cookie = c.split(';')[0];
    if (raw) return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
}

function expect(cond, what) {
  if (!cond) throw new Error(`expected: ${what}`);
  log(`ok: ${what}`);
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const password = 'correct horse battery staple';

  step = 'first start and setup';
  let server = await startServer(port);
  const admin1 = new Client(base);
  expect((await admin1.req('POST', '/api/auth/setup', { username: 'drillmaster', displayName: 'Drill Master', password })).status === 201, 'first-run setup creates the admin');
  const camp = await admin1.req('POST', '/api/campaigns', { name: 'The Drill Campaign', ruleset: '2014' });
  expect(camp.status === 201, 'campaign created');
  const cid = camp.json.id;
  const page = await admin1.req('POST', `/api/campaigns/${cid}/pages`, { title: 'Wyvernkeep Citadel' });
  expect(page.status === 201, 'page created');
  const png = await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 200, g: 30, b: 90 } } }).png().toBuffer();
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'banner.png');
  const up = await admin1.req('POST', `/api/campaigns/${cid}/uploads`, form);
  expect(up.status === 201, 'image uploaded');
  const uploadId = up.json.id;
  const original = await admin1.req('GET', `/api/uploads/${uploadId}`, undefined, true);
  expect(original.status === 200 && original.bytes.length > 0, 'image readable');
  const originalSha = createHash('sha256').update(original.bytes).digest('hex');
  const found0 = await admin1.req('GET', `/api/campaigns/${cid}/search?q=Wyvernkeep`);
  expect(found0.json.pages.length === 1, 'the page is found by search before the backup');

  step = 'backup (server running)';
  const backup = admin(['backup'], port);
  expect(backup.code === 0, `backup exits 0 (${backup.err.split('\n').pop()})`);
  expect(/backup-\d{8}T\d{6}Z\.zip$/.test(backup.out) && !backup.out.includes('\n'), 'backup prints only the path of the zip on stdout');
  const zip = backup.out;

  step = 'work after the backup';
  expect((await admin1.req('POST', `/api/campaigns/${cid}/pages`, { title: 'Written After The Backup' })).status === 201, 'a page is written after the backup');
  await server.stop();

  step = 'wipe';
  rmSync(dataDir, { recursive: true, force: true });
  expect(readdirSync(root).includes('data') === false, 'the data directory is gone (wiped instance)');

  step = 'restore';
  const check = admin(['restore', zip, '--check'], port);
  expect(check.code === 0, `restore --check passes on the wiped instance (${check.err.split('\n').pop()})`);
  const restored = admin(['restore', zip, '--yes'], port);
  expect(restored.code === 0, `restore exits 0 (${restored.err.split('\n').pop()})`);
  expect(/Restored backup-/.test(restored.out) && !/"event"/.test(restored.out), 'restore prints the report (and no audit line) on stdout');
  const refusedMarker = admin(['reset-link', 'drillmaster'], port);
  expect(refusedMarker.code !== 75, 'the marker is gone after a completed restore (reset-link is not refused)');

  step = 'start again';
  server = await startServer(port);
  const after = new Client(base);
  expect((await admin1.req('GET', '/api/auth/me')).json.user === null, 'the old session is gone (everyone signs in again)');
  const login = await after.req('POST', '/api/auth/login', { username: 'drillmaster', password });
  expect(login.status === 200, 'login with the old password works');
  const camps = await after.req('GET', '/api/campaigns');
  expect(camps.json.campaigns.length === 1 && camps.json.campaigns[0].name === 'The Drill Campaign', 'the campaign is back');
  const tree = await after.req('GET', `/api/campaigns/${cid}/pages`);
  const titles = JSON.stringify(tree.json);
  expect(titles.includes('Wyvernkeep Citadel'), 'the page is back');
  expect(!titles.includes('Written After The Backup'), 'work done after the backup is gone');
  const img = await after.req('GET', `/api/uploads/${uploadId}`, undefined, true);
  expect(img.status === 200 && createHash('sha256').update(img.bytes).digest('hex') === originalSha, 'the image is byte-identical');
  const found = await after.req('GET', `/api/campaigns/${cid}/search?q=Wyvernkeep`);
  expect(found.json.pages.length === 1, 'the search index was rebuilt on the first start (page found)');
  const none = await after.req('GET', `/api/campaigns/${cid}/search?q=Written`);
  expect(none.json.pages.length === 0, 'the search index has no hit for work that was rolled back');
  await server.stop();
  log('PASSED');
}

try {
  await main();
  process.exitCode = 0;
} catch (e) {
  console.error(`[drill] FAILED at step "${step}": ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  for (const c of children) c.kill('SIGKILL');
  if (keep) log(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
