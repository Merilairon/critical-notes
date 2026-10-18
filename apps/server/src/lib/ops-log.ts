import { closeSync, constants, fchmodSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const OPS_LOG_NAME = 'restore-log.jsonl';

export type OpsLogEvent = 'backup.created' | 'restore.started' | 'restore.completed' | 'restore.aborted';

/**
 * Durable, append-only record of backups and restores (docs/design/backup.md 8.2): `DATA_DIR/restore-log.jsonl`, mode 0600,
 * one JSON object per line, `fsync`ed per record. It lives outside every swapped path, so it survives a restore.
 * Never pass secrets; usernames do not belong here either.
 */
export function appendOpsLog(dataDir: string, event: OpsLogEvent, fields: Record<string, unknown> = {}, now = Date.now()): void {
  const path = join(dataDir, OPS_LOG_NAME);
  const line = `${JSON.stringify({ ...fields, event, at: new Date(now).toISOString() })}\n`;
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600); // never follows a planted link
  try {
    fchmodSync(fd, 0o600); // on the descriptor, not the path: an existing file with a wider mode is tightened too, whatever the umask
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
