import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toFtsQuery } from '../src/reference/service';
import { createFixture, createSignedInApp, TestClient, type Fixture } from './helpers';

let fx: Fixture;
let client: TestClient;

beforeAll(async () => {
  fx = await createFixture();
  symlinkSync(join(fx.root, 'secret.webp'), join(fx.imgPath, 'bestiary', 'TST', 'Escape.webp'));
  client = (await createSignedInApp(fx)).client;
});
afterAll(() => fx.cleanup());

const get = (path: string) => client.get(path);
const enc = encodeURIComponent;

describe('reference lists respect the campaign policy', () => {
  const names = async (q: string) => ((await get(`/api/reference/kinds/spell?${q}`)).body as { items: { uid: string; badge: string | null; alsoPrintedAs: string[] }[] }).items;

  it('2014 sees classic content only', async () => {
    const items = await names('ruleset=2014');
    expect(items.map((i) => i.uid).sort()).toEqual(['spell:ancient ward|old', 'spell:spark burst|tst']);
  });

  it('2024 sees modern content only', async () => {
    expect((await names('ruleset=2024')).map((i) => i.uid)).toEqual(['spell:spark burst|xtst']);
  });

  it('cross-edition adds badged content and de-duplicates reprints in favour of the campaign edition', async () => {
    const items = await names('ruleset=2024&cross=1');
    expect(items.map((i) => [i.uid, i.badge])).toEqual([
      ['spell:ancient ward|old', 'legacy'],
      ['spell:spark burst|xtst', null],
    ]);
    expect(items[1]!.alsoPrintedAs).toEqual(['spell:spark burst|tst']);
    const classic = await names('ruleset=2014&cross=1');
    expect(classic.find((i) => i.uid.startsWith('spell:spark burst'))!.uid).toBe('spell:spark burst|tst');
  });

  it('per-source toggles disable books', async () => {
    expect((await names('ruleset=2014&sources=OLD:0')).map((i) => i.uid)).toEqual(['spell:spark burst|tst']);
  });

  it('rejects unknown kinds', async () => {
    expect((await get('/api/reference/kinds/nope')).status).toBe(400);
  });
});

describe('entity detail', () => {
  it('returns resolved data, fluff, source info and the reprint group', async () => {
    const { status, body } = await get(`/api/reference/entities/${enc('spell:spark burst|tst')}?ruleset=2024`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      name: 'Spark Burst',
      source: 'TST',
      edition: 'classic',
      visible: false,
      preferredUid: 'spell:spark burst|xtst',
      reprintedAs: [{ uid: 'spell:spark burst|xtst', exists: true }],
      sourceInfo: { id: 'TST', name: 'Test Handbook', edition: 'classic' },
    });
    expect(body.reprintGroup.map((m: { uid: string; visible: boolean }) => [m.uid, m.visible])).toEqual([
      ['spell:spark burst|tst', false],
      ['spell:spark burst|xtst', true],
    ]);
  });

  it('includes fluff and image paths for monsters; 404 for unknown uids', async () => {
    const { body } = await get(`/api/reference/entities/${enc('monster:gloomling|tst')}?ruleset=2014`);
    expect(body.fluff.entries).toEqual(['Gloomlings lurk.']);
    expect(body.imagePath).toBe('bestiary/TST/Gloomling.webp');
    expect((await get(`/api/reference/entities/${enc('monster:nope|tst')}`)).status).toBe(404);
  });
});

describe('search and autocomplete', () => {
  it('finds entities by name prefix and text, filtered by policy', async () => {
    const { body } = await get('/api/reference/search?q=spark&ruleset=2014');
    expect(body.hits.map((h: { uid: string }) => h.uid)).toEqual(['spell:spark burst|tst']);
    const text = await get('/api/reference/search?q=lurk&ruleset=2014&kinds=monster');
    expect(text.body.hits).toEqual([]); // fluff text is not indexed; entity text is
    const byText = await get('/api/reference/search?q=needle&ruleset=2014');
    expect(byText.body.hits[0].uid).toBe('monster:gloomling|tst');
  });

  it('autocompletes within a kind', async () => {
    const { body } = await get('/api/reference/autocomplete/monster?q=gloom&ruleset=2014');
    expect(body.hits.map((h: { name: string }) => h.name)).toContain('Gloomling');
    expect(body.hits.map((h: { name: string }) => h.name)).toContain('Gloomling Chief');
  });

  it('builds safe FTS queries from arbitrary input', () => {
    expect(toFtsQuery('Fire  ball"* OR x')).toBe('"fire"* "ball"* "or"* "x"*');
    expect(toFtsQuery('   ')).toBeNull();
    expect(toFtsQuery('Æther ñ')).toBe('"æther"* "n"*');
  });
});

describe('image route', () => {
  it('serves images with caching headers', async () => {
    const { status, res } = await get('/img/bestiary/TST/Gloomling.webp');
    expect(status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('etag')).toBeTruthy();
    expect(res.headers.get('cache-control')).toContain('max-age');
    const again = await client.app.request('http://localhost/img/bestiary/TST/Gloomling.webp', {
      headers: { 'If-None-Match': res.headers.get('etag')!, cookie: client.cookie },
    });
    expect(again.status).toBe(304);
  });

  it.each([
    '/img/../secret.webp',
    '/img/..%2Fsecret.webp',
    '/img/bestiary/..%2F..%2Fsecret.webp',
    '/img/%2Fetc%2Fpasswd',
    '/img/bestiary/TST/Escape.webp', // symlink pointing outside the root
    '/img/bestiary/TST/Missing.webp',
    '/img/bestiary/TST/Gloomling.json',
  ])('refuses %s', async (path) => {
    expect((await get(path)).status).toBe(404);
  });

  it('requires a session', async () => {
    const anon = new TestClient(client.app);
    expect((await anon.get('/img/bestiary/TST/Gloomling.webp')).status).toBe(401);
    expect((await anon.get('/api/reference/kinds')).status).toBe(401);
  });
});
