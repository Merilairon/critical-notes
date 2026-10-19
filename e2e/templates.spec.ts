/** Templates: the built-in library, block templates with typed fields, linked copies, page templates and defaults. */
import { expect, test, type Page } from '@playwright/test';
import { api, editor, saved, sharedPage } from './support';

const shared = sharedPage();
let campaignId: string, templateId: string, ruinsId: string;

/** Stat grid inputs bind `value` as a property, so match on the live values. */
const statValue = (page: Page, text: string) =>
  page.waitForFunction((t) => [...document.querySelectorAll<HTMLInputElement>('.cn-stat-grid input')].some((i) => i.value === t), text);

test('the library shows the built-ins, read-only', async () => {
  const { page } = shared;
  campaignId = (await api<{ id: string }>(page, 'POST', '/api/campaigns', { name: 'Template Test', ruleset: '2024' })).id;
  await page.goto('/templates');
  await expect(page.locator('h2', { hasText: 'Built-in' }).locator('xpath=following-sibling::ul[1]/li')).toHaveCount(13);
  await page.locator('a', { hasText: 'Dungeon room' }).click();
  await expect(page.getByText('Built-in templates are read-only')).toBeVisible();
});

test('a block template with typed fields', async () => {
  const { page } = shared;
  await page.goto('/templates');
  await page.getByRole('button', { name: 'New block template' }).click();
  await page.waitForURL(/\/templates\/new\/block/);
  await page.locator('input[aria-label="Template name"]').fill('Gate trap');
  await editor(page).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('The gate trap: DC {{dc: number = 14}} or take {{dmg: dice = 2d6}} damage.');
  await expect(page.locator('cn-variables-panel code', { hasText: 'dmg' })).toBeVisible();
  await expect(page.locator('input[aria-label="dc type"]')).toHaveValue('number');
  await page.locator('input[aria-label="dc label"]').fill('Save DC');
  await page.locator('input[aria-label="dc label"]').press('Tab');
  await page.locator('header button', { hasText: 'Create' }).click();
  await page.waitForURL(/\/templates\/[0-9a-f-]{36}$/);
  templateId = page.url().split('/templates/')[1]!;
});

