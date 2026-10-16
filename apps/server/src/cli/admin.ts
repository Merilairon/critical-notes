/**
 * `node dist/admin.mjs reset-link <username>`: prints a password reset link (docs/design/accounts.md 4.6).
 * Config comes from `loadConfig()` like main.ts (environment, then the repo-root `.env` unless CN_SKIP_DOTENV).
 * stdout carries only the result; diagnostics go to stderr.
 */
import { existsSync } from 'node:fs';
import { loadConfig } from '../config';
import { openAppDb } from '../db';
import { CliError, EXIT, SUBCOMMANDS, usage } from './admin-core';

const DEFAULT_PUBLIC_URL = 'http://localhost:4200';

function main(argv: string[]): number {
  const [name, ...args] = argv;
  const cmd = name ? SUBCOMMANDS[name] : undefined;
  if (!cmd) {
    console.error(usage());
    return EXIT.usage;
  }
  const config = loadConfig();
  // Never create a database: a missing file means DATA_DIR points at the wrong place
  if (!existsSync(config.appDbPath)) {
    console.error(`No database at ${config.appDbPath}. Check DATA_DIR (inside Docker: run this in the app container).`);
    return EXIT.notFound;
  }
  if (config.publicUrl === DEFAULT_PUBLIC_URL) console.error(`Warning: PUBLIC_URL is the default ${DEFAULT_PUBLIC_URL}; the link will be wrong unless that is your address.`);
  const db = openAppDb(config.appDbPath);
  try {
    console.log(cmd.run(args, { db, publicUrl: config.publicUrl, info: (m) => console.error(m) }));
    return EXIT.ok;
  } catch (e) {
    if (e instanceof CliError) {
      console.error(e.message);
      return e.exitCode;
    }
    console.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    return 70;
  } finally {
    db.$client.close();
  }
}

process.exitCode = main(process.argv.slice(2));
