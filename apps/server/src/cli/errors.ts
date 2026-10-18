/** Exit codes and the error type of the admin command line. Separate from `admin-core.ts` so the command modules can share them without a cycle. */

/**
 * Exit codes. 0 ok; 1 to 3 and 64 and 70 are the original reset-link codes. The rest follow sysexits where one fits:
 * 65 invalid backup, 66 newer backup, 67 diverged history, 69 server running, 71 restore rolled back, 72 cancelled,
 * 74 disk full, 75 restore in progress, 76 a backup is already running, 77 rollback failed, 78 cannot lock app.sqlite.
 */
export const EXIT = {
  ok: 0,
  unknownUser: 1,
  disabledUser: 2,
  notFound: 3,
  usage: 64,
  invalidBackup: 65,
  newerBackup: 66,
  divergedBackup: 67,
  serverRunning: 69,
  failed: 70,
  rolledBack: 71,
  cancelled: 72,
  diskFull: 74,
  restoreInProgress: 75,
  backupBusy: 76,
  rollbackFailed: 77,
  cannotLock: 78,
} as const;

/** A failure with the message for stderr and the exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}
