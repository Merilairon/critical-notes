/**
 * Trash (Epic M4): deleting a page in the editor asks nothing and offers "Deleted · Undo"; Undo and Restore from the
 * Trash view bring back the content, the subpage, the backlink and the search hit; "Delete permanently" removes a page
 * for good; a player has no Trash link and is sent away from /trash.
 *
 * Every test makes its own campaign and unique names, so the tests do not depend on each other. The only person
 * registered is one player (sign-up is limited to 8 per minute per address; see the M2.10 notes in STATUS.md).
 * Nothing is recorded (no trace, screenshot or video).
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { api, BASE_URL, editor, watch } from './support';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });

const run = Date.now().toString(36);
const para = (id: string, ...content: object[]) => ({ type: 'paragraph', attrs: { id }, content });
const text = (t: string) => ({ type: 'text', text: t });
const doc = (...content: object[]) => ({ schemaVersion: 1, type: 'doc', content });

const errors: string[] = [];
const dialogs: string[] = [];
const closers: (() => Promise<unknown>)[] = [];

test.beforeEach(({ page }) => {
  watch(page, errors);
  page.on('dialog', (d) => dialogs.push(d.message()));
});
test.afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close().catch(() => undefined)));
  const seen = errors.splice(0);
  dialogs.length = 0;
  expect(seen, 'errors in the browser').toEqual([]);
});

interface World {
  campaignId: string;
  title: string;
  childTitle: string;
  linkerTitle: string;
  word: string;
  pageId: string;
  childId: string;
  linkerId: string;
}

/** A campaign with a page (a unique word in its body) with a subpage, and a second page that links to it. All through the API. */
async function world(page: Page, tag: string): Promise<World> {
  const title = `Harbour ${tag} ${run}`;
  const childTitle = `Lighthouse ${tag} ${run}`;
  const linkerTitle = `Rumours ${tag} ${run}`;
  const word = `brinewatch${tag}${run}`;
  const campaignId = (await api<{ id: string }>(page, 'POST', '/api/campaigns', { name: `Trash ${tag} ${run}`, ruleset: '2024' })).id;
  const create = async (input: object) => (await api<{ id: string }>(page, 'POST', `/api/campaigns/${campaignId}/pages?template=0`, input)).id;
  const pageId = await create({ type: 'location', title, visibility: 'all', body: doc(para('b1', text(`The ${word} keeps watch over the bay.`))) });
  const childId = await create({ type: 'location', title: childTitle, visibility: 'all', parentId: pageId, body: doc(para('c1', text('A tall tower of grey stone.'))) });
  const linkerId = await create({
    type: 'session',
    title: linkerTitle,
    visibility: 'all',
    body: doc(para('l1', text('Sailors speak of '), { type: 'pageLink', attrs: { pageId, label: title } })),
  });
  return { campaignId, title, childTitle, linkerTitle, word, pageId, childId, linkerId };
}

const searchIds = async (page: Page, w: World) =>
  (await api<{ pages: { pageId: string }[] }>(page, 'GET', `/api/campaigns/${w.campaignId}/search?q=${encodeURIComponent(w.word)}`)).pages.map((p) => p.pageId);

/** Content, subpage (sidebar tree), backlink and search hit of the page are all there. */
async function expectIntact(page: Page, w: World) {
  await page.goto(`/c/${w.campaignId}/p/${w.pageId}`);
  await expect(page.getByLabel('Page title', { exact: true })).toHaveValue(w.title);
  await expect(editor(page)).toContainText(w.word);
  await expect(page.getByRole('link', { name: w.childTitle, exact: false }).first()).toBeVisible();
  await expect(page.locator('cn-backlinks-panel a', { hasText: w.linkerTitle })).toBeVisible();
  await expect.poll(() => searchIds(page, w)).toContain(w.pageId);
  await page.goto(`/c/${w.campaignId}/p/${w.childId}`);
  await expect(editor(page)).toContainText('A tall tower of grey stone.');
}

/** Deletes the page with the editor's Delete button; no confirm may appear. */
async function deleteInEditor(page: Page, w: World) {
  await page.goto(`/c/${w.campaignId}/p/${w.pageId}`);
  await expect(editor(page)).toContainText(w.word);
  // The search finds it before the delete, so "not found" afterwards proves something
  await expect.poll(() => searchIds(page, w)).toContain(w.pageId);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: `Deleted "${w.title}" and 1 subpage` })).toBeVisible();
  await expect(page.getByRole('button', { name: `Undo delete of "${w.title}"` })).toBeVisible();
  expect(dialogs, 'no confirm dialog').toEqual([]);
  await expect.poll(() => searchIds(page, w)).not.toContain(w.pageId);
}

