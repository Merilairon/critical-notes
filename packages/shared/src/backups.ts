/** Instance backups (Task M3.4, docs/design/backup.md 10, 11 and 13). Admin-only routes under /api/admin/backups. */
import { z } from 'zod';

/** A backup file name; the server checks it before touching the file system. Anything else is a uniform 404. */
export const BACKUP_NAME_PATTERN = /^backup-\d{8}T\d{6}Z\.zip$/;

/** Download step-up: the acting admin's own password, exchanged for a one-use 60 second ticket. */
export const backupTicketInput = z.object({ currentPassword: z.string().min(1).max(200) }).strict();
export type BackupTicketInput = z.infer<typeof backupTicketInput>;

export type BackupTrigger = 'api' | 'cli' | 'scheduler';

export interface BackupCountsDto {
  users: number;
  campaigns: number;
  uploads: number;
}

export interface BackupDto {
  name: string;
  /** Bytes. */
  size: number;
  /** ISO time, parsed from the name (UTC). */
  createdAt: string;
  /** Who started it. `api` for any file whose manifest cannot be read. */
  trigger: BackupTrigger;
  /** From the manifest; null when the manifest could not be read. Informational only. */
  appVersion: string | null;
  /** Tag of the newest applied migration (e.g. `0006_accounts`), or null. */
  migrationLevel: string | null;
  counts: BackupCountsDto | null;
  /** Upload rows that had no file when the backup was made. */
  missingUploads: number | null;
}

export interface BackupListDto {
  backups: BackupDto[];
  /** A backup in progress. `name` is null until the backup holds its lock. */
  running: { name: string | null; startedAt: string } | null;
  /** A fixed sentence about the last failed backup (never raw error text or paths), cleared by the next success. */
  lastError: string | null;
  /** Fixed sentences about the last successful backup (e.g. uploads without a file). */
  lastWarnings: string[];
  /** Scheduled backups (`BACKUP_EVERY_HOURS`); null = off. `nextRunAt` is an ISO time, null while it is being worked out. */
  schedule: { everyHours: number; nextRunAt: string | null } | null;
}

/**
 * 202 answer to "Back up now". `running`: the backup goes on, poll the list. `done`: it already ended within the first
 * moments (finished, or failed: the list carries `lastError`). Refusals are not 202: see the error table in STATUS.md.
 */
export interface BackupStartedDto {
  name: string | null;
  status: 'running' | 'done';
}

/** One-use download ticket: pass it as `?ticket=` to the download URL within `expiresInSec`. */
export interface BackupTicketDto {
  ticket: string;
  expiresInSec: number;
}
