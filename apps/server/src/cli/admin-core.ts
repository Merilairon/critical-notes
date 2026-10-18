/**
 * Core of the `admin` command line (Task M2.6, design docs/design/accounts.md 4.6). Kept free of process
 * handling so tests can call it; `admin.ts` is the thin entry that reads the config and sets the exit code.
 */
import { eq } from 'drizzle-orm';
import type { AppConfig } from '../config';
import type { AppDb } from '../db';
import { users } from '../db/schema';
import { createResetLink } from '../services/users';
import { backupCommand } from './backup';
import { CliError, EXIT } from './errors';
import { restoreCommand, RESTORE_USAGE, type RestoreHooks } from './restore';

export { CliError, EXIT } from './errors';

/** Issues a reset link for `username` (any user, so it also unlocks a locked-out admin). */
export function resetLinkCommand(db: AppDb, username: string, publicUrl: string, now = Date.now()): { url: string; expiresAt: number } {
  const name = username.trim().toLowerCase();
  const user = name ? db.select().from(users).where(eq(users.username, name)).get() : undefined;
  if (!user) throw new CliError(`No user named "${username}".`, EXIT.unknownUser);
  if (user.disabledAt !== null) throw new CliError(`User "${user.username}" is disabled. Enable the account first (Admin > Users); this command does not enable accounts.`, EXIT.disabledUser);
  const { url, expiresAt } = createResetLink(db, user.id, null, publicUrl, { now });
  return { url, expiresAt };
}

/** What every subcommand gets. */
export interface CliContext {
  publicUrl: string;
  config: AppConfig;
  /** Writes a diagnostic to stderr. */
  info: (msg: string) => void;
  /** Asks a yes/no question on the terminal; undefined when there is none (no TTY). */
  confirm?: (question: string) => Promise<boolean>;
  /** Test seams of the restore (crash points, free space). */
  restoreHooks?: RestoreHooks;
}

interface SubcommandBase {
  usage: string;
  /** Subcommands that run while a restore marker exists (only `restore` itself); all others are refused. */
  allowDuringRestore?: boolean;
}

/** Runs against the app database (opened with `openAppDb`, which migrates) and returns the text for stdout. */
export interface DbSubcommand extends SubcommandBase {
  needsDb?: true;
  run(args: string[], ctx: CliContext & { db: AppDb }): string | Promise<string>;
}

/** Skips the generic open: `backup` uses its own connection, `restore` may run on a wiped instance. */
export interface FreeSubcommand extends SubcommandBase {
  needsDb: false;
  run(args: string[], ctx: CliContext): string | Promise<string>;
}

export type Subcommand = DbSubcommand | FreeSubcommand;

/** Subcommands by name. */
export const SUBCOMMANDS: Record<string, Subcommand> = {
  'reset-link': {
    usage: 'reset-link <username>',
    run(args, { db, publicUrl, info }) {
      if (args.length !== 1 || !args[0]) throw new CliError('Usage: admin reset-link <username>', EXIT.usage);
      const { url, expiresAt } = resetLinkCommand(db, args[0], publicUrl);
      info(`Link expires ${new Date(expiresAt).toISOString()}; it works once and replaces any earlier link for this user.`);
      return url;
    },
  },
  backup: {
    usage: 'backup',
    needsDb: false,
    run: (args, { config, info }) => backupCommand(args, { config, info }),
  },
  restore: {
    usage: RESTORE_USAGE,
    needsDb: false,
    allowDuringRestore: true,
    run: (args, { config, info, confirm, restoreHooks }) => restoreCommand(args, { config, info, confirm, hooks: restoreHooks }),
  },
};

export const usage = () => `Usage: admin <command>\n${Object.values(SUBCOMMANDS).map((c) => `  ${c.usage}`).join('\n')}`;
