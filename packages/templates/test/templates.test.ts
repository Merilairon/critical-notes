import { describe, expect, it } from 'vitest';
import { sanitizeDoc, type BlockNode } from '@cn/blocks';
import { getRuleset } from '@cn/fivetools';
import {
  BUILTIN_TEMPLATES,
  coerceValues,
  collectVariables,
  exportTemplates,
  instantiate,
  LIBRARY_FORMAT,
  readTemplateExport,
  renderLinked,
  resolvePageTemplate,
  syncVariables,
  tokenize,
  type PageTemplateDef,
  type TemplateVariable,
} from '../src';

const p = (...content: BlockNode[]): BlockNode => ({ type: 'paragraph', content });
const t = (text: string, marks?: string[]): BlockNode => (marks ? { type: 'text', text, marks: marks.map((m) => ({ type: m })) } : { type: 'text', text });
const texts = (nodes: BlockNode[]): string =>
  nodes
    .map((n) => (n.type === 'text' ? n.text : n.type === 'tag' ? String(n.attrs?.['markup']) : n.type === 'placeholder' ? `[${String(n.attrs?.['name'])}]` : texts(n.content ?? [])))
    .join('');

describe('tokenizer', () => {
  it('parses names, types, defaults and escapes', () => {
    expect(tokenize('DC {{dc: number = 13}} vs {{name}}')).toEqual([
      { t: 'text', text: 'DC ' },
      { t: 'var', name: 'dc', type: 'number', default: '13', raw: '{{dc: number = 13}}' },
      { t: 'text', text: ' vs ' },
      { t: 'var', name: 'name', raw: '{{name}}' },
    ]);
    expect(tokenize('{{save: select(Str|Dex) = Dex}}')[0]).toMatchObject({ name: 'save', type: 'select(Str|Dex)', default: 'Dex' });
    expect(tokenize('{{who: reference<monster>}}')[0]).toMatchObject({ name: 'who', type: 'reference<monster>' });
    expect(tokenize('literal \\{{x}} and {{ not valid! }} and {{open')).toEqual([{ t: 'text', text: 'literal {{x}} and {{ not valid! }} and {{open' }]);
    expect(tokenize('{@b {@i nested}} tags}}')).toEqual([{ t: 'text', text: '{@b {@i nested}} tags}}' }]);
  });
});

describe('variables', () => {
  it('collects the first declaration of each variable from text, attributes, bindings and fields', () => {
    const { variables, issues, typed } = collectVariables([
      p(t('Hello {{name}}, DC {{dc: number = 12}}, {{rules.race}}')),
      p(t('again {{dc: text}} and {{name: text = Bob}}')),
      { type: 'refEmbed', attrs: { uid: { $var: 'creature' }, caption: 'about {{topic}}' } },
      p({ type: 'placeholder', attrs: { name: 'loot', valueType: 'dice', label: 'Loot roll' } }),
      { type: 'templateInstance', attrs: { values: {} }, content: [p(t('{{inner}}'))] },
    ]);
    expect(variables).toEqual([
      { name: 'name', type: 'text', default: 'Bob' },
      { name: 'dc', type: 'number', default: 12 },
      { name: 'creature', type: 'text' },
      { name: 'topic', type: 'text' },
      { name: 'loot', type: 'dice', label: 'Loot roll' },
    ]);
    expect(issues).toEqual(['{{dc}} is declared as number and as text (the first one wins)']);
    expect([...typed]).toEqual(['name', 'dc', 'loot']);
  });

  it('keeps labels and flags of stored variables when content changes', () => {
    const stored: TemplateVariable[] = [{ name: 'dc', type: 'number', label: 'Save DC', required: true, default: 15 }, { name: 'gone', type: 'text' }, { name: 'who', type: 'reference<monster>' }];
    expect(syncVariables([p(t('{{dc: number}} {{new}}')), { type: 'refEmbed', attrs: { uid: { $var: 'who' } } }], stored).variables).toEqual([
      { name: 'dc', type: 'number', label: 'Save DC', required: true, default: 15 },
      { name: 'new', type: 'text' },
      { name: 'who', type: 'reference<monster>' },
    ]);
  });

  it('types and validates values', () => {
    const vars: TemplateVariable[] = [
      { name: 'n', type: 'number', required: true },
      { name: 'ok', type: 'boolean' },
      { name: 'd', type: 'dice' },
      { name: 's', type: 'select(a|b)' },
      { name: 'r', type: 'reference<monster>' },
      { name: 'when', type: 'date', default: '2026-01-01' },
    ];
    expect(coerceValues(vars, { n: '7', ok: 'yes', d: '2d6+1', s: 'b', r: 'MONSTER:Goblin|MM' })).toEqual({
      values: { n: 7, ok: true, d: '2d6+1', s: 'b', r: 'monster:goblin|mm', when: '2026-01-01' },
      issues: [],
    });
    expect(coerceValues(vars, { n: 'x', d: 'banana', s: 'c', r: 'spell:fireball|phb', when: '1/1/26' }).issues.map((i) => `${i.variable}: ${i.message}`)).toEqual([
      'n: Must be a number',
      'd: "banana" is not a dice expression',
      's: Must be one of: a, b',
      'r: Must be a monster',
      'when: Use YYYY-MM-DD',
    ]);
    expect(coerceValues(vars, {}).issues).toEqual([{ variable: 'n', message: 'A value is required' }]);
  });
});

