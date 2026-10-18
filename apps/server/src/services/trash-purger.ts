/**
 * Purge of old trash (task M4.1): pages deleted more than 30 days ago are removed for good, once shortly after the server starts
 * and then daily. A chain of unref'd `setTimeout`s like the backup scheduler (no `setInterval`, no cron library). It defers
 * while a backup runs (`BackupService.isRunning()`) or a restore marker exists, re-checking after `RECHECK_MS`, and `stop()`
 * (called by the clean shutdown) cancels the timer and waits for a run in progress.
 */
import { TRASH_RETENTION_DAYS } from '@cn/shared';
import { restoreMarkerExists } from '../lib/restore-marker';

export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 3600 * 1000;
export const PURGE_INTERVAL_MS = 24 * 3600 * 1000;
/** First run after start: past indexing and the first requests. */
export const PURGE_START_DELAY_MS = 60_000;
export const PURGE_RECHECK_MS = 5 * 60_000;
/** A clock this far behind the newest page change or the last run is not trusted. */
export const CLOCK_MARGIN_MS = 10 * 60_000;

export interface TrashPurgerOptions {
  pages: { purgeExpired(cutoff: number): number; newestActivity?(): number };
  backups: { isRunning(): boolean };
  config: { dataDir: string };
  now?: () => number;
  /** Test seams. */
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  log?: (message: string) => void;
}

const realTimers = {
  set(fn: () => void, ms: number) {
    const t = setTimeout(fn, ms);
    t.unref(); // a pending purge must never keep the process alive
    return t;
  },
  clear: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
};

export class TrashPurger {
  private handle: unknown = null;
  private stopped = false;
  private lastRunAt = 0;
  private running = false;
  private readonly now: () => number;
  private readonly timers: NonNullable<TrashPurgerOptions['timers']>;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: TrashPurgerOptions) {
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? realTimers;
    this.log = opts.log ?? ((m) => console.log(m));
  }

  start(): void {
    if (this.handle !== null) return; // already scheduled: a second call must not leak a timer
    this.stopped = false;
    this.arm(PURGE_START_DELAY_MS);
  }

  /** Cancels the timer; the run itself is synchronous, so nothing is left in progress once this returns. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = null;
  }

  /** One pass. Returns the number of pages purged, or null when deferred (backup or restore running). */
  runOnce(): number | null {
    if (this.running || this.opts.backups.isRunning() || restoreMarkerExists(this.opts.config.dataDir)) return null;
    // A wall clock far in the past would still be safe (nothing expires), one far in the future would purge too much; a clock
    // that went BACKWARDS is the sign of a reset clock, so skip the pass. Compared with the newest page change and our last run.
    const now = this.now();
    const newest = this.opts.pages.newestActivity?.() ?? 0;
    if (now < newest - CLOCK_MARGIN_MS || now < this.lastRunAt - CLOCK_MARGIN_MS) {
      this.log('Trash purge skipped: the system clock looks wrong (earlier than recent changes)');
      return null;
    }
    this.running = true;
    try {
      this.lastRunAt = now;
      const n = this.opts.pages.purgeExpired(now - TRASH_RETENTION_MS);
      if (n) this.log(`Trash: ${n} page${n === 1 ? '' : 's'} deleted more than 30 days ago removed for good`);
      return n;
    } finally {
      this.running = false;
    }
  }

  private arm(ms: number): void {
    if (this.stopped) return;
    this.handle = this.timers.set(() => this.tick(), ms);
  }

  private tick(): void {
    this.handle = null;
    if (this.stopped) return;
    let next = PURGE_INTERVAL_MS;
    try {
      if (this.runOnce() === null) next = PURGE_RECHECK_MS;
    } catch (e) {
      this.log(`Trash purge failed: ${e instanceof Error ? e.message : 'unknown error'}; trying again tomorrow`);
    }
    this.arm(next);
  }
}
