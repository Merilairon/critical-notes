/** Encounters and combat: difficulty, the tracker, the live player view, conditions, and loot. */
import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll, smallTargets } from './phone-checks';
import { api, confirmDialog, dmState, editor, isPhone, newPage, pickSuggestion, saved, sharedPage } from './support';

const shared = sharedPage();
const abilities = { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 10 };
let campaignId: string, ariaId: string, trackerUrl: string;
/** The table screen (the player view), open next to the DM's tracker. */
let table: Page;

const order = (page: Page) => page.locator('ol[aria-label="Initiative order"] li');

test('a campaign with two characters', async () => {
  const { page } = shared;
  campaignId = (await api<{ id: string }>(page, 'POST', '/api/campaigns', { name: 'Goblin Trouble', ruleset: '2014' })).id;
  const pc = async (title: string, hp: number) =>
    (
      await api<{ id: string }>(page, 'POST', `/api/campaigns/${campaignId}/pages`, {
        type: 'pc',
        title,
        facet: { classes: [{ classUid: 'class:fighter|phb', level: 3 }], hpMax: hp, ac: 16, abilities },
      })
    ).id;
  ariaId = await pc('Aria', 28);
  await pc('Bram', 24);
});

test('build an encounter and see its difficulty', async () => {
  const { page } = shared;
  await page.goto(`/c/${campaignId}/encounters`);
  await page.getByRole('button', { name: 'New encounter' }).click();
  await page.waitForURL(/\/encounters\/[0-9a-f-]{36}$/);
  await page.locator('input[aria-label="Encounter name"]').fill('Goblin ambush');
  await page.getByRole('button', { name: '+ Monster' }).click();
  await page.locator('cn-ref-picker input').fill('goblin');
  await page.locator('[role=listbox] [role=option]', { hasText: /^Goblin\s*MM/ }).first().click();
  for (let i = 0; i < 3; i++) await page.locator('button[aria-label="One more Goblin"]').click();
  await page.getByRole('button', { name: '+ Custom' }).click();
  await page.locator('form input[required]').fill('Shadow');
  await page.locator('form button', { hasText: 'Add' }).click();
  await page.locator('input[aria-label="Hidden: Shadow"]').check();
  // 4 goblins (200 XP) + Shadow (CR 1, 200 XP) = 400 × 2.5 (5 creatures vs. a party of two) = 1000: deadly for two level 3s (800)
  await expect(page.locator('[data-testid=difficulty]', { hasText: 'deadly' })).toBeVisible();
  await saved(page);
});

test('run it in the tracker', async () => {
  const { page } = shared;
  await page.getByRole('button', { name: 'Run encounter' }).click();
  await page.waitForURL(/\/trackers\/[0-9a-f-]{36}$/);
  trackerUrl = page.url();
  await expect(order(page).filter({ hasText: 'Goblin 4' })).toBeVisible();
  const names = await order(page).locator('span.font-semibold').allTextContents();
  expect(names.sort()).toEqual(['Aria', 'Bram', 'Goblin 1', 'Goblin 2', 'Goblin 3', 'Goblin 4', 'Shadow']);
});

test('the player view hides the Shadow', async ({ browser }) => {
  // The table screen is the player's view: on an emulated phone in the phone project (the tracker stays on the desktop)
  table = await newPage(browser, dmState(), shared.errors, isPhone());
  await table.goto(`${trackerUrl}/view`);
  await expect(table.locator('li', { hasText: 'Goblin 1' })).toBeVisible();
  await expect(table.locator('li', { hasText: 'Shadow' })).toHaveCount(0);
  // A full-screen view for the table: no app header
  await expect(table.locator('header', { hasText: 'Sign out' })).toHaveCount(0);
  if (isPhone()) {
    // docs/design/phone-layout.md 6.7 and 9.6: fits the width, the way back is first in tab order and 44 px
    await expectNoSidewaysScroll(table, 'table screen');
    const back = table.getByRole('link', { name: '← Campaign' });
    await expect(back).toHaveAttribute('href', `/c/${campaignId}`);
    expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await table.keyboard.press('Tab');
    await expect(back).toBeFocused();
    expect(await smallTargets(table), 'table screen: tap targets under 44 px').toEqual([]);
  }
});

test('keyboard turns and live updates', async () => {
  const { page } = shared;
  const init = (name: string) => page.locator(`input[aria-label="Initiative of ${name}"]`);
  await init('Aria').fill('25');
  await init('Aria').press('Tab');
  await init('Bram').fill('2');
  await init('Bram').press('Tab');
  await page.locator('h1').click(); // leave the inputs so the keys reach the tracker
  await page.keyboard.press('n');
  await expect(page.locator('li[aria-current=true]', { hasText: 'Aria' })).toBeVisible();
  await expect(table.locator('li[aria-current=true]', { hasText: 'Aria' })).toBeVisible();
  await expect(page.locator('header [aria-live=polite]', { hasText: 'Round 1' })).toBeVisible();
});

test('damage shows as a health word for players', async () => {
  const { page } = shared;
  const box = page.locator('input[aria-label="Change hit points of Goblin 1"]');
  await box.fill('-4');
  await box.press('Enter');
  await expect(page.locator('li', { hasText: 'Goblin 1' }).locator('text=3').first()).toBeVisible();
  await expect(table.locator('li', { hasText: 'Goblin 1' }).getByText('Bloodied')).toBeVisible();
});

