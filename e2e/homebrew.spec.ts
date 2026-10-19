/** Homebrew: sources, the form editor with {@ autocomplete and preview, variants, sharing, import, export, delete. */
import { expect, test } from '@playwright/test';
import { api, sharedPage } from './support';

const shared = sharedPage();
let campaignId: string, sourceId: string, houndId: string;

test('a homebrew source', async () => {
  const { page } = shared;
  campaignId = (await api<{ id: string }>(page, 'POST', '/api/campaigns', { name: 'Misty Campaign', ruleset: '2014' })).id;
  await page.goto('/homebrew');
  await page.getByRole('button', { name: 'New source' }).click();
  await page.locator('input[name=fullName]').fill('Misty Vale Tales');
  await page.locator('input[name=abbreviation]').fill('MVT');
  await page.locator('select[name=edition]').selectOption('2014');
  await page.getByRole('button', { name: 'Create source' }).click();
  await page.waitForURL(/\/homebrew\/s\//);
  sourceId = page.url().split('/s/')[1]!;
  await expect(page.locator('h1', { hasText: 'Misty Vale Tales' })).toBeVisible();
});

test('a new monster: form, {@ autocomplete, live preview', async () => {
  const { page } = shared;
  await page.locator('select[aria-label="New entry"]').selectOption('monster');
  await page.waitForURL(/\/new\/monster$/);
  await page.locator('#hb-name').fill('Fog Hound');
  await page.locator('#hb-name').press('Tab');
  await page.locator('#hb-cr').selectOption('2');
  await page.getByRole('button', { name: '+ Traits' }).click();
  await page.locator('input[aria-label="Traits 1 name"]').fill('Misty Bite');
  await page.locator('input[aria-label="Traits 1 name"]').press('Tab');
  const area = page.locator('textarea[aria-label="Paragraph 1"]').first();
  await area.click();
  await area.pressSequentially('Breathes like {@spell fire bo');
  await expect(page.locator('[role=listbox] button', { hasText: 'Fire Bolt' }).first()).toBeVisible();
  await page.keyboard.press('Enter');
  await area.pressSequentially(' when angry.');
  await expect(area).toHaveValue(/\{@spell Fire Bolt\|PHB\} when angry\./);
  await expect(page.locator('aside cn-entity-view h1', { hasText: 'Fog Hound' })).toBeVisible();
  await expect(page.locator('aside', { hasText: 'Misty Bite' })).toBeVisible();
  await page.locator('header button', { hasText: 'Create' }).click();
  await page.waitForURL(/\/homebrew\/e\//);
  houndId = page.url().split('/e/')[1]!;
  await expect(page.locator('[aria-live=polite]', { hasText: 'Saved' })).toBeVisible();
});

test('the JSON view shows the same entity', async () => {
  const { page } = shared;
  await page.locator('button[role=tab]', { hasText: 'JSON' }).click();
  await expect(page.locator('.cm-content')).toContainText('"Fog Hound"');
  await expect(page.locator('.cm-content')).toContainText('Fire Bolt|PHB');
});

test('homebrew shows in the reference with a badge', async () => {
  const { page } = shared;
  await page.locator('a', { hasText: 'View in reference' }).click();
  await page.waitForURL(/\/reference\/monster\//);
  await expect(page.locator('h1', { hasText: 'Fog Hound' })).toBeVisible();
  await expect(page.locator('.cn-badge-homebrew').first()).toBeVisible();
});

test('copy an official monster as a variant', async () => {
  const { page } = shared;
  await page.goto(`/reference/monster/${encodeURIComponent('monster:goblin|mm')}`);
  await page.getByRole('button', { name: 'Copy to homebrew' }).click();
  await page.locator('cn-copy-to-homebrew input[placeholder]').fill('Goblin Fogrunner');
  await page.getByRole('button', { name: 'Copy and edit' }).click();
  await page.waitForURL(/\/homebrew\/e\//);
  await expect(page.getByText('Variant of')).toBeVisible();
  await expect(page.locator('aside cn-entity-view h1', { hasText: 'Goblin Fogrunner' })).toBeVisible();
  await expect(page.locator('aside', { hasText: 'Nimble Escape' })).toBeVisible();
});

test('share with a campaign; its search finds the homebrew', async () => {
  const { page } = shared;
  await page.goto(`/homebrew/s/${sourceId}`);
  await page.locator('label', { hasText: 'Misty Campaign' }).locator('input').check();
  await expect(page.locator('label', { hasText: 'Misty Campaign' }).locator('input')).toBeChecked();
  await page.goto(`/c/${campaignId}`);
  // The shortcut is only bound once the app has started (a race when tracing is off and the machine is fast)
  await page.waitForLoadState('networkidle');
  await page.keyboard.press('Control+k');
  await page.locator('input[type=search]').fill('fog hound');
  await expect(page.locator('#cn-palette-results button', { hasText: 'Fog Hound' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('import a homebrew file', async () => {
  const { page } = shared;
  await page.goto('/homebrew');
  await page.getByRole('button', { name: 'Import' }).click();
  const brew = {
    _meta: { sources: [{ json: 'Thornwood', abbreviation: 'THW', full: 'Thornwood Gazette', authors: ['Ann'], version: '1.0.0' }], dateAdded: 0, dateLastModified: 0, edition: 'classic' },
    spell: [
      {
        name: 'Thorn Whip Plus',
        source: 'Thornwood',
        level: 1,
        school: 'C',
        time: [{ number: 1, unit: 'action' }],
        range: { type: 'point', distance: { type: 'feet', amount: 30 } },
        components: { v: true },
        duration: [{ type: 'instant' }],
        entries: ['Thorns.'],
      },
    ],
    item: [{ name: 'Thorn Ring', source: 'Thornwood', type: 'RG', rarity: 'rare', entries: ['Prickly.'] }],
  };
  await page.locator('input[type=file][accept]').setInputFiles({ name: 'thornwood.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(brew)) });
  await expect(page.locator('cn-import-panel', { hasText: '2 created' })).toBeVisible();
  await expect(page.locator('a', { hasText: 'Thornwood Gazette' })).toBeVisible();
});

test('the export is 5etools homebrew', async () => {
  const doc = await api<{ _meta: { sources: { json: string }[] }; monster: unknown[] }>(shared.page, 'GET', `/api/homebrew/sources/${sourceId}/export`);
  expect(doc._meta.sources[0]!.json).toBe('MistyValeTales');
  expect(doc.monster).toHaveLength(2);
});

test('delete and restore', async () => {
  const { page } = shared;
  await page.goto(`/homebrew/e/${houndId}`);
  await page.locator('header button', { hasText: 'Delete' }).click();
  await page.waitForURL(/\/homebrew\/s\//);
  await expect(page.locator('a', { hasText: 'Fog Hound' })).toHaveCount(0);
  await page.locator('label', { hasText: 'Show deleted' }).locator('input').check();
  await page.locator('a', { hasText: 'Fog Hound' }).click();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('header .cn-badge', { hasText: 'Deleted' })).toHaveCount(0);
});
