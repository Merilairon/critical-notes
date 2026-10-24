/**
 * Thinning of page history (task N1.2; design: docs/design/page-history.md section 5.2). Every row is kept for
 * `keepAllDays`; older rows are thinned to the newest one per page per UTC day, and after `monthlyAfterDays` to one per page per
 * month. The newest row of a page (the live version) and its oldest (the origin) are never deleted. A page with more than
 * `maxPerPage` rows is thinned early, and a campaign over its soft size ceiling loses its oldest daily rows (never inside the
 * keep-all window). Same runner as `TrashPurger`: unref'd `setTimeout` chain, first run a minute after start then daily, deferred
 * while a backup runs or a restore marker exists.
 *
 * The cutoff is bounded by recorded activity: a clock set far forward moves the reference by at most `CLOCK_MARGIN_MS` beyond the
 * newest saved revision, so it cannot thin more than the margin allows; a clock that went backwards skips the pass.
 */
import type { HistoryConfig } from '../config';
import type { AppDb } from '../db';
import { restoreMarkerExists } from '../lib/restore-marker';
import { CLOCK_MARGIN_MS, PURGE_INTERVAL_MS, PURGE_RECHECK_MS, PURGE_START_DELAY_MS } from './trash-purger';

const DAY_MS = 24 * 3600 * 1000;
const PAGE_BATCH = 50;
const DELETE_CHUNK = 500;
const MB = 1024 * 1024;

export interface HistoryPrunerOptions {
  db: AppDb;
  backups: { isRunning(): boolean };
  config: { dataDir: string; history: HistoryConfig };
  now?: () => number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  log?: (message: string) => void;
}

export interface PruneResult {
  daily: number;
  monthly: number;
  overCap: number;
  overCeiling: number;
}

interface Row {
  page_id: string;
  revision: number;
  created_at: number;
  bytes?: number;
}

