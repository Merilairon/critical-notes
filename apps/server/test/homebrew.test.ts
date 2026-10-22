import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema';
import { fetchUrlText, isBlockedAddress } from '../src/homebrew/fetch-url';
import { validateHomebrewDocument } from '../src/homebrew/schema';
import { newId } from '../src/lib/ids';
import { hashPassword } from '../src/lib/password';
import { createFixture, createSignedInApp, TestClient, type Fixture, type TestApp } from './helpers';

let fx: Fixture;
let app: TestApp;
let dm: TestClient;
let campaignId: string;
let sourceCount = 0;

const monster = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  size: ['M'],
  type: 'fey',
  alignment: ['N'],
  ac: [12],
  hp: { average: 11, formula: '2d8 + 2' },
  speed: { walk: 30 },
  str: 10,
  dex: 14,
  con: 12,
  int: 10,
  wis: 10,
  cha: 10,
  passive: 10,
  cr: '1/2',
  ...extra,
});

async function newUser(username: string): Promise<TestClient> {
  fx.db
    .insert(users)
    .values({ id: newId(), username, displayName: username, passwordHash: await hashPassword('another long password'), isAdmin: false })
    .run();
  const client = new TestClient(app);
  const res = await client.post('/api/auth/login', { username, password: 'another long password' });
  expect(res.status).toBe(200);
  return client;
}

async function newSource(client = dm, body: Record<string, unknown> = {}) {
  const res = await client.post('/api/homebrew/sources', { abbreviation: 'Gloom', fullName: `Gloom Grimoire ${++sourceCount}`, edition: '2014', ...body });
  expect(res.status).toBe(201);
  return res.body as { id: string; jsonId: string };
}

beforeAll(async () => {
  fx = await createFixture();
  ({ app, client: dm } = await createSignedInApp(fx));
  campaignId = (await dm.post('/api/campaigns', { name: 'Brew Test', ruleset: '2014' })).body.id;
}, 30_000);
afterAll(() => fx.cleanup());

describe('homebrew sources', () => {
  it('derives a schema-valid unique source id and refuses invalid or taken ids', async () => {
    const a = await newSource(dm, { fullName: 'My Brew!' });
    expect(a.jsonId).toBe('MyBrew');
    expect((await newSource(dm, { fullName: 'Tales of the Fog' })).jsonId).toBe('TalesoftheFog');
    expect((await newSource(dm, { fullName: 'Tales of the Fog' })).jsonId).toBe('TalesoftheFog2');
    expect((await newSource(dm, { fullName: 'UA Remix' })).jsonId).toBe('HBUARemix');
    const create = (jsonId: string) => dm.post('/api/homebrew/sources', { jsonId, abbreviation: 'T', fullName: 'Nope', edition: '2014' });
    expect((await create('TST')).status).toBe(400); // too short for new homebrew
    expect((await create('my_brew_id')).status).toBe(400); // "_" is not allowed by 5etools
    expect((await create('talesofthefog')).status).toBe(409);
  });

  it('keeps private sources private and lets only admins go instance-wide', async () => {
    const mine = await newSource();
    const other = await newUser('player1');
    expect((await other.get(`/api/homebrew/sources/${mine.id}`)).status).toBe(404);
    expect((await other.patch(`/api/homebrew/sources/${mine.id}`, { fullName: 'Hijacked' })).status).toBe(403);
    expect((await other.post('/api/homebrew/sources', { abbreviation: 'X', fullName: 'X', edition: '2014', scope: 'instance' })).status).toBe(403);
    const theirs = await newSource(other, { abbreviation: 'Theirs' });
    expect((await dm.get('/api/homebrew/sources')).body.sources.map((s: { id: string }) => s.id)).not.toContain(theirs.id);
    // The reference browser outside campaigns shows only homebrew the user can see
    await other.post(`/api/homebrew/sources/${theirs.id}/entities`, { entityType: 'monster', data: monster('Secret Beast') });
    expect((await dm.get('/api/reference/search?q=secret%20beast&cross=1')).body.hits).toEqual([]);
    expect((await other.get('/api/reference/search?q=secret%20beast&cross=1')).body.hits.map((h: { name: string }) => h.name)).toEqual(['Secret Beast']);
  });

  it('shares a source with a campaign, which makes its content usable there', async () => {
    const src = await newSource(dm, { abbreviation: 'Shared' });
    await dm.post(`/api/homebrew/sources/${src.id}/entities`, { entityType: 'monster', data: monster('Shared Imp') });
    const list = async () => (await dm.get(`/api/reference/kinds/monster?campaignId=${campaignId}`)).body.items.map((i: { name: string }) => i.name);
    expect(await list()).not.toContain('Shared Imp');
    const shared = await dm.put(`/api/homebrew/sources/${src.id}/shares`, { campaignIds: [campaignId] });
    expect(shared.body.sharedWith).toEqual([{ id: campaignId, name: 'Brew Test' }]);
    expect(await list()).toContain('Shared Imp');
    await dm.put(`/api/homebrew/sources/${src.id}/shares`, { campaignIds: [] });
    expect(await list()).not.toContain('Shared Imp');
  });
});

