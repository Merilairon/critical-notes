import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import v8 from 'node:v8';
import vm from 'node:vm';
import { setTimeout as sleep } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BACKUP_KEEP, loadConfig, parseBackupKeep } from '../src/config';
import { appVersion } from '../src/lib/version';
import {
  API_CREATE_CAP_FACTOR,
  backupNameFor,
  BackupError,
  readBackup,
  snapshotDatabase,
  timestampOfName,
  validateBackupDir,
  type Trigger,
} from '../src/services/backups';
import { rawZip, testManifest } from './zip-builder';
import { makeEnv, noise, T0, upId, type BackupEnv } from './backup-helpers';

const DAY = 24 * 3600 * 1000;
v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc') as () => void;
let env: BackupEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

const bdir = () => env.config.backupDir;
const zips = () => readdirSync(bdir()).filter((n) => /^backup-.*\.zip$/.test(n));

/** A minimal backup whose first entry is a manifest with the given trigger (all that list and prune read). */
function fakeBackup(ms: number, trigger: Trigger | 'garbage' | 'foreign' | 'text' | 'empty' | 'stored'): string {
  const name = backupNameFor(ms);
  mkdirSync(bdir(), { recursive: true, mode: 0o700 });
  const path = join(bdir(), name);
  const manifest = Buffer.from(JSON.stringify(testManifest(1, { trigger: trigger === 'garbage' ? 'x' : trigger })));
  const data: Record<string, Buffer> = {
    garbage: Buffer.from('this is not a zip file'.repeat(20)),
    foreign: rawZip([{ name: 'readme.txt', data: Buffer.from('hello') }]),
    text: Buffer.from('notes'),
    empty: Buffer.alloc(0),
    stored: rawZip([{ name: 'manifest.json', data: manifest, method: 0 }]),
  };
  writeFileSync(path, data[trigger] ?? rawZip([{ name: 'manifest.json', data: manifest }]));
  return name;
}