test('conditions count down with the rounds', async () => {
  const { page } = shared;
  const row = order(page).filter({ hasText: 'Goblin 2' });
  await row.getByRole('button', { name: '+ condition' }).click();
  await row.locator('input[aria-label=Condition]').fill('Prone');
  await row.locator('input[aria-label=Rounds]').fill('1');
  await row.getByRole('button', { name: 'Add' }).click();
  await expect(row.getByText('Prone')).toBeVisible();
  await expect(table.locator('li', { hasText: 'Goblin 2' }).getByText('Prone')).toBeVisible();
  await page.locator('h1').click();
  for (let i = 0; i < 7; i++) await page.keyboard.press('n');
  await expect(page.locator('header [aria-live=polite]', { hasText: 'Round 2' })).toBeVisible();
  await expect(row).not.toContainText('Prone');
});

test('the sticky Combat block and the row actions fit at 200% text on a phone', async () => {
  const { page } = shared;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  const sticky = page.locator('div.sticky');
  expect((await sticky.boundingBox())!.height).toBeLessThanOrEqual(160);
  const past = await page.evaluate(() => [...document.querySelectorAll('ol[aria-label="Initiative order"] button, ol[aria-label="Initiative order"] input')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).length);
  expect(past, 'row controls past the viewport edge').toBe(0);
  await page.evaluate(() => (document.documentElement.style.fontSize = ''));
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('a recharge note and a dying character fit a phone at 100% and 200% text', async () => {
  const { page } = shared;
  const trackerId = trackerUrl.split('/').pop()!;
  const act = (a: object) => api<{ rolls?: unknown[]; state: { combatants: { id: string; name: string }[] } }>(page, 'POST', `/api/campaigns/${campaignId}/trackers/${trackerId}/actions`, a);
  const added = await act({ type: 'add', combatants: [{ name: 'Drake', initiative: 40, hpMax: 50, recharge: [{ name: 'Fire Breath', min: 6 }] }] });
  const state = await act({ type: 'rechargeUsed', id: added.state.combatants.find((c) => c.name === 'Drake')!.id, name: 'Fire Breath' });
  const bram = state.state.combatants.find((c) => c.name === 'Bram')!.id;
  await act({ type: 'update', id: bram, patch: { hp: 0 } });
  for (let i = 0; i < 12; i++) if ((await act({ type: 'next' })).rolls?.length) break;
  await page.setViewportSize({ width: 390, height: 844 });
  const note = page.locator('[data-trk=recharge-note]');
  await expect(note).toBeVisible();
  expect((await page.locator('div.sticky:has([data-trk=next])').boundingBox())!.height, 'sticky block with one roll, 100%').toBeLessThanOrEqual(130);
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  expect((await page.locator('div.sticky:has([data-trk=next])').boundingBox())!.height, 'sticky block with one roll, 200%').toBeLessThanOrEqual(300);
  await page.evaluate(() => (document.documentElement.style.fontSize = ''));
  await page.setViewportSize({ width: 1280, height: 720 });
  await note.getByRole('button', { name: 'Dismiss recharge rolls' }).click();
  await expect(note).toHaveCount(0);
  // The table screen with a dying character at 200% text
  for (const width of [390, 320]) {
    await table.setViewportSize({ width, height: 844 });
    await table.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    await expect(table.getByText('Successes')).toBeVisible();
    const past = await table.evaluate(() => [...document.querySelectorAll('main *, li *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).length);
    expect(past, `table screen at ${width} px, 200%: elements past the edge`).toBe(0);
  }
  await table.evaluate(() => (document.documentElement.style.fontSize = ''));
});

test("ending combat saves the party's hit points", async () => {
  const { page } = shared;
  const box = page.locator('input[aria-label="Change hit points of Aria"]');
  await box.fill('-5');
  await box.press('Enter');
  await expect(page.locator('li', { hasText: 'Aria' }).locator('text=23').first()).toBeVisible();
  await page.getByRole('button', { name: 'End combat' }).click();
  await confirmDialog(page, 'End combat');
  await expect(page.getByText('This combat has ended')).toBeVisible();
  const aria = await api<{ facet: { hpCurrent: number } }>(page, 'GET', `/api/campaigns/${campaignId}/pages/${ariaId}`);
  expect(aria.facet.hpCurrent).toBe(23);
  await table.context().close();
});

test('encounter and loot blocks; loot reaches the inventory', async () => {
  const { page } = shared;
  const pageId = (await api<{ id: string }>(page, 'POST', `/api/campaigns/${campaignId}/pages`, { title: 'Session 4', type: 'session' })).id;
  await page.goto(`/c/${campaignId}/p/${pageId}`);
  await editor(page).click();
  await page.keyboard.type('/encounter');
  await pickSuggestion(page, 'Encounter');
  await page.locator('cn-encounter-block-view select').selectOption({ label: 'Goblin ambush' });
  await expect(page.locator('cn-encounter-block-view', { hasText: '4 × Goblin' })).toBeVisible();
  await expect(page.locator('cn-encounter-block-view', { hasText: 'deadly' })).toBeVisible();
  await editor(page).click({ position: { x: 20, y: 5 } });
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/loot');
  await pickSuggestion(page, 'Loot');
  const loot = page.locator('cn-loot-block-view');
  await loot.getByRole('button', { name: '+ Item' }).click();
  await loot.locator('input[aria-label="Custom loot item"]').fill('Silver ring');
  await loot.locator('form button', { hasText: 'Add' }).click();
  await loot.locator('input[aria-label=gp]').fill('25');
  await loot.locator('input[aria-label=gp]').press('Tab');
  await saved(page);
  await loot.getByRole('button', { name: 'Award' }).click();
  await expect(loot.getByText('Added to the inventory')).toBeVisible();
  await page.goto(`/c/${campaignId}/inventory`);
  const party = page.locator('section[aria-label=Party]');
  await expect(party.getByText('Silver ring')).toBeVisible();
  await expect(party.getByText('from Session 4')).toBeVisible();
  await expect(party.locator('[aria-label=Coins]')).toContainText(/25\s*gp/);
});
