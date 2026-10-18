/**
 * File-system parts of the backup service: `BACKUP_DIR` validation (docs/design/backup.md 11) and the cross-process
 * lock with atomic stale takeover.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { link, open, readFile, rename, stat, unlink, utimes } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { AppConfig } from '../config';

export type BackupErrorCode = 'busy' | 'api-cap' | 'disk' | 'restore-in-progress' | 'db-timeout' | 'too-many-files' | 'not-found' | 'invalid-dir' | 'dir-not-writable';

/** A refusal the callers map to a status: 409 busy / api-cap / restore-in-progress, 507 disk, 404 not-found. */
export class BackupError extends Error {
  constructor(
    readonly code: BackupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BackupError';
  }
  get httpStatus(): 404 | 409 | 500 | 507 {
    switch (this.code) {
      case 'busy':
      case 'api-cap':
      case 'restore-in-progress':
        return 409;
      case 'disk':
        return 507;
      case 'not-found':
        return 404;
      default:
        return 500;
    }
  }
}

/** `realpath` of the path, or of its nearest existing ancestor plus the missing tail. */
function realpathLoose(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

const isInside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

export type BackupDirConfig = Pick<AppConfig, 'backupDir' | 'dataDir' | 'webDistDir' | 'uploadsDir' | 'fivetoolsSrcPath' | 'fivetoolsImgPath'>;

/**
 * Resolves and checks `BACKUP_DIR` (default `DATA_DIR/backups`). Refuses (throws `BackupError('invalid-dir')`) a directory
 * that equals or lies inside the web build, the uploads, the 5etools paths, or that IS the data directory, and a
 * world-writable one. A mode wider than 0700 on an existing directory is returned as a warning.
 * Called when the service is constructed, so a bad setting stops the server (and the CLI) at startup.
 */
export function validateBackupDir(cfg: BackupDirConfig): { dir: string; warnings: string[] } {
  const dir = realpathLoose(cfg.backupDir);
  if (dir === realpathLoose(cfg.dataDir)) throw new BackupError('invalid-dir', 'BACKUP_DIR must not be the data directory itself; use a subdirectory or another volume');
  const protectedPaths: [string, string][] = [
    ['the web build (WEB_DIST_DIR)', cfg.webDistDir],
    ['the uploads directory', cfg.uploadsDir],
    ['the 5etools data (FIVETOOLS_SRC_PATH)', cfg.fivetoolsSrcPath],
    ['the 5etools images (FIVETOOLS_IMG_PATH)', cfg.fivetoolsImgPath],
  ];
  for (const [what, p] of protectedPaths) {
    const real = realpathLoose(p);
    if (isInside(dir, real)) throw new BackupError('invalid-dir', `BACKUP_DIR must not be ${what} or inside it`);
    if (isInside(real, dir)) throw new BackupError('invalid-dir', `BACKUP_DIR must not contain ${what}`);
  }
  if (isInside(realpathLoose(cfg.dataDir), dir)) throw new BackupError('invalid-dir', 'BACKUP_DIR must not contain the data directory');
  const warnings: string[] = [];
  if (existsSync(dir)) {
    const st = statSync(dir);
    if (!st.isDirectory()) throw new BackupError('invalid-dir', 'BACKUP_DIR is not a directory');
    if (st.mode & 0o002) throw new BackupError('invalid-dir', 'BACKUP_DIR is world-writable; backups contain every password hash and secret (chmod o-w)');
    if (st.mode & 0o077) warnings.push(`BACKUP_DIR ${dir} is accessible to other users (mode ${(st.mode & 0o7777).toString(8)}); 0700 is recommended`);
  }
  return { dir, warnings };
}

/** Errors that mean "this user may not write there". */
export const NOT_WRITABLE_CODES = ['EACCES', 'EPERM', 'EROFS'];

/** The one sentence for an unwritable backup folder: names the owner fix for Docker (uid 1000) and for a bare install. */
export function notWritableMessage(dir: string): string {
  const uid = process.getuid?.() ?? 'unknown';
  return `The backup folder ${dir} is not writable by this user (uid ${uid}). Fix the owner: chown 1000:1000 ${dir} (Docker: docker compose run --rm --user root app chown 1000:1000 ${dir}; the folder must be a volume or bind mount of the app service), or the mount is read-only (remove :ro or remount it read-write), or on a bare install make it writable for this user (chown $(id -u):$(id -g) ${dir}), or point BACKUP_DIR at another folder`;
}

/**
 * Proves the app user can create and write in the backup directory: creates it (0700) when missing, then creates, writes and
 * removes a temporary file. Throws `BackupError('dir-not-writable')` with `notWritableMessage`. Nothing is left behind; on a
 * refusal nothing was created except what `mkdir` managed before the failing step. Run after `validateBackupDir`.
 */
export function assertBackupDirWritable(dir: string): void {
  const refuse = (e: unknown): never => {
    if (NOT_WRITABLE_CODES.includes((e as NodeJS.ErrnoException)?.code ?? '')) throw new BackupError('dir-not-writable', notWritableMessage(dir));
    throw e;
  };
  try {
    ensureBackupDir(dir);
  } catch (e) {
    refuse(e);
  }
  const probe = join(dir, `.write-test-${randomBytes(6).toString('hex')}`);
  try {
    const fd = openSync(probe, 'wx', 0o600);
    try {
      writeSync(fd, 'ok');
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    refuse(e);
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      // never created, or already gone
    }
  }
}

/** Creates the backup directory with mode 0700 (independent of the umask) when it does not exist yet. */
export function ensureBackupDir(dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export interface LockOptions {
  /** Test seam: runs after a stale lock was seen and before it is renamed away (a racing taker can strike here). */
  beforeTakeover?: () => void | Promise<void>;
  /** A lock whose mtime is older than this is stale (default 2 minutes). */
  staleMs?: number;
  /** How often the holder touches the lock (default 15 s). */
  heartbeatMs?: number;
}

/**
 * `backups/.lock`, created with `O_EXCL`, holding the start time and pid; the holder touches its mtime every 15 s. A lock
 * older than 2 minutes is stale (no pid check: pids mean nothing across containers). Takeover: the taker renames
 * the stale lock away (only one racing taker succeeds), checks that what it renamed really was stale (a live one is linked
 * back), and only then creates its own. A microsecond window remains between that rename and the put-back; within one
 * process the in-process flag covers it.
 */
export class BackupLock {
  private readonly path: string;
  private readonly staleMs: number;
  private readonly heartbeatMs: number;
  private nonce = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(
    dir: string,
    private readonly opts: LockOptions = {},
  ) {
    this.path = join(dir, '.lock');
    this.staleMs = opts.staleMs ?? 120_000;
    this.heartbeatMs = opts.heartbeatMs ?? 15_000;
  }

  /** True when a fresh lock exists (held by anyone). */
  async isHeld(): Promise<boolean> {
    try {
      return Date.now() - (await stat(this.path)).mtimeMs <= this.staleMs;
    } catch {
      return false;
    }
  }

  async acquire(): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const nonce = randomBytes(8).toString('hex');
        const fh = await open(this.path, 'wx', 0o600);
        try {
          await fh.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), nonce }));
        } finally {
          await fh.close();
        }
        this.nonce = nonce;
        this.timer = setInterval(() => void utimes(this.path, new Date(), new Date()).catch(() => undefined), this.heartbeatMs);
        this.timer.unref();
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      let mtime: number;
      try {
        mtime = (await stat(this.path)).mtimeMs;
      } catch {
        continue; // released between our attempts
      }
      if (Date.now() - mtime <= this.staleMs) throw new BackupError('busy', 'A backup is already running');
      await this.opts.beforeTakeover?.();
      const aside = `${this.path}.stale-${randomBytes(6).toString('hex')}`;
      try {
        await rename(this.path, aside);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // another taker won the race
        throw e;
      }
      // Between our stat and the rename someone may have replaced the stale lock with a live one
      const renamed = await stat(aside).catch(() => null);
      if (renamed && Date.now() - renamed.mtimeMs <= this.staleMs) {
        await link(aside, this.path).catch(() => undefined); // put it back if the slot is still free
        await unlink(aside).catch(() => undefined);
        throw new BackupError('busy', 'A backup is already running');
      }
      await unlink(aside).catch(() => undefined);
    }
    throw new BackupError('busy', 'A backup is already running');
  }

  /** Synchronous, never throws: for a process that is about to exit. Removes the lock only when it is still ours (same nonce check). */
  releaseSync(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      const held = JSON.parse(readFileSync(this.path, 'utf8')) as { nonce?: string };
      if (this.nonce && held.nonce === this.nonce) unlinkSync(this.path);
    } catch {
      // gone already or not ours
    }
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      const held = JSON.parse(await readFile(this.path, 'utf8')) as { nonce?: string };
      if (held.nonce === this.nonce) await unlink(this.path);
    } catch {
      // gone already, or taken over after a very long stall: not ours to delete
    }
  }
}
