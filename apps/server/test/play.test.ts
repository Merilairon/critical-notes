import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, createSignedInApp, type Fixture, type TestClient } from './helpers';

let fx: Fixture;
let dm: TestClient;
let campaignId: string;
const base = () => `/api/campaigns/${campaignId}`;
let aria: string;
let bram: string;

/** Reads server-sent events until `count` events arrived (then cancels the stream). */
async function readEvents(res: Response, count: number): Promise<{ event: string; data: unknown }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: { event: string; data: unknown }[] = [];
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let ix: number;
    while ((ix = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, ix);
      buffer = buffer.slice(ix + 2);
      const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(chunk)?.[1] ?? '';
      if (event !== 'ping') events.push({ event, data: JSON.parse(data) });
    }
  }
  await reader.cancel();
  return events;
}

beforeAll(async () => {
  fx = await createFixture();
  dm = (await createSignedInApp(fx)).client;
  campaignId = (await dm.post('/api/campaigns', { name: 'Combat', ruleset: '2014' })).body.id;
  aria = (await dm.post(`${base()}/pages`, { type: 'pc', title: 'Aria', facet: { classes: [{ classUid: 'class:fighter|tst', level: 3 }], hpMax: 28, hpCurrent: 20, ac: 17, abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 } } })).body.id;
  bram = (await dm.post(`${base()}/pages`, { type: 'pc', title: 'Bram', facet: { classes: [{ classUid: 'class:fighter|tst', level: 2 }], hpMax: 18, ac: 12 } })).body.id;
}, 30_000);
afterAll(() => fx.cleanup());

