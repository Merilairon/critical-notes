import { describe, expect, it } from 'vitest';
import { mergePlayerEdit, projectDoc, sanitizeDoc, type BlockDocument, type BlockNode, type ProjectContext } from '../src';
import { docToMarkdown, markdownToDoc, type FromMarkdownOptions } from '../src/markdown';

let n = 0;
const t = (text: string, ...marks: string[]): BlockNode => ({ type: 'text', text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const p = (...content: BlockNode[]): BlockNode => ({ type: 'paragraph', attrs: { id: `p${++n}` }, content });
const doc = (...content: BlockNode[]): BlockDocument => ({ type: 'doc', schemaVersion: 1, content });
const tag = (markup: string): BlockNode => ({ type: 'tag', attrs: { markup } });
const cell = (type: 'tableHeader' | 'tableCell', ...content: BlockNode[]): BlockNode => ({ type, content: [p(...content)] });

const PAGES: Record<string, string> = { npc1: 'Toblen', loc1: 'Stonehill Inn', dup1: 'Twin', dup2: 'Twin' };
const pageRef = (id: string, label: string) => {
  const title = PAGES[id];
  return title && Object.values(PAGES).filter((v) => v === title).length === 1 ? title : `page:${id}|${label}`;
};
const resolvePage: FromMarkdownOptions['resolvePage'] = (ref) => {
  if (ref.id) return PAGES[ref.id] ? { pageId: ref.id, label: ref.label ?? PAGES[ref.id]! } : null;
  const ids = Object.keys(PAGES).filter((id) => PAGES[id] === ref.title);
  if (ids.length > 1) return { error: `"${ref.title}" names ${ids.length} pages; use [[page:<id>|${ref.title}]]` };
  return ids[0] ? { pageId: ids[0], label: ref.title! } : null;
};
const toMd = (d: BlockDocument) => docToMarkdown(d, { pageRef });
const fromMd = (md: string, base?: BlockDocument) => markdownToDoc(md, { base: base ?? null, resolvePage });
/** Blocks without ids (and with defaults filled in), to compare content. */
const shape = (d: BlockDocument) => JSON.parse(JSON.stringify(sanitizeDoc(d).doc.content, (k, v) => (k === 'id' ? undefined : v)));

/** Every kind of block the editor makes. */
function corpus(): BlockDocument {
  return doc(
    { type: 'heading', attrs: { id: 'h1', level: 2 }, content: [t('The Inn')] },
    p(t('Run by '), { type: 'pageLink', attrs: { pageId: 'npc1', label: 'Toblen' } }, t(', who fears '), tag('{@creature goblin|mm}'), t(' and '), t('bold', 'bold'), t(' text ', 'bold', 'italic'), t('code', 'code')),
    p(t('A '), { type: 'text', text: 'site', marks: [{ type: 'link', attrs: { href: 'https://example.org' } }] }, { type: 'hardBreak' }, t('next line ~ok~'), t('gone', 'strike')),
    { type: 'secret', attrs: { id: 's1', note: 'for later' }, content: [p(t('Toblen is a spy'))] },
    { type: 'secret', attrs: { id: 's2', revealed: true }, content: [p(t('Now everyone knows'))] },
    { type: 'paragraph', attrs: { id: 'dm1', visibility: 'dm' }, content: [t('Only the DM sees this')] },
    { type: 'paragraph', attrs: { id: 'dm2', visibility: 'dm', revealed: true }, content: [t('Revealed DM note')] },
    { type: 'callout', attrs: { id: 'c1', tone: 'warning', icon: '⚔️' }, content: [p(t('Watch out: 12:30 sharp, Status:Hostile'))] },
    { type: 'readAloud', attrs: { id: 'ra' }, content: [p(t('The door creaks.'))] },
    { type: 'blockquote', attrs: { id: 'bq' }, content: [p(t('Quoth the raven'))] },
    { type: 'horizontalRule', attrs: { id: 'hr' } },
    { type: 'encounter', attrs: { id: 'e1', encounterId: 'enc' } },
    {
      type: 'table',
      attrs: { id: 't1', roll: 'd6' },
      content: [
        { type: 'tableRow', content: [cell('tableHeader', t('d6')), cell('tableHeader', t('Result'))] },
        { type: 'tableRow', content: [cell('tableCell', t('1')), cell('tableCell', tag('{@spell fireball|phb}'))] },
        { type: 'tableRow', content: [cell('tableCell', t('2')), cell('tableCell', t('a | pipe'))] },
      ],
    },
    { type: 'bulletList', attrs: { id: 'ul' }, content: [{ type: 'listItem', content: [p(t('One'))] }, { type: 'listItem', content: [p(t('Two')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('Nested'))] }] }] }] },
    { type: 'orderedList', attrs: { id: 'ol', start: 3 }, content: [{ type: 'listItem', content: [p(t('Third'))] }] },
    { type: 'taskList', attrs: { id: 'tl' }, content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(t('Buy rope'))] }, { type: 'taskItem', attrs: { checked: false }, content: [p(t('Sell rope'))] }] },
    { type: 'details', attrs: { id: 'd1', open: true }, content: [{ type: 'detailsSummary', content: [t('More')] }, { type: 'detailsContent', content: [p(t('Hidden lore'))] }] },
    { type: 'columns', attrs: { id: 'col' }, content: [{ type: 'column', content: [p(t('Left'))] }, { type: 'column', content: [{ type: 'callout', attrs: { tone: 'tip' }, content: [p(t('Right'))] }] }] },
    { type: 'tabs', attrs: { id: 'tabs' }, content: [{ type: 'tab', attrs: { title: 'Day' }, content: [p(t('Sunny'))] }, { type: 'tab', attrs: { title: 'Night', visibility: 'dm' }, content: [p(t('Wolves'))] }] },
    { type: 'refEmbed', attrs: { id: 'r1', uid: 'monster:goblin|mm', kind: 'monster', display: 'compact' } },
    { type: 'image', attrs: { id: 'i1', src: { kind: 'upload', id: '01a13581-0061-7827-9f49-360095361b52' }, alt: 'Map', caption: 'The cave', style: 'map' } },
    { type: 'image', attrs: { id: 'i2', src: { kind: 'img', path: 'bestiary/MM/Goblin.webp' }, alt: 'Goblin' } },
    { type: 'statGrid', attrs: { id: 'sg', items: [{ label: 'Population', value: '500' }] } },
    { type: 'loot', attrs: { id: 'l1', items: [{ name: 'Silver ring', qty: 1 }] } },
    { type: 'query', attrs: { id: 'q1', title: 'NPCs here' } },
    { type: 'pageEmbed', attrs: { id: 'pe', pageId: 'loc1' } },
    p(t('Fields like '), { type: 'placeholder', attrs: { name: 'dc', valueType: 'number', label: 'DC' } }, t(' stay.')),
  );
}

