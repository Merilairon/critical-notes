/**
 * The admin command line, minus the process: `runAdmin(argv, io)` returns the exit code, so tests can call it.
 * Config comes from `loadConfig()` like main.ts (environment, then the repo-root `.env` unless CN_SKIP_DOTENV).
 * stdout carries only the result; diagnostics and audit lines go to stderr.
 */
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadConfig, type AppConfig } from '../config';
import { openAppDb } from '../db';
import { restoreBlockedMessage, restoreMarkerExists } from '../lib/restore-marker';
import { CliError, EXIT, SUBCOMMANDS, usage, type CliContext } from './admin-core';

const DEFAULT_PUBLIC_URL = 'http://localhost:4200';

export interface AdminIo {
  out: (text: string) => void;
  err: (text: string) => void;
  config?: AppConfig;
  confirm?: CliContext['confirm'];
  restoreHooks?: CliContext['restoreHooks'];
}

/** Asks on the terminal (prompt on stderr, answer from stdin); null when stdin or stderr is not a terminal. */
export function terminalConfirm(): CliContext['confirm'] {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return undefined;
  return (question) =>
    new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.question(question, (answer) => {
        rl.close();
        resolve(/^y(es)?$/i.test(answer.trim()));
      });
    });
}

export async function runAdmin(argv: string[], io: AdminIo): Promise<number> {
  const [name, ...args] = argv;
  const cmd = name ? SUBCOMMANDS[name] : undefined;
  if (!cmd) {
    io.err(usage());
    return EXIT.usage;
  }
  const config = io.config ?? loadConfig();
  const info = (m: string) => io.err(m);
  const fail = (e: unknown): number => {
    if (e instanceof CliError) {
      io.err(e.message);
      return e.exitCode;
    }
    io.err(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT.failed;
  };
  // While a restore is running or was interrupted, everything but the restore itself refuses (design 7.1)
  if (!cmd.allowDuringRestore && restoreMarkerExists(config.dataDir)) {
    io.err(restoreBlockedMessage(config.dataDir));
    return EXIT.restoreInProgress;
  }
  const ctx: CliContext = { publicUrl: config.publicUrl, config, info, confirm: io.confirm, restoreHooks: io.restoreHooks };
  if (cmd.needsDb === false) {
    try {
      io.out(await cmd.run(args, ctx));
      return EXIT.ok;
    } catch (e) {
      return fail(e);
    }
  }
  // Never create a database: a missing file means DATA_DIR points at the wrong place
  if (!existsSync(config.appDbPath)) {
    io.err(`No database at ${config.appDbPath}. Check DATA_DIR (inside Docker: run this in the app container).`);
    return EXIT.notFound;
  }
  if (config.publicUrl === DEFAULT_PUBLIC_URL) io.err(`Warning: PUBLIC_URL is the default ${DEFAULT_PUBLIC_URL}; the link will be wrong unless that is your address.`);
  const db = openAppDb(config.appDbPath);
  try {
    io.out(await cmd.run(args, { ...ctx, db }));
    return EXIT.ok;
  } catch (e) {
    return fail(e);
  } finally {
    db.$client.close();
  }
}
