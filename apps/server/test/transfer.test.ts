import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, createSignedInApp, testImage, type Fixture, type TestApp, type TestClient } from './helpers';

let fx: Fixture;
let app: TestApp;
let dm: TestClient;
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const text = (t: string) => ({ type: 'text', text: t });

async function request(path: string, init: RequestInit = {}) {
  return app.request(`http://localhost${path}`, { ...init, headers: { cookie: dm.cookie, origin: 'http://localhost', host: 'localhost', ...(init.headers ?? {}) } });
}

async function importZip(bytes: Uint8Array) {
  const form = new FormData();
  form.append('file', new File([bytes], 'campaign.zip', { type: 'application/zip' }));
  const res = await request('/api/campaigns/import', { method: 'POST', body: form });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  fx = await createFixture();
  ({ app, client: dm } = await createSignedInApp(fx));
}, 30_000);
afterAll(() => fx.cleanup());

describe('edition migration', () => {
  let campaignId: string;
  let pageId: string;
  const base = () => `/api/campaigns/${campaignId}`;

  beforeAll(async () => {
    campaignId = (await dm.post('/api/campaigns', { name: 'Old rules', ruleset: '2014' })).body.id;
    const page = (await dm.post(`${base()}/pages`, { title: 'Prep' })).body;
    pageId = page.id;
    await dm.patch(`${base()}/pages/${pageId}`, {
      revision: 1,
      body: {
        type: 'doc',
        content: [
          para(text('Cast '), { type: 'tag', attrs: { markup: '{@spell spark burst|tst|the burst}' } }, text(' and {@spell ancient ward|old}.')),
          { type: 'refEmbed', attrs: { uid: 'condition:dazed|tst' } },
        ],
      },
    });
    await dm.post(`${base()}/pages`, { type: 'npc', title: 'Scout', facet: { statblockUid: 'monster:gloomling|tst' } });
    await dm.post(`${base()}/encounters`, { name: 'Gloom', creatures: [{ id: 'a', kind: 'monster', uid: 'monster:gloomling|tst', count: 2 }] });
    await dm.post(`${base()}/inventory/items`, { itemUid: 'item:shortblade|tst' });
    await dm.patch(base(), { sourceOverrides: { old: true } });
  });

  it('plans: what maps to the new edition, what stays, what cannot be mapped', async () => {
    const plan = (await dm.get(`${base()}/migrate-edition?to=2024`)).body;
    const byFrom = Object.fromEntries(plan.entries.map((e: { from: string; status: string; to: string | null }) => [e.from, [e.status, e.to]]));
    expect(byFrom).toEqual({
      'spell:spark burst|tst': ['mapped', 'spell:spark burst|xtst'],
      'spell:ancient ward|old': ['unmapped', null],
      'condition:dazed|tst': ['mapped', 'condition:dazed|xtst'],
      'monster:gloomling|tst': ['mapped', 'monster:gloomling scout|xtst'],
      'item:shortblade|tst': ['mapped', 'item:shortblade|xtst'],
    });
    expect(plan.entries[0].status).toBe('unmapped'); // problems first
    const gloomling = plan.entries.find((e: { from: string }) => e.from === 'monster:gloomling|tst');
    expect(gloomling.sites.map((s: { kind: string }) => s.kind).sort()).toEqual(['encounter', 'page']);
    expect((await dm.get(`${base()}/migrate-edition?to=2014`)).status).toBe(400);
  });

  it('applies: rewrites references (except those kept), switches the rules and resets source choices', async () => {
    const res = await dm.post(`${base()}/migrate-edition`, { to: '2024', keep: ['condition:dazed|tst'] });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(4);
    const page = (await dm.get(`${base()}/pages/${pageId}`)).body;
    expect(page.body.content[0].content[1].attrs.markup).toBe('{@spell Spark Burst|XTST|the burst}');
    expect(page.body.content[0].content[2].text).toBe(' and {@spell ancient ward|old}.');
    expect(page.body.content[1].attrs.uid).toBe('condition:dazed|tst');
    const npc = (await dm.get(`${base()}/pages?type=npc`)).body.pages[0];
    expect(npc.facet.statblockUid).toBe('monster:gloomling scout|xtst');
    const enc = (await dm.get(`${base()}/encounters`)).body.encounters[0];
    expect((await dm.get(`${base()}/encounters/${enc.id}`)).body.creatures[0].uid).toBe('monster:gloomling scout|xtst');
    expect((await dm.get(`${base()}/inventory`)).body.items[0].itemUid).toBe('item:shortblade|xtst');
    const campaign = (await dm.get(base())).body;
    expect([campaign.ruleset, campaign.sourceOverrides]).toEqual(['2024', {}]);
  });
});

