import { describe, expect, it } from 'vitest';
import { fieldValue, queryFilterSchema, runQuery, type QueryablePage } from '../src/index';

const page = (id: string, title: string, extra: Partial<QueryablePage> = {}): QueryablePage => ({
  id,
  parentId: null,
  type: 'npc',
  title,
  tags: [],
  facet: null,
  props: {},
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

const order = (pages: QueryablePage[], sort: { field: string; dir: 'asc' | 'desc' }) =>
  runQuery(pages, queryFilterSchema.parse({ sort, limit: 500 }), null).map((p) => p.title);

/** The pre-I2.5 algorithm (a collator per comparison, fieldValue twice per comparison), tie-break on the same collator. */
function reference(pages: QueryablePage[], field: string, dir: 'asc' | 'desc'): string[] {
  const d = dir === 'desc' ? -1 : 1;
  const empty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
  const cmp = (a: unknown, b: unknown) =>
    typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  return [...pages]
    .sort((a, b) => {
      const x = fieldValue(a, field);
      const y = fieldValue(b, field);
      const xe = empty(x);
      const ye = empty(y);
      const o = xe || ye ? (xe === ye ? 0 : xe ? 1 : -1) : cmp(x, y) * d;
      return o || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
    })
    .map((p) => p.title);
}

describe('runQuery sort ordering', () => {
  it('ignores accents and case, and orders numbers inside strings numerically', () => {
    const pages = [page('1', 'Zed'), page('2', 'Élan'), page('3', 'eagle'), page('4', 'Room 10'), page('5', 'Room 9'), page('6', 'Adel')];
    expect(order(pages, { field: 'title', dir: 'asc' })).toEqual(['Adel', 'eagle', 'Élan', 'Room 9', 'Room 10', 'Zed']);
    expect(order(pages, { field: 'title', dir: 'desc' })).toEqual(['Zed', 'Room 10', 'Room 9', 'Élan', 'eagle', 'Adel']);
  });

  it('puts empty values last in both directions', () => {
    const pages = [
      page('1', 'a', { props: { cr: 3 } }),
      page('2', 'b'),
      page('3', 'c', { props: { cr: 1 } }),
      page('4', 'd', { props: { cr: '' } }),
      page('5', 'e', { props: { cr: 2 } }),
    ];
    expect(order(pages, { field: 'prop.cr', dir: 'asc' })).toEqual(['c', 'e', 'a', 'b', 'd']);
    expect(order(pages, { field: 'prop.cr', dir: 'desc' })).toEqual(['a', 'e', 'c', 'b', 'd']);
  });

  it('sorts on tags by the comma-joined list, untagged pages last', () => {
    const pages = [
      page('1', 'p1', { tags: ['beta', 'alpha'] }),
      page('2', 'p2', { tags: ['Álpha'] }),
      page('3', 'p3'),
      page('4', 'p4', { tags: ['gamma'] }),
      page('5', 'p5', { tags: ['alpha', 'zeta'] }),
    ];
    expect(order(pages, { field: 'tags', dir: 'asc' })).toEqual(['p2', 'p5', 'p1', 'p4', 'p3']);
    expect(order(pages, { field: 'tags', dir: 'desc' })).toEqual(['p4', 'p1', 'p5', 'p2', 'p3']);
  });

  it('breaks ties on the title', () => {
    const pages = [page('1', 'b', { type: 'x' }), page('2', 'a', { type: 'x' }), page('3', 'c', { type: 'x' })];
    expect(order(pages, { field: 'type', dir: 'desc' })).toEqual(['a', 'b', 'c']);
  });

  it('matches the reference algorithm on mixed random data', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const words = ['alpha', 'Álpha', 'beta', 'Gamma', 'delta', 'room 2', 'room 10', 'ünder', 'under', ''];
    const pages = Array.from({ length: 300 }, (_, i) =>
      page(String(i), `${words[Math.floor(rnd() * words.length)]} ${i}`, {
        type: ['npc', 'quest', 'item'][Math.floor(rnd() * 3)]!,
        tags: Array.from({ length: Math.floor(rnd() * 4) }, () => words[Math.floor(rnd() * words.length)]!),
        props: { cr: rnd() < 0.2 ? null : rnd() < 0.5 ? Math.floor(rnd() * 20) : `${words[Math.floor(rnd() * words.length)]}`, flag: rnd() < 0.5 },
        updatedAt: Math.floor(rnd() * 50),
      }),
    );
    for (const field of ['title', 'type', 'tags', 'updatedAt', 'prop.cr', 'prop.flag']) {
      for (const dir of ['asc', 'desc'] as const) {
        expect(order(pages, { field, dir }), `${field} ${dir}`).toEqual(reference(pages, field, dir));
      }
    }
  });
});