describe('Markdown dialect', () => {
  it('writes every block and reads it back unchanged', () => {
    const d = corpus();
    const md = toMd(d);
    expect(md).toContain('Run by [[Toblen]], who fears {@creature goblin|mm} and **bold** **_text_** `code`');
    expect(md).toContain(':::secret{note="for later"}');
    expect(md).toContain(':::dm\nOnly the DM sees this\n:::');
    expect(md).toContain('<!-- cn:block e1 encounter');
    expect(md).toContain('| 1  | {@spell fireball|phb} |');
    expect(md).toContain('- [x] Buy rope');
    expect(md).toContain('::embed{uid="monster:goblin|mm" display="compact"}');
    expect(md).toContain('![Map](/api/uploads/01a13581-0061-7827-9f49-360095361b52 "The cave")');
    expect(md).toContain('Watch out: 12:30 sharp, Status:Hostile');
    const back = fromMd(md, d);
    expect(back.warnings).toEqual([]);
    // Everything, ids and attributes Markdown can't show included, survives
    expect(back.doc.content).toEqual(sanitizeDoc(d).doc.content);
    expect(toMd(back.doc)).toBe(md);
  });

  it('reads a fresh document written by a model', () => {
    const md = [
      '# Ruins of Thundertree',
      '',
      'Dragon *Venomfang* lairs here; see [[Stonehill Inn]] and {@creature young green dragon|mm}.',
      '',
      ':::secret',
      'The druid **Reidoth** knows the way.',
      ':::',
      '',
      ':::callout{tone=danger}',
      'Ash zombies!',
      ':::',
      '',
      ':::dm',
      'Treasure: 300 gp.',
      ':::',
      '',
      '::embed{uid="monster:ash zombie|lmop"}',
      '',
      ':::roll-table{dice=d4}',
      '| d4 | Encounter |',
      '| --- | --- |',
      '| 1 | {@creature twig blight|mm} |',
      ':::',
    ].join('\n');
    const { doc: d, warnings } = fromMd(md);
    expect(warnings).toEqual([]);
    const types = d.content!.map((b) => `${b.type}${b.attrs?.visibility === 'dm' ? '(dm)' : ''}`);
    expect(types).toEqual(['heading', 'paragraph', 'secret', 'callout', 'paragraph(dm)', 'refEmbed', 'table']);
    expect(d.content![1]!.content).toEqual([
      { type: 'text', text: 'Dragon ' },
      { type: 'text', text: 'Venomfang', marks: [{ type: 'italic' }] },
      { type: 'text', text: ' lairs here; see ' },
      { type: 'pageLink', attrs: { pageId: 'loc1', label: 'Stonehill Inn' } },
      { type: 'text', text: ' and ' },
      { type: 'tag', attrs: { markup: '{@creature young green dragon|mm}' } },
      { type: 'text', text: '.' },
    ]);
    expect(d.content![3]!.attrs).toMatchObject({ tone: 'danger' });
    expect(d.content![5]!.attrs).toMatchObject({ uid: 'monster:ash zombie|lmop', kind: 'monster' });
    expect(d.content![6]!.attrs).toMatchObject({ roll: 'd4' });
    expect(JSON.stringify(d.content![6])).toContain('{@creature twig blight|mm}');
  });

  it('keeps page links unambiguous', () => {
    const d = doc(p({ type: 'pageLink', attrs: { pageId: 'dup2', label: 'Twin' } }));
    expect(toMd(d)).toBe('[[page:dup2|Twin]]\n');
    expect(fromMd('[[Twin]]').warnings).toEqual(['"Twin" names 2 pages; use [[page:<id>|Twin]]']);
    expect(fromMd('See [[Nowhere]].').doc.content![0]!.content).toEqual([{ type: 'text', text: 'See [[Nowhere]].' }]);
    expect(fromMd('See [[Nowhere]].').warnings).toEqual(['No page "Nowhere" to link; it was kept as text']);
  });

  it('reports what it could not keep as written', () => {
    const cases: [string, string][] = [
      ['##### Deep', 'Headings go down to level 4'],
      ['```\nlet x = 1\n```', 'Code blocks are not supported'],
      ['[x](javascript:alert(1))', 'Links need an http(s)'],
      ['<div>hi</div>', 'HTML is not supported'],
      ['Text ![pic](https://example.org/a.png) inline', 'Images must stand alone'],
      [':::sparkles\nshiny\n:::', 'Unknown container ":::sparkles"'],
      [':::secret\nnever closed', '":::secret" was not closed'],
      [':::callout{tone=purple}\nhm\n:::', 'Callout tones are'],
      ['<!-- cn:block zzz encounter -->', 'No block "zzz" to restore'],
      ['::embed{uid="goblin"}', '"::embed" needs a uid'],
    ];
    for (const [md, warning] of cases) expect({ md, warnings: fromMd(md).warnings.join(' | ') }).toEqual({ md, warnings: expect.stringContaining(warning) });
    // Dangerous links never reach the document
    expect(JSON.stringify(fromMd('[x](javascript:alert(1))').doc)).not.toContain('javascript');
    expect(fromMd('##### Deep').doc.content![0]!.attrs).toMatchObject({ level: 4 });
  });

  it('keeps literal text literal', () => {
    for (const text of ['2 * 3 * 4', 'Use [[double brackets]] literally', 'A {{field}} without a field', 'Literal <!-- cn:block x --> text', '# not a heading', 'C:\\path\\to', 'a | b']) {
      const d = doc(p(t(text)));
      const back = markdownToDoc(toMd(d), {});
      expect({ text, back: back.doc.content![0]!.content }).toEqual({ text, back: [{ type: 'text', text }] });
    }
  });

  it('turns {{fields}} back into fields only where the page had them', () => {
    const base = doc(p({ type: 'placeholder', attrs: { name: 'dc', valueType: 'number', label: 'DC' } }));
    expect(fromMd('DC {{dc}} and {{other}}', base).doc.content![0]!.content).toEqual([
      { type: 'text', text: 'DC ' },
      { type: 'placeholder', attrs: { name: 'dc', valueType: 'number', label: 'DC' } },
      { type: 'text', text: ' and {{other}}' },
    ]);
  });
});

