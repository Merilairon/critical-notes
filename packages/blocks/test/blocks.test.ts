import { describe, expect, it } from 'vitest';
import { docLinks, docText, mergePlayerEdit, projectDoc, runQuery, queryFilterSchema, sanitizeDoc, tagEntity, type BlockDocument, type QueryablePage } from '../src/index';

let n = 0;
const newId = () => `blk_${++n}`;

const p = (text: string, attrs: Record<string, unknown> = {}) => ({ type: 'paragraph', attrs, content: [{ type: 'text', text }] });

const doc = (...content: unknown[]): BlockDocument => ({ type: 'doc', content: content as never });

describe('sanitizeDoc', () => {
  it('fills defaults, assigns ids, keeps valid content', () => {
    const { doc: out, issues } = sanitizeDoc(doc(p('Hello'), { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Title', marks: [{ type: 'bold' }] }] }), { newId });
    expect(issues).toEqual([]);
    expect(out.schemaVersion).toBe(1);
    expect(out.content![0]).toMatchObject({ type: 'paragraph', attrs: { id: expect.stringMatching(/^blk_/), visibility: 'inherit', revealed: false } });
    expect(out.content![1]).toMatchObject({ type: 'heading', attrs: { level: 3 }, content: [{ text: 'Title', marks: [{ type: 'bold' }] }] });
  });

  it('wraps unknown blocks losslessly and flags them', () => {
    const weird = { type: 'hologram', attrs: { beam: 1 }, content: [] };
    const { doc: out, issues } = sanitizeDoc(doc(weird), { newId });
    expect(out.content![0]).toMatchObject({ type: 'unknownBlock', attrs: { raw: weird } });
    expect(issues[0]).toMatch(/Unknown block "hologram"/);
  });

  it('drops unsafe links and unknown marks; repairs invalid attrs', () => {
    const { doc: out, issues } = sanitizeDoc(
      doc(
        { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }, { type: 'blink' }, { type: 'italic' }] }] },
        { type: 'heading', attrs: { level: 99 }, content: [] },
      ),
    );
    expect(out.content![0]!.content![0]).toEqual({ type: 'text', text: 'x', marks: [{ type: 'italic' }] });
    expect(out.content![1]!.attrs!.level).toBe(2);
    expect(issues.length).toBe(3);
  });

  it('keeps safe links and the HTML-looking text as plain text', () => {
    const { doc: out } = sanitizeDoc(doc({ type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script>', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] }));
    expect(out.content![0]!.content![0]).toMatchObject({ text: '<script>alert(1)</script>', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] });
  });

  it('enforces content rules', () => {
    const { doc: out } = sanitizeDoc(
      doc(
        { type: 'bulletList', content: [{ type: 'listItem', content: [p('a')] }, p('not an item')] },
        { type: 'text', text: 'stray inline' },
        { type: 'columns', content: [{ type: 'column', content: [] }] },
      ),
    );
    expect(out.content![0]!.content).toHaveLength(1);
    expect(out.content![1]).toMatchObject({ type: 'paragraph', content: [{ text: 'stray inline' }] });
    expect(out.content![2]!.content![0]!.content).toHaveLength(1); // empty column gets a paragraph
  });

  it('validates inline nodes, turning invalid ones into text', () => {
    const { doc: out } = sanitizeDoc(
      doc({ type: 'paragraph', content: [{ type: 'tag', attrs: { markup: '{@spell fireball|xphb}' } }, { type: 'tag', attrs: { markup: 'not markup' } }, { type: 'pageLink', attrs: { pageId: 'p1', label: 'Inn' } }] }),
    );
    expect(out.content![0]!.content).toEqual([
      { type: 'tag', attrs: { markup: '{@spell fireball|xphb}' } },
      { type: 'text', text: 'not markup' },
      { type: 'pageLink', attrs: { pageId: 'p1', label: 'Inn' } },
    ]);
  });

  it('replaces non-documents and truncates oversized ones', () => {
    expect(sanitizeDoc('nope').doc.content).toHaveLength(1);
    const big = doc(...Array.from({ length: 50 }, (_, i) => p(String(i))));
    const { doc: out, issues } = sanitizeDoc(big, { maxNodes: 20 });
    expect(out.content!.length).toBeLessThan(50);
    expect(issues).toContain('Document too large; truncated');
  });
});

describe('projectDoc (player visibility)', () => {
  const d = sanitizeDoc(
    doc(
      p('Public intro'),
      p('DM note', { visibility: 'dm' }),
      p('Revealed clue', { visibility: 'dm', revealed: true }),
      { type: 'secret', content: [p('The duke is a vampire')] },
      { type: 'secret', attrs: { revealed: true }, content: [p('The bridge is out')] },
      { type: 'callout', content: [p('Visible'), p('Nested secret', { visibility: 'dm' })] },
      { type: 'paragraph', content: [{ type: 'text', text: 'See ' }, { type: 'pageLink', attrs: { pageId: 'secret-page', label: 'Vampire lair' } }, { type: 'pageLink', attrs: { pageId: 'open', label: 'Tavern' } }] },
      { type: 'pageEmbed', attrs: { pageId: 'secret-page' } },
      { type: 'hologram' },
      { type: 'encounter', attrs: { encounterId: 'ambush-at-the-bridge' } },
    ),
    { newId },
  ).doc;
  const ctx = { role: 'player' as const, canSeePage: (id: string) => id === 'open' };

  it('removes DM-only and unrevealed secret blocks (with subtrees) for players', () => {
    const text = JSON.stringify(projectDoc(d, ctx));
    expect(text).not.toContain('DM note');
    expect(text).not.toContain('vampire');
    expect(text).not.toContain('Nested secret');
    expect(text).not.toContain('hologram');
    expect(text).not.toContain('ambush-at-the-bridge'); // encounters are for the DM
    expect(text).toContain('Revealed clue');
    expect(text).toContain('The bridge is out');
    expect(text).toContain('Visible');
  });

  it('turns links to invisible pages into text and drops their embeds', () => {
    const out = projectDoc(d, ctx)!;
    const para = out.content!.find((b) => JSON.stringify(b).includes('Tavern'))!;
    expect(para.content).toEqual([
      { type: 'text', text: 'See ' },
      { type: 'text', text: 'Vampire lair' },
      { type: 'pageLink', attrs: { pageId: 'open', label: 'Tavern' } },
    ]);
    expect(out.content!.some((b) => b.type === 'pageEmbed')).toBe(false);
  });

  it('leaves the document untouched for the DM', () => {
    expect(projectDoc(d, { role: 'dm', canSeePage: () => false })).toBe(d);
  });

  it('extracts DM and player text', () => {
    expect(docText(d, 'dm')).toContain('The duke is a vampire');
    expect(docText(d, 'player')).not.toContain('vampire');
    expect(docText(d, 'player')).toContain('Public intro');
  });
});

describe('docLinks', () => {
  it('collects page mentions, embeds and entity references', () => {
    const d = doc(
      { type: 'paragraph', content: [{ type: 'pageLink', attrs: { pageId: 'a', label: 'A' } }, { type: 'tag', attrs: { markup: '{@creature goblin|mm}' } }, { type: 'text', text: 'and {@spell fireball|xphb}' }] },
      { type: 'pageEmbed', attrs: { pageId: 'b' } },
      { type: 'refEmbed', attrs: { uid: 'item:longsword|xphb', kind: 'item' } },
    );
    const links = docLinks(d);
    expect(links.pages).toEqual([{ pageId: 'a', kind: 'mention' }, { pageId: 'b', kind: 'embed' }]);
    expect(links.entities.map((e) => e.uid).sort()).toEqual(['item:longsword|xphb', 'monster:goblin|mm', 'spell:fireball|xphb']);
    expect(tagEntity('{@condition poisoned|xphb}')).toEqual({ uid: 'condition:poisoned|xphb', kind: 'condition' });
    expect(tagEntity('{@b bold}')).toBeNull();
  });
});

describe('runQuery', () => {
  const pages: QueryablePage[] = [
    { id: 'l1', parentId: null, type: 'location', title: 'Phandalin', tags: ['town'], facet: { kind: 'settlement' }, props: {}, createdAt: 1, updatedAt: 5 },
    { id: 'n1', parentId: 'l1', type: 'npc', title: 'Toblen', tags: ['innkeeper'], facet: { locationPageId: 'l1', status: 'alive' }, props: { level: 2 }, createdAt: 2, updatedAt: 3 },
    { id: 'n2', parentId: null, type: 'npc', title: 'Glasstaff', tags: ['villain', 'wizard'], facet: { locationPageId: 'l1', status: 'missing' }, props: { level: 9 }, createdAt: 3, updatedAt: 9 },
    { id: 'n3', parentId: null, type: 'npc', title: 'Sildar', tags: [], facet: { locationPageId: null, status: 'alive' }, props: {}, createdAt: 4, updatedAt: 1 },
  ];
  const q = (input: unknown, ctx: string | null = 'l1') => runQuery(pages, queryFilterSchema.parse(input), ctx).map((p) => p.title);

  it('filters by type, tags and facet values relative to the current page', () => {
    expect(q({ types: ['npc'], where: [{ field: 'facet.locationPageId', op: 'eq', value: { $ctx: 'currentPage' } }] })).toEqual(['Glasstaff', 'Toblen']);
    expect(q({ types: ['npc'], tags: ['Villain'] })).toEqual(['Glasstaff']);
    expect(q({ parent: { $ctx: 'currentPage' } })).toEqual(['Toblen']);
    expect(q({ types: ['npc'], where: [{ field: 'facet.status', op: 'in', value: ['missing', 'dead'] }] })).toEqual(['Glasstaff']);
    expect(q({ where: [{ field: 'facet.locationPageId', op: 'empty' }], types: ['npc'] })).toEqual(['Sildar']);
    expect(q({ where: [{ field: 'title', op: 'contains', value: 'blen' }] })).toEqual(['Toblen']);
    expect(q({ where: [{ field: 'prop.level', op: 'gt', value: 5 }] })).toEqual(['Glasstaff']);
  });

  it('sorts and limits; never returns the current page itself', () => {
    expect(q({ sort: { field: 'updatedAt', dir: 'desc' } }, null)).toEqual(['Glasstaff', 'Phandalin', 'Toblen', 'Sildar']);
    expect(q({ sort: { field: 'updatedAt', dir: 'desc' }, limit: 2 }, null)).toEqual(['Glasstaff', 'Phandalin']);
    expect(q({})).not.toContain('Phandalin');
  });
});

describe('mergePlayerEdit', () => {
  const ctx = { role: 'player' as const, canSeePage: () => true };
  const lines = (d: BlockDocument | null, mode: 'dm' | 'player') => docText(d, mode).split(/\n+/);
  const stored = sanitizeDoc(
    doc(
      p('Intro'),
      p('DM: he is cursed', { visibility: 'dm' }),
      p('Backstory'),
      { type: 'callout', content: [p('Visible tip'), p('Hidden tip', { visibility: 'dm' })] },
      { type: 'secret', content: [p('True parentage')] },
    ),
    { newId },
  ).doc;

  it('keeps hidden blocks where they were while applying the player’s changes', () => {
    const seen = projectDoc(stored, ctx)!;
    const [intro, backstory, callout] = seen.content!;
    const edited = {
      ...seen,
      content: [
        { ...intro!, content: [{ type: 'text', text: 'Intro (edited)' }] },
        backstory!,
        { ...callout!, content: [...callout!.content!, p('New tip')] },
        p('Added by the player'),
      ],
    };
    const merged = mergePlayerEdit(stored, edited, ctx);
    expect(lines(merged, 'dm')).toEqual(['Intro (edited)', 'DM: he is cursed', 'Backstory', 'Visible tip', 'Hidden tip', 'New tip', 'True parentage', 'Added by the player']);
    // What the player sees afterwards is exactly what they saved
    expect(lines(projectDoc(merged, ctx), 'player')).toEqual(['Intro (edited)', 'Backstory', 'Visible tip', 'New tip', 'Added by the player']);
  });

  it('never loses hidden blocks when the player deletes their neighbours', () => {
    const merged = mergePlayerEdit(stored, { type: 'doc', content: [p('Only this')] }, ctx);
    expect(lines(merged, 'dm')).toEqual(['Only this', 'DM: he is cursed', 'Hidden tip', 'True parentage']);
  });

  describe('a DM link to a page the player cannot see, inside a visible paragraph', () => {
    const linkCtx = { role: 'player' as const, canSeePage: (id: string) => id !== 'hidden-page' };
    const storedLinks = sanitizeDoc(
      doc(
        { type: 'paragraph', content: [{ type: 'text', text: 'Met ' }, { type: 'pageLink', attrs: { pageId: 'hidden-page', label: 'the vampire' } }, { type: 'text', text: ' once' }] },
        p('Backstory'),
      ),
      { newId },
    ).doc;

    it('never sends the hidden page id to the player', () => {
      const seen = projectDoc(storedLinks, linkCtx);
      expect(JSON.stringify(seen)).not.toContain('hidden-page');
      expect(docText(seen, 'player')).toContain('the vampire');
    });

    it('keeps the link when the player edits another paragraph', () => {
      const seen = projectDoc(storedLinks, linkCtx)!;
      const [first, backstory] = seen.content!;
      const edited = { ...seen, content: [first!, { ...backstory!, content: [{ type: 'text', text: 'Backstory (edited)' }] }] };
      const merged = mergePlayerEdit(storedLinks, edited, linkCtx);
      expect(JSON.stringify(merged.content![0])).toContain('"pageId":"hidden-page"');
      expect(docText(merged, 'dm')).toContain('Backstory (edited)');
    });

    it('keeps the link when the player edits the paragraph around it but leaves its label text', () => {
      const seen = projectDoc(storedLinks, linkCtx)!;
      const [first, backstory] = seen.content!;
      const edited = { ...seen, content: [{ ...first!, content: [{ type: 'text', text: 'Never met the vampire again' }] }, backstory!] };
      const merged = mergePlayerEdit(storedLinks, edited, linkCtx);
      expect(JSON.stringify(merged.content![0])).toContain('"pageId":"hidden-page"');
      expect(docText(merged, 'dm')).toContain('Never met');
    });
  });
});
