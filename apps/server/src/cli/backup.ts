/**
 * `node dist/admin.mjs backup` (Task M3.3, docs/design/backup.md 10 and 11): the same `BackupService.create` the web page will
 * use, started by the host with trigger `cli`. stdout is the path of the new zip; everything else goes to stderr.
 */
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../config';
import { openAppDbNoMigrate } from '../db';
import { BackupError, BackupService, BackupZipError } from '../services/backups';
import { CliError, EXIT } from './errors';

/** The OS user for audit records (uid when the user has no passwd entry, as in a container started with a random uid). */
export function osActor(): string {
  const uid = process.getuid?.() ?? -1;
  try {
    return `${userInfo().username}`;
  } catch {
    return `uid-${uid}`;
  }
}

export interface BackupCommandEnv {
  config: AppConfig;
  info: (msg: string) => void;
  actor?: string;
}

export async function backupCommand(args: string[], env: BackupCommandEnv): Promise<string> {
  if (args.length) throw new CliError('Usage: admin backup', EXIT.usage);
  const { config, info } = env;
  if (!existsSync(config.appDbPath)) throw new CliError(`No database at ${config.appDbPath}. Check DATA_DIR (inside Docker: run this in the app container).`, EXIT.notFound);
  const db = openAppDbNoMigrate(config.appDbPath);
  try {
    const service = new BackupService({
      db,
      config,
      stepPages: 2000, // a larger step: fewer restarts if the server writes meanwhile
      audit: (event, fields) => info(JSON.stringify({ event, ...fields, at: new Date().toISOString() })), // stderr: stdout is the path only
      warn: (m) => info(m),
    });
    info('Backing up. If the server is busy writing, a copy made from the command line can be restarted again and again and may give up after 10 minutes; run it when the instance is quiet.');
    const r = await service.create({ actor: env.actor ?? osActor(), trigger: 'cli' });
    for (const w of r.warnings) info(`Warning: ${w}`);
    info(`Backup ${r.name}: ${(r.size / (1024 * 1024)).toFixed(1)} MiB; it holds every password hash and every campaign secret, so treat it like the database (keep a copy off this machine, encrypted).`);
    return join(service.dir, r.name);
  } catch (e) {
    throw mapBackupError(e);
  } finally {
    db.$client.close();
  }
}

export function mapBackupError(e: unknown): CliError {
  if (e instanceof CliError) return e;
  if (e instanceof BackupError) {
    switch (e.code) {
      case 'busy':
        return new CliError(`${e.message}. Wait for it to finish (a backup that was killed looks "running" for 2 minutes) and run it again.`, EXIT.backupBusy);
      case 'restore-in-progress':
        return new CliError(e.message, EXIT.restoreInProgress);
      case 'disk':
        return new CliError(e.message, EXIT.diskFull);
      default:
        return new CliError(e.message, EXIT.failed);
    }
  }
  if (e instanceof BackupZipError) return new CliError(`The new backup failed its verification pass (${e.detail}); nothing was kept.`, EXIT.failed);
  if ((e as NodeJS.ErrnoException)?.code === 'ENOSPC') return new CliError('Out of disk space while writing the backup; nothing was kept.', EXIT.diskFull);
  return new CliError(`Failed: ${e instanceof Error ? e.message : String(e)}`, EXIT.failed);
}
