import { createHash, randomBytes } from 'node:crypto';

export const TICKET_TTL_MS = 60_000;

interface Bound {
  adminId: string;
  sessionId: string;
  name: string;
  expiresAt: number;
}

/**
 * One-use download tickets (docs/design/backup.md 10): 32 random bytes, held in memory as a sha256, bound to the admin id,
 * the session id and the file name, valid 60 seconds. `redeem` removes the ticket on the FIRST presentation, whether or
 * not the binding matches, so a ticket seen by a thief is burnt either way. The map is bounded.
 */
export class DownloadTickets {
  private readonly tickets = new Map<string, Bound>();
  constructor(
    private readonly opts: { ttlMs?: number; max?: number; now?: () => number } = {},
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  get size() {
    return this.tickets.size;
  }

  issue(adminId: string, sessionId: string, name: string): string {
    const now = this.now();
    const max = this.opts.max ?? 200;
    if (this.tickets.size >= max) {
      for (const [k, v] of this.tickets) if (v.expiresAt <= now) this.tickets.delete(k);
      // Still full: drop the oldest (Map keeps insertion order)
      for (const k of this.tickets.keys()) {
        if (this.tickets.size < max) break;
        this.tickets.delete(k);
      }
    }
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(hash(ticket), { adminId, sessionId, name, expiresAt: now + (this.opts.ttlMs ?? TICKET_TTL_MS) });
    return ticket;
  }

  redeem(ticket: string, adminId: string, sessionId: string, name: string): boolean {
    const key = hash(ticket);
    const t = this.tickets.get(key);
    if (!t) return false;
    this.tickets.delete(key);
    return t.expiresAt > this.now() && t.adminId === adminId && t.sessionId === sessionId && t.name === name;
  }
}

const hash = (ticket: string) => createHash('sha256').update(ticket).digest('hex');
