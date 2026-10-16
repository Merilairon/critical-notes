import type { Context } from 'hono';
import { HttpError } from './http';

export interface LimiterOptions {
  /** Cap on tracked keys, so spoofed or random keys cannot grow the map without bound. */
  maxKeys?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/**
 * Fixed-window counter per key, in memory (one process). Expired entries are pruned on write, and when the
 * map is still full the oldest keys are dropped, so memory stays bounded under key flooding.
 * A budget is temporary: it only ever answers 429 until the window ends, never locks anything permanently.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { n: number; reset: number }>();
  private readonly maxKeys: number;
  private readonly now: () => number;
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    opts: LimiterOptions = {},
  ) {
    this.maxKeys = opts.maxKeys ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  get size() {
    return this.hits.size;
  }

  /** Throws 429 when the key's budget is used up. Does not count. */
  assert(key: string) {
    const entry = this.hits.get(key);
    const now = this.now();
    if (entry && entry.reset > now && entry.n >= this.max) {
      throw new HttpError(429, 'Too many attempts, try again later', undefined, Math.max(1, Math.ceil((entry.reset - now) / 1000)));
    }
  }

  /** Counts one use (a failure, or an attempt) against the key. */
  fail(key: string) {
    const now = this.now();
    const entry = this.hits.get(key);
    if (entry && entry.reset > now) {
      entry.n++;
      return;
    }
    this.hits.delete(key);
    this.prune(now);
    this.hits.set(key, { n: 1, reset: now + this.windowMs });
  }

  /** `assert` then `fail`: counts every attempt, refuses once the budget is used. */
  hit(key: string) {
    this.assert(key);
    this.fail(key);
  }

  /** Takes back exactly one counted use (never below zero; the key is dropped at zero). */
  give(key: string) {
    const entry = this.hits.get(key);
    if (!entry) return;
    if (--entry.n <= 0) this.hits.delete(key);
  }

  clear(key: string) {
    this.hits.delete(key);
  }

  private prune(now: number) {
    if (this.hits.size < this.maxKeys) return;
    for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    // Map iterates in insertion order: drop the oldest until there is room.
    for (const k of this.hits.keys()) {
      if (this.hits.size < this.maxKeys) break;
      this.hits.delete(k);
    }
  }
}

type Env = { incoming?: { socket?: { remoteAddress?: string } } } | undefined;

/**
 * Builds the function that names the caller for rate limiting. `X-Forwarded-For` is client-controlled unless a
 * proxy we trust overwrites it, so it is read only when `trustProxy` is set (the rightmost entry, the one the
 * trusted proxy appended). Otherwise the key is the socket address. The first request that carries the header
 * while it is ignored logs one warning, since behind a proxy every user then shares one address.
 */
export function createClientKey(trustProxy: boolean, warn: (msg: string) => void = (m) => console.warn(m)) {
  let warned = false;
  return (c: Context): string => {
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded && !trustProxy && !warned) {
      warned = true;
      warn('X-Forwarded-For header received but ignored (TRUST_PROXY is off). Behind a reverse proxy? Set TRUST_PROXY=1, but only if the proxy overwrites that header.');
    }
    if (trustProxy && forwarded) {
      const last = forwarded.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
      if (last) return last;
    }
    return (c.env as Env)?.incoming?.socket?.remoteAddress ?? 'local';
  };
}
