/**
 * Players: an invite link from the members panel, a player joining through it, what the player sees (nothing
 * hidden ever reaches their browser; no game-master tools), editing their own character, the inventory, and
 * the DM's campaign export, import and edition change.
 */
import { expect, test, type Page } from '@playwright/test';
import { api, BASE_URL, editor, newPage, saved, sharedPage } from './support';

// Only the DM may ever see these: the player's browser must never receive them
const HIDDEN = ['SMOKE-SECRET', 'SMOKE-VILLAIN', 'SMOKE-RING', 'SMOKE-WREN-NOTE'];
const para = (id: string, text: string) => ({ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }] });

const shared = sharedPage();
let player: Page;
const playerErrors: string[] = [];
const leaks: string[] = [];
let campaignId: string, townId: string, wrenId: string, inviteUrl: string, importedId: string;

test.afterAll(async () => player?.context().close());
test.afterEach(() => expect(playerErrors.splice(0), "errors in the player's browser").toEqual([]));

test('the DM prepares hidden content', async () => {
  const { page } = shared;
  campaignId = (await api<{ id: string }>(page, 'POST', '/api/campaigns', { name: 'Shadows over Vell', ruleset: '2014' })).id;
  const create = async (input: object) => (await api<{ id: string }>(page, 'POST', `/api/campaigns/${campaignId}/pages?template=0`, input)).id;
  townId = await create({
    type: 'location',
    title: 'Vell',
    visibility: 'all',
    body: {
      schemaVersion: 1,
      type: 'doc',
      content: [
        para('b1', 'A foggy harbour town. Its wizard casts {@spell fireball|phb} at trespassers.'),
        { type: 'secret', attrs: { id: 'b2' }, content: [para('b3', 'SMOKE-SECRET: the mayor is a doppelganger')] },
      ],
    },
  });
  await create({ type: 'npc', title: 'SMOKE-VILLAIN the Pale' });
  wrenId = await create({
    type: 'pc',
    title: 'Wren',
    body: { schemaVersion: 1, type: 'doc', content: [para('w1', 'Wren, a wandering bard.'), { ...para('w2', 'SMOKE-WREN-NOTE: her sister is alive'), attrs: { id: 'w2', visibility: 'dm' } }] },
  });
  const ring = await api<{ id: string }>(page, 'POST', `/api/campaigns/${campaignId}/inventory/items`, { name: 'SMOKE-RING of lies', notes: 'cursed' });
  await api(page, 'PATCH', `/api/campaigns/${campaignId}/inventory/items/${ring.id}`, { identified: false });
});

test('the DM makes an invite link in the members panel', async () => {
  const { page } = shared;
  await page.goto(`/c/${campaignId}/settings`);
  const members = page.locator('section[aria-label=Members]');
  await members.getByRole('button', { name: 'Create link' }).click();
  inviteUrl = await members.locator('input[aria-label="Invite link"]').inputValue();
  expect(inviteUrl).toContain('/invite/');
  await expect(members.locator('li', { hasText: 'Player link' })).toBeVisible();
});

test('a new player registers through the link', async ({ browser }) => {
  player = await newPage(browser, undefined, playerErrors);
  // Every API response the player's browser gets is checked for hidden content
  player.on('response', async (res) => {
    if (!res.url().includes('/api/')) return;
    const body = await res.text().catch(() => '');
    for (const s of HIDDEN) if (body.includes(s)) leaks.push(`${s} in ${res.url()}`);
  });
  await player.goto(inviteUrl.replace(/^https?:\/\/[^/]+/, BASE_URL));
  await expect(player.getByText('Shadows over Vell').first()).toBeVisible();
  await player.locator('input[name=displayName]').fill('Pia');
  await player.locator('input[name=username]').fill(`pia${Date.now().toString(36)}`);
  await player.locator('input[name=password]').fill('pia password');
  await player.getByRole('button', { name: 'Create account and join' }).click();
  await player.waitForURL(new RegExp(`/c/${campaignId}$`));

  const { members } = await api<{ members: { userId: string; displayName: string; role: string }[] }>(shared.page, 'GET', `/api/campaigns/${campaignId}/members`);
  const pia = members.find((m) => m.displayName === 'Pia');
  expect(pia?.role).toBe('player');
  // The DM hands Wren to Pia
  const wren = await api<{ revision: number }>(shared.page, 'GET', `/api/campaigns/${campaignId}/pages/${wrenId}`);
  await api(shared.page, 'PATCH', `/api/campaigns/${campaignId}/pages/${wrenId}`, { revision: wren.revision, facet: { playerUserId: pia!.userId } });
});

test('the player sees the campaign without game-master tools', async () => {
  await player.reload();
  const nav = player.locator('nav[aria-label=Campaign]');
  await expect(nav).toContainText('Members & rules');
  await expect(nav).not.toContainText('Encounters');
  await expect(nav).not.toContainText('Templates');
  await expect(player.getByRole('button', { name: /^\+ (NPC|Location)$|New page/ })).toHaveCount(0);
  const tree = player.locator('cn-page-tree');
  await expect(tree).toContainText('Vell');
  await expect(tree).toContainText('Wren');
  await expect(tree).not.toContainText('SMOKE-VILLAIN');
  await player.goto(`/c/${campaignId}/npcs`);
  await expect(player.locator('h1', { hasText: 'NPCs' })).toBeVisible();
  await expect(player.getByRole('button', { name: '+ NPC' })).toHaveCount(0);
  // Game-master pages send players back to the overview
  await player.goto(`/c/${campaignId}/encounters`);
  await player.waitForURL(new RegExp(`/c/${campaignId}$`));
});

