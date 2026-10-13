import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, createSignedInApp, TestClient, type Fixture, type TestApp } from './helpers';
import { callTool, makeToken, mcpClient } from './mcp-client';
import { UNIDENTIFIED_ITEM_NAME, type InventoryDto } from '@cn/shared';

/**
 * Players must never receive DM-only content. The sentinel crawl seeds a marker string into every place a DM
 * can hide something, then requests everything a player can reach and checks the marker never appears.
 */
const SENTINEL = /sentinel/i;

let fx: Fixture;
let app: TestApp;
let dm: TestClient;
let player: TestClient;
let playerId: string;
let campaignId: string;
const base = () => `/api/campaigns/${campaignId}`;
const para = (text: string, attrs: Record<string, unknown> = {}) => ({ type: 'paragraph', attrs, content: [{ type: 'text', text }] });
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const ids: Record<string, string> = {};

async function join(token: string, username: string): Promise<{ client: TestClient; userId: string }> {
  const client = new TestClient(app);
  const res = await client.post('/api/auth/register', { token, username, displayName: username, password: 'a long enough password' });
  expect(res.status).toBe(201);
  const me = await client.get('/api/auth/me');
  return { client, userId: me.body.user.id };
}

async function invite(role: 'player' | 'codm' = 'player', extra: object = {}) {
  const res = await dm.post(`${base()}/invites`, { role, ...extra });
  expect(res.status).toBe(201);
  return res.body.token as string;
}

