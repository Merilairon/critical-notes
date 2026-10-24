/**
 * `GET /api/campaigns/:campaignId/events`: the campaign event stream (docs/design/reveal.md). Cookie session only: API tokens get
 * 403, a non-member the usual 404. No query-string credentials and no CORS headers. The path ends in `/events`, which `app.ts`
 * keeps out of compression.
 */
import { Hono } from 'hono';
import { requireUser, type AppEnv } from '../auth/session';
import { forbidden } from '../lib/http';
import { sseResponse } from '../lib/sse';
import type { CampaignService } from '../services/campaigns';
import type { EventStreamHub } from '../services/event-streams';

export function eventRoutes(deps: { campaigns: CampaignService; eventStreams: EventStreamHub }) {
  const { campaigns, eventStreams } = deps;
  const app = new Hono<AppEnv>();
  app.use('*', requireUser);

  app.get('/:campaignId/events', (c) => {
    if (c.get('tokenScope')) throw forbidden('API tokens cannot open the event stream');
    const campaignId = c.req.param('campaignId');
    const userId = c.get('user')!.id;
    const sessionId = c.get('sessionId');
    if (!sessionId) throw forbidden('The event stream needs a browser session');
    campaigns.access(campaignId, userId);
    const lastEventId = c.req.header('last-event-id')?.slice(0, 64) || null;
    const conn = eventStreams.admit({ campaignId, userId, sessionId, lastEventId });
    return sseResponse(c, {
      heartbeatMs: eventStreams.heartbeatMs,
      onHeartbeat: () => eventStreams.heartbeat(conn),
      open: (ch) => eventStreams.open(conn, ch),
    });
  });

  return app;
}
