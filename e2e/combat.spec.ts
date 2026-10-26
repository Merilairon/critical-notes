/** Encounters and combat: difficulty, the tracker, the live player view, conditions, and loot. */
import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll, smallTargets } from './phone-checks';
import { api, confirmDialog, dmState, editor, isPhone, newPage, pickSuggestion, saved, sharedPage } from './support';

const shared = sharedPage();
const abilities = { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 10 };
let campaignId: string, ariaId: string, trackerUrl: string;
/** The table screen (the player view), open next to the DM's tracker. */
let table: Page;

/**
 * After a viewport change the tracker switches its layout in a media-query handler, one change later: on a phone
 * the setup toolbar leaves the sticky block and goes below it. Measure the sticky block only once that has happened,
 * else it still holds the wrapped setup buttons (about 260 px) for a moment.
 */
const phoneLayoutSettled = async (page: Page) => {
  await expect(page.locator('div.sticky').getByRole('toolbar', { name: 'Combat setup' })).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: 'Combat setup' })).toBeVisible();
};

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
  await phoneLayoutSettled(page);
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
  await phoneLayoutSettled(page);
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

// A second fight with the same party: a dragon with legendary actions, and a character who drops to 0 HP
const dragon = 'Adult Red Dragon';
let bossId: string;

const rowOf = (page: Page, name: string) => order(page).filter({ has: page.locator('span.font-semibold', { hasText: new RegExp(`^${name}$`) }) });
const tableRow = (name: string) => table.locator('ol > li').filter({ has: table.locator('span.font-semibold', { hasText: new RegExp(`^${name}$`) }) });

test('a boss fight with a dragon from the real data', async ({ browser }) => {
  const { page } = shared;
  await page.goto(`/c/${campaignId}/encounters`);
  await page.getByRole('button', { name: 'New encounter' }).click();
  await page.waitForURL(/\/encounters\/[0-9a-f-]{36}$/);
  await page.locator('input[aria-label="Encounter name"]').fill('Dragon in the hall');
  await page.getByRole('button', { name: '+ Monster' }).click();
  await page.locator('cn-ref-picker input').fill('adult red dragon');
  await page.locator('[role=listbox] [role=option]', { hasText: /^Adult Red Dragon\s*MM/ }).first().click();
  await expect(page.locator('button[aria-label="One more Adult Red Dragon"]')).toBeVisible();
  await saved(page);
  await page.getByRole('button', { name: 'Run encounter' }).click();
  await page.waitForURL(/\/trackers\/[0-9a-f-]{36}$/);
  bossId = page.url().split('/').pop()!;
  await expect(rowOf(page, dragon)).toBeVisible();
  // The dragon's panels exist because its statblock has the data; the party has none
  await expect(rowOf(page, dragon).getByText('Legendary actions')).toBeVisible();
  await expect(rowOf(page, dragon).getByText('Legendary resistance')).toBeVisible();
  await expect(rowOf(page, 'Aria').getByText('Legendary actions')).toHaveCount(0);
  const init = (name: string) => page.locator(`input[aria-label="Initiative of ${name}"]`);
  for (const [name, value] of [[dragon, '30'], ['Aria', '20'], ['Bram', '10']] as const) {
    await init(name).fill(value);
    await init(name).press('Tab');
    await expect(init(name)).toHaveValue(value);
  }
  await table?.context().close(); // the first fight's table screen (already closed once is fine)
  table = await newPage(browser, dmState(), shared.errors);
  await table.goto(`/c/${campaignId}/trackers/${bossId}/view`);
  await expect(tableRow(dragon)).toBeVisible();
});