test('insert it, linked, with the "/" menu', async () => {
  const { page } = shared;
  ruinsId = (await api<{ id: string }>(page, 'POST', `/api/campaigns/${campaignId}/pages`, { title: 'Ruins', type: 'location' })).id;
  await page.goto(`/c/${campaignId}/p/${ruinsId}`);
  await editor(page).click();
  await page.keyboard.type('/templat');
  await expect(page.locator('.cn-suggest-item', { hasText: 'Template…' })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.locator('[role=dialog] button', { hasText: 'Gate trap' }).click();
  await page.locator('[role=dialog] input[aria-label="Save DC"]').fill('16');
  await page.locator('[role=dialog] label', { hasText: 'Keep linked' }).click();
  await page.locator('[role=dialog] button', { hasText: 'Insert' }).click();
  await expect(page.locator('.cn-linked-template', { hasText: 'DC 16' })).toBeVisible();
  await saved(page);
});

test('changing the template updates the linked copy', async () => {
  const { page } = shared;
  await page.goto(`/templates/${templateId}`);
  await editor(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' UPDATED');
  await page.locator('header button', { hasText: 'Save' }).click();
  await expect(page.locator('[aria-live=polite]', { hasText: '1 linked page updated' })).toBeVisible();
  await page.goto(`/c/${campaignId}/p/${ruinsId}`);
  await expect(page.locator('.cn-linked-template', { hasText: 'UPDATED' })).toBeVisible();
  await expect(page.locator('.cn-linked-template')).toContainText('DC 16');
});

test('edit the values of the linked copy', async () => {
  const { page } = shared;
  await page.locator('.cn-linked-template button', { hasText: 'Edit values' }).click();
  await page.locator('.cn-linked-values input[aria-label="Save DC"]').fill('18');
  await page.locator('.cn-linked-values button', { hasText: 'Apply' }).click();
  await expect(page.locator('.cn-linked-template', { hasText: 'DC 18' })).toBeVisible();
  await saved(page);
});

test('a new page from a built-in page template', async () => {
  const { page } = shared;
  await page.getByRole('button', { name: '+ New' }).click();
  await page.locator('button', { hasText: 'From template…' }).click();
  await page.locator('[role=dialog] button', { hasText: 'Settlement' }).click();
  await page.locator('[role=dialog] input[aria-label="Page title"]').fill('Phandalin');
  await page.locator('[role=dialog] input[aria-label=population]').fill('500');
  await page.locator('[role=dialog] button', { hasText: 'Create page' }).click();
  await page.waitForURL((u) => u.pathname.includes('/p/') && !u.pathname.endsWith(ruinsId));
  // The editor component is reused across pages: wait for it to show the new one
  await expect(page.locator('[data-campaign-main] [aria-label="Page title"]')).toHaveValue('Phandalin');
  await statValue(page, '500');
  await expect(page.locator('.tiptap', { hasText: 'Who is here' })).toBeVisible();
});

test("the campaign's default template for NPCs", async () => {
  const { page } = shared;
  await page.goto(`/c/${campaignId}/settings`);
  await page.locator('select[aria-label="Template for NPC"]').selectOption({ label: 'NPC' });
  await expect(page.locator('[role=status]', { hasText: 'Saved' })).toBeVisible();
  await page.getByRole('button', { name: '+ New' }).click();
  await page.locator('[role=menu] button', { hasText: 'NPC' }).first().click();
  await page.waitForURL(/\/p\//);
  await expect(page.locator('.tiptap', { hasText: 'Appearance' })).toBeVisible();
  await statValue(page, 'Species'); // {{rules.race}} in a 2024 campaign
});

test('apply a template to an existing page', async () => {
  const { page } = shared;
  await page.goto(`/c/${campaignId}/p/${ruinsId}`);
  await page.getByRole('button', { name: 'Apply template' }).click();
  await page.locator('[role=dialog] button', { hasText: 'Dungeon room' }).click();
  await page.locator('[role=dialog] button', { hasText: 'Apply' }).click();
  await expect(page.locator('.tiptap', { hasText: 'Hazards' })).toBeVisible();
  await expect(editor(page)).toContainText('UPDATED');
});

test('deleted templates: restore a personal one, delete a campaign one permanently', async () => {
  const { page } = shared;
  const copy = async (scope: 'user' | 'campaign', name: string) => {
    const t = await api<{ id: string; version: number }>(page, 'POST', `/api/templates/${templateId}/duplicate`, { scope, campaignId: scope === 'campaign' ? campaignId : null });
    await api(page, 'PUT', `/api/templates/${t.id}`, { version: t.version, name });
    await api(page, 'DELETE', `/api/templates/${t.id}`);
    return t.id;
  };
  await copy('user', 'Bin personal');
  await copy('campaign', 'Bin campaign');

  await page.goto('/templates');
  const deleted = page.locator('cn-template-trash');
  await expect(deleted.getByRole('heading', { name: 'Deleted templates' })).toBeVisible();
  await expect(deleted.locator('li', { hasText: 'Bin campaign' })).toHaveCount(0); // personal view
  await deleted.getByRole('button', { name: 'Restore: Bin personal' }).click();
  await expect(deleted.locator('div[role=status]')).toContainText('Restored "Bin personal"');
  await expect(page.locator('cn-template-library a', { hasText: 'Bin personal' })).toBeVisible();

  await page.goto(`/c/${campaignId}/templates`);
  await deleted.getByRole('button', { name: 'Delete permanently: Bin campaign' }).click();
  await expect(deleted.locator('div[role=status]')).toContainText('Permanently deleted "Bin campaign"');
  await expect(deleted.locator('li')).toHaveCount(0);
});
