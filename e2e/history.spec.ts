/** Page history panel (N1.4) and the assistant edits of N1.5/N1.6: compare, restore, undo. Players are kept out in rights-history.spec.ts. */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, test, type Page } from '@playwright/test';
import { api, BASE_URL, editor, sharedPage } from './support';

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
  const toggle = page.getByRole('button', { name: /^🕑 History$/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const panel = page.locator('#cn-history-panel');
  await expect(panel.getByRole('heading', { name: 'History' })).toBeFocused();
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  const first = panel.getByRole('checkbox', { name: 'Compare version 1' });
  await first.click();
  await expect(first).toBeChecked();
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
  await expect(page.getByRole('button', { name: /^🕑 History$/ })).toBeFocused();
});

test('the History button is hidden while previewing as a player', async () => {
  const { page } = shared;
  await page.getByRole('button', { name: /Preview as player/ }).click();
  await expect(page.getByRole('button', { name: /^🕑 History$/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Preview as player/ }).click();
  await expect(page.getByRole('button', { name: /^🕑 History$/ })).toBeVisible();
});

/*
 * An AI assistant edits over /mcp (N1.5), and the GM sees and undoes it in the browser (N1.6).
 *
 * Saves by the same author, source and token within 2 minutes fold into one version (page-history.md section 4.1), which
 * would make a timing-dependent number of rows. So every step below changes the author, the source (web or mcp) or the
 * cause (a restore never folds) from the step before it: the number of versions is the same on every run, with no
 * waiting for the window to pass.
 */
const TOKEN_NAME = 'Claude desktop e2e';
type ToolResult = Awaited<ReturnType<Client['callTool']>>;
const mcpText = (res: ToolResult) => ((res.content ?? []) as { text?: string }[]).map((c) => c.text ?? '').join('\n');
/** The JSON a tool returned (its first text part). */
const mcpData = <T>(res: ToolResult): T => {
  expect(res.isError, mcpText(res)).toBeFalsy();
  return JSON.parse((res.content as { text: string }[])[0]!.text) as T;
};
interface HistoryRow { revision: number; viaAssistant: boolean; tokenName: string | null; cause: string; restoredFrom: number | null }

let aiCampaignId: string, aiPageId: string, mcp: Client;
let v1: number, v2: number, v3: number, v4: number;
const aiPath = () => `/c/${aiCampaignId}/p/${aiPageId}`;
const row = (page: Page, revision: number) => page.locator('#cn-history-panel').getByRole('listitem').filter({ hasText: new RegExp(`Version ${revision}(?!\\d)`) });

test('the GM writes a page, an assistant with a write token edits it over MCP', async () => {
  const { page } = shared;
  aiCampaignId = (await api<{ id: string }>(page, 'POST', '/api/campaigns', { name: 'History by AI', ruleset: '2014' })).id;
  const created = await api<{ id: string; revision: number }>(page, 'POST', `/api/campaigns/${aiCampaignId}/pages`, { title: 'Salt Road', type: 'location', visibility: 'all', body: doc('Original road') });
  aiPageId = created.id;
  v1 = created.revision;
  v2 = (await api<{ revision: number }>(page, 'PATCH', `/api/campaigns/${aiCampaignId}/pages/${aiPageId}`, { body: doc('Road as the GM wrote it'), revision: v1 })).revision;

  const { token } = await api<{ token: string }>(page, 'POST', '/api/auth/tokens', { name: TOKEN_NAME, scope: 'write', expiresInDays: 1 });
  mcp = new Client({ name: 'e2e', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const edit = mcpData<{ revision: number }>(await mcp.callTool({ name: 'update_page', arguments: { campaignId: aiCampaignId, pageId: aiPageId, markdown: 'Road as the assistant rewrote it', revision: v2 } }));
  v3 = edit.revision;
  expect(v3).toBeGreaterThan(v2);
});

test('History shows the assistant edit as via AI assistant with the token name, apart from the GM web edit', async () => {
  const { page } = shared;
  await page.goto(aiPath());
  await expect(editor(page)).toContainText('Road as the assistant rewrote it');
  await page.getByRole('button', { name: /^🕑 History$/ }).click();
  const panel = page.locator('#cn-history-panel');
  await expect(panel.getByRole('listitem')).toHaveCount(3);
  // Newest first: the assistant's edit, then the GM's web edit, then the page as created
  await expect(panel.getByRole('listitem').nth(0)).toContainText(`Jan via AI assistant (${TOKEN_NAME})`);
  await expect(panel.getByRole('listitem').nth(1)).toContainText('Jan');
  await expect(panel.getByRole('listitem').nth(1)).not.toContainText('via AI assistant');
  await expect(panel.getByRole('listitem').nth(2)).not.toContainText('via AI assistant');
});

test('the GM restores the version before the assistant edit, and the editor follows without a reload', async () => {
  const { page } = shared;
  const panel = page.locator('#cn-history-panel');
  // A marker on the window: a reload would lose it
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
  await row(page, v2).getByRole('button', { name: new RegExp(`^Restore version ${v2}\\b`) }).click();
  await expect(panel.getByRole('status')).toContainText(`Restored version ${v2}.`);
  await expect(editor(page)).toContainText('Road as the GM wrote it');
  await expect(editor(page)).not.toContainText('assistant rewrote');
  await expect(panel.getByRole('listitem').first()).toContainText(`Restored from version ${v2}`);
  await expect(panel.getByRole('listitem').first()).not.toContainText('via AI assistant');
  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
  await expect(panel.getByRole('listitem')).toHaveCount(4);
});

test('the assistant undoes its own edit with get_page_history and restore_page_version', async () => {
  const { page } = shared;
  // A second assistant edit on top of the GM's restore (the row before it is a web save, so it does not fold)
  let rows = mcpData<HistoryRow[]>(await mcp.callTool({ name: 'get_page_history', arguments: { campaignId: aiCampaignId, pageId: aiPageId } }));
  v4 = rows[0]!.revision;
  expect(rows[0]).toMatchObject({ cause: 'restore', restoredFrom: v2, viaAssistant: false });
  const edit = mcpData<{ revision: number }>(await mcp.callTool({ name: 'update_page', arguments: { campaignId: aiCampaignId, pageId: aiPageId, markdown: 'Road with the assistant second thoughts', revision: v4 } }));

  // It finds its own edit in the history and goes back to the version just before it
  rows = mcpData<HistoryRow[]>(await mcp.callTool({ name: 'get_page_history', arguments: { campaignId: aiCampaignId, pageId: aiPageId } }));
  expect(rows[0]).toMatchObject({ revision: edit.revision, viaAssistant: true, tokenName: TOKEN_NAME, cause: 'edit' });
  const before = rows[1]!;
  expect(before.revision).toBe(v4);
  const undone = mcpData<{ restored: boolean; revision: number }>(
    await mcp.callTool({ name: 'restore_page_version', arguments: { campaignId: aiCampaignId, pageId: aiPageId, revision: before.revision, currentRevision: edit.revision } }),
  );
  expect(undone.restored).toBe(true);
  await mcp.close();

  // The panel of the open page does not poll: reload, as a GM coming back to the page would
  await page.reload();
  await expect(editor(page)).toContainText('Road as the GM wrote it');
  await expect(editor(page)).not.toContainText('second thoughts');
  await page.getByRole('button', { name: /^🕑 History$/ }).click();
  const panel = page.locator('#cn-history-panel');
  await expect(panel.getByRole('listitem')).toHaveCount(6);
  const top = panel.getByRole('listitem').first();
  await expect(top).toContainText(`Jan via AI assistant (${TOKEN_NAME})`);
  await expect(top).toContainText(`Restored from version ${before.revision}`);
  await expect(panel.getByRole('listitem').nth(1)).toContainText('via AI assistant');
  await expect(panel.getByRole('listitem').nth(1)).not.toContainText('Restored from');
});
