import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema';
import { newId } from '../src/lib/ids';
import { hashPassword } from '../src/lib/password';
import { createFixture, createSignedInApp, TestClient, type Fixture, type TestApp } from './helpers';

let fx: Fixture;
let app: TestApp;
let dm: TestClient;
let classic: string;
let modern: string;

type Node = { type: string; text?: string; attrs?: Record<string, unknown>; content?: Node[] };
const para = (text: string): Node => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const flat = (nodes: Node[] | undefined): string =>
  (nodes ?? [])
    .map((n) => (n.type === 'text' ? n.text : n.type === 'tag' ? String(n.attrs?.['markup']) : n.type === 'placeholder' ? `[${String(n.attrs?.['name'])}]` : n.type === 'pageLink' ? `<${String(n.attrs?.['label'])}>` : flat(n.content)))
    .join('');

async function otherUser(username: string) {
  fx.db.insert(users).values({ id: newId(), username, displayName: username, passwordHash: await hashPassword('another long password'), isAdmin: false }).run();
  const c = new TestClient(app);
  await c.post('/api/auth/login', { username, password: 'another long password' });
  return c;
}

beforeAll(async () => {
  fx = await createFixture();
  const signed = await createSignedInApp(fx);
  ({ app, client: dm } = signed);
  signed.services.templates.upsertBuiltins();
  classic = (await dm.post('/api/campaigns', { name: 'Classic', ruleset: '2014' })).body.id;
  modern = (await dm.post('/api/campaigns', { name: 'Modern', ruleset: '2024' })).body.id;
}, 30_000);
afterAll(() => fx.cleanup());

describe('template library', () => {
  it('lists the built-ins, which are read-only but can be duplicated', async () => {
    const list = (await dm.get('/api/templates')).body.templates as { id: string; builtinKey: string; scope: string; canEdit: boolean }[];
    expect(list.filter((t) => t.scope === 'global')).toHaveLength(13);
    const npc = list.find((t) => t.builtinKey === 'npc')!;
    expect(npc.canEdit).toBe(false);
    expect((await dm.put(`/api/templates/${npc.id}`, { version: 1, name: 'Mine now' })).status).toBe(403);
    const copy = await dm.post(`/api/templates/${npc.id}/duplicate`, { scope: 'user' });
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ name: 'NPC (copy)', scope: 'user', canEdit: true, builtinKey: null });
    expect(copy.body.resolvedVariables.map((v: { name: string }) => v.name)).toContain('statblock');
  });

  it('keeps personal and campaign templates private', async () => {
    const mine = (await dm.post('/api/templates', { kind: 'block', scope: 'user', name: 'Mine', definition: { content: [para('{{x}}')] } })).body;
    const camp = (await dm.post('/api/templates', { kind: 'block', scope: 'campaign', campaignId: classic, name: 'Camp', definition: { content: [para('hi')] } })).body;
    const other = await otherUser('player2');
    expect((await other.get(`/api/templates/${mine.id}`)).status).toBe(404);
    expect((await other.get(`/api/templates/${camp.id}`)).status).toBe(404);
    expect((await other.post('/api/templates', { kind: 'block', scope: 'campaign', campaignId: classic, name: 'X', definition: { content: [] } })).status).toBe(404);
    expect((await dm.get(`/api/templates?campaignId=${modern}`)).body.templates.map((t: { id: string }) => t.id)).not.toContain(camp.id);
  });
});