describe('backup service: round trip and consistency', () => {
  function seedPages(n: number) {
    const ins = env.db.$client.prepare('insert into pages (id, campaign_id, sort_key, title, body) values (?, ?, ?, ?, ?)');
    const body = (i: number) => JSON.stringify({ text: noise(1000).toString('hex') + i }); // text that compresses about 2:1, like real notes
    env.db.$client.transaction(() => {
      for (let i = 0; i < n; i++) ins.run(`seed${i}`, 'c1', `a${i}`, `Seed ${i}`, body(i));
    })();
  }

  /** Inserts two paired rows per transaction on the server's own connection, one transaction per event-loop turn. */
  function startPairWriter() {
    let n = 0;
    let stop = false;
    const ins = env.db.$client.prepare('insert into pages (id, campaign_id, sort_key, title, body) values (?, ?, ?, ?, ?)');
    const body = () => JSON.stringify({ text: noise(700).toString('hex') });
    const tx = env.db.$client.transaction((i: number) => {
      ins.run(`pa${i}`, 'c1', `b${i}`, `Pair ${i} a`, body());
      ins.run(`pb${i}`, 'c1', `c${i}`, `Pair ${i} b`, body());
    });
    const tick = () => {
      if (stop) return;
      tx(n++);
      setImmediate(tick);
    };
    setImmediate(tick);
    return { count: () => n, stop: () => (stop = true) };
  }

  async function extractAndOpen(zipName: string) {
    const staging = join(env.root, `staging-${Math.random().toString(36).slice(2)}`);
    mkdirSync(staging);
    const result = await readBackup(join(bdir(), zipName), { extractTo: staging });
    return { staging, result, backup: new Database(join(staging, 'app.sqlite'), { readonly: true }) };
  }

  function checkPairs(db: Database.Database) {
    const lonely = db
      .prepare(
        `select count(*) as n from pages p where (p.id like 'pa%' and not exists (select 1 from pages q where q.id = 'pb' || substr(p.id, 3)))
            or (p.id like 'pb%' and not exists (select 1 from pages q where q.id = 'pa' || substr(p.id, 3)))`,
      )
      .get() as { n: number };
    expect(lonely.n).toBe(0);
  }

  it('a backup taken while the server writes pages holds a consistent snapshot: every pair intact, rows identical to the source', async () => {
    seedPages(3000);
    const svc = env.service();
    const writer = startPairWriter();
    let atSnapshot = 0;
    const withHook = env.service({ hooks: { afterSnapshot: () => void (atSnapshot = writer.count()) } });
    await sleep(20);
    const atStart = writer.count();
    const result = await withHook.create({ actor: 'test', trigger: 'cli' });
    writer.stop();
    await sleep(5);
    expect(atSnapshot).toBeGreaterThan(atStart); // the writer really wrote while the snapshot was taken
    expect(svc.isRunning()).toBe(false);

    const { backup } = await extractAndOpen(result.name);
    expect(backup.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    checkPairs(backup);
    const rows = backup.prepare('select count(*) as n from pages').get() as { n: number };
    expect(rows.n).toBeGreaterThanOrEqual(3000 + 2 * atStart);
    // row by row: whatever the backup holds is identical to the source (the source only gained rows since)
    const same = (table: string, key = 'id') => {
      const src = new Map((env.db.$client.prepare(`select * from ${table}`).all() as Record<string, unknown>[]).map((r) => [r[key], JSON.stringify(r)]));
      const got = backup.prepare(`select * from ${table}`).all() as Record<string, unknown>[];
      for (const r of got) expect(JSON.stringify(r)).toBe(src.get(r[key]));
      return got.length;
    };
    expect(same('pages')).toBe(rows.n);
    expect(same('users')).toBe(1);
    expect(same('campaigns')).toBe(1);
    backup.close();
  }, 60_000);

  it('another connection writing during the copy restarts it but the backup still completes, consistent', async () => {
    seedPages(1500);
    env.db.$client.exec('create table ticks (a integer, b integer)');
    const other = new Database(env.config.appDbPath, { timeout: 5000 });
    let n = 0;
    let stop = false;
    const tx = other.transaction((i: number) => {
      other.prepare('insert into ticks values (?, ?)').run(i, i);
      other.prepare('insert into ticks values (?, ?)').run(i, -i);
    });
    const timer = setInterval(() => {
      if (!stop) tx(n++);
    }, 2);
    try {
      const started = Date.now();
      const result = await env.service().create({ actor: 'test', trigger: 'cli' });
      expect(Date.now() - started).toBeLessThan(60_000);
      stop = true;
      const { backup } = await extractAndOpen(result.name);
      const bad = backup.prepare('select count(*) as n from ticks t where (select count(*) from ticks u where u.a = t.a) <> 2').get() as { n: number };
      expect(bad.n).toBe(0);
      expect(backup.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      backup.close();
    } finally {
      clearInterval(timer);
      other.close();
    }
  }, 90_000);

  it('a separate process (a CLI-like writer) writing during the copy does not stop the backup either', async () => {
    seedPages(1500);
    env.db.$client.exec('create table ticks (a integer, b integer)');
    const sqlitePath = createRequire(import.meta.url).resolve('better-sqlite3');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const D = require(process.argv[1]); const db = new D(process.argv[2]); db.pragma('busy_timeout = 5000');
         const ins = db.prepare('insert into ticks values (?, ?)'); let n = 0;
         const tx = db.transaction((i) => { ins.run(i, i); ins.run(i, -i); });
         setInterval(() => { try { tx(n++); } catch {} }, 10); console.log('ready');`,
        sqlitePath,
        env.config.appDbPath,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
      await sleep(100);
      const result = await env.service({ stepPages: 2000 }).create({ actor: 'test', trigger: 'cli' });
      const { backup } = await extractAndOpen(result.name);
      const bad = backup.prepare('select count(*) as n from ticks t where (select count(*) from ticks u where u.a = t.a) <> 2').get() as { n: number };
      expect(bad.n).toBe(0);
      expect(backup.prepare('select count(*) as n from ticks').get()).not.toEqual({ n: 0 });
      backup.close();
    } finally {
      child.kill('SIGKILL');
    }
  }, 90_000);

  it('refuses to back up a database whose copy fails its integrity check', async () => {
    // an index that no longer matches its table: the page copy cannot notice, only integrity_check can
    env.db.$client.exec(`insert into users (id, username, display_name, password_hash) values ('u7', 'zzqq-integrity-1', 'Z', 'h')`);
    env.db.$client.pragma('wal_checkpoint(TRUNCATE)');
    const file = readFileSync(env.config.appDbPath);
    const at = file.indexOf('zzqq-integrity-1');
    expect(at).toBeGreaterThan(0);
    const corrupted = Buffer.from(file);
    corrupted.write('zzqq-integrity-2', at); // the table's copy of the name; the unique index still holds -1
    const copy = join(env.root, 'corrupt-source.sqlite');
    writeFileSync(copy, corrupted);
    const source = new Database(copy);
    const err = await snapshotDatabase(source, join(env.root, 'snap.sqlite')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/integrity check/);
    source.close();
  });

  it('gives up with a clear message when the copy does not finish within the limit', async () => {
    seedPages(500);
    const svc = env.service({ stepPages: 1, dbTimeoutMs: -1 });
    const err = await svc.create({ actor: 'test', trigger: 'cli' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect((err as BackupError).code).toBe('db-timeout');
    expect(readdirSync(bdir()).filter((n) => n !== '.lock')).toEqual([]); // no temp dir, no partial, nothing published
    expect(svc.status().lastError).toMatch(/did not finish/);
  });

  it('archives uploads (main files and thumbnails) byte for byte, with the manifest facts', async () => {
    const files = new Map<string, Buffer>();
    for (let i = 1; i <= 5; i++) {
      const data = noise(1000 * i + 17);
      env.addUpload(upId(i), data, { thumb: i % 2 ? noise(300) : undefined });
      files.set(upId(i), data);
    }
    const r = await env.service().create({ actor: 'admin1', trigger: 'api' });
    const { staging, result, backup } = await extractAndOpen(r.name);
    for (const [id, data] of files) expect(readFileSync(join(staging, 'uploads', id)).equals(data)).toBe(true);
    expect(readdirSync(join(staging, 'uploads'))).toHaveLength(5 + 3);
    expect(result.manifest).toMatchObject({
      kind: 'critical-notes-backup',
      format: 1,
      trigger: 'api',
      app: { version: appVersion() },
      database: { engine: 'sqlite', latestTag: '0006_accounts' },
      counts: { users: 1, campaigns: 1, uploads: 5 },
      uploads: { files: 8, missing: 0 },
    });
    expect(result.manifest.database.migrations.map((m) => m.tag)).toEqual(['0000_init', '0001_links_properties_uploads', '0002_templates', '0003_encounters_inventory', '0004_members_invites', '0005_api_tokens', '0006_accounts']);
    expect(createHash('sha256').update(readFileSync(join(bdir(), r.name))).digest('hex')).toBe(r.sha256);
    backup.close();
  });

  it('skips non-matching names, symlinks and directories in uploads/ (and says so)', async () => {
    env.addUpload(upId(1), noise(100));
    writeFileSync(join(env.config.uploadsDir, 'notes.txt'), 'not an upload');
    writeFileSync(join(env.root, 'secret.txt'), 'outside');
    symlinkSync(join(env.root, 'secret.txt'), join(env.config.uploadsDir, upId(2)));
    mkdirSync(join(env.config.uploadsDir, upId(3)));
    const r = await env.service().create({ actor: 'a', trigger: 'cli' });
    const { staging } = await extractAndOpen(r.name);
    expect(readdirSync(join(staging, 'uploads'))).toEqual([upId(1)]);
    expect(r.warnings.some((w) => /symlink or non-file/.test(w))).toBe(true);
  });

  it('refuses to start when the uploads folder holds more files than the limit', async () => {
    const svc = env.service({ maxUploadFiles: 3 });
    for (let i = 1; i <= 4; i++) env.addUpload(upId(i), noise(10));
    const err = (await svc.create({ actor: 'a', trigger: 'cli' }).catch((e: unknown) => e)) as BackupError;
    expect(err.code).toBe('too-many-files');
    expect(zips()).toEqual([]);
  });
});

describe('backup service: order guarantee and missing files', () => {
  it('an upload added after the snapshot is an orphan or absent, never a row without a file; the post-check counts real gaps', async () => {
    env.addUpload(upId(1), noise(500));
    env.addUpload(upId(2), noise(500), { row: true });
    unlinkSync(join(env.config.uploadsDir, upId(2))); // a row whose file is gone
    const svc = env.service({
      hooks: {
        afterSnapshot: () => env.addUpload(upId(3), noise(500)), // written after T0: file first, then row, as UploadService does
      },
    });
    const r = await svc.create({ actor: 'a', trigger: 'cli' });
    expect(r.missingUploads).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/1 upload has no file/);
    const staging = join(env.root, 's');
    mkdirSync(staging);
    const res = await readBackup(join(bdir(), r.name), { extractTo: staging });
    const db = new Database(join(staging, 'app.sqlite'), { readonly: true });
    const rows = (db.prepare('select id from uploads').all() as { id: string }[]).map((x) => x.id);
    expect(rows).toEqual(expect.arrayContaining([upId(1), upId(2)]));
    expect(rows).not.toContain(upId(3)); // its row was committed after T0
    const files = readdirSync(join(staging, 'uploads'));
    for (const id of rows.filter((x) => x !== upId(2))) expect(files).toContain(id); // every row (but the damaged one) has its file
    expect(res.manifest.uploads.missing).toBe(1);
    db.close();
  });

  it('an upload committed just before the snapshot has its file in the archive (the listing is taken after the snapshot)', async () => {
    env.addUpload(upId(1), noise(500));
    // the preflight has already looked at uploads/ when this runs; the snapshot is taken next, the real listing after it
    const svc = env.service({ hooks: { beforeSnapshot: () => env.addUpload(upId(2), noise(500)) } });
    const r = await svc.create({ actor: 'a', trigger: 'cli' });
    expect(r.missingUploads).toBe(0);
    const staging = join(env.root, 's2');
    mkdirSync(staging);
    await readBackup(join(bdir(), r.name), { extractTo: staging });
    const db = new Database(join(staging, 'app.sqlite'), { readonly: true });
    for (const row of db.prepare('select id from uploads').all() as { id: string }[]) expect(existsSync(join(staging, 'uploads', row.id)), row.id).toBe(true);
    expect(db.prepare('select count(*) as n from uploads').get()).toEqual({ n: 2 });
    db.close();
  });

  it('a file removed between the listing and the archive is skipped with a warning and the backup still verifies', async () => {
    env.addUpload(upId(1), noise(500));
    env.addUpload(upId(2), noise(500));
    const svc = env.service({ hooks: { afterEnumerate: () => unlinkSync(join(env.config.uploadsDir, upId(2))) } });
    const r = await svc.create({ actor: 'a', trigger: 'cli' });
    expect(r.warnings.join(' ')).toMatch(/removed while the backup ran/);
    const res = await readBackup(join(bdir(), r.name));
    expect(res.uploadFiles).toBe(1);
  });
});

describe('backup service: memory bound on large uploads', () => {
  // Default: ~80 MB of uploads and instrumentation (largest write, outstanding bytes). CN_SLOW_TESTS=1: over 500 MB with the RSS and event-loop checks.
  const SLOW = process.env.CN_SLOW_TESTS === '1';
  const FILES = SLOW ? 40 : 6;

  it(`archives ${FILES * 13} MB of uploads in 64 KiB chunks without holding them in memory`, async () => {
    const svc = env.service({ opsLog: false });
    // warm-up on a small backup: first use of zlib, hashing and the file API allocates what they keep for good
    env.addUpload(upId(99), noise(200_000));
    await svc.create({ actor: 'warm', trigger: 'cli' });
    for (const n of zips()) rmSync(join(bdir(), n));
    rmSync(join(env.config.uploadsDir, upId(99)));
    env.db.$client.exec('delete from uploads');
    const tile = noise(13 * 1024 * 1024);
    for (let i = 1; i <= FILES; i++) {
      tile.writeUInt32LE(i, 0); // every file differs
      writeFileSync(join(env.config.uploadsDir, upId(i)), tile);
    }

    const histogram = monitorEventLoopDelay({ resolution: 10 });
    if (SLOW) histogram.enable();
    const before = process.memoryUsage();
    let peak = before.rss;
    let peakHeap = before.heapUsed;
    const timer = SLOW
      ? setInterval(() => {
          // Collect first: fflate's output buffers are garbage the moment they are written, but V8 frees them lazily
          gc();
          const m = process.memoryUsage();
          peak = Math.max(peak, m.rss);
          peakHeap = Math.max(peakHeap, m.heapUsed);
        }, 25)
      : null;
    let maxWrite = 0;
    let last = 0;
    let writes = 0;
    const big = env.service({
      opsLog: false,
      hooks: {
        onZipWrite: (sofar) => {
          maxWrite = Math.max(maxWrite, sofar - last);
          last = sofar;
          writes++;
        },
      },
    });
    const r = await big.create({ actor: 'a', trigger: 'cli' });
    if (timer) clearInterval(timer);
    histogram.disable();
    expect(r.size).toBeGreaterThan(FILES * 13 * 1024 * 1024 * 0.99);
    // chunked writes: nothing like a whole file (13 MiB) is ever handed to the file system at once, and the data goes out in many pieces
    expect(maxWrite).toBeLessThan(256 * 1024);
    expect(writes).toBeGreaterThan((FILES * 13 * 1024 * 1024) / (256 * 1024));
    if (SLOW) {
      expect(peak - before.rss, 'RSS growth').toBeLessThan(64 * 1024 * 1024);
      expect(peakHeap - before.heapUsed).toBeLessThan(64 * 1024 * 1024);
      expect(histogram.percentile(99) / 1e6, 'event loop p99 delay in ms').toBeLessThan(100);
    }
    expect((await readBackup(join(bdir(), r.name))).uploadFiles).toBe(FILES);
  }, 180_000);
});

describe('backup service: concurrency and locking', () => {
  it('two simultaneous create() calls on one service: one runs, the other is refused', async () => {
    const svc = env.service({ hooks: { afterSnapshot: () => sleep(100) } });
    const [a, b] = await Promise.allSettled([svc.create({ actor: 'a', trigger: 'cli' }), svc.create({ actor: 'b', trigger: 'cli' })]);
    const results = [a, b];
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BackupError);
    expect(rejected.reason.code).toBe('busy');
    expect(rejected.reason.httpStatus).toBe(409);
    expect(zips()).toHaveLength(1);
  });

  it('two processes (two services sharing the folder): the lock file lets one run', async () => {
    const hooks = { afterSnapshot: () => sleep(300) };
    const a = env.service({ hooks });
    const b = env.service({ hooks });
    const results = await Promise.allSettled([a.create({ actor: 'a', trigger: 'cli' }), b.create({ actor: 'b', trigger: 'cli' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.code).toBe('busy');
    expect(existsSync(join(bdir(), '.lock'))).toBe(false); // released
  });

  it('takes over a stale lock, but never a fresh one', async () => {
    mkdirSync(bdir(), { recursive: true, mode: 0o700 });
    const lock = join(bdir(), '.lock');
    writeFileSync(lock, JSON.stringify({ pid: 1, startedAt: 'x', nonce: 'dead' }));
    await expect(env.service().create({ actor: 'a', trigger: 'cli' })).rejects.toMatchObject({ code: 'busy' });
    expect(existsSync(lock)).toBe(true); // the live holder's lock is untouched
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lock, old, old);
    const r = await env.service().create({ actor: 'a', trigger: 'cli' });
    expect(zips()).toEqual([r.name]);
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(bdir()).filter((n) => n.startsWith('.lock'))).toEqual([]); // the renamed stale lock is gone too
  });

  it('two racers taking over the same stale lock: exactly one wins', async () => {
    mkdirSync(bdir(), { recursive: true, mode: 0o700 });
    const lock = join(bdir(), '.lock');
    writeFileSync(lock, '{}');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lock, old, old);
    const hooks = { afterSnapshot: () => sleep(300) };
    const racers = Array.from({ length: 3 }, () => env.service({ hooks }));
    const results = await Promise.allSettled(racers.map((s, i) => s.create({ actor: `r${i}`, trigger: 'cli' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason.code).toBe('busy');
  });

  it('a stale lock that a live backup replaced a moment before the takeover is put back, not stolen', async () => {
    mkdirSync(bdir(), { recursive: true, mode: 0o700 });
    const lock = join(bdir(), '.lock');
    writeFileSync(lock, JSON.stringify({ nonce: 'old' }));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lock, old, old);
    const svc = env.service({
      lock: {
        beforeTakeover: () => {
          // between our look at the stale lock and the rename, a live holder replaced it
          unlinkSync(lock);
          writeFileSync(lock, JSON.stringify({ nonce: 'live' }));
        },
      },
    });
    await expect(svc.create({ actor: 'a', trigger: 'cli' })).rejects.toMatchObject({ code: 'busy' });
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toEqual({ nonce: 'live' });
    expect(readdirSync(bdir()).filter((n) => n.startsWith('.lock.stale'))).toEqual([]);
  });

  it('releases the lock when a backup fails, and a restore marker refuses backups', async () => {
    await expect(env.service({ hooks: { onZipWrite: (n) => { if (n > 0) throw new Error('boom'); } } }).create({ actor: 'a', trigger: 'cli' })).rejects.toThrow('boom');
    expect(existsSync(join(bdir(), '.lock'))).toBe(false);
    writeFileSync(join(env.config.dataDir, '.restore-in-progress'), '{}');
    await expect(env.service().create({ actor: 'a', trigger: 'cli' })).rejects.toMatchObject({ code: 'restore-in-progress' });
  });

  it('isRunning() and status() tell a purge (M4) when to wait', async () => {
    const seen: boolean[] = [];
    let name = '';
    const svc = env.service({
      hooks: {
        afterSnapshot: () => {
          seen.push(svc.isRunning());
          name = svc.status().running?.name ?? '';
        },
      },
    });
    expect(svc.isRunning()).toBe(false);
    const r = await svc.create({ actor: 'a', trigger: 'cli' });
    expect(seen).toEqual([true]);
    expect(name).toMatch(/^backup-\d{8}T\d{6}Z\.zip$/);
    expect(svc.isRunning()).toBe(false);
    expect(svc.status()).toMatchObject({ running: null, lastError: null });
    expect(r.name).toBe(name);
  });
});

describe('backup service: atomic creation, permissions, disk', () => {
  for (const mask of [0o000, 0o077, 0o277]) {
    it(`writes the zip 0600 in a 0700 folder with umask ${mask.toString(8).padStart(3, '0')}, and no listing ever shows a partial file`, async () => {
      const old = process.umask(mask);
      try {
        const listedDuring: string[][] = [];
        let tmpMode = 0;
        let tmpName = '';
        let dbMode = 0;
        const svc = env.service({
          hooks: {
            afterSnapshot: () => {
              tmpName = readdirSync(bdir()).find((n) => n.startsWith('.tmp-')) ?? '';
              tmpMode = statSync(join(bdir(), tmpName)).mode & 0o777;
              dbMode = statSync(join(bdir(), tmpName, 'app.sqlite')).mode & 0o777;
            },
            beforeVerify: async () => {
              expect(readdirSync(bdir()).some((n) => n.startsWith('.partial-'))).toBe(true);
              listedDuring.push((await svc.list()).map((b) => b.name));
            },
          },
        });
        const r = await svc.create({ actor: 'a', trigger: 'cli' });
        expect(listedDuring).toEqual([[]]);
        expect(tmpName).toMatch(/^\.tmp-/);
        expect(tmpMode).toBe(0o700);
        expect(dbMode).toBe(0o600); // the temporary copy of the whole database
        expect(statSync(join(bdir(), r.name)).mode & 0o777).toBe(0o600);
        expect(statSync(bdir()).mode & 0o777).toBe(0o700);
        expect(readdirSync(bdir())).toEqual([r.name]); // temp folder and partial file are gone
      } finally {
        process.umask(old);
      }
    });
  }

  it('never overwrites: two backups in the same second get distinct names', async () => {
    const svc = env.service();
    const a = await svc.create({ actor: 'a', trigger: 'cli' });
    const b = await svc.create({ actor: 'a', trigger: 'cli' });
    expect(a.name).toBe(backupNameFor(T0));
    expect(b.name).toBe(backupNameFor(T0 + 1000));
    // and a name taken by someone else between the choice and the publish is skipped, not clobbered
    writeFileSync(join(bdir(), backupNameFor(T0 + 2000)), 'someone else');
    const c = await env.service({ hooks: { beforeVerify: () => void 0 } }).create({ actor: 'a', trigger: 'cli' });
    expect(c.name).toBe(backupNameFor(T0 + 3000));
    expect(readFileSync(join(bdir(), backupNameFor(T0 + 2000)), 'utf8')).toBe('someone else');
  });

  it('refuses with the numbers when disk space is short, before creating anything; old backups stay', async () => {
    const old = fakeBackup(T0 - DAY, 'cli');
    const svc = env.service({ hooks: { freeBytes: () => 1024 * 1024 } });
    const err = (await svc.create({ actor: 'a', trigger: 'cli' }).catch((e: unknown) => e)) as BackupError;
    expect(err.code).toBe('disk');
    expect(err.httpStatus).toBe(507);
    expect(err.message).toMatch(/\d+ MiB needed, 1 MiB free/);
    expect(err.message).toMatch(/BACKUP_KEEP/);
    expect(readdirSync(bdir()).filter((n) => n !== '.lock').sort()).toEqual([old]);
    expect(svc.status().lastError).toMatch(/Not enough free space/);
  });

  it('ENOSPC in the middle of writing leaves no partial file and no temp folder, keeps the old backups and audits the failure', async () => {
    const keep = [fakeBackup(T0 - 2 * DAY, 'cli'), fakeBackup(T0 - DAY, 'cli')];
    env.addUpload(upId(1), noise(200_000));
    const svc = env.service({
      hooks: {
        onZipWrite: (n) => {
          if (n > 50_000) throw Object.assign(new Error('write failed'), { code: 'ENOSPC' });
        },
      },
    });
    await expect(svc.create({ actor: 'a', trigger: 'cli' })).rejects.toThrow('write failed');
    expect(readdirSync(bdir()).sort()).toEqual(keep.sort());
    expect(svc.status().lastError).toBe('Out of disk space while writing the backup');
    expect(env.audits.find((a) => a.event === 'backup.failed')?.fields).toMatchObject({ actor: 'a', trigger: 'cli', reason: 'Out of disk space while writing the backup' });
  });

  it('the verify pass catches a deliberately corrupted file: nothing is published and nothing is pruned', async () => {
    const olds = [fakeBackup(T0 - 3 * DAY, 'cli'), fakeBackup(T0 - 2 * DAY, 'cli')];
    env.config.backupKeep = 1;
    env.addUpload(upId(1), noise(50_000));
    const svc = env.service({
      hooks: {
        beforeVerify: (partial) => {
          const buf = readFileSync(partial);
          const mid = Math.floor(buf.length / 2);
          buf[mid] = (buf[mid] as number) ^ 0xff;
          writeFileSync(partial, buf);
        },
      },
    });
    await expect(svc.create({ actor: 'a', trigger: 'cli' })).rejects.toBeTruthy();
    expect(readdirSync(bdir()).sort()).toEqual(olds.sort()); // both old backups survive although keep is 1
    expect(svc.status().lastError).toMatch(/^The backup failed its verification pass \(.+\)$/);
  });

  it('a process killed in the middle of creating leaves the earlier backups intact and nothing listed', async () => {
    const earlier = await env.service().create({ actor: 'a', trigger: 'cli' });
    env.addUpload(upId(1), noise(300_000));
    const r = spawnSync(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'fixtures', 'backup-kill.ts'), JSON.stringify(env.config)], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' });
    expect(r.signal).toBe('SIGKILL');
    const names = readdirSync(bdir());
    expect(names.some((n) => n.startsWith('.partial-'))).toBe(true); // the artefact of the kill
    const svc = env.service();
    expect((await svc.list()).map((b) => b.name)).toEqual([earlier.name]);
    expect((await readBackup(join(bdir(), earlier.name))).entries).toBeGreaterThan(2);
    // the dead holder's lock is stale only after 2 minutes; leftovers older than an hour are swept at the next start
    for (const n of names.filter((x) => x.startsWith('.partial-') || x.startsWith('.tmp-'))) utimesSync(join(bdir(), n), new Date(Date.now() - 2 * 3600 * 1000), new Date(Date.now() - 2 * 3600 * 1000));
    const lock = join(bdir(), '.lock');
    if (existsSync(lock)) utimesSync(lock, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
    env.service();
    expect(readdirSync(bdir()).filter((n) => n.startsWith('.partial-') || n.startsWith('.tmp-'))).toEqual([]);
    expect(zips()).toEqual([earlier.name]);
  }, 60_000);

  it('create() sweeps old leftovers itself (before it takes its own lock)', async () => {
    mkdirSync(join(bdir(), '.tmp-aaaaaaaaaaaa'), { recursive: true });
    writeFileSync(join(bdir(), '.partial-bbbbbbbbbbbb.zip'), 'x');
    writeFileSync(join(bdir(), '.partial-cccccccccccc.zip'), 'x');
    const past = new Date(Date.now() - 2 * 3600 * 1000);
    utimesSync(join(bdir(), '.tmp-aaaaaaaaaaaa'), past, past);
    utimesSync(join(bdir(), '.partial-bbbbbbbbbbbb.zip'), past, past);
    const svc = env.service();
    // leftovers appear after the service started (the constructor already swept once)
    mkdirSync(join(bdir(), '.tmp-dddddddddddd'));
    utimesSync(join(bdir(), '.tmp-dddddddddddd'), past, past);
    mkdirSync(join(bdir(), '.tmp-abc'));
    utimesSync(join(bdir(), '.tmp-abc'), past, past); // only the exact names this service generates are swept
    const r = await svc.create({ actor: 'a', trigger: 'cli' });
    expect(readdirSync(bdir()).sort()).toEqual(['.partial-cccccccccccc.zip', '.tmp-abc', r.name]);
  });

  it('a retention pass that fails after the publish does not turn the backup into a failure', async () => {
    const svc = env.service();
    svc.prune = () => Promise.reject(new Error('disk hiccup'));
    const r = await svc.create({ actor: 'a', trigger: 'cli' });
    expect(zips()).toEqual([r.name]);
    expect(r.warnings.join(' ')).toMatch(/could not be pruned/);
    expect(env.audits.some((a) => a.event === 'backup.prune_failed')).toBe(true);
    expect(svc.status().lastError).toBeNull();
    expect(svc.status().lastWarnings.join(' ')).toMatch(/pruned/);
  });

  it('leftovers: young ones and ones next to a live lock stay, old ones go', () => {
    mkdirSync(bdir(), { recursive: true, mode: 0o700 });
    mkdirSync(join(bdir(), '.tmp-aaaaaaaaaaaa'));
    writeFileSync(join(bdir(), '.partial-bbbbbbbbbbbb.zip'), 'x');
    writeFileSync(join(bdir(), '.partial-cccccccccccc.zip'), 'x');
    writeFileSync(join(bdir(), 'notes.txt'), 'keep me');
    const past = new Date(Date.now() - 2 * 3600 * 1000);
    utimesSync(join(bdir(), '.tmp-aaaaaaaaaaaa'), past, past);
    utimesSync(join(bdir(), '.partial-bbbbbbbbbbbb.zip'), past, past);
    writeFileSync(join(bdir(), '.lock'), '{}');
    env.service(); // a live lock: a backup may be running, so nothing is removed
    expect(readdirSync(bdir()).sort()).toEqual(['.lock', '.partial-bbbbbbbbbbbb.zip', '.partial-cccccccccccc.zip', '.tmp-aaaaaaaaaaaa', 'notes.txt']);
    unlinkSync(join(bdir(), '.lock'));
    env.service();
    expect(readdirSync(bdir()).sort()).toEqual(['.partial-cccccccccccc.zip', 'notes.txt']);
  });
});

describe('backup service: list, classification and the cap on API backups', () => {
  it('lists newest first with size, date from the name and trigger; classes anything unreadable as api', async () => {
    fakeBackup(T0 - 3 * DAY, 'cli');
    fakeBackup(T0 - 2 * DAY, 'scheduler');
    fakeBackup(T0 - 1 * DAY, 'api');
    fakeBackup(T0 - 5 * DAY, 'garbage'); // manifest with an unknown trigger
    fakeBackup(T0 - 6 * DAY, 'foreign'); // a zip without manifest.json first
    fakeBackup(T0 - 7 * DAY, 'text'); // not a zip at all
    fakeBackup(T0 - 8 * DAY, 'empty');
    fakeBackup(T0 - 9 * DAY, 'stored'); // manifest stored instead of deflated: refused
    const svc = env.service();
    const list = await svc.list();
    expect(list.map((b) => b.trigger)).toEqual(['api', 'scheduler', 'cli', 'api', 'api', 'api', 'api', 'api']);
    expect(list[0]?.createdAt).toBe(new Date(T0 - DAY).toISOString());
    expect(list[0]?.size).toBeGreaterThan(0);
  });

  it('classification is bounded: one small read per file, cached by name and size, never a full extraction', async () => {
    const reads: string[] = [];
    fakeBackup(T0 - DAY, 'cli');
    const huge = backupNameFor(T0 - 2 * DAY);
    writeFileSync(join(bdir(), huge), rawZip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ ...testManifest(1), pad: 'x'.repeat(1_500_000) })) }]));
    const svc = env.service({ hooks: { onManifestRead: (n) => reads.push(n) } });
    expect((await svc.list()).map((b) => b.trigger)).toEqual(['cli', 'api']); // a first entry over 1 MiB is not read: api
    expect(reads).toHaveLength(2);
    await svc.list();
    await svc.list();
    expect(reads).toHaveLength(2); // cached
    writeFileSync(join(bdir(), backupNameFor(T0 - DAY)), rawZip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(testManifest(1, { trigger: 'scheduler' }))) }, { name: 'x', data: Buffer.alloc(10) }]));
    expect((await svc.list())[0]?.trigger).toBe('scheduler'); // a changed size re-reads
    expect(reads).toHaveLength(3);
  });

  it('only real files with the exact name pattern are listed', async () => {
    fakeBackup(T0 - DAY, 'cli');
    writeFileSync(join(bdir(), 'notes.txt'), 'x');
    writeFileSync(join(bdir(), 'backup-x.zip'), 'x');
    writeFileSync(join(bdir(), 'backup-20260101T000000Z.zip.bak'), 'x');
    mkdirSync(join(bdir(), 'backup-20200101T000000Z.zip'));
    symlinkSync(join(env.root, 'nowhere'), join(bdir(), 'backup-20200202T000000Z.zip'));
    expect((await env.service().list()).map((b) => b.name)).toEqual([backupNameFor(T0 - DAY)]);
  });

  it('trigger comes from the entry point only: bad values throw, and the manifest records exactly what was passed', async () => {
    const svc = env.service();
    for (const bad of ['admin', '', 'API', undefined, null, '__proto__', 'cli ']) {
      await expect(svc.create({ actor: 'a', trigger: bad as never })).rejects.toThrow(TypeError);
    }
    expect(zips()).toEqual([]);
    // an actor that merely looks like a trigger changes nothing
    const r = await svc.create({ actor: 'cli', trigger: 'api' });
    expect((await readBackup(join(bdir(), r.name))).manifest.trigger).toBe('api');
    expect((await svc.list())[0]?.trigger).toBe('api');
    // and a hand-edited manifest in a copied file is only a classification hint for that file
    expect(r.trigger).toBe('api');
  });
});

describe('backup service: prune', () => {
  const names = (list: { name: string }[]) => list.map((b) => b.name);

  it('keeps at least one, clamps nonsense, and touches only exact backup names', async () => {
    const a = fakeBackup(T0 - 3 * DAY, 'cli');
    const b = fakeBackup(T0 - 2 * DAY, 'cli');
    const c = fakeBackup(T0 - 1 * DAY, 'cli');
    writeFileSync(join(bdir(), 'notes.txt'), 'x');
    writeFileSync(join(bdir(), 'backup-x.zip'), 'x');
    mkdirSync(join(bdir(), 'backup-20200101T000000Z.zip'));
    writeFileSync(join(env.root, 'target.zip'), 'target');
    symlinkSync(join(env.root, 'target.zip'), join(bdir(), 'backup-20200202T000000Z.zip'));
    const svc = env.service();
    for (const k of [0, -5, Number.NaN]) {
      env.clock.now = T0;
      const removed = await svc.prune(k, 'cli');
      expect(removed.every((n) => n !== c)).toBe(true);
    }
    expect(names(await svc.list())).toEqual([c]);
    expect(existsSync(join(bdir(), a)) || existsSync(join(bdir(), b))).toBe(false);
    for (const keepMe of ['notes.txt', 'backup-x.zip', 'backup-20200101T000000Z.zip', 'backup-20200202T000000Z.zip']) expect(existsSync(join(bdir(), keepMe))).toBe(true);
    expect(readFileSync(join(env.root, 'target.zip'), 'utf8')).toBe('target');
  });

  it('orders by the timestamp in the name, not the file time', async () => {
    const old = fakeBackup(T0 - 5 * DAY, 'cli');
    const mid = fakeBackup(T0 - 3 * DAY, 'cli');
    const fresh = fakeBackup(T0 - DAY, 'cli');
    // copying changed the mtimes: the oldest backup looks newest on disk
    utimesSync(join(bdir(), old), new Date(), new Date());
    utimesSync(join(bdir(), fresh), new Date(2001, 1, 1), new Date(2001, 1, 1));
    await env.service().prune(2, 'cli');
    expect(names(await env.service().list())).toEqual([fresh, mid]);
  });

  it('skips a name leased by a download, and a download in progress survives a prune and a delete', async () => {
    const old = fakeBackup(T0 - 5 * DAY, 'cli');
    fakeBackup(T0 - DAY, 'cli');
    const svc = env.service();
    const lease = await svc.openForDownload(old, 'admin1');
    expect(await svc.prune(1, 'cli')).toEqual([]); // leased: skipped
    expect(existsSync(join(bdir(), old))).toBe(true);
    unlinkSync(join(bdir(), old)); // even a delete from another process: the open descriptor keeps reading
    const buf = Buffer.alloc(lease.size);
    await lease.handle.read(buf, 0, lease.size, 0);
    expect(buf.length).toBe(lease.size);
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    await lease.release();
    await lease.release(); // idempotent
    fakeBackup(T0 - 6 * DAY, 'cli');
    expect((await svc.prune(1, 'cli')).length).toBe(1);
    expect(env.audits.filter((a) => a.event === 'backup.downloaded')).toHaveLength(1);
  });

  it('opens only exact names, never follows a symlink, never a directory', async () => {
    const real = fakeBackup(T0 - DAY, 'cli');
    symlinkSync(join(bdir(), real), join(bdir(), 'backup-20200202T000000Z.zip'));
    mkdirSync(join(bdir(), 'backup-20200101T000000Z.zip'));
    const svc = env.service();
    for (const bad of ['../x', 'backup-x.zip', 'backup-20200202T000000Z.zip', 'backup-20200101T000000Z.zip', `${real}/`, `./${real}`, 'notes.txt', `${real}\n`]) {
      await expect(svc.openForDownload(bad)).rejects.toMatchObject({ code: 'not-found' });
    }
    const ok = await svc.openForDownload(real);
    await ok.release();
  });

  it('never prunes after a failed backup', async () => {
    for (let i = 1; i <= 4; i++) fakeBackup(T0 - i * DAY, 'cli');
    env.config.backupKeep = 1;
    const svc = env.service({ hooks: { onZipWrite: (n) => { if (n > 0) throw new Error('boom'); } } });
    await expect(svc.create({ actor: 'a', trigger: 'cli' })).rejects.toThrow('boom');
    expect(zips()).toHaveLength(4);
    expect(env.audits.some((a) => a.event === 'backup.pruned')).toBe(false);
  });

  it('prunes after a good backup and audits each deletion with the origin', async () => {
    env.config.backupKeep = 2;
    const olds = [fakeBackup(T0 - 4 * DAY, 'cli'), fakeBackup(T0 - 3 * DAY, 'cli'), fakeBackup(T0 - 2 * DAY, 'cli')];
    const r = await env.service().create({ actor: 'a', trigger: 'cli' });
    expect(names(await env.service().list())).toEqual([r.name, olds[2]]);
    const pruned = env.audits.filter((a) => a.event === 'backup.pruned');
    expect(pruned.map((p) => p.fields.name).sort()).toEqual([olds[0], olds[1]].sort());
    expect(pruned.every((p) => p.fields.origin === 'cli' && typeof p.fields.reason === 'string')).toBe(true);
  });

  describe('origin-restricted eviction (design 11)', () => {
    beforeEach(() => {
      env.cleanup();
      env = makeEnv({ backupKeep: 2 });
    });

    it('a flood of API backups by a stolen cookie: genuine backups stay, creates stop at 3 x keep, and nothing younger than 7 days can be evicted', async () => {
      const genuine = [fakeBackup(T0 - 10 * DAY, 'cli'), fakeBackup(T0 - 3 * DAY, 'scheduler')];
      env.clock.now = T0 + DAY;
      const svc = env.service();
      const made: string[] = [];
      for (let i = 0; i < API_CREATE_CAP_FACTOR * 2; i++) {
        env.clock.now = T0 + DAY + i * 60_000;
        made.push((await svc.create({ actor: 'thief', trigger: 'api' })).name);
      }
      expect(new Set(made).size).toBe(6);
      for (const g of genuine) expect(existsSync(join(bdir(), g))).toBe(true); // every genuine backup survived the flood
      for (const m of made) expect(existsSync(join(bdir(), m))).toBe(true);
      const capped = (await svc.create({ actor: 'thief', trigger: 'api' }).catch((e: unknown) => e)) as BackupError;
      expect(capped.code).toBe('api-cap');
      expect(capped.httpStatus).toBe(409);
      expect(capped.message).toMatch(/node dist\/admin\.mjs backup/);
      expect(zips()).toHaveLength(8);

      // more than 24 hours later: still blocked, and an API prune still cannot evict anything younger than 7 days
      env.clock.now = T0 + 2 * DAY + 2 * 3600 * 1000;
      await expect(svc.create({ actor: 'thief', trigger: 'api' })).rejects.toMatchObject({ code: 'api-cap' });
      expect(await svc.prune(2, 'api')).toEqual([]);
      expect(zips()).toHaveLength(8);
    });

    it('after 7 days the flood ages into the ranked set; genuine backups go only when no newer genuine backup exists (the stated residual)', async () => {
      const genuine = [fakeBackup(T0 - 10 * DAY, 'cli'), fakeBackup(T0 - 3 * DAY, 'scheduler')];
      const flood = Array.from({ length: 6 }, (_, i) => fakeBackup(T0 + DAY + i * 60_000, 'api'));
      const svc = env.service();
      env.clock.now = T0 + 9 * DAY; // all of the flood is now 7 days old or more
      const removed = await svc.prune(2, 'api');
      // ranked together by date: the two newest flood backups win, the genuine ones are pushed out
      expect([...(await svc.list())].map((b) => b.name).sort()).toEqual(flood.slice(4).sort());
      expect(removed.sort()).toEqual([...genuine, ...flood.slice(0, 4)].sort());

      // had a newer genuine backup been made (CLI or scheduler) it ranks first and is kept
      env.cleanup();
      env = makeEnv({ backupKeep: 2 });
      const flood2 = Array.from({ length: 6 }, (_, i) => fakeBackup(T0 + DAY + i * 60_000, 'api'));
      const newer = fakeBackup(T0 + 8 * DAY, 'scheduler');
      env.clock.now = T0 + 9 * DAY;
      await env.service().prune(2, 'scheduler');
      expect((await env.service().list()).map((b) => b.name)).toEqual([newer, flood2[5]]);
    });

    it('a UI-only host keeps exactly keep backups once they are 7 days old', async () => {
      const ages = [10, 9, 8, 7.5, 2, 1];
      const made = ages.map((d) => fakeBackup(T0 - d * DAY, 'api'));
      const svc = env.service();
      await svc.prune(2, 'api');
      // the two young ones are protected and uncounted; of the four old ones the newest two stay
      expect((await svc.list()).map((b) => b.name).sort()).toEqual([made[2], made[3], made[4], made[5]].sort());
      env.clock.now = T0 + 7 * DAY; // everything is old now
      await svc.prune(2, 'api');
      expect((await svc.list()).map((b) => b.name)).toEqual([made[5], made[4]]);
    });

    it('one CLI backup does not delete every API backup older than 7 days: they are ranked with it', async () => {
      env.cleanup();
      env = makeEnv({ backupKeep: 3 });
      const old = [20, 18, 16, 14, 12].map((d) => fakeBackup(T0 - d * DAY, 'api'));
      const cli = fakeBackup(T0, 'cli');
      const svc = env.service();
      await svc.prune(3, 'cli');
      expect((await svc.list()).map((b) => b.name)).toEqual([cli, old[4], old[3]]);
      expect((await svc.list()).length).toBeGreaterThan(1);
    });

    it('a CLI or scheduler prune after a flood keeps the protected API backups and the newest keep of the ranked set', async () => {
      const genuine = [fakeBackup(T0 - 12 * DAY, 'cli'), fakeBackup(T0 - 9 * DAY, 'cli'), fakeBackup(T0 - 5 * DAY, 'scheduler'), fakeBackup(T0 - 4 * DAY, 'cli')];
      const flood = Array.from({ length: 4 }, (_, i) => fakeBackup(T0 - 2 * DAY + i * 60_000, 'api'));
      for (const origin of ['cli', 'scheduler'] as const) {
        await env.service().prune(2, origin);
        expect((await env.service().list()).map((b) => b.name).sort()).toEqual([genuine[2], genuine[3], ...flood].sort());
      }
    });

    it('an API-started prune deletes only candidates aged 7 days or more, even when younger non-API backups are ranked out', async () => {
      const cliOld = fakeBackup(T0 - 30 * DAY, 'cli');
      const young = [fakeBackup(T0 - 3 * DAY, 'cli'), fakeBackup(T0 - 2 * DAY, 'cli'), fakeBackup(T0 - DAY, 'cli')];
      const svc = env.service();
      expect(await svc.prune(2, 'api')).toEqual([cliOld]);
      // young[0] is ranked beyond keep=2 but is younger than 7 days: an API prune leaves it, a CLI prune does not
      expect((await svc.list()).map((b) => b.name)).toEqual([young[2], young[1], young[0]]);
      expect(await svc.prune(2, 'cli')).toEqual([young[0]]);
    });

    it('corrupt, foreign and regex-named non-zip files are classed api and break neither list nor prune', async () => {
      const junk = [fakeBackup(T0 - 20 * DAY, 'garbage'), fakeBackup(T0 - 19 * DAY, 'foreign'), fakeBackup(T0 - 18 * DAY, 'text'), fakeBackup(T0 - 17 * DAY, 'empty'), fakeBackup(T0 - 16 * DAY, 'stored')];
      const good = fakeBackup(T0 - 15 * DAY, 'cli');
      const svc = env.service();
      expect((await svc.list()).filter((b) => junk.includes(b.name)).every((b) => b.trigger === 'api')).toBe(true);
      const removed = await svc.prune(2, 'cli');
      expect(removed.length).toBe(4);
      expect((await svc.list()).map((b) => b.name)).toEqual([good, junk[4]]);
    });
  });
});

describe('BACKUP_DIR and BACKUP_KEEP', () => {
  const cfg = () => ({ ...env.config });
  const refused = (backupDir: string, extra: Record<string, unknown> = {}) => () => validateBackupDir({ ...cfg(), backupDir, ...extra });

  it('refuses a directory equal to or inside the web build, the uploads, the 5etools paths, or the data directory itself', () => {
    const c = cfg();
    for (const dir of [c.dataDir, c.uploadsDir, join(c.uploadsDir, 'sub'), c.webDistDir, join(c.webDistDir, 'assets'), c.fivetoolsSrcPath, join(c.fivetoolsImgPath, 'x', 'y')]) {
      expect(refused(dir), dir).toThrow(BackupError);
    }
    expect(() => validateBackupDir({ ...c, backupDir: join(c.dataDir, 'backups') })).not.toThrow(); // the default
    expect(() => validateBackupDir({ ...c, backupDir: join(env.root, 'other-volume', 'backups') })).not.toThrow();
    expect(() => validateBackupDir({ ...c, backupDir: join(c.dataDir, 'custom') })).not.toThrow(); // a subdirectory of DATA_DIR other than uploads
  });

  it('resolves symlinks before comparing, and refuses when the service is constructed', () => {
    mkdirSync(join(env.config.uploadsDir, 'real'));
    symlinkSync(env.config.uploadsDir, join(env.root, 'alias'));
    expect(refused(join(env.root, 'alias', 'real'))).toThrow(/uploads/);
    expect(refused(join(env.root, 'alias'))).toThrow(/uploads/);
    expect(() => env.service({ config: { ...env.config, backupDir: env.config.uploadsDir } })).toThrow(BackupError);
    expect(() => env.service({ config: { ...env.config, backupDir: env.config.dataDir } })).toThrow(/data directory/);
  });

  it('refuses a world-writable directory and warns about one wider than 0700', () => {
    const dir = join(env.root, 'vol');
    mkdirSync(dir);
    chmodSync(dir, 0o777);
    expect(refused(dir)).toThrow(/world-writable/);
    chmodSync(dir, 0o755);
    const warnings: string[] = [];
    env.service({ config: { ...env.config, backupDir: dir }, warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/755/);
    chmodSync(dir, 0o700);
    expect(validateBackupDir({ ...cfg(), backupDir: dir }).warnings).toEqual([]);
    writeFileSync(join(env.root, 'afile'), 'x');
    expect(refused(join(env.root, 'afile'))).toThrow(/not a directory/);
  });

  it('also refuses a directory that CONTAINS the data directory, uploads, 5etools or the web build (for example /)', () => {
    const c = cfg();
    for (const dir of ['/', env.root, join(env.root, 'var')]) expect(refused(dir), dir).toThrow(BackupError);
    expect(refused(join(env.root, 'var')), 'the data dir itself').toThrow(/data directory/);
    expect(refused(env.root)).toThrow(/contain/);
    expect(c.backupDir).toBeTruthy();
  });

  it('uses a custom folder (a second volume) and keeps zips there', async () => {
    const other = join(env.root, 'second-volume', 'backups');
    const svc = env.service({ config: { ...env.config, backupDir: other } });
    const r = await svc.create({ actor: 'a', trigger: 'cli' });
    expect(readdirSync(other)).toEqual([r.name]);
    expect(statSync(other).mode & 0o777).toBe(0o700);
    expect(existsSync(env.config.backupDir)).toBe(false);
  });

  it('parses BACKUP_KEEP (1 to 1000, default 7) and BACKUP_DIR from the environment', () => {
    const warnings: string[] = [];
    const w = (m: string) => warnings.push(m);
    expect(parseBackupKeep(undefined, w)).toBe(DEFAULT_BACKUP_KEEP);
    expect(DEFAULT_BACKUP_KEEP).toBe(7);
    expect(parseBackupKeep('', w)).toBe(7);
    expect(parseBackupKeep('1', w)).toBe(1);
    expect(parseBackupKeep(' 30 ', w)).toBe(30);
    expect(parseBackupKeep('1000', w)).toBe(1000);
    expect(warnings).toEqual([]);
    for (const bad of ['0', '1001', '-3', '2.5', 'many', '1e2', '07x', '99999']) expect(parseBackupKeep(bad, w)).toBe(7);
    expect(warnings).toHaveLength(8);
    const saved = { dir: process.env.BACKUP_DIR, keep: process.env.BACKUP_KEEP };
    try {
      process.env.BACKUP_KEEP = '12';
      process.env.BACKUP_DIR = '/mnt/backups/cn';
      const c = loadConfig({ dataDir: '/data/app' });
      expect(c.backupKeep).toBe(12);
      expect(c.backupDir).toBe('/mnt/backups/cn');
      delete process.env.BACKUP_DIR;
      delete process.env.BACKUP_KEEP;
      expect(loadConfig({ dataDir: '/data/app' })).toMatchObject({ backupDir: '/data/app/backups', backupKeep: 7 });
    } finally {
      if (saved.dir === undefined) delete process.env.BACKUP_DIR;
      else process.env.BACKUP_DIR = saved.dir;
      if (saved.keep === undefined) delete process.env.BACKUP_KEEP;
      else process.env.BACKUP_KEEP = saved.keep;
    }
  });
});

describe('durable log and audit', () => {
  it('appends backup.created to restore-log.jsonl (0600) with the listed fields, and audits created/failed', async () => {
    const svc = env.service();
    const a = await svc.create({ actor: 'admin1', trigger: 'api' });
    const b = await svc.create({ actor: 'host', trigger: 'cli' });
    const path = join(env.config.dataDir, 'restore-log.jsonl');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ event: 'backup.created', name: a.name, size: a.size, sha256: a.sha256, trigger: 'api', actor: 'admin1' });
    expect(lines[1]).toMatchObject({ event: 'backup.created', name: b.name, trigger: 'cli', actor: 'host' });
    expect(typeof lines[0].at).toBe('string');
    expect(env.audits.filter((x) => x.event === 'backup.created').map((x) => x.fields.name)).toEqual([a.name, b.name]);
    expect(JSON.stringify(env.audits)).not.toMatch(/password|hash"/);
    expect(lstatSync(path).isFile()).toBe(true);
  });

  it('appendOpsLog: a field can never override the event or the time', async () => {
    const { appendOpsLog } = await import('../src/lib/ops-log');
    appendOpsLog(env.config.dataDir, 'restore.started', { event: 'restore.completed', at: 'yesterday' }, 1_800_000_000_000);
    const line = JSON.parse(readFileSync(join(env.config.dataDir, 'restore-log.jsonl'), 'utf8').trim());
    expect(line).toMatchObject({ event: 'restore.started', at: new Date(1_800_000_000_000).toISOString() });
  });

  it('appendOpsLog tightens a looser existing file and survives concurrent appends', async () => {
    const { appendOpsLog } = await import('../src/lib/ops-log');
    const path = join(env.config.dataDir, 'restore-log.jsonl');
    writeFileSync(path, '', { mode: 0o644 });
    chmodSync(path, 0o644);
    appendOpsLog(env.config.dataDir, 'restore.started', { zip: 'x', keepTokens: false });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    for (let i = 0; i < 20; i++) appendOpsLog(env.config.dataDir, 'restore.completed', { i });
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(21);
  });
});

describe('version', () => {
  it('reads the root package.json version, else the server package.json', () => {
    const server = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
    const root = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version?: string };
    expect(appVersion()).toBe(root.version ?? server.version);
    expect(timestampOfName(backupNameFor(T0))).toBe(T0);
    expect(timestampOfName('backup-x.zip')).toBeNull();
  });
});
