/**
 * H1.3: the Properties panel by keyboard and mouse. Deleting a property definition drops its values on every page,
 * so no key sequence and no single click may remove one without the app's own confirmation dialog.
 * Findings and the keyboard table: docs/qa/properties-keyboard.md.
 */
import { expect, test, type Page } from '@playwright/test';
import { api, confirmDialog, sharedPage } from './support';

const shared = sharedPage();
let campaignId: string, pageId: string, moodId: string;

const defs = async (page: Page) => (await api<{ properties: { id: string; key: string }[] }>(page, 'GET', `/api/campaigns/${campaignId}/properties`)).properties;
const deleteButton = (page: Page, label: string) => page.getByRole('button', { name: `Delete property ${label}`, exact: true });

test('a campaign with a page and two properties', async () => {
  const { page } = shared;
  campaignId = (await api<{ id: string }>(page, 'POST', '/api/campaigns', { name: 'Keys', ruleset: '2014' })).id;
  pageId = (await api<{ id: string }>(page, 'POST', `/api/campaigns/${campaignId}/pages`, { title: 'Barkeep', type: 'npc', visibility: 'all' })).id;
  moodId = (await api<{ id: string }>(page, 'POST', `/api/campaigns/${campaignId}/properties`, { label: 'Mood', type: 'select', options: ['tense', 'calm'] })).id;
  await api(page, 'POST', `/api/campaigns/${campaignId}/properties`, { label: 'Notes', type: 'text' });
  await page.goto(`/c/${campaignId}/p/${pageId}`);
  await page.locator('summary', { hasText: 'Properties' }).click();
  await expect(page.locator('select[aria-label=Mood]')).toBeVisible();
});

test('stray Tab, arrow, Enter and Space keys inside the panel delete nothing (Tab inside the dialog excluded)', async () => {
  const { page } = shared;
  const panel = page.locator('cn-properties-panel');
  await page.locator('select[aria-label=Mood]').focus();
  // The QA script's keys in a fixed pseudo-random order. Focus is put back into the panel when a Tab walks out of it
  // (the rest of the page has a Sign out button, which is not what is tested here). While the dialog is open the Tab
  // key is skipped: Tab to "Delete property" and then Enter is a deliberate answer, covered in the next test.
  const keys = ['Tab', 'ArrowDown', 'Enter', 'ArrowRight', 'Space', 'Tab', 'Enter', 'ArrowUp', 'Enter', 'Enter', 'Shift+Tab', 'Space', 'Enter', 'Escape', 'Tab', 'Space', 'Enter'];
  let dialogsSeen = 0;
  for (let round = 0; round < 4; round++) {
    for (const key of keys) {
      const dialog = await page.getByRole('alertdialog').count();
      if (dialog) dialogsSeen++;
      if (dialog && /Tab/.test(key)) continue;
      if (!dialog && !(await panel.evaluate((el) => el.contains(document.activeElement)))) await page.locator('select[aria-label=Mood]').focus();
      await page.keyboard.press(key);
    }
  }
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(dialogsSeen, 'a delete button was reached and its dialog was shown').toBeGreaterThan(0);
  expect((await defs(page)).map((d) => d.key).sort()).toEqual(['mood', 'notes']);
});

test('Enter on a delete button opens the dialog with Cancel focused; Enter, Space and Esc cancel', async () => {
  const { page } = shared;
  await page.reload();
  // The panel may stay open across a reload
  const summary = page.locator('summary', { hasText: 'Properties' });
  await expect(summary).toBeVisible();
  if (!(await summary.evaluate((el) => (el.parentElement as HTMLDetailsElement).open))) await summary.click();
  await deleteButton(page, 'Mood').focus();
  for (const key of ['Enter', 'Space']) {
    await page.keyboard.press(key);
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Delete the property "Mood" from every page');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Enter'); // the default button is Cancel
    await expect(dialog).toHaveCount(0);
    await expect(deleteButton(page, 'Mood')).toBeFocused(); // focus returns to the opener
    expect((await defs(page)).length).toBe(2);
  }
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab'); // Cancel -> Delete property (focus is trapped in the dialog)
  await expect(page.getByRole('alertdialog').getByRole('button', { name: 'Delete property' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter'); // Cancel again
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect((await defs(page)).length).toBe(2);
});

test('a mouse click needs the dialog too; Cancel keeps the property', async () => {
  const { page } = shared;
  await deleteButton(page, 'Mood').click();
  await confirmDialog(page, 'Cancel', ['Delete property?']);
  await expect(page.locator('select[aria-label=Mood]')).toBeVisible();
  expect((await defs(page)).length).toBe(2);
});

test('the delete button target size is recorded (WCAG 2.5.8, 24 x 24 CSS px)', async () => {
  const { page } = shared;
  const box = (await deleteButton(page, 'Mood').boundingBox())!;
  test.info().annotations.push({ type: 'target-size', description: `${box.width} x ${box.height}` });
  // Recorded, not asserted at 24 px: see docs/qa/properties-keyboard.md
  expect(box.width).toBeGreaterThan(0);
});

test('Enter on the button, Tab to Delete property and Enter removes it: a deliberate two-step answer', async () => {
  const { page } = shared;
  await deleteButton(page, 'Notes').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog')).toBeVisible();
  expect((await defs(page)).length, 'nothing is deleted while the dialog is open').toBe(2);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect.poll(async () => (await defs(page)).map((d) => d.key)).toEqual(['mood']);
});

test('only the explicit confirm button removes the property', async () => {
  const { page } = shared;
  await deleteButton(page, 'Mood').click();
  await confirmDialog(page, 'Delete property', ['from every page']);
  await expect(page.locator('select[aria-label=Mood]')).toHaveCount(0);
  expect(await defs(page)).toEqual([]);
  expect(moodId).toBeTruthy();
});
