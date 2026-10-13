/** API tokens for AI assistants: made in the Account page, used over MCP, revoked. */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, test } from '@playwright/test';
import { api, BASE_URL, editor, sharedPage } from './support';

const shared = sharedPage();
let token: string;
let campaignId: string;

const connect = async (bearer: string) => {
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
  return client;
};
const text = (res: Awaited<ReturnType<Client['callTool']>>) => ((res.content ?? []) as { text?: string }[]).map((c) => c.text ?? '').join('\n');

test('make a token on the Account page', async () => {
  const { page } = shared;
  campaignId = (await api<{ id: string }>(page, 'POST', '/api/campaigns', { name: 'AI Prep', ruleset: '2024' })).id;
  await page.goto('/campaigns');
  await page.getByRole('link', { name: 'Jan' }).click();
  await page.waitForURL('**/account');
  await page.getByLabel('Token name').fill('Claude in the browser test');
  await page.getByRole('button', { name: 'Create token' }).click();
  token = await page.getByLabel('New token').inputValue();
  expect(token).toMatch(/^cn_/);
  await expect(page.locator('pre[aria-label="Claude Code"]')).toContainText(`claude mcp add --transport http critical-notes ${BASE_URL}/mcp`);
  await expect(page.locator('tr', { hasText: 'Claude in the browser test' })).toContainText('Read and write');
});

test('an assistant writes a page that shows up in the app', async () => {
  const mcp = await connect(token);
  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  expect(tools).toEqual(expect.arrayContaining(['create_page', 'update_page', 'delete_page', 'create_encounter', 'save_template']));
  const res = await mcp.callTool({
    name: 'create_page',
    arguments: { campaignId, title: 'Old Owl Well', type: 'location', visibility: 'all', markdown: '## The tower\n\nRuined and quiet.\n\n:::secret\nA necromancer digs here.\n:::' },
  });
  expect(res.isError, text(res)).toBeFalsy();
  const pageId = (JSON.parse((res.content as { text: string }[])[0]!.text) as { id: string }).id;
  await mcp.close();

  const { page } = shared;
  await page.goto(`/c/${campaignId}`);
  await page.locator('cn-page-tree a', { hasText: 'Old Owl Well' }).click();
  await page.waitForURL(`**/p/${pageId}`);
  await expect(editor(page).locator('h2', { hasText: 'The tower' })).toBeVisible();
  await expect(editor(page).locator('.cn-secret')).toContainText('A necromancer digs here.');
});

test('a revoked token stops working', async () => {
  const { page } = shared;
  await page.goto('/account');
  await page.getByRole('button', { name: 'Revoke Claude in the browser test' }).click();
  await expect(page.locator('tr', { hasText: 'Claude in the browser test' })).toHaveCount(0);
  await expect(connect(token)).rejects.toThrow();
});