describe('block templates', () => {
  let trapId: string;
  beforeAll(async () => {
    const res = await dm.post('/api/templates', {
      kind: 'block',
      scope: 'user',
      name: 'Ambush',
      definition: {
        variables: [{ name: 'foe', type: 'text', label: 'Who attacks' }],
        content: [
          para('{{count: number = 2}} attackers, DC {{dc: number}} to spot.'),
          { type: 'paragraph', content: [{ type: 'text', text: 'Leader: {{foe: reference<monster>}}, falls ' }, { type: 'tag', attrs: { markup: { $rulesetTag: 'condition:prone' } } }] },
          { type: 'refEmbed', attrs: { uid: { $var: 'foe' } } },
        ],
      },
    });
    expect(res.status).toBe(201);
    trapId = res.body.id;
    expect(res.body.resolvedVariables).toEqual([
      { name: 'count', type: 'number', default: 2 },
      { name: 'dc', type: 'number' },
      { name: 'foe', type: 'reference<monster>', label: 'Who attacks' },
    ]);
  });

  it('fills values with typed content for the campaign edition', async () => {
    const inst = (campaign: string) => dm.post(`/api/campaigns/${campaign}/templates/${trapId}/instantiate`, { values: { dc: '14', foe: 'monster:gloomling|tst' }, mode: 'fill' });
    const a = (await inst(classic)).body.content as Node[];
    expect(flat(a)).toBe('2 attackers, DC 14 to spot.Leader: {@creature Gloomling|TST}, falls {@condition Prone|PHB}');
    expect(a[2]).toEqual({ type: 'refEmbed', attrs: { uid: 'monster:gloomling|tst' } });
    expect(flat((await inst(modern)).body.content)).toContain('{@condition Prone|XPHB}');
  });

  it('validates values, or leaves them as fields', async () => {
    const bad = await dm.post(`/api/campaigns/${classic}/templates/${trapId}/instantiate`, { values: { dc: 'hard', foe: 'spell:spark burst|tst' }, mode: 'fill' });
    expect(bad.status).toBe(400);
    expect(bad.body.details.issues).toEqual([
      { variable: 'dc', message: 'Must be a number' },
      { variable: 'foe', message: 'Must be a monster' },
    ]);
    const fields = await dm.post(`/api/campaigns/${classic}/templates/${trapId}/instantiate`, { values: {}, mode: 'fields' });
    expect(flat(fields.body.content)).toBe('2 attackers, DC [dc] to spot.Leader: [foe], falls {@condition Prone|PHB}');
  });

  it('propagates new versions to linked instances, not to detached ones', async () => {
    const linked = (await dm.post(`/api/campaigns/${classic}/templates/${trapId}/instantiate`, { values: { dc: 12, foe: 'monster:gloomling|tst' }, mode: 'linked' })).body.content as Node[];
    expect(linked[0]).toMatchObject({ type: 'templateInstance', attrs: { templateId: trapId, version: 1, values: { count: 2, dc: 12, foe: 'monster:gloomling|tst' } } });
    const page = (await dm.post(`/api/campaigns/${classic}/pages`, { title: 'Road' })).body;
    const detached = { ...linked[0]!, attrs: { ...linked[0]!.attrs, detached: true } };
    await dm.patch(`/api/campaigns/${classic}/pages/${page.id}`, { revision: 1, body: { type: 'doc', content: [linked[0], detached] } });
    expect((await dm.get(`/api/templates/${trapId}/usage`)).body.usage).toEqual([
      { pageId: page.id, pageTitle: 'Road', campaignId: classic, campaignName: 'Classic', mode: 'linked', version: 1 },
    ]);

    const tpl = (await dm.get(`/api/templates/${trapId}`)).body;
    const v2 = await dm.put(`/api/templates/${trapId}`, { version: 1, definition: { ...tpl.definition, content: [para('UPDATED: {{count}} foes at DC {{dc}}')] } });
    expect(v2.status).toBe(200);
    expect(v2.body).toMatchObject({ propagated: 1, template: { version: 2 } });
    const body = (await dm.get(`/api/campaigns/${classic}/pages/${page.id}`)).body.body.content as Node[];
    expect(flat(body[0]!.content)).toBe('UPDATED: 2 foes at DC 12');
    expect(body[0]!.attrs?.['version']).toBe(2);
    expect(flat(body[1]!.content)).toContain('attackers');
    expect((await dm.put(`/api/templates/${trapId}`, { version: 1, name: 'stale' })).status).toBe(409);
  });
});

