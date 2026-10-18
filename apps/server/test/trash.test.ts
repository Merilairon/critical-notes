import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { entityReferences, pageLinks, pages, uploads } from '../src/db/schema';
import { RESTORE_MARKER } from '../src/lib/restore-marker';
import { isAllowed } from '../src/mcp/api';
import { CLOCK_MARGIN_MS, PURGE_INTERVAL_MS, PURGE_RECHECK_MS, PURGE_START_DELAY_MS, TRASH_RETENTION_MS, TrashPurger } from '../src/services/trash-purger';
import { createFixture, createSignedInApp, TestClient, testImage, type Fixture, type TestApp } from './helpers';

let fx: Fixture;
let app: TestApp;
let dm: TestClient;
let player: TestClient;
let purgeExpired: (cutoff: number) => number;
let campaignId: string;
const base = () => `/api/campaigns/${campaignId}`;
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const text = (t: string) => ({ type: 'text', text: t });
const link = (pageId: string) => ({ type: 'pageLink', attrs: { pageId, label: 'x' } });

async function page(body: Record<string, unknown>) {
  const res = await dm.post(`${base()}/pages`, body);
  expect(res.status).toBe(201);
  return res.body as { id: string; revision: number };
}
async function setBody(id: string, content: unknown[]) {
  const cur = (await dm.get(`${base()}/pages/${id}`)).body;
  const res = await dm.patch(`${base()}/pages/${id}`, { revision: cur.revision, body: { type: 'doc', content } });
  expect(res.status).toBe(200);
}
const trash = async () => (await dm.get(`${base()}/trash`)).body.items as { id: string; title: string; subpageCount: number; deletedAt: number }[];
const hits = async (q: string) => (await dm.get(`${base()}/search?q=${encodeURIComponent(q)}`)).body.pages.map((h: { title: string }) => h.title) as string[];
const rowExists = (id: string) => !!fx.db.select({ id: pages.id }).from(pages).where(eq(pages.id, id)).get();

beforeAll(async () => {
  fx = await createFixture();
  const signed = await createSignedInApp(fx);
  ({ app, client: dm } = signed);
  purgeExpired = (cutoff) => signed.services.pages.purgeExpired(cutoff);
  campaignId = (await dm.post('/api/campaigns', { name: 'Trashy', ruleset: '2014' })).body.id;
  const inv = await dm.post(`${base()}/invites`, { role: 'player' });
  player = new TestClient(app);
  expect((await player.post('/api/auth/register', { token: inv.body.token, username: 'pat', displayName: 'pat', password: 'a long enough password' })).status).toBe(201);
});
afterAll(() => fx.cleanup());

describe('trash listing and access', () => {
  it('lists trees with a root, subpage count and deletion time; players get 403', async () => {
    const root = await page({ title: 'Trashroot' });
    const kid = await page({ title: 'Trashkid', parentId: root.id });
    await page({ title: 'Trashgrandkid', parentId: kid.id });
    const lone = await page({ title: 'Trashlone' });
    expect((await dm.delete(`${base()}/pages/${root.id}`)).status).toBe(200);
    expect((await dm.delete(`${base()}/pages/${lone.id}`)).status).toBe(200);
    const items = await trash();
    expect(items.map((i) => i.title).sort()).toEqual(['Trashlone', 'Trashroot']);
    const r = items.find((i) => i.id === root.id)!;
    expect(r.subpageCount).toBe(2);
    expect(typeof r.deletedAt).toBe('number');
    expect(items.find((i) => i.id === lone.id)!.subpageCount).toBe(0);
    expect(items.every((i) => !('body' in i))).toBe(true);

    const res = await player.get(`${base()}/trash`);
    expect(res.status).toBe(403);
    expect((await player.delete(`${base()}/pages/${root.id}/purge`)).status).toBe(403);
    expect(rowExists(root.id)).toBe(true);
    expect((await new TestClient(app).get(`${base()}/trash`)).status).toBe(401);
  });

  it('lists a subpage deleted earlier as its own entry', async () => {
    const parent = await page({ title: 'Earlyparent' });
    const child = await page({ title: 'Earlychild', parentId: parent.id });
    await dm.delete(`${base()}/pages/${child.id}`);
    await new Promise((r) => setTimeout(r, 5));
    await dm.delete(`${base()}/pages/${parent.id}`);
    const items = await trash();
    expect(items.find((i) => i.id === parent.id)!.subpageCount).toBe(0);
    expect(items.some((i) => i.id === child.id)).toBe(true);
  });

  it("does not show another campaign's trash", async () => {
    const other = (await dm.post('/api/campaigns', { name: 'Other', ruleset: '2014' })).body.id;
    expect((await dm.get(`/api/campaigns/${other}/trash`)).body.items).toEqual([]);
    const p = await page({ title: 'Mine' });
    await dm.delete(`${base()}/pages/${p.id}`);
    expect((await dm.delete(`/api/campaigns/${other}/pages/${p.id}/purge`)).status).toBe(404);
    expect(rowExists(p.id)).toBe(true);
  });
});