describe('instantiation', () => {
  const content: BlockNode[] = [
    { type: 'heading', attrs: { id: 'b1', level: 2 }, content: [t('{{name}}', ['bold'])] },
    p(t('Roll {{dmg: dice}} vs DC {{dc: number = 13}}; meet {{ally: pageLink}} and fight {{foe: reference<monster>}}. {{rules.race}}: {{ancestry}}. Literal \\{{x}}')),
    { type: 'refEmbed', attrs: { id: 'b2', uid: { $var: 'foe' } } },
    p({ type: 'tag', attrs: { markup: { $rulesetTag: 'condition:prone' } } }),
  ];
  const ruleset2024 = getRuleset('2024');
  const opts = {
    terminology: ruleset2024.terminology as unknown as Record<string, string>,
    canonicalRef: (k: string) => ruleset2024.canonicalRef(k),
    describeRef: (uid: string) => (uid === 'monster:goblin|mm' ? { name: 'Goblin', source: 'MM' } : null),
    pageTitle: (id: string) => (id === 'p1' ? 'Toblen' : null),
  };

  it('fills values with typed content, keeps marks, binds attributes and drops block ids', () => {
    const out = instantiate(content, { ...opts, mode: 'fill', values: { name: 'Ambush', dmg: '2d6', ally: 'p1', foe: 'monster:goblin|mm', ancestry: 'Elf' } });
    expect(out[0]).toEqual({ type: 'heading', attrs: { level: 2 }, content: [t('Ambush', ['bold'])] });
    expect(out[1]!.content).toEqual([
      t('Roll '),
      { type: 'tag', attrs: { markup: '{@dice 2d6}' } },
      t(' vs DC '),
      t('13'),
      t('; meet '),
      { type: 'pageLink', attrs: { pageId: 'p1', label: 'Toblen' } },
      t(' and fight '),
      { type: 'tag', attrs: { markup: '{@creature Goblin|MM}' } },
      t('. '),
      t('Species'),
      t(': '),
      t('Elf'),
      t('. Literal {{x}}'),
    ]);
    expect(out[2]).toEqual({ type: 'refEmbed', attrs: { uid: 'monster:goblin|mm' } });
    expect(out[3]!.content).toEqual([{ type: 'tag', attrs: { markup: '{@condition Prone|XPHB}' } }]);
  });

  it('keeps unfilled variables as fields, or drops them when filling', () => {
    const fields = instantiate(content, { ...opts, mode: 'fields', values: {} });
    expect(texts(fields)).toContain('Roll [dmg] vs DC 13; meet [ally] and fight [foe]');
    expect(fields[2]).toEqual({ type: 'refEmbed', attrs: { uid: null } });
    const filled = instantiate(content, { ...opts, mode: 'fill', values: {} });
    expect(texts(filled)).toContain('Roll  vs DC 13; meet  and fight .');
  });

  it('resolves ruleset references per edition', () => {
    const classic = getRuleset('2014');
    const out = instantiate(content.slice(3), { mode: 'fill', values: {}, canonicalRef: (k) => classic.canonicalRef(k) });
    expect(out[0]!.content).toEqual([{ type: 'tag', attrs: { markup: '{@condition Prone|PHB}' } }]);
  });

  it('re-renders linked instances from a new template version with their stored values', () => {
    const instance: BlockNode = { type: 'templateInstance', attrs: { id: 'x', templateId: 't1', version: 1, values: { name: 'Gate' }, detached: false }, content: [p(t('old'))] };
    const v2 = { version: 2, variables: [{ name: 'name', type: 'text' }], content: [p(t('Trap: {{name}} (v2)'))] };
    expect(renderLinked(instance, v2, {})).toEqual({ ...instance, attrs: { ...instance.attrs, version: 2 }, content: [p(t('Trap: '), t('Gate'), t(' (v2)'))] });
    const detached = { ...instance, attrs: { ...instance.attrs, detached: true } };
    expect(renderLinked(detached, v2, {})).toBe(detached);
  });
});