describe('encounters', () => {
  it('resolves monsters, NPC statblocks and custom creatures, and the party levels', async () => {
    const npc = (await dm.post(`${base()}/pages`, { type: 'npc', title: 'Grizzled Scout', facet: { statblockUid: 'monster:gloomling|tst' } })).body;
    const res = await dm.post(`${base()}/encounters`, {
      name: 'Bridge ambush',
      creatures: [
        { id: 'a', kind: 'monster', uid: 'monster:gloomling|tst', count: 3 },
        { id: 'b', kind: 'npc', pageId: npc.id },
        { id: 'c', kind: 'custom', name: 'Swarm of bats', xp: 50, hp: 22, ac: 12, hidden: true },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.partyLevels).toEqual([3, 2]);
    expect(res.body.resolved).toEqual([
      { id: 'a', name: 'Gloomling', uid: 'monster:gloomling|tst', cr: '1/4', xp: 50, hasLairXp: false, hp: 7, ac: null, initBonus: 2, missing: false },
      { id: 'b', name: 'Grizzled Scout', uid: 'monster:gloomling|tst', cr: '1/4', xp: 50, hasLairXp: false, hp: 7, ac: null, initBonus: 2, missing: false },
      { id: 'c', name: 'Swarm of bats', uid: null, cr: null, xp: 50, hasLairXp: false, hp: 22, ac: 12, initBonus: 0, missing: false },
    ]);
    const custom = await dm.patch(`${base()}/encounters/${res.body.id}`, { party: { mode: 'custom', levels: [5, 5, 5, 5] } });
    expect(custom.body.partyLevels).toEqual([5, 5, 5, 5]);
    expect((await dm.get(`${base()}/encounters`)).body.encounters).toEqual([expect.objectContaining({ name: 'Bridge ambush', creatureCount: 5 })]);
  });
});

describe('initiative tracker', () => {
  let trackerId: string;

  it('starts from an encounter with numbered creatures and the party', async () => {
    const enc = (await dm.post(`${base()}/encounters`, {
      name: 'Gloom nest',
      creatures: [{ id: 'a', kind: 'monster', uid: 'monster:gloomling|tst', count: 2 }, { id: 'b', kind: 'custom', name: 'Lurker', hp: 30, hidden: true }],
    })).body;
    const res = await dm.post(`${base()}/encounters/${enc.id}/start`, {});
    expect(res.status).toBe(201);
    trackerId = res.body.id;
    const combatants = res.body.state.combatants as { name: string; kind: string; hp: number | null; initiative: number | null; hidden: boolean }[];
    expect(combatants.map((c) => c.name).sort()).toEqual(['Aria', 'Bram', 'Gloomling 1', 'Gloomling 2', 'Lurker']);
    expect(combatants.find((c) => c.name === 'Aria')).toMatchObject({ kind: 'pc', hp: 20, initiative: null });
    expect(combatants.filter((c) => c.kind !== 'pc').every((c) => typeof c.initiative === 'number')).toBe(true);
  });

  it('applies actions in order and ends combat by writing PC hit points back', async () => {
    const state = (await dm.get(`${base()}/trackers/${trackerId}`)).body.state;
    const id = (n: string) => state.combatants.find((c: { name: string }) => c.name === n).id;
    const act = (a: object) => dm.post(`${base()}/trackers/${trackerId}/actions`, a);
    await act({ type: 'update', id: id('Aria'), patch: { initiative: 25 } });
    const started = (await act({ type: 'start' })).body;
    expect(started.state.activeId).toBe(id('Aria'));
    await act({ type: 'hp', id: id('Aria'), change: -6 });
    expect((await act({ type: 'hp', id: id('Gloomling 1'), change: -100 })).body.state.combatants.find((c: { name: string }) => c.name === 'Gloomling 1').hp).toBe(0);
    expect((await act({ type: 'hp', id: 'nope', change: 1.5 })).status).toBe(400);
    const ended = await act({ type: 'end' });
    expect(ended.body.status).toBe('ended');
    expect((await dm.get(`${base()}/pages/${aria}`)).body.facet.hpCurrent).toBe(14);
    expect((await act({ type: 'next' })).status).toBe(400);
  });

  it('streams live updates; the player stream never contains hidden combatants or notes', async () => {
    const t = (await dm.post(`${base()}/trackers`, {
      name: 'Live',
      combatants: [
        { kind: 'pc', ref: bram, name: 'Bram', hpMax: 18, initiative: 12 },
        { kind: 'monster', name: 'SENTINEL-HIDDEN-BEAST', hpMax: 40, hidden: true, initiative: 20 },
      ],
    })).body;
    const headers = { cookie: dm.cookie, origin: 'http://localhost', host: 'localhost' };
    const playerRes = await dm.app.request(`http://localhost${base()}/trackers/${t.id}/events?view=player`, { headers });
    expect(playerRes.headers.get('content-type')).toContain('text/event-stream');
    expect(playerRes.headers.get('content-encoding')).toBeNull();
    const dmRes = await dm.app.request(`http://localhost${base()}/trackers/${t.id}/events?view=dm`, { headers });
    const playerEvents = readEvents(playerRes, 2);
    const dmEvents = readEvents(dmRes, 2);
    const beast = t.state.combatants.find((c: { hidden: boolean }) => c.hidden).id;
    await new Promise((r) => setTimeout(r, 20));
    await dm.post(`${base()}/trackers/${t.id}/actions`, { type: 'update', id: beast, patch: { notes: 'SENTINEL-NOTE' } });
    const p = await playerEvents;
    const d = await dmEvents;
    expect(p.map((e) => e.event)).toEqual(['state', 'state']);
    expect(JSON.stringify(p)).not.toMatch(/SENTINEL/);
    expect((p[1]!.data as { combatants: { name: string }[] }).combatants.map((c) => c.name)).toEqual(['Bram']);
    expect(JSON.stringify(d[1]!.data)).toContain('SENTINEL-NOTE');
  });
});

describe('inventory and loot', () => {
  it('awards a loot block once, stacks items and records the session', async () => {
    const session = (await dm.post(`${base()}/pages`, { type: 'session', title: 'Session 3' })).body;
    const award = (extra: object = {}) =>
      dm.post(`${base()}/loot/award`, {
        pageId: session.id,
        blockId: 'loot1',
        items: [{ uid: 'item:glow stone|tst', qty: 2 }, { name: 'Silver locket', qty: 1 }],
        coins: { gp: 50, sp: 12 },
        ...extra,
      });
    const res = await award();
    expect(res.status).toBe(200);
    expect(res.body.coins.party).toEqual({ cp: 0, sp: 12, ep: 0, gp: 50, pp: 0 });
    expect(res.body.items.map((i: { name: string; quantity: number; sessionPageId: string }) => [i.name, i.quantity, i.sessionPageId])).toEqual([
      ['Glow Stone', 2, session.id],
      ['Silver locket', 1, session.id],
    ]);
    expect((await award()).status).toBe(409);
    const again = await award({ again: true });
    expect(again.body.items.find((i: { name: string }) => i.name === 'Glow Stone').quantity).toBe(4);
    expect(again.body.owners.map((o: { name: string }) => o.name)).toEqual(['Party', 'Aria', 'Bram']);
  });

  it('limits attunement to three items per character and never lets coins go negative', async () => {
    const add = async (name: string) => (await dm.post(`${base()}/inventory/items`, { ownerPageId: aria, name })).body.id as string;
    const ids = [await add('Ring A'), await add('Ring B'), await add('Ring C'), await add('Ring D')];
    for (const id of ids.slice(0, 3)) expect((await dm.patch(`${base()}/inventory/items/${id}`, { attuned: true })).status).toBe(200);
    const fourth = await dm.patch(`${base()}/inventory/items/${ids[3]}`, { attuned: true });
    expect(fourth.status).toBe(400);
    expect(fourth.body.error).toMatch(/at most 3/);
    // Handing an attuned item to someone else ends the attunement
    expect((await dm.patch(`${base()}/inventory/items/${ids[0]}`, { ownerPageId: bram })).body.item).toMatchObject({ ownerPageId: bram, attuned: false });
    expect((await dm.patch(`${base()}/inventory/items/${ids[3]}`, { attuned: true })).status).toBe(200);
    expect((await dm.post(`${base()}/inventory/items`, { name: 'Pebble' })).body.ownerPageId).toBeNull();
    expect((await dm.patch(`${base()}/inventory/items/${ids[1]}`, { quantity: 0 })).body.item).toBeNull();

    expect((await dm.post(`${base()}/inventory/coins`, { change: { gp: -150 } })).status).toBe(400);
    expect((await dm.post(`${base()}/inventory/coins`, { change: { gp: -60, pp: 0 }, ownerPageId: aria })).body.error).toMatch(/Not enough gp/);
    expect((await dm.post(`${base()}/inventory/coins`, { change: { gp: -40 } })).body.coins.gp).toBe(60); // 2 × 50 awarded
  });
});

describe('encounter blocks for players', () => {
  it('are left out of the player projection of a page', async () => {
    const page = (await dm.post(`${base()}/pages`, { title: 'Prep', visibility: 'all' })).body;
    await dm.patch(`${base()}/pages/${page.id}`, {
      revision: 1,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Visible' }] }, { type: 'encounter', attrs: { encounterId: 'enc-secret' } }] },
    });
    const view = await dm.get(`${base()}/pages/${page.id}?as=player`);
    expect(JSON.stringify(view.body.body)).not.toContain('enc-secret');
    expect(JSON.stringify(view.body.body)).toContain('Visible');
  });
});
