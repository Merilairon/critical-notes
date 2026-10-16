/**
 * Core of the `admin` command line (Task M2.6, design docs/design/accounts.md 4.6). Kept free of process
 * handling so tests can call it; `admin.ts` is the thin entry that reads the config and sets the exit code.
 */
import { eq } from 'drizzle-orm';
import type { AppDb } from '../db';
import { users } from '../db/schema';
import { createResetLink } from '../services/users';

/** Exit codes of the command line. */
export const EXIT = { ok: 0, unknownUser: 1, disabledUser: 2, notFound: 3, usage: 64 } as const;

/** A failure with the message for stderr and the exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

/** Issues a reset link for `username` (any user, so it also unlocks a locked-out admin). */
export function resetLinkCommand(db: AppDb, username: string, publicUrl: string, now = Date.now()): { url: string; expiresAt: number } {
  const name = username.trim().toLowerCase();
  const user = name ? db.select().from(users).where(eq(users.username, name)).get() : undefined;
  if (!user) throw new CliError(`No user named "${username}".`, EXIT.unknownUser);
  if (user.disabledAt !== null) throw new CliError(`User "${user.username}" is disabled. Enable the account first (Admin > Users); this command does not enable accounts.`, EXIT.disabledUser);
  const { url, expiresAt } = createResetLink(db, user.id, null, publicUrl, { now });
  return { url, expiresAt };
}

export interface Subcommand {
  usage: string;
  /** Runs against the app database and returns the text for stdout; `ctx.info` writes a diagnostic to stderr. */
  run(args: string[], ctx: { db: AppDb; publicUrl: string; info: (msg: string) => void }): string;
}

/** Subcommands by name; later tasks (backup, restore) add entries here. */
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
};

export const usage = () => `Usage: admin <command>\n${Object.values(SUBCOMMANDS).map((c) => `  ${c.usage}`).join('\n')}`;