describe('page template inheritance', () => {
  const base: PageTemplateDef = {
    pageType: 'location',
    extendsRef: null,
    bodyMode: 'append',
    defaults: { visibility: 'dm', tags: ['place'] },
    facet: { kind: 'site' },
    properties: [{ key: 'danger', label: 'Danger', type: 'select', options: ['low', 'high'] }],
    variables: [{ name: 'a', type: 'text' }],
    body: [p(t('base'))],
    children: [{ title: 'Basement' }],
  };
  const child: PageTemplateDef = {
    ...base,
    extendsRef: 'base',
    defaults: { icon: '🏰', tags: ['castle'] },
    facet: { kind: 'settlement' },
    properties: [{ key: 'danger', label: 'Threat', type: 'select', options: ['low', 'high'] }, { key: 'lord', label: 'Lord', type: 'pageLink' }],
    variables: [{ name: 'b', type: 'number' }],
    body: [p(t('child'))],
    children: [{ title: 'Tower', templateRef: 'base' }],
  };
  const lookup = (defs: Record<string, PageTemplateDef>) => (ref: string) => (defs[ref] ? { id: ref, def: defs[ref]! } : null);

  it('merges the chain: properties and variables by key, facet, tags, children, body append or replace', () => {
    const { def, chain } = resolvePageTemplate('child', lookup({ base, child }));
    expect(chain).toEqual(['base', 'child']);
    expect(def.defaults).toEqual({ visibility: 'dm', icon: '🏰', tags: ['place', 'castle'] });
    expect(def.facet).toEqual({ kind: 'settlement' });
    expect(def.properties.map((x) => x.label)).toEqual(['Threat', 'Lord']);
    expect(def.variables.map((v) => v.name)).toEqual(['a', 'b']);
    expect(texts(def.body)).toBe('basechild');
    expect(def.children.map((c) => c.title)).toEqual(['Basement', 'Tower']);
    const replaced = resolvePageTemplate('child', lookup({ base, child: { ...child, bodyMode: 'replace' } })).def;
    expect(texts(replaced.body)).toBe('child');
  });

  it('refuses loops and missing parents', () => {
    expect(() => resolvePageTemplate('child', lookup({ child, base: { ...base, extendsRef: 'child' } }))).toThrow(/loop/);
    expect(() => resolvePageTemplate('child', lookup({ child }))).toThrow(/parent template "base" was not found/);
  });
});