describe('restore', () => {
  it('brings back subpages, backlinks, references and search rows', async () => {
    const target = await page({ title: 'Zanzibarkeep' });
    const kid = await page({ title: 'Zanzibarcellar', parentId: target.id });
    const linker = await page({ title: 'Linker' });
    await setBody(linker.id, [para(link(target.id)), para(text('see it'))]);
    await setBody(target.id, [para(text('Quokkas live in Zanzibarkeep'))]);
    await dm.patch(`${base()}/pages/${kid.id}`, { revision: 1, facet: undefined, body: { type: 'doc', content: [para(text('kidtext'), link(linker.id))] } });
    expect(await hits('quokkas')).toEqual(['Zanzibarkeep']);
    const backlinks = async () => (await dm.get(`${base()}/pages/${target.id}/backlinks`)).body;

    await dm.delete(`${base()}/pages/${target.id}`);
    expect(await hits('quokkas')).toEqual([]);
    expect(await hits('kidtext')).toEqual([]);

    const res = await dm.post(`${base()}/pages/${target.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.restored.sort()).toEqual([target.id, kid.id].sort());
    expect(await hits('quokkas')).toEqual(['Zanzibarkeep']);
    expect(await hits('kidtext')).toEqual(['Zanzibarcellar']);
    expect(JSON.stringify(await backlinks())).toContain(linker.id);
    const back = (await dm.get(`${base()}/pages/${kid.id}`)).body;
    expect(back.parentId).toBe(target.id);
    expect(fx.db.select().from(pageLinks).where(eq(pageLinks.fromPageId, kid.id)).all().map((l) => l.toPageId)).toEqual([linker.id]);
    expect((await trash()).some((i) => i.id === target.id)).toBe(false);
    expect((await dm.post(`${base()}/pages/${target.id}/restore`)).status).toBe(400);
  });
});

describe('purge', () => {
  it('refuses live pages and unknown pages', async () => {
    const live = await page({ title: 'Stillhere' });
    const res = await dm.delete(`${base()}/pages/${live.id}/purge`);
    expect(res.status).toBe(400);
    expect(rowExists(live.id)).toBe(true);
    expect((await dm.delete(`${base()}/pages/nope/purge`)).status).toBe(404);
  });

  it('removes the tree and every derived row, and keeps uploads valid', async () => {
    const form = new FormData();
    form.append('file', new File([Buffer.from(await testImage())], 'map.png', { type: 'image/png' }));
    const up = await app.request(`http://localhost${base()}/uploads`, { method: 'POST', body: form, headers: { cookie: dm.cookie, origin: 'http://localhost', host: 'localhost' } });
    const upload = (await up.json()) as { id: string; url: string };

    const root = await page({ title: 'Purgeroot' });
    const kid = await page({ title: 'Purgekid', parentId: root.id });
    const keeper = await page({ title: 'Keeper' });
    await setBody(root.id, [para(text('Wombats gather'))]);
    await setBody(kid.id, [{ type: 'image', attrs: { src: upload.url } }, para(text('Dingos too'))]);
    await setBody(keeper.id, [para(link(root.id)), { type: 'image', attrs: { src: upload.url } }]);
    fx.db.insert(entityReferences).values({ pageId: kid.id, uid: 'monster:gloomling|tst', via: 'inline' }).onConflictDoNothing().run();
    expect(fx.db.select().from(pageLinks).where(eq(pageLinks.toPageId, root.id)).all()).toHaveLength(1);
    expect(await hits('wombats')).toEqual(['Purgeroot']);
    const searchRows = (ids: string[]) =>
      ids.map((id) => fx.indexDb.prepare('SELECT id FROM page_search WHERE page_id = ?').get(id) as { id: number } | undefined);
    const rowIds = searchRows([root.id, kid.id]).map((r) => r!.id);

    await dm.delete(`${base()}/pages/${root.id}`);
    // soft delete already removed the search rows; put them back so the purge itself is what is proved
    const pagesSvc = (await import('../src/reference/page-search')).PageSearchIndex;
    const idx = new pagesSvc(fx.indexDb);
    for (const [id, title] of [[root.id, 'Purgeroot'], [kid.id, 'Purgekid']] as const) {
      idx.upsert({ pageId: id, campaignId, type: 'generic', icon: null, visibility: 'dm', title, textDm: 'zzz', textPlayer: 'zzz' });
    }
    expect(searchRows([root.id, kid.id]).every(Boolean)).toBe(true);
    const res = await dm.delete(`${base()}/pages/${root.id}/purge`);
    expect(res.status).toBe(200);
    expect([...res.body.purged].sort()).toEqual([root.id, kid.id].sort());

    expect(rowExists(root.id)).toBe(false);
    expect(rowExists(kid.id)).toBe(false);
    expect(fx.db.select().from(pageLinks).where(eq(pageLinks.toPageId, root.id)).all()).toEqual([]);
    expect(fx.db.select().from(pageLinks).where(eq(pageLinks.fromPageId, kid.id)).all()).toEqual([]);
    expect(fx.db.select().from(entityReferences).where(eq(entityReferences.pageId, kid.id)).all()).toEqual([]);
    expect(searchRows([root.id, kid.id])).toEqual([undefined, undefined]);
    for (const rid of rowIds) expect(fx.indexDb.prepare('SELECT rowid FROM page_fts WHERE rowid = ?').get(rid)).toBeUndefined();
    expect(await hits('wombats')).toEqual([]);
    expect(await hits('dingos')).toEqual([]);
    expect((await trash()).some((i) => i.id === root.id)).toBe(false);
    expect((await dm.post(`${base()}/pages/${root.id}/restore`)).status).toBe(404);

    // The image is still stored, served, and used by the page that survives
    expect(fx.db.select().from(uploads).where(eq(uploads.id, upload.id)).get()).toBeTruthy();
    expect((await dm.request('GET', upload.url)).status).toBe(200);
    expect((await dm.get(`${base()}/pages/${keeper.id}`)).status).toBe(200);
  });

  it('keeps a subpage deleted earlier in the trash as a root when its parent is purged, and it can be restored', async () => {
    const parent = await page({ title: 'Gonparent' });
    const child = await page({ title: 'Survivingchild', parentId: parent.id });
    await dm.delete(`${base()}/pages/${child.id}`);
    await new Promise((r) => setTimeout(r, 5));
    await dm.delete(`${base()}/pages/${parent.id}`);
    const res = await dm.delete(`${base()}/pages/${parent.id}/purge`);
    expect(res.body.purged).toEqual([parent.id]);
    expect(rowExists(parent.id)).toBe(false);
    expect(fx.db.select({ p: pages.parentId }).from(pages).where(eq(pages.id, child.id)).get()!.p).toBeNull();
    const entry = (await trash()).find((i) => i.id === child.id);
    expect(entry).toBeTruthy();
    const back = await dm.post(`${base()}/pages/${child.id}/restore`);
    expect(back.status).toBe(200);
    const live = (await dm.get(`${base()}/pages/${child.id}`)).body;
    expect(live.parentId).toBeNull();
  });

  it('lets AI assistants read the trash but never purge it', () => {
    expect(isAllowed('GET', `/api/campaigns/c1/trash`)).toBe(true);
    expect(isAllowed('POST', `/api/campaigns/c1/trash`)).toBe(false);
    expect(isAllowed('DELETE', `/api/campaigns/c1/trash`)).toBe(false);
    expect(isAllowed('DELETE', `/api/campaigns/c1/pages/p1/purge`)).toBe(false);
  });

  it('purges only pages deleted more than 30 days ago', async () => {
    const old = await page({ title: 'Oldpage' });
    const oldKid = await page({ title: 'Oldkid', parentId: old.id });
    const fresh = await page({ title: 'Freshpage' });
    await dm.delete(`${base()}/pages/${old.id}`);
    await dm.delete(`${base()}/pages/${fresh.id}`);
    const stamp = Date.now() - TRASH_RETENTION_MS - 1000;
    fx.db.update(pages).set({ deletedAt: stamp }).where(eq(pages.id, old.id)).run();
    fx.db.update(pages).set({ deletedAt: stamp }).where(eq(pages.id, oldKid.id)).run();
    const n = purgeExpired(Date.now() - TRASH_RETENTION_MS);
    expect(n).toBe(2);
    expect(rowExists(old.id)).toBe(false);
    expect(rowExists(oldKid.id)).toBe(false);
    expect(rowExists(fresh.id)).toBe(true);
    expect((await trash()).map((i) => i.id)).toContain(fresh.id);
  });
});

describe('TrashPurger scheduling', () => {
  const makeFake = () => {
    const timers: { fn: () => void; ms: number; id: number }[] = [];
    let seq = 0;
    return {
      timers,
      api: {
        set: (fn: () => void, ms: number) => {
          const t = { fn, ms, id: ++seq };
          timers.push(t);
          return t;
        },
        clear: (h: unknown) => {
          const i = timers.indexOf(h as (typeof timers)[number]);
          if (i >= 0) timers.splice(i, 1);
        },
      },
    };
  };
  const build = (opts: { running?: () => boolean; dataDir?: string; purge?: (c: number) => number }) => {
    const fake = makeFake();
    const purge = vi.fn(opts.purge ?? (() => 3));
    const log = vi.fn();
    const p = new TrashPurger({
      pages: { purgeExpired: purge },
      backups: { isRunning: opts.running ?? (() => false) },
      config: { dataDir: opts.dataDir ?? '/nonexistent-dir-for-test' },
      now: () => 10_000_000_000_000,
      timers: fake.api,
      log,
    });
    return { p, fake, purge, log };
  };

  it('runs shortly after start, then daily, with a 30 day cutoff', () => {
    const { p, fake, purge } = build({});
    p.start();
    expect(fake.timers.map((t) => t.ms)).toEqual([PURGE_START_DELAY_MS]);
    fake.timers.shift()!.fn();
    expect(purge).toHaveBeenCalledWith(10_000_000_000_000 - TRASH_RETENTION_MS);
    expect(fake.timers.map((t) => t.ms)).toEqual([PURGE_INTERVAL_MS]);
  });

  it('defers while a backup runs and tries again soon', () => {
    let running = true;
    const { p, fake, purge } = build({ running: () => running });
    p.start();
    fake.timers.shift()!.fn();
    expect(purge).not.toHaveBeenCalled();
    expect(fake.timers.map((t) => t.ms)).toEqual([PURGE_RECHECK_MS]);
    running = false;
    fake.timers.shift()!.fn();
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it('defers while a restore marker exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cn-trash-'));
    try {
      writeFileSync(join(dir, RESTORE_MARKER), '{}');
      const { p, fake, purge } = build({ dataDir: dir });
      expect(p.runOnce()).toBeNull();
      expect(purge).not.toHaveBeenCalled();
      p.start();
      fake.timers.shift()!.fn();
      expect(fake.timers.map((t) => t.ms)).toEqual([PURGE_RECHECK_MS]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a second start (no leaked timer)', () => {
    const { p, fake } = build({});
    p.start();
    p.start();
    expect(fake.timers).toHaveLength(1);
  });

  it('skips a pass when the clock is behind recent changes or the last run', () => {
    let newest = 0;
    let now = 10_000_000_000_000;
    const fake = makeFake();
    const purge = vi.fn(() => 0);
    const log = vi.fn();
    const p = new TrashPurger({ pages: { purgeExpired: purge, newestActivity: () => newest }, backups: { isRunning: () => false }, config: { dataDir: '/nonexistent-dir-for-test' }, now: () => now, timers: fake.api, log });
    expect(p.runOnce()).toBe(0);
    newest = now + CLOCK_MARGIN_MS + 1; // a page changed "in the future"
    expect(p.runOnce()).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('clock'));
    newest = now - 1;
    expect(p.runOnce()).toBe(0);
    now -= CLOCK_MARGIN_MS + 1; // the clock jumped back since the last run
    expect(p.runOnce()).toBeNull();
    expect(purge).toHaveBeenCalledTimes(2);
  });

  it('survives a failing purge and stops cleanly', async () => {
    const { p, fake, log } = build({
      purge: () => {
        throw new Error('db busy');
      },
    });
    p.start();
    fake.timers.shift()!.fn();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('db busy'));
    expect(fake.timers.map((t) => t.ms)).toEqual([PURGE_INTERVAL_MS]);
    await p.stop();
    expect(fake.timers).toEqual([]);
    p.start();
    await p.stop();
    expect(fake.timers).toEqual([]);
  });
});
