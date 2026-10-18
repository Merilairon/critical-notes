/**
 * `node dist/admin.mjs <command>`: `reset-link <username>` (docs/design/accounts.md 4.6), `backup` and `restore <file>`
 * (docs/design/backup.md). The logic is in `run.ts` and `admin-core.ts`; this entry only wires the process.
 * stdout carries only the result; diagnostics and audit lines go to stderr.
 */
import { runAdmin, terminalConfirm } from './run';

process.exitCode = await runAdmin(process.argv.slice(2), {
  out: (t) => console.log(t),
  err: (t) => console.error(t),
  confirm: terminalConfirm(),
});
