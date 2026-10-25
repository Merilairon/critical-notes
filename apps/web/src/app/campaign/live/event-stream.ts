import { blockRevealedEvent, byeEvent, helloEvent, pageSharedEvent, type BlockRevealedEvent, type PageSharedEvent } from '@cn/shared';
import { SSE_MAX_BYTES, SseParser } from '../../core/sse-parser';

export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
/** No byte (a frame, a ping or a comment) for this long: the connection is dead, reconnect. */
export const SILENCE_MS = 60_000;
/** A connection that stays open this long counts as healthy: the backoff starts over. */
export const STABLE_MS = 60_000;
/** Failing for longer than this switches on the polling fallback. */
export const POLL_AFTER_MS = 120_000;
export const POLL_EVERY_MS = 60_000;
/** Back in a tab: a stream silent for longer than this (the server pings every 25 s) is treated as stalled. */
export const STALE_MS = 30_000;

/** `live` once `hello` arrived; `retrying` while waiting to reconnect; `paused` after `bye: evicted`; `polling` when the stream cannot be kept open. */
export type StreamState = 'idle' | 'connecting' | 'live' | 'retrying' | 'polling' | 'paused';

export interface StreamHandlers {
  /** `hello` arrived on a connection. `first` is true for the first one since `start()`. */
  onHello(info: { replayed: boolean; first: boolean }): void;
  onShared(event: PageSharedEvent): void;
  onRevealed(event: BlockRevealedEvent): void;
  onResync(): void;
  onState(state: StreamState): void;
  /** Polling fallback tick (every 60 s and when the tab gets focus again) while the stream cannot open. */
  onPoll(): void;
}

export interface StreamOptions {
  fetchFn?: typeof fetch;
  random?: () => number;
  /** For tests: a target for the window listeners (focus, online) and the document's visibilitychange. */
  win?: {
    addEventListener(type: 'focus' | 'online', listener: () => void): void;
    removeEventListener(type: 'focus' | 'online', listener: () => void): void;
    document?: {
      visibilityState: string;
      addEventListener(type: 'visibilitychange', listener: () => void): void;
      removeEventListener(type: 'visibilitychange', listener: () => void): void;
    };
  };
}

/** "Retry-After" as milliseconds (delta-seconds or an HTTP date); null when absent or unusable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const v = header.trim();
  if (/^\d+$/.test(v)) return Math.min(Number(v) * 1000, BACKOFF_MAX_MS);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.min(Math.max(at - now, 0), BACKOFF_MAX_MS);
}

/**
 * Client for `GET /api/campaigns/:cid/events` (docs/design/reveal.md section 5). Uses fetch with a streamed body and its own
 * SSE parser because a native EventSource never retries after a non-200 answer and cannot send Last-Event-ID itself.
 *
 * Every failure (network error, non-200, stream end, 60 s of silence) goes the same way: close, wait with full-jitter
 * exponential backoff (1 s doubling to 30 s; `Retry-After` and the server's `retry:` are a floor), reconnect with the last
 * `id:` as `Last-Event-ID`. `bye: evicted` stops for good until `resume()`. The owner of this object decides what to refetch on
 * every `onHello`.
 */
export class CampaignEventStream {
  private readonly fetchFn: typeof fetch;
  private readonly random: () => number;
  private readonly win: StreamOptions['win'];
  private state: StreamState = 'idle';
  private run = 0;
  private abort: AbortController | null = null;
  private lastId: string | null = null;
  private lastByteAt = 0;
  private attempt = 0;
  private serverRetry = 0;
  private everHello = false;
  private failingSince: number | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private silence: ReturnType<typeof setTimeout> | undefined;
  private stable: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private readonly onFocus = () => {
    if (this.state === 'polling' && this.win?.document?.visibilityState !== 'hidden') this.handlers.onPoll();
  };

  constructor(
    private readonly url: string,
    private readonly handlers: StreamHandlers,
    options: StreamOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? ((...args) => globalThis.fetch(...args));
    this.random = options.random ?? Math.random;
    this.win = options.win ?? (typeof window === 'undefined' ? undefined : window);
  }

  start() {
    if (this.state !== 'idle') return;
    this.win?.addEventListener('online', this.onOnline);
    this.win?.document?.addEventListener('visibilitychange', this.onVisible);
    this.begin();
  }

  /**
   * The network came back or the tab was shown again: a stalled stream would only be noticed by the 60 s silence watchdog,
   * so reconnect now (the old connection is aborted first, so there is never a second stream). Ignored while idle or paused.
   * Coming back to a tab, a stream that delivered something in the last STALE_MS is left alone.
   */
  private nudge(force: boolean) {
    if (this.state === 'idle' || this.state === 'paused') return;
    if (!force && (this.state === 'connecting' || (this.state === 'live' && Date.now() - this.lastByteAt < STALE_MS))) return;
    this.attempt = 0;
    void this.connect();
  }