beforeAll(async () => {
  fx = await createFixture();
  ({ app, client: dm } = await createSignedInApp(fx));
  campaignId = (await dm.post('/api/campaigns', { name: 'Secrets', ruleset: '2014' })).body.id;
  ({ client: player, userId: playerId } = await join(await invite(), 'pat'));

  const create = async (key: string, body: object) => {
    const res = await dm.post(`${base()}/pages`, body);
    expect(res.status).toBe(201);
    ids[key] = res.body.id;
    return res.body;
  };
  const patch = async (key: string, body: object) => {
    const page = (await dm.get(`${base()}/pages/${ids[key]}`)).body;
    const res = await dm.patch(`${base()}/pages/${ids[key]}`, { revision: page.revision, ...body });
    expect(res.status).toBe(200);
  };

  // Hidden pages of every kind
  await create('hidden', { title: 'SENTINEL hidden page', visibility: 'dm', body: doc(para('SENTINEL hidden body')) });
  await create('selectedOther', { title: 'SENTINEL selected for nobody', visibility: 'selected' });
  await create('selectedMe', { title: 'Letter for Pat', visibility: 'selected' });
  await patch('selectedMe', { viewers: [playerId] });
  await create('childOfHidden', { title: 'Cellar', visibility: 'all', parentId: ids['hidden'] });

  const enc = await dm.post(`${base()}/encounters`, { name: 'SENTINEL ambush', creatures: [{ id: 'a', kind: 'custom', name: 'SENTINEL brute', xp: 100 }] });

  // A shared page full of things players must not get
  await dm.post(`${base()}/properties`, { label: 'Secret motive', type: 'text', dmOnly: true });
  await dm.post(`${base()}/properties`, { label: 'Mood', type: 'text' });
  await create('town', { title: 'Town', visibility: 'all' });
  await patch('town', {
    props: { secret_motive: 'SENTINEL motive', mood: 'calm' },
    body: doc(
      para('Welcome to town.'),
      para('SENTINEL dm paragraph', { visibility: 'dm' }),
      { type: 'secret', content: [para('SENTINEL unrevealed secret')] },
      { type: 'secret', attrs: { revealed: true }, content: [para('The mayor is kind')] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Behind ' }, { type: 'pageLink', attrs: { pageId: ids['hidden'], label: 'a door' } }] },
      { type: 'pageEmbed', attrs: { pageId: ids['hidden'] } },
      { type: 'encounter', attrs: { encounterId: enc.body.id } },
      { type: 'callout', content: [para('Visible tip'), para('SENTINEL nested dm', { visibility: 'dm' })] },
    ),
  });

  // An NPC whose statblock is the DM's own homebrew
  await create('npc', { type: 'npc', title: 'Grik', visibility: 'all' });
  const clone = await dm.post(`${base()}/npc-statblocks`, { pageId: ids['npc'], baseUid: 'monster:gloomling|tst', name: 'Sentinel Grik' });
  expect(clone.status).toBe(201);

  // The player's character, with a DM note on it
  await create('pc', { type: 'pc', title: 'Pat the Brave', visibility: 'dm', facet: { playerUserId: playerId } });
  await patch('pc', { body: doc(para('My backstory'), para('SENTINEL dm note about Pat', { visibility: 'dm' })) });

  // House rules, a campaign template, a tracker
  await dm.patch(base(), { houseRules: doc(para('Flanking is on.'), para('SENTINEL house secret', { visibility: 'dm' })) });
  await dm.post('/api/templates', { kind: 'block', scope: 'campaign', campaignId, name: 'SENTINEL template', definition: { content: [para('x')] } });
  const tracker = await dm.post(`${base()}/trackers`, {
    name: 'Fight',
    combatants: [
      { kind: 'pc', ref: ids['pc'], name: 'Pat the Brave', hpMax: 20, notes: 'SENTINEL combat note' },
      { kind: 'monster', name: 'SENTINEL lurker', hpMax: 30, hidden: true },
    ],
  });
  ids['tracker'] = tracker.body.id;

  // Belongings: an item nobody has identified yet, and a character the players don't know about
  const ring = await dm.post(`${base()}/inventory/items`, { ownerPageId: null, name: 'SENTINEL ring of lies', notes: 'SENTINEL cursed' });
  ids['ring'] = ring.body.id;
  expect((await dm.patch(`${base()}/inventory/items/${ids['ring']}`, { identified: false })).status).toBe(200);
  // (played by the DM, so the members list would name it)
  const dmId = (await dm.get('/api/auth/me')).body.user.id;
  await create('spy', { type: 'pc', title: 'SENTINEL spy', visibility: 'dm', facet: { playerUserId: dmId } });
  await dm.post(`${base()}/inventory/items`, { ownerPageId: ids['spy'], name: 'SENTINEL poison' });
  await dm.post(`${base()}/inventory/coins`, { ownerPageId: ids['spy'], change: { pp: 7 } });
}, 60_000);
afterAll(() => fx.cleanup());

describe('sentinel crawl: nothing DM-only reaches a player', () => {
  it('finds no marker in anything a player can request', async () => {
    const bodies: string[] = [];
    // Only what the server answers counts (the requests themselves may search for the marker)
    const paths: string[] = [];
    const get = async (path: string) => {
      const res = await player.get(path);
      paths.push(path);
      bodies.push(typeof res.body === 'string' ? res.body : JSON.stringify(res.body));
      return res;
    };
    const post = async (path: string, body: unknown) => {
      const res = await player.post(path, body);
      paths.push(path);
      bodies.push(JSON.stringify(res.body));
      return res;
    };

    await get('/api/campaigns');
    const campaign = await get(base());
    expect(campaign.body.role).toBe('player');
    const tree = (await get(`${base()}/pages`)).body.pages as { id: string; parentId: string | null }[];
    for (const p of tree) {
      await get(`${base()}/pages/${p.id}`);
      await get(`${base()}/pages/${p.id}/backlinks`);
    }
    for (const type of ['npc', 'pc', 'location', 'generic']) await get(`${base()}/pages?type=${type}`);
    // Pages a player cannot see answer like pages that do not exist
    for (const key of ['hidden', 'selectedOther']) {
      expect((await get(`${base()}/pages/${ids[key]}`)).status).toBe(404);
      expect((await get(`${base()}/pages/${ids[key]}/backlinks`)).status).toBe(404);
    }
    await post(`${base()}/query`, { filter: {} });
    await post(`${base()}/query`, { filter: { where: [{ field: 'facet.statblockUid', op: 'exists' }] } });
    await post(`${base()}/query`, { filter: { where: [{ field: 'props.secret_motive', op: 'exists' }] } });
    for (const q of ['sentinel', 'door', 'town', 'secret', 'motive']) await get(`${base()}/search?q=${q}`);
    await get(`${base()}/properties`);
    await get(`${base()}/members`);
    await get(`${base()}/inventory`);
    const active = (await get(`${base()}/trackers/active`)).body.trackers as { id: string }[];
    for (const t of active) {
      await get(`${base()}/trackers/${t.id}/player`);
      const stream = await player.app.request(`http://localhost${base()}/trackers/${t.id}/events?view=player`, { headers: { cookie: player.cookie, origin: 'http://localhost', host: 'localhost' } });
      const reader = stream.body!.getReader();
      const first = await reader.read();
      await reader.cancel();
      paths.push('events');
      bodies.push(new TextDecoder().decode(first.value));
    }
    for (const q of ['sentinel', 'grik']) {
      await get(`/api/reference/search?q=${q}&campaignId=${campaignId}`);
      await get(`/api/reference/autocomplete/monster?q=${q}&campaignId=${campaignId}`);
    }
    await get(`/api/reference/kinds/monster?campaignId=${campaignId}`);
    await get(`/api/reference/sources?campaignId=${campaignId}`);
    await get(`/api/templates?campaignId=${campaignId}`);
    await get('/api/homebrew/sources');
    // DM-only areas refuse
    for (const path of [`${base()}/encounters`, `${base()}/invites`, `${base()}/trackers/${ids['tracker']}`, `${base()}/template-defaults`, `${base()}/trackers/${ids['tracker']}/events?view=dm`]) {
      expect([path, (await get(path)).status]).toEqual([path, 403]);
    }

    const leaks = bodies.map((b, i) => `${paths[i]} → ${b}`.slice(0, 600)).filter((_, i) => SENTINEL.test(bodies[i]!));
    expect(leaks).toEqual([]);
    expect(bodies.length).toBeGreaterThan(40);
  });

  it("finds no marker in anything a player's AI assistant can read", async () => {
    const mcp = await mcpClient(app, await makeToken(player, 'write'));
    const outputs: string[] = [];
    const read = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await callTool(mcp, name, args);
      outputs.push(`${name} ${JSON.stringify(args)} → ${res.text}`);
      return res;
    };
    await read('list_campaigns');
    const campaign = await read('get_campaign', { campaignId });
    expect(campaign.data.yourRole).toBe('player');
    for (const page of campaign.data.pages as { id: string }[]) await read('get_page', { campaignId, pageId: page.id });
    for (const key of ['hidden', 'selectedOther']) expect((await read('get_page', { campaignId, pageId: ids[key] })).isError).toBe(true);
    for (const query of ['sentinel', 'door', 'secret', 'motive']) await read('search_pages', { campaignId, query });
    for (const type of ['npc', 'pc', 'location', 'generic']) await read('search_pages', { campaignId, type });
    await read('get_inventory', { campaignId });
    for (const query of ['sentinel', 'grik']) await read('search_rules', { campaignId, query });
    const sources = await read('list_homebrew');
    for (const source of sources.data as { id: string }[]) await read('list_homebrew', { sourceId: source.id });
    const templates = await read('list_templates', { campaignId });
    for (const tpl of templates.data as { id: string }[]) await read('get_template', { templateId: tpl.id });
    expect((await read('list_encounters', { campaignId })).isError).toBe(true);
    const tools = (await mcp.listTools()).tools;
    outputs.push(JSON.stringify(tools));

    const leaks = outputs.filter((o) => SENTINEL.test(o.slice(o.indexOf('→'))));
    expect(leaks.map((l) => l.slice(0, 600))).toEqual([]);
    expect(outputs.length).toBeGreaterThan(20);
  });

  it('still shows players what is meant for them', async () => {
    const tree = (await player.get(`${base()}/pages`)).body.pages as { id: string; title: string; parentId: string | null }[];
    expect(tree.map((p) => p.title).sort()).toEqual(['Cellar', 'Grik', 'Letter for Pat', 'Pat the Brave', 'Town']);
    expect(tree.find((p) => p.title === 'Cellar')!.parentId).toBeNull(); // its parent is hidden
    const town = (await player.get(`${base()}/pages/${ids['town']}`)).body;
    const text = JSON.stringify(town.body);
    expect(text).toContain('Welcome to town.');
    expect(text).toContain('The mayor is kind');
    expect(text).toContain('Visible tip');
    expect(town.body.content.find((b: { content?: { text?: string }[] }) => b.content?.[0]?.text === 'Behind ').content).toEqual([
      { type: 'text', text: 'Behind ' },
      { type: 'text', text: 'a door' },
    ]);
    expect(town.props).toEqual({ mood: 'calm' });
    expect((await player.get(`${base()}/pages/${ids['npc']}`)).body.facet).not.toHaveProperty('statblockUid');
    expect((await player.get(`${base()}/properties`)).body.properties.map((p: { key: string }) => p.key)).toEqual(['mood']);
    const view = (await player.get(`${base()}/trackers/${ids['tracker']}/player`)).body;
    expect(view.combatants.map((c: { name: string }) => c.name)).toEqual(['Pat the Brave']);
  });

  it('shows the DM everything (the projection is for players only)', async () => {
    const town = (await dm.get(`${base()}/pages/${ids['town']}`)).body;
    expect(JSON.stringify(town)).toContain('SENTINEL dm paragraph');
    expect(town.props.secret_motive).toBe('SENTINEL motive');
  });
});

