/**
 * `node dist/admin.mjs restore <file> [--check] [--yes] [--keep-tokens] [--no-carry-restrictions]` (Task M3.3,
 * docs/design/backup.md 7 and 8). The zip reading, the staged database checks and the carry-over are the M3.2 building
 * blocks (`readBackup`, `prepareRestoredDatabase`, `probeStopped`); this file owns the marker, the staging directory, the swap,
 * the rollback and the report.
 *
 * The invariant that makes it crash-safe: every step is written to the marker (`next`) BEFORE it runs, and every step
 * decides "already done?" by looking at the file system, so running the same command again finishes an interrupted
 * restore. A marker with `rollingBack` is only ever continued as a rollback.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsc, lchownSync, rmSync, statSync } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, stat, statfs, unlink } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import type { AppConfig } from '../config';
import { appendOpsLog } from '../lib/ops-log';
import {
  LIVE_DB_NAMES,
  PRE_RESTORE_NAME_RE,
  readRestoreMarker,
  restoreBlockedMessage,
  restoreMarkerPath,
  type RestoreMarker,
  type RollbackStep,
} from '../lib/restore-marker';
import {
  BackupZipError,
  compareMigrationRows,
  DIVERGED_MESSAGE,
  isDamagedDatabaseError,
  loadJournal,
  prepareRestoredDatabase,
  probeStopped,
  readBackup,
  RestoreRefusal,
  ServerRunningError,
  type Manifest,
  type PrepareReport,
  type StoppedProbe,
} from '../services/backups';
import { BackupZip, MAX_MANIFEST_BYTES, parseManifest, RATIO_LIMIT, safeText } from '../services/backup-zip';
import { adminCommandInline, START_SERVER_HINT } from '../lib/admin-hints';
import { CliError, EXIT } from './errors';

const MiB = 1024 * 1024;

export interface RestoreFlags {
  check: boolean;
  yes: boolean;
  keepTokens: boolean;
  carryRestrictions: boolean;
}

export const KEEP_TOKENS_WARNING =
  'WARNING: --keep-tokens makes every API token and invite link that was valid when the backup was made active again, including any that were revoked later because of a compromise.';

/** Parses `restore <file> [--check] [--yes] [--keep-tokens] [--no-carry-restrictions]`. */
export function parseRestoreArgs(args: string[]): { file: string } & RestoreFlags {
  const flags: RestoreFlags = { check: false, yes: false, keepTokens: false, carryRestrictions: true };
  const files: string[] = [];
  for (const a of args) {
    if (a === '--check') flags.check = true;
    else if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--keep-tokens') flags.keepTokens = true;
    else if (a === '--no-carry-restrictions') flags.carryRestrictions = false;
    else if (a.startsWith('-')) throw new CliError(`Unknown option ${safeText(a)}.\n${RESTORE_USAGE}`, EXIT.usage);
    else files.push(a);
  }
  if (files.length !== 1 || !files[0]) throw new CliError(`Usage: ${RESTORE_USAGE}`, EXIT.usage);
  if (flags.keepTokens && !flags.yes && !flags.check) throw new CliError(`${KEEP_TOKENS_WARNING}\nIt is only accepted together with --yes.`, EXIT.usage);
  return { file: files[0], ...flags };
}

export const RESTORE_USAGE = 'restore <backup.zip> [--check] [--yes] [--keep-tokens] [--no-carry-restrictions]';

export interface RestoreHooks {
  /**
   * Called at named points: `marker:<step>` right after the marker recorded the step and `done:<step>` after it ran (the same for
   * `rollback:marker:<step>` / `rollback:done:<step>`), plus `install:beforeLink`, `install:afterLink`, `stage:extracted`,
   * `probe:acquired`, `marker:created`, `before-marker`. Tests kill the process or inject a racing process here.
   */
  at?: (point: string) => void | Promise<void>;
  /** Free bytes on the data directory's file system (default: `statfs`). */
  freeBytes?: () => number;
}

export interface RestoreEnv {
  config: AppConfig;
  /** Diagnostics (stderr). */
  info: (msg: string) => void;
  /** Asks a yes/no question on the terminal; undefined when there is no terminal. */
  confirm?: (question: string) => Promise<boolean>;
  now?: () => number;
  user?: { uid: number; name: string };
  hooks?: RestoreHooks;
  isRoot?: boolean;
  chown?: (path: string, uid: number, gid: number) => void;
  migrationsDir?: string;
  /** Test seam for the install's hard link. */
  linkFn?: typeof link;
}

/** The install found a racing process: undo the swap (design 8, rollback). */
class RollbackNeeded extends Error {}

export function fmtBytes(n: number): string {
  if (n >= 1024 * MiB) return `${(n / (1024 * MiB)).toFixed(1)} GiB`;
  if (n >= MiB) return `${(n / MiB).toFixed(1)} MiB`;
  return `${Math.max(0, Math.round(n / 1024))} KiB`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};

const lstatOrNull = (p: string) => lstat(p).catch(() => null);
const exists = async (p: string) => (await lstatOrNull(p)) !== null;

async function fsyncPath(p: string): Promise<void> {
  const fh = await open(p, fsc.O_RDONLY | fsc.O_DIRECTORY).catch(() => null);
  if (!fh) return;
  try {
    await fh.sync();
  } catch {
    // some file systems refuse fsync on a directory
  } finally {
    await fh.close();
  }
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      h.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

async function dirSize(path: string): Promise<number> {
  let total = 0;
  const st = await lstatOrNull(path);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  for (const name of await readdir(path)) total += await dirSize(join(path, name));
  return total;
}

/** Atomic marker write: temp file, fsync, rename over the marker, fsync of the directory (no torn JSON after a kill). */
async function writeMarkerAtomic(dataDir: string, m: RestoreMarker): Promise<void> {
  const tmp = join(dataDir, `.restore-in-progress.tmp-${randomBytes(6).toString('hex')}`);
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(JSON.stringify(m));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, restoreMarkerPath(dataDir));
  await fsyncPath(dataDir);
}

