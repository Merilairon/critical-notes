/** The dice log stays open while rolling, at phone width (touch) and desktop width (real clicks and taps). */
import { expect, test, type Page } from '@playwright/test';
import { api, BASE_URL, DM_STATE } from './support';

let pageUrl: string;

test('a page with two dice tags', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: BASE_URL, storageState: DM_STATE });
  const page = await ctx.newPage();
  await page.goto('/campaigns');
  const camp = (await api<{ id: string }>(page, 'POST', '/api/campaigns', { name: 'Dice Log Check', ruleset: '2014' })).id;
  const tag = (markup: string) => ({ type: 'tag', attrs: { markup } });
  const body = { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'd1' }, content: [{ type: 'text', text: 'Roll ' }, tag('{@dice 1d20+5}'), { type: 'text', text: ' and ' }, tag('{@damage 2d6+3}')] }] };
  const p = await api<{ id: string }>(page, 'POST', `/api/campaigns/${camp}/pages?template=0`, { type: 'location', title: 'Dice page', visibility: 'all', body });
  pageUrl = `/c/${camp}/p/${p.id}`;
  await ctx.close();
});

async function rollWhileLogOpen(page: Page, tap: boolean) {
  await page.goto(pageUrl);
  await expect(page.locator('.cn-roll').first()).toBeVisible();
  await page.getByRole('button', { name: 'Dice log' }).click();
  const log = page.locator('#dice-log');
  await expect(log).toBeVisible();
  const rows = log.locator('ol li');
  const roll = page.locator('.cn-roll').first();
  const before = await log.locator('ol li:not(:has-text("Tap or click"))').count();
  if (tap) await roll.tap();
  else await roll.click();
  await expect(log.locator('ol li:not(:has-text("Tap or click"))')).toHaveCount(before + 1);
  await expect(log).toBeVisible();
  await (tap ? page.locator('.cn-roll').nth(1).tap() : page.locator('.cn-roll').nth(1).click());
  await expect(log.locator('ol li:not(:has-text("Tap or click"))')).toHaveCount(before + 2);
  await expect(log).toBeVisible();
  await expect(rows.first()).toContainText(/\d/);
  // The toast is not shown while the log is open
  await expect(page.locator('[role=status]:has-text("2d6")')).toHaveCount(0);
}

for (const [name, w, h, touch] of [['desktop 1280', 1280, 800, false], ['phone 390', 390, 844, true], ['phone 320', 320, 700, true]] as const) {
  test(`rolling with the dice log open keeps it open: ${name}`, async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE_URL, storageState: DM_STATE, viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch });
    const page = await ctx.newPage();
    await rollWhileLogOpen(page, touch);
    await ctx.close();
  });
}

test('a tap on the page away from a roll still closes the log below lg', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: BASE_URL, storageState: DM_STATE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto(pageUrl);
  await expect(page.locator('.cn-roll').first()).toBeVisible();
  await page.getByRole('button', { name: 'Dice log' }).tap();
  await expect(page.locator('#dice-log')).toBeVisible();
  await page.touchscreen.tap(200, 700);
  await expect(page.locator('#dice-log')).toHaveCount(0);
  await ctx.close();
});