const trashRow = (page: Page, title: string) => page.getByRole('list', { name: 'Deleted pages' }).getByRole('listitem').filter({ hasText: title });

test('deleting a page offers Undo without a confirm, and Undo brings everything back', async ({ page }) => {
  const w = await world(page, 'undo');
  await deleteInEditor(page, w);
  await page.getByRole('button', { name: `Undo delete of "${w.title}"` }).click();
  await page.waitForURL(`**/c/${w.campaignId}/p/${w.pageId}`);
  await expectIntact(page, w);
  expect(dialogs, 'no confirm dialog').toEqual([]);
});

test('Restore from the Trash view brings everything back', async ({ page }) => {
  const w = await world(page, 'restore');
  await deleteInEditor(page, w);
  await page.getByRole('link', { name: /Trash$/ }).click();
  await page.waitForURL(`**/c/${w.campaignId}/trash`);
  const row = trashRow(page, w.title);
  await expect(row).toContainText('1 subpage');
  await row.getByRole('button', { name: `Restore ${w.title}` }).click();
  await expect(page.getByRole('status').filter({ hasText: `Restored "${w.title}"` })).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(dialogs, 'restore asks nothing').toEqual([]);
  await expectIntact(page, w);
});

test('Delete permanently (confirmed) removes the page and its subpage for good', async ({ page }) => {
  const w = await world(page, 'purge');
  await deleteInEditor(page, w);
  await page.goto(`/c/${w.campaignId}/trash`);
  const row = trashRow(page, w.title);
  await row.getByRole('button', { name: `Delete ${w.title} permanently` }).click();
  await expect(page.getByRole('status').filter({ hasText: `Permanently deleted "${w.title}"` })).toBeVisible();
  expect(dialogs.length, 'one confirm').toBe(1);
  expect(dialogs[0]).toContain(w.title);
  expect(dialogs[0]).toContain('1 subpage');
  await expect(row).toHaveCount(0);

  for (const id of [w.pageId, w.childId]) {
    const res = await page.request.get(`/api/campaigns/${w.campaignId}/pages/${id}`);
    expect(res.status(), 'purged page is gone').toBe(404);
  }
  expect(await searchIds(page, w)).not.toContain(w.pageId);
  await page.goto(`/c/${w.campaignId}/p/${w.pageId}`);
  await expect(page.getByLabel('Page title', { exact: true })).toHaveCount(0);
  await page.goto(`/c/${w.campaignId}/trash`);
  await expect(page.getByText('The trash is empty.')).toBeVisible();
});

test('a player has no Trash link and is sent away from /trash', async ({ page, browser, playwright }) => {
  const w = await world(page, 'player');
  const token = (await api<{ token: string }>(page, 'POST', `/api/campaigns/${w.campaignId}/invites`, { role: 'player', expiresInDays: 1, maxUses: 1 })).token;
  const http: APIRequestContext = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: BASE_URL } });
  closers.push(() => http.dispose());
  const username = `trp${run}`;
  const reg = await http.post('/api/auth/register', { data: { token, username, displayName: `Trash Player ${run}`, password: `pw-${run}-${Math.random().toString(36).slice(2)}` } });
  expect(reg.status(), 'register').toBe(201);

  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 1000 }, storageState: await http.storageState() });
  closers.push(() => context.close());
  const player = watch(await context.newPage(), errors);

  await player.goto(`/c/${w.campaignId}`);
  await expect(player.getByRole('link', { name: /Overview$/ }).first()).toBeVisible();
  await expect(player.getByRole('link', { name: /Trash$/ })).toHaveCount(0);

  await player.goto(`/c/${w.campaignId}/trash`);
  await player.waitForURL(new RegExp(`/c/${w.campaignId}$`));
  await expect(player.getByRole('heading', { name: 'Trash', exact: true })).toHaveCount(0);
  const res = await player.request.get(`/api/campaigns/${w.campaignId}/trash`);
  expect(res.status(), 'the API refuses players too').toBe(403);
});