  private readonly onOnline = () => this.nudge(true);
  private readonly onVisible = () => {
    if (this.win?.document?.visibilityState === 'visible') this.nudge(false);
  };

  /** The Resume button of a paused tab. */
  resume() {
    if (this.state !== 'paused') return;
    this.begin();
  }

  stop() {
    this.run++;
    this.teardown();
    this.stopPolling();
    this.win?.removeEventListener('online', this.onOnline);
    this.win?.document?.removeEventListener('visibilitychange', this.onVisible);
    this.setState('idle');
  }

  private begin() {
    this.attempt = 0;
    this.failingSince = null;
    void this.connect();
  }

  private setState(next: StreamState) {
    if (this.state === next) return;
    this.state = next;
    this.handlers.onState(next);
  }

  private teardown() {
    this.abort?.abort();
    this.abort = null;
    clearTimeout(this.silence);
    clearTimeout(this.stable);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private async connect() {
    const run = ++this.run;
    this.teardown();
    this.setState(this.state === 'polling' ? 'polling' : 'connecting');
    const abort = new AbortController();
    this.abort = abort;
    let floor = 0;
    let evicted = false;
    try {
      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      if (this.lastId) headers['Last-Event-ID'] = this.lastId;
      this.armSilence(run);
      const res = await this.fetchFn(this.url, { headers, credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
      if (run !== this.run) return;
      if (!res.ok || !res.body) {
        floor = retryAfterMs(res.headers.get('Retry-After')) ?? 0;
        void res.body?.cancel().catch(() => undefined);
        throw new Error(`events ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (run !== this.run) return;
        if (done) break;
        this.armSilence(run);
        this.lastByteAt = Date.now();
        for (const frame of parser.feed(decoder.decode(value, { stream: true }))) {
          if (parser.retry != null) this.serverRetry = Math.min(parser.retry, BACKOFF_MAX_MS);
          if (this.dispatch(frame.event, frame.data, frame.id, run) === 'evicted') {
            evicted = true;
            abort.abort();
            break;
          }
          if (run !== this.run) return;
        }
        if (evicted) break;
        if (parser.retry != null) this.serverRetry = Math.min(parser.retry, BACKOFF_MAX_MS);
      }
    } catch {
      if (run !== this.run) return;
    }
    if (run !== this.run) return;
    this.teardown();
    if (evicted) {
      this.stopPolling();
      this.setState('paused');
      return;
    }
    this.scheduleRetry(floor);
  }

  private armSilence(run: number) {
    clearTimeout(this.silence);
    this.silence = setTimeout(() => {
      if (run === this.run) this.abort?.abort();
    }, SILENCE_MS);
  }

  private dispatch(event: string, data: string, id: string | null, run: number): 'evicted' | undefined {
    if (id) this.lastId = id;
    if (data.length > SSE_MAX_BYTES) return; // never parse something this server does not send
    let json: unknown;
    try {
      json = data ? JSON.parse(data) : {};
    } catch {
      return;
    }
    switch (event) {
      case 'hello': {
        const hello = helloEvent.safeParse(json);
        if (!hello.success) return;
        this.onLive(run);
        const first = !this.everHello;
        this.everHello = true;
        this.handlers.onHello({ replayed: hello.data.replayed, first });
        return;
      }
      case 'page-shared': {
        const e = pageSharedEvent.safeParse(json);
        if (e.success) this.handlers.onShared(e.data);
        return;
      }
      case 'block-revealed': {
        const e = blockRevealedEvent.safeParse(json);
        if (e.success) this.handlers.onRevealed(e.data);
        return;
      }
      case 'resync':
        this.handlers.onResync();
        return;
      case 'bye': {
        const bye = byeEvent.safeParse(json);
        if (bye.success && bye.data.reason === 'evicted') return 'evicted';
        return;
      }
      default:
        return; // ping and anything unknown
    }
  }

  private onLive(run: number) {
    this.failingSince = null;
    this.stopPolling();
    this.setState('live');
    clearTimeout(this.stable);
    this.stable = setTimeout(() => {
      if (run === this.run) this.attempt = 0;
    }, STABLE_MS);
  }

  private scheduleRetry(floor: number) {
    const now = Date.now();
    this.failingSince ??= now;
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    this.attempt++;
    const delay = Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, this.random() * cap, floor, this.serverRetry));
    if (now - this.failingSince >= POLL_AFTER_MS) this.startPolling();
    else if (this.state !== 'polling') this.setState('retrying');
    const t = setTimeout(() => {
      this.timers.delete(t);
      void this.connect();
    }, delay);
    this.timers.add(t);
  }

  private startPolling() {
    if (this.poll) return;
    this.setState('polling');
    this.poll = setInterval(() => this.handlers.onPoll(), POLL_EVERY_MS);
    this.win?.addEventListener('focus', this.onFocus);
    this.handlers.onPoll();
  }

  private stopPolling() {
    if (!this.poll) return;
    clearInterval(this.poll);
    this.poll = undefined;
    this.win?.removeEventListener('focus', this.onFocus);
  }
}
