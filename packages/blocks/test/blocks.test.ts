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

  it('keeps empty values last in both directions', () => {
    // Sildar has no level, Phandalin neither; Toblen 2, Glasstaff 9
    expect(q({ sort: { field: 'prop.level', dir: 'asc' } }, null)).toEqual(['Toblen', 'Glasstaff', 'Phandalin', 'Sildar']);
    expect(q({ sort: { field: 'prop.level', dir: 'desc' } }, null)).toEqual(['Glasstaff', 'Toblen', 'Phandalin', 'Sildar']);
    // An empty list or text counts as empty too
    expect(q({ sort: { field: 'tags', dir: 'desc' } }, null).slice(-1)).toEqual(['Sildar']);
    expect(q({ sort: { field: 'tags', dir: 'asc' } }, null).slice(-1)).toEqual(['Sildar']);
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

  it('players cannot reveal: new blocks (children too) arrive unrevealed and stored flags are kept', () => {
    const seen = projectDoc(stored, ctx)!;
    const secret = { type: 'secret', attrs: { id: 'new1', revealed: true }, content: [p('Mine', { revealed: true })] };
    const merged = mergePlayerEdit(stored, { ...seen, content: [...seen.content!, secret] }, ctx);
    const added = merged.content!.find((b) => b.attrs?.id === 'new1')!;
    expect(added.attrs?.revealed).toBe(false);
    expect(added.content![0]!.attrs?.revealed).toBeFalsy();
    // Re-submitting the id of a block the player never saw gives a copy that is also unrevealed
    const hidden = stored.content!.find((b) => b.type === 'secret')!;
    const copy = mergePlayerEdit(stored, { ...seen, content: [...seen.content!, { ...hidden, attrs: { ...hidden.attrs, revealed: true } }] }, ctx);
    expect(copy.content!.filter((b) => b.type === 'secret').every((b) => !b.attrs?.revealed)).toBe(true);
    // No stored content: still cleared
    expect(mergePlayerEdit(null, { type: 'doc', content: [secret] } as never, ctx).content![0]!.attrs?.revealed).toBe(false);
  });

  it('clears revealed on new children of a stored container with no blocks, and keeps the stored flag of an already revealed block', () => {
    // Built by hand (sanitizeDoc would not allow an empty container): ids and flags exactly as given
    const raw = {
      type: 'doc',
      content: [
        { type: 'callout', attrs: { id: 'k1' }, content: [] },
        { type: 'paragraph', attrs: { id: 'r1', visibility: 'dm', revealed: true }, content: [{ type: 'text', text: 'Shown' }] },
      ],
    } as unknown as BlockDocument;
    const submitted = {
      type: 'doc',
      content: [
        { type: 'callout', attrs: { id: 'k1' }, content: [{ type: 'secret', attrs: { id: 'n1', revealed: true }, content: [p('x', { revealed: true })] }] },
        { type: 'paragraph', attrs: { id: 'r1', visibility: 'dm', revealed: true }, content: [{ type: 'text', text: 'Shown (edited)' }] },
      ],
    } as unknown as BlockDocument;
    const merged = mergePlayerEdit(raw, submitted, ctx);
    const child = merged.content![0]!.content![0]!;
    expect(child.attrs?.revealed).toBe(false);
    expect(child.content![0]!.attrs?.revealed).toBeFalsy();
    expect(merged.content![1]!.attrs?.revealed).toBe(true);
  });

  it('never loses hidden blocks when the player deletes their neighbours', () => {
    const merged = mergePlayerEdit(stored, { type: 'doc', content: [p('Only this')] }, ctx);
    expect(lines(merged, 'dm')).toEqual(['Only this', 'DM: he is cursed', 'Hidden tip', 'True parentage']);
  });

  it('puts back DM-only children of a visible container submitted without its content', () => {
    const seen = projectDoc(stored, ctx)!;
    const { content: _gone, ...bare } = seen.content![2]!;
    const merged = mergePlayerEdit(stored, { ...seen, content: [seen.content![0]!, seen.content![1]!, bare] }, ctx);
    expect(lines(merged, 'dm')).toContain('Hidden tip');
  });

  it('does not duplicate DM-only children for a repeated id, nor let a new block take a hidden id', () => {
    const seen = projectDoc(stored, ctx)!;
    const hiddenId = (stored.content![1]!.attrs as { id: string }).id;
    const merged = mergePlayerEdit(stored, { ...seen, content: [...seen.content!, seen.content![2]!, p('Squatter', { id: hiddenId })] }, ctx);
    expect(lines(merged, 'dm').filter((l) => l === 'Hidden tip')).toHaveLength(1);
    expect(lines(merged, 'dm').filter((l) => l === 'DM: he is cursed')).toHaveLength(1);
    expect(JSON.stringify(merged).match(new RegExp(`"id":"${hiddenId}"`, 'g'))).toHaveLength(1);
  });

  it('does not let a nested new block take the id of a hidden block elsewhere in the document', () => {
    const base = sanitizeDoc(doc({ type: 'callout', content: [p('Tip')] }, p('hid', { visibility: 'dm' })), { newId }).doc;
    const hiddenId = (base.content![1]!.attrs as { id: string }).id;
    const seen = projectDoc(base, ctx)!;
    const callout = seen.content![0]!;
    const merged = mergePlayerEdit(base, { ...seen, content: [{ ...callout, content: [...callout.content!, p('Squatter', { id: hiddenId })] }] }, ctx);
    const out = sanitizeDoc(merged, { newId }).doc;
    expect((out.content![1]!.attrs as { id: string }).id).toBe(hiddenId);
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

describe('query block columns and player projection', () => {
  const query = (attrs: Record<string, unknown>) => ({ type: 'query', attrs: { id: 'q1', ...attrs } });
  const hidden = (f: string) => f === 'prop.secret' || f === 'facet.statblockUid';
  const ctx = { role: 'player' as const, canSeePage: () => true, isHiddenField: hidden };
  const attrsOf = (d: BlockDocument | null) => d!.content![0]!.attrs as Record<string, unknown>;

  it('drops bad column keys instead of wiping the block attributes', () => {
    const { doc: out } = sanitizeDoc(
      doc(query({ title: 'Mine', view: 'table', filter: { types: ['npc'] }, columns: ['facet.status', 'title', 'bogus', 7, 'prop.a b', 'facet.status', 'tags'] })),
      { newId },
    );
    expect(attrsOf(out)).toMatchObject({ title: 'Mine', view: 'table', filter: { types: ['npc'] }, columns: ['facet.status', 'tags'] });
  });

  it('caps columns at 10 and defaults a missing or non-array list to empty', () => {
    const many = Array.from({ length: 14 }, (_, i) => `prop.p${i}`);
    expect((attrsOf(sanitizeDoc(doc(query({ columns: many })), { newId }).doc)['columns'] as string[]).length).toBe(10);
    expect(attrsOf(sanitizeDoc(doc(query({})), { newId }).doc)['columns']).toEqual([]);
    expect(attrsOf(sanitizeDoc(doc(query({ columns: 'tags' })), { newId }).doc)['columns']).toEqual([]);
  });

  it('removes DM-only columns and resets a DM-only default sort for players', () => {
    const d = sanitizeDoc(doc(query({ view: 'table', columns: ['prop.secret', 'prop.mood', 'facet.statblockUid', 'type'], filter: { sort: { field: 'prop.secret', dir: 'desc' } } })), { newId }).doc;
    const seen = attrsOf(projectDoc(d, ctx));
    expect(seen['columns']).toEqual(['prop.mood', 'type']);
    expect(seen['filter']).toMatchObject({ sort: { field: 'title', dir: 'asc' } });
    expect(JSON.stringify(seen)).not.toContain('secret');
    // A visible sort stays
    const ok = sanitizeDoc(doc(query({ filter: { sort: { field: 'prop.mood', dir: 'desc' } } })), { newId }).doc;
    expect(attrsOf(projectDoc(ok, ctx))['filter']).toMatchObject({ sort: { field: 'prop.mood', dir: 'desc' } });
  });

  it('leaves the block alone when the context cannot tell hidden fields (exports, merges)', () => {
    const d = sanitizeDoc(doc(query({ columns: ['prop.secret'] })), { newId }).doc;
    expect(attrsOf(projectDoc(d, { role: 'player', canSeePage: () => true }))['columns']).toEqual(['prop.secret']);
    expect(projectDoc(d, { role: 'dm', canSeePage: () => true, isHiddenField: hidden })).toBe(d);
  });

  it('keeps the stored columns and sort when a player saves the cleaned copy', () => {
    const stored = sanitizeDoc(doc(query({ columns: ['prop.secret', 'prop.mood'], filter: { sort: { field: 'prop.secret', dir: 'desc' } } })), { newId }).doc;
    const seen = projectDoc(stored, ctx)!;
    const merged = mergePlayerEdit(stored, seen, ctx);
    expect(attrsOf(merged)['columns']).toEqual(['prop.secret', 'prop.mood']);
    expect(attrsOf(merged)['filter']).toMatchObject({ sort: { field: 'prop.secret', dir: 'desc' } });
  });

  it('keeps every hidden key when the player’s visible list is already full', () => {
    const visible = Array.from({ length: 9 }, (_, i) => `prop.v${i}`);
    const stored = sanitizeDoc(doc(query({ columns: ['prop.secret', 'facet.statblockUid', ...visible.slice(0, 8)] })), { newId }).doc;
    const seen = projectDoc(stored, ctx)!;
    const edited = { ...seen, content: [{ ...seen.content![0]!, attrs: { ...attrsOf(seen), columns: [...visible, 'type'] } }] };
    const columns = attrsOf(sanitizeDoc(mergePlayerEdit(stored, edited, ctx), { newId }).doc)['columns'] as string[];
    expect(columns).toHaveLength(10);
    expect(columns).toEqual(expect.arrayContaining(['prop.secret', 'facet.statblockUid']));
    expect(columns.slice(0, 8)).toEqual(visible.slice(0, 8));
  });

  it('applies a player’s own column change and still keeps the hidden keys', () => {
    const stored = sanitizeDoc(doc(query({ columns: ['prop.secret', 'prop.mood'] })), { newId }).doc;
    const seen = projectDoc(stored, ctx)!;
    const edited = { ...seen, content: [{ ...seen.content![0]!, attrs: { ...attrsOf(seen), columns: ['type', 'prop.mood'] } }] };
    expect(attrsOf(mergePlayerEdit(stored, edited, ctx))['columns']).toEqual(['type', 'prop.mood', 'prop.secret']);
  });
});
