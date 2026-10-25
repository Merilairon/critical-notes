import { CampaignEventStream, retryAfterMs, type StreamHandlers, type StreamState } from './event-stream';

interface Conn {
  init: RequestInit;
  push(text: string): void;
  end(): void;
}

/** A fetch whose answers the test scripts: `answers` is consumed one per call (a number is an error status). */
function fakeFetch(answers: (number | { status: number; retryAfter?: string } | 'stream')[]) {
  const conns: Conn[] = [];
  const calls: RequestInit[] = [];
  const fn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls.push(init ?? {});
    const next = answers.shift() ?? 'stream';
    if (next !== 'stream') {
      const o = typeof next === 'number' ? { status: next } : next;
      return new Response('', { status: o.status, headers: o.retryAfter ? { 'Retry-After': o.retryAfter } : {} });
    }
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
    init?.signal?.addEventListener('abort', () => {
      try {
        ctl.error(new DOMException('aborted', 'AbortError'));
      } catch {
        /* already closed */
      }
    });
    const enc = new TextEncoder();
    conns.push({
      init: init ?? {},
      push: (t) => ctl.enqueue(enc.encode(t)),
      end: () => ctl.close(),
    });
    return new Response(body, { status: 200 });
  });
  return { fn: fn as unknown as typeof fetch, calls, conns, spy: fn };
}