test("legendary actions: spend, undo, and the reset on the dragon's turn", async () => {
  const { page } = shared;
  const row = rowOf(page, dragon);
  const panel = row.getByRole('group', { name: /^Legendary actions/ });
  await expect(panel).toContainText('3 of 3 left');
  await page.getByRole('button', { name: 'Start combat' }).click();
  await expect(page.locator('li[aria-current=true]', { hasText: dragon })).toBeVisible();
  await row.getByRole('button', { name: `Spend 2 legendary actions of ${dragon}` }).click();
  await expect(panel).toContainText('1 of 3 left');
  await row.getByRole('button', { name: `Give back one legendary action of ${dragon}` }).click();
  await expect(panel).toContainText('2 of 3 left');
  await row.getByRole('button', { name: `Spend 3 legendary actions of ${dragon}` }).click();
  await expect(panel).toContainText('None left');
  // They come back when the dragon's turn starts again: dragon, Aria, Bram, then round 2
  await page.locator('h1').click();
  // One turn per press: wait for the active row to change before the next key
  for (const next of ['Aria', 'Bram', dragon]) {
    await page.keyboard.press('n');
    await expect(page.locator('li[aria-current=true]', { hasText: next })).toBeVisible();
  }
  await expect(page.locator('header [aria-live=polite]', { hasText: 'Round 2' })).toBeVisible();
  await expect(panel).toContainText('3 of 3 left');
});

test('Legendary Resistance: use one, give it back', async () => {
  const { page } = shared;
  const row = rowOf(page, dragon);
  const panel = row.getByRole('group', { name: /^Legendary resistance/ });
  await expect(panel).toContainText('3 of 3 left');
  await row.getByRole('button', { name: `Use one Legendary Resistance of ${dragon}` }).click();
  await expect(panel).toContainText('2 of 3 left');
  await row.getByRole('button', { name: `Use one Legendary Resistance of ${dragon}` }).click();
  await expect(panel).toContainText('1 of 3 left');
  await row.getByRole('button', { name: `Give back one Legendary Resistance of ${dragon}` }).click();
  await expect(panel).toContainText('2 of 3 left');
});

test('a character at 0 HP starts dying: death save pips and rolls', async () => {
  const { page } = shared;
  const row = rowOf(page, 'Bram');
  const box = page.locator('input[aria-label="Change hit points of Bram"]');
  // Bram's HP is set here, not inherited from the first fight (which ended with him at 0 HP)
  const tracker = await api<{ state: { combatants: { id: string; name: string }[] } }>(page, 'GET', `/api/campaigns/${campaignId}/trackers/${bossId}`);
  const bramId = tracker.state.combatants.find((c) => c.name === 'Bram')!.id;
  await api(page, 'POST', `/api/campaigns/${campaignId}/trackers/${bossId}/actions`, { type: 'update', id: bramId, patch: { hp: 24 } });
  await expect(row.locator('span.font-mono')).toHaveText('24');
  await expect(row.getByRole('button', { name: 'Start death saves for Bram' })).toHaveCount(0);
  await expect(row.getByRole('group', { name: /^Death saves/ })).toHaveCount(0);
  await box.fill('=0');
  await box.press('Enter');
  const panel = row.getByRole('group', { name: /^Death saves/ });
  await expect(panel).toContainText('Dying');
  const successes = row.getByRole('group', { name: 'Successes of Bram' });
  const failures = row.getByRole('group', { name: 'Failures of Bram' });
  await expect(successes).toContainText('0 of 3');

  // A success (15) and a failure (5), typed as the d20 the player rolled
  const roll = row.locator('input[aria-label="Death save d20 roll of Bram"]');
  await roll.fill('15');
  await row.getByRole('button', { name: 'Record roll for Bram' }).click();
  await expect(successes).toContainText('1 of 3');
  await expect(successes.locator('.cn-trk-pip[data-on=true]')).toHaveCount(1);
  await roll.fill('5');
  await row.getByRole('button', { name: 'Record roll for Bram' }).click();
  await expect(failures).toContainText('1 of 3');
  await expect(failures.locator('.cn-trk-pip[data-on=true]')).toHaveCount(1);

  // The table sees the same counts, for a player character
  const seen = tableRow('Bram');
  await expect(seen).toContainText('Dying');
  await expect(seen.locator('span', { hasText: /^Successes/ }).first()).toContainText('1 of 3');
  await expect(seen.locator('span', { hasText: /^Failures/ }).first()).toContainText('1 of 3');
  await expect(seen.locator('.cn-trk-pip[data-on=true]')).toHaveCount(2);

  // A manual correction with the stepper
  await failures.getByRole('button', { name: 'Remove a failure from Bram' }).click();
  await expect(failures).toContainText('0 of 3');
  await expect(seen.locator('.cn-trk-pip[data-on=true]')).toHaveCount(1);
});

