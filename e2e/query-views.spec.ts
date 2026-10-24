/**
 * Query block views (I2.2): layout checks that need a real browser. Cards must not overflow at 200% text on a
 * phone and on a desktop; the table header buttons must be clickable (the block host must not swallow pointer events);
 * sorting by a header puts empty values last in both directions.
 */
import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { api, watch } from './support';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });

const run = randomBytes(3).toString('hex');
const errors: string[] = [];
test.beforeEach(({ page }) => watch(page, errors));
// Changing the text size under a live editor makes Chrome report a harmless ResizeObserver loop
test.afterEach(() => expect(errors.splice(0).filter((e) => !/ResizeObserver loop/.test(e)), 'errors in the browser').toEqual([]));

async function world(page: Page, view: 'table' | 'cards') {
  const campaignId = (await api<{ id: string }>(page, 'POST', '/api/campaigns', { name: `Views ${view} ${run}`, ruleset: '2024' })).id;
  const create = async (input: object) => (await api<{ id: string }>(page, 'POST', `/api/campaigns/${campaignId}/pages?template=0`, input)).id;
  const query = { type: 'query', attrs: { id: 'q1', title: 'Cast', view, columns: ['facet.status', 'facet.role', 'facet.attitude'], filter: { types: ['npc'] } } };
  for (const [title, role, status] of [['Sildar Hallwinter', 'Guide of the long road to Phandalin', 'alive'], ['Gundren', '', 'missing'], ['Nezznar', 'Wizard', 'alive']] as const) {
    await create({ type: 'npc', title, visibility: 'all', facet: { role, status } });
  }
  const pageId = await create({ type: 'generic', title: `Cast ${view} ${run}`, visibility: 'all', body: { schemaVersion: 1, type: 'doc', content: [query] } });
  return `/c/${campaignId}/p/${pageId}`;
}

for (const width of [320, 390, 1280]) {
  test(`cards at 200% text fit their block at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(await world(page, 'cards'));
    await expect(page.locator('.cn-card').first()).toBeVisible();
    await page.evaluate(() => (document.documentElement.style.fontSize = '32px'));
    const overflows = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.cn-card, .cn-card dd, .cn-query-frame')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className),
    );
    expect(overflows).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });
}

test('table header buttons are clickable and keep empty values last in both directions', async ({ page }) => {
  await page.goto(await world(page, 'table'));
  const rows = () => page.locator('.cn-table tbody th a').allInnerTexts().then((t) => t.map((x) => x.replace(/^\S*\s*NPC:\s*/, '').trim()));
  await expect(page.locator('.cn-table')).toBeVisible();
  const role = page.getByRole('button', { name: 'Role', exact: true });
  await role.click(); // plain click: fails if another element covers it
  await expect(page.locator('.cn-table th[aria-sort=ascending]')).toContainText('Role');
  await expect.poll(async () => (await rows()).at(-1)).toBe('Gundren');
  await role.click();
  await expect(page.locator('.cn-table th[aria-sort=descending]')).toContainText('Role');
  await expect.poll(async () => (await rows()).at(-1)).toBe('Gundren');
});
