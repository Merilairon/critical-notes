/** Invite links: what a link leads to (no sign-in needed) and joining with it. */
import { Hono } from 'hono';
import { requireUser, type AppEnv } from '../auth/session';
import type { CampaignService } from '../services/campaigns';

export function inviteRoutes(campaigns: CampaignService) {
  const app = new Hono<AppEnv>();

  app.get('/:token', (c) => c.json(campaigns.inviteInfo(c.req.param('token'), c.get('user')?.id ?? null)));

  app.post('/:token/accept', requireUser, (c) => c.json({ campaignId: campaigns.acceptInvite(c.req.param('token'), c.get('user')!.id) }));

  return app;
}
