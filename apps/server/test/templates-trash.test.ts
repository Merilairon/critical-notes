import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TRASH_RETENTION_DAYS } from '@cn/shared';
import { campaignTemplateDefaults, pages, templateUsage, templateVersions, templates } from '../src/db/schema';
import { RESTORE_MARKER } from '../src/lib/restore-marker';
import { isAllowed } from '../src/mcp/api';
import { TRASH_RETENTION_MS, TrashPurger } from '../src/services/trash-purger';
import { createFixture, createSignedInApp, TestClient, type Fixture, type TestApp } from './helpers';

let fx: Fixture;
let app: TestApp;
let dm: TestClient;
let codm: TestClient;
let player: TestClient;
let stranger: TestClient;
let campaignId: string;
let otherCampaignId: string;
let services: Awaited<ReturnType<typeof createSignedInApp>>['services'];

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const block = (name: string, text = 'hi') => ({ kind: 'block', name, definition: { content: [para(text)] } });
const base = () => `/api/campaigns/${campaignId}`;
type Item = { id: string; name: string; scope: string; deletedAt: number; canEdit: boolean };
const trash = async (c: TestClient, q = '') => (await c.get(`/api/templates/trash${q}`)).body.templates as Item[];

async function join(role: 'player' | 'codm', username: string) {
  const inv = await dm.post(`${base()}/invites`, { role });
  const c = new TestClient(app);
  expect((await c.post('/api/auth/register', { token: inv.body.token, username, displayName: username, password: 'a long enough password' })).status).toBe(201);
  return c;
}

beforeAll(async () => {
  fx = await createFixture();
  const signed = await createSignedInApp(fx);
  ({ app, client: dm, services } = signed);
  signed.services.templates.upsertBuiltins();
  campaignId = (await dm.post('/api/campaigns', { name: 'Tpl trash', ruleset: '2014' })).body.id;
  otherCampaignId = (await dm.post('/api/campaigns', { name: 'Other', ruleset: '2014' })).body.id;
  codm = await join('codm', 'cody');
  player = await join('player', 'pat');
  stranger = new TestClient(app);
  const inv = await dm.post(`/api/campaigns/${otherCampaignId}/invites`, { role: 'player' });
  expect((await stranger.post('/api/auth/register', { token: inv.body.token, username: 'sam', displayName: 'sam', password: 'a long enough password' })).status).toBe(201);
}, 30_000);
afterAll(() => fx.cleanup());

