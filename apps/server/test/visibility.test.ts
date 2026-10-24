import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, createSignedInApp, TestClient, type Fixture, type TestApp } from './helpers';
import { openEvents } from './events-helpers';
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

  // A deleted page: the trash is GM only
  await create('trashed', { title: 'SENTINEL trashed page', visibility: 'all', body: doc(para('SENTINEL trashed body')) });
  expect((await dm.delete(`${base()}/pages/${ids['trashed']}`)).status).toBe(200);

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
  const deletedTpl = await dm.post('/api/templates', { kind: 'block', scope: 'campaign', campaignId, name: 'SENTINEL deleted template', definition: { content: [para('x')] } });
  await dm.delete(`/api/templates/${deletedTpl.body.id}`);
  const tracker = await dm.post(`${base()}/trackers`, {
    name: 'Fight',
    combatants: [
      { kind: 'pc', ref: ids['pc'], name: 'Pat the Brave', hpMax: 20, notes: 'SENTINEL combat note' },
      { kind: 'monster', name: 'SENTINEL lurker', hpMax: 30, hidden: true, deathSaves: true },
      {
        kind: 'monster',
        name: 'Wyrm',
        hpMax: 100,
        deathSaves: true,
        legendary: { perRound: 3 },
        resistance: { max: 3 },
        recharge: [{ name: 'SENTINEL breath', min: 5 }],
      },
    ],
  });
  ids['tracker'] = tracker.body.id;
  // Tracker rules (I3): death saves, a readied action, recharge, a hidden lair row, the delay move
  const act = async (action: object) => expect((await dm.post(`${base()}/trackers/${ids['tracker']}/actions`, action)).status).toBe(200);
  const cs = (tracker.body.state.combatants as { id: string; name: string }[]);
  const idOf = (n: string) => cs.find((c) => c.name === n)!.id;
  await act({ type: 'hp', id: idOf('SENTINEL lurker'), change: -30 });
  await act({ type: 'deathSave', id: idOf('SENTINEL lurker'), roll: 3 });
  await act({ type: 'hp', id: idOf('Wyrm'), change: -100 });
  await act({ type: 'ready', id: idOf('Wyrm'), trigger: 'SENTINEL wyrm trigger' });
  await act({ type: 'ready', id: idOf('SENTINEL lurker'), trigger: 'SENTINEL lurker trigger' });
  await act({ type: 'legendarySpend', id: idOf('Wyrm') });
  await act({ type: 'legendaryResist', id: idOf('Wyrm') });
  await act({ type: 'rechargeUsed', id: idOf('Wyrm'), name: 'SENTINEL breath' });
  await act({ type: 'setInLair', id: idOf('Wyrm'), inLair: true });
  await act({ type: 'lairAdd', name: 'SENTINEL lair', ref: 'SENTINEL group', markInLair: [idOf('Wyrm')] });
  await act({ type: 'update', id: idOf('Pat the Brave'), patch: { initiative: 12 } });
  await act({ type: 'moveAfter', id: idOf('Wyrm'), afterId: idOf('Pat the Brave') });
  await act({ type: 'hp', id: idOf('Pat the Brave'), change: -20 });
  await act({ type: 'deathSave', id: idOf('Pat the Brave'), roll: 4 });

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
    // The trash is for the GM: players are refused, even for a page that was visible to them
    expect((await get(`${base()}/trash`)).status).toBe(403);
    expect((await player.delete(`${base()}/pages/${ids['trashed']}/purge`)).status).toBe(403);
    expect((await get(`${base()}/pages/${ids['trashed']}`)).status).toBe(404);
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
    await get('/api/templates/trash');
    await get(`/api/templates/trash?campaignId=${campaignId}`);
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
    const trash = await read('list_trash', { campaignId });
    expect(trash.isError).toBe(true);
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
    expect(view.combatants.map((c: { name: string }) => c.name)).toEqual(['Pat the Brave', 'Wyrm']);
    // Death saves show for the player's character; a visible monster shows none of its tracker data
    const [pat, wyrm] = view.combatants;
    expect(pat.dying).toEqual({ successes: 0, failures: 1, status: 'dying' });
    expect(wyrm).toEqual({ id: wyrm.id, name: 'Wyrm', kind: 'monster', initiative: 12, hp: null, health: 'down', conditions: [], dying: null, readied: null });
    expect(JSON.stringify(view)).not.toMatch(/legendary|resistance|recharge|inLair|tieRank|SENTINEL|trigger/i);
  });

  it('keeps tracker rule data out of the player event stream and the DM-only rolls out of player events', async () => {
    const url = `http://localhost${base()}/trackers/${ids['tracker']}/events?view=player`;
    const stream = await player.app.request(url, { headers: { cookie: player.cookie, origin: 'http://localhost', host: 'localhost' } });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // the snapshot
    const wyrm = (await dm.get(`${base()}/trackers/${ids['tracker']}`)).body.state.combatants.find((c: { name: string }) => c.name === 'Wyrm').id;
    // Heal the wyrm and cycle the turns until it acts, so its spent breath rolls
    const res = await dm.post(`${base()}/trackers/${ids['tracker']}/actions`, { type: 'legendaryResist', id: wyrm, undo: true });
    expect(res.status).toBe(200);
    const event = decoder.decode((await reader.read()).value);
    await reader.cancel();
    expect(event).toContain('event: state');
    expect(event).not.toMatch(SENTINEL);
    expect(event).not.toMatch(/legendary|resistance|recharge|rolls|inLair|tieRank/i);
  });

  it('sends recharge rolls to the DM only', async () => {
    const tid = ids['tracker'];
    const state = (await dm.get(`${base()}/trackers/${tid}`)).body.state as { combatants: { id: string; name: string }[] };
    const wyrm = state.combatants.find((c) => c.name === 'Wyrm')!.id;
    const stream = await player.app.request(`http://localhost${base()}/trackers/${tid}/events?view=player`, { headers: { cookie: player.cookie, origin: 'http://localhost', host: 'localhost' } });
    const reader = stream.body!.getReader();
    await reader.read(); // the snapshot
    // The breath is spent: the wyrm's turn rolls it, the DM response carries the roll
    const actions = [{ type: 'start' }, { type: 'next' }, { type: 'next' }, { type: 'next' }];
    const rolls: { combatantId: string; name: string; min: number }[] = [];
    const events: string[] = [];
    for (const action of actions) {
      const res = await dm.post(`${base()}/trackers/${tid}/actions`, action);
      expect(res.status).toBe(200);
      rolls.push(...(res.body.rolls ?? []));
      events.push(new TextDecoder().decode((await reader.read()).value));
    }
    await reader.cancel();
    expect(rolls).toHaveLength(1);
    expect(rolls[0]).toMatchObject({ combatantId: wyrm, name: 'SENTINEL breath', min: 5 });
    expect(events.join('')).not.toMatch(/SENTINEL|roll|breath/i);
    expect(JSON.stringify((await player.get(`${base()}/trackers/${tid}/player`)).body)).not.toMatch(/SENTINEL|roll/i);
  });

  it('counts only the pages the viewer may see in the campaign list and in list_campaigns', async () => {
    const countIn = (list: { id: string; pageCount: number }[]) => list.find((c) => c.id === campaignId)!.pageCount;
    const visibleToPlayer = (await player.get(`${base()}/pages`)).body.pages.length as number;
    const live = (await dm.get(`${base()}/pages`)).body.pages.length as number;
    expect(live).toBeGreaterThan(visibleToPlayer); // the sentinel hidden pages exist
    const playerList = (await player.get('/api/campaigns')).body.campaigns;
    const dmList = (await dm.get('/api/campaigns')).body.campaigns;
    expect(countIn(playerList)).toBe(visibleToPlayer);
    expect(countIn(dmList)).toBe(live);
    const pages = async (client: TestClient) => {
      const res = await callTool(await mcpClient(app, await makeToken(client, 'read')), 'list_campaigns');
      return (res.data as { id: string; pages: number }[]).find((c) => c.id === campaignId)!.pages;
    };
    expect(await pages(player)).toBe(visibleToPlayer);
    expect(await pages(dm)).toBe(live);
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

  it('keeps a DM-only child when the player saves its callout without content', async () => {
    const callout = { type: 'callout', content: [para('Shared tip'), para('SENTINEL callout dm child', { visibility: 'dm' })] };
    const before = (await dm.get(`${base()}/pages/${ids['pc']}`)).body;
    expect((await dm.patch(`${base()}/pages/${ids['pc']}`, { revision: before.revision, body: { ...before.body, content: [...before.body.content, callout] } })).status).toBe(200);
    const mine = (await player.get(`${base()}/pages/${ids['pc']}`)).body;
    const content = mine.body.content.map((b: { type: string }) => {
      if (b.type !== 'callout') return b;
      const { content: _gone, ...bare } = b as Record<string, unknown>;
      return bare;
    });
    const res = await player.patch(`${base()}/pages/${ids['pc']}`, { revision: mine.revision, body: { ...mine.body, content } });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(SENTINEL);
    expect(JSON.stringify((await dm.get(`${base()}/pages/${ids['pc']}`)).body.body)).toContain('SENTINEL callout dm child');
  });

  it('keeps the DM’s link to a hidden page when the player edits another paragraph', async () => {
    const link = { type: 'paragraph', content: [{ type: 'text', text: 'Owes a favour to ' }, { type: 'pageLink', attrs: { pageId: ids['hidden'], label: 'a stranger' } }] };
    const before = (await dm.get(`${base()}/pages/${ids['pc']}`)).body;
    expect((await dm.patch(`${base()}/pages/${ids['pc']}`, { revision: before.revision, body: { ...before.body, content: [...before.body.content, link, para('Second wind')] } })).status).toBe(200);

    const mine = (await player.get(`${base()}/pages/${ids['pc']}`)).body;
    expect(JSON.stringify(mine.body)).not.toContain(ids['hidden']);
    const content = mine.body.content.map((b: { content?: { text?: string }[] }) => (b.content?.[0]?.text === 'Second wind' ? para('Second wind (edited)') : b));
    const res = await player.patch(`${base()}/pages/${ids['pc']}`, { revision: mine.revision, body: { ...mine.body, content } });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(ids['hidden']);

    const asDm = (await dm.get(`${base()}/pages/${ids['pc']}`)).body;
    expect(JSON.stringify(asDm.body)).toContain('Second wind (edited)');
    expect(JSON.stringify(asDm.body)).toContain(`"pageId":"${ids['hidden']}"`);
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

describe('sentinel crawl: the event stream', () => {
  it('tells a player nothing about what stays hidden, and exactly what became visible to them', async () => {
    const dmId = (await dm.get('/api/auth/me')).body.user.id as string;
    /** Saves the DM's raw version of a page after `change` rewrote its blocks (block ids are kept). */
    const edit = async (key: string, change: (content: Record<string, unknown>[]) => Record<string, unknown>[] | void, extra: object = {}) => {
      const page = (await dm.get(`${base()}/pages/${ids[key]}`)).body;
      const content = structuredClone(page.body.content as Record<string, unknown>[]);
      const res = await dm.patch(`${base()}/pages/${ids[key]}`, { revision: page.revision, body: { type: 'doc', content: change(content) ?? content }, ...extra });
      expect(res.status).toBe(200);
    };
    const secretBlock = { type: 'secret', attrs: { id: 'crawl-secret' }, content: [para('SENTINEL text of the new secret', { id: 'crawl-secret-child' })] };

    const { res, reader } = await openEvents(app, player, campaignId);
    expect(res.status).toBe(200);
    await reader.until((f) => f.event === 'hello');

    // Writes on everything hidden: none of it may produce a frame for the player
    await edit('hidden', (c) => void c.push(para('SENTINEL more hidden text'), { type: 'secret', attrs: { id: 'hidden-secret', revealed: true }, content: [para('SENTINEL revealed on a hidden page')] }));
    await edit('selectedOther', (c) => void c.push(para('SENTINEL for somebody else')), { title: 'SENTINEL selected, retitled', viewers: [dmId] });
    await edit('spy', (c) => void c.push(para('SENTINEL spy notes')), { title: 'SENTINEL spy, retitled' });
    await edit('town', (c) => void c.push(para('SENTINEL fresh DM paragraph', { id: 'crawl-dm', visibility: 'dm' }), secretBlock));
    await edit('childOfHidden', (c) => void c.push(para('A visible edit')));
    const hiddenNew = (await dm.post(`${base()}/pages`, { title: 'SENTINEL brand new hidden page', visibility: 'dm', body: doc(para('SENTINEL body')) })).body.id as string;
    const nobody = (await dm.post(`${base()}/pages`, { title: 'SENTINEL for nobody', visibility: 'selected' })).body.id as string;
    expect(nobody).toBeTruthy();
    // Nothing yet
    expect((await reader.settle(300)).map((f) => f.event)).toEqual(['hello']);

    // What the player is entitled to: a page shared with everyone, and a block revealed on a page they can read
    const handout = (await dm.post(`${base()}/pages`, { title: 'SENTINEL handout title', visibility: 'dm' })).body.id as string;
    const shared = await dm.patch(`${base()}/pages/${handout}`, { revision: 1, visibility: 'all' });
    expect(shared.status).toBe(200);
    await edit('town', (c) => {
      const b = c.find((n) => (n['attrs'] as { id?: string }).id === 'crawl-secret') as { attrs: Record<string, unknown> };
      b.attrs['revealed'] = true;
    });

    const frames = await reader.settle(3000);
    await reader.cancel();
    const wire = frames.map((f) => f.raw).join('\n\n');
    expect(wire).not.toMatch(SENTINEL);
    // No hidden page id anywhere, not even without a marker string
    for (const key of ['hidden', 'selectedOther', 'trashed', 'spy', 'pc', 'ring']) if (ids[key]) expect(wire).not.toContain(ids[key]);
    for (const hiddenId of [hiddenNew, nobody]) expect(wire).not.toContain(hiddenId);
    expect(wire).not.toContain('hidden-secret');
    // Exactly the expected events, and an `id:` only on those
    expect(frames.map((f) => [f.event, JSON.parse(f.data)])).toEqual([
      ['hello', { replayed: false }],
      ['page-shared', { pageId: handout }],
      ['block-revealed', { pageId: ids['town'], blockIds: ['crawl-secret'] }],
    ]);
    expect(frames.filter((f) => f.id).map((f) => f.event)).toEqual(['page-shared', 'block-revealed']);
    expect(reader.frames.filter((f) => f.id === undefined).every((f) => ['hello', 'ping'].includes(f.event))).toBe(true);
  }, 20_000);
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