describe('homebrew entities', () => {
  let src: { id: string; jsonId: string };
  const base = () => `/api/homebrew/sources/${src.id}`;
  beforeAll(async () => {
    src = await newSource(dm, { abbreviation: 'Ents' });
  });

  it('saves valid entities and indexes them for the reference', async () => {
    const res = await dm.post(`${base()}/entities`, { entityType: 'monster', data: monster('Murk Hound') });
    expect(res.status).toBe(201);
    expect(res.body.entity.uid).toBe(`monster:murk hound|${src.jsonId.toLowerCase()}`);
    expect(res.body.validation.errors).toEqual([]);
    const ref = await dm.get(`/api/reference/entities/${encodeURIComponent(res.body.entity.uid)}`);
    expect(ref.body).toMatchObject({ name: 'Murk Hound', origin: 'homebrew', prop: 'monster' });
  });

  it('blocks schema errors unless forced, and app errors always', async () => {
    const bad = await dm.post(`${base()}/entities`, { entityType: 'monster', data: monster('Wrong Hound', { hp: 'lots' }) });
    expect(bad.status).toBe(400);
    expect(bad.body.details.errors[0].message).toMatch(/^5etools schema/);
    const forced = await dm.post(`${base()}/entities`, { entityType: 'monster', data: monster('Wrong Hound', { hp: 'lots' }), force: true });
    expect(forced.status).toBe(201);
    expect(forced.body.validation.warnings.some((w: { message: string }) => w.message.startsWith('5etools schema'))).toBe(true);
    const badCr = await dm.post(`${base()}/entities`, { entityType: 'monster', data: monster('Odd Hound', { cr: '99' }), force: true });
    expect(badCr.status).toBe(400);
    expect(badCr.body.details.errors.map((e: { path: string }) => e.path)).toContain('/cr');
    const dup = await dm.post(`${base()}/entities`, { entityType: 'monster', data: monster('Murk Hound') });
    expect(dup.status).toBe(400);
    expect(dup.body.details.errors.map((e: { message: string }) => e.message).join()).toContain('already has a monster called "Murk Hound"');
  });

  it('warns about broken references, bad dice and name collisions', async () => {
    const res = await dm.post(`${base()}/entities`, {
      entityType: 'monster',
      data: monster('Gloomling', { trait: [{ name: 'Weird', entries: ['Casts {@spell spark burst|tst} and {@spell no such spell|tst}, dealing {@damage banana}.'] }] }),
    });
    expect(res.status).toBe(201);
    const messages = res.body.validation.warnings.map((w: { message: string }) => w.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Unknown spell "no such spell" (TST)'),
        expect.stringContaining('Dice expression "banana"'),
        expect.stringContaining('also exists in TST'),
      ]),
    );
    expect(messages.join()).not.toContain('spark burst');
  });

  it('versions entities: stale saves conflict, revisions restore, renames keep old links working', async () => {
    const created = (await dm.post(`${base()}/entities`, { entityType: 'spell', data: { name: 'Gloom Bolt', level: 1, school: 'V', time: [{ number: 1, unit: 'action' }], range: { type: 'point', distance: { type: 'feet', amount: 60 } }, components: { v: true }, duration: [{ type: 'instant' }], entries: ['Dark.'] } })).body.entity;
    const oldUid = created.uid;
    const v2 = await dm.put(`/api/homebrew/entities/${created.id}`, { entityType: 'spell', revision: 1, data: { ...created.data, entries: ['Darker.'] } });
    expect(v2.status).toBe(200);
    expect((await dm.put(`/api/homebrew/entities/${created.id}`, { entityType: 'spell', revision: 1, data: created.data })).status).toBe(409);
    const renamed = await dm.put(`/api/homebrew/entities/${created.id}`, { entityType: 'spell', revision: 2, data: { ...v2.body.entity.data, name: 'Umbral Bolt' } });
    expect(renamed.body.entity.uid).not.toBe(oldUid);
    const viaOld = await dm.get(`/api/reference/entities/${encodeURIComponent(oldUid)}`);
    expect(viaOld.body.name).toBe('Umbral Bolt');

    const revisions = (await dm.get(`/api/homebrew/entities/${created.id}/revisions`)).body.revisions;
    expect(revisions.map((r: { revNo: number }) => r.revNo)).toEqual([3, 2, 1]);
    const restored = await dm.post(`/api/homebrew/entities/${created.id}/revisions/1/restore`);
    expect(restored.body).toMatchObject({ name: 'Gloom Bolt', currentRevision: 4, data: { entries: ['Dark.'] } });
  });

  it('soft-deletes: hidden from lists and search, still resolvable where used, restorable', async () => {
    const e = (await dm.post(`${base()}/entities`, { entityType: 'monster', data: monster('Fading Wisp') })).body.entity;
    await dm.put(`/api/homebrew/sources/${src.id}/shares`, { campaignIds: [campaignId] });
    const page = (await dm.post(`/api/campaigns/${campaignId}/pages`, { title: 'Wisp lair' })).body;
    await dm.patch(`/api/campaigns/${campaignId}/pages/${page.id}`, {
      revision: 1,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'tag', attrs: { markup: `{@creature Fading Wisp|${src.jsonId}}` } }] }] },
    });
    expect((await dm.get(`/api/homebrew/entities/${e.id}/usage`)).body.usage).toEqual([
      { pageId: page.id, pageTitle: 'Wisp lair', campaignId, campaignName: 'Brew Test', via: 'tag' },
    ]);

    expect((await dm.delete(`/api/homebrew/entities/${e.id}`)).status).toBe(204);
    const search = await dm.get(`/api/reference/search?q=fading&campaignId=${campaignId}`);
    expect(search.body.hits).toEqual([]);
    const ref = await dm.get(`/api/reference/entities/${encodeURIComponent(e.uid)}?campaignId=${campaignId}`);
    expect(ref.body).toMatchObject({ name: 'Fading Wisp', deleted: true });
    expect((await dm.get(`${base()}/entities`)).body.entities.map((x: { name: string }) => x.name)).not.toContain('Fading Wisp');
    expect((await dm.get(`${base()}/entities?deleted=1`)).body.entities.find((x: { name: string }) => x.name === 'Fading Wisp').deleted).toBe(true);

    await dm.post(`/api/homebrew/entities/${e.id}/restore`);
    expect((await dm.get(`/api/reference/search?q=fading&campaignId=${campaignId}`)).body.hits).toHaveLength(1);
  });

  it('copies reference entities as full clones or `_copy` variants', async () => {
    const clone = await dm.post('/api/homebrew/copy', { sourceId: src.id, baseUid: 'monster:gloomling|tst', mode: 'clone' });
    expect(clone.status).toBe(201);
    expect(clone.body.entity.name).toBe('Gloomling (copy)');
    expect(clone.body.entity.data).not.toHaveProperty('page');
    expect(clone.body.entity.data).toMatchObject({ source: src.jsonId, cr: '1/4' });
    const variant = await dm.post('/api/homebrew/copy', { sourceId: src.id, baseUid: 'monster:gloomling|tst', mode: 'variant', name: 'Gloomling Elder' });
    expect(variant.body.entity.data).toMatchObject({ _copy: { name: 'Gloomling', source: 'TST' } });
    const resolved = await dm.get(`/api/reference/entities/${encodeURIComponent(variant.body.entity.uid)}`);
    expect(resolved.body.data.trait[0].name).toBe('Shadow Step');
    const item = await dm.post('/api/homebrew/copy', { sourceId: src.id, baseUid: 'item:shortblade|tst', mode: 'clone', name: 'Longer Blade' });
    expect(item.body.entity.entityType).toBe('baseitem');
  });

  it('merges homebrew subraces into their parent race', async () => {
    const res = await dm.post(`${base()}/entities`, {
      entityType: 'subrace',
      data: { name: 'Gale', raceName: 'Sylph', raceSource: 'TST', entries: [{ type: 'entries', name: 'Gust', entries: ['Whoosh.'] }] },
      force: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.entity.uid).toBe(`race:sylph (gale)|${src.jsonId.toLowerCase()}`);
    const ref = await dm.get(`/api/reference/entities/${encodeURIComponent(res.body.entity.uid)}`);
    expect(ref.body.data.entries.map((e: { name: string }) => e.name)).toEqual(['Breeze', 'Gust']);
  });

  it('previews unsaved entities with `_copy` resolved', async () => {
    const res = await dm.post('/api/homebrew/preview', { sourceId: src.id, entityType: 'monster', data: { name: 'Tiny Chief', _copy: { name: 'Gloomling Chief', source: 'TST' } } });
    expect(res.body.entity.data.action.map((a: { name: string }) => a.name)).toEqual(['Needle', 'Command']);
    expect(res.body.validation.errors).toEqual([]);
  });
});