describe('templates trash', () => {
  it('lists and restores a personal template, newest deletion first, without definitions', async () => {
    const a = (await dm.post('/api/templates', { ...block('Mine A'), scope: 'user' })).body;
    const b = (await dm.post('/api/templates', { ...block('Mine B'), scope: 'user' })).body;
    expect((await trash(dm)).map((t) => t.name)).not.toContain('Mine A');
    await dm.delete(`/api/templates/${a.id}`);
    await dm.delete(`/api/templates/${b.id}`);
    expect((await dm.get(`/api/templates/${a.id}`)).status).toBe(404);
    const list = await trash(dm);
    expect(list.map((t) => t.name)).toEqual(expect.arrayContaining(['Mine A', 'Mine B']));
    expect(list.map((t) => t.deletedAt)).toEqual([...list.map((t) => t.deletedAt)].sort((x, y) => y - x));
    expect(list.every((t) => !('definition' in t) && typeof t.deletedAt === 'number' && t.scope !== 'global')).toBe(true);

    const res = await dm.post(`/api/templates/${a.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: a.id, name: 'Mine A', version: 1, canEdit: true });
    expect((await dm.get(`/api/templates/${a.id}`)).status).toBe(200);
    expect((await dm.get('/api/templates')).body.templates.map((t: { id: string }) => t.id)).toContain(a.id);
    expect((await trash(dm)).map((t) => t.name)).not.toContain('Mine A');
    expect((await dm.post(`/api/templates/${a.id}/restore`)).status).toBe(404); // already live
  });

  it('permission matrix: personal templates are the owner only', async () => {
    const t = (await dm.post('/api/templates', { ...block('Private'), scope: 'user' })).body;
    await dm.delete(`/api/templates/${t.id}`);
    for (const who of [codm, player, stranger]) {
      expect((await trash(who)).map((x) => x.id)).not.toContain(t.id);
      expect((await who.post(`/api/templates/${t.id}/restore`)).status).toBe(404);
    }
    expect((await new TestClient(app).get('/api/templates/trash')).status).toBe(401);
    expect((await new TestClient(app).post(`/api/templates/${t.id}/restore`)).status).toBe(401);
    expect((await trash(dm)).map((x) => x.id)).toContain(t.id);
  });

  it('permission matrix: campaign templates are for the DM and co-DM, never players or other campaigns', async () => {
    const t = (await dm.post('/api/templates', { ...block('Camp tpl'), scope: 'campaign', campaignId })).body;
    await dm.delete(`/api/templates/${t.id}`);
    expect((await trash(dm, `?campaignId=${campaignId}`)).map((x) => x.id)).toContain(t.id);
    expect((await trash(dm, `?campaignId=${otherCampaignId}`)).map((x) => x.id)).not.toContain(t.id);
    expect((await trash(codm)).map((x) => x.id)).toContain(t.id);
    for (const who of [player, stranger]) {
      expect(await trash(who)).toEqual([]);
      expect(await trash(who, `?campaignId=${campaignId}`)).toEqual([]);
      expect((await who.post(`/api/templates/${t.id}/restore`)).status).toBe(404);
    }
    expect((await codm.post(`/api/templates/${t.id}/restore`)).status).toBe(200);
    expect((await player.get(`/api/templates/${t.id}`)).status).toBe(404);
    expect((await codm.get(`/api/templates/${t.id}`)).status).toBe(200);
  });

  it('never exposes built-ins, which cannot be deleted', async () => {
    const npc = (await dm.get('/api/templates')).body.templates.find((t: { builtinKey: string }) => t.builtinKey === 'npc');
    expect((await dm.delete(`/api/templates/${npc.id}`)).status).toBe(403);
    expect((await dm.post(`/api/templates/${npc.id}/restore`)).status).toBe(404);
    expect((await trash(dm)).some((t) => t.scope === 'global')).toBe(false);
  });

  it('restoring keeps linked instances in step with new versions', async () => {
    const t = (await dm.post('/api/templates', { ...block('Trap', 'DC one'), scope: 'campaign', campaignId })).body;
    const inst = (await dm.post(`${base()}/templates/${t.id}/instantiate`, { values: {}, mode: 'linked' })).body.content;
    const page = (await dm.post(`${base()}/pages`, { title: 'Road' })).body;
    expect((await dm.patch(`${base()}/pages/${page.id}`, { revision: page.revision, body: { type: 'doc', content: inst } })).status).toBe(200);
    await dm.delete(`/api/templates/${t.id}`);
    expect((await dm.put(`/api/templates/${t.id}`, { version: 1, definition: { content: [para('x')] } })).status).toBe(404);

    expect((await dm.post(`/api/templates/${t.id}/restore`)).status).toBe(200);
    expect((await dm.get(`/api/templates/${t.id}/usage`)).body.usage).toHaveLength(1);
    const saved = await dm.put(`/api/templates/${t.id}`, { version: 1, definition: { content: [para('DC two')] } });
    expect(saved.status).toBe(200);
    expect(saved.body.propagated).toBe(1);
    expect(JSON.stringify((await dm.get(`${base()}/pages/${page.id}`)).body.body)).toContain('DC two');
  });

  it('refuses a page template whose parent is still in the trash, with a readable error', async () => {
    const parent = (await dm.post('/api/templates', { kind: 'page', name: 'Parent', scope: 'user', definition: { pageType: 'generic', body: [para('p')] } })).body;
    expect(parent.id).toBeTruthy();
    const child = await dm.post('/api/templates', { kind: 'page', name: 'Child', scope: 'user', definition: { pageType: 'generic', extendsRef: parent.id, body: [para('c')] } });
    expect(child.status).toBe(201);
    await dm.delete(`/api/templates/${child.body.id}`);
    await dm.delete(`/api/templates/${parent.id}`);
    const res = await dm.post(`/api/templates/${child.body.id}/restore`);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/Parent.*trash/);
    expect((await trash(dm)).map((t) => t.id)).toContain(child.body.id);
    expect((await dm.post(`/api/templates/${parent.id}/restore`)).status).toBe(200);
    expect((await dm.post(`/api/templates/${child.body.id}/restore`)).status).toBe(200);
  });

  it('co-DMs can list, update, use and delete campaign templates, and see their usage', async () => {
    const t = (await dm.post('/api/templates', { ...block('Shared', 'one'), scope: 'campaign', campaignId })).body;
    expect((await codm.get(`/api/templates?campaignId=${campaignId}`)).body.templates.map((x: { id: string }) => x.id)).toContain(t.id);
    expect((await codm.get(`/api/templates/${t.id}`)).body.canEdit).toBe(true);
    const inst = (await dm.post(`${base()}/templates/${t.id}/instantiate`, { values: {}, mode: 'linked' })).body.content;
    const page = (await dm.post(`${base()}/pages`, { title: 'Shared use' })).body;
    expect((await dm.patch(`${base()}/pages/${page.id}`, { revision: page.revision, body: { type: 'doc', content: inst } })).status).toBe(200);
    expect((await codm.get(`/api/templates/${t.id}/usage`)).body.usage).toHaveLength(1);
    expect((await codm.put(`/api/templates/${t.id}`, { version: 1, name: 'Shared v2' })).status).toBe(200);
    expect((await codm.delete(`/api/templates/${t.id}`)).status).toBe(204);
    expect((await trash(codm)).map((x) => x.id)).toContain(t.id);
    // Players still see none of it.
    expect((await player.get(`/api/templates/${t.id}/usage`)).status).toBe(404);
    expect((await player.put(`/api/templates/${t.id}`, { version: 2, name: 'x' })).status).toBe(404);
  });

  it('restoring does not bring back the campaign default', async () => {
    const t = (await dm.post('/api/templates', { kind: 'page', name: 'Default', scope: 'campaign', campaignId, definition: { pageType: 'generic', body: [para('d')] } })).body;
    expect((await dm.put(`${base()}/template-defaults`, { pageType: 'generic', templateId: t.id })).status).toBe(200);
    expect(JSON.stringify((await dm.get(`${base()}/template-defaults`)).body)).toContain(t.id);
    await dm.delete(`/api/templates/${t.id}`);
    expect((await dm.post(`/api/templates/${t.id}/restore`)).status).toBe(200);
    expect(JSON.stringify((await dm.get(`${base()}/template-defaults`)).body)).not.toContain(t.id);
  });
});

const tplRow = (id: string) => fx.db.select({ id: templates.id }).from(templates).where(eq(templates.id, id)).get();
const nRows = (table: typeof templateVersions | typeof templateUsage | typeof campaignTemplateDefaults, col: unknown, id: string) =>
  fx.db.select({ n: count() }).from(table).where(eq(col as never, id)).get()!.n;
const ageTemplate = (id: string, ms: number) => fx.db.update(templates).set({ deletedAt: Date.now() - ms }).where(eq(templates.id, id)).run();
const pageTpl = (name: string, extra: Record<string, unknown> = {}) => ({ kind: 'page', name, scope: 'user', definition: { pageType: 'generic', body: [para(name)], ...extra } });

describe('templates purge', () => {
  it('purges a trashed personal template for the owner only', async () => {
    const t = (await dm.post('/api/templates', { ...block('Gone'), scope: 'user' })).body;
    expect((await dm.delete(`/api/templates/${t.id}/purge`)).status).toBe(400); // live
    expect(tplRow(t.id)).toBeTruthy();
    await dm.delete(`/api/templates/${t.id}`);
    for (const who of [codm, player, stranger]) expect((await who.delete(`/api/templates/${t.id}/purge`)).status).toBe(404);
    expect((await new TestClient(app).delete(`/api/templates/${t.id}/purge`)).status).toBe(401);
    expect(tplRow(t.id)).toBeTruthy();
    const res = await dm.delete(`/api/templates/${t.id}/purge`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ purged: [t.id] });
    expect(tplRow(t.id)).toBeUndefined();
    expect((await trash(dm)).map((x) => x.id)).not.toContain(t.id);
    expect((await dm.post(`/api/templates/${t.id}/restore`)).status).toBe(404);
    expect((await dm.delete(`/api/templates/${t.id}/purge`)).status).toBe(404);
  });

  it('campaign templates: DM and co-DM may purge, players and other campaigns get 404; a live one is refused', async () => {
    const t = (await dm.post('/api/templates', { ...block('Camp gone'), scope: 'campaign', campaignId })).body;
    expect((await player.delete(`/api/templates/${t.id}/purge`)).status).toBe(404); // live and not editable: no hint
    expect((await codm.delete(`/api/templates/${t.id}/purge`)).status).toBe(400);
    await dm.delete(`/api/templates/${t.id}`);
    for (const who of [player, stranger]) expect((await who.delete(`/api/templates/${t.id}/purge`)).status).toBe(404);
    expect((await codm.delete(`/api/templates/${t.id}/purge`)).body).toEqual({ purged: [t.id] });
    expect(tplRow(t.id)).toBeUndefined();
    const t2 = (await dm.post('/api/templates', { ...block('Camp gone 2'), scope: 'campaign', campaignId })).body;
    await dm.delete(`/api/templates/${t2.id}`);
    expect((await dm.delete(`/api/templates/${t2.id}/purge`)).status).toBe(200);
  });

  it('never purges built-ins', async () => {
    const npc = (await dm.get('/api/templates')).body.templates.find((t: { builtinKey: string }) => t.builtinKey === 'npc');
    expect((await dm.delete(`/api/templates/${npc.id}/purge`)).status).toBe(404);
    expect(tplRow(npc.id)).toBeTruthy();
    // even a built-in row that somehow carries a deletedAt is not touched by the scheduler
    fx.db.update(templates).set({ deletedAt: Date.now() - TRASH_RETENTION_MS - 1000 }).where(eq(templates.id, npc.id)).run();
    expect(services.templates.purgeExpired(Date.now() - TRASH_RETENTION_MS)).toBe(0);
    expect(tplRow(npc.id)).toBeTruthy();
    fx.db.update(templates).set({ deletedAt: null }).where(eq(templates.id, npc.id)).run();
  });

  it('removes versions, usage and default rows; pages made from it keep their content and lose the link; instances keep content', async () => {
    const b = (await dm.post('/api/templates', { ...block('Trap b', 'DC one'), scope: 'campaign', campaignId })).body;
    expect((await dm.put(`/api/templates/${b.id}`, { version: 1, definition: { content: [para('DC two')] } })).status).toBe(200);
    const inst = (await dm.post(`${base()}/templates/${b.id}/instantiate`, { values: {}, mode: 'linked' })).body.content;
    const host = (await dm.post(`${base()}/pages`, { title: 'Host' })).body;
    expect((await dm.patch(`${base()}/pages/${host.id}`, { revision: host.revision, body: { type: 'doc', content: inst } })).status).toBe(200);

    const p = (await dm.post('/api/templates', { ...pageTpl('Page src'), scope: 'campaign', campaignId })).body;
    const made = (await dm.post(`${base()}/pages/from-template`, { templateId: p.id, title: 'Made' })).body;
    expect(fx.db.select({ f: pages.fromTemplateId }).from(pages).where(eq(pages.id, made.id)).get()!.f).toBe(p.id);

    expect(nRows(templateVersions, templateVersions.templateId, b.id)).toBe(2);
    expect(nRows(templateUsage, templateUsage.templateId, b.id)).toBe(1);
    await dm.delete(`/api/templates/${b.id}`);
    await dm.delete(`/api/templates/${p.id}`);
    fx.db.insert(campaignTemplateDefaults).values({ campaignId, pageType: 'npc', templateId: p.id }).run(); // as if still set
    expect(nRows(templateUsage, templateUsage.templateId, b.id)).toBe(1); // soft delete keeps usage (restorable)

    expect((await dm.delete(`/api/templates/${b.id}/purge`)).status).toBe(200);
    expect((await dm.delete(`/api/templates/${p.id}/purge`)).status).toBe(200);
    expect(nRows(templateVersions, templateVersions.templateId, b.id)).toBe(0);
    expect(nRows(templateUsage, templateUsage.templateId, b.id)).toBe(0);
    expect(nRows(campaignTemplateDefaults, campaignTemplateDefaults.templateId, p.id)).toBe(0);

    const hostNow = (await dm.get(`${base()}/pages/${host.id}`)).body;
    expect(hostNow.deletedAt ?? null).toBeNull();
    expect(JSON.stringify(hostNow.body)).toContain('DC two');
    const madeNow = (await dm.get(`${base()}/pages/${made.id}`)).body;
    expect(madeNow.title).toBe('Made');
    expect(JSON.stringify(madeNow.body)).toContain('Page src');
    expect(fx.db.select({ f: pages.fromTemplateId, v: pages.fromTemplateVersion }).from(pages).where(eq(pages.id, made.id)).get()).toEqual({ f: null, v: null });
    // a later save of the host page still works
    const cur = (await dm.get(`${base()}/pages/${host.id}`)).body;
    expect((await dm.patch(`${base()}/pages/${host.id}`, { revision: cur.revision, title: 'Host 2' })).status).toBe(200);
  });

  it('a child template of a purged parent is still there and reports an issue; it can be edited and restored', async () => {
    const parent = (await dm.post('/api/templates', pageTpl('Par'))).body;
    const child = (await dm.post('/api/templates', pageTpl('Kid', { extendsRef: parent.id }))).body;
    expect((await dm.get(`/api/templates/${child.id}`)).body.issues).toEqual([]);
    await dm.delete(`/api/templates/${parent.id}`);
    expect((await dm.delete(`/api/templates/${parent.id}/purge`)).status).toBe(200);
    const got = await dm.get(`/api/templates/${child.id}`);
    expect(got.status).toBe(200);
    expect(got.body.issues.length).toBeGreaterThan(0);
    const keep = await dm.put(`/api/templates/${child.id}`, { version: 1, name: 'Kid 2', definition: { pageType: 'generic', extendsRef: parent.id, body: [para('k')] } });
    expect(keep.status).toBe(400); // an edit that keeps the dangling parent is refused: change or clear it in the same save
    expect(JSON.stringify(keep.body)).toContain('template to extend was not found');
    expect((await dm.put(`/api/templates/${child.id}`, { version: 1, name: 'Kid 2', definition: { pageType: 'generic', body: [para('k')] } })).status).toBe(200);
    // a trashed child whose parent was purged can be restored (nothing is in the way)
    const child2 = (await dm.post('/api/templates', pageTpl('Kid3', { extendsRef: 'builtin:npc' }))).body;
    await dm.delete(`/api/templates/${child2.id}`);
    expect((await dm.post(`/api/templates/${child2.id}/restore`)).status).toBe(200);
  });

  it('the scheduler purges templates deleted more than 30 days ago, and only those', async () => {
    services.templates.purgeExpired(Date.now() + 365 * 86_400_000); // start from an empty trash: the count below is exact
    const old = (await dm.post('/api/templates', { ...block('Old'), scope: 'user' })).body;
    const oldCamp = (await dm.post('/api/templates', { ...block('Old camp'), scope: 'campaign', campaignId })).body;
    const fresh = (await dm.post('/api/templates', { ...block('Fresh'), scope: 'user' })).body;
    const live = (await dm.post('/api/templates', { ...block('Live'), scope: 'user' })).body;
    for (const t of [old, oldCamp, fresh]) await dm.delete(`/api/templates/${t.id}`);
    ageTemplate(old.id, TRASH_RETENTION_DAYS * 86_400_000 + 1000);
    ageTemplate(oldCamp.id, TRASH_RETENTION_DAYS * 86_400_000 + 1000);
    ageTemplate(fresh.id, TRASH_RETENTION_MS - 3_600_000);
    const log = vi.fn();
    let running = false;
    const purger = new TrashPurger({ pages: services.pages, templates: services.templates, backups: { isRunning: () => running }, config: { dataDir: fx.config.dataDir }, log });
    running = true; // deferred during a backup
    expect(purger.runOnce()).toBeNull();
    expect(tplRow(old.id)).toBeTruthy();
    running = false;
    expect(purger.runOnce()).toBe(2);
    expect(tplRow(old.id)).toBeUndefined();
    expect(tplRow(oldCamp.id)).toBeUndefined();
    expect(tplRow(fresh.id)).toBeTruthy();
    expect(tplRow(live.id)).toBeTruthy();
    expect(log).toHaveBeenCalledWith('Trash: 2 templates deleted more than 30 days ago removed for good');
    expect(purger.lastRunFailed).toBe(false);
    expect(await trash(player)).toEqual([]);
    expect((await trash(dm)).map((x) => x.id)).toContain(fresh.id);
  });

  it('defers while a restore marker exists and skips on a wrong clock', async () => {
    const t = (await dm.post('/api/templates', { ...block('Marker'), scope: 'user' })).body;
    await dm.delete(`/api/templates/${t.id}`);
    ageTemplate(t.id, TRASH_RETENTION_MS + 1000);
    const dir = mkdtempSync(joinPath(tmpdir(), 'cn-marker-'));
    try {
      writeFileSync(joinPath(dir, RESTORE_MARKER), '{}');
      const deferred = new TrashPurger({ pages: services.pages, templates: services.templates, backups: { isRunning: () => false }, config: { dataDir: dir }, log: () => {} });
      expect(deferred.runOnce()).toBeNull();
      expect(tplRow(t.id)).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const log = vi.fn();
    const behind = new TrashPurger({ pages: services.pages, templates: services.templates, backups: { isRunning: () => false }, config: { dataDir: fx.config.dataDir }, now: () => 1000, log });
    expect(behind.runOnce()).toBeNull(); // the clock is far behind the newest template change
    expect(tplRow(t.id)).toBeTruthy();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('clock'));
    expect(new TrashPurger({ pages: services.pages, templates: services.templates, backups: { isRunning: () => false }, config: { dataDir: fx.config.dataDir }, log: () => {} }).runOnce()).toBeGreaterThanOrEqual(1);
    expect(tplRow(t.id)).toBeUndefined();
  });

  it('keeps assistants away from the template trash and from purge', () => {
    expect(isAllowed('GET', '/api/templates')).toBe(true);
    expect(isAllowed('GET', '/api/templates/abc123')).toBe(true);
    expect(isAllowed('GET', '/api/templates/trash')).toBe(false);
    expect(isAllowed('GET', '/api/templates/trash/')).toBe(false);
    expect(isAllowed('GET', '/api/templates/trash/purge')).toBe(false);
    expect(isAllowed('GET', '/api/templates/trash\n')).toBe(false);
    expect(isAllowed('GET', '/api/templates/trash\r')).toBe(false);
    expect(isAllowed('GET', '/api/templates/%74rash')).toBe(true); // an ordinary (unknown) id for the app: a 404, not the trash
    expect(isAllowed('GET', '/api/templates/export')).toBe(false);
    expect(isAllowed('GET', '/api/templates/export\n')).toBe(false);
    expect(isAllowed('GET', '/api/templates/a\nb')).toBe(false);
    expect(isAllowed('DELETE', '/api/templates/abc123/purge')).toBe(false);
    expect(isAllowed('DELETE', '/api/templates/trash/purge')).toBe(false);
    expect(isAllowed('POST', '/api/templates/abc123/restore')).toBe(false);
    expect(isAllowed('POST', '/api/templates/abc123/purge')).toBe(false);
  });

  it('keeps a template deleted exactly at the cutoff, purges one just before it', () => {
    const cutoff = 5_000_000_000_000;
    const mk = (id: string, deletedAt: number) =>
      fx.db.insert(templates).values({ id, kind: 'block', scope: 'user', name: id, definition: { content: [] }, deletedAt }).run();
    services.templates.purgeExpired(Date.now() + 365 * 86_400_000);
    mk('edge-at', cutoff);
    mk('edge-before', cutoff - 1);
    expect(services.templates.purgeExpired(cutoff)).toBe(1);
    expect(tplRow('edge-at')).toBeTruthy();
    expect(tplRow('edge-before')).toBeUndefined();
    services.templates.purgeExpired(Date.now() + 365 * 86_400_000);
  });

  it('purges more than 500 templates in chunks', () => {
    services.templates.purgeExpired(Date.now() + 365 * 86_400_000);
    for (let i = 0; i < 1203; i++) fx.db.insert(templates).values({ id: `bulk-${i}`, kind: 'block', scope: 'user', name: `b${i}`, definition: { content: [] }, deletedAt: 1000 }).run();
    fx.db.insert(templateVersions).values({ templateId: 'bulk-1100', version: 1, definition: { content: [] } }).run();
    expect(services.templates.purgeExpired(2000)).toBe(1203);
    expect(fx.db.select({ n: count() }).from(templates).where(eq(templates.deletedAt, 1000)).get()!.n).toBe(0);
    expect(nRows(templateVersions, templateVersions.templateId, 'bulk-1100')).toBe(0);
  });

  it('newestActivity is the newest updatedAt or deletedAt, and the purger honours it', () => {
    const newest = services.templates.newestActivity();
    expect(newest).toBeGreaterThan(0);
    fx.db.insert(templates).values({ id: 'future-del', kind: 'block', scope: 'user', name: 'f', definition: { content: [] }, deletedAt: newest + 5_000_000 }).run();
    expect(services.templates.newestActivity()).toBe(newest + 5_000_000);
    fx.db.delete(templates).where(eq(templates.id, 'future-del')).run();
    expect(services.templates.newestActivity()).toBe(newest);
  });

  it('the purger isolates pages and templates: one failing kind does not stop the other', () => {
    const t = fx.db.insert(templates).values({ id: 'iso-1', kind: 'block', scope: 'user', name: 'iso', definition: { content: [] }, deletedAt: 1000 }).run();
    expect(t).toBeTruthy();
    const mkPurger = (pagesFn: (c: number) => number, tplFn: (c: number) => number, log: (m: string) => void) =>
      new TrashPurger({ pages: { purgeExpired: pagesFn }, templates: { purgeExpired: tplFn }, backups: { isRunning: () => false }, config: { dataDir: fx.config.dataDir }, log });
    const log = vi.fn();
    const tplOk = vi.fn(() => 2);
    const a = mkPurger(() => { throw new Error('pages down'); }, tplOk, log);
    expect(a.runOnce()).toBe(2); // partial count
    expect(tplOk).toHaveBeenCalled();
    expect(a.lastRunFailed).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('pages down'));
    const log2 = vi.fn();
    const pagesOk = vi.fn(() => 3);
    const b = mkPurger(pagesOk, () => { throw new Error('templates down'); }, log2);
    expect(b.runOnce()).toBe(3);
    expect(pagesOk).toHaveBeenCalled();
    expect(b.lastRunFailed).toBe(true);
    expect(log2).toHaveBeenCalledWith(expect.stringContaining('templates down'));
    expect(log2).toHaveBeenCalledWith(expect.stringContaining('trying again tomorrow'));
    // a later healthy pass clears the flag
    expect(mkPurger(() => 0, () => 0, () => {}).lastRunFailed).toBe(false);
    services.templates.purgeExpired(Date.now() + 365 * 86_400_000);
  });

  it('a failing templates purge through the timer keeps the schedule going', () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const log = vi.fn();
    const p = new TrashPurger({
      pages: { purgeExpired: () => 1 },
      templates: { purgeExpired: () => { throw new Error('boom'); } },
      backups: { isRunning: () => false },
      config: { dataDir: fx.config.dataDir },
      timers: { set: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clear: () => {} },
      log,
    });
    p.start();
    timers.shift()!.fn();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(timers).toHaveLength(1); // re-armed
  });

  it('writes scope and campaign into the purge audit line', async () => {
    const t = (await dm.post('/api/templates', { ...block('Audited'), scope: 'campaign', campaignId })).body;
    await dm.delete(`/api/templates/${t.id}`);
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      expect((await dm.delete(`/api/templates/${t.id}/purge`)).status).toBe(200);
      const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('template.purged'));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'template.purged', templateId: t.id, scope: 'campaign', campaignId });
    } finally {
      spy.mockRestore();
    }
  });
});