/** Creates the marker only if none exists (`O_EXCL` semantics through a no-clobber `link()` of a fully written file, so it is never empty or torn). */
async function createMarkerExclusive(dataDir: string, m: RestoreMarker): Promise<boolean> {
  const marker = restoreMarkerPath(dataDir);
  const tmp = join(dataDir, `.restore-in-progress.tmp-${randomBytes(6).toString('hex')}`);
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(JSON.stringify(m));
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    try {
      await link(tmp, marker);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      if (!['EPERM', 'ENOTSUP', 'EXDEV', 'EMLINK'].includes(code ?? '')) throw e;
      // a file system without hard links: plain O_EXCL create
      try {
        const f = await open(marker, 'wx', 0o600);
        try {
          await f.writeFile(JSON.stringify(m));
          await f.sync();
        } finally {
          await f.close();
        }
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw e2;
      }
    }
    await fsyncPath(dataDir);
    return true;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/** Only one restore process at a time: an exclusive SQLite lock on a small file (released by the kernel when the process dies, however it dies). */
function acquireRunLock(dataDir: string): { release(): void } {
  const path = join(dataDir, '.restore.lock');
  const db = new Database(path, { timeout: 200 });
  try {
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('begin exclusive');
  } catch (e) {
    db.close();
    if ((e as { code?: string }).code === 'SQLITE_BUSY') throw new CliError('Another restore is running right now (the data directory is locked by it).', EXIT.restoreInProgress);
    throw e;
  }
  return {
    release() {
      try {
        db.close();
      } finally {
        rmSyncQuiet(path);
      }
    },
  };
}
function rmSyncQuiet(p: string) {
  rmSync(p, { force: true });
}

export function mapRestoreError(e: unknown, claimedVersion?: string): CliError {
  if (e instanceof CliError) return e;
  if (e instanceof ServerRunningError) return new CliError(`${e.message}`, EXIT.serverRunning);
  if (e instanceof BackupZipError) {
    const code = e.code === 'too-new' ? EXIT.newerBackup : EXIT.invalidBackup;
    return new CliError(e.code === 'invalid' ? `${e.message}. Nothing was changed.` : `${e.message}. Nothing was changed.`, code);
  }
  if (e instanceof RestoreRefusal) {
    const code = e.code === 'newer' ? EXIT.newerBackup : e.code === 'different' ? EXIT.divergedBackup : EXIT.invalidBackup;
    const claim = e.code === 'different' && claimedVersion ? ` (the backup claims it was made by Critical Notes ${safeText(claimedVersion)}; that is the backup's own statement)` : '';
    return new CliError(`${e.message}${claim}. Nothing was changed.`, code);
  }
  if ((e as NodeJS.ErrnoException)?.code === 'ENOSPC') return new CliError('Out of disk space while restoring. Free space and run the same command again. The live data was not changed.', EXIT.diskFull);
  return new CliError(`Failed: ${e instanceof Error ? e.message : String(e)}`, EXIT.failed);
}

interface Preflight {
  realFile: string;
  sha256: string;
  size: number;
  manifest: Manifest;
  declared: number;
}

class Restore {
  private readonly dataDir: string;
  private readonly uploads: string;
  private readonly now: () => number;
  private readonly user: { uid: number; name: string };
  private m!: RestoreMarker;
  private probe: StoppedProbe | null = null;
  private liveReadable = true;
  private liveStat: { dev: number; ino: number } | null = null;
  private pf!: Preflight;

  constructor(
    private readonly a: { file: string } & RestoreFlags,
    private readonly env: RestoreEnv,
  ) {
    this.dataDir = env.config.dataDir;
    this.uploads = env.config.uploadsDir;
    this.now = env.now ?? Date.now;
    const uid = process.getuid?.() ?? -1;
    this.user = env.user ?? { uid, name: safeName(uid) };
  }

  private info = (m: string) => this.env.info(m);
  private hook = async (point: string) => {
    await this.env.hooks?.at?.(point);
  };
  private path = (name: string) => join(this.dataDir, name);
  private get staging() {
    return this.path(this.m.staging);
  }
  private get pre() {
    return this.path(this.m.preRestore);
  }

  private async mark(patch: Partial<RestoreMarker>): Promise<void> {
    Object.assign(this.m, patch);
    await writeMarkerAtomic(this.dataDir, this.m);
  }

  private async step(next: string, fn: () => Promise<void>): Promise<void> {
    await this.mark({ next });
    await this.hook(`marker:${next}`);
    await fn();
    await this.hook(`done:${next}`);
  }

  private opsLog(event: 'restore.started' | 'restore.completed' | 'restore.aborted', extra: Record<string, unknown> = {}) {
    try {
      appendOpsLog(
        this.dataDir,
        event,
        {
          backup: this.m.zip.name,
          zipSha256: this.m.zip.sha256,
          keepTokens: this.m.flags.keepTokens,
          carryRestrictions: this.m.flags.carryRestrictions,
          liveCompared: (this.m.report as { prepare?: PrepareReport } | undefined)?.prepare?.carry.liveCompared ?? null,
          uid: this.user.uid,
          user: this.user.name,
          phase: this.m.phase,
          ...extra,
        },
        this.now(),
      );
    } catch (e) {
      this.info(`Could not write ${this.dataDir}/restore-log.jsonl: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // region Entry

  async run(): Promise<string> {
    if (this.a.check) return this.runCheck();
    await this.checkLayout(true);
    const peek = readRestoreMarker(this.dataDir);
    if (peek === 'unreadable') throw new CliError(restoreBlockedMessage(this.dataDir), EXIT.restoreInProgress);
    // Fail early (before any file is staged) when nothing can confirm. A swap already under way is a commitment: no prompt.
    if (!peek?.rollingBack && !this.a.yes && !this.env.confirm && peek?.phase !== 'swapping') {
      throw new CliError('There is no terminal to ask for confirmation. Run it again with --yes to restore without a prompt (use --check first to verify the backup).', EXIT.usage);
    }
    await this.sweepStale(false);
    // Only a hint to skip the work below: the decision is made on the marker read again UNDER the lock
    if (!peek?.rollingBack) this.pf = await this.preflight();
    await this.hook('before-lock');
    const lock = acquireRunLock(this.dataDir);
    try {
      await this.sweepStale(true);
      const existing = readRestoreMarker(this.dataDir);
      if (existing === 'unreadable') throw new CliError(restoreBlockedMessage(this.dataDir), EXIT.restoreInProgress);
      if (existing?.rollingBack) return await this.continueRollbackOnly(existing);
      this.pf ??= await this.preflight();
      if (existing && existing.zip.sha256 !== this.pf.sha256) {
        throw new CliError(`${restoreBlockedMessage(this.dataDir)}\n  This backup file is not the one that restore was started with, so it cannot continue with it.`, EXIT.restoreInProgress);
      }
      if (!existing || existing.phase === 'started') await this.checkSpace(); // before any marker or staging exists
      return await this.runLocked(existing);
    } finally {
      lock.release();
    }
  }

  /** Leftovers that hold the report or a half-written marker: nothing else may be running (called under the lock, or for old check folders only). */
  private async sweepStale(underLock: boolean): Promise<void> {
    const base = (await exists(this.dataDir)) ? this.dataDir : null;
    if (!base) return;
    for (const n of await readdir(base).catch(() => [] as string[])) {
      if (underLock && n.startsWith('.restore-in-progress.tmp-')) await rm(join(base, n), { force: true }).catch(() => undefined);
      if (n.startsWith('.restore-check-')) {
        const st = await lstatOrNull(join(base, n));
        if (st && Date.now() - st.mtimeMs > 3600_000) await rm(join(base, n), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async runLocked(existing: RestoreMarker | null): Promise<string> {
    let createdMarker = false;
    if (existing) {
      this.m = existing;
      this.m.resumes = (this.m.resumes ?? 0) + 1;
      this.info(`Continuing the interrupted restore of ${this.m.zip.name} (it stopped at "${this.m.next}").`);
      if (this.m.phase !== 'started' && (this.m.flags.keepTokens !== this.a.keepTokens || this.m.flags.carryRestrictions !== this.a.carryRestrictions)) {
        this.info('The staged restore keeps the options it was started with (--keep-tokens, --no-carry-restrictions).');
      }
    } else {
      const ts = stamp(this.now());
      let suffix = '';
      for (let k = 1; (await exists(this.path(`.restore-${ts}${suffix}`))) || (await exists(this.path(`pre-restore-${ts}${suffix}`))); k++) suffix = `-${k}`;
      this.m = {
        v: 1,
        startedAt: new Date(this.now()).toISOString(),
        user: this.user,
        zip: { name: safeText(basename(this.pf.realFile)), sha256: this.pf.sha256, size: this.pf.size },
        staging: `.restore-${ts}${suffix}`,
        preRestore: `pre-restore-${ts}${suffix}`,
        flags: { keepTokens: this.a.keepTokens, carryRestrictions: this.a.carryRestrictions },
        phase: 'started',
        next: 'stage',
        liveMoved: null,
        uploadsLive: null,
      };
      await this.hook('before-marker');
      // Created BEFORE the probe (design 7.1): from here on a starting server sees it and exits
      if (!(await createMarkerExclusive(this.dataDir, this.m))) throw new CliError(restoreBlockedMessage(this.dataDir), EXIT.restoreInProgress);
      createdMarker = true;
      await this.hook('marker:created');
    }
    this.opsLog('restore.started', existing ? { resumed: true } : {});

    try {
      await this.acquireProbe();
      if (this.m.phase === 'started') await this.stagePhase();
      else if (this.m.phase === 'staged' && !(await this.stagedIntact())) {
        if (this.m.liveMoved !== null) throw new Error('The staged files are missing');
        await this.mark({ phase: 'started', next: 'stage', staged: undefined, report: undefined });
        await this.stagePhase();
      }
      if (this.m.phase === 'staged') {
        await this.confirmPhase();
        this.assertLiveUnchanged();
        // From here the marker (checked by every starting server before AND after it opens the database) and the no-clobber
        // install are the protection, as design 7.1 says of the lock after the first rename. Closing the probe NOW lets SQLite
        // finish its own business (merge a hot WAL, remove the files it made) on the real files, never on moved ones or,
        // later, on the restored database's names.
        this.releaseProbe();
        await this.mark({ phase: 'swapping', next: 'preRestoreDir' });
      }
      this.releaseProbe(); // unconditionally: a resumed swap must not keep the live database open through the moves
      return await this.swapPhase();
    } catch (e) {
      throw await this.handleFailure(e, createdMarker);
    } finally {
      this.releaseProbe();
    }
  }

  /** Failure policy: before the swap nothing live changed, so staging and the marker are removed; during the swap the marker stays. */
  private async handleFailure(e: unknown, createdMarker: boolean): Promise<CliError> {
    if (e instanceof RollbackNeeded) return this.rollback(e.message);
    const mapped = mapRestoreError(e, this.pf?.manifest.app.version);
    if (e instanceof BackupZipError && e.detail) this.info(`Reason: ${e.detail}`);
    const beforeSwap = this.m.phase !== 'swapping' && this.m.liveMoved === null;
    if (beforeSwap && (createdMarker || this.m.phase === 'started' || this.m.phase === 'staged')) {
      await rm(this.staging, { recursive: true, force: true }).catch(() => undefined);
      await unlink(restoreMarkerPath(this.dataDir)).catch(() => undefined);
      await this.sweepStale(true);
      await fsyncPath(this.dataDir);
      this.opsLog('restore.aborted', { reason: mapped.exitCode });
      return mapped;
    }
    this.info(
      `The restore stopped part-way (the marker was left in place, so the server will not start). Run the same command again to finish it. If that is not possible, your previous data is in ${this.m.preRestore}/ inside the data directory.`,
    );
    this.opsLog('restore.aborted', { reason: 'interrupted', step: this.m.next });
    return mapped;
  }

  // endregion

  // region Preflight and probe

  /** DATA_DIR and uploads/ must be what the swap expects (design 8 step 1). */
  private async checkLayout(create: boolean): Promise<void> {
    const st = await lstatOrNull(this.dataDir);
    if (!st) {
      if (!create) return;
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      await chmod(this.dataDir, 0o700);
    } else if (st.isSymbolicLink()) {
      throw new CliError(`The data directory ${this.dataDir} is a symbolic link; point DATA_DIR at the real directory.`, EXIT.failed);
    } else if (!st.isDirectory()) {
      throw new CliError(`${this.dataDir} is not a directory.`, EXIT.failed);
    }
    const dir = await stat(this.dataDir);
    for (const n of LIVE_DB_NAMES) {
      const f = await lstatOrNull(this.path(n));
      if (f && !f.isFile()) throw new CliError(`${this.path(n)} is not a regular file (a symbolic link or a directory); a restore moves these files and will not follow links. Remove or fix it first. Nothing was changed.`, EXIT.failed);
    }
    const up = await lstatOrNull(this.uploads);
    if (up) {
      if (up.isSymbolicLink()) throw new CliError(`${this.uploads} is a symbolic link; a restore replaces uploads/ and will not follow links. Replace it with a real directory first.`, EXIT.failed);
      if (!up.isDirectory()) throw new CliError(`${this.uploads} is not a directory.`, EXIT.failed);
      if (up.dev !== dir.dev) throw new CliError(`${this.uploads} is a separate mount; a restore swaps uploads/ by renaming and needs it on the same file system as the data directory.`, EXIT.failed);
    }
  }

  private async preflight(): Promise<Preflight> {
    let realFile: string;
    try {
      realFile = await realpath(this.a.file);
    } catch {
      throw new CliError(`Cannot read ${safeText(this.a.file)}: no such file.`, EXIT.notFound);
    }
    const st = await stat(realFile);
    if (!st.isFile()) throw new CliError(`${safeText(this.a.file)} is not a regular file.`, EXIT.invalidBackup);
    const sha256 = await sha256File(realFile).catch(() => {
      throw new CliError(`Cannot read ${safeText(this.a.file)}.`, EXIT.notFound);
    });
    // Early and advisory: the structure and the manifest (a few KB), so a clean message comes before gigabytes are extracted.
    // The binding migration decision is made on the staged database itself.
    const zip = await BackupZip.open(realFile);
    let manifest: Manifest;
    let declared: number;
    try {
      const first = zip.entries[0];
      if (!first || first.kind !== 'manifest') throw new BackupZipError('invalid', 'first entry is not the manifest');
      const read = await zip.readEntry(first, { maxBytes: MAX_MANIFEST_BYTES, ratio: RATIO_LIMIT, collect: true });
      manifest = parseManifest(read.data as Buffer);
      declared = zip.declaredBytes();
    } finally {
      await zip.close();
    }
    const verdict = compareMigrationRows(
      manifest.database.migrations.map((r) => ({ hash: r.hash, created_at: r.when })),
      loadJournal(this.env.migrationsDir),
    );
    if (verdict.kind === 'newer') throw new CliError(`This backup was made by a newer Critical Notes (version ${safeText(manifest.app.version)}); update before restoring it. Nothing was changed.`, EXIT.newerBackup);
    if (verdict.kind === 'different') {
      throw new CliError(`${DIVERGED_MESSAGE} (the backup claims it was made by Critical Notes ${safeText(manifest.app.version)}; that is the backup's own statement). Nothing was changed.`, EXIT.divergedBackup);
    }
    return { realFile, sha256, size: st.size, manifest, declared };
  }

  private free = async (): Promise<number> => {
    if (this.env.hooks?.freeBytes) return this.env.hooks.freeBytes();
    const base = (await exists(this.dataDir)) ? this.dataDir : tmpdir();
    const s = await statfs(base);
    return Number(s.bavail) * Number(s.bsize);
  };

  /** `max(3 x zip size, declared uncompressed sizes) + 64 MiB` free on the data directory's file system, with the numbers in the refusal. */
  private async checkSpace(): Promise<number> {
    const free = await this.free();
    const need = Math.max(3 * this.pf.size, this.pf.declared) + 64 * MiB;
    if (free < need) {
      throw new CliError(
        `Not enough free space to restore: ${fmtBytes(need)} needed (the larger of 3 x the zip and the unpacked size, plus 64 MiB), ${fmtBytes(free)} free in ${this.dataDir}. Free space and run it again. Nothing was changed.`,
        EXIT.diskFull,
      );
    }
    return free;
  }

  private releaseProbe(): void {
    try {
      this.probe?.db.close();
    } catch {
      // already closed
    }
    this.probe = null;
  }

  private async acquireProbe(): Promise<void> {
    // A swap under way has already listed the files to move; opening the database now could change that list (a hot WAL is merged and removed)
    if (this.m.phase === 'swapping' && this.m.liveMoved !== null) {
      await this.hook('probe:skipped');
      return;
    }
    const appDb = this.env.config.appDbPath;
    const before = await lstatOrNull(appDb);
    try {
      this.probe = probeStopped(appDb);
    } catch (e) {
      if (e instanceof ServerRunningError) throw e;
      if (!isDamagedDatabaseError(e)) {
        // Cannot open or lock it for some other reason (permissions, a read-only mount, a lock error): a server may be running. Refuse.
        const code = (e as { code?: string }).code ?? 'unknown';
        throw new CliError(`Cannot lock app.sqlite (${safeText(code)}), refusing: a server may be running, or the data directory is not writable by this user. Nothing was changed.`, EXIT.cannotLock);
      }
      // A damaged live database is the very case restore is for: carry-over is skipped, the swap goes ahead
      this.liveReadable = false;
      this.info('The live database is damaged (SQLite cannot read it). Live restrictions cannot be compared; the old files are kept in the pre-restore folder.');
    }
    const st = before ? await lstatOrNull(appDb) : null;
    this.liveStat = this.probe ? { dev: this.probe.dev, ino: this.probe.ino } : st ? { dev: st.dev, ino: st.ino } : null;
    await this.hook('probe:acquired');
  }

  /** The pre-swap check (design 7.1 point 3): the probe connection still answers and the path still names the locked inode. */
  private assertLiveUnchanged(): void {
    if (this.probe) {
      try {
        if (!this.probe.db.open) throw new Error('closed');
        this.probe.db.prepare('select 1').get();
      } catch {
        throw new CliError('The lock on the live database was lost while the restore was being prepared; nothing was swapped. Run it again.', EXIT.failed);
      }
    }
    if (this.liveStat) {
      const now = ((): { dev: number; ino: number } | null => {
        try {
          const s = statSync(this.env.config.appDbPath);
          return { dev: s.dev, ino: s.ino };
        } catch {
          return null;
        }
      })();
      if (!now || now.dev !== this.liveStat.dev || now.ino !== this.liveStat.ino) {
        throw new CliError('The live database was replaced while the restore was being prepared; nothing was swapped. Run it again.', EXIT.failed);
      }
    }
  }

  // endregion

  // region Stage

  private async stagePhase(): Promise<void> {
    const free = await this.free();
    await rm(this.staging, { recursive: true, force: true });
    await mkdir(this.staging, { mode: 0o700 });
    await chmod(this.staging, 0o700);
    await this.hook('stage:begin');
    await fsyncPath(this.dataDir);
    await this.mark({ phase: 'started', next: 'stage', flags: { keepTokens: this.a.keepTokens, carryRestrictions: this.a.carryRestrictions } });
    const res = await readBackup(this.pf.realFile, { extractTo: this.staging, maxTotalBytes: free - 64 * MiB });
    await this.hook('stage:extracted');
    const prep = await prepareRestoredDatabase(join(this.staging, 'app.sqlite'), {
      keepTokens: this.a.keepTokens,
      live: this.probe && this.liveReadable ? this.probe.db : null,
      carryRestrictions: this.a.carryRestrictions,
      stagedUploadsDir: join(this.staging, 'uploads'),
      now: this.now(),
      migrationsDir: this.env.migrationsDir,
    });
    await fsyncPath(join(this.staging, 'uploads'));
    await fsyncPath(this.staging);
    await this.mark({
      phase: 'staged',
      next: 'confirm',
      staged: { sha256: prep.sha256, size: prep.size },
      report: { manifest: res.manifest, prepare: prep },
    });
    await this.hook('marker:staged');
  }

  /** A resumed `staged` restore: is what the marker recorded still there? (Before the swap starts the hash is checked too.) */
  private async stagedIntact(): Promise<boolean> {
    if (await this.installedAlready()) return true;
    const f = await lstatOrNull(join(this.staging, 'app.sqlite'));
    if (!f || !f.isFile() || f.size !== this.m.staged?.size) return false;
    if (this.m.liveMoved === null && (await sha256File(join(this.staging, 'app.sqlite'))) !== this.m.staged.sha256) return false;
    return (await exists(join(this.staging, 'uploads'))) || this.m.uploadsLive !== null;
  }

  private async confirmPhase(): Promise<void> {
    const rep = this.m.report as { manifest: Manifest; prepare: PrepareReport };
    this.info(planText(rep.manifest, rep.prepare, this.m, this.env.config.dataDir, (await exists(this.path('app.sqlite'))) || (await exists(this.uploads))));
    if (this.a.yes) return;
    const ok = this.env.confirm ? await this.env.confirm('Replace the current data with this backup? [y/N] ') : false;
    if (!ok) throw new CliError('Cancelled. Nothing was changed.', EXIT.cancelled);
  }

  // endregion

  // region Swap

  private async swapPhase(): Promise<string> {
    await this.step('preRestoreDir', () => this.stepPreRestoreDir());
    await this.step('moveLive', () => this.stepMoveLive());
    await this.step('moveUploads', () => this.stepMoveUploads());
    await this.step('install', () => this.stepInstall());
    await this.step('indexDelete', async () => {
      for (const n of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm', 'index.sqlite-journal']) await rm(this.path(n), { force: true });
      await fsyncPath(this.dataDir);
    });
    let text = '';
    await this.step('finish', async () => {
      text = await this.stepFinish();
    });
    return text;
  }

  private async stepPreRestoreDir(): Promise<void> {
    const made = await mkdir(this.pre, { mode: 0o700 }).then(
      () => true,
      (e: NodeJS.ErrnoException) => (e.code === 'EEXIST' ? false : Promise.reject(e)),
    );
    if (!made && !(await lstat(this.pre)).isDirectory()) throw new Error('The pre-restore path exists and is not a directory');
    await chmod(this.pre, 0o700);
    await fsyncPath(this.dataDir);
  }

  private async stepMoveLive(): Promise<void> {
    if (this.m.liveMoved === null) {
      // The intended move list FIRST: a crash half-way is finished from it, so the three files move together or not at all
      const list: { name: string; size: number }[] = [];
      for (const n of LIVE_DB_NAMES) {
        const st = await lstatOrNull(this.path(n));
        if (!st) continue;
        if (!st.isFile()) throw new Error(`${n} in the data directory is not a regular file`);
        list.push({ name: n, size: st.size });
      }
      await this.mark({ liveMoved: list });
    }
    for (const f of this.m.liveMoved ?? []) {
      const live = this.path(f.name);
      const dst = join(this.pre, f.name);
      if (await exists(dst)) continue; // already moved (the live name may hold the restored database by now)
      if (await exists(live)) await rename(live, dst);
      else throw new Error(`${f.name} is neither in the data directory nor in the pre-restore folder`);
      await this.hook(`moveLive:moved:${f.name}`);
    }
    await fsyncPath(this.pre);
    await fsyncPath(this.dataDir);
  }

  private async stepMoveUploads(): Promise<void> {
    const sUp = join(this.staging, 'uploads');
    const pUp = join(this.pre, 'uploads');
    if (this.m.uploadsLive === null) await this.mark({ uploadsLive: await exists(this.uploads) });
    if (this.m.uploadsLive && !(await exists(pUp))) {
      await rename(this.uploads, pUp);
      await this.hook('moveUploads:aside');
    }
    if (await exists(sUp)) {
      const cur = await lstatOrNull(this.uploads);
      if (cur) {
        if (cur.isDirectory() && (await readdir(this.uploads)).length === 0) await rmdir(this.uploads); // an empty folder a racing start made
        else throw new RollbackNeeded('something else appeared at uploads/ during the restore');
      }
      await rename(sUp, this.uploads);
    } else if (!(await exists(this.uploads))) {
      throw new Error('The staged uploads are missing');
    }
    await fsyncPath(this.pre);
    await fsyncPath(this.dataDir);
  }

  private async installedAlready(): Promise<boolean> {
    const staged = this.m.staged;
    if (!staged) return false;
    const t = await lstatOrNull(this.path('app.sqlite'));
    return !!t && t.isFile() && t.size === staged.size && (await sha256File(this.path('app.sqlite'))) === staged.sha256;
  }

  /** Moves whatever stands at the three live names into `pre/racer-<n>-*` without ever overwriting a file there. */
  private async sweepRacers(): Promise<void> {
    const present: string[] = [];
    for (const n of LIVE_DB_NAMES) if (await exists(this.path(n))) present.push(n);
    if (!present.length) return;
    let n = 1;
    while (await anyExists(LIVE_DB_NAMES.map((x) => join(this.pre, `racer-${n}-${x}`)))) n++;
    for (const name of present) await rename(this.path(name), join(this.pre, `racer-${n}-${name}`));
    this.info(`A process created database files during the restore; they were moved to ${this.m.preRestore}/racer-${n}-*.`);
  }

  private async stepInstall(): Promise<void> {
    const target = this.path('app.sqlite');
    const sDb = join(this.staging, 'app.sqlite');
    if (await this.installedAlready()) {
      await rm(sDb, { force: true }); // a crash between link() and unlink() lands here
    } else {
      if (!(await exists(sDb))) throw new Error('The staged database is neither in staging nor installed');
      await this.sweepRacers();
      await this.hook('install:beforeLink');
      try {
        await (this.env.linkFn ?? link)(sDb, target); // no-clobber: EEXIST if anything stands there
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') throw new RollbackNeeded('a process created the database while the restore ran');
        if (!['EPERM', 'ENOTSUP', 'EXDEV', 'EMLINK', 'ENOSYS'].includes(code ?? '')) throw e;
        // A file system without hard links: an exclusive copy is the same no-clobber guarantee (a half-written copy fails the hash check and is swept as debris on a resume)
        try {
          await copyFile(sDb, target, fsc.COPYFILE_EXCL);
        } catch (e2) {
          if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') throw new RollbackNeeded('a process created the database while the restore ran');
          throw e2;
        }
        const fh = await open(target, 'r+');
        try {
          await fh.sync();
        } finally {
          await fh.close();
        }
      }
      await this.hook('install:afterLink');
      await unlink(sDb);
    }
    await fsyncPath(this.dataDir);
    await fsyncPath(this.staging);
    for (const n of ['app.sqlite-wal', 'app.sqlite-shm']) if (await exists(this.path(n))) throw new RollbackNeeded(`${n} appeared next to the restored database`);
  }

  private async stepFinish(): Promise<string> {
    await rm(this.staging, { recursive: true, force: true });
    await fsyncPath(this.dataDir);
    await this.chownIfRoot();
    const rep = this.m.report as { manifest: Manifest; prepare: PrepareReport };
    const preSize = await dirSize(this.pre);
    const others: { name: string; size: number }[] = [];
    for (const n of await readdir(this.dataDir)) {
      if (PRE_RESTORE_NAME_RE.test(n) && n !== this.m.preRestore) others.push({ name: n, size: await dirSize(this.path(n)) });
    }
    const text = reportText(rep.manifest, rep.prepare, this.m, preSize, others);
    this.opsLog('restore.completed', { preRestore: this.m.preRestore, migratedSteps: rep.prepare.migratedSteps });
    await unlink(restoreMarkerPath(this.dataDir));
    await fsyncPath(this.dataDir);
    for (const n of await readdir(this.dataDir)) if (n.startsWith('.restore-in-progress.tmp-')) await rm(this.path(n), { force: true });
    return text;
  }

  /**
   * Best effort, root only. `lchown` (never follows a link) and no walk through the OLD data: the previous uploads tree is untrusted
   * (a compromised server may have planted links in it) and keeps its owner. Only what this restore wrote is handed over.
   */
  private async chownIfRoot(): Promise<void> {
    const isRoot = this.env.isRoot ?? process.getuid?.() === 0;
    if (!isRoot) return;
    const chown = this.env.chown ?? lchownSync;
    const dir = await stat(this.dataDir);
    const give = (p: string) => {
      try {
        chown(p, dir.uid, dir.gid);
      } catch (e) {
        this.info(`Could not change the owner of ${p}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const walk = async (p: string) => {
      const st = await lstatOrNull(p);
      if (!st || st.isSymbolicLink()) return;
      give(p);
      if (st.isDirectory()) for (const n of await readdir(p)) await walk(join(p, n));
    };
    await walk(this.path('app.sqlite'));
    await walk(this.uploads); // the staged tree written by this restore
    await walk(this.path('restore-log.jsonl'));
    give(this.pre); // the folder itself, and the database files directly in it, but not the old uploads tree
    for (const n of await readdir(this.pre)) {
      const st = await lstatOrNull(join(this.pre, n));
      if (st?.isFile()) give(join(this.pre, n));
    }
  }

  // endregion

  // region Rollback

  /** Called with the marker read under the lock and with the run lock held. */
  private async continueRollbackOnly(m: RestoreMarker): Promise<string> {
    this.m = m;
    this.info('An earlier restore was being rolled back; continuing the rollback (this does not restore the new backup).');
    throw await this.rollback(m.rollingBack?.reason ?? 'rollback continued');
  }

  /** Design 8 rollback, five idempotent steps recorded in the marker. Always returns the CliError to throw. */
  private async rollback(reason: string): Promise<CliError> {
    const steps: RollbackStep[] = ['removeInstalled', 'uploadsBack', 'liveBack', 'deleteStaging', 'finalize'];
    const from = this.m.rollingBack?.next ?? 'removeInstalled';
    try {
      this.info(`Rolling back: ${reason}.`);
      for (const s of steps.slice(steps.indexOf(from))) {
        await this.mark({ phase: 'swapping', rollingBack: { reason, next: s } });
        await this.hook(`rollback:marker:${s}`);
        await this.rollbackStep(s);
        await this.hook(`rollback:done:${s}`);
      }
    } catch (e) {
      await this.mark({ rollingBack: { reason, next: this.m.rollingBack?.next ?? 'removeInstalled', failed: true } }).catch(() => undefined);
      return new CliError(
        `Rollback FAILED (${e instanceof Error ? e.message : String(e)}). The server will not start. Your previous data is in ${this.m.preRestore}/ inside the data directory: move app.sqlite (and -wal/-shm) and uploads/ back to their old places, remove .restore-* folders, then delete ${restoreMarkerPath(this.dataDir)}. Running the restore command again retries the rollback.`,
        EXIT.rollbackFailed,
      );
    }
    return new CliError(`The restore was rolled back (${reason}). Your data is exactly as it was before. Run the restore again when no other process is touching the data directory.`, EXIT.rolledBack);
  }

  private async rollbackStep(s: RollbackStep): Promise<void> {
    const target = this.path('app.sqlite');
    switch (s) {
      case 'removeInstalled': {
        const t = await lstatOrNull(target);
        if (t?.isFile() && this.m.staged && t.size === this.m.staged.size && (await sha256File(target)) === this.m.staged.sha256) await unlink(target);
        await this.sweepRacers(); // anything else standing at the live names is a racer's, never overwritten
        await fsyncPath(this.dataDir);
        break;
      }
      case 'uploadsBack': {
        const sUp = join(this.staging, 'uploads');
        const pUp = join(this.pre, 'uploads');
        if (this.m.uploadsLive === null) break;
        if (this.m.uploadsLive) {
          if (await exists(pUp)) {
            if (await exists(this.uploads)) {
              if (await exists(sUp)) throw new Error('uploads/ exists in both the live and the staging place');
              await rename(this.uploads, sUp);
            }
            await rename(pUp, this.uploads);
          }
        } else if ((await exists(this.uploads)) && !(await exists(sUp))) {
          await rename(this.uploads, sUp);
        }
        await fsyncPath(this.dataDir);
        break;
      }
      case 'liveBack': {
        for (const f of this.m.liveMoved ?? []) {
          const src = join(this.pre, f.name);
          const live = this.path(f.name);
          if (await exists(src)) {
            if (await exists(live)) throw new Error(`${f.name} cannot be put back: something stands in its place`);
            await rename(src, live);
          } else if (!(await exists(live))) {
            throw new Error(`${f.name} is neither in the pre-restore folder nor in the data directory`);
          }
        }
        await rmdir(this.pre).catch(() => undefined); // only when empty; racer files keep it
        await fsyncPath(this.dataDir);
        break;
      }
      case 'deleteStaging':
        await rm(this.staging, { recursive: true, force: true });
        await fsyncPath(this.dataDir);
        break;
      case 'finalize':
        this.opsLog('restore.aborted', { reason: 'rolled back', detail: this.m.rollingBack?.reason ?? '' });
        await unlink(restoreMarkerPath(this.dataDir));
        await fsyncPath(this.dataDir);
        break;
    }
  }

  // endregion

  // region --check

  private async runCheck(): Promise<string> {
    await this.checkLayout(false);
    await this.sweepStale(false);
    if (readRestoreMarker(this.dataDir) !== null) throw new CliError(restoreBlockedMessage(this.dataDir), EXIT.restoreInProgress);
    this.pf = await this.preflight();
    const base = (await exists(this.dataDir)) ? this.dataDir : tmpdir();
    const free = await this.free();
    const need = Math.max(3 * this.pf.size, this.pf.declared) + 64 * MiB;
    if (free < need) throw new CliError(`Not enough free space to check the restore: ${fmtBytes(need)} needed, ${fmtBytes(free)} free. Nothing was changed.`, EXIT.diskFull);
    const dir = join(base, `.restore-check-${randomBytes(6).toString('hex')}`);
    await mkdir(dir, { mode: 0o700 });
    try {
      const res = await readBackup(this.pf.realFile, { extractTo: dir, maxTotalBytes: free - 64 * MiB });
      const prep = await prepareRestoredDatabase(join(dir, 'app.sqlite'), {
        keepTokens: this.a.keepTokens,
        live: null,
        carryRestrictions: false,
        stagedUploadsDir: join(dir, 'uploads'),
        now: this.now(),
        migrationsDir: this.env.migrationsDir,
      });
      const mf = res.manifest;
      return [
        `Backup ${safeText(basename(this.pf.realFile))} (sha256 ${this.pf.sha256}) is complete and restorable. Nothing was changed.`,
        `Made ${safeText(mf.createdAt)} by Critical Notes ${safeText(mf.app.version)}: ${mf.counts.users} users, ${mf.counts.campaigns} campaigns, ${mf.counts.uploads} uploads, ${res.uploadFiles} upload files.`,
        prep.migratedSteps ? `Restoring it would migrate its database by ${prep.migratedSteps} step${prep.migratedSteps === 1 ? '' : 's'}.` : 'Its database is at this version.',
        prep.missingUploads ? `${prep.missingUploads} upload record${prep.missingUploads === 1 ? ' has' : 's have'} no file in the backup.` : 'Every upload record has its file.',
        `Enabled administrators in it: ${prep.admins.map(safeText).join(', ') || '(none)'}.`,
      ].join('\n');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // endregion
}

function safeName(uid: number): string {
  try {
    return safeText(userInfo().username);
  } catch {
    return `uid-${uid}`;
  }
}

async function anyExists(paths: string[]): Promise<boolean> {
  for (const p of paths) if (await exists(p)) return true;
  return false;
}

// region Texts

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const names = (l: string[]) => (l.length ? l.map(safeText).join(', ') : 'none');

function planText(mf: Manifest, p: PrepareReport, m: RestoreMarker, dataDir: string, hadLive: boolean): string {
  const lines = [
    `Restore started by ${m.user.name} (uid ${m.user.uid}); live data compared with the backup: ${p.carry.liveCompared ? 'yes' : 'no'}; backup file sha256 ${m.zip.sha256}.`,
    `Backup ${m.zip.name}, made ${safeText(mf.createdAt)} by Critical Notes ${safeText(mf.app.version)}: ${plural(mf.counts.users, 'user')}, ${plural(mf.counts.campaigns, 'campaign')}, ${plural(mf.counts.uploads, 'upload')}.`,
    `It will REPLACE the current database and uploads. Everything done after ${safeText(mf.createdAt)} will be gone from the running instance.`,
    `Sessions (${p.purged.sessions}) and password reset links (${p.purged.passwordResets}) are cleared.`,
    m.flags.keepTokens ? KEEP_TOKENS_WARNING : `API tokens (${p.purged.apiTokensRevoked}) and invite links (${p.purged.invitesRevoked}) are revoked.`,
    ...carryLines(p, m),
    hadLive ? `The current state is moved (not copied) to ${join(dataDir, m.preRestore)}/ and stays there until you delete it.` : 'There is no current data, so nothing will be moved aside.',
  ];
  if (p.migratedSteps) lines.push(`The backup is older: its database was migrated by ${plural(p.migratedSteps, 'step')}.`);
  return lines.join('\n');
}

function carryLines(p: PrepareReport, m: RestoreMarker): string[] {
  const c = p.carry;
  if (!m.flags.carryRestrictions) return ['Live restrictions were NOT carried over (--no-carry-restrictions): a user disabled since the backup is enabled again.'];
  if (!c.liveCompared) return ['The live data could not be compared: check Admin > Users and re-disable or demote anyone you had already acted on.'];
  const out = [`Carried over from the live data: disabled users: ${names(c.disabledCarried)}; API tokens revoked: ${c.tokensRevokedCarried}; invite links revoked: ${c.invitesRevokedCarried}.`];
  if (c.adminsDemotedOrDeletedLive.length) out.push(`Administrators in the backup that are demoted or deleted in the live data (NOT applied, check them): ${names(c.adminsDemotedOrDeletedLive)}.`);
  if (c.usersDeletedLive.length) out.push(`Users in the backup that were deleted live (they are back): ${names(c.usersDeletedLive)}.`);
  if (c.usersLostFromBackup.length) out.push(`Users created after the backup (their accounts and content are NOT in the restored instance; the pre-restore copy still holds them): ${names(c.usersLostFromBackup)}.`);
  if (c.tokensCreatedLiveLost || c.invitesCreatedLiveLost) out.push(`API tokens created after the backup: ${c.tokensCreatedLiveLost}; invite links: ${c.invitesCreatedLiveLost} (lost).`);
  return out;
}

function reportText(mf: Manifest, p: PrepareReport, m: RestoreMarker, preSize: number, others: { name: string; size: number }[]): string {
  const lines = [
    `Restored ${m.zip.name} (made ${safeText(mf.createdAt)} by Critical Notes ${safeText(mf.app.version)}): ${plural(mf.counts.users, 'user')}, ${plural(mf.counts.campaigns, 'campaign')}, ${plural(mf.counts.uploads, 'upload')}.`,
    `Everything done after ${safeText(mf.createdAt)} is gone from this instance.`,
  ];
  if (p.migratedSteps) lines.push(`Migrated ${plural(p.migratedSteps, 'step')} to this version.`);
  lines.push(`Cleared ${plural(p.purged.sessions, 'session')} (everyone signs in again) and ${plural(p.purged.passwordResets, 'password reset link')}; issue new ones with the command for your setup. ${adminCommandInline('reset-link <username>')}.`);
  lines.push(
    m.flags.keepTokens
      ? `${KEEP_TOKENS_WARNING} Tokens and invite links were kept as in the backup.`
      : `Revoked ${plural(p.purged.apiTokensRevoked, 'API token')} and ${plural(p.purged.invitesRevoked, 'invite link')}; people create new ones.`,
  );
  lines.push(...carryLines(p, m));
  lines.push(`Enabled administrators: ${names(p.admins)}. A name you do not recognise means the backup is compromised: reset every admin password and review Admin > Users.`);
  if (p.missingUploads) lines.push(`${plural(p.missingUploads, 'upload record')} in the backup had no file (they were already missing when it was made).`);
  if ((m.liveMoved?.length ?? 0) > 0 || m.uploadsLive) {
    lines.push(
      `Your previous data was MOVED (not copied) to ${m.preRestore}/ inside the data directory (${fmtBytes(preSize)}). It still holds the old password hashes and tokens: delete it after you have verified the restored instance.`,
    );
  } else {
    lines.push('There was no previous data, so nothing was moved aside.');
  }
  if (others.length) lines.push(`Older pre-restore folders still on disk: ${others.map((o) => `${o.name} (${fmtBytes(o.size)})`).join(', ')}.`);
  const check = [...new Set([...p.carry.adminsDemotedOrDeletedLive, ...p.carry.usersDeletedLive])];
  if (p.carry.liveCompared && check.length) {
    lines.push(`CHECK THESE NOW (demoted or deleted in the live data before the restore; they are back as they were in the backup): ${names(check)}. Disable or demote them in Admin > Users, or reset their passwords with the command for your setup. ${adminCommandInline('reset-link <username>')}.`);
  }
  lines.push('The first start rebuilds the search index from the restored data and takes longer than usual. Start the server now. ' + START_SERVER_HINT);
  return lines.join('\n');
}

// endregion

/** `restore <file>`: returns the report for stdout; throws `CliError` with the exit code. */
export async function restoreCommand(args: string[], env: RestoreEnv): Promise<string> {
  const parsed = parseRestoreArgs(args);
  try {
    return await new Restore(parsed, env).run();
  } catch (e) {
    throw mapRestoreError(e);
  }
}
