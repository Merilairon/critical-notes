import { byeEvent } from '@cn/shared';

export type TrackerStreamPause = 'evicted' | 'access' | 'unavailable';

export const pauseMessage = (p: TrackerStreamPause) =>
  p === 'evicted'
    ? 'Live updates paused: this tracker is open in too many places. Reload to resume.'
    : p === 'access'
      ? 'Live updates stopped: you no longer have access to this tracker.'
      : 'Live updates are unavailable right now. Reload to try again.';

export interface TrackerStream {
  close(): void;
}

/**
 * A tracker's live `state` events. Native EventSource would reconnect after every close, which with the stream caps turns an
 * eviction into an endless swap between tabs. So: `bye evicted` and `bye access` stop for good (the owner shows a notice), a
 * `bye restart` reconnects after a random 3 to 6 s, and a connection the browser gave up on (a 503 over the cap) is reported.
 */
export function openTrackerStream(url: string, onState: (data: string) => void, onPause: (why: TrackerStreamPause) => void): TrackerStream {
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const connect = () => {
    es = new EventSource(url);
    const mine = es;
    mine.addEventListener('state', (e) => onState((e as MessageEvent<string>).data));
    mine.addEventListener('bye', (e) => {
      mine.close();
      if (stopped || es !== mine) return;
      let reason: string | undefined;
      try {
        const parsed = byeEvent.safeParse(JSON.parse((e as MessageEvent<string>).data));
        reason = parsed.success ? parsed.data.reason : undefined;
      } catch {
        reason = undefined;
      }
      if (reason === 'evicted' || reason === 'access') {
        stopped = true;
        onPause(reason);
        return;
      }
      timer = setTimeout(connect, 3000 + Math.random() * 3000);
    });
    mine.onerror = () => {
      if (!stopped && es === mine && mine.readyState === 2) {
        stopped = true;
        onPause('unavailable');
      }
    };
  };
  connect();
  return {
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      es?.close();
    },
  };
}