describe('campaign export and import', () => {
  let sourceId: string;
  const ids: Record<string, string> = {};
  const base = () => `/api/campaigns/${sourceId}`;

  beforeAll(async () => {
    sourceId = (await dm.post('/api/campaigns', { name: 'Lost Mine', ruleset: '2014' })).body.id;
    const create = async (key: string, body: object) => (ids[key] = (await dm.post(`${base()}/pages`, body)).body.id);
    await create('town', { type: 'location', title: 'Phandalin', visibility: 'all' });
    await create('inn', { type: 'location', title: 'Stonehill Inn', parentId: ids['town'], facet: { parentLocationPageId: ids['town'] } });
    await create('npc', { type: 'npc', title: 'Toblen', facet: { locationPageId: ids['inn'] } });
    await create('pc', { type: 'pc', title: 'Aria' });
    await create('session', { type: 'session', title: 'Session 1' });
    await dm.post(`${base()}/npc-statblocks`, { pageId: ids['npc'], baseUid: 'monster:gloomling|tst', name: 'Toblen Stonehill' });
    await dm.post(`${base()}/properties`, { label: 'Owner', type: 'pageLink' });
    await dm.post(`${base()}/properties`, { label: 'Secret', type: 'text', dmOnly: true });

    const form = new FormData();
    form.append('file', new File([await testImage()], 'map.png', { type: 'image/png' }));
    const upload = (await (await request(`${base()}/uploads`, { method: 'POST', body: form })).json()) as { id: string };
    ids['upload'] = upload.id;

    const inn = (await dm.get(`${base()}/pages/${ids['inn']}`)).body;
    await dm.patch(`${base()}/pages/${ids['inn']}`, {
      revision: inn.revision,
      props: { owner: ids['npc'], secret: 'Smuggling' },
      body: {
        type: 'doc',
        content: [para(text('Run by '), { type: 'pageLink', attrs: { pageId: ids['npc'], label: 'Toblen' } }, text(', fights {@creature Toblen Stonehill|placeholder}.')), { type: 'image', attrs: { src: { kind: 'upload', id: upload.id } } }],
      },
    });
    const enc = (await dm.post(`${base()}/encounters`, { name: 'Bar fight', locationPageId: ids['inn'], creatures: [{ id: 'a', kind: 'npc', pageId: ids['npc'] }] })).body;
    ids['encounter'] = enc.id;
    await dm.post(`${base()}/inventory/items`, { ownerPageId: ids['pc'], name: 'Lucky coin' });
    await dm.post(`${base()}/inventory/coins`, { change: { gp: 25 } });
    const tpl = (await dm.post('/api/templates', { kind: 'page', scope: 'campaign', campaignId: sourceId, name: 'Tavern', definition: { pageType: 'location', body: [para(text('{{name}}'))] } })).body;
    await dm.put(`${base()}/template-defaults`, { pageType: 'location', templateId: tpl.id });
    await dm.patch(base(), { houseRules: { type: 'doc', content: [para(text('Crits explode'))] }, sourceOverrides: { old: true } });
  });

  it('exports a zip with campaign.json and the images', async () => {
    const res = await request(`${base()}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Lost-Mine.zip"');
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['campaign.json', `uploads/${ids['upload']}`]);
    const doc = JSON.parse(new TextDecoder().decode(files['campaign.json']));
    expect(doc).toMatchObject({ format: 'critical-notes/campaign', schemaVersion: 1, campaign: { name: 'Lost Mine', ruleset: '2014' } });
    expect(doc.pages).toHaveLength(5);
    expect(doc.homebrew.monster.map((m: { name: string }) => m.name)).toEqual(['Toblen Stonehill']);
  });

  it('imports as a new campaign with new ids and every reference pointing at the new things', async () => {
    const zip = new Uint8Array(await (await request(`${base()}/export`)).arrayBuffer());
    const res = await importZip(zip);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ pages: 5, encounters: 1, templates: 1, homebrew: 1, uploads: 1, warnings: [] });
    const newId = res.body['campaignId'] as string;
    expect(newId).not.toBe(sourceId);
    const nb = `/api/campaigns/${newId}`;
    const tree = (await dm.get(`${nb}/pages`)).body.pages as { id: string; title: string; parentId: string | null }[];
    const byTitle = Object.fromEntries(tree.map((p) => [p.title, p]));
    expect(Object.keys(byTitle).sort()).toEqual(['Aria', 'Phandalin', 'Session 1', 'Stonehill Inn', 'Toblen']);
    for (const p of tree) expect(Object.values(ids)).not.toContain(p.id);
    expect(byTitle['Stonehill Inn']!.parentId).toBe(byTitle['Phandalin']!.id);

    const inn = (await dm.get(`${nb}/pages/${byTitle['Stonehill Inn']!.id}`)).body;
    expect(inn.facet.parentLocationPageId).toBe(byTitle['Phandalin']!.id);
    expect(inn.props).toEqual({ owner: byTitle['Toblen']!.id, secret: 'Smuggling' });
    expect(inn.body.content[0].content[1].attrs.pageId).toBe(byTitle['Toblen']!.id);
    const image = inn.body.content[1].attrs.src;
    expect(image.id).not.toBe(ids['upload']);
    expect((await request(`/api/uploads/${image.id}`)).status).toBe(200);

    // The campaign-only homebrew moved to the new campaign's own source
    const campaign = (await dm.get(nb)).body;
    const npc = (await dm.get(`${nb}/pages/${byTitle['Toblen']!.id}`)).body;
    expect(npc.facet.statblockUid).toBe(`monster:toblen stonehill|${campaign.campaignSourceId.toLowerCase()}`);
    expect((await dm.get(`/api/reference/entities/${encodeURIComponent(npc.facet.statblockUid)}?campaignId=${newId}`)).body.name).toBe('Toblen Stonehill');
    expect(npc.facet.statblockHomebrewEntityId).toEqual(expect.any(String));

    const encounters = (await dm.get(`${nb}/encounters`)).body.encounters;
    const enc = (await dm.get(`${nb}/encounters/${encounters[0].id}`)).body;
    expect([enc.locationPageId, enc.creatures[0].pageId]).toEqual([byTitle['Stonehill Inn']!.id, byTitle['Toblen']!.id]);
    const inventory = (await dm.get(`${nb}/inventory`)).body;
    expect(inventory.items[0]).toMatchObject({ name: 'Lucky coin', ownerPageId: byTitle['Aria']!.id });
    expect(inventory.coins.party.gp).toBe(25);
    const defaults = (await dm.get(`${nb}/template-defaults`)).body.defaults;
    const templates = (await dm.get(`/api/templates?campaignId=${newId}&kind=page`)).body.templates.filter((t: { scope: string }) => t.scope === 'campaign');
    expect(defaults).toEqual({ location: templates[0].id });
    expect(campaign).toMatchObject({ name: 'Lost Mine', houseRules: { content: [{ content: [{ text: 'Crits explode' }] }] }, sourceOverrides: { old: true } });

    // The original is untouched
    const original = (await dm.get(`${base()}/pages/${ids['npc']}`)).body;
    expect((await dm.get(`/api/reference/entities/${encodeURIComponent(original.facet.statblockUid)}?campaignId=${sourceId}`)).body.name).toBe('Toblen Stonehill');
  });

  it('refuses files that are not campaign exports, or from a newer version', async () => {
    expect((await importZip(Uint8Array.from([1, 2, 3, 4]))).body.error).toMatch(/not a zip/);
    expect((await importZip(zipSync({ 'readme.txt': strToU8('hi') }))).body.error).toMatch(/no campaign.json/);
    expect((await importZip(zipSync({ 'campaign.json': strToU8('{oops') }))).body.error).toMatch(/not valid JSON/);
    const future = zipSync({ 'campaign.json': strToU8(JSON.stringify({ format: 'critical-notes/campaign', schemaVersion: 99, campaign: {} })) });
    expect((await importZip(future)).body.error).toMatch(/newer version of Critical Notes/);
  });
});
