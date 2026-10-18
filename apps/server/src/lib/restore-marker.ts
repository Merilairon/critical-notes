/**
 * The restore marker `DATA_DIR/.restore-in-progress` (docs/design/backup.md 7.1). Kept tiny and dependency-free so that
 * `main.ts` can check it at the very top, before it touches anything in the data directory.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RESTORE_MARKER = '.restore-in-progress';

export const restoreMarkerPath = (dataDir: string) => join(dataDir, RESTORE_MARKER);

/** True when the marker (or anything named like it, even a dangling link) exists. */
export function restoreMarkerExists(dataDir: string): boolean {
  try {
    lstatSync(restoreMarkerPath(dataDir));
    return true;
  } catch {
    return false;
  }
}

export const ROLLBACK_STEPS = ['removeInstalled', 'uploadsBack', 'liveBack', 'deleteStaging', 'finalize'] as const;
export type RollbackStep = (typeof ROLLBACK_STEPS)[number];
/** The only file names a restore ever moves aside or back: anything else in a marker is not ours. */
export const LIVE_DB_NAMES = ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm'] as const;

/** What the restore records before every step (JSON, written atomically). Names, sizes and hashes only: no secrets. */
export interface RestoreMarker {
  v: 1;
  startedAt: string;
  user: { uid: number; name: string };
  zip: { name: string; sha256: string; size: number };
  /** Directory NAMES inside DATA_DIR (validated against a strict pattern before use). */
  staging: string;
  preRestore: string;
  flags: { keepTokens: boolean; carryRestrictions: boolean };
  phase: 'started' | 'staged' | 'swapping';
  /** The step that is about to run or was running when the process died. */
  next: string;
  /** sha256 and size of the staged `app.sqlite`, recorded when the phase becomes `staged`. */
  staged?: { sha256: string; size: number };
  /** Live files moved into the pre-restore directory; `null` until the move list was written (step 2 has not started). */
  liveMoved: { name: string; size: number }[] | null;
  /** Whether a live `uploads/` existed when its move was planned; `null` = not planned yet. */
  uploadsLive: boolean | null;
  /** Everything the final report needs, so that a resumed run can still print it. */
  report?: Record<string, unknown>;
  rollingBack?: { reason: string; next: RollbackStep; failed?: boolean };
  resumes?: number;
}

export const STAGING_NAME_RE = /^\.restore-\d{8}T\d{6}Z(-\d{1,3})?$/;
export const PRE_RESTORE_NAME_RE = /^pre-restore-\d{8}T\d{6}Z(-\d{1,3})?$/;

/** Shape check of everything the restore later acts on: a marker is a file on disk and may be damaged or planted. */
function validMarker(m: RestoreMarker): boolean {
  const isStr = (v: unknown): v is string => typeof v === 'string';
  if (!m || m.v !== 1 || !STAGING_NAME_RE.test(m.staging) || !PRE_RESTORE_NAME_RE.test(m.preRestore)) return false;
  if (!isStr(m.zip?.name) || !/^[0-9a-f]{64}$/.test(m.zip?.sha256 ?? '')) return false;
  if (!isStr(m.user?.name) || typeof m.user?.uid !== 'number' || !isStr(m.startedAt) || !isStr(m.next)) return false;
  if (!['started', 'staged', 'swapping'].includes(m.phase)) return false;
  if (typeof m.flags?.keepTokens !== 'boolean' || typeof m.flags?.carryRestrictions !== 'boolean') return false;
  if (m.staged !== undefined && (!/^[0-9a-f]{64}$/.test(m.staged?.sha256 ?? '') || typeof m.staged?.size !== 'number')) return false;
  if (m.liveMoved !== null && (!Array.isArray(m.liveMoved) || !m.liveMoved.every((f) => (LIVE_DB_NAMES as readonly string[]).includes(f?.name) && typeof f.size === 'number'))) return false;
  if (m.uploadsLive !== null && typeof m.uploadsLive !== 'boolean') return false;
  if (m.rollingBack !== undefined && !(ROLLBACK_STEPS as readonly string[]).includes(m.rollingBack?.next)) return false;
  return true;
}

/** The parsed marker, `null` when there is none, `'unreadable'` when it exists but is not a marker this version can read. */
export function readRestoreMarker(dataDir: string): RestoreMarker | null | 'unreadable' {
  if (!restoreMarkerExists(dataDir)) return null;
  try {
    const m = JSON.parse(readFileSync(restoreMarkerPath(dataDir), 'utf8')) as RestoreMarker;
    return validMarker(m) ? m : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 120);

/** The message every refusing caller (server start, other CLI commands) prints while the marker exists. */
export function restoreBlockedMessage(dataDir: string): string {
  const m = readRestoreMarker(dataDir);
  const where = restoreMarkerPath(dataDir);
  const lines = ['A restore is running or was interrupted, so this is refused until it is finished.'];
  if (m && m !== 'unreadable') {
    lines.push(`  Restore of ${clean(m.zip.name)} started ${clean(m.startedAt)} by ${clean(m.user.name)}; stopped at step "${clean(m.next)}"${m.rollingBack ? ' while rolling back' : ''}.`);
    lines.push('  To FINISH it: stop the server (docker compose stop app) and run the same command again:');
    lines.push('    node dist/admin.mjs restore <the same backup file> [the same flags]');
    lines.push(m.rollingBack ? '  A rollback was under way: running restore again continues the rollback and brings the old state back.' : '  If the swap had not started yet, running it again simply starts over.');
    lines.push('  With Docker: docker compose run --rm app node admin.mjs restore <the same backup file> [the same flags]');
    lines.push(`  To ABORT by hand: your previous data is in ${clean(m.preRestore)}/ inside the data directory (restore its files and uploads/ to their old places), then delete ${where}.`);
  } else {
    lines.push(`  The marker ${where} cannot be read. Look at the data directory for pre-restore-* and .restore-* folders, finish or undo the restore by hand, then delete the marker.`);
  }
  return lines.join('\n');
}

/**
 * Server start guard (design 7.1): if the marker exists, print why and exit 1. `main.ts` calls it at the very top (before
 * `ensureDataDirs` and `openIndexDb`) and again right after `openAppDb`; `onRefuse` runs first (closes the database).
 * `restart: unless-stopped` crash-loops harmlessly while the marker exists, which is intended.
 */
export function refuseWhileRestoring(dataDir: string, onRefuse?: () => void, exit: (code: number) => never = (c) => process.exit(c)): void {
  if (!restoreMarkerExists(dataDir)) return;
  try {
    onRefuse?.();
  } finally {
    console.error(`Critical Notes did not start.\n${restoreBlockedMessage(dataDir)}`);
    exit(1);
  }
}
