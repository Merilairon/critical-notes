import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { entityReferences } from '../src/db/schema';
import { createFixture, createSignedInApp, TestClient, testImage, type Fixture } from './helpers';

let fx: Fixture;
let dm: TestClient;
let campaignId: string;
const base = () => `/api/campaigns/${campaignId}`;

const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const text = (t: string) => ({ type: 'text', text: t });

beforeAll(async () => {
  fx = await createFixture();
  dm = (await createSignedInApp(fx)).client;
  campaignId = (await dm.post('/api/campaigns', { name: 'Blocks', ruleset: '2014' })).body.id;
});
afterAll(() => fx.cleanup());

describe('page bodies', () => {
  it('sanitizes and assigns block ids on save, preserving unknown blocks', async () => {
    const page = (await dm.post(`${base()}/pages`, { title: 'Doc' })).body;
    const res = await dm.patch(`${base()}/pages/${page.id}`, {
      revision: 1,
      body: {
        type: 'doc',
        content: [
          para(text('hi'), { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }),
          { type: 'hologram', attrs: { x: 1 } },
          { type: 'secret', content: [para(text('hidden'))] },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = res.body.body;
    expect(body.schemaVersion).toBe(1);
    expect(body.content[0].attrs.id).toMatch(/^b/);
    expect(body.content[0].content[1]).toEqual({ type: 'text', text: 'link' }); // unsafe link mark dropped
    expect(body.content[1]).toMatchObject({ type: 'unknownBlock', attrs: { raw: { type: 'hologram' } } });
    expect(body.content[2]).toMatchObject({ type: 'secret', attrs: { visibility: 'inherit', revealed: false } });
  });
});

describe('backlinks and entity references', () => {
  it('tracks [[links]], embeds and facet links', async () => {
    const tavern = (await dm.post(`${base()}/pages`, { type: 'location', title: 'Stonehill Inn' })).body;
    const npc = (await dm.post(`${base()}/pages`, { type: 'npc', title: 'Toblen', facet: { locationPageId: tavern.id, statblockUid: 'monster:gloomling|tst' } })).body;
    const note = (await dm.post(`${base()}/pages`, { title: 'Notes' })).body;
    await dm.patch(`${base()}/pages/${note.id}`, {
      revision: 1,
      body: {
        type: 'doc',
        content: [
          para(text('Meet at '), { type: 'pageLink', attrs: { pageId: tavern.id, label: 'Stonehill Inn' } }, { type: 'tag', attrs: { markup: '{@spell spark burst|tst}' } }),
          { type: 'pageEmbed', attrs: { pageId: npc.id } },
          para({ type: 'pageLink', attrs: { pageId: 'not-a-page', label: 'ghost' } }),
        ],
      },
    });
    const back = (await dm.get(`${base()}/pages/${tavern.id}/backlinks`)).body.backlinks;
    expect(back.map((b: { title: string; kinds: string[] }) => [b.title, b.kinds.sort()]).sort()).toEqual([
      ['Notes', ['mention']],
      ['Toblen', ['property']],
    ]);
    expect((await dm.get(`${base()}/pages/${npc.id}/backlinks`)).body.backlinks.map((b: { kinds: string[] }) => b.kinds)).toEqual([['embed']]);
    const refs = fx.db.select().from(entityReferences).all().map((r) => `${r.uid}:${r.via}`).sort();
    expect(refs).toEqual(['monster:gloomling|tst:facet', 'spell:spark burst|tst:tag']);
  });

  it('drops backlinks when the linking page is deleted', async () => {
    const a = (await dm.post(`${base()}/pages`, { title: 'Target' })).body;
    const b = (await dm.post(`${base()}/pages`, { title: 'Linker' })).body;
    await dm.patch(`${base()}/pages/${b.id}`, { revision: 1, body: { type: 'doc', content: [para({ type: 'pageLink', attrs: { pageId: a.id, label: 'T' } })] } });
    expect((await dm.get(`${base()}/pages/${a.id}/backlinks`)).body.backlinks).toHaveLength(1);
    await dm.delete(`${base()}/pages/${b.id}`);
    expect((await dm.get(`${base()}/pages/${a.id}/backlinks`)).body.backlinks).toHaveLength(0);
  });
});

describe('custom properties', () => {
  it('creates typed properties and validates values', async () => {
    const level = (await dm.post(`${base()}/properties`, { label: 'Threat Level', type: 'select', options: ['low', 'high'] })).body;
    expect(level.key).toBe('threat_level');
    const seen = (await dm.post(`${base()}/properties`, { label: 'Last seen', type: 'date' })).body;
    const ally = (await dm.post(`${base()}/properties`, { label: 'Ally', type: 'pageLink' })).body;
    expect((await dm.post(`${base()}/properties`, { label: 'Bad', type: 'select' })).status).toBe(400);

    const a = (await dm.post(`${base()}/pages`, { type: 'npc', title: 'Halia' })).body;
    const b = (await dm.post(`${base()}/pages`, { type: 'npc', title: 'Harbin' })).body;
    const ok = await dm.patch(`${base()}/pages/${a.id}`, { revision: 1, props: { [level.key]: 'high', [seen.key]: '2026-10-01', [ally.key]: b.id } });
    expect(ok.status).toBe(200);
    expect(ok.body.props).toEqual({ threat_level: 'high', last_seen: '2026-10-01', ally: b.id });
    expect((await dm.get(`${base()}/pages/${b.id}/backlinks`)).body.backlinks[0].kinds).toEqual(['property']);

    const bad = await dm.patch(`${base()}/pages/${a.id}`, { revision: 2, props: { [level.key]: 'apocalyptic', nope: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.body.details).toEqual(expect.arrayContaining([expect.stringContaining('not one of the options'), 'Unknown property "nope"']));
    const cleared = await dm.patch(`${base()}/pages/${a.id}`, { revision: 2, props: { [seen.key]: null } });
    expect(cleared.body.props).toEqual({ threat_level: 'high', ally: b.id });
  });
});

describe('query blocks', () => {
  it('returns pages filtered by type, facets and properties, relative to the current page', async () => {
    const town = (await dm.post(`${base()}/pages`, { type: 'location', title: 'Thundertree' })).body;
    await dm.post(`${base()}/pages`, { type: 'npc', title: 'Reidoth', facet: { locationPageId: town.id } });
    await dm.post(`${base()}/pages`, { type: 'npc', title: 'Venomfang', facet: { locationPageId: town.id, status: 'dead' } });
    const res = await dm.post(`${base()}/query`, {
      filter: { types: ['npc'], where: [{ field: 'facet.locationPageId', op: 'eq', value: { $ctx: 'currentPage' } }], sort: { field: 'title', dir: 'desc' } },
      contextPageId: town.id,
    });
    expect(res.body.rows.map((r: { title: string }) => r.title)).toEqual(['Venomfang', 'Reidoth']);
    const alive = await dm.post(`${base()}/query`, { filter: { types: ['npc'], where: [{ field: 'facet.status', op: 'eq', value: 'alive' }, { field: 'facet.locationPageId', op: 'eq', value: town.id }] } });
    expect(alive.body.rows.map((r: { title: string }) => r.title)).toEqual(['Reidoth']);
    expect((await dm.post(`${base()}/query`, { filter: { where: [{ field: 'x', op: 'explode' }] } })).status).toBe(400);
  });
});

describe('page search', () => {
  it('finds pages by title and body text, and secrets only in DM mode', async () => {
    const p = (await dm.post(`${base()}/pages`, { title: 'Cragmaw Castle' })).body;
    await dm.patch(`${base()}/pages/${p.id}`, { revision: 1, body: { type: 'doc', content: [para(text('Owlbears roam here.')), { type: 'secret', content: [para(text('King Grol holds Gundren'))] }] } });
    const hits = async (q: string) => (await dm.get(`${base()}/search?q=${encodeURIComponent(q)}`)).body.pages.map((h: { title: string }) => h.title);
    expect(await hits('cragm')).toEqual(['Cragmaw Castle']);
    expect(await hits('owlbear')).toEqual(['Cragmaw Castle']);
    expect(await hits('gundren')).toEqual(['Cragmaw Castle']);
    const playerHits = fx.indexDb ? (await import('../src/reference/page-search')).PageSearchIndex : null;
    const index = new playerHits!(fx.indexDb);
    expect(index.search(campaignId, 'gundren', { mode: 'player' })).toEqual([]);
    expect(index.search(campaignId, 'owlbear', { mode: 'player' }).map((h) => h.title)).toEqual(['Cragmaw Castle']);
  });
});

describe('uploads', () => {
  async function upload(bytes: Uint8Array, name: string, cookie = dm.cookie) {
    const form = new FormData();
    form.append('file', new File([bytes], name, { type: 'image/png' }));
    return dm.app.request(`http://localhost${base()}/uploads`, { method: 'POST', body: form, headers: { cookie, origin: 'http://localhost', host: 'localhost' } });
  }

  it('accepts real images, rejects disguised files, serves to members only', async () => {
    const ok = await upload(await testImage(), 'map.png');
    expect(ok.status).toBe(201);
    const dto = (await ok.json()) as { id: string; url: string; mime: string };
    expect(dto.mime).toBe('image/png');
    const served = await dm.get(dto.url);
    expect(served.status).toBe(200);
    expect(served.res.headers.get('content-type')).toBe('image/png');

    const fake = await upload(new TextEncoder().encode('<svg onload=alert(1)>'), 'evil.png');
    expect(fake.status).toBe(400);
    // The right magic bytes are not enough: the image must decode
    const truncated = await upload(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), 'broken.png');
    expect(truncated.status).toBe(400);

    const anon = new TestClient(dm.app);
    expect((await anon.get(dto.url)).status).toBe(401);
  });

  it('strips metadata, keeps the format and makes a thumbnail', async () => {
    const photo = await testImage('jpeg', { width: 1200, height: 800, exifCopyright: 'SENTINEL-EXIF' });
    expect(Buffer.from(photo).includes('SENTINEL-EXIF')).toBe(true);
    const dto = (await (await upload(photo, 'photo.jpg')).json()) as { id: string; url: string; mime: string };
    expect(dto.mime).toBe('image/jpeg');
    const res = await dm.app.request(`http://localhost${dto.url}`, { headers: { cookie: dm.cookie } });
    const stored = Buffer.from(await res.arrayBuffer());
    expect(stored.includes('SENTINEL-EXIF')).toBe(false);
    expect((await sharp(stored).metadata()).exif).toBeUndefined();

    const thumbRes = await dm.app.request(`http://localhost${dto.url}?size=thumb`, { headers: { cookie: dm.cookie } });
    expect(thumbRes.headers.get('content-type')).toBe('image/webp');
    const thumb = await sharp(Buffer.from(await thumbRes.arrayBuffer())).metadata();
    expect([thumb.width, thumb.height]).toEqual([400, 267]);
  });
});

