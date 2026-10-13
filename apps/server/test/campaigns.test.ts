import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users, campaignMembers } from '../src/db/schema';
import { hashPassword } from '../src/lib/password';
import { createFixture, createSignedInApp, TestClient, type Fixture } from './helpers';

let fx: Fixture;
let dm: TestClient;
let other: TestClient;
let app: TestClient['app'];

beforeAll(async () => {
  fx = await createFixture();
  const created = await createSignedInApp(fx);
  dm = created.client;
  app = created.app;
  // A second user (accounts are created by invite in milestone h; insert directly here)
  fx.db.insert(users).values({ id: 'u2', username: 'eve', displayName: 'Eve', passwordHash: await hashPassword('another password'), isAdmin: false }).run();
  other = new TestClient(app);
  expect((await other.post('/api/auth/login', { username: 'eve', password: 'another password' })).status).toBe(200);
});
afterAll(() => fx.cleanup());

describe('auth', () => {
  it('reports the current user and blocks a second setup', async () => {
    const me = await dm.get('/api/auth/me');
    expect(me.body).toMatchObject({ user: { username: 'dm', isAdmin: true }, setupRequired: false });
    expect((await dm.post('/api/auth/setup', { username: 'x', displayName: 'X', password: 'password123' })).status).toBe(400);
  });

  it('rejects wrong passwords and rate limits', async () => {
    const anon = new TestClient(app);
    expect((await anon.post('/api/auth/login', { username: 'dm', password: 'nope' })).status).toBe(401);
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await anon.post('/api/auth/login', { username: 'dm', password: 'nope' })).status;
    expect(last).toBe(429);
  });

  it('rejects cross-origin and non-JSON mutations', async () => {
    const res = await app.request('http://localhost/api/campaigns', {
      method: 'POST',
      headers: { origin: 'https://evil.example', cookie: dm.cookie, 'content-type': 'application/json', host: 'localhost' },
      body: JSON.stringify({ name: 'x', ruleset: '2014' }),
    });
    expect(res.status).toBe(403);
    const form = await app.request('http://localhost/api/campaigns', {
      method: 'POST',
      headers: { cookie: dm.cookie, 'content-type': 'application/x-www-form-urlencoded', 'content-length': '20', host: 'localhost' },
      body: 'name=x&ruleset=2014',
    });
    expect(form.status).toBe(403);
  });

  it('logs out', async () => {
    const tmp = new TestClient(app);
    await tmp.post('/api/auth/login', { username: 'eve', password: 'another password' });
    expect((await tmp.get('/api/campaigns')).status).toBe(200);
    await tmp.post('/api/auth/logout');
    expect((await tmp.get('/api/campaigns')).status).toBe(401);
  });
});

