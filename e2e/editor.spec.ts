/** The block editor: "/" menu, [[page links]], secrets, custom properties, the player preview, backlinks and search. */
import { expect, test } from '@playwright/test';
import { api, editor, pickSuggestion, saved, sharedPage } from './support';

const SECRET = 'Glasstaff is really Iarno';
const shared = sharedPage();
let campaignId: string, innId: string, sessionId: string;

test('a campaign with an inn and a session', async () => {
  const { page } = shared;
  campaignId = (await api<{ id: string }>(page, 'POST', '/api/campaigns', { name: 'Lost Mine', ruleset: '2014' })).id;
  const create = async (body: object) => (await api<{ id: string }>(page, 'POST', `/api/campaigns/${campaignId}/pages`, body)).id;
  innId = await create({ title: 'Stonehill Inn', type: 'location', visibility: 'all' });
  sessionId = await create({ title: 'Session 1', type: 'session', visibility: 'all' });
  await page.goto(`/c/${campaignId}/p/${sessionId}`);
  await expect(editor(page)).toBeVisible();
});

test('write blocks with the "/" menu, a [[link]] and a secret', async () => {
  const { page } = shared;
  await editor(page).click();
  await page.keyboard.type('The party arrives at ');
  await page.keyboard.type('[[Stonehill');
  await pickSuggestion(page, 'Stonehill Inn');
  await page.keyboard.type('for the night.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/callout');
  await pickSuggestion(page, 'Callout');
  await page.keyboard.type('Remember the redbrand patrol.');
  await editor(page).locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/secret');
  await pickSuggestion(page, 'DM secret');
  await page.keyboard.type(SECRET);
  await saved(page);
  await expect(editor(page).locator('.cn-page-link')).toHaveCount(1);
  await expect(editor(page).locator('.cn-callout')).toHaveCount(1);
  await expect(editor(page).locator('.cn-secret')).toHaveCount(1);
});

test('the body is kept after a reload', async () => {
  const { page } = shared;
  await page.reload();
  await expect(editor(page).locator('.cn-secret')).toBeVisible();
  await expect(editor(page)).toContainText(SECRET);
  await expect(editor(page)).toContainText('Stonehill Inn');
});

test('a custom property: define it and set a value', async () => {
  const { page } = shared;
  await page.locator('summary', { hasText: 'Properties' }).click();
  await page.getByRole('button', { name: '+ Add property' }).click();
  await page.locator('form input').first().fill('Mood');
  await page.locator('form select').first().selectOption('select');
  await page.locator('form label', { hasText: 'Options' }).locator('input').fill('tense, calm');
  await page.locator('form button', { hasText: 'Add' }).click();
  await page.locator('select[aria-label=Mood]').selectOption('tense');
  await saved(page);
  await page.reload();
  await expect(page.locator('select[aria-label=Mood]')).toHaveValue('tense');
});

test('the player preview leaves the secret out (page and network)', async () => {
  const { page } = shared;
  const response = page.waitForResponse((r) => r.url().includes(`/pages/${sessionId}?as=player`));
  await page.getByRole('button', { name: 'Preview as player' }).click();
  expect(await (await response).text()).not.toContain(SECRET);
  const preview = page.locator('.cn-player-preview');
  await expect(preview.locator('.cn-callout')).toBeVisible();
  await expect(preview).not.toContainText(SECRET);
  await expect(preview).toContainText('The party arrives at');
  await expect(preview).toContainText('Stonehill Inn');
  await page.getByRole('button', { name: 'Preview as player' }).click();
  await expect(editor(page).locator('.cn-secret')).toBeVisible();
});

test('the linked page shows the backlink', async () => {
  const { page } = shared;
  await page.locator('.tiptap .cn-page-link').click();
  await page.waitForURL(`**/p/${innId}`);
  await expect(page.locator('cn-backlinks-panel a', { hasText: 'Session 1' })).toBeVisible();
});

test('Ctrl+K finds campaign pages by their text', async () => {
  const { page } = shared;
  await page.keyboard.press('Control+k');
  await page.locator('input[type=search]').fill('redbrand');
  await expect(page.locator('#cn-palette-results', { hasText: 'Campaign pages' })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.waitForURL(`**/p/${sessionId}`);
});
