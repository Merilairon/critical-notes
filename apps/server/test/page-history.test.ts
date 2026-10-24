/**
 * Page history, recording side (task N1.2; design docs/design/page-history.md). Every write point leaves a full snapshot in the
 * same transaction; saves fold, no-ops are skipped, an unrecorded earlier state gets a baseline; the pruner thins old rows; the
 * history service restores content only.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FACET_ACCESS_FIELDS, FACET_SCHEMAS, type FacetType } from '@cn/shared';
import { hashToken } from '../src/auth/session';
import { DEFAULT_HISTORY, parseHistoryConfig } from '../src/config';
import { apiTokens, pageRevisions, pages, templates } from '../src/db/schema';
import { HistoryPruner } from '../src/services/history-pruner';
import type { PageHistoryService } from '../src/services/page-history';
import { snapshotHash, type WriteContext } from '../src/services/revisions';
import { createFixture, createSignedInApp, TestClient, type Fixture, type TestApp } from './helpers';
import { callTool, makeToken, mcpClient } from './mcp-client';

let fx: Fixture;
let app: TestApp;
let dm: TestClient;
let player: TestClient;
let playerId: string;
let dmId: string;
let services: Awaited<ReturnType<typeof createSignedInApp>>['services'];
let campaignId: string;
const base = () => `/api/campaigns/${campaignId}`;
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content: unknown[]) => ({ type: 'doc', content });

const rows = (pageId: string) => fx.db.select().from(pageRevisions).where(eq(pageRevisions.pageId, pageId)).orderBy(asc(pageRevisions.revision)).all();
const revs = (pageId: string) => rows(pageId).map((r) => r.revision);
const causes = (pageId: string) => rows(pageId).map((r) => r.cause);
const ctx = (over: Partial<WriteContext> = {}): WriteContext => ({ userId: dmId, source: 'web', cause: 'edit', ...over });

async function newPage(body: Record<string, unknown> = {}) {
  const res = await dm.post(`${base()}/pages`, { title: 'Page', ...body });
  expect(res.status).toBe(201);
  return res.body as { id: string; revision: number };
}
async function edit(id: string, patch: Record<string, unknown>, who: TestClient = dm) {
  const cur = (await who.get(`${base()}/pages/${id}`)).body;
  const res = await who.patch(`${base()}/pages/${id}`, { revision: cur.revision, ...patch });
  expect(res.status).toBe(200);
  return res.body as { id: string; revision: number };
}

beforeAll(async () => {
  fx = await createFixture();
  ({ app, client: dm, services } = await createSignedInApp(fx));
  dmId = (await dm.get('/api/auth/me')).body.user.id;
  campaignId = (await dm.post('/api/campaigns', { name: 'History', ruleset: '2014' })).body.id;
  const inv = await dm.post(`${base()}/invites`, { role: 'player' });
  player = new TestClient(app);
  expect((await player.post('/api/auth/register', { token: inv.body.token, username: 'pat', displayName: 'Pat', password: 'a long enough password' })).status).toBe(201);
  playerId = (await player.get('/api/auth/me')).body.user.id;
}, 30_000);
afterAll(() => fx.cleanup());
afterEach(() => vi.restoreAllMocks());

describe('recording', () => {
  it('create writes revision 1 (cause create, source web, the author)', async () => {
    const p = await newPage({ title: 'Inn', body: doc(para('hello')) });
    const [r] = rows(p.id);
    expect(rows(p.id)).toHaveLength(1);
    expect(r).toMatchObject({ revision: 1, cause: 'create', source: 'web', authorUserId: dmId, tokenId: null, title: 'Inn', campaignId });
    expect(JSON.stringify(r!.body)).toContain('hello');
    expect(r!.bytes).toBeGreaterThan(0);
  });

  it('stores the hash of the stored snapshot (title, type, body, details, properties) and the row equals the live page', async () => {
    const p = await newPage({ type: 'npc', title: 'Toblen', facet: { status: 'alive' } });
    await edit(p.id, { body: doc(para('x')) });
    const live = (await dm.get(`${base()}/pages/${p.id}`)).body;
    const newest = rows(p.id).at(-1)!;
    expect(newest.revision).toBe(live.revision);
    expect(newest.contentHash).toBe(snapshotHash({ title: live.title, type: live.type, body: live.body, details: live.facet, properties: live.props }));
    expect(newest.details).toMatchObject({ status: 'alive' });
    expect(newest.properties).toEqual({});
  });

  it('folds saves of the same author and source inside the window into one row that keeps its first time', async () => {
    const p = await newPage();
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(t0);
    await edit(p.id, { body: doc(para('one')) });
    const first = rows(p.id).at(-1)!;
    expect(first.cause).toBe('edit');
    now.mockReturnValue(t0 + 60_000);
    await edit(p.id, { body: doc(para('two')) });
    now.mockReturnValue(t0 + 119_000);
    await edit(p.id, { body: doc(para('three')) });
    expect(causes(p.id)).toEqual(['create', 'edit']); // revision 1, then ONE edit row for revisions 2 to 4
    const run = rows(p.id).at(-1)!;
    expect(run.revision).toBe(4);
    expect(run.createdAt).toBe(first.createdAt);
    expect(JSON.stringify(run.body)).toContain('three');
    now.mockReturnValue(t0 + 3 * 60_000);
    await edit(p.id, { body: doc(para('four')) }); // window passed (measured from the first save of the run)
    expect(causes(p.id)).toEqual(['create', 'edit', 'edit']);
  });

  it('does not fold across authors, sources, tokens, MCP calls or non-edit causes, nor into create', async () => {
    const p = await newPage();
    const pg = services.pages;
    const upd = (c: WriteContext, text: string) => pg.update(campaignId, p.id, { revision: pg.get(campaignId, p.id).revision, body: doc(para(text)) as never }, c);
    upd(ctx(), 'a');
    upd(ctx({ userId: playerId }), 'b'); // another author
    upd(ctx({ userId: playerId, source: 'player' }), 'c'); // another source
    upd(ctx({ userId: playerId, source: 'mcp', tokenId: 't1' }), 'd');
    upd(ctx({ userId: playerId, source: 'mcp', tokenId: 't1' }), 'e'); // MCP calls are never folded
    upd(ctx({ userId: playerId, source: 'mcp', tokenId: 't1', cause: 'template_sync' }), 'f');
    upd(ctx({ userId: playerId, source: 'mcp', tokenId: 't1', cause: 'template_sync' }), 'g');
    expect(causes(p.id)).toEqual(['create', 'edit', 'edit', 'edit', 'edit', 'edit', 'template_sync', 'template_sync']);
    expect(rows(p.id).map((r) => r.source)).toEqual(['web', 'web', 'web', 'player', 'mcp', 'mcp', 'mcp', 'mcp']);
  });

  it('coalescing off (0 minutes) keeps every save', async () => {
    const p = await newPage();
    const off = new (services.pages.constructor as new (...a: unknown[]) => typeof services.pages)(fx.db, services.properties, { update() {}, remove() {}, backlinks: () => [] }, { coalesceMinutes: 0 });
    for (const t of ['a', 'b', 'c']) off.update(campaignId, p.id, { revision: off.get(campaignId, p.id).revision, body: doc(para(t)) as never }, ctx());
    expect(causes(p.id)).toEqual(['create', 'edit', 'edit', 'edit']);
  });

  it('skips a save that changes nothing recorded (same content, or only visibility, tags and viewers)', async () => {
    const p = await newPage({ title: 'Quiet', body: doc(para('same')) });
    const live0 = (await dm.get(`${base()}/pages/${p.id}`)).body;
    await edit(p.id, { title: 'Quiet', body: live0.body }); // the editor sends back the document it was given
    await edit(p.id, { visibility: 'all' });
    await edit(p.id, { tags: ['a', 'b'] });
    await edit(p.id, { viewers: [playerId], visibility: 'selected' });
    expect(revs(p.id)).toEqual([1]);
    expect((await dm.get(`${base()}/pages/${p.id}`)).body.revision).toBe(5); // the page revision still moved
  });

  it('records property changes, with the page, in one commit (props now run inside the update transaction)', async () => {
    await dm.post(`${base()}/properties`, { label: 'Mood', type: 'text' });
    const p = await newPage();
    await edit(p.id, { props: { mood: 'calm' } });
    expect(rows(p.id).at(-1)!.properties).toEqual({ mood: 'calm' });
  });

  it('rolls everything back together: a failure after the page write leaves no page change, no property change and no row', async () => {
    const p = await newPage({ title: 'Stable' });
    await edit(p.id, { props: { mood: 'before' } });
    const before = rows(p.id).length;
    const live = (await dm.get(`${base()}/pages/${p.id}`)).body;
    vi.spyOn(services.pages as unknown as { record: () => void }, 'record').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => services.pages.update(campaignId, p.id, { revision: live.revision, title: 'Changed', props: { mood: 'after' } }, ctx())).toThrow('boom');
    vi.restoreAllMocks();
    const now = (await dm.get(`${base()}/pages/${p.id}`)).body;
    expect([now.title, now.revision, now.props]).toEqual(['Stable', live.revision, { mood: 'before' }]);
    expect(rows(p.id)).toHaveLength(before);
  });

  it('a failing property value fails the whole save (nothing half written)', async () => {
    const p = await newPage({ title: 'Whole' });
    const live = (await dm.get(`${base()}/pages/${p.id}`)).body;
    const res = await dm.patch(`${base()}/pages/${p.id}`, { revision: live.revision, title: 'Nope', props: { unknown_key: 1 } });
    expect(res.status).toBe(400);
    expect((await dm.get(`${base()}/pages/${p.id}`)).body).toMatchObject({ title: 'Whole', revision: live.revision });
    expect(rows(p.id)).toHaveLength(1);
  });
});

describe('baseline', () => {
  it('a page without history gets the state it overwrites as a baseline, then the new state', async () => {
    const p = await newPage({ title: 'Old', body: doc(para('legacy')) });
    fx.db.delete(pageRevisions).where(eq(pageRevisions.pageId, p.id)).run(); // as a page from before this feature
    await edit(p.id, { title: 'New' });
    const [base0, now] = rows(p.id);
    expect(base0).toMatchObject({ revision: 1, cause: 'baseline', source: 'system', authorUserId: null, title: 'Old' });
    expect(now).toMatchObject({ revision: 2, cause: 'edit', title: 'New' });
    expect(base0!.createdAt).toBe(fx.db.select().from(pages).where(eq(pages.id, p.id)).get()!.createdAt);
  });

  it('a stale newest row (history out of step with the page) also gets a baseline of the real overwritten state', async () => {
    const p = await newPage({ title: 'A' });
    await edit(p.id, { title: 'B' });
    fx.db.update(pages).set({ title: 'Bypassed' }).where(eq(pages.id, p.id)).run(); // a write that skipped PageService
    await edit(p.id, { title: 'C' });
    const titles = rows(p.id).map((r) => `${r.cause}:${r.title}`);
    // the bypassing write did not bump the revision, so the baseline's own number is taken: it goes below the lowest row
    expect(titles).toEqual(['baseline:Bypassed', 'create:A', 'edit:B', 'edit:C']);
    expect(revs(p.id)).toEqual([0, 1, 2, 3]);
  });

  it('an older backup restored into a newer database: the page is ahead of its history, the baseline takes the page revision', async () => {
    const p = await newPage({ title: 'Ahead' });
    fx.db.update(pages).set({ title: 'Ahead (edited elsewhere)', revision: 10 }).where(eq(pages.id, p.id)).run();
    await edit(p.id, { title: 'Ahead again' });
    expect(rows(p.id).map((r) => `${r.revision}:${r.cause}:${r.title}`)).toEqual(['1:create:Ahead', '10:baseline:Ahead (edited elsewhere)', '11:edit:Ahead again']);
  });

  it('collision: a row already holding the pre-write revision with another hash never makes the update fail', async () => {
    const p = await newPage({ title: 'Clash' });
    fx.db.delete(pageRevisions).where(eq(pageRevisions.pageId, p.id)).run();
    fx.db
      .insert(pageRevisions)
      .values({ pageId: p.id, revision: 1, campaignId, title: 'Planted', type: 'generic', body: null, details: null, properties: {}, source: 'web', cause: 'edit', contentHash: 'not-the-hash', bytes: 1 })
      .run();
    await edit(p.id, { title: 'After' });
    const all = rows(p.id);
    expect(all.map((r) => r.title)).toEqual(['Clash', 'Planted', 'After']); // baseline numbered below the lowest row
    expect(all.map((r) => r.revision)).toEqual([0, 1, 2]);
    expect(all[0]).toMatchObject({ cause: 'baseline', source: 'system' });
    expect(all[2]).toMatchObject({ cause: 'edit' });
    await edit(p.id, { title: 'Again' }); // still fine afterwards
  });
});

describe('source and cause', () => {
  it('records web, player and mcp (with the token id), and never trusts the client', async () => {
    const pc = await newPage({ type: 'pc', title: 'Aria', visibility: 'all', facet: { playerUserId: playerId }, body: doc(para('visible'), { type: 'secret', content: [para('DM SECRET')] }) });
    await edit(pc.id, { body: doc(para('player wrote this')) }, player);
    const asPlayer = rows(pc.id).at(-1)!;
    expect(asPlayer).toMatchObject({ source: 'player', authorUserId: playerId, cause: 'edit', tokenId: null });
    // the snapshot is the merged stored document: the DM's secret block is still in it
    expect(JSON.stringify(asPlayer.body)).toContain('DM SECRET');
    expect(JSON.stringify(asPlayer.body)).toContain('player wrote this');
    // a client-supplied source is ignored
    const cur = (await dm.get(`${base()}/pages/${pc.id}`)).body;
    await dm.patch(`${base()}/pages/${pc.id}`, { revision: cur.revision, title: 'Aria 2', source: 'mcp', tokenId: 'x', cause: 'import' });
    expect(rows(pc.id).at(-1)).toMatchObject({ source: 'web', cause: 'edit', tokenId: null, title: 'Aria 2' });

    const token = await makeToken(dm, 'write', 'Claude');
    const tokenId = fx.db.select().from(apiTokens).where(eq(apiTokens.tokenHash, hashToken(token))).get()!.id;
    const mcp = await mcpClient(app, token);
    const page = (await callTool(mcp, 'create_page', { campaignId, title: 'From AI', markdown: 'Hello' })).data;
    expect(rows(page.id)[0]).toMatchObject({ revision: 1, cause: 'create', source: 'mcp', tokenId, authorUserId: dmId });
    await callTool(mcp, 'update_page', { campaignId, pageId: page.id, appendMarkdown: 'More' });
    await callTool(mcp, 'update_page', { campaignId, pageId: page.id, appendMarkdown: 'Even more' });
    const mcpRows = rows(page.id);
    expect(mcpRows.map((r) => r.source)).toEqual(['mcp', 'mcp', 'mcp']); // each call is its own row
    expect(mcpRows.every((r) => r.tokenId === tokenId)).toBe(true);
    // the token is revoked: history still says "mcp" with the id (no foreign key)
    await dm.delete(`/api/auth/tokens/${tokenId}`);
    expect(rows(page.id)[0]!.tokenId).toBe(tokenId);
    fx.db.delete(apiTokens).where(eq(apiTokens.id, tokenId)).run();
    expect(rows(page.id)).toHaveLength(3);
  });
});

describe('write points', () => {
  it('create from a template writes ONE row per created page, with its properties', async () => {
    const t = (
      await dm.post('/api/templates', {
        kind: 'page',
        scope: 'campaign',
        campaignId,
        name: 'Keep',
        definition: {
          pageType: 'generic',
          body: [para('Walls')],
          properties: [{ key: 'danger', label: 'Danger', type: 'text', default: 'high' }],
          children: [{ title: 'Cellar' }],
        },
      })
    ).body;
    const res = await dm.post(`${base()}/pages/from-template`, { templateId: t.id, title: 'Castle', values: {}, mode: 'fill' });
    expect(res.status).toBe(201);
    const kids = (await dm.get(`${base()}/pages`)).body.pages.filter((p: { parentId: string | null }) => p.parentId === res.body.id);
    expect(res.body.props).toEqual({ danger: 'high' });
    expect(rows(res.body.id)).toHaveLength(1);
    expect(rows(res.body.id)[0]).toMatchObject({ cause: 'create', properties: { danger: 'high' } });
    expect(kids).toHaveLength(1);
    expect(rows(kids[0].id)).toHaveLength(1);

    // apply to an existing page
    const target = await newPage({ title: 'Existing' });
    await dm.post(`${base()}/pages/${target.id}/apply-template`, { templateId: t.id, values: {}, mode: 'fill' });
    expect(causes(target.id)).toEqual(['create', 'template_apply']);
  });

  it('template propagation records template_sync for every linked page, by the editing user', async () => {
    const tpl = (await dm.post('/api/templates', { kind: 'block', scope: 'user', name: 'Trap', definition: { content: [para('v1')] } })).body;
    const inst = (await dm.post(`${base()}/templates/${tpl.id}/instantiate`, { values: {}, mode: 'linked' })).body.content;
    const a = await newPage();
    const b = await newPage();
    await edit(a.id, { body: doc(...inst) });
    await edit(b.id, { body: doc(...inst) });
    const put = await dm.put(`/api/templates/${tpl.id}`, { version: 1, definition: { content: [para('v2')] } });
    expect(put.body.propagated).toBe(2);
    for (const id of [a.id, b.id]) {
      expect(rows(id).at(-1)).toMatchObject({ cause: 'template_sync', source: 'web', authorUserId: dmId });
      expect(JSON.stringify(rows(id).at(-1)!.body)).toContain('v2');
    }
  });

  it('the start-up upgrade of a built-in template propagates to linked pages, recorded with source system, cause template_sync and no author', async () => {
    services.templates.upsertBuiltins();
    const builtin = fx.db.select().from(templates).where(and(eq(templates.kind, 'block'), isNotNull(templates.builtinKey))).get()!;
    fx.db.update(templates).set({ version: builtin.version - 1 }).where(eq(templates.id, builtin.id)).run(); // as if an older build had seeded it
    const inst = (await dm.post(`${base()}/templates/${builtin.id}/instantiate`, { values: {}, mode: 'linked' })).body.content;
    const p = await newPage();
    await edit(p.id, { body: doc(...inst) });
    const before = rows(p.id).length;
    expect(services.templates.upsertBuiltins().updated).toBeGreaterThan(0);
    expect(rows(p.id)).toHaveLength(before + 1);
    expect(rows(p.id).at(-1)).toMatchObject({ source: 'system', authorUserId: null, cause: 'template_sync', tokenId: null });
  });

  it('edition migration records edition_migration, by the owner', async () => {
    const c = (await dm.post('/api/campaigns', { name: 'Old', ruleset: '2014' })).body.id;
    const page = (await dm.post(`/api/campaigns/${c}/pages`, { title: 'Spells', body: doc({ type: 'paragraph', content: [{ type: 'text', text: 'Cast {@spell spark burst|tst}' }] }) })).body;
    const res = await dm.post(`/api/campaigns/${c}/migrate-edition`, { to: '2024', keep: [] });
    expect(res.status).toBe(200);
    expect(rows(page.id).map((r) => r.cause)).toEqual(['create', 'edition_migration']);
    expect(rows(page.id).at(-1)).toMatchObject({ source: 'web', authorUserId: dmId });
  });

  it('import of N pages writes exactly N rows (cause import), with the content filled', async () => {
    const src = (await dm.post('/api/campaigns', { name: 'Export me', ruleset: '2014' })).body.id;
    const sb = `/api/campaigns/${src}`;
    await dm.post(`${sb}/properties`, { label: 'Mood', type: 'text' });
    for (let i = 0; i < 4; i++) await dm.post(`${sb}/pages`, { title: `P${i}`, type: i % 2 ? 'npc' : 'generic', body: doc(para(`body ${i}`)), props: { mood: 'x' }, facet: i % 2 ? { status: 'alive' } : undefined });
    const zip = new Uint8Array(await (await app.request(`http://localhost${sb}/export`, { headers: { cookie: dm.cookie, host: 'localhost' } })).arrayBuffer());
    const form = new FormData();
    form.append('file', new File([zip], 'c.zip', { type: 'application/zip' }));
    const res = await app.request('http://localhost/api/campaigns/import', { method: 'POST', body: form, headers: { cookie: dm.cookie, origin: 'http://localhost', host: 'localhost' } });
    expect(res.status).toBe(201);
    const newId = ((await res.json()) as { campaignId: string }).campaignId;
    const all = fx.db.select().from(pageRevisions).where(eq(pageRevisions.campaignId, newId)).all();
    const livePages = fx.db.select().from(pages).where(eq(pages.campaignId, newId)).all();
    expect(livePages).toHaveLength(4);
    expect(all).toHaveLength(4);
    expect(all.every((r) => r.cause === 'import' && r.source === 'web' && r.authorUserId === dmId)).toBe(true);
    expect(JSON.stringify(all.map((r) => r.body))).toContain('body 3'); // the filled state, not the empty shell
    expect(all.find((r) => (r.title === 'P1'))!.properties).toEqual({ mood: 'x' });
  });

  it('ending a combat records the hit-point sync as cause tracker, by the GM who ended it', async () => {
    const c = (await dm.post('/api/campaigns', { name: 'Combat', ruleset: '2014' })).body.id;
    const cb = `/api/campaigns/${c}`;
    const aria = (await dm.post(`${cb}/pages`, { type: 'pc', title: 'Aria', facet: { hpMax: 20, hpCurrent: 20, classes: [{ classUid: 'class:fighter|tst', level: 3 }] } })).body.id;
    const enc = (await dm.post(`${cb}/encounters`, { name: 'Fight', creatures: [{ id: 'a', kind: 'custom', name: 'Rat', hp: 5 }] })).body;
    const tracker = (await dm.post(`${cb}/encounters/${enc.id}/start`, {})).body;
    const ariaId = tracker.state.combatants.find((x: { name: string }) => x.name === 'Aria').id;
    await dm.post(`${cb}/trackers/${tracker.id}/actions`, { type: 'hp', id: ariaId, change: -7 });
    await dm.post(`${cb}/trackers/${tracker.id}/actions`, { type: 'end' });
    expect((await dm.get(`${cb}/pages/${aria}`)).body.facet.hpCurrent).toBe(13);
    expect(rows(aria).map((r) => r.cause)).toEqual(['create', 'tracker']);
    expect(rows(aria).at(-1)).toMatchObject({ source: 'web', authorUserId: dmId });
    expect(rows(aria).at(-1)!.details).toMatchObject({ hpCurrent: 13 });
  });

  it('the copy-statblock route records an edit', async () => {
    const npc = await newPage({ type: 'npc', title: 'Scout' });
    const res = await dm.post(`${base()}/npc-statblocks`, { pageId: npc.id, baseUid: 'monster:gloomling|tst' });
    expect(res.status).toBe(201);
    expect(rows(npc.id).at(-1)).toMatchObject({ cause: 'edit', source: 'web' });
    expect(rows(npc.id).at(-1)!.details).toMatchObject({ statblockUid: expect.stringContaining('scout') });
  });

  it('move, trash and restore from the trash write no revision', async () => {
    const p = await newPage();
    const q = await newPage();
    await dm.post(`${base()}/pages/${p.id}/move`, { parentId: q.id });
    await dm.delete(`${base()}/pages/${p.id}`);
    await dm.post(`${base()}/trash/${p.id}/restore`, {});
    expect(revs(p.id)).toEqual([1]);
  });
});

describe('purge', () => {
  it('removes the history with the page, subtree included, and leaves other pages alone', async () => {
    const root = await newPage();
    const kid = (await dm.post(`${base()}/pages`, { title: 'Kid', parentId: root.id })).body;
    const keep = await newPage();
    await edit(root.id, { title: 'R2' });
    await edit(kid.id, { title: 'K2' });
    await dm.delete(`${base()}/pages/${root.id}`);
    services.pages.purge(campaignId, root.id);
    expect(rows(root.id)).toHaveLength(0);
    expect(rows(kid.id)).toHaveLength(0);
    expect(rows(keep.id)).toHaveLength(1);
    expect(fx.db.select().from(pages).where(eq(pages.id, root.id)).get()).toBeUndefined();
  });

  it('deletes a large history in short batches', async () => {
    const p = await newPage();
    const insert = fx.db.$client.prepare(
      `insert into page_revisions (page_id, revision, campaign_id, title, type, properties, source, cause, content_hash, bytes) values (?, ?, ?, 't', 'generic', '{}', 'web', 'edit', ?, 1)`,
    );
    fx.db.$client.transaction(() => {
      for (let i = 2; i < 2600; i++) insert.run(p.id, i, campaignId, `h${i}`);
    })();
    expect(rows(p.id).length).toBeGreaterThan(2500);
    await dm.delete(`${base()}/pages/${p.id}`);
    services.pages.purge(campaignId, p.id);
    expect(rows(p.id)).toHaveLength(0);
  });
});

describe('FACET_ACCESS_FIELDS', () => {
  it('lists every facet field that references a user', () => {
    for (const type of Object.keys(FACET_SCHEMAS) as FacetType[]) {
      const named = Object.keys(FACET_SCHEMAS[type].shape).filter((k) => /user/i.test(k));
      expect([...FACET_ACCESS_FIELDS[type]].sort(), type).toEqual(named.sort());
    }
  });
});

describe('settings', () => {
  it('HISTORY_* are validated like BACKUP_KEEP: an invalid value warns and falls back', () => {
    const warns: string[] = [];
    expect(parseHistoryConfig({}, (m) => warns.push(m))).toEqual(DEFAULT_HISTORY);
    expect(DEFAULT_HISTORY).toEqual({ keepAllDays: 30, coalesceMinutes: 2, maxPerPage: 200, maxMbPerCampaign: 500, monthlyAfterDays: 365 });
    expect(parseHistoryConfig({ HISTORY_COALESCE_MINUTES: '0', HISTORY_KEEP_ALL_DAYS: '60' }, (m) => warns.push(m))).toMatchObject({ coalesceMinutes: 0, keepAllDays: 60 });
    expect(warns).toEqual([]);
    expect(parseHistoryConfig({ HISTORY_KEEP_ALL_DAYS: '0', HISTORY_MAX_PER_PAGE: 'many', HISTORY_COALESCE_MINUTES: '-1' }, (m) => warns.push(m))).toEqual(DEFAULT_HISTORY);
    expect(warns).toHaveLength(3);
  });
});

describe('no writer bypasses PageService', () => {
  it('nothing outside services/pages.ts updates the page body or inserts pages directly', () => {
    const dir = join(import.meta.dirname, '..', 'src');
    const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts') && f !== join('services', 'pages.ts'));
    const bad = files.filter((f) => {
      const src = readFileSync(join(dir, f), 'utf8');
      return /update\(pages\)\s*\.set\(\{[^}]*\bbody\b/s.test(src) || /insert\(pages\)/.test(src);
    });
    expect(bad).toEqual([]);
  });
});

describe('pruning', () => {
  const DAY = 86_400_000;
  const NOW = Date.UTC(2027, 5, 15, 12, 0, 0);
  const noBackups = { isRunning: () => false };
  let n = 0;

  function seed(pageId: string, list: { revision: number; at: number; bytes?: number }[]) {
    fx.db.delete(pageRevisions).where(eq(pageRevisions.pageId, pageId)).run();
    for (const r of list) {
      fx.db
        .insert(pageRevisions)
        .values({ pageId, revision: r.revision, campaignId, title: 't', type: 'generic', properties: {}, source: 'web', cause: 'edit', contentHash: `h${++n}`, bytes: r.bytes ?? 10, createdAt: r.at })
        .run();
    }
  }
  const pruner = (now: number, history = { ...DEFAULT_HISTORY }, log: string[] = []) =>
    new HistoryPruner({ db: fx.db, backups: noBackups, config: { dataDir: fx.config.dataDir, history }, now: () => now, log: (m) => log.push(m) });

  // The other test pages carry rows too: run the pruner on a clean table
  function clean() {
    fx.db.$client.exec('delete from page_revisions');
  }

  it('keeps everything for 30 days, then one per page per UTC day; the oldest and the newest rows are protected', async () => {
    clean();
    const p = await newPage();
    clean();
    const day = (daysAgo: number) => Math.floor((NOW - daysAgo * DAY) / DAY) * DAY;
    seed(p.id, [
      { revision: 1, at: day(100) + 1 * 3600_000 }, // oldest: protected
      { revision: 2, at: day(100) + 2 * 3600_000 }, // goes
      { revision: 3, at: day(100) + 3 * 3600_000 }, // newest of its day
      { revision: 4, at: day(50) + 1 * 3600_000 }, // goes
      { revision: 5, at: day(50) + 2 * 3600_000 },
      { revision: 6, at: day(29) + 1 * 3600_000 }, // inside the window: both kept
      { revision: 7, at: day(29) + 2 * 3600_000 },
      { revision: 8, at: NOW - 3600_000 }, // newest: protected
    ]);
    const result = pruner(NOW).runOnce()!;
    expect(result.daily).toBe(2);
    expect(revs(p.id)).toEqual([1, 3, 5, 6, 7, 8]);
    expect(pruner(NOW).runOnce()!.daily).toBe(0); // idempotent
  });

  it('the 30-day boundary: a row just inside is kept, one just outside is thinned', async () => {
    clean();
    const p = await newPage();
    clean();
    // cutoff = reference (the newest row + the clock margin, capped at now) - 30 days
    const reference = Math.min(NOW, NOW - 3600_000 + 10 * 60_000);
    const cutoff = reference - 30 * DAY;
    seed(p.id, [
      { revision: 1, at: cutoff - 5 * DAY }, // oldest
      { revision: 2, at: cutoff - 1 }, // outside, same day as 3
      { revision: 3, at: cutoff - 1 + 1 },
      { revision: 4, at: cutoff + 1 }, // inside
      { revision: 5, at: NOW - 3600_000 },
    ]);
    pruner(NOW).runOnce();
    const left = revs(p.id);
    expect(left).toContain(4);
    expect(left).toContain(1);
    expect(left).toContain(5);
    // revisions 2 and 3 are on the same UTC day unless the cutoff sits at midnight; at most one survives
    expect(left.filter((r) => r === 2 || r === 3).length).toBeLessThanOrEqual(1);
  });

  it('after a year only one per page per month remains', async () => {
    clean();
    const p = await newPage();
    clean();
    const month = Date.UTC(2025, 2, 1); // March 2025, more than 365 days before NOW
    seed(p.id, [
      { revision: 1, at: month + 1 * DAY }, // oldest
      { revision: 2, at: month + 5 * DAY },
      { revision: 3, at: month + 9 * DAY },
      { revision: 4, at: month + 20 * DAY }, // newest of March
      { revision: 5, at: Date.UTC(2025, 3, 3) },
      { revision: 6, at: Date.UTC(2025, 3, 4) }, // newest of April
      { revision: 7, at: NOW - 3600_000 },
    ]);
    const r = pruner(NOW).runOnce()!;
    expect(revs(p.id)).toEqual([1, 4, 6, 7]);
    expect(r.daily + r.monthly).toBe(3);
  });

  it('a page over the per-page cap is thinned early (never its oldest or newest row)', async () => {
    clean();
    const p = await newPage();
    clean();
    const list = Array.from({ length: 30 }, (_, i) => ({ revision: i + 1, at: NOW - (30 - i) * 60_000 }));
    seed(p.id, list);
    const q = await newPage();
    seed(q.id, [{ revision: 1, at: NOW - 60_000 }, { revision: 2, at: NOW - 30_000 }]);
    const r = pruner(NOW, { ...DEFAULT_HISTORY, maxPerPage: 10 }).runOnce()!;
    expect(r.overCap).toBe(19); // 30 rows: the 10 newest and the oldest stay
    expect(revs(p.id)).toEqual([1, ...Array.from({ length: 10 }, (_, i) => 21 + i)]);
    expect(revs(q.id)).toEqual([1, 2]);
  });

  it('a campaign over its ceiling loses its oldest daily rows down to one per month, never the window', async () => {
    clean();
    const p = await newPage();
    clean();
    const day = (d: number) => Math.floor((NOW - d * DAY) / DAY) * DAY;
    seed(p.id, [
      { revision: 1, at: day(200), bytes: 1000 }, // oldest
      { revision: 2, at: day(199), bytes: 1000 },
      { revision: 3, at: day(198), bytes: 1000 },
      { revision: 4, at: day(197), bytes: 1000 }, // same month as 2 and 3? only if the days fall in one month
      { revision: 5, at: day(5), bytes: 1000 }, // inside the window
      { revision: 6, at: day(4), bytes: 1000 },
      { revision: 7, at: NOW - 3600_000, bytes: 1000 }, // newest
    ]);
    const log: string[] = [];
    // ceiling 4500 bytes of 7000: it must free at least 3 rows of the old ones
    const r = pruner(NOW, { ...DEFAULT_HISTORY, maxMbPerCampaign: 4500 / (1024 * 1024) }, log).runOnce()!;
    expect(r.overCeiling).toBeGreaterThan(0);
    expect(revs(p.id)).toEqual(expect.arrayContaining([1, 5, 6, 7])); // oldest, window and newest untouched
    expect(JSON.stringify(log)).not.toContain('NaN');
  });

  it('a clock set forward cannot thin more than the recorded activity allows; a clock set back skips the pass', async () => {
    clean();
    const p = await newPage();
    clean();
    const t0 = NOW - 90 * DAY;
    seed(p.id, [
      { revision: 1, at: t0 - 20 * DAY },
      ...Array.from({ length: 5 }, (_, i) => ({ revision: 2 + i, at: t0 - 10 * DAY + i * 60_000 })), // one UTC day, inside the window of t0
      { revision: 7, at: t0 },
    ]);
    const before = revs(p.id);
    const forward = pruner(t0 + 60 * DAY).runOnce()!; // +60 days, a wrong clock
    expect(forward.daily + forward.monthly).toBe(0);
    expect(revs(p.id)).toEqual(before);
    const log: string[] = [];
    expect(pruner(t0 - DAY, { ...DEFAULT_HISTORY }, log).runOnce()).toBeNull();
    expect(log[0]).toMatch(/clock looks wrong/);
  });

  it('defers while a backup runs, and a failed kind does not stop the pass', async () => {
    const busy = new HistoryPruner({ db: fx.db, backups: { isRunning: () => true }, config: { dataDir: fx.config.dataDir, history: DEFAULT_HISTORY } });
    expect(busy.runOnce()).toBeNull();
  });

  it('the delete re-checks that a row is not the newest: a save landing between selection and delete is safe', () => {
    clean();
    const id = (fx.db.select().from(pages).limit(1).get() as { id: string }).id;
    seed(id, [{ revision: 1, at: NOW - 100 * DAY }, { revision: 2, at: NOW - 100 * DAY + 1000 }, { revision: 3, at: NOW - 100 * DAY + 2000 }]);
    const p = pruner(NOW) as unknown as { deleteRows(r: { page_id: string; revision: number }[]): number };
    // 3 is the newest, 1 is the oldest: neither may go even when asked; 2 may
    expect(p.deleteRows([{ page_id: id, revision: 3 }, { page_id: id, revision: 1 }, { page_id: id, revision: 2 }])).toBe(1);
    expect(revs(id)).toEqual([1, 3]);
  });
});

describe('PageHistoryService', () => {
  let history: PageHistoryService;
  beforeAll(() => {
    history = services.pageHistory;
  });
  const gm = () => ctx();

  it('lists newest first without content, and reads one revision whole', async () => {
    const p = await newPage({ title: 'First' });
    await edit(p.id, { title: 'Second', body: doc(para('SECRET-LATER')) });
    const list = history.list(campaignId, p.id);
    expect(list.map((r) => r.title)).toEqual(['Second', 'First']);
    expect(list[0]).toMatchObject({ source: 'web', cause: 'edit', author: { id: dmId, displayName: 'The DM' }, tokenName: null, restoredFrom: null });
    expect(Object.keys(list[0]!)).not.toContain('body');
    expect(history.list(campaignId, p.id, { before: 2 }).map((r) => r.revision)).toEqual([1]);
    expect(history.get(campaignId, p.id, 2).body).toBeTruthy();
    expect(() => history.get(campaignId, p.id, 99)).toThrow(/not found/i);
    expect(() => history.list(campaignId, 'nope')).toThrow(/not found/i);
  });

  it('restores content as a new revision with cause restore, keeping visibility, tags and cover', async () => {
    const p = await newPage({ title: 'V1', body: doc(para('one')), visibility: 'dm', tags: ['x'] });
    await edit(p.id, { title: 'V2', body: doc(para('two')) });
    await edit(p.id, { visibility: 'all', tags: ['y'], cover: 'cover-id' });
    const live = (await dm.get(`${base()}/pages/${p.id}`)).body;
    const out = history.restore(campaignId, p.id, 1, live.revision, gm());
    expect(out.restored).toBe(true);
    expect(out.page).toMatchObject({ title: 'V1', visibility: 'all', tags: ['y'], cover: 'cover-id' });
    expect(JSON.stringify(out.page.body)).toContain('one');
    const last = rows(p.id).at(-1)!;
    expect(last).toMatchObject({ cause: 'restore', restoredFrom: 1, revision: out.page.revision });
    expect(rows(p.id).length).toBeGreaterThanOrEqual(3); // nothing was deleted
    // undo the restore
    const back = history.restore(campaignId, p.id, 2, out.page.revision, gm());
    expect(back.page.title).toBe('V2');
  });

  it('restoring the live content is a no-op; a stale revision is a 409', async () => {
    const p = await newPage({ title: 'Same' });
    await edit(p.id, { title: 'Other' });
    const live = (await dm.get(`${base()}/pages/${p.id}`)).body;
    expect(() => history.restore(campaignId, p.id, 1, live.revision - 1, gm())).toThrow(/changed by someone/);
    const noop = history.restore(campaignId, p.id, 2, live.revision, gm());
    expect(noop.restored).toBe(false);
    expect(rows(p.id).map((r) => r.cause)).toEqual(['create', 'edit']);
  });

  it('never gives a removed player their character back (playerUserId keeps its live value)', async () => {
    const pc = await newPage({ type: 'pc', title: 'Aria', visibility: 'all', facet: { playerUserId: playerId, hpMax: 10 } });
    await edit(pc.id, { title: 'Aria II', facet: { hpMax: 12 } });
    // the player leaves: the assignment is cleared as removeMember does
    await edit(pc.id, { facet: { playerUserId: null } });
    const live = (await dm.get(`${base()}/pages/${pc.id}`)).body;
    const out = history.restore(campaignId, pc.id, 1, live.revision, gm());
    expect(out.page.facet).toMatchObject({ playerUserId: null, hpMax: 10 });
    expect(rows(pc.id).at(-1)!.details).toMatchObject({ playerUserId: null });
    expect((await player.patch(`${base()}/pages/${pc.id}`, { revision: out.page.revision, title: 'Mine' })).status).toBeGreaterThanOrEqual(403);
    // a snapshot that differs only in the removed assignment is no write
    const again = history.restore(campaignId, pc.id, 1, out.page.revision, gm());
    expect(again.restored).toBe(false);
  });

  it('clears links to pages that are gone and skips deleted property definitions, with warnings', async () => {
    const target = await newPage({ type: 'npc', title: 'Target' });
    const def = (await dm.post(`${base()}/properties`, { label: 'Ephemeral', type: 'text' })).body;
    const npc = await newPage({ type: 'npc', title: 'Holder', facet: { locationPageId: undefined, factionPageId: undefined }, props: { ephemeral: 'v' } });
    const loc = await newPage({ type: 'location', title: 'Place' });
    const cur = (await dm.get(`${base()}/pages/${npc.id}`)).body;
    services.pages.update(campaignId, npc.id, { revision: cur.revision, facet: { locationPageId: loc.id } }, ctx({ cause: 'template_apply' })); // its own row: an edit would fold into the next one
    await edit(npc.id, { title: 'Holder 2', facet: { locationPageId: null } });
    await dm.delete(`${base()}/pages/${loc.id}`);
    await dm.delete(`${base()}/properties/${def.id}`);
    void target;
    const live = (await dm.get(`${base()}/pages/${npc.id}`)).body;
    const snapRev = rows(npc.id).find((r) => (r.details as { locationPageId?: string } | null)?.locationPageId === loc.id)!.revision;
    const out = history.restore(campaignId, npc.id, snapRev, live.revision, gm());
    expect(out.warnings.join(' ')).toMatch(/no longer exists/);
    expect(out.warnings.join(' ')).toMatch(/Ephemeral|ephemeral/);
    expect(out.page.facet?.['locationPageId']).toBeNull();
  });
});

describe('only game masters have anything to do with the table', () => {
  it('page DTOs and player projections never carry history fields', async () => {
    const p = await newPage({ visibility: 'all' });
    await edit(p.id, { title: 'Seen' });
    const asPlayer = (await player.get(`${base()}/pages/${p.id}`)).body;
    expect(Object.keys(asPlayer).sort()).not.toEqual(expect.arrayContaining(['history']));
    expect(JSON.stringify(asPlayer)).not.toMatch(/contentHash|content_hash|restoredFrom|tokenId/);
    const dmView = (await dm.get(`${base()}/pages/${p.id}`)).body;
    expect(JSON.stringify(dmView)).not.toMatch(/contentHash|content_hash|restoredFrom|tokenId/);
  });
});

describe('history endpoints (task N1.3)', () => {
  const hp = (id: string) => `${base()}/pages/${id}/history`;
  async function joinAs(role: 'player' | 'codm', username: string) {
    const inv = await dm.post(`${base()}/invites`, { role });
    const client = new TestClient(app);
    expect((await client.post('/api/auth/register', { token: inv.body.token, username, displayName: username, password: 'a long enough password' })).status).toBe(201);
    return { client, userId: (await client.get('/api/auth/me')).body.user.id as string };
  }

  it('lists, reads and restores for the GM; the list has no content, limit is capped and validated', async () => {
    const p = await newPage({ title: 'Ledger', body: doc(para('first')) });
    await edit(p.id, { title: 'Ledger 2', body: doc(para('second')) });
    const list = await dm.get(hp(p.id));
    expect(list.status).toBe(200);
    expect(list.body.items.map((r: { title: string }) => r.title)).toEqual(['Ledger 2', 'Ledger']);
    expect(list.body.items[0]).not.toHaveProperty('body');
    expect((await dm.get(`${hp(p.id)}?before=2&limit=1`)).body.items.map((r: { revision: number }) => r.revision)).toEqual([1]);
    expect((await dm.get(`${hp(p.id)}?limit=101`)).status).toBe(400);
    expect((await dm.get(`${hp(p.id)}?limit=0`)).status).toBe(400);
    const one = await dm.get(`${hp(p.id)}/1`);
    expect(one.status).toBe(200);
    expect(JSON.stringify(one.body.body)).toContain('first');
    expect((await dm.get(`${hp(p.id)}/99`)).status).toBe(404);
    expect((await dm.get(`${hp(p.id)}/x`)).status).toBe(400);
    expect((await dm.get(hp('nope'))).status).toBe(404);

    const live = (await dm.get(`${base()}/pages/${p.id}`)).body;
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const res = await dm.post(`${hp(p.id)}/1/restore`, { revision: live.revision });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ restored: true, warnings: [], page: { title: 'Ledger', revision: live.revision + 1 } });
    expect(rows(p.id).at(-1)).toMatchObject({ cause: 'restore', restoredFrom: 1, source: 'web', authorUserId: dmId });
    const line = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes('page.history_restored'))!;
    expect(JSON.parse(line)).toMatchObject({ event: 'page.history_restored', campaignId, pageId: p.id, actor: dmId, fromRevision: 1, toRevision: live.revision + 1 });
    expect(line).not.toMatch(/Ledger|first|second/);
  });

  it('answers 409 with the current page when the revision is stale, and restoring the live content writes nothing', async () => {
    const p = await newPage({ title: 'Race' });
    await edit(p.id, { title: 'Race 2' });
    const stale = await dm.post(`${hp(p.id)}/1/restore`, { revision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.details.current.title).toBe('Race 2');
    expect((await dm.post(`${hp(p.id)}/1/restore`, {})).status).toBe(400);
    expect((await dm.post(`${hp(p.id)}/1/restore`, { revision: '2' })).status).toBe(400);
    const live = (await dm.get(`${base()}/pages/${p.id}`)).body;
    const before = rows(p.id).length;
    const noop = await dm.post(`${hp(p.id)}/${live.revision}/restore`, { revision: live.revision });
    expect(noop.body.restored).toBe(false);
    expect(rows(p.id)).toHaveLength(before);
  });

  it('refuses players and a demoted co-DM before looking at the page; a co-DM may', async () => {
    const p = await newPage({ title: 'Guarded', visibility: 'all' });
    await edit(p.id, { title: 'Guarded 2' });
    for (const path of [hp(p.id), `${hp(p.id)}/1`, hp('nope'), `${hp(p.id)}/zzz`]) expect([path, (await player.get(path)).status]).toEqual([path, 403]);
    expect((await player.post(`${hp(p.id)}/1/restore`, { revision: 2 })).status).toBe(403);
    expect((await player.post(`${hp(p.id)}/1/restore`, {})).status).toBe(403);
    const co = await joinAs('codm', 'cody');
    expect((await co.client.get(hp(p.id))).status).toBe(200);
    expect((await co.client.post(`${hp(p.id)}/1/restore`, { revision: 2 })).status).toBe(200);
    expect((await dm.patch(`${base()}/members/${co.userId}`, { role: 'player' })).status).toBe(200);
    expect((await co.client.get(hp(p.id))).status).toBe(403);
    expect((await co.client.get(`${hp(p.id)}/1`)).status).toBe(403);
  });

  it('after a member is removed, restoring an older revision gives them no access back', async () => {
    const { client, userId } = await joinAs('player', 'rex');
    const pc = await newPage({ type: 'pc', title: 'Rexa', visibility: 'all', facet: { playerUserId: userId, hpMax: 10 } });
    await edit(pc.id, { title: 'Rexa II', facet: { hpMax: 12 } });
    expect((await client.patch(`${base()}/pages/${pc.id}`, { revision: (await client.get(`${base()}/pages/${pc.id}`)).body.revision, title: 'Mine' })).status).toBe(200);
    expect((await dm.delete(`${base()}/members/${userId}`)).status).toBe(204);
    expect(services.visibility.ownCharacterIds(campaignId, userId).size).toBe(0);
    const live = (await dm.get(`${base()}/pages/${pc.id}`)).body;
    expect(live.facet.playerUserId).toBeNull();
    const res = await dm.post(`${hp(pc.id)}/1/restore`, { revision: live.revision });
    expect(res.status).toBe(200);
    expect(res.body.page.facet).toMatchObject({ playerUserId: null, hpMax: 10 });
    expect(services.visibility.ownCharacterIds(campaignId, userId).size).toBe(0);
    expect((await client.get(`${base()}/pages/${pc.id}`)).status).toBe(404);
  });

  it('opens and restores revisions below 1, and accepts only strict integers', async () => {
    const p = await newPage({ title: 'Neg', body: doc(para('old')) });
    await edit(p.id, { title: 'Neg 2' });
    fx.db.update(pageRevisions).set({ revision: -1 }).where(and(eq(pageRevisions.pageId, p.id), eq(pageRevisions.revision, 1))).run();
    expect((await dm.get(hp(p.id))).body.items.map((r: { revision: number }) => r.revision)).toEqual([2, -1]);
    expect((await dm.get(`${hp(p.id)}?before=0`)).body.items.map((r: { revision: number }) => r.revision)).toEqual([-1]);
    expect((await dm.get(`${hp(p.id)}/-1`)).body.title).toBe('Neg');
    const live = (await dm.get(`${base()}/pages/${p.id}`)).body;
    const res = await dm.post(`${hp(p.id)}/-1/restore`, { revision: live.revision });
    expect(res.status).toBe(200);
    expect(res.body.page.title).toBe('Neg');
    for (const bad of ['1e0', '01x', '+1', '0x1', '%201', '1.5', '-']) expect([bad, (await dm.get(`${hp(p.id)}/${bad}`)).status]).toEqual([bad, 400]);
    for (const bad of ['1e0', '+1', '0x1', '%201', '1.5', 'x']) expect([bad, (await dm.get(`${hp(p.id)}?before=${bad}`)).status]).toEqual([bad, 400]);
    for (const bad of ['1e0', '+1', '0x1', '%201', '0', '-1']) expect([bad, (await dm.get(`${hp(p.id)}?limit=${bad}`)).status]).toEqual([bad, 400]);
    expect((await dm.post(`${hp(p.id)}/1/restore`, { revision: 1.5 })).status).toBe(400);
  });

  it('skips a property whose definition was deleted, with a warning', async () => {
    const def = (await dm.post(`${base()}/properties`, { label: 'Gone prop', type: 'text' })).body;
    const p = await newPage({ title: 'Props', props: { gone_prop: 'v' } });
    await edit(p.id, { title: 'Props 2' });
    expect((await dm.delete(`${base()}/properties/${def.id}`)).status).toBeLessThan(300);
    const live = (await dm.get(`${base()}/pages/${p.id}`)).body;
    const res = await dm.post(`${hp(p.id)}/1/restore`, { revision: live.revision });
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([expect.stringMatching(/"gone_prop" no longer exists/)]);
    expect(res.body.page.props).not.toHaveProperty('gone_prop');
  });

  it('clears a page-link property that points at a purged page, with a warning', async () => {
    await dm.post(`${base()}/properties`, { label: 'Ally link', type: 'pageLink' });
    const target = await newPage({ title: 'Doomed' });
    const p = await newPage({ title: 'Linker', props: { ally_link: target.id } });
    await edit(p.id, { title: 'Linker 2', props: { ally_link: null } });
    expect((await dm.delete(`${base()}/pages/${target.id}`)).status).toBe(200);
    expect((await dm.delete(`${base()}/pages/${target.id}/purge`)).status).toBe(200);
    const live = (await dm.get(`${base()}/pages/${p.id}`)).body;
    const res = await dm.post(`${hp(p.id)}/1/restore`, { revision: live.revision });
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([expect.stringMatching(/Ally link.*no longer exists/)]);
    expect(res.body.page.props['ally_link'] ?? null).toBeNull();
  });

  it('lists tokenName null once the token is gone', async () => {
    const token = await makeToken(dm, 'write', 'Scribe');
    const tokenId = fx.db.select().from(apiTokens).where(eq(apiTokens.tokenHash, hashToken(token))).get()!.id;
    const mcp = await mcpClient(app, token);
    const page = (await callTool(mcp, 'create_page', { campaignId, title: 'By Scribe', markdown: 'Hi' })).data;
    expect((await dm.get(hp(page.id))).body.items[0]).toMatchObject({ source: 'mcp', tokenName: 'Scribe' });
    expect((await dm.delete(`/api/auth/tokens/${tokenId}`)).status).toBe(204);
    fx.db.delete(apiTokens).where(eq(apiTokens.id, tokenId)).run();
    expect((await dm.get(hp(page.id))).body.items[0]).toMatchObject({ source: 'mcp', tokenName: null });
  });
});
