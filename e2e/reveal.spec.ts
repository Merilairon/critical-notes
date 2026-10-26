/**
 * Reveal to players, live: the DM and a player are in two browsers of the same campaign. The DM uses "Reveal now" on a
 * DM secret and on a DM-only block, and "Share now" on a handout; the player sees each within 2 seconds without
 * reloading (toast, "New" pill, block highlight). Before the reveal the hidden text is nowhere in the player's page
 * or in any response their browser gets.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { PLAYER_STATE } from './env';
import { api, baseUrl, watch, sharedPage } from './support';

const SECRET = 'REVEAL-SECRET: the bridge is rigged';
const DM_ONLY = 'REVEAL-DMONLY: the key is under the stone';
const HANDOUT = 'REVEAL-HANDOUT Letter from the baron';
const HANDOUT_TEXT = 'REVEAL-HANDOUT-TEXT: meet me at dawn';
const HIDDEN = [SECRET, DM_ONLY, HANDOUT_TEXT];
/** The player must see a reveal this fast, with no reload. */
const LIVE = 2_000;

const para = (id: string, text: string, attrs: object = {}) => ({ type: 'paragraph', attrs: { id, ...attrs }, content: [{ type: 'text', text }] });

const shared = sharedPage();
let player: Page;
let playerContext: BrowserContext;
const playerErrors: string[] = [];
const leaks: string[] = [];
/** True until the DM reveals anything: no response to the player may carry hidden text before that. */
let guarding = true;
let campaignId: string, townId: string, handoutId: string;

test.afterAll(async () => playerContext?.close());
test.afterEach(() => expect(playerErrors.splice(0), "errors in the player's browser").toEqual([]));

/** A context signed in as a player: the one `players.spec.ts` saved if her session still works, else a new sign-up. */
async function playerSession(browser: Browser, inviteToken: string): Promise<BrowserContext> {
  if (existsSync(PLAYER_STATE)) {
    const context = await browser.newContext({ baseURL: baseUrl(), viewport: { width: 1440, height: 1000 }, storageState: PLAYER_STATE });
    const me = (await (await context.request.get('/api/auth/me')).json()) as { user: unknown };
    if (me.user) {
      const res = await context.request.post(`/api/invites/${inviteToken}/accept`, { headers: { origin: baseUrl() } });
      expect(res.ok(), `accept invite: ${res.status()}`).toBe(true);
      return context;
    }
    await context.close();
  }
  // Run alone (or her session is gone): sign up through the invite, once
  const run = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const context = await browser.newContext({ baseURL: baseUrl(), viewport: { width: 1440, height: 1000 }, storageState: { cookies: [], origins: [] } });
  const res = await context.request.post('/api/auth/register', {
    data: { token: inviteToken, username: `rvl${run}`, displayName: `Reveal Player ${run}`, password: `pw-${run}-${randomBytes(6).toString('hex')}` },
    headers: { origin: baseUrl() },
  });
  expect(res.status(), 'register').toBe(201);
  return context;
}

/**
 * Opens the options menu of the block with this text through its drag handle (hover, click): it does not depend on
 * where the editor thinks the caret is, which lags behind a click for a moment.
 */
async function openBlockMenu(page: Page, text: string) {
  await page.locator('.tiptap').getByText(text).hover();
  await page.locator('.cn-drag-handle').click();
  await expect(page.getByRole('menuitem', { name: 'Reveal now' })).toBeVisible();
}

test('the DM prepares a table with hidden content, and a player joins', async ({ browser }) => {
  const { page } = shared;
  campaignId = (await api<{ id: string }>(page, 'POST', '/api/campaigns', { name: 'Reveal at the table', ruleset: '2014' })).id;
  const create = async (input: object) => (await api<{ id: string }>(page, 'POST', `/api/campaigns/${campaignId}/pages?template=0`, input)).id;
  townId = await create({
    type: 'location',
    title: 'Harrow Bridge',
    visibility: 'all',
    body: {
      schemaVersion: 1,
      type: 'doc',
      content: [
        para('r1', 'A narrow stone bridge over the gorge.'),
        { type: 'secret', attrs: { id: 'r2' }, content: [para('r3', SECRET)] },
        para('r4', DM_ONLY, { visibility: 'dm' }),
        para('r5', 'Travellers pay a toll of two copper.'),
      ],
    },
  });
  handoutId = await create({ type: 'handout', title: HANDOUT, visibility: 'dm', body: { schemaVersion: 1, type: 'doc', content: [para('h1', HANDOUT_TEXT)] } });

  const token = (await api<{ token: string }>(page, 'POST', `/api/campaigns/${campaignId}/invites`, { role: 'player', expiresInDays: 1, maxUses: 1 })).token;
  playerContext = await playerSession(browser, token);
  player = watch(await playerContext.newPage(), playerErrors);
  // Every API response the player's browser gets is checked for hidden content
  player.on('response', async (res) => {
    if (!res.url().includes('/api/')) return;
    const body = await res.text().catch(() => '');
    if (guarding) for (const s of HIDDEN) if (body.includes(s)) leaks.push(`${s} in ${res.url()}`);
  });
});

