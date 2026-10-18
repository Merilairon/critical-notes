/** Task M3.3, review round 1 (Code Reviewer and Security Architect items R1 to R6 and (a) to (e)). */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT } from '../src/cli/errors';
import { restoreCommand } from '../src/cli/restore';
import { appendOpsLog } from '../src/lib/ops-log';
import { readRestoreMarker, restoreBlockedMessage, restoreMarkerExists } from '../src/lib/restore-marker';
import { isDamagedDatabaseError } from '../src/services/backups';
import { spawn } from 'node:child_process';
import { join as pjoin } from 'node:path';
import { changeLive, ignoreOpsLog, preRestoreDirs, runCli, seededInstance, stopServer, treeDigest, type Seeded } from './restore-helpers';

let s: Seeded;
afterEach(() => {
  if (!s) return;
  try {
    chmodSync(s.env.config.appDbPath, 0o600);
  } catch {
    // gone
  }
  s.env.cleanup();
  rmSync(s.work, { recursive: true, force: true });
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
const SERVER_ROOT = pjoin(import.meta.dirname, '..');
const clean = () => {
  expect(restoreMarkerExists(data())).toBe(false);
  expect(readdirSync(data()).filter((n) => n.startsWith('.restore-') || n.startsWith('.restore.'))).toEqual([]);
};

describe('R1: the probe does not fail open', () => {
  it('only a corrupt or not-a-database file counts as damaged', () => {
    for (const code of ['SQLITE_CORRUPT', 'SQLITE_CORRUPT_VTAB', 'SQLITE_NOTADB']) expect(isDamagedDatabaseError({ code }), code).toBe(true);
    for (const code of ['SQLITE_CANTOPEN', 'SQLITE_IOERR_LOCK', 'SQLITE_BUSY_RECOVERY', 'SQLITE_LOCKED', 'SQLITE_PROTOCOL', 'SQLITE_PERM', undefined]) {
      expect(isDamagedDatabaseError({ code }), String(code)).toBe(false);
    }
  });

  it('an app.sqlite that cannot be opened (chmod 000) refuses with its own exit code and changes nothing', async () => {
    s = await seededInstance();
    stopServer(s.env);
    chmodSync(dbPath(), 0o000);
    const before = treeDigest(data(), (p) => ignoreOpsLog(p) || p === 'app.sqlite');
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config);
    expect(r.code).toBe(EXIT.cannotLock);
    expect(r.err).toMatch(/Cannot lock app\.sqlite \(SQLITE_CANTOPEN\), refusing/);
    chmodSync(dbPath(), 0o600);
    expect(treeDigest(data(), (p) => ignoreOpsLog(p) || p === 'app.sqlite')).toEqual(before);
    expect(preRestoreDirs(data())).toEqual([]);
    clean();
  });
});

describe('R2: nothing follows links, nothing untrusted is trusted', () => {
  it('the operations log is never written through a symlink', () => {
    s = undefined as unknown as Seeded;
    const dir = join(process.env.TMPDIR ?? '/tmp', `cn-ops-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const target = join(dir, 'victim');
      writeFileSync(target, 'precious', { mode: 0o644 });
      symlinkSync(target, join(dir, 'restore-log.jsonl'));
      expect(() => appendOpsLog(dir, 'backup.created', { name: 'x' })).toThrow();
      expect(readFileSync(target, 'utf8')).toBe('precious');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('as root it uses lchown and never touches the old uploads tree, nor follows a planted link', async () => {
    s = await seededInstance();
    changeLive(s.env);
    symlinkSync('/etc/shadow', join(data(), 'uploads', 'planted-link'));
    stopServer(s.env);
    const calls: string[] = [];
    await restoreCommand([s.zip, '--yes'], { config: s.env.config, info: () => undefined, isRoot: true, chown: (p) => void calls.push(p) });
    expect(calls.some((c) => c.includes('/etc/shadow') || c.includes('planted-link'))).toBe(false);
    expect(calls.some((c) => /pre-restore-[^/]*\/uploads/.test(c))).toBe(false);
    const src = readFileSync(join(SERVER_ROOT, 'src', 'cli', 'restore.ts'), 'utf8');
    expect(src).toContain('this.env.chown ?? lchownSync');
    expect(src).not.toMatch(/\bchownSync\(/);
  });

  it('a marker is validated: unknown move-list names, a bad staged hash, an unknown rollback step, a missing user are all unreadable and never acted on', async () => {
    s = await seededInstance();
    stopServer(s.env);
    const good = {
      v: 1, startedAt: 'now', user: { uid: 1, name: 'u' }, zip: { name: 'a.zip', sha256: 'a'.repeat(64), size: 1 }, staging: '.restore-20261017T093000Z',
      preRestore: 'pre-restore-20261017T093000Z', flags: { keepTokens: false, carryRestrictions: true }, phase: 'swapping', next: 'moveLive', liveMoved: [{ name: 'app.sqlite', size: 1 }], uploadsLive: null,
    };
    const put = (m: unknown) => writeFileSync(join(data(), '.restore-in-progress'), JSON.stringify(m));
    put(good);
    expect(readRestoreMarker(data())).not.toBe('unreadable');
    const bad: Record<string, unknown>[] = [
      { ...good, liveMoved: [{ name: '../../etc/passwd', size: 1 }] },
      { ...good, liveMoved: [{ name: 'uploads', size: 1 }] },
      { ...good, staged: { sha256: 'xyz', size: 1 } },
      { ...good, rollingBack: { reason: 'x', next: 'bogus' } },
      { ...good, user: undefined },
      { ...good, phase: 'weird' },
    ];
    const before = treeDigest(data(), ignoreOpsLog);
    for (const m of bad) {
      put(m);
      expect(readRestoreMarker(data())).toBe('unreadable');
      expect(() => restoreBlockedMessage(data())).not.toThrow();
      const r = await runCli(['restore', s.zip, '--yes'], s.env.config);
      expect(r.code).toBe(EXIT.restoreInProgress);
    }
    rmSync(join(data(), '.restore-in-progress'));
    expect(treeDigest(data(), (p) => ignoreOpsLog(p))).toEqual(Object.fromEntries(Object.entries(before).filter(([k]) => k !== '.restore-in-progress')));
  });

  it('the blocked message also gives the Docker form', async () => {
    s = await seededInstance();
    writeFileSync(
      join(data(), '.restore-in-progress'),
      JSON.stringify({ v: 1, startedAt: 'now', user: { uid: 1, name: 'u' }, zip: { name: 'a.zip', sha256: 'a'.repeat(64), size: 1 }, staging: '.restore-20261017T093000Z', preRestore: 'pre-restore-20261017T093000Z', flags: { keepTokens: false, carryRestrictions: true }, phase: 'started', next: 'stage', liveMoved: null, uploadsLive: null }),
    );
    expect(restoreBlockedMessage(data())).toMatch(/docker compose run --rm app node admin\.mjs restore/);
  });

  it('the blocked message shows the right program for both forms and ends with docker compose up -d', async () => {
    s = await seededInstance();
    writeFileSync(
      join(data(), '.restore-in-progress'),
      JSON.stringify({ v: 1, startedAt: 'now', user: { uid: 1, name: 'u' }, zip: { name: 'a.zip', sha256: 'a'.repeat(64), size: 1 }, staging: '.restore-20261017T093000Z', preRestore: 'pre-restore-20261017T093000Z', flags: { keepTokens: false, carryRestrictions: true }, phase: 'started', next: 'stage', liveMoved: null, uploadsLive: null }),
    );
    const msg = restoreBlockedMessage(data());
    expect(msg).toContain('Docker:       docker compose run --rm app node admin.mjs restore <the same backup file> [the same flags]');
    expect(msg).toContain('Bare install: node apps/server/dist/admin.mjs restore <the same backup file> [the same flags]   (from the repository folder)');
    expect(msg).not.toMatch(/node dist\/admin\.mjs/);
    expect(msg).toContain('docker compose up -d (works whether or not the container exists)');
    expect(msg).not.toContain('start app');
    // substrings the README quotes
    expect(msg).toMatch(/To FINISH it: stop the server \(docker compose stop app/);
    expect(msg).toMatch(/run the same command again/);
    expect(msg).toMatch(/To ABORT by hand/);
  });
});

describe('R3: messages and the planner statistics', () => {
  it('names the extra object and the way out; terminal escapes in the name are neutralised', async () => {
    s = await seededInstance();
    stopServer(s.env);
    const { mkdirSync: mk } = await import('node:fs');
    const { readBackup, readMigrationLevel } = await import('../src/services/backups');
    const { rawZip, testManifest, validEntries } = await import('./zip-builder');
    const staged = join(s.work, 'x');
    mk(staged);
    await readBackup(s.zip, { extractTo: staged });
    const evil = new Database(join(staged, 'app.sqlite'));
    evil.exec(`create table "evil\u001b[2Jname" (x)`);
    evil.pragma('journal_mode = DELETE');
    evil.close();
    const dbBytes = readFileSync(join(staged, 'app.sqlite'));
    const manifest = testManifest(dbBytes.length);
    const d = new Database(join(staged, 'app.sqlite'), { readonly: true });
    (manifest.database as Record<string, unknown>).migrations = readMigrationLevel(d);
    d.close();
    const uploads = Object.fromEntries([...s.uploads.keys()].map((id) => [id, readFileSync(join(staged, 'uploads', id))]));
    const f = join(s.work, 'evil.zip');
    writeFileSync(f, rawZip(validEntries({ db: dbBytes, uploads, manifest })));
    const r = await runCli(['restore', f, '--yes'], s.env.config);
    expect(r.code).toBe(EXIT.invalidBackup);
    expect(r.err).toMatch(/extra schema object \(table evil\?\[2Jname\)/);
    expect(r.err).toMatch(/exactly the application's own schema/);
    expect(r.err).toMatch(/ANALYZE/);
    expect(r.err).toMatch(/make a new backup/);
    // eslint-disable-next-line no-control-regex
    expect(r.err).not.toMatch(/\u001b/);
  });

  it('a diverged history says it comes from another branch or an edited database, and which version the backup CLAIMS', async () => {
    s = await seededInstance();
    s.env.db.$client.exec(`update __drizzle_migrations set hash = 'ffff' where rowid = 2`);
    const r0 = await s.env.service({ opsLog: false }).create({ actor: 'x', trigger: 'cli' });
    stopServer(s.env);
    const r = await runCli(['restore', join(s.env.config.backupDir, r0.name), '--yes'], s.env.config);
    expect(r.code).toBe(EXIT.divergedBackup);
    expect(r.err).toMatch(/different branch, a fork or an edited database/);
    expect(r.err).toMatch(/claims it was made by Critical Notes/);
  });
});

describe('R4: the marker is read again under the lock', () => {
  it('a restore that finished between the first look and the lock is not "resumed" from a stale marker', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    // leave a real interrupted restore behind
    const fixture = pjoin(import.meta.dirname, 'fixtures', 'restore-kill.ts');
    await new Promise<void>((resolve) => {
      const c = spawn(process.execPath, ['--import', 'tsx', fixture, JSON.stringify(s.env.config), s.zip], { cwd: SERVER_ROOT, env: { ...process.env, CN_SKIP_DOTENV: '1', KILL_AT: 'done:moveLive' }, stdio: 'ignore' });
      c.once('exit', () => resolve());
    });
    expect(readRestoreMarker(data())).toMatchObject({ phase: 'swapping' });
    let inner: Awaited<ReturnType<typeof runCli>> | null = null;
    let fired = false;
    const outer = await runCli(['restore', s.zip, '--yes'], s.env.config, {
      restoreHooks: {
        async at(p) {
          if (p === 'before-lock' && !fired) {
            fired = true;
            inner = await runCli(['restore', s.zip, '--yes'], s.env.config); // finishes the interrupted restore completely
          }
        },
      },
    });
    expect(inner).toMatchObject({ code: 0 });
    expect(outer.code, outer.err).toBe(0); // it saw no marker under the lock and did a clean second restore
    clean();
    expect(q('select count(*) as n from users')).toEqual([{ n: 3 }]);
    expect(q('pragma integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(preRestoreDirs(data())).toHaveLength(2);
  }, 60_000);

  it('two invocations of the same zip: while one runs, the other is told so (75) and changes nothing', async () => {
    s = await seededInstance();
    stopServer(s.env);
    let second: Awaited<ReturnType<typeof runCli>> | null = null;
    const first = await runCli(['restore', s.zip, '--yes'], s.env.config, {
      restoreHooks: {
        async at(p) {
          if (p === 'marker:created') second = await runCli(['restore', s.zip, '--yes'], s.env.config);
        },
      },
    });
    expect(first.code).toBe(0);
    expect(second).toMatchObject({ code: EXIT.restoreInProgress });
    expect(second!.err).toMatch(/Another restore is running/);
    expect(preRestoreDirs(data())).toHaveLength(1);
  });
});

describe('R5: a resumed swap does not keep the database open', () => {
  async function interrupted(point: string) {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    const fixture = pjoin(import.meta.dirname, 'fixtures', 'restore-kill.ts');
    await new Promise<void>((resolve) => {
      const c = spawn(process.execPath, ['--import', 'tsx', fixture, JSON.stringify(s.env.config), s.zip], { cwd: SERVER_ROOT, env: { ...process.env, CN_SKIP_DOTENV: '1', KILL_AT: point }, stdio: 'ignore' });
      c.once('exit', () => resolve());
    });
  }

  it('resuming in the swapping phase before the move list exists: the probe is released before the moves (a second connection is not blocked)', async () => {
    await interrupted('marker:preRestoreDir');
    expect(readRestoreMarker(data())).toMatchObject({ phase: 'swapping', liveMoved: null });
    let blocked: string | null = 'not tried';
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config, {
      restoreHooks: {
        at(p) {
          if (p !== 'marker:preRestoreDir') return;
          const other = new Database(dbPath(), { timeout: 100 });
          try {
            other.prepare('select count(*) from users').get();
            blocked = null;
          } catch (e) {
            blocked = (e as { code?: string }).code ?? 'error';
          } finally {
            other.close();
          }
        },
      },
    });
    expect(r.code).toBe(0);
    expect(blocked).toBeNull();
  }, 60_000);

  it('resuming after the move list was written does not open the live database at all', async () => {
    await interrupted('done:moveLive');
    const points: string[] = [];
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config, { restoreHooks: { at: (p) => void points.push(p) } });
    expect(r.code).toBe(0);
    expect(points).toContain('probe:skipped');
    expect(points).not.toContain('probe:acquired');
  }, 60_000);
});

describe('R6: odd live files are refused before any marker exists', () => {
  it('a symlinked app.sqlite (or -wal, or a directory) is refused up front, with nothing created', async () => {
    s = await seededInstance();
    stopServer(s.env);
    const real = join(s.work, 'real.sqlite');
    writeFileSync(real, 'x');
    for (const make of [
      () => {
        rmSync(dbPath());
        symlinkSync(real, dbPath());
      },
      () => {
        rmSync(dbPath());
        writeFileSync(dbPath(), 'x');
        symlinkSync(real, `${dbPath()}-wal`);
      },
      () => {
        rmSync(`${dbPath()}-wal`, { force: true });
        mkdirSync(`${dbPath()}-shm`);
      },
    ]) {
      make();
      const before = treeDigest(data(), ignoreOpsLog);
      const r = await runCli(['restore', s.zip, '--yes'], s.env.config);
      expect(r.code).toBe(EXIT.failed);
      expect(r.err).toMatch(/not a regular file/);
      expect(treeDigest(data(), ignoreOpsLog)).toEqual(before);
      clean();
    }
  });
});

describe('Code Reviewer items', () => {
  it('(a) a hard-link failure other than EEXIST falls back to an exclusive copy', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    const eperm = async () => Promise.reject(Object.assign(new Error('no links here'), { code: 'EPERM' }));
    const out = await restoreCommand([s.zip, '--yes'], { config: s.env.config, info: () => undefined, linkFn: eperm as never });
    expect(out).toMatch(/^Restored /);
    expect(q('select count(*) as n from users')).toEqual([{ n: 3 }]);
    expect(q('pragma integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    clean();
  });

  it('(a) the exclusive copy refuses to overwrite a racer (rolls back, exit 71)', async () => {
    s = await seededInstance();
    stopServer(s.env);
    const before = treeDigest(data(), (p) => ignoreOpsLog(p) || p.startsWith('pre-restore-') || p.startsWith('.restore'));
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config, {
      restoreHooks: {
        at(p) {
          if (p === 'install:beforeLink') writeFileSync(dbPath(), 'racer');
        },
      },
    });
    expect(r.code).toBe(EXIT.rolledBack);
    expect(treeDigest(data(), (p) => ignoreOpsLog(p) || p.startsWith('pre-restore-') || p.startsWith('.restore'))).toEqual(before);
  });

  it('(b) a staged app.sqlite damaged while the restore was interrupted (same size) is staged again, never installed', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    const fixture = pjoin(import.meta.dirname, 'fixtures', 'restore-kill.ts');
    await new Promise<void>((resolve) => {
      const c = spawn(process.execPath, ['--import', 'tsx', fixture, JSON.stringify(s.env.config), s.zip], { cwd: SERVER_ROOT, env: { ...process.env, CN_SKIP_DOTENV: '1', KILL_AT: 'marker:staged' }, stdio: 'ignore' });
      c.once('exit', () => resolve());
    });
    const m = readRestoreMarker(data());
    if (m === null || m === 'unreadable') throw new Error('no marker');
    const staged = join(data(), m.staging, 'app.sqlite');
    const bytes = readFileSync(staged);
    bytes[bytes.length - 5]! ^= 0xff; // same size, one byte different
    writeFileSync(staged, bytes);
    const damagedSha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config);
    expect(r.code, r.err).toBe(0);
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(readFileSync(dbPath())).digest('hex')).not.toBe(damagedSha);
    expect(q('pragma integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  }, 60_000);

  it('(c) a dangling symlink named like the marker also blocks BackupService.create', async () => {
    s = await seededInstance();
    symlinkSync(join(s.work, 'nowhere'), join(data(), '.restore-in-progress'));
    await expect(s.env.service({ opsLog: false }).create({ actor: 'x', trigger: 'cli' })).rejects.toMatchObject({ code: 'restore-in-progress' });
  });

  it('(d) leftover marker temp files and old check folders are swept at the start', async () => {
    s = await seededInstance();
    stopServer(s.env);
    writeFileSync(join(data(), '.restore-in-progress.tmp-abc'), '{"report":"x"}');
    mkdirSync(join(data(), '.restore-check-old'));
    writeFileSync(join(data(), '.restore-check-old', 'app.sqlite'), 'x');
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(join(data(), '.restore-check-old'), old, old);
    mkdirSync(join(data(), '.restore-check-fresh'));
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config);
    expect(r.code).toBe(0);
    expect(existsSync(join(data(), '.restore-in-progress.tmp-abc'))).toBe(false);
    expect(existsSync(join(data(), '.restore-check-old'))).toBe(false);
    expect(existsSync(join(data(), '.restore-check-fresh'))).toBe(true); // a check that may be running now is left alone
  });

  it('(d) the same sweep runs when the restore is refused or aborted (the leftovers hold the report)', async () => {
    s = await seededInstance();
    stopServer(s.env);
    const { holdDatabase, killAndWait } = await import('./restore-helpers');
    const holder = await holdDatabase(dbPath());
    try {
      writeFileSync(join(data(), '.restore-in-progress.tmp-zzz'), '{"report":"x"}');
      const r = await runCli(['restore', s.zip, '--yes'], s.env.config);
      expect(r.code).toBe(EXIT.serverRunning);
      expect(existsSync(join(data(), '.restore-in-progress.tmp-zzz'))).toBe(false);
    } finally {
      await killAndWait(holder);
    }
  });

  it('(e) a wiped instance is not told anything was moved aside; the plan and --check show the sha256, the user and liveCompared; a --yes run ends with the admins to check', async () => {
    s = await seededInstance();
    stopServer(s.env);
    rmSync(data(), { recursive: true, force: true });
    const chk = await runCli(['restore', s.zip, '--check'], s.env.config);
    expect(chk.out).toMatch(/sha256 [0-9a-f]{64}/);
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config);
    expect(r.out).toMatch(/There was no previous data, so nothing was moved aside/);
    expect(r.out).not.toMatch(/MOVED/);
    expect(r.err).toMatch(/There is no current data, so nothing will be moved aside/);
    expect(r.err).toMatch(/Restore started by .* \(uid \d+\); live data compared with the backup: no; backup file sha256 [0-9a-f]{64}/);
    // over live data: the demoted/deleted block comes last, with the pointer
    const s2 = await seededInstance();
    try {
      s2.env.db.$client.exec(`delete from users where id = 'u1' and 0; update users set is_admin = 0 where id = 'u1'`);
      stopServer(s2.env);
      const r2 = await runCli(['restore', s2.zip, '--yes'], s2.env.config);
      expect(r2.out).toMatch(/CHECK THESE NOW[^]*gm[^]*reset-link/);
      expect(r2.out).toContain('Docker: docker compose run --rm app node admin.mjs reset-link <username>; bare install: node apps/server/dist/admin.mjs reset-link <username>');
      expect(r2.out).toContain('docker compose up -d (works whether or not the container exists)');
      expect(r2.out).not.toMatch(/node dist\/admin\.mjs|docker compose start app/);
      expect(r2.out.indexOf('CHECK THESE NOW')).toBeLessThan(r2.out.indexOf('The first start rebuilds'));
    } finally {
      s2.env.cleanup();
      rmSync(s2.work, { recursive: true, force: true });
    }
  });
});
