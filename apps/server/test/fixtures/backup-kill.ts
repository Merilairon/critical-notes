/** Child process for the "killed during creation" test: starts a backup and SIGKILLs itself on the second write. */
import { openAppDb } from '../../src/db';
import { BackupService } from '../../src/services/backups';

const config = JSON.parse(process.argv[2] ?? '{}');
const db = openAppDb(config.appDbPath);
const service = new BackupService({
  db,
  config,
  opsLog: false,
  warn: () => undefined,
  audit: () => undefined,
  hooks: {
    onZipWrite: (bytesSoFar) => {
      if (bytesSoFar > 0) process.kill(process.pid, 'SIGKILL');
    },
  },
});
await service.create({ actor: 'kill-test', trigger: 'cli' });
