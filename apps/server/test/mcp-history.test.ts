/** MCP page history tools (task N1.5): get_page_history and restore_page_version, GM tokens only. */
import type { Client } from '@modelcontextprotocol/client';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageRevisions } from '../src/db/schema';
import { Api, isAllowed } from '../src/mcp/api';
import { createFixture, createSignedInApp, TestClient, type Fixture, type TestApp } from './helpers';
import { callTool, makeToken, mcpClient } from './mcp-client';

let fx: Fixture;
let app: TestApp;
let dm: TestClient;
let mcp: Client;
let campaignId: string;
let dmId: string;
const base = () => `/api/campaigns/${campaignId}`;
const hist = (id: string) => `${base()}/pages/${id}/history`;

beforeAll(async () => {
  fx = await createFixture();
  const signed = await createSignedInApp(fx);
  app = signed.app;
  dm = signed.client;
  signed.services.templates.upsertBuiltins();
  campaignId = ((await dm.post('/api/campaigns', { name: 'Phandalin', ruleset: '2014' })).body as { id: string }).id;
  dmId = ((await dm.get('/api/auth/me')).body as { user: { id: string } }).user.id;
  mcp = await mcpClient(app, await makeToken(dm, 'write', 'assistant'));
});
afterAll(() => fx.cleanup());

async function join(role: 'player' | 'codm', username: string) {
  const invite = (await dm.post(`${base()}/invites`, { role })).body as { token: string };
  const client = new TestClient(app);
  await client.post('/api/auth/register', { token: invite.token, username, displayName: username, password: 'a long enough password' });
  return { client, userId: ((await client.get('/api/auth/me')).body as { user: { id: string } }).user.id };
}
const rowsOf = (pageId: string) => fx.db.select().from(pageRevisions).where(eq(pageRevisions.pageId, pageId)).all().sort((a, b) => a.revision - b.revision);

