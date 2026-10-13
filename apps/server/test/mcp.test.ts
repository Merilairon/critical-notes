import { eq } from 'drizzle-orm';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiTokens } from '../src/db/schema';
import { hashToken, internalAuth } from '../src/auth/session';
import { Api } from '../src/mcp/api';
import { createFixture, createSignedInApp, TestClient, type Fixture, type TestApp } from './helpers';
import { callTool, makeToken, mcpClient } from './mcp-client';

let fx: Fixture;
let app: TestApp;
let dm: TestClient;
let services: Awaited<ReturnType<typeof createSignedInApp>>['services'];
let mcp: Client;
let campaignId: string;
const base = () => `/api/campaigns/${campaignId}`;

beforeAll(async () => {
  fx = await createFixture();
  ({ app, client: dm, services } = await createSignedInApp(fx));
  services.templates.upsertBuiltins();
  campaignId = ((await dm.post('/api/campaigns', { name: 'Phandalin', ruleset: '2014' })).body as { id: string }).id;
  mcp = await mcpClient(app, await makeToken(dm));
});
afterAll(() => fx.cleanup());

describe('API tokens', () => {
  it('are shown once, stored as a hash, listed and revoked', async () => {
    const res = await dm.post('/api/auth/tokens', { name: 'Claude', scope: 'read', expiresInDays: null });
    expect(res.status).toBe(201);
    const { token, id } = res.body as { token: string; id: string };
    expect(token).toMatch(/^cn_[\w-]{43}$/);
    const row = fx.db.select().from(apiTokens).where(eq(apiTokens.id, id)).get()!;
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const list = (await dm.get('/api/auth/tokens')).body as { tokens: { id: string; token?: string; expiresAt: number | null }[] };
    expect(list.tokens.find((t) => t.id === id)).toMatchObject({ expiresAt: null });
    expect(JSON.stringify(list)).not.toContain(token);
    expect((await dm.delete(`/api/auth/tokens/${id}`)).status).toBe(204);
    expect((await dm.get('/api/auth/tokens')).body).not.toMatchObject({ tokens: [expect.objectContaining({ id })] });
    await expect(mcpClient(app, token)).rejects.toThrow();
  });

  it('only open /mcp, never the REST API', async () => {
    const token = await makeToken(dm);
    const viaApi = await app.request('http://localhost/api/campaigns', { headers: { authorization: `Bearer ${token}` } });
    expect(viaApi.status).toBe(401);
    const noToken = await app.request('http://localhost/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get('www-authenticate')).toContain('Bearer');
    const crossSite = await app.request('http://localhost/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(crossSite.status).toBe(403);
  });

  it('stop working when they expire', async () => {
    const token = await makeToken(dm);
    fx.db.update(apiTokens).set({ expiresAt: Date.now() - 1 }).where(eq(apiTokens.tokenHash, hashToken(token))).run();
    await expect(mcpClient(app, token)).rejects.toThrow();
  });

  it('cannot manage tokens, and read tokens cannot write', async () => {
    const userId = ((await dm.get('/api/auth/me')).body as { user: { id: string } }).user.id;
    const reader = new Api(app, { userId, scope: 'read' });
    await expect(reader.post(`${base()}/pages`, { title: 'X' })).rejects.toMatchObject({ status: 403 });
    await expect(reader.get('/api/auth/tokens' as never)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('Not available') });
    // Even a write token's own calls cannot reach the token routes
    const res = await app.request('http://internal/api/auth/tokens', {}, internalAuth({ userId, scope: 'write' }));
    expect(res.status).toBe(403);
  });

  it('read tokens get the read tools only', async () => {
    const reader = await mcpClient(app, await makeToken(dm, 'read'));
    const names = (await reader.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_campaigns', 'get_campaign', 'get_page', 'search_rules', 'get_inventory', 'list_templates']));
    expect(names.some((n) => /^(create|update|delete|save|add|remove|change|restore)_/.test(n))).toBe(false);
    const writer = (await mcp.listTools()).tools;
    expect(writer.find((t) => t.name === 'delete_page')?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(writer.find((t) => t.name === 'get_page')?.annotations).toMatchObject({ readOnlyHint: true });
  });
});

describe('pages through MCP', () => {
  let tavernId: string;
  let npcId: string;

  it('finds the campaign and the rules', async () => {
    const campaigns = await callTool(mcp, 'list_campaigns');
    expect(campaigns.data).toEqual([expect.objectContaining({ id: campaignId, name: 'Phandalin', role: 'dm' })]);
    const rules = await callTool(mcp, 'search_rules', { campaignId, query: 'gloomling' });
    expect(rules.data[0]).toMatchObject({ uid: 'monster:gloomling|tst', tag: '{@creature Gloomling|TST}' });
    const campaign = await callTool(mcp, 'get_campaign', { campaignId });
    expect(campaign.data.pageTypes.npc.details).toMatchObject({ status: 'one of: alive, dead, missing, unknown', factionPageId: 'Faction page: id or exact title' });
  });

  it('creates pages from Markdown, with details and properties', async () => {
    await dm.post(`${base()}/properties`, { label: 'Mood', type: 'select', options: ['calm', 'tense'] });
    const tavern = await callTool(mcp, 'create_page', { campaignId, title: 'Stonehill Inn', type: 'location', visibility: 'all', details: { kind: 'site' } });
    expect(tavern.isError).toBe(false);
    tavernId = tavern.data.id;
    const npc = await callTool(mcp, 'create_page', {
      campaignId,
      title: 'Toblen',
      type: 'npc',
      parent: 'Stonehill Inn',
      details: { status: 'alive', locationPageId: 'Stonehill Inn' },
      properties: { mood: 'tense' },
      markdown: 'Runs [[Stonehill Inn]]. Fears {@creature Gloomling|TST}.\n\n:::secret\nHe pays the **Redbrands**.\n:::\n\n[[Nowhere]]',
    });
    expect(npc.data.warnings).toEqual(['No page "Nowhere" to link; it was kept as text']);
    npcId = npc.data.id;
    const page = (await dm.get(`${base()}/pages/${npcId}`)).body as { parentId: string; facet: Record<string, unknown>; props: Record<string, unknown>; body: { content: { type: string }[] } };
    expect(page.parentId).toBe(tavernId);
    expect(page.facet).toMatchObject({ status: 'alive', locationPageId: tavernId });
    expect(page.props).toEqual({ mood: 'tense' });
    expect(page.body.content.map((b) => b.type)).toEqual(['paragraph', 'secret', 'paragraph']);
    expect(JSON.stringify(page.body)).toContain('"type":"pageLink"');
    expect(JSON.stringify(page.body)).toContain('{@creature Gloomling|TST}');
  });

  it('reads a page as Markdown and edits it without losing what Markdown cannot show', async () => {
    // An encounter block (shown as a placeholder line) added in the editor
    const stored = (await dm.get(`${base()}/pages/${npcId}`)).body as { revision: number; body: { content: unknown[] } };
    await dm.patch(`${base()}/pages/${npcId}`, { revision: stored.revision, body: { type: 'doc', content: [...stored.body.content, { type: 'encounter', attrs: { id: 'enc1', encounterId: null } }] } });
    const page = await callTool(mcp, 'get_page', { campaignId, pageId: npcId });
    expect(page.data).toMatchObject({ title: 'Toblen', type: 'npc', parent: 'Stonehill Inn', properties: { mood: 'tense' } });
    expect(page.markdown).toContain('Runs [[Stonehill Inn]]. Fears {@creature Gloomling|TST}.');
    expect(page.markdown).toContain(':::secret\nHe pays the **Redbrands**.\n:::');
    expect(page.markdown).toContain('<!-- cn:block enc1 encounter');

    const edited = await callTool(mcp, 'update_page', { campaignId, pageId: npcId, edits: [{ find: 'the **Redbrands**', replace: 'the **Zhentarim**' }], title: 'Toblen Stonehill' });
    expect(edited.isError).toBe(false);
    const after = (await dm.get(`${base()}/pages/${npcId}`)).body as { title: string; body: { content: { type: string; attrs?: { id?: string } }[] } };
    expect(after.title).toBe('Toblen Stonehill');
    expect(JSON.stringify(after.body)).toContain('Zhentarim');
    expect(after.body.content.find((b) => b.type === 'encounter')?.attrs?.id).toBe('enc1');

    // A whole new text against an old revision is refused
    const stale = await callTool(mcp, 'update_page', { campaignId, pageId: npcId, revision: page.data.revision, markdown: 'Gone' });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('read it again');
    const ambiguous = await callTool(mcp, 'update_page', { campaignId, pageId: npcId, edits: [{ find: 'e', replace: 'E' }] });
    expect(ambiguous.text).toContain('more than once');
  });

  it('moves, deletes and restores pages', async () => {
    const moved = await callTool(mcp, 'update_page', { campaignId, pageId: npcId, parent: '' });
    expect(moved.isError).toBe(false);
    expect(((await dm.get(`${base()}/pages/${npcId}`)).body as { parentId: string | null }).parentId).toBeNull();
    const child = await callTool(mcp, 'create_page', { campaignId, title: 'Cellar', parent: tavernId });
    const deleted = await callTool(mcp, 'delete_page', { campaignId, pageId: tavernId });
    expect(deleted.data.deleted).toEqual([tavernId, child.data.id]);
    expect((await dm.get(`${base()}/pages/${child.data.id}`)).status).toBe(404);
    const restored = await callTool(mcp, 'restore_page', { campaignId, pageId: tavernId });
    expect(restored.data.restored).toEqual([tavernId, child.data.id]);
    expect(((await dm.get(`${base()}/pages/${child.data.id}`)).body as { parentId: string }).parentId).toBe(tavernId);
  });

  it('creates a page from a template', async () => {
    const templates = await callTool(mcp, 'list_templates', { campaignId, kind: 'page' });
    const settlement = templates.data.find((t: { name: string }) => t.name === 'Settlement');
    const page = await callTool(mcp, 'create_page', { campaignId, title: 'Phandalin', templateId: settlement.id, templateValues: { population: '500' }, markdown: 'Added by the assistant.' });
    expect(page.isError).toBe(false);
    const body = JSON.stringify(((await dm.get(`${base()}/pages/${page.data.id}`)).body as { body: unknown }).body);
    expect(body).toContain('500');
    expect(body).toContain('Added by the assistant.');
  });
});

describe('encounters, inventory, homebrew and templates through MCP', () => {
  it('plans an encounter with its difficulty', async () => {
    await dm.post(`${base()}/pages`, { type: 'pc', title: 'Aria', facet: { classes: [{ classUid: 'class:fighter|tst', level: 2 }] } });
    const created = await callTool(mcp, 'create_encounter', {
      campaignId,
      name: 'Ambush',
      creatures: [{ kind: 'monster', uid: 'monster:gloomling|tst', count: 3 }, { kind: 'custom', name: 'Shadow', xp: 200, hidden: true }],
      party: { mode: 'custom', levels: [3, 3] },
    });
    expect(created.isError).toBe(false);
    expect(created.data.creatures).toEqual([expect.objectContaining({ name: 'Gloomling', count: 3 }), expect.objectContaining({ name: 'Shadow', hidden: true })]);
    expect(typeof created.data.difficulty).toBe('string');
    const updated = await callTool(mcp, 'update_encounter', { campaignId, encounterId: created.data.id, name: 'Night ambush' });
    expect(updated.data.creatures).toHaveLength(2);
    const list = await callTool(mcp, 'list_encounters', { campaignId });
    // 3 gloomlings and the shadow
    expect(list.data).toEqual([expect.objectContaining({ name: 'Night ambush', creatures: 4 })]);
    expect((await callTool(mcp, 'delete_encounter', { campaignId, encounterId: created.data.id })).isError).toBe(false);
  });

  it('manages the inventory', async () => {
    const item = await callTool(mcp, 'add_inventory_item', { campaignId, name: 'Rope', quantity: 2 });
    await callTool(mcp, 'update_inventory_item', { campaignId, itemId: item.data.id, quantity: 5, owner: 'Aria' });
    await callTool(mcp, 'change_coins', { campaignId, owner: 'Aria', gp: 12 });
    const spend = await callTool(mcp, 'change_coins', { campaignId, owner: 'Aria', gp: -20 });
    expect(spend.isError).toBe(true);
    const inv = await callTool(mcp, 'get_inventory', { campaignId });
    const aria = inv.data.find((o: { owner: { name?: string } }) => o.owner.name === 'Aria');
    expect(aria).toMatchObject({ coins: { gp: 12 }, items: [expect.objectContaining({ name: 'Rope', quantity: 5 })] });
    expect((await callTool(mcp, 'remove_inventory_item', { campaignId, itemId: item.data.id })).isError).toBe(false);
  });

  it('writes homebrew, with validation', async () => {
    const source = await callTool(mcp, 'save_homebrew_source', { fullName: 'Misty Vale', abbreviation: 'MV', edition: 'any', shareWith: [campaignId] });
    expect(source.data).toMatchObject({ name: 'Misty Vale', sharedWith: ['Phandalin'] });
    const bad = await callTool(mcp, 'create_homebrew_entry', { sourceId: source.data.id, type: 'monster', data: { name: '' } });
    expect(bad.isError).toBe(true);
    const entry = await callTool(mcp, 'create_homebrew_entry', { sourceId: source.data.id, type: 'condition', data: { name: 'Mossy', entries: ['Covered in moss.'] } });
    expect(entry.data).toMatchObject({ name: 'Mossy', type: 'condition', revision: 1 });
    const read = await callTool(mcp, 'get_homebrew_entry', { entryId: entry.data.id });
    expect(read.data.data).toMatchObject({ name: 'Mossy', source: 'MistyVale' });
    const updated = await callTool(mcp, 'update_homebrew_entry', { entryId: entry.data.id, revision: 1, data: { name: 'Mossy', entries: ['Thick moss.'] } });
    expect(updated.data.revision).toBe(2);
    const stale = await callTool(mcp, 'update_homebrew_entry', { entryId: entry.data.id, revision: 1, data: { name: 'Mossy', entries: ['Old.'] } });
    expect(stale.text).toContain('revision 2');
    // It is in the campaign's rules now
    const rules = await callTool(mcp, 'search_rules', { campaignId, query: 'mossy' });
    expect(rules.data[0]).toMatchObject({ name: 'Mossy', tag: '{@condition Mossy|MistyVale}' });
    expect((await callTool(mcp, 'delete_homebrew_entry', { entryId: entry.data.id })).isError).toBe(false);
    expect((await callTool(mcp, 'restore_homebrew_entry', { entryId: entry.data.id })).data).toMatchObject({ name: 'Mossy' });
  });

  it('writes templates in Markdown', async () => {
    const created = await callTool(mcp, 'save_template', { kind: 'block', scope: 'user', name: 'Trap', markdown: 'A trap: DC {{dc: number = 12}}.\n\n:::secret\nDisarm with {{tool}}.\n:::' });
    expect(created.data.variables.map((v: { name: string }) => v.name)).toEqual(['dc', 'tool']);
    const read = await callTool(mcp, 'get_template', { templateId: created.data.id });
    expect(read.markdown).toBe('A trap: DC {{dc: number = 12}}.\n\n:::secret\nDisarm with {{tool}}.\n:::\n');
    const updated = await callTool(mcp, 'save_template', { templateId: created.data.id, version: read.data.version, markdown: read.markdown!.replace('12', '14') });
    expect(updated.data.version).toBe(read.data.version + 1);
    const builtin = (await callTool(mcp, 'list_templates', { kind: 'block' })).data.find((t: { scope: string }) => t.scope === 'global');
    expect((await callTool(mcp, 'save_template', { templateId: builtin.id, version: builtin.version, name: 'Mine' })).text).toContain('read-only');
    expect((await callTool(mcp, 'delete_template', { templateId: created.data.id })).isError).toBe(false);
  });
});

describe('players through MCP', () => {
  let player: Client;
  let pcId: string;

  beforeAll(async () => {
    const invite = (await dm.post(`${base()}/invites`, { role: 'player' })).body as { token: string };
    const client = new TestClient(app);
    await client.post('/api/auth/register', { token: invite.token, username: 'pia', displayName: 'Pia', password: 'a long enough password' });
    const userId = ((await client.get('/api/auth/me')).body as { user: { id: string } }).user.id;
    const pc = (await dm.post(`${base()}/pages`, {
      type: 'pc',
      title: 'Wren',
      facet: { playerUserId: userId },
      body: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'w1' }, content: [{ type: 'text', text: 'A bard.' }] }, { type: 'paragraph', attrs: { id: 'w2', visibility: 'dm' }, content: [{ type: 'text', text: 'Her sister lives.' }] }] },
    })).body as { id: string };
    pcId = pc.id;
    player = await mcpClient(app, await makeToken(client));
  });

  it('see only what is shared, and edit only their own character', async () => {
    const campaign = await callTool(player, 'get_campaign', { campaignId });
    const titles = campaign.data.pages.map((p: { title: string }) => p.title);
    expect(titles).toContain('Wren');
    expect(titles).not.toContain('Toblen Stonehill');
    const own = await callTool(player, 'get_page', { campaignId, pageId: pcId });
    expect(own.markdown).not.toContain('sister');
    const edit = await callTool(player, 'update_page', { campaignId, pageId: pcId, appendMarkdown: 'Owes the guild 40 gp.' });
    expect(edit.isError).toBe(false);
    const stored = (await dm.get(`${base()}/pages/${pcId}`)).body as { body: { content: { attrs: { id: string } }[] } };
    expect(stored.body.content.slice(0, 2).map((b) => b.attrs.id)).toEqual(['w1', 'w2']);
    expect(JSON.stringify(stored.body)).toContain('Owes the guild');
    expect((await callTool(player, 'create_page', { campaignId, title: 'Mine' })).isError).toBe(true);
    expect((await callTool(player, 'list_encounters', { campaignId })).isError).toBe(true);
  });
});
