import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { sseResponse } from '../src/lib/sse';
import { EventReader } from './events-helpers';

describe('sseResponse heartbeat', () => {
  it('a throwing onHeartbeat closes that stream, clears its timer and does not take the process down', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let cleaned = 0;
    const app = new Hono();
    app.get('/bad', (c) =>
      sseResponse(c, {
        heartbeatMs: 20,
        onHeartbeat: () => {
          throw new Error('SQLITE_BUSY');
        },
        open: () => () => void cleaned++,
      }),
    );
    app.get('/good', (c) => sseResponse(c, { heartbeatMs: 20, open: () => undefined }));
    const bad = new EventReader(await app.request('/bad'));
    const good = new EventReader(await app.request('/good'));
    expect(await bad.endedWithin(1000)).toBe(true);
    await good.until((f) => f.event === 'ping');
    expect(good.ended).toBe(false);
    expect(cleaned).toBe(1);
    expect(errors).toHaveBeenCalled();
    await good.cancel();
    errors.mockRestore();
  });
});
