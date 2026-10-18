/**
 * Instance backups (docs/design/backup.md, task M3.2): `BackupService` (create, list, prune, status, isRunning,
 * openForDownload), the four database-specific functions of section 15 (`snapshotDatabase`, `readMigrationLevel`,
 * `prepareRestoredDatabase`, `probeStopped`) and the building blocks the restore command (M3.3) calls. The zip format,
 * its writer and its bounded reader live in `backup-zip.ts`.
 *
 * Not here (other tasks): HTTP routes and tickets (M3.4), CLI subcommands, marker, swap (M3.3), the scheduler (M3.5).
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, constants as fsc, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, rename, rm, statfs, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import * as schema from '../db/schema';
import { MIGRATIONS_DIR, openAppDbForRestore, type AppDb } from '../db';
import type { AppConfig } from '../config';
import { audit as defaultAudit } from '../lib/audit';
import { appendOpsLog } from '../lib/ops-log';
import { appVersion } from '../lib/version';
import { restoreMarkerExists } from '../lib/restore-marker';
import {
  BackupZipError,
  CHUNK,
  isTrigger,
  MANIFEST_FORMAT,
  MANIFEST_KIND,
  MAX_DB_ENTRY_BYTES,
  MAX_UPLOAD_FILES,
  readBackup,
  readManifestHead,
  safeText,
  UPLOAD_FILE_RE,
  ZipFileWriter,
  type Manifest,
  type ManifestSummary,
  type Trigger,
} from './backup-zip';
import { BackupError, BackupLock, ensureBackupDir, validateBackupDir, type LockOptions } from './backup-fs';

export { BackupError, validateBackupDir } from './backup-fs';
export { BackupZipError, readBackup, type Manifest, type Trigger } from './backup-zip';

const MiB = 1024 * 1024;
const DAY_MS = 24 * 3600 * 1000;
/** API-created backups younger than this are protected from eviction and not counted toward `keep` (design 11). */
export const API_PRUNE_MIN_AGE_DAYS = 7;
export const API_PRUNE_MIN_AGE_MS = API_PRUNE_MIN_AGE_DAYS * DAY_MS;
/** An API create is refused (409) while this many times `keep` young API backups exist. */
export const API_CREATE_CAP_FACTOR = 3;
const DB_PHASE_LIMIT_MS = 10 * 60 * 1000;
const LEFTOVER_MAX_AGE_MS = 3600 * 1000;
export { RESTORE_MARKER } from '../lib/restore-marker';
export const BACKUP_NAME_RE = /^backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.zip$/;

// region Database-specific functions (design 15)

export interface MigrationRow {
  hash: string;
  created_at: number;
}
export interface JournalEntry {
  tag: string;
  hash: string;
  when: number;
}

/** The build's migrations in order: tag and `when` from the drizzle journal, `hash` = sha256 of the `.sql` text (as drizzle stores it). */
export function loadJournal(migrationsDir = MIGRATIONS_DIR): JournalEntry[] {
  const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] };
  const files = readMigrationFiles({ migrationsFolder: migrationsDir });
  return journal.entries.map((e, i) => ({ tag: e.tag, when: e.when, hash: (files[i] as { hash: string }).hash }));
}

/** The migration level of an open database: its `__drizzle_migrations` rows in insertion order (`id` is NULL in SQLite: drizzle declares it SERIAL). Throws when the table is absent. */
export function readMigrationRows(db: Database.Database, limit = 10_000): MigrationRow[] {
  // Bounded: a hostile database may hold millions of forged rows; callers pass the journal length + 1
  return db.prepare('select hash, created_at from __drizzle_migrations order by rowid limit ?').all(limit) as MigrationRow[];
}

/** `readMigrationLevel`: the rows of the snapshot with `tag` filled in by matching `hash` against the build's journal (null when unknown). */
export function readMigrationLevel(db: Database.Database, journal: JournalEntry[] = loadJournal()): Manifest['database']['migrations'] {
  return readMigrationRows(db).map((r) => ({ tag: journal.find((j) => j.hash === r.hash)?.tag ?? null, hash: r.hash, when: r.created_at }));
}

export interface SnapshotInfo {
  /** Size of the snapshot file (one self-contained file, `journal_mode = DELETE`). */
  bytes: number;
  sqliteVersion: string;
  migrations: Manifest['database']['migrations'];
  counts: Manifest['counts'];
  /** `uploads.id` of every row in the snapshot (for the missing-file post-check). */
  uploadIds: string[];
}

export interface SnapshotOptions {
  /** Pages copied per step (default 100; the CLI passes 2000). Never 0: the wrapper would transfer nothing forever. */
  stepPages?: number;
  /** Wall-clock limit for the copy (default 10 minutes). Foreign writes restart the copy from page 1 and can starve it. */
  timeoutMs?: number;
  journal?: JournalEntry[];
}

/**
 * `snapshotDatabase`: copies the live database with the SQLite online backup API (page-stepped, yielding to the event loop),
 * converts the copy to `journal_mode = DELETE`, requires `integrity_check` = ok and reads the migration level and counts.
 * `dest` must not exist. Writes through the SAME connection between steps are mirrored by SQLite; a write from another
 * connection or process restarts the copy (design 4).
 */