describe('campaigns', () => {
  let campaignId: string;

  it('creates a campaign with a DM membership and a campaign homebrew source', async () => {
    const res = await dm.post('/api/campaigns', { name: 'Lost Mines', ruleset: '2014' });
    expect(res.status).toBe(201);
    campaignId = res.body.id;
    expect(res.body).toMatchObject({ name: 'Lost Mines', ruleset: '2014', role: 'dm', crossEdition: false });
    expect(res.body.campaignSourceId).toMatch(/^Camp[0-9a-f]{8}$/);
    expect((await dm.get('/api/campaigns')).body.campaigns).toHaveLength(1);
  });

  it('validates input', async () => {
    expect((await dm.post('/api/campaigns', { name: '', ruleset: '2014' })).status).toBe(400);
    expect((await dm.post('/api/campaigns', { name: 'X', ruleset: '3.5' })).status).toBe(400);
  });

  it('hides campaigns from non-members', async () => {
    expect((await other.get(`/api/campaigns/${campaignId}`)).status).toBe(404);
    expect((await other.get('/api/campaigns')).body.campaigns).toEqual([]);
    expect((await other.get(`/api/reference/kinds?campaignId=${campaignId}`)).status).toBe(404);
  });

  it('drives reference visibility from campaign settings', async () => {
    const spells = async () => ((await dm.get(`/api/reference/kinds/spell?campaignId=${campaignId}`)).body.items as { uid: string }[]).map((i) => i.uid);
    expect(await spells()).toEqual(['spell:ancient ward|old', 'spell:spark burst|tst']);
    await dm.patch(`/api/campaigns/${campaignId}`, { sourceOverrides: { OLD: false } });
    expect(await spells()).toEqual(['spell:spark burst|tst']);
    await dm.patch(`/api/campaigns/${campaignId}`, { sourceOverrides: { old: null } });
    expect(await spells()).toHaveLength(2);
    // Query params cannot override campaign rules
    expect((await dm.get(`/api/reference/kinds/spell?campaignId=${campaignId}&ruleset=2024`)).body.items).toHaveLength(2);
  });

  it('only DMs can change settings', async () => {
    fx.db.insert(campaignMembers).values({ campaignId, userId: 'u2', role: 'player' }).run();
    expect((await other.patch(`/api/campaigns/${campaignId}`, { name: 'Hacked' })).status).toBe(403);
    // Players get the page tree, but only pages shared with them (none yet)
    const tree = await other.get(`/api/campaigns/${campaignId}/pages`);
    expect([tree.status, tree.body.pages]).toEqual([200, []]);
    expect((await other.post(`/api/campaigns/${campaignId}/pages`, { title: 'Sneaky' })).status).toBe(403);
    fx.db.delete(campaignMembers).where(eq(campaignMembers.userId, 'u2')).run();
  });

  describe('pages and facets', () => {
    let npcId: string;
    let locationId: string;
    let factionId: string;

    it('creates typed pages with facet defaults and validates facet links', async () => {
      const loc = await dm.post(`/api/campaigns/${campaignId}/pages`, { type: 'location', title: 'Phandalin', facet: { kind: 'settlement' } });
      expect(loc.status).toBe(201);
      locationId = loc.body.id;
      expect(loc.body.facet).toMatchObject({ kind: 'settlement', parentLocationPageId: null });
      const fac = await dm.post(`/api/campaigns/${campaignId}/pages`, { type: 'faction', title: 'Redbrands' });
      factionId = fac.body.id;
      const npc = await dm.post(`/api/campaigns/${campaignId}/pages`, {
        type: 'npc',
        title: 'Glasstaff',
        parentId: locationId,
        tags: ['villain', 'wizard'],
        facet: { factionPageId: factionId, locationPageId: locationId, role: 'Leader' },
      });
      expect(npc.status).toBe(201);
      npcId = npc.body.id;
      expect(npc.body).toMatchObject({ type: 'npc', parentId: locationId, tags: ['villain', 'wizard'], revision: 1 });
      expect(npc.body.facet).toMatchObject({ status: 'alive', role: 'Leader', factionPageId: factionId });
      // a faction link must point at a faction page
      const bad = await dm.post(`/api/campaigns/${campaignId}/pages`, { type: 'npc', title: 'X', facet: { factionPageId: locationId } });
      expect(bad.status).toBe(400);
      expect((await dm.post(`/api/campaigns/${campaignId}/pages`, { type: 'npc', title: 'X', facet: { status: 'zombie' } })).status).toBe(400);
    });

    it('lists pages as a tree and by type with facets', async () => {
      const tree = (await dm.get(`/api/campaigns/${campaignId}/pages`)).body.pages;
      expect(tree.map((p: { title: string }) => p.title).sort()).toEqual(['Glasstaff', 'Phandalin', 'Redbrands']);
      const npcs = (await dm.get(`/api/campaigns/${campaignId}/pages?type=npc`)).body.pages;
      expect(npcs).toHaveLength(1);
      expect(npcs[0].facet.locationPageId).toBe(locationId);
      expect((await dm.get(`/api/campaigns/${campaignId}/pages?type=dragon`)).status).toBe(400);
    });

    it('updates with optimistic concurrency', async () => {
      const ok = await dm.patch(`/api/campaigns/${campaignId}/pages/${npcId}`, { revision: 1, title: 'Iarno Albrek', facet: { status: 'missing' }, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] } });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ title: 'Iarno Albrek', revision: 2 });
      expect(ok.body.facet).toMatchObject({ status: 'missing', role: 'Leader' }); // partial facet update merges
      const stale = await dm.patch(`/api/campaigns/${campaignId}/pages/${npcId}`, { revision: 1, title: 'Lost update' });
      expect(stale.status).toBe(409);
      expect(stale.body.details.current.title).toBe('Iarno Albrek');
    });

    it('changing the page type swaps the facet', async () => {
      const p = await dm.post(`/api/campaigns/${campaignId}/pages`, { type: 'generic', title: 'Session One' });
      const res = await dm.patch(`/api/campaigns/${campaignId}/pages/${p.body.id}`, { revision: 1, type: 'session', facet: { number: 1, date: '2026-10-08' } });
      expect(res.body).toMatchObject({ type: 'session', facet: { number: 1, date: '2026-10-08', status: 'planned' } });
    });

    it('moves pages with fractional keys and prevents cycles', async () => {
      const a = (await dm.post(`/api/campaigns/${campaignId}/pages`, { title: 'A' })).body;
      const b = (await dm.post(`/api/campaigns/${campaignId}/pages`, { title: 'B' })).body;
      const c = (await dm.post(`/api/campaigns/${campaignId}/pages`, { title: 'C' })).body;
      expect(a.sortKey < b.sortKey && b.sortKey < c.sortKey).toBe(true);
      const moved = await dm.post(`/api/campaigns/${campaignId}/pages/${c.id}/move`, { parentId: null, beforeId: a.id });
      expect(moved.body.sortKey < a.sortKey).toBe(true);
      await dm.post(`/api/campaigns/${campaignId}/pages/${b.id}/move`, { parentId: a.id });
      expect((await dm.post(`/api/campaigns/${campaignId}/pages/${a.id}/move`, { parentId: b.id })).status).toBe(400);
    });

    it('soft-deletes a subtree', async () => {
      const res = await dm.delete(`/api/campaigns/${campaignId}/pages/${locationId}`);
      expect(res.body.deleted).toEqual(expect.arrayContaining([locationId, npcId]));
      expect((await dm.get(`/api/campaigns/${campaignId}/pages/${npcId}`)).status).toBe(404);
    });
  });

  describe('NPC statblocks', () => {
    it('clones a bestiary statblock as campaign homebrew (_copy) and lets the DM customize it', async () => {
      const npc = (await dm.post(`/api/campaigns/${campaignId}/pages`, { type: 'npc', title: 'Grik' })).body;
      const res = await dm.post(`/api/campaigns/${campaignId}/npc-statblocks`, { pageId: npc.id, baseUid: 'monster:gloomling|tst' });
      expect(res.status).toBe(201);
      const campaign = (await dm.get(`/api/campaigns/${campaignId}`)).body;
      expect(res.body.uid).toBe(`monster:grik|${campaign.campaignSourceId.toLowerCase()}`);
      expect(res.body.page.facet).toMatchObject({ statblockUid: res.body.uid, statblockHomebrewEntityId: res.body.entityId });

      const entity = (await dm.get(`/api/reference/entities/${encodeURIComponent(res.body.uid)}?campaignId=${campaignId}`)).body;
      expect(entity).toMatchObject({ name: 'Grik', origin: 'homebrew', edition: 'any', visible: true });
      expect(entity.data.cr).toBe('1/4'); // inherited from the base statblock
      expect(entity.raw._copy).toEqual({ name: 'Gloomling', source: 'TST' });

      // Customize: rename + override CR; the NPC facet follows the new uid
      const raw = (await dm.get(`/api/campaigns/${campaignId}/homebrew/${res.body.entityId}`)).body;
      const upd = await dm.put(`/api/campaigns/${campaignId}/homebrew/${res.body.entityId}`, { data: { ...raw.data, name: 'Grik the Bold', cr: '2' } });
      expect(upd.body.revision).toBe(2);
      const page = (await dm.get(`/api/campaigns/${campaignId}/pages/${npc.id}`)).body;
      expect(page.facet.statblockUid).toBe(upd.body.uid);
      const renamed = (await dm.get(`/api/reference/entities/${encodeURIComponent(upd.body.uid)}?campaignId=${campaignId}`)).body;
      expect(renamed.data.cr).toBe('2');
      // The old uid is an alias now, so existing {@creature Grik|…} tags keep working
      expect((await dm.get(`/api/reference/entities/${encodeURIComponent(res.body.uid)}?campaignId=${campaignId}`)).body.name).toBe('Grik the Bold');

      // Searchable inside the campaign only
      const hits = (await dm.get(`/api/reference/search?q=grik&campaignId=${campaignId}`)).body.hits;
      expect(hits.map((h: { uid: string }) => h.uid)).toEqual([upd.body.uid]);
    });

    it('campaign homebrew is invisible outside its campaign', async () => {
      const second = (await dm.post('/api/campaigns', { name: 'Other', ruleset: '2014' })).body;
      expect((await dm.get(`/api/reference/search?q=grik&campaignId=${second.id}`)).body.hits).toEqual([]);
      expect((await dm.get('/api/reference/search?q=grik&ruleset=2014')).body.hits).toEqual([]);
      const sources = (await dm.get(`/api/reference/sources?campaignId=${second.id}`)).body.sources as { origin: string; id: string }[];
      expect(sources.filter((s) => s.origin === 'homebrew').map((s) => s.id)).toEqual([second.campaignSourceId]);
    });

    it('rejects non-monster bases and non-NPC pages', async () => {
      const loc = (await dm.post(`/api/campaigns/${campaignId}/pages`, { type: 'location', title: 'Cave' })).body;
      expect((await dm.post(`/api/campaigns/${campaignId}/npc-statblocks`, { pageId: loc.id, baseUid: 'monster:gloomling|tst' })).status).toBe(400);
      const npc = (await dm.post(`/api/campaigns/${campaignId}/pages`, { type: 'npc', title: 'Bob' })).body;
      expect((await dm.post(`/api/campaigns/${campaignId}/npc-statblocks`, { pageId: npc.id, baseUid: 'spell:spark burst|tst' })).status).toBe(400);
    });
  });
});