test('before any reveal the player has none of it', async () => {
  await player.goto(`/c/${campaignId}/p/${townId}`);
  await expect(player.getByRole('heading', { name: 'Harrow Bridge' })).toBeVisible();
  await expect(player.locator('cn-block-view', { hasText: 'A narrow stone bridge' })).toBeVisible();
  await expect(player.locator('cn-block-view', { hasText: 'Travellers pay a toll' })).toBeVisible();
  const body = player.locator('body');
  for (const s of [SECRET, DM_ONLY, HANDOUT_TEXT, 'REVEAL-HANDOUT']) await expect(body).not.toContainText(s);
  await expect(player.locator('cn-page-tree')).not.toContainText('REVEAL-HANDOUT');
  await expect(player.locator('.cn-new-block')).toHaveCount(0);
  const res = await player.request.get(`/api/campaigns/${campaignId}/pages/${handoutId}`);
  expect(res.status(), 'the handout is hidden from the API too').toBe(404);
  expect(leaks, 'hidden text in a response before any reveal').toEqual([]);
  guarding = false;
});

test('"Reveal now" on a DM secret reaches the open page of the player without a reload', async () => {
  const { page } = shared;
  // A marker that a reload would wipe: the player's page must not navigate or reload
  await player.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));

  await page.goto(`/c/${campaignId}/p/${townId}`);
  await openBlockMenu(page, SECRET);
  await page.getByRole('menuitem', { name: 'Reveal now' }).click();
  await expect(page.locator('.cn-reveal-notice')).toContainText('Revealed to players');

  const block = player.locator('cn-block-view .cn-new-block', { hasText: SECRET });
  await expect(block).toBeVisible({ timeout: LIVE });
  await expect(player.locator('cn-live-toast')).toContainText('New details on this page', { timeout: LIVE });
  // The DM-only block next to it is still hidden
  await expect(player.locator('body')).not.toContainText(DM_ONLY);
  expect(await player.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload), 'the page was not reloaded').toBe(true);
});

test('"Reveal now" on a DM-only block shows it live too', async () => {
  const { page } = shared;
  await openBlockMenu(page, DM_ONLY);
  await page.getByRole('menuitem', { name: 'Reveal now' }).click();
  await expect(page.locator('.cn-reveal-notice')).toContainText('Revealed to players');

  await expect(player.locator('cn-block-view', { hasText: DM_ONLY })).toBeVisible({ timeout: LIVE });
  expect(await player.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload), 'the page was not reloaded').toBe(true);
  // Still nothing of the handout
  await expect(player.locator('body')).not.toContainText(HANDOUT_TEXT);
});

test('"Share now" on a handout appears in the player\'s tree with a toast and a New badge', async () => {
  const { page } = shared;
  // The toasts of the two reveals above collapse into one card; clear it so this share gets its own
  await player.locator('cn-live-toast').getByRole('button', { name: 'Dismiss' }).click();
  await expect(player.locator('cn-live-toast [role=status] > div')).toHaveCount(0);
  await page.goto(`/c/${campaignId}/p/${handoutId}`);
  await page.getByRole('group', { name: 'Share this handout' }).getByRole('button', { name: 'Share now' }).click();
  await expect(page.getByText('Shared with all players')).toBeVisible();

  const tree = player.locator('cn-page-tree');
  await expect(tree).toContainText('REVEAL-HANDOUT', { timeout: LIVE });
  await expect(tree.locator('li, a', { hasText: 'REVEAL-HANDOUT' }).filter({ hasText: 'New' }).first()).toBeVisible({ timeout: LIVE });
  await expect(player.locator('cn-live-toast')).toContainText(`New: ${HANDOUT}`, { timeout: LIVE });
  expect(await player.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload), 'the page was not reloaded').toBe(true);

  // Opening it from the toast shows the content
  await player.locator('cn-live-toast').getByRole('button', { name: 'Open' }).click();
  await expect(player.locator('cn-block-view', { hasText: HANDOUT_TEXT })).toBeVisible();
});