export async function snapshotDatabase(db: Database.Database, dest: string, opts: SnapshotOptions = {}): Promise<SnapshotInfo> {
  const step = Math.max(1, Math.floor(opts.stepPages ?? 100));
  const limit = opts.timeoutMs ?? DB_PHASE_LIMIT_MS;
  const started = Date.now();
  await db.backup(dest, {
    progress: () => {
      if (Date.now() - started > limit) throw new BackupError('db-timeout', `The database copy did not finish within ${Math.round(limit / 60000)} minutes (other processes keep writing); try again when the instance is quiet`);
      return step;
    },
  });
  chmodSync(dest, 0o600); // SQLite creates it with 0644 less the umask
  const copy = new Database(dest, { fileMustExist: true });
  try {
    copy.pragma('journal_mode = DELETE');
    const check = copy.pragma('integrity_check') as { integrity_check: string }[];
    if (check.length !== 1 || check[0]?.integrity_check !== 'ok') throw new Error('The database copy failed its integrity check');
    const count = (table: string) => (copy.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
    const info: Omit<SnapshotInfo, 'bytes'> = {
      sqliteVersion: (copy.prepare('select sqlite_version() as v').get() as { v: string }).v,
      migrations: readMigrationLevel(copy, opts.journal),
      counts: { users: count('users'), campaigns: count('campaigns'), uploads: count('uploads') },
      uploadIds: (copy.prepare('select id from uploads').all() as { id: string }[]).map((r) => r.id),
    };
    copy.close();
    for (const suffix of ['-wal', '-shm']) if (existsSync(dest + suffix)) throw new Error('The database copy left a journal file behind');
    return { ...info, bytes: statSync(dest).size };
  } finally {
    if (copy.open) copy.close();
  }
}

export class ServerRunningError extends Error {
  constructor() {
    super('The server is running (the database is locked); stop it first. With Docker: docker compose stop app');
    this.name = 'ServerRunningError';
  }
}

export interface StoppedProbe {
  /** Stays open and exclusive until the restore finishes; doubles as the read-only window onto the live data. */
  db: Database.Database;
  /** `dev` and `ino` of the path right after the lock was acquired (the pre-swap check compares them). */
  dev: number;
  ino: number;
}

/**
 * `probeStopped` (design 7.1): opens the live database exclusively. `SQLITE_BUSY` means another connection is open
 * (`ServerRunningError`). Returns null when the file does not exist (a wiped instance: nothing to probe).
 */
export function probeStopped(appDbPath: string): StoppedProbe | null {
  if (!existsSync(appDbPath)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(appDbPath, { fileMustExist: true, timeout: 500 });
    db.pragma('locking_mode = EXCLUSIVE');
    db.prepare('select count(*) from sqlite_master').get();
    db.exec('begin exclusive');
  } catch (e) {
    try {
      db?.close();
    } catch {
      // nothing to do
    }
    // Busy or locked: another connection has it, which is what a running server looks like (and BUSY_RECOVERY: one is recovering it)
    if (/^SQLITE_(BUSY|LOCKED)/.test((e as { code?: string }).code ?? '')) throw new ServerRunningError();
    throw e;
  }
  const st = statSync(appDbPath);
  return { db, dev: st.dev, ino: st.ino };
}

/** `damaged` only for a file SQLite says is corrupt or not a database; every other failure to open and lock must refuse (a server may be running). */
export function isDamagedDatabaseError(e: unknown): boolean {
  return /^SQLITE_(CORRUPT|NOTADB)/.test((e as { code?: string }).code ?? '');
}

export type MigrationVerdict = { kind: 'same' | 'older'; steps: number } | { kind: 'newer' | 'different' };

/**
 * Design 7.2, applied to the rows of the STAGED database (never to the manifest, which is attacker-controlled): the same
 * pairs as the build journal, or a strict prefix of it (an older backup, migrated before the swap), are accepted;
 * more rows ('newer') and anything else ('different': another hash or `created_at`, a gap, no rows) are refused.
 */
export function compareMigrationRows(rows: MigrationRow[], journal: JournalEntry[] = loadJournal()): MigrationVerdict {
  if (rows.length === 0) return { kind: 'different' };
  for (let i = 0; i < Math.min(rows.length, journal.length); i++) {
    const r = rows[i] as MigrationRow;
    const j = journal[i] as JournalEntry;
    if (r.hash !== j.hash || Number(r.created_at) !== j.when) return { kind: 'different' };
  }
  if (rows.length > journal.length) return { kind: 'newer' };
  return rows.length === journal.length ? { kind: 'same', steps: 0 } : { kind: 'older', steps: journal.length - rows.length };
}

interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
const schemaOf = (db: Database.Database, limit = -1): SchemaRow[] =>
  db.prepare('select type, name, tbl_name, sql from sqlite_master order by type, name, tbl_name, sql limit ?').all(limit) as SchemaRow[];

/** The `sqlite_master` of a `:memory:` database migrated to the first `n` entries of the journal. */
export function referenceSchema(n: number, migrationsDir = MIGRATIONS_DIR): SchemaRow[] {
  const mem = new Database(':memory:');
  try {
    mem.pragma('foreign_keys = ON');
    const db = drizzle(mem, { schema });
    const migrations = readMigrationFiles({ migrationsFolder: migrationsDir }).slice(0, n);
    // drizzle's own migrator on a prefix of the journal (`dialect` and `session` are internal, absent from the public type)
    const internals = db as unknown as { dialect: { migrate(m: unknown, session: unknown, config: unknown): void }; session: unknown };
    internals.dialect.migrate(migrations, internals.session, { migrationsFolder: migrationsDir });
    return schemaOf(mem);
  } finally {
    mem.close();
  }
}

/**
 * The planner statistics `ANALYZE` leaves behind. Inert data, so exactly these two tables with exactly this SQL are tolerated in a
 * backup (and dropped from the staged copy before anything else happens); anything else stays a refusal.
 */
const STAT_TABLES: Record<string, string> = {
  sqlite_stat1: 'CREATE TABLE sqlite_stat1(tbl,idx,stat)',
  sqlite_stat4: 'CREATE TABLE sqlite_stat4(tbl,idx,neq,nlt,ndlt,sample)',
};
const isCanonicalStat = (r: SchemaRow) => r.type === 'table' && r.name === r.tbl_name && STAT_TABLES[r.name] === r.sql;

/** Null when `db`'s schema objects equal the reference exactly; otherwise a short description of the first difference. `allowStats` ignores the canonical `sqlite_stat1`/`sqlite_stat4` tables. */
export function compareSchema(db: Database.Database, reference: SchemaRow[], allowStats = false): string | null {
  let actual = schemaOf(db, reference.length + 3); // bounded: more than expected is already a difference
  if (allowStats) actual = actual.filter((r) => !isCanonicalStat(r));
  const same = (a: SchemaRow | undefined, b: SchemaRow | undefined) => a && b && a.type === b.type && a.name === b.name && a.tbl_name === b.tbl_name && a.sql === b.sql;
  for (let i = 0; i < Math.max(actual.length, reference.length); i++) {
    if (!same(actual[i], reference[i])) {
      const odd = actual[i] ?? reference[i];
      return `${odd?.type ?? 'object'} ${odd?.name ?? ''}`.trim();
    }
  }
  return null;
}

export const DIVERGED_MESSAGE =
  'The migration history of this backup differs from this version of Critical Notes. It comes from a different branch, a fork or an edited database; restore it with the app version recorded in it';

/** The refusal for a staged database with an object the application never creates. `object` is untrusted text from the backup. */
export function schemaRefusalMessage(object: string): string {
  return `This backup's database has an extra schema object (${safeText(object)}). This version only restores databases that contain exactly the application's own schema, so the backup was not restored. If someone ran ANALYZE or edited the database by hand, remove the object in the live database and make a new backup. Older backups with this object cannot be restored by this version`;
}

/** Why a backup is refused at restore time; `code` distinguishes the exit codes M3.3 maps. */
export class RestoreRefusal extends Error {
  constructor(
    readonly code: 'newer' | 'different' | 'schema' | 'integrity' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'RestoreRefusal';
  }
}

export interface PrepareOptions {
  /** Keep API tokens and invite links as in the backup (default: revoke them all). */
  keepTokens?: boolean;
  /** The live database (the probe connection) for the carry-over of restrictions; null/undefined = could not be compared. */
  live?: Database.Database | null;
  /** Carry live restrictions over (default true). */
  carryRestrictions?: boolean;
  /** The extracted `uploads/` folder, to count rows without a main file. */
  stagedUploadsDir?: string;
  now?: number;
  migrationsDir?: string;
}

export interface CarryReport {
  liveCompared: boolean;
  /** Applied to the staged copy: users disabled live and not in the backup. */
  disabledCarried: string[];
  tokensRevokedCarried: number;
  invitesRevokedCarried: number;
  /** Reported only, never applied. */
  adminsDemotedOrDeletedLive: string[];
  usersDeletedLive: string[];
  usersLostFromBackup: string[];
  tokensCreatedLiveLost: number;
  invitesCreatedLiveLost: number;
}

export interface PrepareReport {
  /** Migrations applied to bring the staged copy to the build level. */
  migratedSteps: number;
  purged: { sessions: number; passwordResets: number; apiTokensRevoked: number; invitesRevoked: number };
  carry: CarryReport;
  /** `uploads` rows without a main file in the staged uploads (a warning, not fatal). */
  missingUploads: number;
  /** Enabled administrators of the restored database (an unknown name here means: treat the backup as compromised). */
  admins: string[];
  /** sha256 and size of the final staged file (for the marker). */
  sha256: string;
  size: number;
}

function emptyCarry(liveCompared: boolean): CarryReport {
  return { liveCompared, disabledCarried: [], tokensRevokedCarried: 0, invitesRevokedCarried: 0, adminsDemotedOrDeletedLive: [], usersDeletedLive: [], usersLostFromBackup: [], tokensCreatedLiveLost: 0, invitesCreatedLiveLost: 0 };
}

/**
 * Design 8.1: the live database is diffed against the staged copy by id. Restrictions held live (disabled users, revoked tokens
 * and invites) are applied to the staged copy; everything else that differs is only reported. If the live side cannot be
 * read (corrupt, or an old schema without the columns) nothing is applied and `liveCompared` is false.
 */
export function carryOverRestrictions(staged: Database.Database, live: Database.Database): CarryReport {
  const q = <T>(db: Database.Database, sql: string) => db.prepare(sql).all() as T[];
  type U = { id: string; username: string; is_admin: number; disabled_at: number | null };
  type R = { id: string; revoked_at: number | null };
  let liveUsers: U[], liveTokens: R[], liveInvites: R[];
  try {
    liveUsers = q<U>(live, 'select id, username, is_admin, disabled_at from users');
    liveTokens = q<R>(live, 'select id, revoked_at from api_tokens');
    liveInvites = q<R>(live, 'select id, revoked_at from campaign_invites');
  } catch {
    return emptyCarry(false);
  }
  const report = emptyCarry(true);
  const stagedUsers = new Map(q<U>(staged, 'select id, username, is_admin, disabled_at from users').map((u) => [u.id, u]));
  const liveIds = new Set(liveUsers.map((u) => u.id));
  for (const lu of liveUsers) {
    const su = stagedUsers.get(lu.id);
    if (!su) {
      report.usersLostFromBackup.push(lu.username);
      continue;
    }
    if (lu.disabled_at != null && su.disabled_at == null) {
      staged.prepare('update users set disabled_at = ? where id = ?').run(lu.disabled_at, lu.id);
      report.disabledCarried.push(su.username);
    }
    if (su.is_admin && !lu.is_admin) report.adminsDemotedOrDeletedLive.push(su.username);
  }
  for (const su of stagedUsers.values()) {
    if (!liveIds.has(su.id)) {
      report.usersDeletedLive.push(su.username);
      if (su.is_admin) report.adminsDemotedOrDeletedLive.push(su.username);
    }
  }
  const carry = (table: 'api_tokens' | 'campaign_invites', liveRows: R[]) => {
    const ids = new Set(q<{ id: string }>(staged, `select id from ${table}`).map((r) => r.id));
    let applied = 0;
    let lost = 0;
    for (const r of liveRows) {
      if (!ids.has(r.id)) lost++;
      else if (r.revoked_at != null) applied += staged.prepare(`update ${table} set revoked_at = ? where id = ? and revoked_at is null`).run(r.revoked_at, r.id).changes;
    }
    return { applied, lost };
  };
  const t = carry('api_tokens', liveTokens);
  const i = carry('campaign_invites', liveInvites);
  report.tokensRevokedCarried = t.applied;
  report.tokensCreatedLiveLost = t.lost;
  report.invitesRevokedCarried = i.applied;
  report.invitesCreatedLiveLost = i.lost;
  return report;
}

/**
 * `prepareRestoredDatabase` (design 8, step 3, in this order so that hostile schema objects never execute):
 *  1. open the staged file READ-ONLY with `trusted_schema = OFF`, `cell_size_check = ON`, `query_only = ON`;
 *  2. its own `__drizzle_migrations` rows against the build journal (7.2);
 *  3. its `sqlite_master` against a `:memory:` database migrated to the same journal prefix (rejects planted triggers,
 *     views, virtual tables, altered columns, extra indexes) BEFORE anything is migrated or written;
 *  4. `integrity_check` and `foreign_key_check`;
 *  5. reopen read-write through `openAppDbForRestore`, migrate, compare the schema with the full journal again;
 *  6. in one transaction: sessions and password resets deleted, tokens and invites revoked (unless `keepTokens`), live
 *     restrictions carried over;
 *  7. `journal_mode = DELETE`, close, no `-wal`/`-shm` beside the file;
 *  8. count uploads rows without a file, list the enabled admins, fsync, hash.
 * Throws `RestoreRefusal`; the staged file is not modified by any refusal before step 5.
 */
export async function prepareRestoredDatabase(stagedPath: string, opts: PrepareOptions = {}): Promise<PrepareReport> {
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const journal = loadJournal(dir);
  let rows: MigrationRow[];
  const ro = (() => {
    try {
      return new Database(stagedPath, { readonly: true, fileMustExist: true });
    } catch {
      throw new RestoreRefusal('invalid', 'The database in this backup cannot be opened');
    }
  })();
  let behind: number;
  try {
    ro.pragma('trusted_schema = OFF');
    ro.pragma('cell_size_check = ON');
    ro.pragma('query_only = ON');
    try {
      // Look at the table's definition in the schema before reading it: it must be the one drizzle creates
      const defs = ro.prepare(`select type, sql from sqlite_master where name = '__drizzle_migrations'`).all() as { type: string; sql: string | null }[];
      const expected = referenceSchema(1, dir).find((r) => r.name === '__drizzle_migrations');
      if (defs.length !== 1 || defs[0]?.type !== 'table' || defs[0]?.sql !== expected?.sql) throw new RestoreRefusal('invalid', 'The database in this backup has no migration history');
      rows = readMigrationRows(ro, journal.length + 1);
    } catch {
      throw new RestoreRefusal('invalid', 'The database in this backup has no migration history');
    }
    const verdict = compareMigrationRows(rows, journal);
    if (verdict.kind === 'newer') throw new RestoreRefusal('newer', 'This backup was made by a newer Critical Notes (its database has newer migrations); update before restoring it');
    if (verdict.kind === 'different') throw new RestoreRefusal('different', DIVERGED_MESSAGE);
    behind = verdict.kind === 'older' ? verdict.steps : 0;
    let diff: string | null;
    try {
      diff = compareSchema(ro, referenceSchema(rows.length, dir), true);
    } catch {
      throw new RestoreRefusal('invalid', 'The database in this backup cannot be read');
    }
    if (diff) throw new RestoreRefusal('schema', schemaRefusalMessage(diff));
    const integrity = ro.pragma('integrity_check') as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new RestoreRefusal('integrity', 'The database in this backup is damaged (integrity check failed)');
    if (ro.prepare('pragma foreign_key_check').get()) throw new RestoreRefusal('integrity', 'The database in this backup is inconsistent (foreign key check failed)');
  } catch (e) {
    if (e instanceof RestoreRefusal) throw e;
    throw new RestoreRefusal('invalid', 'The database in this backup cannot be read');
  } finally {
    ro.close();
  }

  const db = openAppDbForRestore(stagedPath, dir);
  const sqlite = db.$client;
  try {
    const finalDiff = compareSchema(sqlite, referenceSchema(journal.length, dir));
    if (finalDiff) throw new RestoreRefusal('schema', `The migrated database does not match this version (${safeText(finalDiff)})`);
    const now = opts.now ?? Date.now();
    const keepTokens = opts.keepTokens ?? false;
    const purged = { sessions: 0, passwordResets: 0, apiTokensRevoked: 0, invitesRevoked: 0 };
    let carry = emptyCarry(false);
    sqlite.transaction(() => {
      purged.sessions = sqlite.prepare('delete from sessions').run().changes;
      purged.passwordResets = sqlite.prepare('delete from password_resets').run().changes;
      if (!keepTokens) {
        purged.apiTokensRevoked = sqlite.prepare('update api_tokens set revoked_at = ? where revoked_at is null').run(now).changes;
        purged.invitesRevoked = sqlite.prepare('update campaign_invites set revoked_at = ? where revoked_at is null').run(now).changes;
      }
      if (opts.live && opts.carryRestrictions !== false) carry = carryOverRestrictions(sqlite, opts.live);
    })();
    const admins = (sqlite.prepare('select username from users where is_admin = 1 and disabled_at is null order by username').all() as { username: string }[]).map((u) => u.username);
    let missingUploads = 0;
    if (opts.stagedUploadsDir) {
      for (const r of sqlite.prepare('select id from uploads').iterate() as Iterable<{ id: string }>) if (!existsSync(join(opts.stagedUploadsDir, r.id))) missingUploads++;
    }
    sqlite.pragma('journal_mode = DELETE');
    sqlite.close();
    for (const suffix of ['-wal', '-shm']) if (existsSync(stagedPath + suffix)) throw new Error('The staged database left a journal file behind');
    const fh = await open(stagedPath, 'r+');
    let size: number;
    try {
      await fh.sync();
      size = (await fh.stat()).size;
    } finally {
      await fh.close();
    }
    const sha256 = await hashFile(stagedPath);
    return { migratedSteps: behind, purged, carry, missingUploads, admins, sha256, size };
  } finally {
    if (sqlite.open) sqlite.close();
  }
}

async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  const fh = await open(path, 'r');
  try {
    for await (const c of chunksOf(fh)) h.update(c);
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

async function* chunksOf(fh: FileHandle): AsyncGenerator<Buffer> {
  for (;;) {
    const buf = Buffer.allocUnsafe(CHUNK);
    const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
    if (bytesRead === 0) return;
    yield buf.subarray(0, bytesRead);
  }
}

// endregion

// region Service

export interface BackupInfo {
  name: string;
  size: number;
  /** ISO time parsed from the name. */
  createdAt: string;
  /** From the manifest; `api` for anything unreadable (conservative). */
  trigger: Trigger;
  /** Manifest facts for the list (null when the manifest cannot be read in full). Never includes anything but counts and versions. */
  detail: ManifestSummary['detail'];
}

/** Why the last backup failed, as a stable code: routes show a fixed sentence per code, never `lastError` text. */
export type BackupFailureCode = 'disk' | 'no-space' | 'verify' | 'too-many-files' | 'db-timeout' | 'failed';

export interface BackupStatus {
  running: { name: string; startedAt: string } | null;
  lastError: string | null;
  lastErrorCode: BackupFailureCode | null;
  lastWarnings: string[];
}

export interface CreateResult {
  name: string;
  size: number;
  /** sha256 of the zip file. */
  sha256: string;
  trigger: Trigger;
  missingUploads: number;
  warnings: string[];
}

export interface LeasedBackup {
  name: string;
  size: number;
  handle: FileHandle;
  /** Closes the descriptor and ends the lease (idempotent); a leased name is skipped by `prune`. */
  release(): Promise<void>;
}

export interface BackupServiceOptions {
  db: AppDb;
  config: Pick<AppConfig, 'dataDir' | 'uploadsDir' | 'backupDir' | 'backupKeep' | 'webDistDir' | 'fivetoolsSrcPath' | 'fivetoolsImgPath'>;
  /** Clock for names and ages (default `Date.now`). */
  now?: () => number;
  /** Audit sink (default: one JSON line on stdout; the CLI passes a stderr variant). */
  audit?: (event: string, fields: Record<string, unknown>) => void;
  /** Pages per step for the database copy (default 100; the CLI uses 2000). */
  stepPages?: number;
  dbTimeoutMs?: number;
  lock?: LockOptions;
  /** Defaults to the design limit of 200,000; lowered by tests. */
  maxUploadFiles?: number;
  migrationsDir?: string;
  /** Write `backup.created` to `DATA_DIR/restore-log.jsonl` (default true). */
  opsLog?: boolean;
  warn?: (message: string) => void;
  /** Test seams. */
  hooks?: {
    beforeSnapshot?: () => void | Promise<void>;
    afterSnapshot?: () => void | Promise<void>;
    afterEnumerate?: (names: string[]) => void | Promise<void>;
    onZipWrite?: (bytesSoFar: number) => void;
    onManifestRead?: (name: string) => void;
    beforeVerify?: (partialPath: string) => void | Promise<void>;
    freeBytes?: () => number | Promise<number>;
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export function backupNameFor(ms: number): string {
  const d = new Date(ms);
  return `backup-${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z.zip`;
}
/** Epoch ms from a backup file name (UTC), or null when the name does not match. */
export function timestampOfName(name: string): number | null {
  const m = BACKUP_NAME_RE.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

async function* readChunks(fh: FileHandle): AsyncGenerator<Buffer> {
  yield* chunksOf(fh);
}

function* slices(buf: Buffer): Generator<Buffer> {
  for (let i = 0; i < buf.length; i += CHUNK) yield buf.subarray(i, i + CHUNK);
}

export class BackupService {
  readonly dir: string;
  private readonly cfg: BackupServiceOptions['config'];
  private readonly db: AppDb;
  private readonly now: () => number;
  private readonly auditFn: (event: string, fields: Record<string, unknown>) => void;
  private readonly lock: BackupLock;
  private readonly maxUploads: number;
  private readonly cache = new Map<string, ManifestSummary>();
  private readonly leases = new Map<string, number>();
  private running: { name: string; startedAt: number } | null = null;
  private lastError: string | null = null;
  private lastErrorCode: BackupFailureCode | null = null;
  private lastWarnings: string[] = [];
  private readonly journal: JournalEntry[];

  constructor(private readonly opts: BackupServiceOptions) {
    this.cfg = opts.config;
    this.db = opts.db;
    this.now = opts.now ?? Date.now;
    this.auditFn = opts.audit ?? defaultAudit;
    // Throws (the server/CLI refuses to start) for a directory inside the web build, uploads, 5etools or the data root
    const { dir, warnings } = validateBackupDir(opts.config);
    for (const w of warnings) (opts.warn ?? ((m: string) => console.warn(m)))(w);
    ensureBackupDir(dir);
    this.dir = dir;
    this.lock = new BackupLock(dir, opts.lock);
    this.maxUploads = Math.min(opts.maxUploadFiles ?? MAX_UPLOAD_FILES, MAX_UPLOAD_FILES);
    this.journal = loadJournal(opts.migrationsDir);
    this.cleanupLeftovers();
  }

  /** True while this process runs a backup. A later purge of upload files must not unlink anything while this is true (design 4). */
  isRunning(): boolean {
    return this.running !== null;
  }

  status(): BackupStatus {
    return {
      running: this.running ? { name: this.running.name, startedAt: new Date(this.running.startedAt).toISOString() } : null,
      lastError: this.lastError,
      lastErrorCode: this.lastErrorCode,
      lastWarnings: [...this.lastWarnings],
    };
  }

  private audit(event: string, fields: Record<string, unknown>) {
    try {
      this.auditFn(event, fields);
    } catch {
      // an audit sink must never break a backup
    }
  }

  /** Removes `.partial-*`, `.tmp-*` and `.lock.stale-*` older than one hour, unless a live lock says a backup is running. */
  cleanupLeftovers(): void {
    try {
      const lockPath = join(this.dir, '.lock');
      if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs <= (this.opts.lock?.staleMs ?? 120_000)) return;
      for (const name of readdirSync(this.dir)) {
        if (!/^\.(partial-[0-9a-f]{12}\.zip|tmp-[0-9a-f]{12}|lock\.stale-[0-9a-f]{12})$/.test(name)) continue;
        const p = join(this.dir, name);
        if (Date.now() - statSync(p).mtimeMs > LEFTOVER_MAX_AGE_MS) rmSync(p, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
  }

  private async manifestOf(name: string, size: number): Promise<ManifestSummary> {
    const key = `${name}\0${size}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    // An unreadable manifest is classed `api` (conservative)
    const t = (await readManifestHead(join(this.dir, name), () => this.opts.hooks?.onManifestRead?.(name))) ?? { trigger: 'api' as const, detail: null };
    this.cache.set(key, t);
    return t;
  }

  /** Backups in the folder, newest first. Only regular files whose name matches the pattern; nothing else is read or touched. */
  async list(): Promise<BackupInfo[]> {
    const names = (await readdir(this.dir).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? [] : Promise.reject(e)))).filter((n) => BACKUP_NAME_RE.test(n));
    const out: BackupInfo[] = [];
    const live = new Set<string>();
    for (const name of names) {
      const st = await lstat(join(this.dir, name)).catch(() => null);
      if (!st || !st.isFile()) continue;
      live.add(`${name}\0${st.size}`);
      const m = await this.manifestOf(name, st.size);
      out.push({ name, size: st.size, createdAt: new Date(timestampOfName(name) as number).toISOString(), trigger: m.trigger, detail: m.detail });
    }
    for (const k of this.cache.keys()) if (!live.has(k)) this.cache.delete(k);
    return out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  }

  /**
   * Retention (design 11). Protected set P: API-created backups younger than 7 days (always kept, not counted). Ranked set
   * R: everything else, by the name's timestamp, newest first; the newest `keep` of R are kept. An unrestricted prune (CLI,
   * scheduler) may delete any other member of R; an API prune only those aged 7 days or more. `keep` is at least 1.
   */
  async prune(keep: number, origin: Trigger): Promise<string[]> {
    if (!isTrigger(origin)) throw new TypeError('prune origin must be api, cli or scheduler');
    const k = Math.max(1, Math.floor(Number.isFinite(keep) ? keep : 1));
    const now = this.now();
    const age = (b: BackupInfo) => now - (timestampOfName(b.name) as number);
    const ranked = (await this.list()).filter((b) => !(b.trigger === 'api' && age(b) < API_PRUNE_MIN_AGE_MS));
    let candidates = ranked.slice(k);
    if (origin === 'api') candidates = candidates.filter((b) => age(b) >= API_PRUNE_MIN_AGE_MS);
    const removed: string[] = [];
    for (const b of candidates) {
      if (this.leases.has(b.name)) continue;
      try {
        await unlink(join(this.dir, b.name));
      } catch {
        continue;
      }
      removed.push(b.name);
      this.audit('backup.pruned', { name: b.name, reason: 'beyond keep', origin, keep: k });
    }
    return removed;
  }

  /** Throws `BackupError('api-cap')` when the web page already made `3 x keep` backups that are younger than 7 days (design 11). */
  async assertApiCreateAllowed(): Promise<void> {
    const young = (await this.list()).filter((b) => b.trigger === 'api' && this.now() - (timestampOfName(b.name) as number) < API_PRUNE_MIN_AGE_MS).length;
    if (young >= API_CREATE_CAP_FACTOR * this.cfg.backupKeep) {
      throw new BackupError('api-cap', `Too many recent backups were made from the web page (${young}); older ones are released after ${API_PRUNE_MIN_AGE_DAYS} days. Use the command line instead: node dist/admin.mjs backup`);
    }
  }

  /** Opens a backup for download: validated name, `O_NOFOLLOW`, regular file, leased until released. */
  async openForDownload(name: string, actor?: string, extra: { ip?: string; audit?: boolean } = {}): Promise<LeasedBackup> {
    if (!BACKUP_NAME_RE.test(name)) throw new BackupError('not-found', 'Not found');
    let handle: FileHandle;
    try {
      // O_NONBLOCK: opening a FIFO named like a backup must not hang (it then fails the regular-file check below)
      handle = await open(join(this.dir, name), fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
    } catch {
      throw new BackupError('not-found', 'Not found');
    }
    const st = await handle.stat();
    // nlink !== 1: a hard link to some other file (the backups folder is not the only name for these bytes) is not a backup
    if (!st.isFile() || st.nlink !== 1) {
      await handle.close();
      throw new BackupError('not-found', 'Not found');
    }
    this.leases.set(name, (this.leases.get(name) ?? 0) + 1);
    let released = false;
    if (extra.audit !== false) this.audit('backup.downloaded', { actor, name, ...(extra.ip ? { ip: extra.ip } : {}) });
    return {
      name,
      size: st.size,
      handle,
      release: async () => {
        if (released) return;
        released = true;
        const n = (this.leases.get(name) ?? 1) - 1;
        if (n <= 0) this.leases.delete(name);
        else this.leases.set(name, n);
        await handle.close().catch(() => undefined);
      },
    };
  }

  private async enumerateUploads(): Promise<{ names: string[]; bytes: number; skipped: string[] }> {
    const all = (await readdir(this.cfg.uploadsDir)).filter((n) => UPLOAD_FILE_RE.test(n)).sort();
    if (all.length > this.maxUploads) {
      throw new BackupError('too-many-files', `The uploads folder holds ${all.length.toLocaleString('en')} files; a backup holds at most ${this.maxUploads.toLocaleString('en')}`);
    }
    const names: string[] = [];
    const skipped: string[] = [];
    let bytes = 0;
    for (let i = 0; i < all.length; i += 128) {
      const batch = all.slice(i, i + 128);
      const stats = await Promise.all(batch.map((n) => lstat(join(this.cfg.uploadsDir, n)).catch(() => null)));
      batch.forEach((n, j) => {
        const st = stats[j];
        if (!st) return; // vanished
        if (!st.isFile()) skipped.push(n); // symlinks and directories are never archived
        else {
          names.push(n);
          bytes += st.size;
        }
      });
    }
    return { names, bytes, skipped };
  }

  private freeBytes(): Promise<number> | number {
    if (this.opts.hooks?.freeBytes) return this.opts.hooks.freeBytes();
    return statfs(this.dir).then((s) => Number(s.bavail) * Number(s.bsize));
  }

  /**
   * Writes `backup-<UTC timestamp>.zip` (design 3 to 6, 11): lock, preflight, database snapshot FIRST, then the uploads, then
   * `checksums.json` last; verified by the restore reader before it is published by an atomic no-clobber link and an
   * fsynced directory; pruned afterwards. `trigger` is set by the entry point (route, CLI, scheduler) and never taken from input.
   */
  async create(args: { actor: string; trigger: Trigger; ip?: string }): Promise<CreateResult> {
    const { actor, trigger } = args;
    const ipField = args.ip ? { ip: args.ip } : {};
    if (!isTrigger(trigger)) throw new TypeError('trigger must be api, cli or scheduler');
    if (this.running) throw new BackupError('busy', 'A backup is already running');
    if (restoreMarkerExists(this.cfg.dataDir)) throw new BackupError('restore-in-progress', 'A restore is running or was interrupted; backups are refused until it is finished');
    // Set before the first await: this is the in-process mutex
    this.running = { name: '', startedAt: this.now() };
    const tmpDir = join(this.dir, `.tmp-${randomBytes(6).toString('hex')}`);
    const partial = join(this.dir, `.partial-${randomBytes(6).toString('hex')}.zip`);
    let locked = false;
    try {
      ensureBackupDir(this.dir); // it may have been removed (or a mount gone) since the service started
      if (trigger === 'api') await this.assertApiCreateAllowed();
      this.cleanupLeftovers(); // before our own lock exists: with a fresh lock (ours included) it deliberately does nothing
      await this.lock.acquire();
      locked = true;
      let name = backupNameFor(this.now());
      while (existsSync(join(this.dir, name))) name = backupNameFor((timestampOfName(name) as number) + 1000);
      this.running = { name, startedAt: this.running.startedAt };

      // Preflight, before anything is created
      const dbBytes = Number((this.db.$client.pragma('page_count', { simple: true }) as number) * (this.db.$client.pragma('page_size', { simple: true }) as number));
      const pre = await this.enumerateUploads();
      const need = dbBytes + dbBytes + pre.bytes + 64 * MiB;
      const free = await this.freeBytes();
      if (free < need) {
        throw new BackupError(
          'disk',
          `Not enough free space for a backup: ${Math.ceil(need / MiB)} MiB needed, ${Math.floor(free / MiB)} MiB free in ${this.dir}. Lower BACKUP_KEEP, free space or point BACKUP_DIR at a larger disk`,
        );
      }

      await mkdir(tmpDir, { mode: 0o700 });
      await chmod(tmpDir, 0o700); // whatever the umask
      await this.opts.hooks?.beforeSnapshot?.();
      // T0: the database snapshot comes FIRST, so every row in it has its file already in the listing taken at T1 > T0
      const snap = await snapshotDatabase(this.db.$client, join(tmpDir, 'app.sqlite'), { stepPages: this.opts.stepPages, timeoutMs: this.opts.dbTimeoutMs, journal: this.journal });
      if (snap.bytes > MAX_DB_ENTRY_BYTES) throw new Error('The database is 4 GiB or larger; a backup cannot hold it');
      await this.opts.hooks?.afterSnapshot?.();
      const listing = await this.enumerateUploads();
      await this.opts.hooks?.afterEnumerate?.(listing.names);
      const warnings: string[] = listing.skipped.map(() => 'A symlink or non-file in uploads/ was not backed up');
      const present = new Set(listing.names);
      const missing = snap.uploadIds.filter((id) => !present.has(id)).length;
      if (missing) warnings.push(`${missing} upload${missing === 1 ? ' has' : 's have'} no file on disk and could not be backed up`);

      const createdMs = this.now();
      const manifest: Manifest = {
        kind: MANIFEST_KIND,
        format: MANIFEST_FORMAT,
        createdAt: new Date(createdMs).toISOString(),
        trigger,
        app: { version: appVersion() },
        database: {
          engine: 'sqlite',
          sqliteVersion: snap.sqliteVersion,
          bytes: snap.bytes,
          migrations: snap.migrations,
          latestTag: snap.migrations.at(-1)?.tag ?? null,
          latestWhen: snap.migrations.at(-1)?.when ?? null,
        },
        counts: snap.counts,
        uploads: { files: listing.names.length, bytes: listing.bytes, missing },
      };

      const fh = await open(partial, 'wx', 0o600);
      let sha256: string;
      let size: number;
      let vanished = 0;
      try {
        await fh.chmod(0o600);
        const writer = new ZipFileWriter(fh, { mtime: new Date(createdMs), onWrite: this.opts.hooks?.onZipWrite });
        await writer.addFile('manifest.json', 1, slices(Buffer.from(JSON.stringify(manifest))));
        const entries: { path: string; size: number; sha256: string }[] = [];
        const dbFh = await open(join(tmpDir, 'app.sqlite'), 'r');
        try {
          const r = await writer.addFile('app.sqlite', 6, readChunks(dbFh));
          entries.push({ path: 'app.sqlite', ...r });
        } finally {
          await dbFh.close();
        }
        for (const n of listing.names) {
          let up: FileHandle;
          try {
            up = await open(join(this.cfg.uploadsDir, n), fsc.O_RDONLY | fsc.O_NOFOLLOW);
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ELOOP') {
              vanished++;
              continue;
            }
            throw e;
          }
          try {
            if (!(await up.stat()).isFile()) {
              vanished++;
              continue;
            }
            const r = await writer.addFile(`uploads/${n}`, 1, readChunks(up));
            entries.push({ path: `uploads/${n}`, ...r });
          } finally {
            await up.close();
          }
        }
        await writer.addFile('checksums.json', 1, slices(Buffer.from(JSON.stringify({ entries }))));
        await writer.finish();
        await fh.sync();
        sha256 = writer.digest();
        size = writer.bytesWritten;
      } finally {
        await fh.close();
      }
      if (vanished) warnings.push(`${vanished} upload file${vanished === 1 ? ' was' : 's were'} removed while the backup ran and ${vanished === 1 ? 'is' : 'are'} not in it`);

      // Verify before publish: the same reader restore uses, the same limits. A failure publishes nothing and prunes nothing.
      await this.opts.hooks?.beforeVerify?.(partial);
      await readBackup(partial);

      const finalName = await this.publish(partial, name);
      this.lastWarnings = warnings;
      this.lastError = null;
      this.lastErrorCode = null;
      this.audit('backup.created', { actor, name: finalName, size, trigger, missingUploads: missing, ...ipField });
      if (this.opts.opsLog !== false) {
        try {
          appendOpsLog(this.cfg.dataDir, 'backup.created', { name: finalName, size, sha256, trigger, actor }, this.now());
        } catch (e) {
          (this.opts.warn ?? ((m: string) => console.warn(m)))(`Could not write ${this.cfg.dataDir}/restore-log.jsonl: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      try {
        await this.prune(this.cfg.backupKeep, trigger);
      } catch (e) {
        // The backup is published and good; a failed retention pass must not turn it into a failed backup
        const reason = e instanceof Error ? e.message.slice(0, 200) : 'Unknown error';
        this.audit('backup.prune_failed', { actor, reason });
        warnings.push('Old backups could not be pruned; check the backup folder');
      }
      this.lastWarnings = warnings;
      return { name: finalName, size, sha256, trigger, missingUploads: missing, warnings };
    } catch (e) {
      const reason = describeFailure(e);
      if (!(e instanceof BackupError && (e.code === 'busy' || e.code === 'restore-in-progress'))) {
        this.lastError = reason;
        this.lastErrorCode = failureCode(e);
        this.audit('backup.failed', { actor, trigger, reason, ...ipField });
      }
      throw e;
    } finally {
      await rm(partial, { force: true }).catch(() => undefined);
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      if (locked) await this.lock.release();
      this.running = null;
    }
  }

  /** Atomic, no-clobber publish: `link()` fails with EEXIST instead of overwriting; the timestamp advances a second until free. */
  private async publish(partial: string, wanted: string): Promise<string> {
    let name = wanted;
    for (let i = 0; i < 120; i++) {
      try {
        await link(partial, join(this.dir, name));
        await unlink(partial);
        await fsyncDir(this.dir);
        return name;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
          if (['EPERM', 'ENOTSUP', 'EXDEV', 'EMLINK'].includes((e as NodeJS.ErrnoException).code ?? '') && !existsSync(join(this.dir, name))) {
            await rename(partial, join(this.dir, name)); // file systems without hard links
            await fsyncDir(this.dir);
            return name;
          }
          throw e;
        }
        name = backupNameFor((timestampOfName(name) as number) + 1000);
      }
    }
    throw new Error('Could not find a free backup name');
  }
}

async function fsyncDir(dir: string): Promise<void> {
  const fd = await open(dir, fsc.O_RDONLY | fsc.O_DIRECTORY);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}

export function failureCode(e: unknown): BackupFailureCode {
  if (e instanceof BackupZipError) return 'verify';
  if (e instanceof BackupError) return e.code === 'disk' || e.code === 'too-many-files' || e.code === 'db-timeout' ? e.code : 'failed';
  if ((e as NodeJS.ErrnoException)?.code === 'ENOSPC') return 'no-space';
  return 'failed';
}

function describeFailure(e: unknown): string {
  if (e instanceof BackupZipError) return e.code === 'invalid' ? `The backup failed its verification pass (${e.detail})` : e.message;
  if (e instanceof BackupError) return e.message;
  if ((e as NodeJS.ErrnoException)?.code === 'ENOSPC') return 'Out of disk space while writing the backup';
  return e instanceof Error ? e.message.slice(0, 200) : 'Unknown error';
}

// endregion
