import { collapse, diffDegrades, diffFields, diffLines, diffWords, MAX_DIFF_CELLS, showValue, summarize, summaryText, type DiffLine } from './history-diff';

const kinds = (l: DiffLine[]) => l.map((x) => x.kind);
const text = (l: DiffLine) => l.parts.map((p) => p.text).join('');
const changed = (l: DiffLine) => l.parts.filter((p) => p.changed).map((p) => p.text);
const nLines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i}`);

describe('diffLines', () => {
  it('identical texts have only equal lines', () => {
    const d = diffLines('a\nb', 'a\nb');
    expect(kinds(d)).toEqual(['equal', 'equal']);
    expect(summaryText(summarize(d))).toBe('No text differences.');
  });

  it('empty to text is all added, text to empty all removed', () => {
    expect(kinds(diffLines('', 'a\nb'))).toEqual(['added', 'added']);
    expect(kinds(diffLines('a\nb', ''))).toEqual(['removed', 'removed']);
    expect(diffLines('', '')).toEqual([]);
  });

  it('a pure add keeps the neighbours as context', () => {
    const d = diffLines('a\nc', 'a\nb\nc');
    expect(kinds(d)).toEqual(['equal', 'added', 'equal']);
    expect(text(d[1])).toBe('b');
  });

  it('a pure remove', () => {
    expect(kinds(diffLines('a\nb\nc', 'a\nc'))).toEqual(['equal', 'removed', 'equal']);
  });

  it('pairs a replaced line and marks only the changed word', () => {
    const d = diffLines('The harbour master Aldric keeps the keys', 'The harbour master Brenna keeps the keys');
    expect(kinds(d)).toEqual(['removed', 'added']);
    expect(changed(d[0])).toEqual(['Aldric']);
    expect(changed(d[1])).toEqual(['Brenna']);
    expect(text(d[0])).toBe('The harbour master Aldric keeps the keys');
    expect(summaryText(summarize(d))).toBe('Text: 1 word added, 1 word removed in 1 place.');
  });

  it('shows a fully different pair as two whole lines', () => {
    const d = diffLines('alpha', 'omega');
    expect(d.map((l) => l.parts)).toEqual([[{ text: 'alpha', changed: true }], [{ text: 'omega', changed: true }]]);
  });

  it('leaves unpaired lines as whole-line changes', () => {
    const d = diffLines('one two\nextra', 'one three');
    expect(kinds(d)).toEqual(['removed', 'removed', 'added']);
    expect(changed(d[1])).toEqual(['extra']);
  });

  it('treats CRLF like LF', () => {
    expect(kinds(diffLines('a\r\nb', 'a\nb'))).toEqual(['equal', 'equal']);
  });

  it('counts separate places', () => {
    const d = diffLines('a\nb\nc\nd\ne', 'a\nB\nc\nd\nE');
    expect(summarize(d).places).toBe(2);
  });

  it('falls back to one removed and one added block above the size guard', () => {
    const n = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 5;
    const a = ['top', ...nLines(n, 'x'), 'bottom'].join('\n');
    const b = ['top', ...nLines(n, 'y'), 'bottom'].join('\n');
    const d = diffLines(a, b);
    expect(d[0].kind).toBe('equal');
    expect(d.at(-1)!.kind).toBe('equal');
    expect(d.filter((l) => l.kind === 'removed')).toHaveLength(n);
    expect(d.filter((l) => l.kind === 'added')).toHaveLength(n);
  });
});

describe('diffWords', () => {
  it('keeps whitespace out of the changed flag', () => {
    const w = diffWords('a b c', 'a x c');
    expect(w.removed.filter((p) => p.changed).map((p) => p.text)).toEqual(['b']);
    expect(w.added.filter((p) => p.changed).map((p) => p.text)).toEqual(['x']);
  });
});

describe('collapse', () => {
  it('keeps a run of exactly 6 unchanged lines', () => {
    const d = diffLines(['a', ...nLines(6), 'b'].join('\n'), ['A', ...nLines(6), 'B'].join('\n'));
    expect(collapse(d).some((i) => i.type === 'gap')).toBe(false);
  });

  it('collapses a run of 7 with 3 lines of context on each side', () => {
    const d = diffLines(['a', ...nLines(7), 'b'].join('\n'), ['A', ...nLines(7), 'B'].join('\n'));
    const items = collapse(d);
    const gap = items.find((i) => i.type === 'gap');
    expect(gap?.type === 'gap' && gap.hidden).toHaveLength(1);
    expect(items.filter((i) => i.type === 'line')).toHaveLength(d.length - 1);
  });

  it('keeps context only on the side next to a change at the start or end', () => {
    const d = diffLines(nLines(20).join('\n'), ['new', ...nLines(20)].join('\n'));
    const items = collapse(d);
    const gap = items.find((i) => i.type === 'gap');
    expect(gap?.type === 'gap' && gap.hidden).toHaveLength(17);
    expect(items.at(-1)!.type).toBe('gap');
  });

  it('expanding a gap shows its lines', () => {
    const d = diffLines(nLines(30).join('\n'), ['n', ...nLines(30)].join('\n'));
    expect(collapse(d, new Set([0])).every((i) => i.type === 'line')).toBe(true);
  });
});

describe('diffFields', () => {
  const base = { title: 'Old Harbour', type: 'location', details: { kind: 'site' }, properties: { mood: 'tense' } };

  it('lists nothing for identical versions', () => {
    expect(diffFields(base, structuredClone(base))).toEqual([]);
  });

  it('lists title, type, details and properties with labels', () => {
    const next = { title: 'New Harbour', type: 'npc', details: { kind: 'room', extra: 1 }, properties: { mood: null } };
    const out = diffFields(base, next, { type: (t) => t.toUpperCase(), details: (k) => (k === 'kind' ? 'Kind' : undefined), property: () => 'Mood' });
    expect(out.map((c) => [c.group, c.label, c.from, c.to])).toEqual([
      ['Title', 'Title', '"Old Harbour"', '"New Harbour"'],
      ['Type', 'Type', 'LOCATION', 'NPC'],
      ['Details', 'extra', 'empty', '1'],
      ['Details', 'Kind', '"site"', '"room"'],
      ['Properties', 'Mood', '"tense"', 'empty'],
    ]);
  });

  it('cuts long values at 80 characters', () => {
    expect(showValue('x'.repeat(200))).toHaveLength(81);
  });
});

describe('diffDegrades', () => {
  it('is true only when the changed middle is above the size guard', () => {
    const n = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 5;
    expect(diffDegrades(nLines(n, 'x').join('\n'), nLines(n, 'y').join('\n'))).toBe(true);
    expect(diffDegrades('a\nb', 'a\nc')).toBe(false);
    expect(diffDegrades(nLines(n, 'x').join('\n'), nLines(n, 'x').join('\n'))).toBe(false);
  });
});