describe('editing through Markdown', () => {
  it('changes only what the model changed', () => {
    const base = doc(
      { type: 'paragraph', attrs: { id: 'a', textAlign: 'center' }, content: [t('Centered'), t(' and underlined', 'underline')] },
      { type: 'paragraph', attrs: { id: 'b', textAlign: 'right' }, content: [t('Edit me')] },
      { type: 'paragraph', attrs: { id: 'gap' } },
      { type: 'encounter', attrs: { id: 'enc', encounterId: 'e1' } },
      { type: 'paragraph', attrs: { id: 'c' }, content: [t('Delete me')] },
    );
    const md = toMd(base).replace('Edit me', 'Edited').replace('Delete me\n', 'Brand new\n');
    const { doc: next } = fromMd(md, base);
    const blocks = next.content!;
    // Unchanged: the original block, underline and alignment included
    expect(blocks[0]).toEqual(sanitizeDoc(base).doc.content![0]);
    // Edited: new text, same id and alignment
    expect(blocks[1]).toMatchObject({ attrs: { id: 'b', textAlign: 'right' }, content: [{ type: 'text', text: 'Edited' }] });
    // The empty paragraph (not shown in Markdown) stays where it was
    expect(blocks[2]!.attrs?.id).toBe('gap');
    expect(blocks[3]!.attrs).toMatchObject({ id: 'enc', encounterId: 'e1' });
    expect(blocks[4]).toMatchObject({ attrs: { id: 'c' }, content: [{ type: 'text', text: 'Brand new' }] });
  });

  it('moves and deletes placeholders like any other line', () => {
    const base = doc(p(t('First')), { type: 'encounter', attrs: { id: 'enc', encounterId: 'e1' } }, { type: 'loot', attrs: { id: 'loot' } }, p(t('Last')));
    const lines = toMd(base).split('\n\n');
    const moved = fromMd([lines[1], lines[0], lines[3]].join('\n\n'), base).doc.content!;
    expect(moved.map((b) => b.attrs?.id)).toEqual(['enc', base.content![0]!.attrs!.id, base.content![3]!.attrs!.id]);
  });

  it('keeps nested ids when a container is edited', () => {
    const base = doc({ type: 'callout', attrs: { id: 'co', tone: 'tip' }, content: [p(t('Keep')), p(t('Change'))] });
    const next = fromMd(toMd(base).replace('Change', 'Changed'), base).doc.content![0]!;
    expect(next.attrs?.id).toBe('co');
    expect(next.content!.map((b) => b.attrs?.id)).toEqual(base.content![0]!.content!.map((b) => b.attrs?.id));
  });

  it("lets a player edit their page without moving the DM's hidden blocks", () => {
    const stored = doc(p(t('Wren, a bard.')), { type: 'paragraph', attrs: { id: 'hidden', visibility: 'dm' }, content: [t('Her sister lives')] }, p(t('Likes songs.')));
    const ctx: ProjectContext = { role: 'player', canSeePage: () => true };
    const received = projectDoc(stored, ctx)!;
    expect(toMd(received)).not.toContain('sister');
    const edited = fromMd(toMd(received).replace('Likes songs.', 'Likes songs and ale.'), received).doc;
    const merged = mergePlayerEdit(stored, edited, ctx);
    expect(merged.content!.map((b) => b.attrs?.id)).toEqual(stored.content!.map((b) => b.attrs?.id));
    expect(JSON.stringify(merged)).toContain('Likes songs and ale.');
  });
});

