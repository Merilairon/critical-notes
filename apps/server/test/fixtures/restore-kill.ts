/**
 * Child process for the crash tests: runs `restore <zip> --yes` and SIGKILLs itself when the restore reaches the point named in
 * KILL_AT (see RestoreHooks.at). RACER=link plants a persistent racing database just before the install (forcing a rollback).
 * argv: <config json> <zip>
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAdmin } from '../../src/cli/run';

const config = JSON.parse(process.argv[2] ?? '{}');
const zip = process.argv[3] ?? '';
const killAt = process.env.KILL_AT;

const code = await runAdmin(['restore', zip, '--yes'], {
  config,
  out: () => undefined,
  err: () => undefined,
  restoreHooks: {
    at(point) {
      if (process.env.RACER === 'link' && point === 'install:beforeLink') writeFileSync(join(config.dataDir, 'app.sqlite'), 'a racing database');
      if (point === killAt) process.kill(process.pid, 'SIGKILL');
    },
  },
});
process.exit(code);
