/**
 * Page history is for the GM only (N1.3/N1.4/N1.6): a real player gets 403 on the three history routes and sees no
 * History button.
 *
 * This is part of the history tests but lives in its own file on purpose: it needs the signed-in player that
 * `players.spec.ts` saves in PLAYER_STATE, and files run in alphabetical order, so `history.spec.ts` runs before she
 * exists. A sign-up of its own would use up the 8 a minute that `trash.spec.ts` needs. This file sorts after
 * `players.spec.ts` (and, run alone, falls back to one sign-up).
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { expect, test, type BrowserContext } from '@playwright/test';
import { PLAYER_STATE } from './env';
import { api, baseUrl, sharedPage, watch } from './support';

const shared = sharedPage();
const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

test('a player cannot reach the history: 403 on all three routes and no History button', async ({ browser }) => {
  const { page } = shared;
  const campaignId = (await api<{ id: string }>(page, 'POST', '/api/campaigns', { name: 'History rights', ruleset: '2014' })).id;
  const created = await api<{ id: string; revision: number }>(page, 'POST', `/api/campaigns/${campaignId}/pages`, { title: 'Salt Road', type: 'location', visibility: 'all', body: doc('Original road') });
  const pageId = created.id;
  const edited = await api<{ revision: number }>(page, 'PATCH', `/api/campaigns/${campaignId}/pages/${pageId}`, { body: doc('Road as the GM wrote it'), revision: created.revision });
  const hist = `/api/campaigns/${campaignId}/pages/${pageId}/history`;
  const inviteToken = (await api<{ token: string }>(page, 'POST', `/api/campaigns/${campaignId}/invites`, { role: 'player', expiresInDays: 1, maxUses: 1 })).token;

  // Her session from players.spec.ts when it works (sign-ups are rate limited to 8 a minute), else one sign-up
  let context: BrowserContext | undefined;
  if (existsSync(PLAYER_STATE)) {
    const saved = await browser.newContext({ baseURL: baseUrl(), viewport: { width: 1440, height: 1000 }, storageState: PLAYER_STATE });
    if (((await (await saved.request.get('/api/auth/me')).json()) as { user: unknown }).user) context = saved;
    else await saved.close();
  }
  if (context) {
    const accepted = await context.request.post(`/api/invites/${inviteToken}/accept`, { headers: { origin: baseUrl() } });
    expect(accepted.ok(), `accept invite: ${accepted.status()}`).toBe(true);
  } else {
    const run = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
    context = await browser.newContext({ baseURL: baseUrl(), viewport: { width: 1440, height: 1000 }, storageState: { cookies: [], origins: [] } });
    const res = await context.request.post('/api/auth/register', {
      data: { token: inviteToken, username: `hst${run}`, displayName: `History Player ${run}`, password: `pw-${run}-${randomBytes(6).toString('hex')}` },
      headers: { origin: baseUrl() },
    });
    expect(res.status(), 'register').toBe(201);
  }

  const errors: string[] = [];
  try {
    const player = watch(await context.newPage(), errors);
    const headers = { origin: baseUrl() };
    expect((await player.request.get(hist, { headers })).status(), 'list').toBe(403);
    expect((await player.request.get(`${hist}/${created.revision}`, { headers })).status(), 'one version').toBe(403);
    expect((await player.request.post(`${hist}/${created.revision}/restore`, { headers, data: { revision: edited.revision } })).status(), 'restore').toBe(403);
    // The refused restore changed nothing
    const current = await api<{ body: unknown; revision: number }>(page, 'GET', `/api/campaigns/${campaignId}/pages/${pageId}`);
    expect(current.revision).toBe(edited.revision);
    expect(JSON.stringify(current.body)).toContain('Road as the GM wrote it');

    // She reads the page, with no History button (the page is read-only for her: no editor)
    await player.goto(`/c/${campaignId}/p/${pageId}`);
    await expect(player.getByRole('heading', { name: 'Salt Road', level: 1 })).toBeVisible();
    await expect(player.getByText('Road as the GM wrote it')).toBeVisible();
    await expect(player.getByRole('button', { name: /History/ })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
