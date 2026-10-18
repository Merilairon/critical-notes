import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAdmin } from '../src/cli/run';
import { EXIT } from '../src/cli/errors';
import { FAILURE_TEXT } from '../src/routes/backups';
import { assertBackupDirWritable, BackupError } from '../src/services/backups';
import { makeEnv, type BackupEnv } from './backup-helpers';

// Root ignores permission bits, so these cases only mean something for an ordinary user (CI and Docker run as `node`)
const asRoot = process.getuid?.() === 0;
const SERVER_ROOT = join(import.meta.dirname, '..');
let env: BackupEnv;
let scratch: string;
beforeEach(() => {
  env = makeEnv();
  scratch = mkdtempSync(join(tmpdir(), 'cn-bdw-'));
});
afterEach(() => {
  for (const d of [env.root, scratch]) {
    try {
      chmodSync(d, 0o700);
      for (const n of readdirSync(d)) chmodSync(join(d, n), 0o700);
    } catch {
      // gone
    }
  }
  env.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

const notWritable = (dir: string) => {
  try {
    assertBackupDirWritable(dir);
  } catch (e) {
    return e;
  }
  return null;
};

describe.skipIf(asRoot)('assertBackupDirWritable', () => {
  it('creates a missing directory with mode 0700 and leaves no probe file behind', () => {
    const dir = join(scratch, 'a', 'b');
    assertBackupDirWritable(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir)).toEqual([]);
    assertBackupDirWritable(dir); // an existing, writable one is fine too
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a read-only directory (and a root-owned one, simulated with chmod) with the fix in the message', () => {
    for (const mode of [0o500, 0o555, 0o000]) {
      const dir = join(scratch, `ro-${mode.toString(8)}`);
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, mode);
      const e = notWritable(dir);
      expect(e, mode.toString(8)).toBeInstanceOf(BackupError);
      expect((e as BackupError).code).toBe('dir-not-writable');
      const msg = (e as BackupError).message;
      expect(msg).toContain(`The backup folder ${dir} is not writable by this user (uid ${process.getuid!()}).`);
      expect(msg).toContain(`Fix the owner: chown 1000:1000 ${dir}`);
      expect(msg).toContain('docker compose run --rm --user root app chown 1000:1000');
      chmodSync(dir, 0o700);
      expect(readdirSync(dir), 'no probe file left').toEqual([]);
    }
  });

  it('refuses a missing directory whose parent is read-only, and creates nothing', () => {
    const parent = join(scratch, 'parent');
    mkdirSync(parent, { mode: 0o500 });
    chmodSync(parent, 0o500);
    const e = notWritable(join(parent, 'backups'));
    expect((e as BackupError).code).toBe('dir-not-writable');
    chmodSync(parent, 0o700);
    expect(readdirSync(parent)).toEqual([]);
  });

  it('does not swallow other errors as "not writable"', () => {
    const file = join(scratch, 'plain-file');
    writeFileSync(file, 'x');
    const e = notWritable(join(file, 'sub')); // ENOTDIR
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(BackupError);
  });
});

describe.skipIf(asRoot)('BackupService with a folder that is not writable', () => {
  it('the constructor refuses at once (server start and CLI both build the service)', () => {
    const dir = env.config.backupDir;
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o500);
    expect(() => env.service()).toThrow(/is not writable by this user/);
  });

  it('EACCES while backing up becomes dir-not-writable: readable error, stable code, fixed sentence for the list', async () => {
    const service = env.service();
    chmodSync(env.config.backupDir, 0o500); // changed after start (a volume re-mounted, a chown)
    const err = await service.create({ actor: 'u1', trigger: 'api' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect((err as BackupError).code).toBe('dir-not-writable');
    expect((err as BackupError).message).toContain('chown 1000:1000');
    expect(service.status().lastErrorCode).toBe('dir-not-writable');
    expect(service.isRunning()).toBe(false);
    expect(FAILURE_TEXT['dir-not-writable']).toMatch(/may not write in the backup folder/);
    expect(FAILURE_TEXT['dir-not-writable']).not.toMatch(/\//); // a fixed sentence: no path
    chmodSync(env.config.backupDir, 0o700);
    expect(readdirSync(env.config.backupDir)).toEqual([]);
  });
});

describe.skipIf(asRoot)('admin backup (CLI)', () => {
  it('exits with its own code and the message, and creates nothing', async () => {
    const dir = join(scratch, 'ro');
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o500);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runAdmin(['backup'], { config: { ...env.config, backupDir: dir }, out: (t) => out.push(t), err: (t) => err.push(t) });
    expect(code).toBe(EXIT.dirNotWritable);
    expect(EXIT.dirNotWritable).toBe(73);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain(`The backup folder ${dir} is not writable by this user`);
    chmodSync(dir, 0o700);
    expect(readdirSync(dir)).toEqual([]);
    expect(readdirSync(env.config.dataDir).filter((n) => n === 'restore-log.jsonl')).toEqual([]);
  });
});

describe.skipIf(asRoot)('the server process', () => {
  const start = (dataDir: string, extra: Record<string, string>) =>
    spawnSync(process.execPath, ['--import', 'tsx', join(SERVER_ROOT, 'src', 'main.ts')], {
      cwd: SERVER_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, CN_SKIP_DOTENV: '1', DATA_DIR: dataDir, PORT: '0', FIVETOOLS_SRC_PATH: join(dataDir, 'nope'), FIVETOOLS_IMG_PATH: join(dataDir, 'nope2'), BACKUP_EVERY_HOURS: '24', ...extra },
    });

  it('refuses to start at once with the fix in the message, and creates nothing', () => {
    const data = join(scratch, 'data');
    mkdirSync(data);
    const ro = join(scratch, 'ro');
    mkdirSync(ro, { mode: 0o700 });
    chmodSync(ro, 0o500);
    const r = start(data, { BACKUP_DIR: ro });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain(`Refusing to start: The backup folder ${ro} is not writable by this user`);
    expect(r.stderr).toContain(`chown 1000:1000 ${ro}`);
    expect(readdirSync(data), 'nothing created in the data directory').toEqual([]);
    chmodSync(ro, 0o700);
    expect(readdirSync(ro)).toEqual([]);
  }, 90_000);

  it('a missing BACKUP_DIR under a read-only parent also refuses and creates nothing', () => {
    const data = join(scratch, 'data');
    mkdirSync(data);
    const parent = join(scratch, 'parent');
    mkdirSync(parent, { mode: 0o700 });
    chmodSync(parent, 0o500);
    const r = start(data, { BACKUP_DIR: join(parent, 'backups') });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Refusing to start: The backup folder .* is not writable/);
    chmodSync(parent, 0o700);
    expect(readdirSync(parent)).toEqual([]);
    expect(readdirSync(data)).toEqual([]);
  }, 90_000);

  it('the restore marker is still checked first: its message wins over the writability one', () => {
    const data = join(scratch, 'data');
    mkdirSync(data);
    writeFileSync(join(data, '.restore-in-progress'), '{torn');
    const ro = join(scratch, 'ro');
    mkdirSync(ro, { mode: 0o700 });
    chmodSync(ro, 0o500);
    const r = start(data, { BACKUP_DIR: ro });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/restore is running or was interrupted/);
    expect(r.stderr).not.toMatch(/not writable/);
    expect(existsSync(join(data, 'app.sqlite'))).toBe(false);
  }, 90_000);
});