describe('page history through MCP (task N1.5)', () => {
  it('allows exactly the three history routes, with strict revisions, and never a purge', () => {
    const p = '/api/campaigns/c1/pages/p1/history';
    for (const [m, u] of [['GET', p], ['GET', `${p}/3`], ['GET', `${p}/-1`], ['POST', `${p}/3/restore`]] as const) expect([m, u, isAllowed(m, u)]).toEqual([m, u, true]);
    for (const [m, u] of [
      ['POST', p], ['PUT', p], ['PATCH', p], ['DELETE', p], ['DELETE', `${p}/3`], ['PUT', `${p}/3`], ['POST', `${p}/3`], ['GET', `${p}/3/restore`],
      ['GET', `${p}/abc`], ['GET', `${p}/1x`], ['GET', `${p}/1/2`], ['GET', `${p}/../x`], ['GET', `${p}/`], ['POST', `${p}/abc/restore`], ['POST', `${p}/3/restore/x`],
      ['DELETE', `${p}/3/restore`], ['GET', '/api/campaigns/c1/history'], ['GET', `${p}/prune`],
      ['DELETE', '/api/campaigns/c1/pages/p1/purge'], ['POST', '/api/campaigns/c1/pages/p1/purge'], ['DELETE', '/api/campaigns/c1/trash'],
    ] as const) expect([m, u, isAllowed(m, u)]).toEqual([m, u, false]);
  });

  it('lets an assistant find and undo its own edit, recorded as an MCP write with the token', async () => {
    const tokenId = ((await dm.get('/api/auth/tokens')).body as { tokens: { id: string; name: string }[] }).tokens.find((t) => t.name === 'assistant')!.id;
    const page = await callTool(mcp, 'create_page', { campaignId, title: 'Ledger', markdown: 'Original text.' });
    fx.db.update(pageRevisions).set({ createdAt: Date.now() - 60 * 60_000 }).where(eq(pageRevisions.pageId, page.data.id)).run();
    const edit = await callTool(mcp, 'update_page', { campaignId, pageId: page.data.id, markdown: 'Wrecked text.', revision: page.data.revision });
    expect(edit.isError).toBe(false);

    const list = await callTool(mcp, 'get_page_history', { campaignId, pageId: page.data.id });
    expect(list.data.map((r: { revision: number }) => r.revision)).toEqual([edit.data.revision, page.data.revision]);
    expect(list.data[0]).toEqual({ revision: edit.data.revision, createdAt: expect.any(Number), author: expect.any(String), viaAssistant: true, tokenName: 'assistant', cause: 'edit', restoredFrom: null, title: 'Ledger', bytes: expect.any(Number) });
    expect(JSON.stringify(list.data)).not.toMatch(/Wrecked|Original|tokenId|token_id|authorUserId/);
    expect((await callTool(mcp, 'get_page_history', { campaignId, pageId: page.data.id, before: edit.data.revision, limit: 1 })).data.map((r: { revision: number }) => r.revision)).toEqual([page.data.revision]);
    const old = await callTool(mcp, 'get_page_history', { campaignId, pageId: page.data.id, revision: page.data.revision });
    expect(old.markdown).toContain('Original text.');
    expect(old.data).toMatchObject({ revision: page.data.revision, type: 'generic', properties: {} });

    const undone = await callTool(mcp, 'restore_page_version', { campaignId, pageId: page.data.id, revision: page.data.revision, currentRevision: edit.data.revision });
    expect(undone.data).toEqual({ id: page.data.id, title: 'Ledger', revision: edit.data.revision + 1, restored: true, warnings: [] });
    expect((await callTool(mcp, 'get_page', { campaignId, pageId: page.data.id })).markdown).toContain('Original text.');
    // A new row attributed to the assistant and its token; history is append-only
    const rows = rowsOf(page.data.id);
    expect(rows.map((r) => r.revision)).toEqual([page.data.revision, edit.data.revision, edit.data.revision + 1]);
    expect(rows.at(-1)).toMatchObject({ cause: 'restore', restoredFrom: page.data.revision, source: 'mcp', tokenId, authorUserId: dmId });
    // Restoring what is already there changes nothing
    const again = await callTool(mcp, 'restore_page_version', { campaignId, pageId: page.data.id, revision: page.data.revision, currentRevision: edit.data.revision + 1 });
    expect(again.data).toMatchObject({ restored: false, revision: edit.data.revision + 1 });
    expect(rowsOf(page.data.id)).toHaveLength(3);
  });

  it('refuses a stale revision, bad ids and bad revisions, and changes nothing', async () => {
    const page = await callTool(mcp, 'create_page', { campaignId, title: 'Stale', markdown: 'One.' });
    await callTool(mcp, 'update_page', { campaignId, pageId: page.data.id, markdown: 'Two.', revision: page.data.revision });
    const before = rowsOf(page.data.id).length;
    const stale = await callTool(mcp, 'restore_page_version', { campaignId, pageId: page.data.id, revision: page.data.revision, currentRevision: page.data.revision });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('read it again');
    expect(rowsOf(page.data.id)).toHaveLength(before);
    expect((await callTool(mcp, 'get_page', { campaignId, pageId: page.data.id })).markdown).toContain('Two.');
    expect((await callTool(mcp, 'get_page_history', { campaignId, pageId: page.data.id, revision: 9999 })).isError).toBe(true);
    expect((await callTool(mcp, 'get_page_history', { campaignId, pageId: 'nope' })).isError).toBe(true);
    expect((await callTool(mcp, 'get_page_history', { campaignId: 'nope', pageId: page.data.id })).isError).toBe(true);
    expect((await callTool(mcp, 'restore_page_version', { campaignId, pageId: 'nope', revision: 1, currentRevision: 1 })).isError).toBe(true);
    expect((await callTool(mcp, 'restore_page_version', { campaignId, pageId: page.data.id, revision: 9999, currentRevision: page.data.revision + 1 })).isError).toBe(true);
    // Not integers: refused by the tool schema. An id that tries to change the path is encoded and finds no page.
    for (const args of [{ revision: 1.5 }, { revision: '1/../x' }, { currentRevision: 'x' }]) {
      const res = await mcp.callTool({ name: 'restore_page_version', arguments: { campaignId, pageId: page.data.id, revision: 1, currentRevision: 1, ...args } });
      expect(res.isError).toBe(true);
    }
    expect((await callTool(mcp, 'get_page_history', { campaignId, pageId: `${page.data.id}/../${page.data.id}` })).isError).toBe(true);
    expect(rowsOf(page.data.id)).toHaveLength(before);
    // The API client behind the tools refuses everything else about history
    const api = new Api(app, { userId: dmId, scope: 'write' });
    for (const [m, u] of [['DELETE', hist(page.data.id)], ['DELETE', `${hist(page.data.id)}/1`], ['DELETE', `${base()}/pages/${page.data.id}/purge`], ['PUT', `${hist(page.data.id)}/1`]] as const)
      await expect(api.request(m, u)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('Not available') });
  });

  it('keeps a read token from restoring, and refuses players and outsiders', async () => {
    const page = await callTool(mcp, 'create_page', { campaignId, title: 'Guarded', visibility: 'all', markdown: 'Public.' });
    await callTool(mcp, 'update_page', { campaignId, pageId: page.data.id, markdown: 'Public 2.', revision: page.data.revision });
    const revision = page.data.revision + 1;
    // A read token sees history but has no restore tool, and the REST layer refuses its POST
    const reader = await mcpClient(app, await makeToken(dm, 'read'));
    expect((await callTool(reader, 'get_page_history', { campaignId, pageId: page.data.id })).isError).toBe(false);
    expect((await reader.listTools()).tools.map((t) => t.name)).not.toContain('restore_page_version');
    await expect(new Api(app, { userId: dmId, scope: 'read' }).post(`${hist(page.data.id)}/${page.data.revision}/restore`, { revision })).rejects.toMatchObject({ status: 403 });

    // A player (write token), and a user who belongs to another campaign only
    const player = await mcpClient(app, await makeToken((await join('player', 'hana')).client));
    const otherCampaign = ((await dm.post('/api/campaigns', { name: 'Elsewhere', ruleset: '2014' })).body as { id: string }).id;
    const invite = (await dm.post(`/api/campaigns/${otherCampaign}/invites`, { role: 'player' })).body as { token: string };
    const stranger = new TestClient(app);
    await stranger.post('/api/auth/register', { token: invite.token, username: 'otto', displayName: 'otto', password: 'a long enough password' });
    const outsider = await mcpClient(app, await makeToken(stranger));
    const before = rowsOf(page.data.id).length;
    for (const [who, client] of [['player', player], ['outsider', outsider]] as const) {
      for (const args of [{}, { revision: page.data.revision }]) expect([who, (await callTool(client, 'get_page_history', { campaignId, pageId: page.data.id, ...args })).isError]).toEqual([who, true]);
      const restore = await callTool(client, 'restore_page_version', { campaignId, pageId: page.data.id, revision: page.data.revision, currentRevision: revision });
      expect([who, restore.isError]).toEqual([who, true]);
    }
    expect(rowsOf(page.data.id)).toHaveLength(before);
    expect(((await dm.get(`${base()}/pages/${page.data.id}`)).body as { revision: number }).revision).toBe(revision);
  });

  it('works for a co-DM token and stops when the co-DM is demoted', async () => {
    const co = await join('codm', 'ivo');
    const token = await mcpClient(app, await makeToken(co.client));
    const page = await callTool(mcp, 'create_page', { campaignId, title: 'Shared GM', markdown: 'A.' });
    await callTool(mcp, 'update_page', { campaignId, pageId: page.data.id, markdown: 'B.', revision: page.data.revision });
    const list = await callTool(token, 'get_page_history', { campaignId, pageId: page.data.id });
    expect(list.isError).toBe(false);
    expect(list.data).toHaveLength(2);
    expect((await callTool(token, 'restore_page_version', { campaignId, pageId: page.data.id, revision: page.data.revision, currentRevision: page.data.revision + 1 })).data.restored).toBe(true);
    expect((await dm.patch(`${base()}/members/${co.userId}`, { role: 'player' })).status).toBe(200);
    expect((await callTool(token, 'get_page_history', { campaignId, pageId: page.data.id })).isError).toBe(true);
  });
});
