/**
 * Shared server-sent events plumbing for the tracker stream and the campaign event stream: headers, the heartbeat, cleanup on
 * abort and a BOUNDED write queue. A reader that stops reading gets dropped (it reconnects and refetches) instead of making the
 * server buffer without limit.
 */
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

export const HEARTBEAT_MS = 25_000;
/** Pending writes allowed per connection (events are about 100 bytes). */
export const MAX_PENDING_WRITES = 50;
/** `end()` waits this long for its last frame; a stalled reader is then cut instead of holding the socket. */
export const END_WRITE_WAIT_MS = 500;

/** One frame as text. `retry:` goes first to match the design sketch (docs/design/reveal.md section 4); clients ignore field order. */
function encode(f: SseFrame): string {
  for (const v of [f.event, f.id]) if (v && /[\r\n]/.test(v)) throw new Error('SSE event and id must be single-line');
  const lines = [
    ...(f.retry !== undefined ? [`retry: ${f.retry}`] : []),
    `event: ${f.event}`,
    ...(f.data ?? '').split(/\r\n|\r|\n/).map((l) => `data: ${l}`),
    ...(f.id !== undefined ? [`id: ${f.id}`] : []),
  ];
  return `${lines.join('\n')}\n\n`;
}

export interface SseFrame {
  event: string;
  /** Single-line payload (JSON); empty for a heartbeat. */
  data?: string;
  id?: string;
  /** Reconnect delay hint for the client, in ms. */
  retry?: number;
}

export interface SseChannel {
  /** Queues a frame. False when the channel is closed, or the queue overflowed (the connection is then dropped). */
  send(frame: SseFrame): boolean;
  /** Writes a last frame (not counted against the queue limit), then closes. */
  end(frame?: SseFrame): void;
  close(): void;
  readonly closed: boolean;
}

export interface SseOptions {
  heartbeatMs?: number;
  maxPending?: number;
  /** Runs on every heartbeat tick, before the ping; may close the channel (re-validation). */
  onHeartbeat?: (ch: SseChannel) => void;
  /** Runs once, synchronously, as the stream starts. Returns the cleanup that runs when the connection ends. */
  open: (ch: SseChannel) => (() => void) | void;
}

export function sseResponse(c: Context, opts: SseOptions): Response {
  const res = streamSSE(c, async (stream) => {
    const maxPending = opts.maxPending ?? MAX_PENDING_WRITES;
    let pending = 0;
    let isClosed = false;
    let ending = false;
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const finish = (hard: boolean) => {
      if (isClosed) return;
      isClosed = true;
      if (hard) void stream.abort();
      resolve();
    };
    const write = (text: string) => stream.write(text);
    const channel: SseChannel = {
      get closed() {
        return isClosed;
      },
      send(f) {
        if (isClosed || ending) return false;
        if (pending >= maxPending) {
          finish(true);
          return false;
        }
        // Encode first: a frame that cannot be encoded must not leak the counter or throw into the publisher
        let text: string;
        try {
          text = encode(f);
        } catch {
          return false;
        }
        pending++;
        void write(text).then(() => void pending--);
        return true;
      },
      end(f) {
        if (isClosed || ending) return;
        ending = true;
        let text: string | null = null;
        try {
          text = f ? encode(f) : null;
        } catch {
          // an unencodable last frame: just close
        }
        if (text) {
          const cut = setTimeout(() => finish(true), END_WRITE_WAIT_MS);
          void write(text).then(() => {
            clearTimeout(cut);
            finish(false);
          });
        } else finish(false);
      },
      close: () => finish(false),
    };
    stream.onAbort(() => finish(false));
    const cleanup = opts.open(channel);
    const timer = setInterval(() => {
      opts.onHeartbeat?.(channel);
      channel.send({ event: 'ping' });
    }, opts.heartbeatMs ?? HEARTBEAT_MS);
    await done;
    clearInterval(timer);
    cleanup?.();
  });
  res.headers.set('cache-control', 'no-store');
  res.headers.set('x-accel-buffering', 'no');
  return res;
}