test('a shared page shows without its secret, read-only', async () => {
  await player.goto(`/c/${campaignId}/p/${townId}`);
  await expect(player.locator('cn-block-view', { hasText: 'foggy harbour town' })).toBeVisible();
  await expect(player.locator('.tiptap')).toHaveCount(0);
  await expect(player.locator('body')).not.toContainText('doppelganger');
  const search = await api<{ pages: unknown[] }>(player, 'GET', `/api/campaigns/${campaignId}/search?q=doppelganger`);
  expect(search.pages).toEqual([]);
});

test('the player edits their own character', async () => {
  await player.goto(`/c/${campaignId}/p/${wrenId}`);
  await expect(editor(player).getByText('Wren, a wandering bard.')).toBeVisible();
  await expect(player.locator('button[title^="DM-only block"]')).toHaveCount(0);
  await editor(player).click();
  await player.keyboard.press('Control+End');
  await player.keyboard.press('Enter');
  // The full "/" menu, without the game-master blocks
  await player.keyboard.type('/');
  await expect(player.locator('.cn-suggest-item', { hasText: 'Callout' })).toBeVisible();
  await expect(player.locator('.cn-suggest-item', { hasText: 'DM secret' })).toHaveCount(0);
  await player.keyboard.press('Backspace');
  await player.keyboard.type('Pia: Wren owes the guild 40 gp.');
  await saved(player);
  const stored = JSON.stringify((await api<{ body: unknown }>(shared.page, 'GET', `/api/campaigns/${campaignId}/pages/${wrenId}`)).body);
  expect(stored).toContain('owes the guild');
  // The DM's note on the page, which the player never saw, is still there
  expect(stored).toContain('SMOKE-WREN-NOTE');
});

test('the inventory as a player', async () => {
  await player.goto(`/c/${campaignId}/inventory`);
  const party = player.locator('section[aria-label=Party]');
  await expect(party.getByText('Unidentified item')).toBeVisible();
  await expect(party.locator('input[aria-label^="Quantity of"]')).toHaveCount(0);
  const wren = player.locator('section[aria-label=Wren]');
  await wren.locator('input[aria-label="Coins for Wren"]').fill('5');
  await wren.getByRole('button', { name: 'Add' }).click();
  await expect(wren.locator('[aria-label=Coins]')).toContainText(/5\s*gp/);
  await expect(player.locator('label', { hasText: /^\s*identified/i })).toHaveCount(0);
});

test('members and house rules for the player', async () => {
  await player.goto(`/c/${campaignId}/settings`);
  const members = player.locator('section[aria-label=Members]');
  await expect(members.getByText('Pia')).toBeVisible();
  await expect(members.getByText('plays Wren')).toBeVisible();
  await expect(members.getByRole('button', { name: 'Leave this campaign' })).toBeVisible();
  await expect(members.getByRole('button', { name: 'Create link' })).toHaveCount(0);
  await expect(player.getByText('Export campaign')).toHaveCount(0);
});

test("nothing hidden reached the player's browser", () => {
  expect(leaks).toEqual([]);
});

test('export and import the campaign', async () => {
  const { page } = shared;
  const res = await page.request.get(`/api/campaigns/${campaignId}/export`);
  expect(res.ok()).toBe(true);
  const zip = await res.body();
  expect(zip.subarray(0, 2).toString()).toBe('PK');
  await page.goto('/campaigns');
  await page.locator('input[type=file]').setInputFiles({ name: 'vell.zip', mimeType: 'application/zip', buffer: zip });
  const report = page.locator('[role=status]', { hasText: 'Imported' });
  await expect(report).toContainText('Imported 3 pages');
  await report.getByRole('link', { name: 'Open the campaign' }).click();
  await page.waitForURL(/\/c\/[0-9a-f-]{36}$/);
  importedId = page.url().split('/c/')[1]!;
  expect(importedId).not.toBe(campaignId);
  await expect(page.locator('cn-page-tree')).toContainText('SMOKE-VILLAIN');
});

test('move the imported copy to the other edition', async () => {
  const { page } = shared;
  await page.goto(`/c/${importedId}/settings`);
  const edition = page.locator('section[aria-label=Edition]');
  await edition.getByRole('button', { name: 'Check what would change' }).click();
  await expect(edition.locator('tr', { hasText: 'Fireball' })).toBeVisible();
  await edition.getByRole('button', { name: /^Move to the/ }).click();
  await expect(edition.locator('[role=status]', { hasText: 'Done:' })).toBeVisible();
  const { pages } = await api<{ pages: { id: string }[] }>(page, 'GET', `/api/campaigns/${importedId}/pages?type=location`);
  const town = await api<{ body: unknown }>(page, 'GET', `/api/campaigns/${importedId}/pages/${pages[0]!.id}`);
  expect(JSON.stringify(town.body)).toMatch(/\{@spell fireball\|xphb\}/i);
  // The original keeps its references
  const original = await api<{ body: unknown }>(page, 'GET', `/api/campaigns/${campaignId}/pages/${townId}`);
  expect(JSON.stringify(original.body)).toContain('fireball|phb');
});
