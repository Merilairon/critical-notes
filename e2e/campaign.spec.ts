/** Campaigns, typed pages and the NPC statblock, the campaign's reference, signing in and out. */
import { expect, test } from '@playwright/test';
import { DM, newPage, sharedPage } from './support';

const shared = sharedPage();

test('create a campaign', async () => {
  const { page } = shared;
  await page.goto('/campaigns');
  await page.getByRole('button', { name: 'New campaign' }).click();
  await page.locator('input[name=name]').fill('Lost Mine of Phandelver');
  await page.locator('textarea[name=description]').fill('A starter adventure.');
  await page.locator('form label', { hasText: 'D&D 5e (2014 rules)' }).click();
  await page.getByRole('button', { name: 'Create campaign' }).click();
  await page.waitForURL(/\/c\/[^/]+$/);
  await expect(page.locator('h1', { hasText: 'Lost Mine' })).toBeVisible();
});

test('an NPC with a customized statblock', async () => {
  const { page } = shared;
  await page.getByRole('button', { name: '+ NPC' }).click();
  await page.waitForURL(/\/p\//);
  await page.locator('[aria-label="Page title"]').fill('Glasstaff');
  await page.locator('input[placeholder="Search the bestiary…"]').fill('mage');
  await page.locator('[role=listbox] button').filter({ has: page.getByText(/^Mage$/) }).click();
  await expect(page.locator('.cn-statblock')).toBeVisible();
  await page.getByRole('button', { name: 'Customize copy' }).click();
  await expect(page.locator('.cn-badge-homebrew', { hasText: 'Customized' })).toBeVisible();
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Iarno Albrek, secretly the leader of the Redbrands.');
  await expect(page.locator('[aria-live=polite]', { hasText: 'Saved' })).toBeVisible();
});

test('the NPC list shows the custom statblock', async () => {
  const { page } = shared;
  await page.locator('nav[aria-label=Campaign] a', { hasText: 'NPCs' }).click();
  await expect(page.locator('td a', { hasText: 'Glasstaff' })).toBeVisible();
  await expect(page.locator('.cn-badge-homebrew', { hasText: 'custom' })).toBeVisible();
});

test('session log', async () => {
  const { page } = shared;
  await page.locator('nav[aria-label=Campaign] a', { hasText: 'Sessions' }).click();
  await page.getByRole('button', { name: '+ Next session' }).click();
  await page.waitForURL(/\/p\//);
  await page.locator('nav[aria-label=Campaign] a', { hasText: 'Sessions' }).click();
  await expect(page.locator('[data-campaign-main] a', { hasText: 'Session 1' })).toBeVisible();
});

test("the campaign's reference uses its rules", async () => {
  const { page } = shared;
  await page.locator('nav[aria-label=Campaign] a', { hasText: 'Reference' }).click();
  await page.locator('a', { hasText: 'Spells' }).click();
  await page.locator('input[type=search]').fill('fireball');
  const fireball = page.locator('button[role=option]', { hasText: 'Fireball' });
  await expect(fireball.locator('span').last()).toHaveText('PHB');
});

test('the page body is kept', async () => {
  const { page } = shared;
  await page.locator('nav[aria-label=Pages] a', { hasText: 'Glasstaff' }).click();
  await expect(page.locator('.ProseMirror', { hasText: 'Redbrands' })).toBeVisible();
  await page.locator('nav[aria-label=Campaign] a', { hasText: 'Settings' }).click();
  await expect(page.locator('h2', { hasText: 'Sources' })).toBeVisible();
});

test('sign in and out', async ({ browser }) => {
  // A separate session: signing out ends only that one
  const errors: string[] = [];
  const page = await newPage(browser, undefined, errors);
  await page.goto('/login');
  await page.locator('input[name=username]').fill(DM.username);
  await page.locator('input[name=password]').fill(DM.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/campaigns');
  await expect(page.locator('h2', { hasText: 'Lost Mine of Phandelver' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('**/login');
  await page.context().close();
  expect(errors).toEqual([]);
});