test('Nat 1 is two failures; three failures is dead, and can be taken back', async () => {
  const { page } = shared;
  const row = rowOf(page, 'Bram');
  await row.getByRole('button', { name: 'Add a failure to Bram' }).click();
  await expect(row.getByRole('group', { name: 'Failures of Bram' })).toContainText('1 of 3');
  await row.getByRole('button', { name: 'Nat 1: two failures, death save for Bram' }).click();
  await expect(row.getByRole('group', { name: /^Death saves/ })).toContainText('Dead');
  await expect(row.getByRole('group', { name: 'Failures of Bram' })).toContainText('3 of 3');
  await expect(row.locator('span.font-semibold.line-through')).toBeVisible();
  await expect(tableRow('Bram')).toContainText('Dead');
  await expect(tableRow('Bram').locator('span.font-semibold.line-through')).toBeVisible();
  // A dead character gets no roll controls
  await expect(row.getByRole('button', { name: 'Record roll for Bram' })).toHaveCount(0);
  await row.getByRole('button', { name: 'Back to dying, Bram' }).click();
  await expect(row.getByRole('group', { name: /^Death saves/ })).toContainText('Dying');
  await expect(row.getByRole('group', { name: 'Failures of Bram' })).toContainText('0 of 3');
  await expect(tableRow('Bram')).toContainText('Dying');
  await expect(tableRow('Bram').locator('span.font-semibold.line-through')).toHaveCount(0);
});

test('Nat 20 brings the character up at 1 HP; down again, then Stable, then Dead', async () => {
  const { page } = shared;
  const row = rowOf(page, 'Bram');
  await row.getByRole('button', { name: 'Nat 20: up at 1 HP, death save for Bram' }).click();
  await expect(row.getByRole('group', { name: /^Death saves/ })).toHaveCount(0);
  await expect(tableRow('Bram').getByText('Dying')).toHaveCount(0);
  await expect(tableRow('Bram').locator('span.font-mono').last()).toHaveText(/^1\/24/);

  const box = page.locator('input[aria-label="Change hit points of Bram"]');
  await box.fill('-1');
  await box.press('Enter');
  const panel = row.getByRole('group', { name: /^Death saves/ });
  await expect(panel).toContainText('Dying');
  await row.getByRole('button', { name: 'Stable, Bram' }).click();
  await expect(panel).toContainText('Stable');
  await expect(tableRow('Bram')).toContainText('Stable');
  await expect(row.getByRole('button', { name: 'Record roll for Bram' })).toHaveCount(0);
  await row.getByRole('button', { name: 'Dead, Bram' }).click();
  await expect(panel).toContainText('Dead');
  await expect(tableRow('Bram')).toContainText('Dead');
});