describe('what players may change', () => {
  it('edits their own character without losing the DM’s hidden notes', async () => {
    const mine = (await player.get(`${base()}/pages/${ids['pc']}`)).body;
    expect(JSON.stringify(mine.body)).not.toMatch(SENTINEL);
    const res = await player.patch(`${base()}/pages/${ids['pc']}`, {
      revision: mine.revision,
      body: { ...mine.body, content: [...mine.body.content, para('I found a sword.')] },
      facet: { hpCurrent: 9 },
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(SENTINEL);
    const asDm = (await dm.get(`${base()}/pages/${ids['pc']}`)).body;
    const lines = JSON.stringify(asDm.body);
    expect(lines).toContain('SENTINEL dm note about Pat');
    expect(lines).toContain('I found a sword.');
    expect(asDm.facet.hpCurrent).toBe(9);
  });

  it('cannot edit other pages, change visibility, or reassign characters', async () => {
    const town = (await player.get(`${base()}/pages/${ids['town']}`)).body;
    expect((await player.patch(`${base()}/pages/${ids['town']}`, { revision: town.revision, title: 'Mine' })).status).toBe(403);
    expect((await player.patch(`${base()}/pages/${ids['hidden']}`, { revision: 1, title: 'Mine' })).status).toBe(404);
    const mine = (await player.get(`${base()}/pages/${ids['pc']}`)).body;
    expect((await player.patch(`${base()}/pages/${ids['pc']}`, { revision: mine.revision, visibility: 'all' })).status).toBe(400);
    expect((await player.patch(`${base()}/pages/${ids['pc']}`, { revision: mine.revision, facet: { playerUserId: null } })).status).toBe(400);
    expect((await player.patch(`${base()}/pages/${ids['pc']}`, { revision: mine.revision, props: { secret_motive: 'x' } })).status).toBe(400);
    expect((await player.delete(`${base()}/pages/${ids['pc']}`)).status).toBe(403);
    expect((await player.post(`${base()}/pages/${ids['pc']}/move`, { parentId: null })).status).toBe(403);
    expect((await player.post(`${base()}/properties`, { label: 'X', type: 'text' })).status).toBe(403);
  });

  it('manages only their own character’s belongings', async () => {
    const own = await player.post(`${base()}/inventory/items`, { ownerPageId: ids['pc'], name: 'Lucky coin' });
    expect(own.status).toBe(201);
    expect((await player.post(`${base()}/inventory/items`, { ownerPageId: null, name: 'Party loot' })).status).toBe(403);
    expect((await player.post(`${base()}/inventory/coins`, { ownerPageId: ids['pc'], change: { gp: 5 } })).status).toBe(200);
    expect((await player.post(`${base()}/inventory/coins`, { ownerPageId: null, change: { gp: 5 } })).status).toBe(403);
    // Giving it to the party is fine; taking it back is not
    expect((await player.patch(`${base()}/inventory/items/${own.body.id}`, { ownerPageId: null })).status).toBe(200);
    expect((await player.patch(`${base()}/inventory/items/${own.body.id}`, { ownerPageId: ids['pc'] })).status).toBe(403);
  });

  it('sees unidentified items only as such, and cannot identify them', async () => {
    const inv = (await player.get(`${base()}/inventory`)).body as InventoryDto;
    expect(inv.items.find((i) => i.id === ids['ring'])).toMatchObject({ name: UNIDENTIFIED_ITEM_NAME, itemUid: null, notes: '' });
    expect(inv.owners.map((o) => o.pageId)).toEqual([null, ids['pc']]);
    expect(Object.keys(inv.coins)).not.toContain(ids['spy']);
    // Handed to the player's character, it is theirs to carry but still not theirs to identify or rename
    expect((await dm.patch(`${base()}/inventory/items/${ids['ring']}`, { ownerPageId: ids['pc'] })).status).toBe(200);
    const moved = await player.patch(`${base()}/inventory/items/${ids['ring']}`, { quantity: 1 });
    expect(moved.status).toBe(200);
    expect(moved.body.item.name).toBe(UNIDENTIFIED_ITEM_NAME);
    expect((await player.patch(`${base()}/inventory/items/${ids['ring']}`, { identified: true })).status).toBe(403);
    expect((await player.patch(`${base()}/inventory/items/${ids['ring']}`, { name: 'Plain ring' })).status).toBe(403);
    expect((await dm.get(`${base()}/inventory`)).body.items.find((i: { id: string }) => i.id === ids['ring']).name).toBe('SENTINEL ring of lies');
  });
});

describe('invites and members', () => {
  it('refuses used up, expired and withdrawn invites, and only the owner invites co-DMs', async () => {
    const once = await invite('player', { maxUses: 1 });
    await join(once, 'quinn');
    const info = await new TestClient(app).get(`/api/invites/${once}`);
    expect(info.body).toMatchObject({ campaignName: 'Secrets', valid: false, reason: 'This invite has been used up' });
    const anon = new TestClient(app);
    expect((await anon.post('/api/auth/register', { token: once, username: 'robin', displayName: 'Robin', password: 'a long enough password' })).status).toBe(400);

    const count = (await dm.get(`${base()}/invites`)).body.invites.length;
    const created = (await dm.post(`${base()}/invites`, { role: 'player' })).body;
    expect((await dm.get(`${base()}/invites`)).body.invites).toHaveLength(count + 1);
    await dm.delete(`${base()}/invites/${created.invite.id}`);
    expect((await anon.get(`/api/invites/${created.token}`)).body.reason).toBe('This invite was withdrawn');
    expect((await anon.get('/api/invites/not-a-real-token-at-all')).status).toBe(404);

    expect((await player.post(`${base()}/invites`, { role: 'player' })).status).toBe(403);
    const coToken = await invite('codm');
    const { client: co } = await join(coToken, 'cody');
    expect((await co.get(`${base()}/encounters`)).status).toBe(200); // co-DMs are game masters
    expect((await co.post(`${base()}/invites`, { role: 'codm' })).status).toBe(403);
    expect((await co.post(`${base()}/invites`, { role: 'player' })).status).toBe(201);
  });

  it('lets an existing user join with a link, and the owner manage roles', async () => {
    const token = await invite();
    const other = (await join(await invite(), 'sam')).client;
    expect((await other.post(`/api/invites/${token}/accept`)).body.campaignId).toBe(campaignId);
    const members = (await dm.get(`${base()}/members`)).body.members as { userId: string; displayName: string; role: string; characters: { title: string }[] }[];
    expect(members[0]!.role).toBe('dm');
    expect(members.find((m) => m.displayName === 'pat')!.characters.map((c) => c.title)).toEqual(['Pat the Brave']);
    const sam = members.find((m) => m.displayName === 'sam')!;
    expect((await player.patch(`${base()}/members/${sam.userId}`, { role: 'codm' })).status).toBe(403);
    expect((await dm.patch(`${base()}/members/${sam.userId}`, { role: 'codm' })).status).toBe(200);
    expect((await other.get(`${base()}/encounters`)).status).toBe(200);
    // Leaving unassigns characters; the owner cannot leave
    expect((await player.delete(`${base()}/members/${playerId}`)).status).toBe(204);
    expect((await dm.get(`${base()}/pages/${ids['pc']}`)).body.facet.playerUserId).toBeNull();
    expect((await player.get(base())).status).toBe(404);
    const me = (await dm.get('/api/auth/me')).body.user.id;
    expect((await dm.delete(`${base()}/members/${me}`)).status).toBe(400);
  });
});