describe('page templates', () => {
  let keepId: string;
  beforeAll(async () => {
    const res = await dm.post('/api/templates', {
      kind: 'page',
      scope: 'campaign',
      campaignId: classic,
      name: 'Keep',
      definition: {
        pageType: 'location',
        extendsRef: 'builtin:location',
        defaults: { title: 'The keep of {{lord}}', icon: '🏰', tags: ['keep'] },
        facet: { kind: 'settlement' },
        properties: [{ key: 'danger', label: 'Danger', type: 'select', options: ['low', 'high'], default: 'high' }],
        body: [para('Held by {{lord}} with {{guards: number = 20}} guards.')],
        children: [{ title: 'Market', templateRef: 'builtin:shop' }, { title: 'Dungeon' }],
      },
    });
    expect(res.status).toBe(201);
    keepId = res.body.id;
  });

  it('creates a page with inherited content, facet, properties and child pages', async () => {
    const res = await dm.post(`/api/campaigns/${classic}/pages/from-template`, { templateId: keepId, values: { lord: 'Lady Vex', first_impression: 'Grey walls.' }, mode: 'fill' });
    expect(res.status).toBe(201);
    const page = res.body;
    expect(page).toMatchObject({ title: 'The keep of Lady Vex', type: 'location', icon: '🏰', tags: ['keep'], facet: { kind: 'settlement' }, props: { danger: 'high' } });
    const text = flat(page.body.content);
    expect(text).toContain('Grey walls.'); // from the Location built-in
    expect(text).toContain('Held by Lady Vex with 20 guards.');
    const tree = (await dm.get(`/api/campaigns/${classic}/pages`)).body.pages as { id: string; title: string; parentId: string | null }[];
    expect(tree.filter((p) => p.parentId === page.id).map((p) => p.title).sort()).toEqual(['Dungeon', 'Market']);
    const market = tree.find((p) => p.parentId === page.id && p.title === 'Market')!;
    expect(flat((await dm.get(`/api/campaigns/${classic}/pages/${market.id}`)).body.body.content)).toContain('Wares');
    expect((await dm.get(`/api/templates/${keepId}/usage`)).body.usage.map((u: { mode: string }) => u.mode)).toEqual(['page']);
  });

  it('applies a template to an existing page without overwriting anything', async () => {
    const page = (await dm.post(`/api/campaigns/${classic}/pages`, { type: 'location', title: 'Old fort', body: { type: 'doc', content: [para('My notes')] } })).body;
    await dm.patch(`/api/campaigns/${classic}/pages/${page.id}`, { revision: 1, props: { danger: 'low' } });
    const res = await dm.post(`/api/campaigns/${classic}/pages/${page.id}/apply-template`, { templateId: keepId, values: { lord: 'Nobody' }, mode: 'fill' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Old fort');
    expect(res.body.props.danger).toBe('low');
    expect(flat(res.body.body.content).startsWith('My notes')).toBe(true);
    expect(flat(res.body.body.content)).toContain('Held by Nobody');
  });

  it('refuses templates that extend each other in a loop', async () => {
    const a = (await dm.post('/api/templates', { kind: 'page', scope: 'user', name: 'A', definition: { pageType: 'generic', body: [] } })).body;
    const b = (await dm.post('/api/templates', { kind: 'page', scope: 'user', name: 'B', definition: { pageType: 'generic', extendsRef: a.id, body: [] } })).body;
    const loop = await dm.put(`/api/templates/${a.id}`, { version: 1, definition: { pageType: 'generic', extendsRef: b.id, body: [] } });
    expect(loop.status).toBe(400);
    expect(loop.body.error).toMatch(/cannot extend itself/);
  });

  it('uses the campaign default template for new pages of a type', async () => {
    const npc = (await dm.get('/api/templates')).body.templates.find((t: { builtinKey: string }) => t.builtinKey === 'npc');
    expect((await dm.put(`/api/campaigns/${modern}/template-defaults`, { pageType: 'npc', templateId: npc.id })).body.defaults).toEqual({ npc: npc.id });
    const withTemplate = (await dm.post(`/api/campaigns/${modern}/pages`, { type: 'npc', title: 'Bryn' })).body;
    expect(withTemplate.title).toBe('Bryn');
    expect(flat(withTemplate.body.content)).toContain('Appearance');
    expect(withTemplate.body.content[0].attrs.items[0].label).toBe('Species'); // {{rules.race}} in a 2024 campaign
    const plain = (await dm.post(`/api/campaigns/${modern}/pages?template=0`, { type: 'npc', title: 'Plain' })).body;
    expect(flat(plain.body.content)).toBe('');
  });
});

describe('template import and export', () => {
  it('exports and re-imports templates, and refuses files from a newer version', async () => {
    const src = (await dm.post('/api/templates', { kind: 'block', scope: 'user', name: 'Portable', definition: { content: [para('{{a}}')] } })).body;
    const exported = await dm.get(`/api/templates/export?ids=${src.id}`);
    expect(exported.body).toMatchObject({ format: 'critical-notes/template', schemaVersion: 1, template: { name: 'Portable', kind: 'block' } });
    const imported = await dm.post('/api/templates/import', { scope: 'campaign', campaignId: classic, document: exported.body });
    expect(imported.body.created).toEqual([{ id: expect.any(String), name: 'Portable' }]);
    const future = await dm.post('/api/templates/import', { document: { ...exported.body, schemaVersion: 99 } });
    expect(future.status).toBe(400);
    expect(future.body.error).toMatch(/newer version of Critical Notes/);
  });
});
