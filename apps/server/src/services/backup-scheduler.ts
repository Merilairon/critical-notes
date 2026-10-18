/**
 * Scheduled backups (docs/design/backup.md 12, task M3.5). Off unless `BACKUP_EVERY_HOURS` is 1 to 720. Runs in the server
 * process as a chain of unref'd `setTimeout`s (never `setInterval`, never a cron library) and only ever calls
 * `BackupService.create({ trigger: 'scheduler' })`, which takes the same mutex and lock as every other backup and prunes with
 * `prune(keep, 'scheduler')`. No retention rule of its own.
 *
 * The schedule is derived from the world, not from memory: the next run is the newest backup's timestamp (the name; ANY
 * trigger counts, so a manual backup also postpones the next scheduled one) plus the interval (names from the future are
 * ignored, see `newest`). A restart therefore does not reset it. Sleeps are cut into chunks of at
 * most 30 minutes (Node's timer limit is 24.8 days, the interval up to 30) and the due time is re-derived from the clock on
 * every wake-up, which absorbs suspend/resume and clock jumps in either direction.
 */
import { restoreMarkerExists } from '../lib/restore-marker';
import { BackupError, timestampOfName, type BackupService } from './backups';

export const HOUR_MS = 3600 * 1000;
/** After downtime: wait this long (so indexing and the first requests are done), plus up to `CATCH_UP_JITTER_MS`. */
export const CATCH_UP_DELAY_MS = 60_000;
export const CATCH_UP_JITTER_MS = 30_000;
/** Longest single sleep; the due time is re-derived from the clock after each. */
export const MAX_SLEEP_MS = 30 * 60_000;
/** A busy lock or a restore marker is looked at again after this long (never queued, never a tight loop). */
export const RECHECK_MS = 5 * 60_000;
/** Failure backoff: 15 minutes, then x4 each time (15 m, 1 h, 4 h, 16 h), never longer than the interval. */
export const BACKOFF_BASE_MS = 15 * 60_000;

export interface SchedulerTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: SchedulerTimers = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref(); // a pending backup timer must never keep the process alive
    return t;
  },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface BackupSchedulerOptions {
  service: Pick<BackupService, 'create' | 'list' | 'isRunning'>;
  config: { dataDir: string; backupEveryHours: number };
  /** Test seams. */
  now?: () => number;
  timers?: SchedulerTimers;
  random?: () => number;
  log?: (message: string) => void;
}

export interface SchedulerInfo {
  everyHours: number;
  /** ISO time of the next planned run, or null while it is being worked out. */
  nextRunAt: string | null;
}

export class BackupScheduler {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly timers: SchedulerTimers;
  private readonly random: () => number;
  private readonly log: (message: string) => void;
  private handle: unknown = null;
  private nextAt: number | null = null;
  private holdUntil = 0;
  private failures = 0;
  private started = false;
  private stopped = false;
  private inflight: Promise<void> | null = null;
  private lastNote = '';

  constructor(private readonly opts: BackupSchedulerOptions) {
    this.intervalMs = opts.config.backupEveryHours * HOUR_MS;
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? realTimers;
    this.random = opts.random ?? Math.random;
    this.log = opts.log ?? ((m) => console.log(m));
  }

  get enabled(): boolean {
    return this.opts.config.backupEveryHours > 0;
  }

  /** What the admin page shows; null when scheduling is off. */
  info(): SchedulerInfo | null {
    if (!this.enabled) return null;
    return { everyHours: this.opts.config.backupEveryHours, nextRunAt: this.started && !this.stopped && this.nextAt !== null ? new Date(this.nextAt).toISOString() : null };
  }

  /** Plans the first run (a single catch-up after downtime, or newest backup + interval). Does nothing when off or already started. */
  start(): void {
    if (!this.enabled || this.started) return;
    this.started = true;
    this.inflight = this.plan(true).finally(() => {
      this.inflight = null;
    });
  }