describe('templates', () => {
  it('refers to blocks by position and keeps bindings', () => {
    const base = doc(
      { type: 'paragraph', content: [t('Trap DC {{dc: number = 13}}')] },
      { type: 'refEmbed', attrs: { uid: { $var: 'creature' }, display: 'full' } },
      { type: 'paragraph', content: [t('Becomes '), { type: 'tag', attrs: { markup: { $rulesetTag: 'condition:poisoned' } } }] },
    );
    const md = docToMarkdown(base, { mode: 'template' });
    expect(md).toContain('Trap DC {{dc: number = 13}}');
    expect(md).toContain('<!-- cn:block @1 refEmbed');
    expect(md).toContain('<!-- cn:block @2 paragraph');
    const back = markdownToDoc(md.replace('13', '15'), { mode: 'template', base });
    expect(back.doc.content![0]!.content).toEqual([{ type: 'text', text: 'Trap DC {{dc: number = 15}}' }]);
    expect(back.doc.content![1]!.attrs?.uid).toEqual({ $var: 'creature' });
    expect(JSON.stringify(back.doc.content![2])).toContain('$rulesetTag');
  });
});

describe('shape', () => {
  it('is what the server stores', () => {
    expect(shape(fromMd('Hello').doc)).toEqual([{ type: 'paragraph', attrs: { textAlign: null, visibility: 'inherit', revealed: false }, content: [{ type: 'text', text: 'Hello' }] }]);
  });
});
