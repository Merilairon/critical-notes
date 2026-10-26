/** Page history panel (N1.4): compare an older version, restore it, undo the restore, and keep players away from it. */
import { expect, test } from '@playwright/test';
import { api, editor, sharedPage } from './support';

const shared = sharedPage();
let campaignId: string, pageId: string;
const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

test('a page with two versions', async () => {
  const { page } = shared;
  campaignId = (await api<{ id: string }>(page, 'POST', '/api/campaigns', { name: 'History', ruleset: '2014' })).id;
  const created = await api<{ id: string; revision: number }>(page, 'POST', `/api/campaigns/${campaignId}/pages`, { title: 'Old Harbour', type: 'location', visibility: 'all', body: doc('Alpha tavern') });
  pageId = created.id;
  await api(page, 'PATCH', `/api/campaigns/${campaignId}/pages/${pageId}`, { body: doc('Beta tavern'), revision: created.revision });
  await page.goto(`/c/${campaignId}/p/${pageId}`);
  await expect(editor(page)).toContainText('Beta tavern');
});

test('open History, compare the first version with the current page', async () => {
  const { page } = shared;
  const toggle = page.getByRole('button', { name: /History/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const panel = page.locator('#cn-history-panel');
  await expect(panel.getByRole('heading', { name: 'History' })).toBeFocused();
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  await panel.getByRole('checkbox', { name: /Compare version 1\b/ }).check();
  const diff = panel.getByRole('region', { name: /Changes from version 1 to version/ });
  await expect(diff).toContainText('removed: Alpha tavern');
  await expect(diff).toContainText('added: Beta tavern');
  await expect(panel).toContainText('Compares text only');
});

test('restore the first version, then undo the restore', async () => {
  const { page } = shared;
  const panel = page.locator('#cn-history-panel');
  await panel.getByRole('button', { name: /^Restore version 1\b/ }).click();
  await expect(panel.getByRole('status')).toContainText('Restored version 1.');
  await expect(editor(page)).toContainText('Alpha tavern');
  await expect(panel.getByRole('listitem').first()).toContainText('Restored from version 1');
  await panel.getByRole('button', { name: 'Undo restore' }).click();
  await expect(panel.getByRole('status')).toContainText('Undone.');
  await expect(editor(page)).toContainText('Beta tavern');
  await expect(panel.getByRole('listitem')).toHaveCount(4);
});

test('Escape closes the panel and returns focus to the History button', async () => {
  const { page } = shared;
  await page.locator('#cn-history-panel').getByRole('heading', { name: 'History' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#cn-history-panel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /History/ })).toBeFocused();
});

test('the History button is hidden while previewing as a player', async () => {
  const { page } = shared;
  await page.getByRole('button', { name: /Preview as player/ }).click();
  await expect(page.getByRole('button', { name: /History/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Preview as player/ }).click();
  await expect(page.getByRole('button', { name: /History/ })).toBeVisible();
});