function handlers() {
  const log = {
    hello: [] as { replayed: boolean; first: boolean }[],
    shared: [] as string[],
    revealed: [] as { pageId: string; blockIds: string[] }[],
    resync: 0,
    polls: 0,
    states: [] as StreamState[],
  };
  const h: StreamHandlers = {
    onHello: (i) => log.hello.push(i),
    onShared: (e) => log.shared.push(e.pageId),
    onRevealed: (e) => log.revealed.push(e),
    onResync: () => void log.resync++,
    onState: (s) => log.states.push(s),
    onPoll: () => void log.polls++,
  };
  return { h, log };
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const win = () => {
  const l = new Map<string, Set<() => void>>();
  const set = (t: string) => l.get(t) ?? l.set(t, new Set()).get(t)!;
  const add = (t: string, f: () => void) => void set(t).add(f);
  const remove = (t: string, f: () => void) => void set(t).delete(f);
  return {
    addEventListener: add as (t: 'focus' | 'online', f: () => void) => void,
    removeEventListener: remove as (t: 'focus' | 'online', f: () => void) => void,
    fire: (t = 'focus') => set(t).forEach((f) => f()),
    count: (t: string) => set(t).size,
    document: { visibilityState: 'visible', addEventListener: add as (t: 'visibilitychange', f: () => void) => void, removeEventListener: remove as (t: 'visibilitychange', f: () => void) => void },
  };
};

describe('CampaignEventStream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('connects with the cookie, no Last-Event-ID first, then sends the last id on reconnect', async () => {
    const f = fakeFetch(['stream', 'stream']);
    const { h, log } = handlers();
    const s = new CampaignEventStream('/api/campaigns/c1/events', h, { fetchFn: f.fn, random: () => 0, win: win() });
    s.start();
    await tick();
    expect(f.calls[0]).toMatchObject({ credentials: 'same-origin', headers: { Accept: 'text/event-stream' } });
    expect((f.calls[0]?.headers as Record<string, string>)['Last-Event-ID']).toBeUndefined();
    f.conns[0]!.push('retry: 3000\nevent: hello\ndata: {"replayed":false}\n\nid: tok1\nevent: page-shared\ndata: {"pageId":"p1"}\n\n');
    await tick();
    expect(log.hello).toEqual([{ replayed: false, first: true }]);
    expect(log.shared).toEqual(['p1']);
    expect(log.states.at(-1)).toBe('live');
    f.conns[0]!.end();
    await tick(3000);
    expect(f.calls).toHaveLength(2);
    expect((f.calls[1]?.headers as Record<string, string>)['Last-Event-ID']).toBe('tok1');
    f.conns[1]!.push('event: hello\ndata: {"replayed":true}\n\n');
    await tick();
    expect(log.hello.at(-1)).toEqual({ replayed: true, first: false });
    s.stop();
  });

  it('control events never move Last-Event-ID', async () => {
    const f = fakeFetch(['stream', 'stream']);
    const { h } = handlers();
    const s = new CampaignEventStream('/e', h, { fetchFn: f.fn, random: () => 0, win: win() });
    s.start();
    await tick();
    f.conns[0]!.push('event: hello\ndata: {"replayed":false}\n\nevent: ping\ndata:\n\n');
    await tick();
    f.conns[0]!.end();
    await tick(2000);
    expect((f.calls[1]?.headers as Record<string, string>)['Last-Event-ID']).toBeUndefined();
    s.stop();
  });

  it('keeps trying after a non-200 and honours Retry-After as a floor (native EventSource would give up)', async () => {
    const f = fakeFetch([{ status: 503, retryAfter: '7' }, 'stream']);
    const { h, log } = handlers();
    const s = new CampaignEventStream('/e', h, { fetchFn: f.fn, random: () => 0, win: win() });
    s.start();
    await tick();
    expect(log.states.at(-1)).toBe('retrying');
    await tick(6500);
    expect(f.spy).toHaveBeenCalledTimes(1);
    await tick(600);
    expect(f.spy).toHaveBeenCalledTimes(2);
    f.conns[0]!.push('event: hello\ndata: {"replayed":false}\n\n');
    await tick();
    expect(log.states.at(-1)).toBe('live');
    s.stop();
  });

  it('uses full-jitter exponential backoff between 1 s and 30 s', async () => {
    const f = fakeFetch([500, 500, 500, 500, 500, 500, 500]);
    const { h } = handlers();
    const s = new CampaignEventStream('/e', h, { fetchFn: f.fn, random: () => 1, win: win() });
    s.start();
    await tick();
    // random()=1 -> delay equals the cap: 1, 2, 4, 8, 16, 30, 30 s
    const gaps = [1000, 2000, 4000, 8000, 16000, 30000];
    for (const [i, gap] of gaps.entries()) {
      await tick(gap - 1);
      expect(f.spy).toHaveBeenCalledTimes(i + 1);
      await tick(1);
      expect(f.spy).toHaveBeenCalledTimes(i + 2);
    }
    s.stop();
  });

  it('jitters: random()=0 still waits the 1 s floor', async () => {
    const f = fakeFetch([500, 'stream']);
    const { h } = handlers();
    const s = new CampaignEventStream('/e', h, { fetchFn: f.fn, random: () => 0, win: win() });
    s.start();
    await tick(999);
    expect(f.spy).toHaveBeenCalledTimes(1);
    await tick(2);
    expect(f.spy).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('stops for good after bye evicted until Resume; reconnects after bye restart', async () => {
    const f = fakeFetch(['stream', 'stream', 'stream']);
    const { h, log } = handlers();
    const s = new CampaignEventStream('/e', h, { fetchFn: f.fn, random: () => 0, win: win() });
    s.start();
    await tick();
    f.conns[0]!.push('event: bye\ndata: {"reason":"restart"}\n\n');
    f.conns[0]!.end();
    await tick(2000);
    expect(f.spy).toHaveBeenCalledTimes(2);
    f.conns[1]!.push('event: bye\ndata: {"reason":"evicted"}\n\n');
    await tick();
    expect(log.states.at(-1)).toBe('paused');
    await tick(120_000);
    expect(f.spy).toHaveBeenCalledTimes(2);
    s.resume();
    await tick();
    expect(f.spy).toHaveBeenCalledTimes(3);
    s.stop();
  });

  it('ignores frames that fail the strict schemas and handles resync', async () => {
    const f = fakeFetch(['stream']);
    const { h, log } = handlers();
    const s = new CampaignEventStream('/e', h, { fetchFn: f.fn, random: () => 0, win: win() });
    s.start();
    await tick();
    f.conns[0]!.push(
      'event: page-shared\ndata: {"pageId":"p1","title":"leak"}\n\n' +
        'event: page-shared\ndata: not json\n\n' +
        'event: block-revealed\ndata: {"pageId":"p2","blockIds":["b1","b2"]}\n\n' +
        'event: surprise\ndata: {}\n\n' +
        'event: resync\ndata: {}\n\n',
    );
    await tick();
    expect(log.shared).toEqual([]);
    expect(log.revealed).toEqual([{ pageId: 'p2', blockIds: ['b1', 'b2'] }]);
    expect(log.resync).toBe(1);
    s.stop();
  });

  it('reconnects after 60 s of silence', async () => {
    const f = fakeFetch(['stream', 'stream']);
    const { h } = handlers();
    const s = new CampaignEventStream('/e', h, { fetchFn: f.fn, random: () => 0, win: win() });
    s.start();
    await tick();
    f.conns[0]!.push('event: hello\ndata: {"replayed":false}\n\n');
    await tick(59_000);
    expect(f.spy).toHaveBeenCalledTimes(1);
    await tick(3000);
    expect(f.spy).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('falls back to polling after 2 minutes of failure (every 60 s and on focus) and stops when the stream opens', async () => {
    const f = fakeFetch(Array.from({ length: 40 }, () => 500));
    const { h, log } = handlers();
    const w = win();
    const s = new CampaignEventStream('/e', h, { fetchFn: f.fn, random: () => 1, win: w });
    s.start();
    await tick(110_000);
    expect(log.polls).toBe(0);
    await tick(40_000);
    expect(log.states).toContain('polling');
    const first = log.polls;
    expect(first).toBeGreaterThanOrEqual(1);
    await tick(60_000);
    expect(log.polls).toBe(first + 1);
    w.fire();
    expect(log.polls).toBe(first + 2);
    // the next attempt succeeds: polling stops
    f.conns.length = 0;
    while (!f.conns.length) await tick(1000);
    f.conns[0]!.push('event: hello\ndata: {"replayed":false}\n\n');
    await tick();
    expect(log.states.at(-1)).toBe('live');
    const after = log.polls;
    await tick(120_000);
    w.fire();
    expect(log.polls).toBe(after);
    s.stop();
  });

  it('reconnects at once when the network comes back, even though the old connection looks alive (no second stream)', async () => {
    const f = fakeFetch(['stream', 'stream']);
    const { h, log } = handlers();
    const w = win();
    const s = new CampaignEventStream('/e', h, { fetchFn: f.fn, random: () => 0, win: w });
    s.start();
    await tick();
    f.conns[0]!.push('event: hello\ndata: {"replayed":false}\n\nid: t1\nevent: page-shared\ndata: {"pageId":"p1"}\n\n');
    await tick();
    // offline: nothing arrives; online fires well before the 60 s watchdog
    await tick(5000);
    w.fire('online');
    await tick();
    expect(f.spy).toHaveBeenCalledTimes(2);
    expect((f.calls[1]?.headers as Record<string, string>)['Last-Event-ID']).toBe('t1');
    f.conns[1]!.push('event: hello\ndata: {"replayed":true}\n\n');
    await tick();
    expect(log.hello.at(-1)).toEqual({ replayed: true, first: false });
    // the first connection was aborted: its late frames reach nobody
    expect(() => f.conns[0]!.push('event: page-shared\ndata: {"pageId":"ghost"}\n\n')).toThrow(); // already aborted
    await tick();
    expect(log.shared).toEqual(['p1']);
    s.stop();
    expect(w.count('online')).toBe(0);
    expect(w.count('visibilitychange')).toBe(0);
  });

  it('on returning to the tab reconnects only a stream that went quiet for 30 s, and never while paused', async () => {
    const f = fakeFetch(['stream', 'stream', 'stream']);
    const { h } = handlers();
    const w = win();
    const s = new CampaignEventStream('/e', h, { fetchFn: f.fn, random: () => 0, win: w });
    s.start();
    await tick();
    f.conns[0]!.push('event: hello\ndata: {"replayed":false}\n\n');
    await tick(10_000);
    w.fire('visibilitychange');
    await tick();
    expect(f.spy).toHaveBeenCalledTimes(1);
    await tick(25_000);
    w.fire('visibilitychange');
    await tick();
    expect(f.spy).toHaveBeenCalledTimes(2);
    f.conns[1]!.push('event: bye\ndata: {"reason":"evicted"}\n\n');
    await tick();
    w.fire('online');
    await tick();
    expect(f.spy).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('parses Retry-After seconds and dates, capped at 30 s', () => {
    expect(retryAfterMs('5')).toBe(5000);
    expect(retryAfterMs('9999')).toBe(30_000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('nonsense')).toBeNull();
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
  });
});
