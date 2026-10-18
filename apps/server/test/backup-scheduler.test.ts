import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, parseBackupEveryHours } from '../src/config';
import {
  BACKOFF_BASE_MS,
  BackupScheduler,
  CATCH_UP_DELAY_MS,
  CATCH_UP_JITTER_MS,
  HOUR_MS,
  MAX_SLEEP_MS,
  RECHECK_MS,
  type BackupSchedulerOptions,
  type SchedulerTimers,
} from '../src/services/backup-scheduler';
import { backupNameFor, BackupError, readBackup, type Trigger } from '../src/services/backups';
import { RESTORE_MARKER } from '../src/lib/restore-marker';
import { makeEnv, T0, type BackupEnv } from './backup-helpers';

const MIN = 60_000;
const DAY = 24 * HOUR_MS;

/** A manual timer queue over one shared clock: nothing waits for real time. */
class FakeTimers implements SchedulerTimers {
  readonly clock = { now: T0 };
  readonly delays: number[] = [];
  private items: { id: number; at: number; fn: () => void }[] = [];
  private seq = 0;
  set(fn: () => void, ms: number) {
    this.delays.push(ms);
    const id = ++this.seq;
    this.items.push({ id, at: this.clock.now + ms, fn });
    return id;
  }
  clear(h: unknown) {
    this.items = this.items.filter((i) => i.id !== h);
  }
  get pending() {
    return this.items.length;
  }
  /** Moves the clock forward, firing timers in order and letting each run settle. */
  async advance(ms: number, settle: () => Promise<void> = flush) {
    const target = this.clock.now + ms;
    await settle(); // a start() has planned by now
    for (;;) {
      const next = this.items.filter((i) => i.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.items = this.items.filter((i) => i !== next);
      this.clock.now = Math.max(this.clock.now, next.at);
      next.fn();
      await settle();
    }
    this.clock.now = target;
  }
  /** The clock jumps (suspend, NTP step) without a timer firing; then the earliest pending timer fires, as after a resume. */
  async jumpAndFire(ms: number, settle: () => Promise<void> = flush) {
    this.clock.now += ms;
    const next = this.items.sort((a, b) => a.at - b.at)[0];
    if (next) {
      this.items = this.items.filter((i) => i !== next);
      next.fn();
      await settle();
    }
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

/** A scripted service: backups are names; `create` adds one at the clock's time. */
function fakeService(timers: FakeTimers, initial: number[] = []) {
  const state = {
    names: initial.map(backupNameFor).sort().reverse(),
    running: false,
    failWith: null as unknown,
    creates: [] as { actor: string; trigger: Trigger; at: number }[],
    attempts: [] as number[],
    gate: null as Promise<void> | null,
    listFails: false,
  };
  const service = {
    list: async () => {
      if (state.listFails) throw new Error('EIO');
      return state.names.map((name) => ({ name })) as never;
    },
    isRunning: () => state.running,
    create: async (args: { actor: string; trigger: Trigger }) => {
      state.attempts.push(timers.clock.now);
      if (state.gate) await state.gate;
      if (state.failWith) throw state.failWith;
      state.creates.push({ ...args, at: timers.clock.now });
      state.names.unshift(backupNameFor(timers.clock.now));
      return {} as never;
    },
  };
  return { state, service };
}

let dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'cn-sch-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  vi.restoreAllMocks();
});

function make(opts: { hours?: number; initial?: number[]; dataDir?: string } = {}) {
  const timers = new FakeTimers();
  const { state, service } = fakeService(timers, opts.initial);
  const logs: string[] = [];
  const dataDir = opts.dataDir ?? tmp();
  const scheduler = new BackupScheduler({
    service: service as unknown as BackupSchedulerOptions['service'],
    config: { dataDir, backupEveryHours: opts.hours ?? 24 },
    now: () => timers.clock.now,
    timers,
    random: () => 0.5,
    log: (m) => logs.push(m),
  });
  return { timers, state, scheduler, logs, dataDir };
}

describe('BACKUP_EVERY_HOURS parsing', () => {
  it('is off when unset, empty or 0', () => {
    for (const v of [undefined, '', '  ', '0', '00']) expect(parseBackupEveryHours(v)).toEqual({ hours: 0, error: null });
  });
  it('accepts 1 to 720', () => {
    for (const [v, n] of [['1', 1], ['24', 24], [' 168 ', 168], ['720', 720]] as const) expect(parseBackupEveryHours(v)).toEqual({ hours: n, error: null });
  });
  it('refuses everything else with a clear message', () => {
    for (const v of ['721', '-1', '1.5', 'daily', '1e3', '0x10', '24h', '99999', '١٢']) {
      const r = parseBackupEveryHours(v);
      expect(r.hours, v).toBe(0);
      expect(r.error, v).toMatch(/^BACKUP_EVERY_HOURS must be a whole number from 1 to 720/);
    }
    expect(parseBackupEveryHours('x'.repeat(500)).error!.length).toBeLessThan(250);
  });
  it('loadConfig carries the value and the error, and is off by default', () => {
    const saved = process.env.BACKUP_EVERY_HOURS;
    try {
      delete process.env.BACKUP_EVERY_HOURS;
      expect(loadConfig()).toMatchObject({ backupEveryHours: 0, backupEveryHoursError: null });
      process.env.BACKUP_EVERY_HOURS = '12';
      expect(loadConfig()).toMatchObject({ backupEveryHours: 12, backupEveryHoursError: null });
      process.env.BACKUP_EVERY_HOURS = 'often';
      expect(loadConfig()).toMatchObject({ backupEveryHours: 0, backupEveryHoursError: expect.stringContaining('BACKUP_EVERY_HOURS') });
    } finally {
      if (saved === undefined) delete process.env.BACKUP_EVERY_HOURS;
      else process.env.BACKUP_EVERY_HOURS = saved;
    }
  });
});

describe('BackupScheduler', () => {
  it('is off by default: start() arms nothing and the page gets no schedule', async () => {
    const { scheduler, timers, state } = make({ hours: 0 });
    expect(scheduler.enabled).toBe(false);
    scheduler.start();
    await timers.advance(100 * DAY);
    expect(timers.pending).toBe(0);
    expect(timers.delays).toEqual([]);
    expect(state.attempts).toEqual([]);
    expect(scheduler.info()).toBeNull();
  });

  it('runs every interval with actor and trigger "scheduler" (and nothing else)', async () => {
    const { scheduler, timers, state } = make({ hours: 6, initial: [T0 - HOUR_MS] });
    scheduler.start();
    await flush();
    expect(scheduler.info()).toEqual({ everyHours: 6, nextRunAt: new Date(T0 - HOUR_MS + 6 * HOUR_MS).toISOString() });
    await timers.advance(5 * HOUR_MS - MIN);
    expect(state.creates).toHaveLength(0);
    await timers.advance(2 * MIN);
    expect(state.creates).toHaveLength(1);
    expect(state.creates[0]).toMatchObject({ actor: 'scheduler', trigger: 'scheduler' });
    await timers.advance(6 * HOUR_MS);
    await timers.advance(6 * HOUR_MS);
    expect(state.creates).toHaveLength(3);
    expect(state.creates.map((c) => c.trigger)).toEqual(['scheduler', 'scheduler', 'scheduler']);
  });

  it('makes no catch-up when a recent backup exists, and a restart does not reset the schedule', async () => {
    const { scheduler, timers, state } = make({ hours: 24, initial: [T0 - 2 * HOUR_MS] });
    scheduler.start();
    await timers.advance(60 * MIN * 21);
    expect(state.attempts).toEqual([]); // 21 h later: still not due (22 h after the backup)
    await timers.advance(2 * HOUR_MS);
    expect(state.attempts).toHaveLength(1);
  });

  it('a backup of any trigger counts as recent (the name decides, not the trigger)', async () => {
    const { scheduler, timers, state } = make({ hours: 24, initial: [T0 - 23 * HOUR_MS] });
    scheduler.start();
    await timers.advance(30 * MIN);
    expect(state.attempts).toHaveLength(0);
    await timers.advance(40 * MIN);
    expect(state.attempts).toHaveLength(1);
  });

  it('makes exactly one catch-up after long downtime, after 60 s plus jitter, not one per missed run', async () => {
    const { scheduler, timers, state, logs } = make({ hours: 6, initial: [T0 - 30 * DAY] });
    scheduler.start();
    await flush();
    const expected = CATCH_UP_DELAY_MS + Math.floor(0.5 * CATCH_UP_JITTER_MS);
    expect(timers.delays[0]).toBe(expected);
    expect(logs[0]).toMatch(/one will be made shortly/);
    await timers.advance(expected - 1);
    expect(state.attempts).toHaveLength(0);
    await timers.advance(2);
    expect(state.attempts).toEqual([T0 + expected]);
    await timers.advance(6 * HOUR_MS - MIN);
    expect(state.attempts).toHaveLength(1); // the next one is a full interval after the catch-up
    await timers.advance(2 * MIN);
    expect(state.attempts).toHaveLength(2);
  });

  it('the catch-up is re-checked when it fires: a backup made in the meantime cancels it', async () => {
    const { scheduler, timers, state } = make({ hours: 24, initial: [] });
    scheduler.start();
    await flush();
    state.names.unshift(backupNameFor(T0 + 10_000)); // a manual backup during the delay
    await timers.advance(2 * MIN);
    expect(state.attempts).toHaveLength(0);
    await timers.advance(24 * HOUR_MS);
    expect(state.attempts).toHaveLength(1);
  });

  it('the catch-up jitter stays within 30 s', async () => {
    for (const r of [0, 0.999]) {
      const timers = new FakeTimers();
      const { service } = fakeService(timers, []);
      const s = new BackupScheduler({ service: service as never, config: { dataDir: tmp(), backupEveryHours: 1 }, now: () => timers.clock.now, timers, random: () => r, log: () => undefined });
      s.start();
      await flush();
      expect(timers.delays[0]).toBeGreaterThanOrEqual(CATCH_UP_DELAY_MS);
      expect(timers.delays[0]).toBeLessThan(CATCH_UP_DELAY_MS + CATCH_UP_JITTER_MS);
      await s.stop();
    }
  });

  it('skips and logs (does not queue) when a backup is already running, then re-derives from the list', async () => {
    const { scheduler, timers, state, logs } = make({ hours: 1, initial: [T0 - 2 * HOUR_MS] });
    state.running = true; // a manual / API backup holds the mutex
    scheduler.start();
    await timers.advance(2 * MIN);
    expect(state.attempts).toHaveLength(0);
    expect(logs.filter((l) => /already running/.test(l))).toHaveLength(1);
    // it finished and published a backup: nothing is due until an interval after it
    state.running = false;
    state.names.unshift(backupNameFor(timers.clock.now));
    await timers.advance(RECHECK_MS + 30 * MIN);
    expect(state.attempts).toHaveLength(0);
    await timers.advance(40 * MIN);
    expect(state.attempts).toHaveLength(1);
  });

  it('an in-flight lock from another process (BackupError busy) is a skip, not a failure', async () => {
    const { scheduler, timers, state, logs } = make({ hours: 24, initial: [T0 - 3 * DAY] });
    state.failWith = new BackupError('busy', 'A backup is already running');
    scheduler.start();
    await timers.advance(2 * MIN);
    expect(state.attempts).toHaveLength(1);
    expect(logs.some((l) => /failed/.test(l))).toBe(false);
    state.failWith = null;
    await timers.advance(RECHECK_MS);
    expect(state.creates).toHaveLength(1);
  });

  it('never has two runs of its own in flight', async () => {
    const { scheduler, timers, state } = make({ hours: 1, initial: [T0 - 5 * HOUR_MS] });
    let release!: () => void;
    state.gate = new Promise<void>((r) => (release = r));
    scheduler.start();
    await timers.advance(3 * HOUR_MS);
    expect(state.attempts).toHaveLength(1); // no timer is armed while the run is in flight
    expect(timers.pending).toBe(0);
    release();
    await flush();
    expect(timers.pending).toBe(1);
  });

  it('skips while the restore marker exists, logs once, and runs after it is gone', async () => {
    const { scheduler, timers, state, logs, dataDir } = make({ hours: 24, initial: [T0 - 3 * DAY] });
    writeFileSync(join(dataDir, RESTORE_MARKER), '{}');
    scheduler.start();
    await timers.advance(2 * HOUR_MS);
    expect(state.attempts).toHaveLength(0);
    expect(logs.filter((l) => /restore is running/.test(l))).toHaveLength(1);
    rmSync(join(dataDir, RESTORE_MARKER));
    await timers.advance(RECHECK_MS);
    expect(state.creates).toHaveLength(1);
  });

  it('a dangling restore marker link also blocks', async () => {
    const { scheduler, timers, state, dataDir } = make({ hours: 24, initial: [] });
    (await import('node:fs')).symlinkSync(join(dataDir, 'nowhere'), join(dataDir, RESTORE_MARKER));
    scheduler.start();
    await timers.advance(HOUR_MS);
    expect(state.attempts).toHaveLength(0);
  });

  it('a failing run keeps old backups, backs off (15 min, then x4) and does not retry every minute', async () => {
    const { scheduler, timers, state, logs } = make({ hours: 24, initial: [T0 - 3 * DAY] });
    state.failWith = new Error('boom with /secret/path');
    scheduler.start();
    await timers.advance(24 * HOUR_MS);
    expect(state.names).toHaveLength(1); // nothing was added or removed by the scheduler
    const gaps = state.attempts.slice(1).map((t, i) => t - (state.attempts[i] as number));
    expect(gaps.slice(0, 3)).toEqual([BACKOFF_BASE_MS, 4 * BACKOFF_BASE_MS, 16 * BACKOFF_BASE_MS]);
    expect(state.attempts.length).toBeLessThanOrEqual(6);
    expect(logs.filter((l) => /failed/.test(l)).length).toBe(state.attempts.length);
    expect(logs.join('\n')).not.toMatch(/secret|boom/); // a fixed sentence: no raw error text in the log
  });

  it('the backoff never exceeds the interval, and a success resets it', async () => {
    const { scheduler, timers, state } = make({ hours: 1, initial: [T0 - 5 * HOUR_MS] });
    state.failWith = new Error('x');
    scheduler.start();
    await timers.advance(10 * HOUR_MS);
    const gaps = state.attempts.slice(1).map((t, i) => t - (state.attempts[i] as number));
    expect(Math.max(...gaps)).toBe(HOUR_MS);
    state.failWith = null;
    await timers.advance(HOUR_MS + MIN);
    expect(state.creates).toHaveLength(1);
    // a new failure after the success starts the backoff over at 15 min (not at the capped 1 h)
    const okAt = state.creates[0]!.at;
    state.failWith = new Error('again');
    await timers.advance(3 * HOUR_MS);
    const after = state.attempts.filter((t) => t > okAt);
    expect(after[1]! - after[0]!).toBe(BACKOFF_BASE_MS);
    expect(after[2]! - after[1]!).toBe(HOUR_MS); // 4 x 15 min, capped at the 1 h interval
  });

  it('stop() clears the timer, plans nothing more and waits for a run in progress', async () => {
    const { scheduler, timers, state } = make({ hours: 1, initial: [T0 - 5 * HOUR_MS] });
    let release!: () => void;
    state.gate = new Promise<void>((r) => (release = r));
    scheduler.start();
    await timers.advance(2 * MIN); // the catch-up starts and blocks in create
    expect(state.attempts).toHaveLength(1);
    let stopped = false;
    const p = scheduler.stop().then(() => (stopped = true));
    await flush();
    expect(stopped).toBe(false); // not interrupted: it is allowed to finish
    release();
    await p;
    expect(timers.pending).toBe(0);
    await timers.advance(10 * DAY);
    expect(state.attempts).toHaveLength(1);
    expect(scheduler.info()?.nextRunAt).toBeNull();
  });

  it('a run that fails after stop() does not re-arm', async () => {
    const { scheduler, timers, state } = make({ hours: 1, initial: [T0 - 5 * HOUR_MS] });
    let release!: () => void;
    state.gate = new Promise<void>((r) => (release = r));
    state.failWith = new Error('late');
    scheduler.start();
    await timers.advance(2 * MIN);
    const p = scheduler.stop();
    release();
    await p;
    expect(timers.pending).toBe(0);
    await timers.advance(DAY);
    expect(state.attempts).toHaveLength(1);
  });

  it('stop() before the first plan finishes arms nothing', async () => {
    const { scheduler, timers } = make({ hours: 1 });
    scheduler.start();
    await scheduler.stop();
    expect(timers.pending).toBe(0);
  });

  it('start() twice does not double the chain', async () => {
    const { scheduler, timers } = make({ hours: 1, initial: [T0] });
    scheduler.start();
    scheduler.start();
    await flush();
    expect(timers.pending).toBe(1);
  });

  it('sleeps in chunks of at most 30 minutes (a 720 h interval exceeds the timer limit)', async () => {
    const { scheduler, timers, state } = make({ hours: 720, initial: [T0] });
    scheduler.start();
    await timers.advance(721 * HOUR_MS);
    expect(Math.max(...timers.delays)).toBeLessThanOrEqual(MAX_SLEEP_MS);
    expect(Math.max(...timers.delays)).toBeLessThan(2 ** 31 - 1);
    expect(state.creates).toHaveLength(1);
  });

  it('clock jumping forwards over several intervals runs once', async () => {
    const { scheduler, timers, state } = make({ hours: 6, initial: [T0 - HOUR_MS] });
    scheduler.start();
    await flush();
    await timers.jumpAndFire(3 * DAY); // suspended for three days
    await timers.advance(0);
    expect(state.attempts).toHaveLength(1);
    await timers.advance(5 * HOUR_MS);
    expect(state.attempts).toHaveLength(1);
  });

  it('clock jumping backwards recounts the interval instead of waiting for a time far away', async () => {
    const { scheduler, timers, state, logs } = make({ hours: 6, initial: [T0 - HOUR_MS] });
    scheduler.start();
    await flush();
    await timers.jumpAndFire(-10 * DAY);
    expect(logs.some((l) => /moved backwards/.test(l))).toBe(true);
    expect(scheduler.info()?.nextRunAt).toBe(new Date(timers.clock.now + 6 * HOUR_MS).toISOString());
    await timers.advance(6 * HOUR_MS + MIN);
    expect(state.attempts).toHaveLength(1);
  });

  it('a backup named in the future does not silence the scheduler', async () => {
    const { scheduler, timers, state } = make({ hours: 6, initial: [T0 + 30 * DAY] });
    scheduler.start();
    await timers.advance(6 * HOUR_MS + MIN);
    expect(state.attempts).toHaveLength(1);
  });

  it('a failing list() does not stop the schedule: a backup is attempted and decides', async () => {
    const { scheduler, timers, state } = make({ hours: 1 });
    state.listFails = true;
    scheduler.start();
    await timers.advance(2 * MIN);
    expect(state.attempts).toHaveLength(1);
    await timers.advance(HOUR_MS + MIN);
    expect(state.attempts.length).toBeGreaterThan(1);
    await scheduler.stop();
  });

  it('uses unref\'d real timers by default, and stop() destroys the pending one', async () => {
    vi.useFakeTimers();
    try {
      const s = new BackupScheduler({
        service: { list: async () => [], isRunning: () => false, create: vi.fn() } as never,
        config: { dataDir: tmp(), backupEveryHours: 1 },
        log: () => undefined,
      });
      s.start();
      await vi.advanceTimersByTimeAsync(0);
      const t = (s as unknown as { handle: { hasRef(): boolean } }).handle;
      expect(t).toBeTruthy();
      expect(t.hasRef()).toBe(false); // does not keep the process alive
      await s.stop();
      expect((s as unknown as { handle: unknown }).handle).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BackupScheduler with the real BackupService', () => {
  let env: BackupEnv | null = null;
  afterEach(() => {
    env?.cleanup();
    env = null;
  });
  const settle = (s: BackupScheduler) => async () => {
    for (let i = 0; i < 2000; i++) {
      await new Promise((r) => setTimeout(r, 5));
      if (!(s as unknown as { inflight: unknown }).inflight) return;
    }
    throw new Error('the scheduler never settled');
  };
  function setup(keep = 7, hours = 24) {
    env = makeEnv({ backupKeep: keep });
    const timers = new FakeTimers();
    timers.clock.now = env.clock.now;
    // one clock for the service and the scheduler
    const service = env.service({ now: () => timers.clock.now });
    const scheduler = new BackupScheduler({ service, config: { dataDir: env.config.dataDir, backupEveryHours: hours }, now: () => timers.clock.now, timers, random: () => 0, log: () => undefined });
    return { service, scheduler, timers, env };
  }

  it('writes trigger "scheduler" in the manifest, lists it, audits actor and trigger, and logs the durable record', async () => {
    const { service, scheduler, timers, env } = setup();
    scheduler.start();
    await timers.advance(CATCH_UP_DELAY_MS + 1, settle(scheduler));
    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ trigger: 'scheduler' });
    expect((await readBackup(join(service.dir, list[0]!.name))).manifest.trigger).toBe('scheduler');
    expect(env.audits.find((a) => a.event === 'backup.created')?.fields).toMatchObject({ actor: 'scheduler', trigger: 'scheduler' });
    await scheduler.stop();
  });

  it('prunes with (keep, "scheduler") but never evicts protected API backups', async () => {
    const { service, scheduler, timers, env } = setup(1, 1);
    // two API backups made by the page, 2 and 1 hours ago: protected for 7 days, not counted toward keep
    for (const ago of [2, 1]) {
      timers.clock.now = T0 - ago * HOUR_MS;
      await service.create({ actor: 'u1', trigger: 'api' });
    }
    // two CLI backups older than that
    for (const ago of [5, 4]) {
      timers.clock.now = T0 - ago * HOUR_MS;
      await service.create({ actor: 'cli', trigger: 'cli' });
    }
    timers.clock.now = T0;
    const auditsBefore = env.audits.length;
    // The newest backup (the API one) is 1 hour old and the interval 1 hour: due now
    scheduler.start();
    await timers.advance(CATCH_UP_DELAY_MS + 1, settle(scheduler));
    const list = await service.list();
    const byTrigger = (t: Trigger) => list.filter((b) => b.trigger === t).length;
    expect(byTrigger('api')).toBe(2); // protected
    expect(byTrigger('scheduler')).toBe(1);
    expect(byTrigger('cli')).toBe(0); // beyond keep=1 once the scheduled one exists
    expect(env.audits.slice(auditsBefore).filter((a) => a.event === 'backup.pruned').map((a) => a.fields.origin)).toEqual(['scheduler']);
    await scheduler.stop();
  });

  it('a disk-full run audits backup.failed with trigger scheduler, keeps old backups and shows a fixed sentence status', async () => {
    const { service, scheduler, timers, env } = setup(7, 24);
    await service.create({ actor: 'cli', trigger: 'cli' });
    const before = (await service.list()).map((b) => b.name);
    timers.clock.now = T0 + 3 * DAY;
    const full = env.service({ now: () => timers.clock.now, hooks: { freeBytes: () => 0 } });
    const s2 = new BackupScheduler({ service: full, config: { dataDir: env.config.dataDir, backupEveryHours: 24 }, now: () => timers.clock.now, timers, random: () => 0, log: () => undefined });
    s2.start();
    await timers.advance(CATCH_UP_DELAY_MS + 1, settle(s2));
    expect((await full.list()).map((b) => b.name)).toEqual(before);
    const failed = env.audits.filter((a) => a.event === 'backup.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.fields).toMatchObject({ actor: 'scheduler', trigger: 'scheduler' });
    expect(full.status()).toMatchObject({ lastErrorCode: 'disk' });
    expect(env.audits.some((a) => a.event === 'backup.pruned')).toBe(false); // a failure prunes nothing
    await s2.stop();
    await scheduler.stop();
  });

  it('skips with the restore marker present and the real service (nothing is written)', async () => {
    const { service, scheduler, timers, env } = setup();
    mkdirSync(env.config.dataDir, { recursive: true });
    writeFileSync(join(env.config.dataDir, RESTORE_MARKER), '{}');
    scheduler.start();
    await timers.advance(CATCH_UP_DELAY_MS + 1, settle(scheduler));
    expect(await service.list()).toHaveLength(0);
    expect(env.audits.some((a) => a.event === 'backup.failed')).toBe(false);
    await scheduler.stop();
  });

  it('does not overlap a manual backup that is running (the same mutex)', async () => {
    const { service, scheduler, timers, env } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = env.service({ now: () => timers.clock.now, hooks: { beforeSnapshot: () => gate } });
    const s2 = new BackupScheduler({ service: slow, config: { dataDir: env.config.dataDir, backupEveryHours: 24 }, now: () => timers.clock.now, timers, random: () => 0, log: () => undefined });
    const manual = slow.create({ actor: 'u1', trigger: 'api' });
    await new Promise((r) => setImmediate(r));
    expect(slow.isRunning()).toBe(true);
    s2.start();
    await timers.advance(CATCH_UP_DELAY_MS + 1, settle(s2));
    release();
    await manual;
    const list = await slow.list();
    expect(list.map((b) => b.trigger)).toEqual(['api']);
    await s2.stop();
    await scheduler.stop();
    void service;
  });
});