describe('export format', () => {
  const tpl = { kind: 'block' as const, name: 'Trap', definition: { variables: [], content: [p(t('x'))] } };

  it('round-trips single templates and libraries', () => {
    expect(readTemplateExport(exportTemplates([tpl])).templates).toEqual([tpl]);
    const lib = exportTemplates([tpl, { ...tpl, name: 'Other' }]);
    expect(lib.format).toBe(LIBRARY_FORMAT);
    expect(readTemplateExport(lib).templates.map((x) => x.name)).toEqual(['Trap', 'Other']);
  });

  it('upgrades old versions step by step and refuses newer ones', () => {
    const migrations = {
      1: (d: Record<string, unknown>) => ({ ...d, template: { ...(d.template as object), name: `${String((d.template as { title: string }).title)}` } }),
      2: (d: Record<string, unknown>) => ({ ...d, template: { ...(d.template as object), tags: ['upgraded'] } }),
    };
    const old = { format: 'critical-notes/template', schemaVersion: 1, template: { kind: 'block', title: 'Old trap', definition: { variables: [], content: [] } } };
    expect(readTemplateExport(old, { migrations, current: 3 }).templates[0]).toMatchObject({ name: 'Old trap', tags: ['upgraded'] });
    expect(() => readTemplateExport({ ...old, schemaVersion: 4 }, { migrations, current: 3 })).toThrow(/newer version of Critical Notes/);
    expect(() => readTemplateExport({ ...old, schemaVersion: 0 }, { migrations, current: 3 })).toThrow(/No upgrade from template format 0/);
    expect(() => readTemplateExport({ format: 'something else' })).toThrow(/Not a Critical Notes template file/);
  });

  it('skips invalid templates in a library', () => {
    const res = readTemplateExport({ format: LIBRARY_FORMAT, schemaVersion: 1, templates: [tpl, { kind: 'page', name: 'Bad', definition: { body: [] } }, 7] });
    expect(res.templates).toHaveLength(1);
    expect(res.skipped).toEqual(['Template 2: a page template needs "pageType" and "body"', 'Template 3: not an object']);
  });
});

describe('built-in templates', () => {
  it('has the 13 planned templates with unique keys', () => {
    expect(BUILTIN_TEMPLATES.map((b) => b.key)).toEqual([
      'npc',
      'location',
      'settlement',
      'dungeon-room',
      'quest',
      'faction',
      'session-prep',
      'session-recap',
      'shop',
      'player-handout',
      'magic-item-handout',
      'trap',
      'random-encounter-table',
    ]);
  });

  it.each(['2014', '2024'] as const)('instantiates every built-in into valid blocks for %s campaigns', (rulesetId) => {
    const ruleset = getRuleset(rulesetId);
    const lookup = (ref: string) => {
      const b = BUILTIN_TEMPLATES.find((x) => `builtin:${x.key}` === ref || x.key === ref);
      return b && b.kind === 'page' ? { id: b.key, def: b.definition as PageTemplateDef } : null;
    };
    for (const b of BUILTIN_TEMPLATES) {
      const def = b.kind === 'page' ? resolvePageTemplate(b.key, lookup).def : null;
      const content = def ? def.body : (b.definition as { content: BlockNode[] }).content;
      const variables = def ? def.variables : (b.definition as { variables: TemplateVariable[] }).variables;
      for (const mode of ['fill', 'fields'] as const) {
        const out = instantiate(content, {
          mode,
          values: {},
          variables,
          terminology: ruleset.terminology as unknown as Record<string, string>,
          canonicalRef: (k) => ruleset.canonicalRef(k),
        });
        const { issues } = sanitizeDoc({ type: 'doc', content: out });
        expect({ template: b.key, mode, issues }).toEqual({ template: b.key, mode, issues: [] });
        expect(JSON.stringify(out)).not.toMatch(/\{\{|\$var|\$ruleset/);
      }
    }
  });

  it('declares the variables used in titles and facets', () => {
    const prep = BUILTIN_TEMPLATES.find((b) => b.key === 'session-prep')!.definition as PageTemplateDef;
    expect(prep.variables).toContainEqual({ name: 'number', type: 'number' });
    const npc = BUILTIN_TEMPLATES.find((b) => b.key === 'npc')!.definition as PageTemplateDef;
    expect(npc.variables.find((v) => v.name === 'statblock')).toEqual({ name: 'statblock', type: 'reference<monster>', label: 'Statblock' });
  });
});
