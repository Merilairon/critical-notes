import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, createSignedInApp, TestClient, type Fixture, type TestApp } from './helpers';

let fx: Fixture;
let app: TestApp;
let dm: TestClient;
let codm: TestClient;
let player: TestClient;
let stranger: TestClient;
let campaignId: string;
let otherCampaignId: string;

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
  ({ app, client: dm } = signed);
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
