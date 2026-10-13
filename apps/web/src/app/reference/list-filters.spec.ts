import type { ListItemDto } from '@cn/shared';
import { applyFilters, filterOptions, filtersFor, parseFilterParams, sortItems } from './list-filters';

const item = (name: string, source: string, summary: Record<string, unknown>): ListItemDto => ({
  uid: `spell:${name.toLowerCase()}|${source.toLowerCase()}`,
  name,
  source,
  page: null,
  edition: 'classic',
  badge: null,
  summary,
  hasImage: false,
  hasToken: false,
  origin: 'official',
  alsoPrintedAs: [],
});

const spells = [
  item('Fireball', 'PHB', { level: 3, school: 'Evocation', classes: ['Wizard', 'Sorcerer'] }),
  item('Light', 'PHB', { level: 0, school: 'Evocation', classes: ['Wizard', 'Cleric'] }),
  item('Bless', 'PHB', { level: 1, school: 'Enchantment', classes: ['Cleric'] }),
  item('Éclair', 'TST', { level: 1, school: 'Evocation', classes: [] }),
];

describe('reference list filters', () => {
  const defs = filtersFor('spell');

  it('parses {@filter}-style params case-insensitively, including ; separators', () => {
    const active = parseFilterParams({ level: '1;3', class: 'Wizard', unknown: 'x' }, defs);
    expect([...active['level']!]).toEqual(['1', '3']);
    expect([...active['class']!]).toEqual(['wizard']);
    expect(active['unknown']).toBeUndefined();
  });

  it('filters by facets (AND across facets, OR within) and diacritic-insensitive name search', () => {
    expect(applyFilters(spells, defs, parseFilterParams({ level: '1,3', class: 'wizard' }, defs), '').map((s) => s.name)).toEqual(['Fireball']);
    expect(applyFilters(spells, defs, {}, 'ecl').map((s) => s.name)).toEqual(['Éclair']);
    expect(applyFilters(spells, defs, parseFilterParams({ source: 'tst' }, defs), '').map((s) => s.name)).toEqual(['Éclair']);
  });

  it('builds sorted options with labels', () => {
    const level = defs.find((d) => d.key === 'level')!;
    expect(filterOptions(spells, level).map((o) => o.label)).toEqual(['Cantrip', 'Level 1', 'Level 3']);
  });

  it('sorts by level then name, both directions', () => {
    expect(sortItems(spells, 'level', 1).map((s) => s.name)).toEqual(['Light', 'Bless', 'Éclair', 'Fireball']);
    expect(sortItems(spells, 'name', -1)[0]!.name).toBe('Light');
  });
});
