/**
 * Task M3.3, design 8 "Crash and power-loss recovery" and 19: kill -9 the restore process at EVERY marker phase and step
 * boundary (and mid-step), then resume (same zip), refuse (other zip) or roll back; and the server-start guard.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT } from '../src/cli/errors';
import { readRestoreMarker, restoreMarkerExists } from '../src/lib/restore-marker';
import { BackupService } from '../src/services/backups';
import { openAppDb } from '../src/db';
import { upId } from './backup-helpers';
import { changeLive, ignoreOpsLog, preRestoreDirs, runCli, seededInstance, stopServer, treeDigest, type Seeded } from './restore-helpers';

const SERVER_ROOT = join(import.meta.dirname, '..');
let s: Seeded;
afterEach(() => {
  s?.env.cleanup();
  if (s) rmSync(s.work, { recursive: true, force: true });
});
const data = () => s.env.config.dataDir;
const dbPath = () => s.env.config.appDbPath;
const q = <T = Record<string, unknown>>(sql: string, p = dbPath()): T[] => {
  const d = new Database(p, { readonly: true });
  try {
    return d.prepare(sql).all() as T[];
  } finally {
    d.close();
  }
};

/** Runs the restore in a child process that kills itself at `point`; resolves with the signal (null = it ran to the end). */
function killedAt(zip: string, point: string, extraEnv: Record<string, string> = {}): Promise<{ signal: NodeJS.Signals | null; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'fixtures', 'restore-kill.ts'), JSON.stringify(s.env.config), zip], {
      cwd: SERVER_ROOT,
      env: { ...process.env, CN_SKIP_DOTENV: '1', KILL_AT: point, ...extraEnv },
      stdio: 'ignore',
    });
    child.once('exit', (code, signal) => resolve({ signal, code }));
  });
}

/** Every point a restore passes, in order (over a live instance, so every step really runs). */
async function pointsOf(extra: { racer?: boolean } = {}): Promise<string[]> {
  const probe = await seededInstance();
  changeLive(probe.env);
  stopServer(probe.env);
  const seen: string[] = [];
  await runCli(['restore', probe.zip, '--yes'], probe.env.config, {
    restoreHooks: {
      at(p) {
        seen.push(p);
        if (extra.racer && p === 'install:beforeLink') writeFileSync(join(probe.env.config.dataDir, 'app.sqlite'), 'a racing database');
      },
    },
  });
  probe.env.cleanup();
  rmSync(probe.work, { recursive: true, force: true });
  return seen;
}

async function liveInstance(): Promise<void> {
  s = await seededInstance();
  changeLive(s.env);
  stopServer(s.env);
}

