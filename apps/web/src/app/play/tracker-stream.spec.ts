import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTrackerStream } from './tracker-stream';

class FakeSource {
  static all: FakeSource[] = [];
  readyState = 1;
  closed = false;
  onerror: (() => void) | null = null;
  private handlers = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data: string) {
    for (const fn of this.handlers.get(type) ?? []) fn({ data } as MessageEvent<string>);
  }
}

describe('openTrackerStream', () => {
  beforeEach(() => {
    FakeSource.all = [];
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeSource);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('passes state through', () => {
    const states: string[] = [];
    openTrackerStream('/e', (d) => states.push(d), () => undefined);
    FakeSource.all[0]!.emit('state', '{"a":1}');
    expect(states).toEqual(['{"a":1}']);
  });

  it.each(['evicted', 'access'] as const)('bye %s closes and never reconnects', (reason) => {
    const pauses: string[] = [];
    openTrackerStream('/e', () => undefined, (w) => pauses.push(w));
    FakeSource.all[0]!.emit('bye', JSON.stringify({ reason }));
    vi.advanceTimersByTime(60_000);
    expect(FakeSource.all[0]!.closed).toBe(true);
    expect(FakeSource.all).toHaveLength(1);
    expect(pauses).toEqual([reason]);
  });

  it('bye restart reconnects once after a 3 to 6 s delay', () => {
    const pauses: string[] = [];
    openTrackerStream('/e', () => undefined, (w) => pauses.push(w));
    FakeSource.all[0]!.emit('bye', '{"reason":"restart"}');
    vi.advanceTimersByTime(2900);
    expect(FakeSource.all).toHaveLength(1);
    vi.advanceTimersByTime(3200);
    expect(FakeSource.all).toHaveLength(2);
    expect(pauses).toEqual([]);
  });

  it('reports a connection the browser gave up on (503 over the cap), but not a retrying one', () => {
    const pauses: string[] = [];
    openTrackerStream('/e', () => undefined, (w) => pauses.push(w));
    const es = FakeSource.all[0]!;
    es.readyState = 0;
    es.onerror?.();
    expect(pauses).toEqual([]);
    es.readyState = 2;
    es.onerror?.();
    expect(pauses).toEqual(['unavailable']);
  });

  it('close() cancels a pending reconnect', () => {
    const s = openTrackerStream('/e', () => undefined, () => undefined);
    FakeSource.all[0]!.emit('bye', '{"reason":"restart"}');
    s.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSource.all).toHaveLength(1);
  });
});
