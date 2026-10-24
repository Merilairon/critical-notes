import type { TestApp, TestClient } from './helpers';

export interface Frame {
  event: string;
  data: string;
  id?: string;
  retry?: number;
  raw: string;
}

/** Collects the frames of a server-sent event response in the background. */
export class EventReader {
  frames: Frame[] = [];
  ended = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private waiters: (() => void)[] = [];

  constructor(readonly res: Response) {
    this.reader = res.body!.getReader();
    void this.loop();
  }

  private async loop() {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let ix: number;
        while ((ix = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, ix);
          buffer = buffer.slice(ix + 2);
          const retry = /^retry: (.*)$/m.exec(raw)?.[1];
          this.frames.push({
            event: /^event: (.*)$/m.exec(raw)?.[1] ?? 'message',
            data: /^data: ?(.*)$/m.exec(raw)?.[1] ?? '',
            id: /^id: (.*)$/m.exec(raw)?.[1],
            retry: retry === undefined ? undefined : Number(retry),
            raw,
          });
          this.wake();
        }
      }
    } catch {
      // cancelled
    }
    this.ended = true;
    this.wake();
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** Frames other than heartbeats. */
  get events(): Frame[] {
    return this.frames.filter((f) => f.event !== 'ping');
  }

  /** Resolves with the first frame (from `from`) that matches, or throws after `ms`. */
  async until(pred: (f: Frame) => boolean, ms = 2500, from = 0): Promise<Frame> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.frames.slice(from).find(pred);
      if (hit) return hit;
      if (this.ended || Date.now() >= deadline) throw new Error(`no matching frame (have: ${this.frames.map((f) => f.event).join(', ')})`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, Math.max(1, deadline - Date.now()));
      });
    }
  }

  async endedWithin(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!this.ended && Date.now() < deadline) {
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 20);
      });
    }
    return this.ended;
  }

  /** Waits for `ms`, then returns the non-heartbeat frames received so far. */
  async settle(ms: number): Promise<Frame[]> {
    await new Promise((r) => setTimeout(r, ms));
    return this.events;
  }

  async cancel() {
    await this.reader.cancel().catch(() => undefined);
  }
}

export async function openEvents(app: TestApp, client: TestClient, campaignId: string, opts: { lastEventId?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { origin: 'http://localhost', host: 'localhost', ...opts.headers };
  if (client.cookie) headers['cookie'] = client.cookie;
  if (opts.lastEventId) headers['last-event-id'] = opts.lastEventId;
  const res = await app.request(`http://localhost/api/campaigns/${campaignId}/events`, { headers });
  const reader = res.status === 200 ? new EventReader(res) : null;
  return { res, reader: reader as EventReader };
}