describe('homebrew import and export', () => {
  const file = (data: Record<string, unknown>) => ({ name: 'brew.json', text: JSON.stringify(data) });
  const brew = {
    _meta: {
      sources: [{ json: 'Fogbound', abbreviation: 'FOG', full: 'Fogbound Tales', authors: ['Ann'], version: '1.2.0', convertedBy: ['Ann'] }],
      dateAdded: 1700000000,
      dateLastModified: 1700000000,
      edition: 'one',
      spellSchools: { F: { full: 'Fogcraft', short: 'Fog' } },
    },
    monster: [
      // A variant listed before its parent
      { name: 'Fog Lord', source: 'Fogbound', _copy: { name: 'Fog Wisp', source: 'Fogbound' }, cr: '3' },
      monster('Fog Wisp', { source: 'Fogbound' }),
      { source: 'Fogbound', cr: '1' },
      monster('Wanderer', { source: 'Elsewhere' }),
    ],
    monsterFluff: [{ name: 'Fog Wisp', source: 'Fogbound', entries: ['It drifts.'] }],
    spell: [{ name: 'Fog Step', source: 'Fogbound', level: 2, school: 'C', time: [{ number: 1, unit: 'bonus' }], range: { type: 'point', distance: { type: 'self' } }, components: { v: true }, duration: [{ type: 'instant' }], entries: ['Step.'] }],
    unknownThings: [{ a: 1 }],
  };

  it('imports sources, entities (any order), fluff, and reports what it skipped', async () => {
    const report = await importVia(file(brew));
    expect(report.sources).toEqual([expect.objectContaining({ jsonId: 'Fogbound', created: true })]);
    expect(report.created).toBe(4);
    expect(report.skipped).toEqual([{ type: 'monster', name: '(unnamed)', reason: 'A name is required' }]);
    expect(report.unsupported).toEqual({ unknownThings: 1 });
    expect(report.warnings.join('\n')).toContain('source "Elsewhere" is not in _meta.sources');
    const lord = await dm.get('/api/reference/entities/monster%3Afog%20lord%7Cfogbound?cross=1&ruleset=2024');
    expect(lord.body).toMatchObject({ name: 'Fog Lord', edition: 'one', data: { cr: '3', hp: { average: 11 } } });
    const wisp = await dm.get('/api/reference/entities/monster%3Afog%20wisp%7Cfogbound?cross=1&ruleset=2024');
    expect(wisp.body.fluff.entries).toEqual(['It drifts.']);
  });

  it('re-imports idempotently and updates what changed', async () => {
    expect(await importVia(file(brew))).toMatchObject({ created: 0, updated: 0, unchanged: 4 });
    const changed = structuredClone(brew);
    (changed.spell[0] as { entries: string[] }).entries = ['Step lightly.'];
    expect(await importVia(file(changed))).toMatchObject({ created: 0, updated: 1, unchanged: 3 });
  });

  it('exports valid 5etools homebrew that round-trips', async () => {
    const src = (await dm.get('/api/homebrew/sources')).body.sources.find((s: { jsonId: string }) => s.jsonId === 'Fogbound');
    const exported = await dm.get(`/api/homebrew/sources/${src.id}/export`);
    expect(exported.res.headers.get('content-disposition')).toBe('attachment; filename="Fogbound.json"');
    const doc = exported.body;
    expect(doc._meta).toMatchObject({ edition: 'one', spellSchools: { F: { full: 'Fogcraft' } }, sources: [{ json: 'Fogbound', abbreviation: 'FOG', authors: ['Ann'] }] });
    expect(doc.monster.map((m: { name: string }) => m.name).sort()).toEqual(['Fog Lord', 'Fog Wisp', 'Wanderer']);
    expect(doc.monsterFluff).toEqual([{ name: 'Fog Wisp', source: 'Fogbound', entries: ['It drifts.'] }]);
    expect(doc.unknownThings).toEqual([{ a: 1 }]);
    const { unknownThings: _unknown, ...known } = doc;
    expect(validateHomebrewDocument(known)).toEqual([]);
    expect(await importVia({ name: 'Fogbound.json', text: JSON.stringify(doc) })).toMatchObject({ created: 0, updated: 0, unchanged: 4 });
  });

  it('never crashes on malformed files', async () => {
    const report = await importVia(
      { name: 'broken.json', text: '{ not json' },
      { name: 'array.json', text: '[1,2,3]' },
      { name: 'nometa.json', text: JSON.stringify({ monster: [monster('Lost')] }) },
      file({ _meta: { sources: [{ json: 'TST', abbreviation: 'T', full: 'Official' }] }, monster: [monster('Sneaky', { source: 'TST' })] }),
      file({ _meta: { sources: [{ json: 'Odd', abbreviation: 'O', full: 'Odd' }, 'nope'] }, monster: 'not an array', spell: [null, 7, 'x', { name: 'Ok Spell', source: 'Odd', level: 99 }] }),
    );
    expect(report.created).toBe(0);
    expect(report.warnings.join('\n')).toMatch(/broken\.json: not valid JSON/);
    expect(report.warnings.join('\n')).toMatch(/array\.json: not a JSON object/);
    expect(report.warnings.join('\n')).toMatch(/nometa\.json: no _meta\.sources/);
    expect(report.warnings.join('\n')).toMatch(/"TST" is an official source id/);
    expect(report.skipped.map((s) => s.reason)).toEqual(['Entity must be a JSON object', 'Entity must be a JSON object', 'Entity must be a JSON object', expect.stringContaining('Spell level')]);
  });

  it('refuses URL imports from private addresses', async () => {
    const res = await dm.post('/api/homebrew/import-url', { url: 'http://127.0.0.1:8080/brew.json' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a public address/);
    expect((await dm.post('/api/homebrew/import-url', { url: 'file:///etc/passwd' })).status).toBe(400);
  });
});

describe('URL fetcher', () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/big') {
        res.writeHead(200);
        res.end('x'.repeat(2048));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"_meta":{}}');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  it('classifies addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '2002:7f00:1::', '64:ff9b:1::7f00:1', '::7f00:1', 'not-an-ip']) {
      expect([a, isBlockedAddress(a)]).toEqual([a, true]);
    }
    for (const a of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) expect([a, isBlockedAddress(a)]).toEqual([a, false]);
  });

  it('downloads, enforces the size limit and refuses private hosts', async () => {
    expect(await fetchUrlText(`http://127.0.0.1:${port}/ok.json`, { allowPrivate: true })).toBe('{"_meta":{}}');
    await expect(fetchUrlText(`http://127.0.0.1:${port}/big`, { allowPrivate: true, maxBytes: 1000 })).rejects.toThrow(/too large/);
    await expect(fetchUrlText(`http://127.0.0.1:${port}/ok.json`)).rejects.toThrow(/not a public address/);
    await expect(fetchUrlText(`http://localhost:${port}/ok.json`)).rejects.toThrow(/not a public address/);
  });
});

/** Imports files through the multipart endpoint. */
async function importVia(...files: { name: string; text: string }[]) {
  const form = new FormData();
  for (const f of files) form.append('files', new File([f.text], f.name, { type: 'application/json' }));
  form.append('defaultEdition', '2014');
  const res = await app.request('http://localhost/api/homebrew/import', { method: 'POST', body: form, headers: { cookie: dm.cookie, origin: 'http://localhost', host: 'localhost' } });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    created: number;
    updated: number;
    unchanged: number;
    skipped: { type: string; name: string; reason: string }[];
    warnings: string[];
    unsupported: Record<string, number>;
    sources: { jsonId: string; created: boolean }[];
  };
}