function assertRestoredOnce() {
  expect(restoreMarkerExists(data())).toBe(false);
  expect(readdirSync(data()).filter((n) => n.startsWith('.restore'))).toEqual([]);
  expect(preRestoreDirs(data()), 'exactly one pre-restore directory').toHaveLength(1);
  expect(existsSync(`${dbPath()}-wal`)).toBe(false);
  expect(existsSync(`${dbPath()}-shm`)).toBe(false);
  expect(q('select username from users order by username')).toEqual([{ username: 'gm' }, { username: 'locked' }, { username: 'player' }]);
  expect(q('pragma integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  for (const [id, bytes] of s.uploads) expect(readFileSync(join(data(), 'uploads', id)).equals(bytes)).toBe(true);
  expect(existsSync(join(data(), 'uploads', upId(9)))).toBe(false);
  expect(readdirSync(data()).filter((n) => n.startsWith('index.sqlite'))).toEqual([]);
  const old = join(data(), preRestoreDirs(data())[0]!);
  expect(q("select username from users where id = 'u9'", join(old, 'app.sqlite'))).toEqual([{ username: 'newcomer' }]);
  expect(existsSync(join(old, 'uploads', upId(9)))).toBe(true);
  expect(readdirSync(data()).filter((n) => n.includes('.tmp-'))).toEqual([]);
}

describe('kill -9 at every point of the forward path, then run the same command again', () => {
  it('has the points we expect (a regression guard for the hook names the tests rely on)', async () => {
    const points = await pointsOf();
    for (const p of [
      'before-lock', 'before-marker', 'marker:created', 'probe:acquired', 'stage:begin', 'stage:extracted', 'marker:staged', 'marker:preRestoreDir', 'done:preRestoreDir',
      'marker:moveLive', 'moveLive:moved:app.sqlite', 'done:moveLive', 'marker:moveUploads', 'moveUploads:aside', 'done:moveUploads', 'marker:install',
      'install:beforeLink', 'install:afterLink', 'done:install', 'marker:indexDelete', 'done:indexDelete', 'marker:finish', 'done:finish',
    ]) expect(points, p).toContain(p);
  });

  it('resumes to a complete restore from every point, with exactly one pre-restore directory, no stale -wal/-shm and no torn marker', async () => {
    const points = [...new Set(await pointsOf())];
    expect(points.length).toBeGreaterThan(20);
    for (const point of points) {
      await liveInstance();
      const before = treeDigest(data(), (p) => ignoreOpsLog(p) || p.startsWith('uploads/') || p === 'uploads');
      const k = await killedAt(s.zip, point);
      expect(k.signal, `killed at ${point}`).toBe('SIGKILL');
      const marker = readRestoreMarker(data()); // never torn: it parses, or there is none
      if (point === 'before-marker' || point === 'before-lock') expect(marker).toBeNull();
      if (point === 'done:finish') {
        expect(marker, point).toBeNull();
      } else if (point !== 'before-marker' && point !== 'before-lock') {
        expect(marker, `marker after a kill at ${point}`).not.toBe('unreadable');
        expect(marker, `marker after a kill at ${point}`).not.toBeNull();
        // a starting server is refused for as long as the marker exists
        expect(restoreMarkerExists(data())).toBe(true);
      }
      // before the swap nothing live has changed
      if (['before-lock', 'before-lock', 'before-marker', 'marker:created', 'probe:acquired', 'stage:begin', 'stage:extracted', 'marker:staged'].includes(point)) {
        // (a kill while the probe was open leaves the empty -wal file that merely opening a WAL database creates; that is not a change)
        const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
        const now = treeDigest(data(), (p) => ignoreOpsLog(p) || p.startsWith('uploads/') || p === 'uploads' || p.startsWith('.restore'));
        if (now['app.sqlite-wal'] === EMPTY) delete now['app.sqlite-wal'];
        expect(now).toEqual(Object.fromEntries(Object.entries(before).filter(([p]) => !p.startsWith('.restore'))));
      }
      const r = await runCli(['restore', s.zip, '--yes'], s.env.config);
      if (point === 'done:finish') {
        // it had completed: a second run is a NEW restore of the same file, which also works
        expect(r.code, point).toBe(0);
        expect(preRestoreDirs(data()).length).toBe(2);
      } else {
        expect(r.code, `${point}: ${r.err}`).toBe(0);
        assertRestoredOnce();
      }
      s.env.cleanup();
      rmSync(s.work, { recursive: true, force: true });
    }
  }, 240_000);

  it('a different zip is refused while a restore is interrupted (the marker is printed); the interrupted one still finishes', async () => {
    await liveInstance();
    const k = await killedAt(s.zip, 'done:moveLive');
    expect(k.signal).toBe('SIGKILL');
    // a VALID different backup
    const dir2 = join(s.work, 'second');
    mkdirSync(dir2);
    const env2 = { ...s.env.config, backupDir: dir2, dataDir: join(s.work, 'd2'), appDbPath: join(s.work, 'd2', 'app.sqlite'), uploadsDir: join(s.work, 'd2', 'uploads') };
    mkdirSync(env2.uploadsDir, { recursive: true });
    const d2 = openAppDb(env2.appDbPath);
    d2.$client.exec(`insert into users (id, username, display_name, password_hash) values ('z', 'zed', 'Z', 'h')`);
    const made = await new BackupService({ db: d2, config: env2, opsLog: false, warn: () => undefined, audit: () => undefined }).create({ actor: 'x', trigger: 'cli' });
    d2.$client.close();
    const zip2 = join(dir2, made.name);
    const quiet = (p: string) => ignoreOpsLog(p) || p.startsWith('.restore.lock'); // the lock file of the killed process may linger
    const mid = treeDigest(data(), quiet);
    const r2 = await runCli(['restore', zip2, '--yes'], s.env.config);
    expect(r2.code).toBe(EXIT.restoreInProgress);
    expect(r2.err).toMatch(/not the one that restore was started with/);
    expect(r2.err).toMatch(/Restore of backup-.*\.zip started/);
    expect(treeDigest(data(), quiet)).toEqual(mid);
    const ok = await runCli(['restore', s.zip, '--yes'], s.env.config);
    expect(ok.code).toBe(0);
    assertRestoredOnce();
  }, 60_000);

  it('a server (or reset-link, or backup) is refused for the whole interruption, and the marker is never torn', async () => {
    await liveInstance();
    expect((await killedAt(s.zip, 'moveLive:moved:app.sqlite')).signal).toBe('SIGKILL');
    for (const argv of [['backup'], ['reset-link', 'gm']]) expect((await runCli(argv, s.env.config)).code).toBe(EXIT.restoreInProgress);
    const m = readRestoreMarker(data());
    expect(m).toMatchObject({ v: 1, phase: 'swapping', next: 'moveLive' });
    expect(statSync(join(data(), '.restore-in-progress')).mode & 0o777).toBe(0o600);
    // the intended move list was written BEFORE the first move
    expect((m as { liveMoved: { name: string }[] }).liveMoved.map((f) => f.name)).toEqual(['app.sqlite']);
    expect((await runCli(['restore', s.zip, '--yes'], s.env.config)).code).toBe(0);
    assertRestoredOnce();
  }, 60_000);
});

describe('kill -9 during a rollback, then run the command again (a rollback is only ever continued as a rollback)', () => {
  it('continues the rollback from every point and ends with the original state byte for byte', async () => {
    const points = [...new Set(await pointsOf({ racer: true }))].filter((p) => p.startsWith('rollback:'));
    expect(points).toEqual(expect.arrayContaining(['rollback:marker:removeInstalled', 'rollback:done:removeInstalled', 'rollback:marker:uploadsBack', 'rollback:marker:liveBack', 'rollback:marker:deleteStaging', 'rollback:marker:finalize', 'rollback:done:finalize']));
    for (const point of points) {
      await liveInstance();
      const originalState = () => treeDigest(data(), (p) => ignoreOpsLog(p) || p.startsWith('pre-restore-') || p.startsWith('.restore'));
      const before = originalState();
      const k = await killedAt(s.zip, point, { RACER: 'link' });
      expect(k.signal, point).toBe('SIGKILL');
      if (point !== 'rollback:done:finalize') expect(readRestoreMarker(data()), point).toMatchObject({ rollingBack: { reason: expect.any(String) } });
      // the new run is given a DIFFERENT file; it must still only roll back
      const other = join(s.work, 'whatever.zip');
      writeFileSync(other, 'not even a zip');
      const r = await runCli(['restore', point === 'rollback:done:finalize' ? s.zip : other, '--yes'], s.env.config);
      if (point === 'rollback:done:finalize') {
        // the rollback had finished and removed the marker: this is a fresh restore, which now works
        expect(r.code, point).toBe(0);
      } else {
        expect(r.code, `${point}: ${r.err}`).toBe(EXIT.rolledBack);
        expect(originalState(), point).toEqual(before);
        expect(restoreMarkerExists(data()), point).toBe(false);
        expect(readdirSync(data()).filter((n) => n.startsWith('.restore')), point).toEqual([]);
      }
      s.env.cleanup();
      rmSync(s.work, { recursive: true, force: true });
    }
  }, 240_000);
});

describe('the server start guard (design 7.1)', () => {
  function startServer(dir: string, extraEnv: Record<string, string> = {}) {
    return spawnSync(process.execPath, ['--import', 'tsx', join(SERVER_ROOT, 'src', 'main.ts')], {
      cwd: SERVER_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, CN_SKIP_DOTENV: '1', DATA_DIR: dir, PORT: '0', FIVETOOLS_SRC_PATH: join(dir, 'nope'), FIVETOOLS_IMG_PATH: join(dir, 'nope2'), ...extraEnv },
    });
  }

  it('exits 1 BEFORE touching the data directory when the marker exists, with a message that says how to finish or abort', async () => {
    await liveInstance();
    rmSync(join(data(), 'uploads'), { recursive: true });
    rmSync(dbPath());
    expect((await killedAt(s.zip, 'marker:created')).signal).toBe('SIGKILL'); // a real marker, written by the real code
    const before = treeDigest(data(), () => false);
    const r = startServer(data());
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/restore is running or was interrupted/);
    expect(r.stderr).toMatch(/run the same command again/);
    expect(r.stderr).toMatch(/To ABORT by hand/);
    expect(r.stderr).toMatch(/\.restore-in-progress/);
    expect(treeDigest(data(), () => false), 'nothing was created or changed (no uploads/, index.sqlite, app.sqlite)').toEqual(before);
    expect(existsSync(join(data(), 'index.sqlite'))).toBe(false);
    expect(existsSync(join(data(), 'uploads'))).toBe(false);
  }, 90_000);

  it('an unreadable marker also stops it (the server never starts "by accident")', async () => {
    s = await seededInstance();
    stopServer(s.env);
    writeFileSync(join(data(), '.restore-in-progress'), '{torn');
    const r = startServer(data());
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/cannot be read/);
  }, 90_000);

  it('checks the marker at the very top and again right after openAppDb (source order guard)', () => {
    const src = readFileSync(join(SERVER_ROOT, 'src', 'main.ts'), 'utf8');
    const iFirst = src.indexOf('refuseWhileRestoring(config.dataDir);');
    const iEnsure = src.indexOf('ensureDataDirs(config);');
    const iIndex = src.indexOf('openIndexDb(config.indexDbPath)');
    const iApp = src.indexOf('openAppDb(config.appDbPath)');
    const iSecond = src.indexOf('refuseWhileRestoring(config.dataDir, ');
    expect(iFirst).toBeGreaterThan(0);
    expect(iFirst).toBeLessThan(iEnsure);
    expect(iFirst).toBeLessThan(iIndex);
    expect(iEnsure).toBeLessThan(iApp);
    expect(iSecond).toBeGreaterThan(iApp);
    expect(src.slice(iSecond, iSecond + 200)).toMatch(/close\(\)/); // it closes the databases before exiting
  });
});