  /** Clears the timer and plans nothing more. Resolves when a run in progress has ended (it is not interrupted). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = null;
    this.nextAt = null;
    await this.inflight?.catch(() => undefined);
  }

  /**
   * Newest backup time from the NAME (any trigger). Names later than the clock (the clock was stepped back, or the files come from
   * a machine with a clock in the future) are ignored: their age is unknowable, and counting them would postpone every run
   * until the clock catches up. `null`: no usable backup, or the list failed (then a backup is attempted and fails or succeeds on its own).
   */
  private async newest(): Promise<number | null> {
    try {
      const now = this.now();
      let best: number | null = null;
      for (const b of await this.opts.service.list()) {
        const ts = timestampOfName(b.name);
        if (ts !== null && ts <= now && (best === null || ts > best)) best = ts;
      }
      return best;
    } catch {
      return null;
    }
  }

  private arm(at: number): void {
    if (this.stopped) return;
    if (this.handle !== null) this.timers.clear(this.handle);
    this.nextAt = at;
    const delay = Math.max(0, Math.min(at - this.now(), MAX_SLEEP_MS));
    this.handle = this.timers.set(() => this.wake(), delay);
  }

  private note(message: string): void {
    if (message === this.lastNote) return; // the same sentence is not repeated while nothing changed
    this.lastNote = message;
    this.log(message);
  }

  private async plan(initial: boolean): Promise<void> {
    const newest = await this.newest();
    if (this.stopped) return;
    const now = this.now();
    const due = Math.max(newest === null ? 0 : newest + this.intervalMs, this.holdUntil);
    if (due > now) return this.arm(due);
    // Nothing recent: one catch-up run after a short, jittered delay. It is re-checked when it fires.
    if (initial) this.log(`Scheduled backups: no backup in the last ${this.opts.config.backupEveryHours} h; one will be made shortly`);
    this.arm(now + CATCH_UP_DELAY_MS + Math.floor(this.random() * CATCH_UP_JITTER_MS));
  }

  private wake(): void {
    this.handle = null;
    if (this.stopped || this.inflight) return;
    const now = this.now();
    const remaining = (this.nextAt ?? now) - now;
    if (remaining > this.intervalMs + CATCH_UP_DELAY_MS + CATCH_UP_JITTER_MS) {
      // The clock went backwards: the planned time is further away than any plan can be. Start counting again from here.
      this.log('Scheduled backups: the system clock moved backwards; counting the interval again from now');
      this.arm(now + this.intervalMs);
      return;
    }
    if (remaining > 0) return this.arm(this.nextAt as number); // a chunk of a long sleep
    this.inflight = this.runDue().finally(() => {
      this.inflight = null;
    });
  }

  private async runDue(): Promise<void> {
    try {
      if (restoreMarkerExists(this.opts.config.dataDir)) {
        this.note('Scheduled backup skipped: a restore is running or was interrupted');
        return this.arm(this.now() + RECHECK_MS);
      }
      // Re-derive: a manual or CLI backup since the plan postpones this run; a failure hold (backoff) is respected
      const newest = await this.newest();
      if (this.stopped) return;
      const due = Math.max(newest === null ? 0 : newest + this.intervalMs, this.holdUntil);
      if (due > this.now()) return this.arm(due);
      if (this.opts.service.isRunning()) {
        this.note('Scheduled backup skipped: a backup is already running');
        return this.arm(this.now() + RECHECK_MS);
      }
      try {
        await this.opts.service.create({ actor: 'scheduler', trigger: 'scheduler' });
        this.failures = 0;
        this.holdUntil = 0;
        this.lastNote = '';
        return await this.plan(false);
      } catch (e) {
        if (e instanceof BackupError && (e.code === 'busy' || e.code === 'restore-in-progress')) {
          this.note(`Scheduled backup skipped: ${e.code === 'busy' ? 'a backup is already running' : 'a restore is running or was interrupted'}`);
          return this.arm(this.now() + RECHECK_MS);
        }
        // The service has already audited `backup.failed` (actor and trigger 'scheduler') and kept the fixed sentence for the admin page
        this.failures++;
        const wait = Math.min(this.intervalMs, BACKOFF_BASE_MS * 4 ** (this.failures - 1));
        this.holdUntil = this.now() + wait;
        this.log(`Scheduled backup failed (attempt ${this.failures}); old backups are kept; next try in ${Math.round(wait / 60_000)} min`);
        return this.arm(this.holdUntil);
      }
    } catch {
      // Nothing in the chain may become an unhandled rejection or stop the schedule
      this.holdUntil = this.now() + RECHECK_MS;
      this.arm(this.holdUntil);
    }
  }
}