test('the player view shows readied actions of characters only, and nothing DM-only', async () => {
  const { page } = shared;
  const ready = async (name: string, trigger: string) => {
    const row = rowOf(page, name);
    await row.getByRole('button', { name: new RegExp(`^More actions for ${name}`) }).click();
    await row.getByRole('button', { name: 'Ready…' }).click();
    await row.locator(`input[aria-label="Trigger of the readied action of ${name}"]`).fill(trigger);
    await row.getByRole('button', { name: 'Set' }).click();
    await expect(row.getByText(`Readied: ${trigger}`)).toBeVisible();
  };
  // Every DM-only change comes first; Aria's readied trigger (which the table does show) is set LAST, so that
  // seeing it on the table means the table has already received every state that could have leaked the rest
  const boss = rowOf(page, dragon);
  await boss.getByRole('button', { name: `Spend 1 legendary action of ${dragon}` }).click();
  await expect(boss.getByRole('group', { name: /^Legendary actions/ })).toContainText('2 of 3 left');
  await boss.getByRole('button', { name: `Use one Legendary Resistance of ${dragon}` }).click();
  await expect(boss.getByRole('group', { name: /^Legendary resistance/ })).toContainText('1 of 3 left');
  const tracker = await api<{ state: { combatants: { id: string; name: string }[] } }>(page, 'GET', `/api/campaigns/${campaignId}/trackers/${bossId}`);
  const dragonId = tracker.state.combatants.find((c) => c.name === dragon)!.id;
  await api(page, 'POST', `/api/campaigns/${campaignId}/trackers/${bossId}/actions`, { type: 'update', id: dragonId, patch: { notes: 'DM-only dragon note' } });
  // A monster flagged "Makes death saves", at 0 HP: the DM's tracker has it dying, the table must not know
  const act = (a: object) => api<{ state: { combatants: { id: string; name: string; dying?: { status: string } }[] } }>(page, 'POST', `/api/campaigns/${campaignId}/trackers/${bossId}/actions`, a);
  const ghoulId = (await act({ type: 'add', combatants: [{ name: 'Ghoul', kind: 'monster', initiative: 5, hpMax: 22, deathSaves: true }] })).state.combatants.find((c) => c.name === 'Ghoul')!.id;
  const downed = await act({ type: 'update', id: ghoulId, patch: { hp: 0 } });
  expect(downed.state.combatants.find((c) => c.id === ghoulId)!.dying?.status, 'the flagged monster is dying on the DM side').toBe('dying');
  await ready(dragon, 'secret dragon trigger');
  await ready('Aria', 'if the dragon inhales');

  // The sync point: the table has Aria's trigger, which was the last change
  await expect(tableRow('Aria')).toContainText('Readied: if the dragon inhales');

  // The dragon on the table: a health word and nothing else
  const seen = tableRow(dragon);
  await expect(seen).toBeVisible();
  await expect(seen).toContainText('Unhurt');
  await expect(seen).not.toContainText(/Readied|Dying|Stable|Dead|Successes|Failures|legendary|resistance|recharge|lair|secret|note/i);
  // The DM's labels and texts are nowhere in the player's DOM (innerHTML includes aria-labels and hidden nodes)
  const html = await table.locator('body').innerHTML();
  for (const secret of [
    'secret dragon trigger',
    'DM-only dragon note',
    `Spend 1 legendary action of ${dragon}`,
    `Use one Legendary Resistance of ${dragon}`,
    `Legendary actions of ${dragon}`,
    'Legendary resistance',
    'Record roll for',
    'Hidden from players',
  ]) {
    expect(html, `player DOM contains "${secret}"`).not.toContain(secret);
  }
  // The data the page is built from: the dragon has exactly the player fields, all empty but its name and health
  const raw = await api<{ combatants: Record<string, unknown>[] }>(table, 'GET', `/api/campaigns/${campaignId}/trackers/${bossId}/player`);
  const entry = raw.combatants.find((c) => c.name === dragon)!;
  expect(Object.keys(entry).sort()).toEqual(['conditions', 'dying', 'health', 'hp', 'id', 'initiative', 'kind', 'name', 'readied']);
  expect(entry).toMatchObject({ kind: 'monster', hp: null, dying: null, readied: null, conditions: [], initiative: 30 });
  // The flagged monster at 0 HP: only a health word, never dying (that is for characters)
  await expect(tableRow('Ghoul')).toBeVisible();
  await expect(tableRow('Ghoul')).not.toContainText(/Dying|Stable|Dead|Successes|Failures/i);
  expect(raw.combatants.find((c) => c.name === 'Ghoul')).toMatchObject({ kind: 'monster', hp: null, dying: null, health: 'down' });
  expect(JSON.stringify(raw)).not.toContain('secret dragon trigger');
  expect(JSON.stringify(raw)).not.toContain('DM-only dragon note');
  await table.context().close();
});