const realTimers = {
  set(fn: () => void, ms: number) {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clear: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
};

/** `YYYY-MM` of an epoch-ms timestamp in UTC. */
const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

export class HistoryPruner {
  private handle: unknown = null;
  private stopped = false;
  private lastRunAt = 0;
  private running = false;
  lastRunFailed = false;
  private readonly now: () => number;
  private readonly timers: NonNullable<HistoryPrunerOptions['timers']>;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: HistoryPrunerOptions) {
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? realTimers;
    this.log = opts.log ?? ((m) => console.log(m));
  }

  start(): void {
    if (this.handle !== null) return;
    this.stopped = false;
    this.arm(PURGE_START_DELAY_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = null;
  }

  private get client() {
    return this.opts.db.$client;
  }

  /** One pass. Returns the counts, or null when deferred (backup or restore running) or skipped (clock looks wrong). */
  runOnce(): PruneResult | null {
    if (this.running || this.opts.backups.isRunning() || restoreMarkerExists(this.opts.config.dataDir)) return null;
    const now = this.now();
    const newest = (this.client.prepare('select max(created_at) as m from page_revisions').get() as { m: number | null }).m ?? 0;
    if (now < newest - CLOCK_MARGIN_MS || now < this.lastRunAt - CLOCK_MARGIN_MS) {
      this.log('History pruning skipped: the system clock looks wrong (earlier than recent changes)');
      return null;
    }
    this.running = true;
    this.lastRunFailed = false;
    try {
      this.lastRunAt = now;
      const cfg = this.opts.config.history;
      const reference = Math.min(now, newest + CLOCK_MARGIN_MS);
      const cutoff = reference - cfg.keepAllDays * DAY_MS;
      const monthlyCutoff = reference - Math.max(cfg.monthlyAfterDays, cfg.keepAllDays) * DAY_MS;
      const result: PruneResult = { daily: 0, monthly: 0, overCap: 0, overCeiling: 0 };
      const attempt = (name: string, fn: () => void) => {
        try {
          fn();
        } catch (e) {
          this.lastRunFailed = true;
          this.log(`History pruning (${name}) failed: ${e instanceof Error ? e.message : 'unknown error'}; trying again tomorrow`);
        }
      };
      attempt('daily', () => (result.daily = this.thinDaily(cutoff)));
      attempt('monthly', () => (result.monthly = this.thinMonthly(monthlyCutoff)));
      attempt('per-page cap', () => (result.overCap = this.thinOverCap(cfg.maxPerPage)));
      attempt('campaign size', () => (result.overCeiling = this.thinOverCeiling(cutoff, cfg.maxMbPerCampaign * MB)));
      const total = result.daily + result.monthly + result.overCap + result.overCeiling;
      if (total) this.log(`History: ${total} older revision${total === 1 ? '' : 's'} thinned (${result.daily} daily, ${result.monthly} monthly, ${result.overCap} over the per-page cap, ${result.overCeiling} over the campaign size)`);
      return result;
    } finally {
      this.running = false;
    }
  }

  private batches(pageIds: string[]): string[][] {
    const out: string[][] = [];
    for (let i = 0; i < pageIds.length; i += PAGE_BATCH) out.push(pageIds.slice(i, i + PAGE_BATCH));
    return out;
  }

  /** Daily tier: older than `cutoff`, keep the newest row per page and UTC day. */
  private thinDaily(cutoff: number): number {
    const pageIds = (this.client.prepare('select distinct page_id from page_revisions where created_at < ?').all(cutoff) as { page_id: string }[]).map((r) => r.page_id);
    let n = 0;
    for (const batch of this.batches(pageIds)) {
      n += this.client.transaction(() => {
        // Re-selected inside the transaction that deletes, so a save between batches is seen
        const rows = this.client
          .prepare(
            `select t.page_id, t.revision from (
               select page_id, revision, created_at,
                 row_number() over (partition by page_id, created_at / ${DAY_MS} order by revision desc) as rn,
                 revision = max(revision) over (partition by page_id) as is_newest,
                 revision = min(revision) over (partition by page_id) as is_oldest
               from page_revisions where page_id in (${batch.map(() => '?').join(',')})
             ) as t where t.created_at < ? and t.rn > 1 and not t.is_newest and not t.is_oldest`,
          )
          .all(...batch, cutoff) as Row[];
        return this.deleteRows(rows);
      })();
    }
    return n;
  }

  /** Monthly tier: older than `monthlyCutoff`, keep the newest row per page and UTC month. Grouped here (month bucketing is not portable SQL). */
  private thinMonthly(monthlyCutoff: number): number {
    const pageIds = (this.client.prepare('select distinct page_id from page_revisions where created_at < ?').all(monthlyCutoff) as { page_id: string }[]).map((r) => r.page_id);
    let n = 0;
    for (const batch of this.batches(pageIds)) {
      n += this.client.transaction(() => {
        const rows = this.client
          .prepare(`select page_id, revision, created_at from page_revisions where page_id in (${batch.map(() => '?').join(',')}) order by page_id, revision`)
          .all(...batch) as Row[];
        const doomed: Row[] = [];
        const byPage = new Map<string, Row[]>();
        for (const r of rows) byPage.set(r.page_id, [...(byPage.get(r.page_id) ?? []), r]);
        for (const list of byPage.values()) {
          const keep = new Map<string, number>(); // month -> newest revision
          for (const r of list) if (r.created_at < monthlyCutoff) keep.set(monthOf(r.created_at), r.revision);
          const first = list[0]!.revision;
          const last = list.at(-1)!.revision;
          for (const r of list) if (r.created_at < monthlyCutoff && r.revision !== first && r.revision !== last && keep.get(monthOf(r.created_at)) !== r.revision) doomed.push(r);
        }
        return this.deleteRows(doomed);
      })();
    }
    return n;
  }

  /** A page over `cap` rows: the oldest beyond the newest `cap` are thinned by the daily rule early. */
  private thinOverCap(cap: number): number {
    const pageIds = (this.client.prepare('select page_id from page_revisions group by page_id having count(*) > ?').all(cap) as { page_id: string }[]).map((r) => r.page_id);
    let n = 0;
    for (const batch of this.batches(pageIds)) {
      n += this.client.transaction(() => {
        const rows = this.client
          .prepare(
            `select t.page_id, t.revision from (
               select page_id, revision,
                 row_number() over (partition by page_id order by revision desc) as pos,
                 row_number() over (partition by page_id, created_at / ${DAY_MS} order by revision desc) as day_rn,
                 revision = min(revision) over (partition by page_id) as is_oldest
               from page_revisions where page_id in (${batch.map(() => '?').join(',')})
             ) as t where t.pos > ? and t.day_rn > 1 and not t.is_oldest`,
          )
          .all(...batch, cap) as Row[];
        return this.deleteRows(rows);
      })();
    }
    return n;
  }

  /**
   * A campaign over its soft ceiling: thin its rows older than the keep-all window to one per page per month, oldest first,
   * until it fits. The window is never touched; if it cannot fit, a warning says so and nothing more is deleted.
   */
  private thinOverCeiling(cutoff: number, ceilingBytes: number): number {
    const sizes = this.client.prepare('select campaign_id, sum(bytes) as total from page_revisions group by campaign_id having sum(bytes) > ?').all(ceilingBytes) as { campaign_id: string; total: number }[];
    let n = 0;
    for (const { campaign_id, total } of sizes) {
      const rows = this.client.prepare('select page_id, revision, created_at, bytes from page_revisions where campaign_id = ? order by page_id, revision').all(campaign_id) as Required<Row>[];
      const byPage = new Map<string, Required<Row>[]>();
      for (const r of rows) byPage.set(r.page_id, [...(byPage.get(r.page_id) ?? []), r]);
      const candidates: Required<Row>[] = [];
      for (const list of byPage.values()) {
        const keep = new Map<string, number>();
        for (const r of list) if (r.created_at < cutoff) keep.set(monthOf(r.created_at), r.revision);
        const first = list[0]!.revision;
        const last = list.at(-1)!.revision;
        for (const r of list) if (r.created_at < cutoff && r.revision !== first && r.revision !== last && keep.get(monthOf(r.created_at)) !== r.revision) candidates.push(r);
      }
      candidates.sort((a, b) => a.created_at - b.created_at);
      let size = total;
      const doomed: Row[] = [];
      for (const r of candidates) {
        if (size <= ceilingBytes) break;
        doomed.push(r);
        size -= r.bytes;
      }
      n += this.client.transaction(() => this.deleteRows(doomed))();
      if (size > ceilingBytes) this.log(`History: campaign ${campaign_id} still holds ${Math.round(size / MB)} MB of history, over its ${Math.round(ceilingBytes / MB)} MB ceiling; the keep-all window and the protected rows are never thinned`);
    }
    return n;
  }

  /**
   * Deletes rows in chunks, re-stating in the statement that a row is neither the newest nor the oldest of its page, so a row
   * that became the newest (a save landed) or whose page is gone is never deleted on stale information.
   */
  private deleteRows(rows: { page_id: string; revision: number }[]): number {
    if (!rows.length) return 0;
    const stmt = this.client.prepare(
      `delete from page_revisions where page_id = ? and revision = ?
         and revision < (select max(revision) from page_revisions r where r.page_id = page_revisions.page_id)
         and revision > (select min(revision) from page_revisions r where r.page_id = page_revisions.page_id)`,
    );
    let n = 0;
    for (let i = 0; i < rows.length; i += DELETE_CHUNK) for (const r of rows.slice(i, i + DELETE_CHUNK)) n += stmt.run(r.page_id, r.revision).changes;
    return n;
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
      this.log(`History pruning failed: ${e instanceof Error ? e.message : 'unknown error'}; trying again tomorrow`);
    }
    this.arm(next);
  }
}
