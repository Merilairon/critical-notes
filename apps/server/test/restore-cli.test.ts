/**
 * Task M3.3: `restore` and `backup` through the real command line (`runAdmin`), docs/design/backup.md 7, 8, 19.
 * Crash injection and the server-start guard are in `restore-crash.test.ts`; the schema allowlist blocker in `schema-allowlist.test.ts`.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT } from '../src/cli/errors';
import { restoreCommand } from '../src/cli/restore';
import { MIGRATIONS_DIR, openAppDb } from '../src/db';
import { readRestoreMarker, restoreMarkerExists } from '../src/lib/restore-marker';
import { BackupService, loadJournal, readBackup, readMigrationLevel } from '../src/services/backups';
import { rawZip, testManifest, validEntries } from './zip-builder';
import { makeEnv, upId } from './backup-helpers';
import { changeLive, holdDatabase, ignoreOpsLog, killAndWait, preRestoreDirs, runCli, seededInstance, stopServer, treeDigest, type Seeded } from './restore-helpers';

let s: Seeded;
const cleanups: (() => void)[] = [];
afterEach(() => {
  s?.env.cleanup();
  if (s) rmSync(s.work, { recursive: true, force: true });
  for (const c of cleanups.splice(0)) c();
});
const data = () => s.env.config.dataDir;
const dbPath = () => s.env.config.appDbPath;
const open = (p = dbPath()) => new Database(p, { readonly: true });
const q = <T = Record<string, unknown>>(sql: string, p = dbPath()): T[] => {
  const d = open(p);
  try {
    return d.prepare(sql).all() as T[];
  } finally {
    d.close();
  }
};
const leftovers = () => readdirSync(data()).filter((n) => n.startsWith('.restore-') || n.startsWith('.restore.'));
const opsLog = () => (existsSync(join(data(), 'restore-log.jsonl')) ? readFileSync(join(data(), 'restore-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);

describe('restore on a wiped instance and over a live one', () => {
  it('restores onto a wiped instance (no data directory content at all): data, uploads, and nothing else', async () => {
    s = await seededInstance();
    stopServer(s.env);
    rmSync(data(), { recursive: true, force: true });
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config);
    expect(r.code).toBe(EXIT.ok);
    expect(q('select username from users order by username')).toEqual([{ username: 'gm' }, { username: 'locked' }, { username: 'player' }]);
    for (const [id, bytes] of s.uploads) expect(readFileSync(join(data(), 'uploads', id)).equals(bytes)).toBe(true);
    expect(existsSync(join(data(), 'uploads', `${upId(1)}.thumb`))).toBe(true);
    expect(q('select count(*) as n from sessions')).toEqual([{ n: 0 }]);
    expect(q('select count(*) as n from password_resets')).toEqual([{ n: 0 }]);
    expect(q('select id, revoked_at is not null as revoked from api_tokens order by id')).toEqual([{ id: 't1', revoked: 1 }, { id: 't2', revoked: 1 }]);
    expect(restoreMarkerExists(data())).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(readdirSync(data()).filter((n) => n.endsWith('-wal') || n.endsWith('-shm'))).toEqual([]);
    expect(r.out).toContain('could not be compared'); // a wiped instance has nothing to diff
    expect(opsLog().map((e) => e.event)).toEqual(['restore.started', 'restore.completed']);
    expect(opsLog()[1]).toMatchObject({ liveCompared: false });
    // the application opens it as a normal database
    const app = openAppDb(dbPath());
    expect(app.$client.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    app.$client.close();
  });

  it('over a live instance: old state MOVED to pre-restore (not copied), live restrictions carried, report is the only stdout', async () => {
    s = await seededInstance();
    changeLive(s.env);
    s.env.db.$client.exec(`create table keep_me_marker (x)`); // proof the pre-restore copy is the old database
    stopServer(s.env);
    writeFileSync(join(data(), 'index.sqlite'), 'old index');
    writeFileSync(join(data(), 'index.sqlite-wal'), 'old wal');
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config);
    expect(r.code).toBe(EXIT.ok);
    // restored data
    expect(q('select username from users order by username')).toEqual([{ username: 'gm' }, { username: 'locked' }, { username: 'player' }]);
    // carried over: 'player' was disabled live after the backup
    expect(q<{ username: string; disabled: number }>('select username, disabled_at is not null as disabled from users order by username').map((u) => [u.username, u.disabled])).toEqual([['gm', 0], ['locked', 1], ['player', 1]]);
    expect(r.out).toMatch(/disabled users: player/);
    expect(r.out).toMatch(/newcomer/); // lost from the backup, reported
    // moved, not copied
    const pre = preRestoreDirs(data());
    expect(pre).toHaveLength(1);
    const old = join(data(), pre[0]!);
    expect(q("select name from sqlite_master where name = 'keep_me_marker'", join(old, 'app.sqlite'))).toHaveLength(1);
    expect(existsSync(join(old, 'uploads', upId(9)))).toBe(true);
    expect(existsSync(join(data(), 'uploads', upId(9)))).toBe(false);
    // the search index is deleted so the first start rebuilds it
    expect(readdirSync(data()).filter((n) => n.startsWith('index.sqlite'))).toEqual([]);
    // stdout is the report only: no audit JSON, no plan; stderr has the plan
    expect(r.out).not.toMatch(/"event"/);
    expect(r.out).toMatch(/delete it after you have verified/);
    expect(r.out).toContain(pre[0]!);
    expect(r.err).toMatch(/REPLACE the current database/);
  });

  it('stale -wal/-shm beside a crashed live database: none stays beside the new file, and the old committed data is preserved in pre-restore', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    // a real crashed writer: WAL file with committed, un-checkpointed frames, and its -shm
    const holder = await holdDatabase(dbPath());
    await killAndWait(holder);
    expect(existsSync(`${dbPath()}-wal`)).toBe(true);
    expect(existsSync(`${dbPath()}-shm`)).toBe(true);
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config);
    expect(r.code).toBe(EXIT.ok);
    expect(existsSync(`${dbPath()}-wal`)).toBe(false);
    expect(existsSync(`${dbPath()}-shm`)).toBe(false);
    // the probe recovered the WAL (SQLite merged the committed frames into the old file when it let go of it), so the
    // pre-restore copy is self-contained and holds the crashed writer's committed row
    const old = join(data(), preRestoreDirs(data())[0]!);
    expect(q('select x from held_probe', join(old, 'app.sqlite'))).toEqual([{ x: 1 }]);
    expect(q('select username from users where id = ?'.replace('?', "'u9'"), join(old, 'app.sqlite'))).toEqual([{ username: 'newcomer' }]);
    // the restored database is the backup, not a replay of the old frames
    expect(q("select name from sqlite_master where name = 'held_probe'")).toEqual([]);
    expect(q('select count(*) as n from users')).toEqual([{ n: 3 }]);
  });

  it('junk -wal/-shm files that look live are not left beside the new database, and whatever remains of them is in pre-restore', async () => {
    s = await seededInstance();
    stopServer(s.env);
    writeFileSync(`${dbPath()}-wal`, Buffer.alloc(8272, 9));
    writeFileSync(`${dbPath()}-shm`, Buffer.alloc(32768, 9));
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config);
    expect(r.code).toBe(EXIT.ok);
    expect(existsSync(`${dbPath()}-wal`)).toBe(false);
    expect(existsSync(`${dbPath()}-shm`)).toBe(false);
    expect(q('select count(*) as n from users')).toEqual([{ n: 3 }]);
    const reopened = openAppDb(dbPath()); // and the application opens it without surprises
    expect(reopened.$client.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    reopened.$client.close();
  });

  it('the old -wal and -shm move together with app.sqlite when they exist at the moment of the move (all three or none)', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config, {
      restoreHooks: {
        at(p) {
          // frames written by a late writer, after the probe let go and before the files are listed
          if (p === 'done:preRestoreDir') {
            writeFileSync(`${dbPath()}-wal`, 'late wal frames');
            writeFileSync(`${dbPath()}-shm`, 'late shm');
          }
        },
      },
    });
    expect(r.code).toBe(0);
    const old = join(data(), preRestoreDirs(data())[0]!);
    expect(readFileSync(join(old, 'app.sqlite-wal'), 'utf8')).toBe('late wal frames');
    expect(readFileSync(join(old, 'app.sqlite-shm'), 'utf8')).toBe('late shm');
    expect(q("select username from users where id = 'u9'", join(old, 'app.sqlite'))).toEqual([{ username: 'newcomer' }]);
    expect(existsSync(`${dbPath()}-wal`)).toBe(false);
    expect(existsSync(`${dbPath()}-shm`)).toBe(false);
  });

  it('a damaged live database does not stop the restore (the disaster case); carry-over is reported as impossible', async () => {
    s = await seededInstance();
    stopServer(s.env);
    writeFileSync(dbPath(), Buffer.concat([Buffer.from('this is not a database '), Buffer.alloc(4096, 7)]));
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toMatch(/could not be compared/);
    expect(readFileSync(join(data(), preRestoreDirs(data())[0]!, 'app.sqlite')).subarray(0, 22).toString()).toBe('this is not a database');
    expect(q('select count(*) as n from users')).toEqual([{ n: 3 }]);
  });

  it('files and folders it creates are private: 0600/0700, owned by the running user, no stray temp files', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    expect((await runCli(['restore', s.zip, '--yes'], s.env.config)).code).toBe(0);
    const mode = (p: string) => statSync(p).mode & 0o777;
    const uid = process.getuid!();
    expect(mode(dbPath())).toBe(0o600);
    expect(mode(join(data(), 'uploads'))).toBe(0o700);
    expect(mode(join(data(), 'uploads', upId(1)))).toBe(0o600);
    expect(mode(join(data(), preRestoreDirs(data())[0]!))).toBe(0o700);
    expect(mode(join(data(), 'restore-log.jsonl'))).toBe(0o600);
    for (const p of [dbPath(), join(data(), 'uploads'), join(data(), 'uploads', upId(1))]) expect(statSync(p).uid).toBe(uid);
    expect(readdirSync(data()).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('run as root it chowns the database, uploads, pre-restore copy and log to the owner of the data directory (best effort)', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    const calls: string[] = [];
    const text = await restoreCommand([s.zip, '--yes'], {
      config: s.env.config,
      info: () => undefined,
      isRoot: true,
      chown: (p, uid, gid) => {
        expect([uid, gid]).toEqual([statSync(data()).uid, statSync(data()).gid]);
        calls.push(p.replace(data(), ''));
      },
    });
    expect(text).toMatch(/^Restored /);
    expect(calls).toContain('/app.sqlite');
    expect(calls).toContain('/uploads');
    expect(calls).toContain(`/uploads/${upId(1)}`);
    expect(calls.some((c) => /^\/pre-restore-.*\/app\.sqlite$/.test(c))).toBe(true);
    expect(calls.filter((c) => /^\/pre-restore-[^/]*\/uploads/.test(c)), 'the old uploads tree is untrusted and keeps its owner').toEqual([]);
    expect(calls).toContain('/restore-log.jsonl');
  });

  it('prints no secret: no password hash, token or invite hash in stdout, stderr or the operations log', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config);
    const everything = `${r.out}\n${r.err}\n${readFileSync(join(data(), 'restore-log.jsonl'), 'utf8')}`;
    for (const secret of ['pwhash-', 'token-hash', 'invite-hash', 'reset-hash']) expect(everything).not.toContain(secret);
    // user names are only in what the terminal shows (design 8.2), never in the log
    const log = readFileSync(join(data(), 'restore-log.jsonl'), 'utf8');
    for (const name of ['newcomer', 'player', 'locked']) expect(log).not.toContain(name);
  });
});

describe('carry-over of live restrictions through the command (design 8.1)', () => {
  it('a token revoked live after the backup stays revoked under --keep-tokens, a user disabled live stays disabled; the report lists the enabled admins', async () => {
    s = await seededInstance();
    changeLive(s.env); // t1 revoked live, 'player' disabled live, 'newcomer' and t9 created live
    stopServer(s.env);
    const r = await runCli(['restore', s.zip, '--keep-tokens', '--yes'], s.env.config);
    expect(r.code).toBe(0);
    expect(q('select id, revoked_at is not null as revoked from api_tokens order by id')).toEqual([{ id: 't1', revoked: 1 }, { id: 't2', revoked: 1 }]);
    expect(q('select revoked_at from campaign_invites where id = ?'.replace('?', "'i1'"))).toEqual([{ revoked_at: null }]); // kept: not revoked live
    expect(q("select disabled_at is not null as d from users where username = 'player'")).toEqual([{ d: 1 }]);
    expect(r.out).toMatch(/API tokens revoked: 1/);
    expect(r.out).toMatch(/Enabled administrators: gm\./);
    expect(r.out).toMatch(/not applied|NOT in the restored instance/);
  });

  it('--no-carry-restrictions skips it: the user disabled live is enabled again, as in the backup', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    const r = await runCli(['restore', s.zip, '--yes', '--no-carry-restrictions'], s.env.config);
    expect(r.code).toBe(0);
    expect(q("select disabled_at from users where username = 'player'")).toEqual([{ disabled_at: null }]);
    expect(r.out).toMatch(/NOT carried over \(--no-carry-restrictions\)/);
    expect(opsLog().at(-1)).toMatchObject({ event: 'restore.completed', carryRestrictions: false });
  });
});

describe('restore-log.jsonl (design 8.2)', () => {
  it('records backup.created, restore.started and restore.completed with the listed fields, survives the restore, mode 0600', async () => {
    s = await seededInstance();
    const b = await runCli(['backup'], s.env.config);
    expect(b.code).toBe(0);
    stopServer(s.env);
    expect((await runCli(['restore', s.zip, '--yes', '--keep-tokens', '--no-carry-restrictions'], s.env.config)).code).toBe(0);
    const log = opsLog();
    expect(log.map((e) => e.event)).toEqual(['backup.created', 'restore.started', 'restore.completed']);
    expect(log[0]).toMatchObject({ trigger: 'cli' });
    expect(log[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const e of log.slice(1)) {
      expect(e).toMatchObject({ backup: expect.stringMatching(/^backup-\d{8}T\d{6}Z\.zip$/), keepTokens: true, carryRestrictions: false, uid: process.getuid!(), phase: expect.any(String) });
      expect(e.zipSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof e.user).toBe('string');
      expect(typeof e.at).toBe('string');
    }
    expect(log[2]).toMatchObject({ liveCompared: false });
    expect(statSync(join(data(), 'restore-log.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('an aborted restore is logged with restore.aborted', async () => {
    s = await seededInstance();
    stopServer(s.env);
    const bad = join(s.work, 'bad.zip');
    writeFileSync(bad, Buffer.concat([readFileSync(s.zip)]).subarray(0, 5000));
    expect((await runCli(['restore', bad, '--yes'], s.env.config)).code).toBe(EXIT.invalidBackup);
    // refused in the preflight: nothing started, nothing to abort
    expect(opsLog()).toEqual([]);
    // a refusal after the marker (the server holds the database) is logged
    const holder = await holdDatabase(dbPath());
    cleanups.push(() => holder.kill('SIGKILL'));
    expect((await runCli(['restore', s.zip, '--yes'], s.env.config)).code).toBe(EXIT.serverRunning);
    expect(opsLog().map((e) => e.event)).toEqual(['restore.started', 'restore.aborted']);
  });
});

describe('refusals', () => {
  it('refuses while a real second process holds the database, leaves everything as it was, and works after kill -9', async () => {
    s = await seededInstance();
    stopServer(s.env);
    const holder = await holdDatabase(dbPath());
    cleanups.push(() => holder.kill('SIGKILL'));
    const before = treeDigest(data(), ignoreOpsLog);
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config);
    expect(r.code).toBe(EXIT.serverRunning);
    expect(r.err).toMatch(/server is running/);
    expect(r.err).toMatch(/docker compose stop app/);
    expect(treeDigest(data(), (p) => ignoreOpsLog(p) || p.startsWith('app.sqlite-'))).toEqual({ ...Object.fromEntries(Object.entries(before).filter(([k]) => !k.startsWith('app.sqlite-'))) });
    expect(restoreMarkerExists(data())).toBe(false);
    expect(leftovers()).toEqual([]);
    await killAndWait(holder);
    expect((await runCli(['restore', s.zip, '--yes'], s.env.config)).code).toBe(0);
    expect(q("select name from sqlite_master where name = 'held_probe'")).toEqual([]);
  });

  it('a server-like second connection cannot open the database while the restore holds it (between probe and swap)', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    let blocked = '';
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config, {
      restoreHooks: {
        at(p) {
          if (p !== 'stage:extracted') return;
          const other = new Database(dbPath(), { timeout: 100 });
          try {
            other.prepare('select count(*) from users').get();
          } catch (e) {
            blocked = (e as { code?: string }).code ?? 'error';
          } finally {
            other.close();
          }
        },
      },
    });
    expect(r.code).toBe(0);
    expect(blocked).toBe('SQLITE_BUSY');
  });

  it('--keep-tokens requires --yes: refused with the warning before anything happens; with --yes tokens and invites are kept', async () => {
    s = await seededInstance();
    stopServer(s.env);
    const before = treeDigest(data());
    const r = await runCli(['restore', s.zip, '--keep-tokens'], s.env.config);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toMatch(/revoked later because of a compromise/);
    expect(r.err).toMatch(/--yes/);
    expect(treeDigest(data())).toEqual(before);
    const ok = await runCli(['restore', s.zip, '--keep-tokens', '--yes'], s.env.config);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/WARNING: --keep-tokens/);
    expect(q('select id, revoked_at from api_tokens order by id')).toEqual([{ id: 't1', revoked_at: null }, { id: 't2', revoked_at: 1690000000000 }]);
    expect(q('select revoked_at from campaign_invites where id = ?'.replace('?', "'i1'"))).toEqual([{ revoked_at: null }]);
    expect(q('select count(*) as n from sessions')).toEqual([{ n: 0 }]); // cleared regardless
  });

  it('--keep-tokens with --check needs no --yes (nothing changes)', async () => {
    s = await seededInstance();
    stopServer(s.env);
    expect((await runCli(['restore', s.zip, '--keep-tokens', '--check'], s.env.config)).code).toBe(0);
  });

  it('without --yes and without a terminal it refuses early (64); with a terminal it asks, and "no" changes nothing', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    const before = treeDigest(data());
    const none = await runCli(['restore', s.zip], s.env.config);
    expect(none.code).toBe(EXIT.usage);
    expect(none.err).toMatch(/--yes/);
    expect(treeDigest(data())).toEqual(before);
    const asked: string[] = [];
    const no = await runCli(['restore', s.zip], s.env.config, { confirm: async (q) => (asked.push(q), false) });
    expect(no.code).toBe(EXIT.cancelled);
    expect(asked).toHaveLength(1);
    expect(treeDigest(data(), ignoreOpsLog)).toEqual(treeDigest(data(), ignoreOpsLog));
    expect(restoreMarkerExists(data())).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(q("select username from users where id = 'u9'")).toEqual([{ username: 'newcomer' }]); // live data untouched
    const yes = await runCli(['restore', s.zip], s.env.config, { confirm: async () => true });
    expect(yes.code).toBe(0);
  });

  it('usage errors: no file, two files, unknown option', async () => {
    s = await seededInstance();
    for (const argv of [['restore'], ['restore', 'a', 'b'], ['restore', s.zip, '--force'], ['frobnicate']]) expect((await runCli(argv, s.env.config)).code).toBe(EXIT.usage);
    expect((await runCli(['restore', join(s.work, 'missing.zip'), '--yes'], s.env.config)).code).toBe(EXIT.notFound);
    expect((await runCli(['restore', s.work, '--yes'], s.env.config)).code).toBe(EXIT.invalidBackup); // a directory
  });

  it('uploads/ as a symlink, or not a directory, is refused before anything is touched', async () => {
    s = await seededInstance();
    stopServer(s.env);
    const elsewhere = join(s.work, 'elsewhere');
    mkdirSync(elsewhere);
    rmSync(join(data(), 'uploads'), { recursive: true });
    symlinkSync(elsewhere, join(data(), 'uploads'));
    const before = treeDigest(data());
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config);
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toMatch(/symbolic link/);
    expect(treeDigest(data())).toEqual(before);
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(join(data(), 'uploads'));
    writeFileSync(join(data(), 'uploads'), 'a file');
    expect((await runCli(['restore', s.zip, '--yes'], s.env.config)).code).toBe(EXIT.failed);
  });

  it('a symlinked data directory is refused', async () => {
    s = await seededInstance();
    stopServer(s.env);
    const link = join(s.work, 'datalink');
    symlinkSync(data(), link);
    const r = await runCli(['restore', s.zip, '--yes'], { ...s.env.config, dataDir: link, appDbPath: join(link, 'app.sqlite'), uploadsDir: join(link, 'uploads'), indexDbPath: join(link, 'index.sqlite') });
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toMatch(/symbolic link/);
  });

  it('not enough free space refuses with the numbers and creates nothing (no marker, no staging, no log line)', async () => {
    s = await seededInstance();
    stopServer(s.env);
    const before = treeDigest(data());
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config, { restoreHooks: { freeBytes: () => 1000 } });
    expect(r.code).toBe(EXIT.diskFull);
    expect(r.err).toMatch(/MiB needed/);
    expect(r.err).toMatch(/free in/);
    expect(treeDigest(data())).toEqual(before);
  });

  it('backup and reset-link refuse while the marker exists; so does a second restore of another file', async () => {
    s = await seededInstance();
    stopServer(s.env);
    let during: { backup: number; reset: number; other: number; msg: string } | null = null;
    const other = join(s.work, 'other.zip');
    cpSync(s.zip, other);
    writeFileSync(other, Buffer.concat([readFileSync(s.zip), Buffer.alloc(0)])); // same bytes: use a different file below
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config, {
      restoreHooks: {
        async at(p) {
          if (p !== 'marker:preRestoreDir') return;
          const b = await runCli(['backup'], s.env.config);
          const rl = await runCli(['reset-link', 'gm'], s.env.config);
          const o = await runCli(['restore', join(s.work, 'other.zip'), '--yes'], s.env.config); // same sha, but the run lock is held
          during = { backup: b.code, reset: rl.code, other: o.code, msg: b.err };
        },
      },
    });
    expect(r.code).toBe(0);
    expect(during).toMatchObject({ backup: EXIT.restoreInProgress, reset: EXIT.restoreInProgress, other: EXIT.restoreInProgress });
    expect(during!.msg).toMatch(/restore is running or was interrupted/);
    expect(during!.msg).toMatch(/run the same command again/);
  });
});

describe('concurrent restores', () => {
  it('a second restore of a DIFFERENT file gets the marker and is told what is running', async () => {
    s = await seededInstance();
    stopServer(s.env);
    const other = join(s.work, 'other.zip');
    writeFileSync(other, Buffer.concat([readFileSync(s.zip)]));
    // make it a different file (sha) that is still valid: append is not allowed in a zip, so rebuild with another database content
    const svc = openAppDb(dbPath());
    svc.$client.exec(`insert into users (id, username, display_name, password_hash) values ('u7', 'second', 'S', 'h')`);
    const r2 = await new BackupService({ db: svc, config: { ...s.env.config, backupDir: join(s.work, 'b2') }, opsLog: false, warn: () => undefined, audit: () => undefined }).create({ actor: 'x', trigger: 'cli' });
    svc.$client.close();
    const zip2 = join(s.work, r2.name);
    cpSync(join(s.work, 'b2', r2.name), zip2);
    let second: Awaited<ReturnType<typeof runCli>> | null = null;
    const first = await runCli(['restore', s.zip, '--yes'], s.env.config, {
      restoreHooks: {
        async at(p) {
          if (p === 'marker:created') second = await runCli(['restore', zip2, '--yes'], s.env.config);
        },
      },
    });
    expect(first.code).toBe(0);
    expect(second).toMatchObject({ code: EXIT.restoreInProgress });
    expect(second!.err).toMatch(/Another restore is running/);
    expect(q('select count(*) as n from users')).toEqual([{ n: 3 }]); // the first one won
  });

  it('losing the race for the marker itself (EEXIST at create) ends in "restore in progress" and removes nothing of the winner', async () => {
    s = await seededInstance();
    stopServer(s.env);
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config, {
      restoreHooks: {
        at(p) {
          if (p === 'before-marker') writeFileSync(join(data(), '.restore-in-progress'), '{"winner":true}');
        },
      },
    });
    expect(r.code).toBe(EXIT.restoreInProgress);
    expect(readFileSync(join(data(), '.restore-in-progress'), 'utf8')).toBe('{"winner":true}');
    expect(readdirSync(data()).filter((n) => n.startsWith('.restore-') && n !== '.restore-in-progress')).toEqual([]);
    expect(preRestoreDirs(data())).toEqual([]);
  });
});

describe('restore --check', () => {
  it('verifies the backup, and leaves the data directory byte-identical (no marker, no staging, no log)', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    const before = treeDigest(data());
    const r = await runCli(['restore', s.zip, '--check'], s.env.config);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/complete and restorable. Nothing was changed/);
    expect(r.out).toMatch(/3 users, 1 campaigns, 3 uploads/);
    expect(treeDigest(data())).toEqual(before);
    // works on a server that is running: it never probes
    const holder = await holdDatabase(dbPath());
    cleanups.push(() => holder.kill('SIGKILL'));
    expect((await runCli(['restore', s.zip, '--check'], s.env.config)).code).toBe(0);
  });

  it('reports a bad backup with the invalid code', async () => {
    s = await seededInstance();
    const bad = join(s.work, 'bad.zip');
    const bytes = readFileSync(s.zip);
    bytes[Math.floor(bytes.length / 2)]! ^= 0xff;
    writeFileSync(bad, bytes);
    const r = await runCli(['restore', bad, '--check'], s.env.config);
    expect(r.code).toBe(EXIT.invalidBackup);
    expect(r.err).toMatch(/not a complete Critical Notes backup/);
  });
});

describe('the migration level and hostile files', () => {
  const noChange = () => {
    expect(restoreMarkerExists(data())).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(preRestoreDirs(data())).toEqual([]);
  };

  it('a backup from a NEWER level is refused with its own code; a diverged history with another; live data untouched', async () => {
    s = await seededInstance();
    s.env.db.$client.exec(`insert into __drizzle_migrations (hash, created_at) values ('beef', 9999999999999)`);
    const r = await s.env.service({ opsLog: false }).create({ actor: 'x', trigger: 'cli' });
    const newer = join(s.work, 'newer.zip');
    cpSync(join(s.env.config.backupDir, r.name), newer);
    s.env.db.$client.exec(`delete from __drizzle_migrations where hash = 'beef'; update __drizzle_migrations set hash = 'ffff' where rowid = 2`);
    const r2 = await s.env.service({ opsLog: false }).create({ actor: 'x', trigger: 'cli' });
    const diverged = join(s.work, 'diverged.zip');
    cpSync(join(s.env.config.backupDir, r2.name), diverged);
    s.env.db.$client.exec(`update __drizzle_migrations set hash = (select hash from __drizzle_migrations where rowid = 2) where 0`);
    stopServer(s.env);
    const before = treeDigest(data(), ignoreOpsLog);
    const a = await runCli(['restore', newer, '--yes'], s.env.config);
    expect(a.code).toBe(EXIT.newerBackup);
    expect(a.err).toMatch(/newer Critical Notes/);
    const b = await runCli(['restore', diverged, '--yes'], s.env.config);
    expect(b.code).toBe(EXIT.divergedBackup);
    expect(treeDigest(data(), ignoreOpsLog)).toEqual(before);
    noChange();
  });

  it('an OLDER level is restored and migrated; a migration failure on the staged copy aborts with live data untouched', async () => {
    s = await seededInstance();
    const env = s.env;
    stopServer(env);
    // build an older instance: database at level 3
    const olderDir = join(s.work, 'older');
    mkdirSync(join(olderDir, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    writeFileSync(join(olderDir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 3) }));
    for (const e of journal.entries.slice(0, 3)) cpSync(join(MIGRATIONS_DIR, `${e.tag}.sql`), join(olderDir, `${e.tag}.sql`));
    const old = makeEnv();
    cleanups.push(() => old.cleanup());
    old.db.$client.close();
    rmSync(old.config.appDbPath, { force: true });
    rmSync(`${old.config.appDbPath}-wal`, { force: true });
    rmSync(`${old.config.appDbPath}-shm`, { force: true });
    const odb = openAppDb(old.config.appDbPath, olderDir);
    odb.$client.exec(`insert into users (id, username, display_name, password_hash) values ('o1', 'oldtimer', 'O', 'h')`);
    const svc = new BackupService({ db: odb, config: old.config, migrationsDir: olderDir, opsLog: false, warn: () => undefined, audit: () => undefined });
    const made = await svc.create({ actor: 'x', trigger: 'cli' });
    odb.$client.close();
    const olderZip = join(s.work, made.name);
    cpSync(join(old.config.backupDir, made.name), olderZip);
    const r = await runCli(['restore', olderZip, '--yes'], env.config);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Migrated 5 steps/);
    expect(q('select username from users')).toEqual([{ username: 'oldtimer' }]);
    expect(q('select count(*) as n from __drizzle_migrations')).toEqual([{ n: loadJournal().length }]);
    expect(q('select disabled_at from users')).toEqual([{ disabled_at: null }]); // a column added by a later migration
  });

  it('corrupt, truncated at several offsets, not a zip, empty: all refused (65), DATA_DIR byte-identical, nothing left behind', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    const good = readFileSync(s.zip);
    const cases: [string, Buffer][] = [
      ['flipped byte in the middle', Buffer.from(good.map((b, i) => (i === Math.floor(good.length / 2) ? b ^ 0xff : b)))],
      ['flipped byte in the database entry', Buffer.from(good.map((b, i) => (i === 3000 ? b ^ 0x55 : b)))],
      ...[10, 100, 2000, Math.floor(good.length / 3), good.length - 30, good.length - 1].map((n) => [`cut at ${n}`, good.subarray(0, n)] as [string, Buffer]),
      ['not a zip', Buffer.from('hello, this is not a backup'.repeat(50))],
      ['empty', Buffer.alloc(0)],
      ['a zip with trailing bytes', Buffer.concat([good, Buffer.from('x')])],
    ];
    const before = treeDigest(data(), ignoreOpsLog);
    for (const [what, bytes] of cases) {
      const f = join(s.work, 'case.zip');
      writeFileSync(f, bytes);
      const r = await runCli(['restore', f, '--yes'], s.env.config);
      expect(r.code, what).toBe(EXIT.invalidBackup);
      expect(treeDigest(data(), ignoreOpsLog), what).toEqual(before);
      noChange();
    }
  });

  it('hostile zips are refused before any live change: stored entry, zip-slip names, extra entry, missing checksums, entry after checksums', async () => {
    s = await seededInstance();
    stopServer(s.env);
    const staged = join(s.work, 'x');
    mkdirSync(staged);
    await readBackup(s.zip, { extractTo: staged });
    const dbBytes = readFileSync(join(staged, 'app.sqlite'));
    const manifest = JSON.parse(JSON.stringify(testManifest(dbBytes.length))) as Record<string, unknown>;
    const d = new Database(join(staged, 'app.sqlite'), { readonly: true });
    const real = readMigrationLevel(d);
    d.close();
    (manifest.database as Record<string, unknown>).migrations = real;
    const parts = { db: dbBytes, uploads: {}, manifest };
    const base = validEntries(parts);
    const variants: [string, Buffer][] = [
      ['stored database entry', rawZip(base.map((e) => (e.name === 'app.sqlite' ? { ...e, method: 0 } : e)))],
      ['zip-slip name', rawZip([...base.slice(0, 2), { name: 'uploads/../../etc/passwd', data: Buffer.from('x') }, base[2]!])],
      ['backslash name', rawZip([...base.slice(0, 2), { name: 'uploads\\..\\x', data: Buffer.from('x') }, base[2]!])],
      ['entry after checksums', rawZip([...base, { name: 'app.sqlite', data: Buffer.from('late') }])],
      ['no checksums', rawZip(base.slice(0, 2))],
      ['comment in the end record', rawZip(base, { comment: Buffer.from('hi') })],
    ];
    const before = treeDigest(data(), ignoreOpsLog);
    for (const [what, bytes] of variants) {
      const f = join(s.work, 'hostile.zip');
      writeFileSync(f, bytes);
      const r = await runCli(['restore', f, '--yes'], s.env.config);
      expect(r.code, what).toBe(EXIT.invalidBackup);
      expect(treeDigest(data(), ignoreOpsLog), what).toEqual(before);
      noChange();
    }
  });

  it('a planted trigger is refused after staging but BEFORE any live change, and it never fired (no marker row)', async () => {
    s = await seededInstance();
    stopServer(s.env);
    const staged = join(s.work, 'x');
    mkdirSync(staged);
    await readBackup(s.zip, { extractTo: staged });
    const evil = new Database(join(staged, 'app.sqlite'));
    evil.exec(`create table evil_marker (x); create trigger evil after update on api_tokens begin insert into evil_marker values (1); end;`);
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
    const before = treeDigest(data(), ignoreOpsLog);
    const r = await runCli(['restore', f, '--yes'], s.env.config);
    expect(r.code).toBe(EXIT.invalidBackup);
    expect(r.err).toMatch(/extra schema object \(table evil_marker\)/);
    expect(treeDigest(data(), ignoreOpsLog)).toEqual(before);
    noChange();
    expect(opsLog().map((e) => e.event)).toEqual(['restore.started', 'restore.aborted']);
  });
});

describe('races and rollback', () => {
  const originalState = () => treeDigest(data(), (p) => ignoreOpsLog(p) || p.startsWith('pre-restore-') || p.startsWith('.restore'));

  it('the live database replaced (different inode) between probe and swap: aborts without swapping', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    let after: Record<string, string> = {};
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config, {
      restoreHooks: {
        at(p) {
          if (p !== 'marker:staged') return;
          renameSync(dbPath(), `${dbPath()}.moved`);
          cpSync(`${dbPath()}.moved`, dbPath());
          after = treeDigest(data(), (x) => ignoreOpsLog(x) || x.startsWith('.restore'));
        },
      },
    });
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toMatch(/replaced while the restore was being prepared/);
    expect(treeDigest(data(), (x) => ignoreOpsLog(x) || x.startsWith('.restore'))).toEqual(after);
    expect(preRestoreDirs(data())).toEqual([]);
    expect(restoreMarkerExists(data())).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('a racer that creates app.sqlite + -wal + -shm after the live files were moved ends up under pre-restore/racer-*, and the install succeeds', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config, {
      restoreHooks: {
        at(p) {
          if (p !== 'done:moveUploads') return;
          for (const n of ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm']) writeFileSync(join(data(), n), `racer ${n}`);
        },
      },
    });
    expect(r.code).toBe(0);
    const pre = join(data(), preRestoreDirs(data())[0]!);
    for (const n of ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm']) {
      expect(readFileSync(join(pre, `racer-1-${n}`), 'utf8')).toBe(`racer ${n}`);
      expect(existsSync(join(pre, n)) || n.endsWith('shm') || n.endsWith('wal')).toBe(true); // the real old files are untouched by the sweep
    }
    expect(q('select count(*) as n from users')).toEqual([{ n: 3 }]);
    expect(r.err).toMatch(/racer-1/);
  });

  it('a persistent racer rolls back: uploads and the database triple are back byte for byte, staging and marker gone (exit 71)', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    const before = originalState();
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config, {
      restoreHooks: {
        at(p) {
          if (p === 'install:beforeLink') writeFileSync(join(data(), 'app.sqlite'), 'a racing database');
        },
      },
    });
    expect(r.code).toBe(EXIT.rolledBack);
    expect(r.err).toMatch(/Rolling back/);
    // the racer's file is kept aside, everything of ours is back
    const pre = readdirSync(data()).filter((n) => n.startsWith('pre-restore-'));
    expect(pre.length).toBeLessThanOrEqual(1);
    if (pre[0]) expect(readdirSync(join(data(), pre[0])).sort()).toEqual(['racer-1-app.sqlite']);
    expect(originalState()).toEqual(before);
    expect(restoreMarkerExists(data())).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(opsLog().map((e) => e.event)).toEqual(['restore.started', 'restore.aborted']);
    expect(opsLog()[1]).toMatchObject({ reason: 'rolled back' });
    // and a later restore, without the racer, works
    expect((await runCli(['restore', s.zip, '--yes'], s.env.config)).code).toBe(0);
  });

  it('a rollback after a crashed writer left a hot WAL brings back the same data (SQLite merged the committed frames once, which is not a change)', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    await killAndWait(await holdDatabase(dbPath()));
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config, {
      restoreHooks: {
        at(p) {
          if (p === 'install:beforeLink') writeFileSync(join(data(), 'app.sqlite'), 'a racing database');
        },
      },
    });
    expect(r.code).toBe(EXIT.rolledBack);
    expect(q('select x from held_probe')).toEqual([{ x: 1 }]);
    expect(q("select username from users where id = 'u9'")).toEqual([{ username: 'newcomer' }]);
    expect(existsSync(join(data(), 'uploads', upId(9)))).toBe(true);
    expect(restoreMarkerExists(data())).toBe(false);
  });

  it('a -wal that appears next to the freshly installed database rolls back too, removing the installed file', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    const before = originalState();
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config, {
      restoreHooks: {
        at(p) {
          if (p === 'install:afterLink') writeFileSync(join(data(), 'app.sqlite-wal'), 'a late wal');
        },
      },
    });
    expect(r.code).toBe(EXIT.rolledBack);
    expect(originalState()).toEqual(before);
    expect(restoreMarkerExists(data())).toBe(false);
  });

  it('a rollback that cannot finish leaves the marker with the manual instructions (77); running again retries the rollback only', async () => {
    s = await seededInstance();
    changeLive(s.env);
    stopServer(s.env);
    const before = originalState();
    const r = await runCli(['restore', s.zip, '--yes'], s.env.config, {
      restoreHooks: {
        at(p) {
          if (p === 'install:beforeLink') writeFileSync(join(data(), 'app.sqlite'), 'racer');
          if (p === 'rollback:marker:liveBack') writeFileSync(join(data(), 'app.sqlite'), 'late racer'); // something stands where the old file must go
        },
      },
    });
    expect(r.code).toBe(EXIT.rollbackFailed);
    expect(r.err).toMatch(/Rollback FAILED/);
    expect(r.err).toMatch(/pre-restore-/);
    expect(readRestoreMarker(data())).toMatchObject({ rollingBack: { failed: true } });
    // the server is refused, backup is refused
    expect((await runCli(['backup'], s.env.config)).code).toBe(EXIT.restoreInProgress);
    // a human removes the late racer; the same command continues the ROLLBACK, whatever the file is
    rmSync(join(data(), 'app.sqlite'));
    const again = await runCli(['restore', s.zip, '--yes'], s.env.config);
    expect(again.code).toBe(EXIT.rolledBack);
    expect(originalState()).toEqual(before);
    expect(restoreMarkerExists(data())).toBe(false);
  });
});

describe('CLI backup (design 10, 11)', () => {
  it('prints only the path of the zip; trigger cli; the audit line, the notes and the starvation warning go to stderr; operations log', async () => {
    s = await seededInstance();
    const r = await runCli(['backup'], s.env.config);
    expect(r.code).toBe(0);
    expect(r.out.split('\n')).toHaveLength(1);
    expect(r.out).toMatch(/backup-\d{8}T\d{6}Z\.zip$/);
    expect(existsSync(r.out)).toBe(true);
    expect(statSync(r.out).mode & 0o777).toBe(0o600);
    const res = await readBackup(r.out);
    expect(res.manifest.trigger).toBe('cli');
    expect(r.err).toMatch(/"event":"backup.created"/);
    expect(r.err).toMatch(/can be restarted again and again/);
    expect(r.err).toMatch(/treat it like the database/);
    expect(r.out).not.toMatch(/event/);
    expect(opsLog()).toMatchObject([{ event: 'backup.created', trigger: 'cli', actor: expect.any(String) }]);
    // the live database was not migrated or changed by making the backup, and the server's connection still works
    expect(s.env.db.$client.prepare('select count(*) as n from users').get()).toEqual({ n: 3 });
  });

  it('prunes with BACKUP_KEEP and trigger cli (an unrestricted prune)', async () => {
    s = await seededInstance();
    const cfg = { ...s.env.config, backupKeep: 2 };
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      // names are timestamps in seconds: age the earlier ones so each gets its own name
      const r = await runCli(['backup'], cfg);
      expect(r.code).toBe(0);
      names.push(r.out);
      for (const f of readdirSync(cfg.backupDir).filter((n) => /^backup-/.test(n))) {
        const old = new Date(Date.now() - 1000);
        utimesSync(join(cfg.backupDir, f), old, old);
      }
      await new Promise((res) => setTimeout(res, 1100));
    }
    const zips = readdirSync(cfg.backupDir).filter((n) => /^backup-.*\.zip$/.test(n));
    // seededInstance made one more backup (trigger cli) before: keep = 2 leaves exactly two
    expect(zips).toHaveLength(2);
    expect(existsSync(names[2]!)).toBe(true);
  }, 30_000);

  it('a backup that is already running gives its own exit code (76); a leftover fresh lock counts as running', async () => {
    s = await seededInstance();
    mkdirSync(s.env.config.backupDir, { recursive: true });
    writeFileSync(join(s.env.config.backupDir, '.lock'), JSON.stringify({ pid: 1, startedAt: 'x', nonce: 'n' }));
    const r = await runCli(['backup'], s.env.config);
    expect(r.code).toBe(EXIT.backupBusy);
    expect(r.err).toMatch(/already running/);
  });

  it('a missing database is exit 3; arguments are a usage error', async () => {
    s = await seededInstance();
    expect((await runCli(['backup', 'now'], s.env.config)).code).toBe(EXIT.usage);
    stopServer(s.env);
    rmSync(dbPath());
    expect((await runCli(['backup'], s.env.config)).code).toBe(EXIT.notFound);
  });

  it('exit codes are all distinct', () => {
    const values = Object.values(EXIT);
    expect(new Set(values).size).toBe(values.length);
  });
});
