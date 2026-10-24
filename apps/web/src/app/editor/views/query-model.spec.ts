import type { PropertyDefDto, QueryRowDto } from '@cn/shared';
import { cellFor, columnCatalog, defaultColumns, effectiveColumns, normalizeColumns, normalizeView, resolveColumn, sortRows, sortValue, staleReason, type ColumnContext } from './query-model';

const prop = (key: string, extra: Partial<PropertyDefDto> = {}): PropertyDefDto => ({ id: key, key, label: key[0]!.toUpperCase() + key.slice(1), type: 'text', options: null, appliesTo: null, dmOnly: false, refKind: null, ...extra });
const cx = (extra: Partial<ColumnContext> = {}): ColumnContext => ({ types: [], props: [], isGm: true, ...extra });
const row = (extra: Partial<QueryRowDto> = {}): QueryRowDto => ({
  id: 'r1',
  parentId: null,
  sortKey: 'a',
  type: 'npc',
  title: 'Sildar',
  icon: null,
  visibility: 'all',
  updatedAt: Date.UTC(2026, 9, 12, 12),
  createdAt: Date.UTC(2026, 0, 3, 12),
  tags: [],
  facet: null,
  props: {},
  ...extra,
});
const noPage = () => null;

describe('query model: attributes', () => {
  it('reads a missing or unknown view as the list and a bad column list as empty', () => {
    expect(normalizeView(undefined)).toBe('list');
    expect(normalizeView(null)).toBe('list');
    expect(normalizeView('grid')).toBe('list');
    expect(normalizeView('table')).toBe('table');
    expect(normalizeView('cards')).toBe('cards');
    expect(normalizeColumns(undefined)).toEqual([]);
    expect(normalizeColumns('tags')).toEqual([]);
    expect(normalizeColumns(['tags', 'title', 'tags', 5, '', 'type'])).toEqual(['tags', 'type']);
  });
});

describe('query model: columns', () => {
  it('resolves page, details and property keys, and nothing else', () => {
    const c = cx({ props: [prop('mood')] });
    expect(resolveColumn('updatedAt', c)!.kind).toBe('datetime');
    expect(resolveColumn('facet.status', c)!.label).toBe('Status');
    expect(resolveColumn('prop.mood', c)!.label).toBe('Mood');
    expect(resolveColumn('prop.gone', c)).toBeNull();
    expect(resolveColumn('bogus', c)).toBeNull();
    expect(resolveColumn('title', c)).toBeNull();
  });

  it('does not resolve a facet field that the chosen types do not have', () => {
    expect(resolveColumn('facet.priority', cx({ types: ['npc'] }))).toBeNull();
    expect(resolveColumn('facet.priority', cx({ types: ['quest'] }))).not.toBeNull();
    expect(staleReason('facet.priority', cx({ types: ['npc'] }))).toBe('Not available for these pages (facet.priority)');
    expect(staleReason('prop.gone', cx())).toBe('Removed property (prop.gone)');
    expect(staleReason('type', cx())).toBeNull();
  });

  it('hides DM-only fields and properties from players', () => {
    const props = [prop('secret', { dmOnly: true }), prop('mood')];
    expect(resolveColumn('facet.statblockUid', cx({ isGm: true }))!.dmOnly).toBe(true);
    expect(resolveColumn('facet.statblockUid', cx({ isGm: false }))).toBeNull();
    expect(resolveColumn('prop.secret', cx({ props, isGm: true }))!.dmOnly).toBe(true);
    expect(resolveColumn('prop.secret', cx({ props, isGm: false }))).toBeNull();
    const player = columnCatalog(cx({ props, isGm: false }));
    expect(player.properties.map((c) => c.key)).toEqual(['prop.mood']);
    const dm = columnCatalog(cx({ props, isGm: true }));
    expect(dm.properties.map((c) => c.key)).toEqual(['prop.secret', 'prop.mood']);
  });

  it('offers the union of details by key for several types, one type’s fields for one, and no reference links', () => {
    const all = columnCatalog(cx()).details.map((c) => c.key);
    expect(all.filter((k) => k === 'facet.status')).toHaveLength(1);
    expect(all).toContain('facet.priority');
    expect(all).not.toContain('facet.speciesUid');
    expect(all).not.toContain('facet.statblockUid');
    expect(columnCatalog(cx({ types: ['quest'] })).details.map((c) => c.key)).toEqual(['facet.status', 'facet.priority', 'facet.giverPageId']);
  });

  it('offers only properties that apply to the chosen types', () => {
    const props = [prop('a', { appliesTo: ['npc'] }), prop('b', { appliesTo: ['quest'] }), prop('c')];
    expect(columnCatalog(cx({ props, types: ['npc'] })).properties.map((c) => c.key)).toEqual(['prop.a', 'prop.c']);
    expect(columnCatalog(cx({ props })).properties.map((c) => c.key)).toEqual(['prop.a', 'prop.b', 'prop.c']);
  });

  it('marks only scalar columns as usable for the saved default sort', () => {
    const c = cx({ props: [prop('t'), prop('m', { type: 'multiselect', options: ['x'] }), prop('p', { type: 'pageLink' })] });
    expect(['type', 'updatedAt', 'facet.status', 'facet.number', 'prop.t'].every((k) => resolveColumn(k, c)!.scalar)).toBe(true);
    expect(['tags', 'prop.m', 'prop.p', 'facet.factionPageId'].some((k) => resolveColumn(k, c)!.scalar)).toBe(false);
  });
});

describe('query model: default columns', () => {
  it('is nothing for the list', () => {
    expect(defaultColumns(['npc'], 'list', cx())).toEqual([]);
  });
  it('is type and updated for no type or several types', () => {
    expect(defaultColumns([], 'table', cx())).toEqual(['type', 'updatedAt']);
    expect(defaultColumns(['npc', 'quest'], 'table', cx())).toEqual(['type', 'updatedAt']);
  });
  it('is the type’s first three plain fields, then updated, for one type (type is redundant)', () => {
    expect(defaultColumns(['npc'], 'table', cx())).toEqual(['facet.role', 'facet.status', 'facet.attitude', 'updatedAt']);
    expect(defaultColumns(['session'], 'table', cx())).toEqual(['facet.number', 'facet.date', 'facet.status', 'updatedAt']);
    expect(defaultColumns(['location'], 'table', cx())).toEqual(['facet.kind', 'facet.parentLocationPageId', 'updatedAt']);
    expect(defaultColumns(['pc'], 'table', cx())).toEqual(['facet.playerName', 'facet.hpMax', 'facet.ac', 'updatedAt']);
    expect(defaultColumns(['item'], 'table', cx())).toEqual(['updatedAt']);
    expect(defaultColumns(['generic'], 'table', cx())).toEqual(['updatedAt']);
  });
  it('caps cards at three', () => {
    expect(defaultColumns(['npc'], 'cards', cx())).toEqual(['facet.role', 'facet.status', 'facet.attitude']);
  });
  it('shows chosen columns that still resolve, even if none do, and the defaults only when none are chosen', () => {
    expect(effectiveColumns(['prop.gone'], [], 'table', cx())).toEqual([]);
    expect(effectiveColumns([], ['quest'], 'table', cx()).map((c) => c.key)).toEqual(['facet.status', 'facet.priority', 'facet.giverPageId', 'updatedAt']);
    expect(effectiveColumns(['tags', 'prop.gone', 'type'], [], 'cards', cx()).map((c) => c.key)).toEqual(['tags', 'type']);
  });
});

describe('query model: cells', () => {
  const now = new Date(2026, 9, 23);
  const col = (key: string, c = cx()) => resolveColumn(key, c)!;

  it('renders select options by label, checkboxes as Yes/No, numbers as text', () => {
    const r = row({ facet: { status: 'missing', hpMax: 12, inspiration: false } });
    expect(cellFor(r, col('facet.status'), noPage)).toEqual({ kind: 'badge', text: 'Missing' });
    expect(cellFor(r, col('facet.hpMax'), noPage)).toEqual({ kind: 'number', text: '12' });
    expect(cellFor(r, col('facet.inspiration'), noPage)).toEqual({ kind: 'bool', yes: false });
  });

  it('gives an empty cell for no value, a hidden page and a reference link, never an id', () => {
    const r = row({ facet: { factionPageId: 'secret-id', speciesUid: 'race:elf|phb' } });
    expect(cellFor(r, col('facet.factionPageId'), noPage)).toEqual({ kind: 'empty' });
    expect(cellFor(r, col('facet.factionPageId'), (id) => (id === 'secret-id' ? 'Lords' : null))).toEqual({ kind: 'page', id: 'secret-id', title: 'Lords' });
    expect(cellFor(r, col('facet.speciesUid'), () => 'Elf')).toEqual({ kind: 'empty' });
    expect(cellFor(row(), col('facet.role'), noPage)).toEqual({ kind: 'empty' });
  });

  it('shows the year only when it is not the current one', () => {
    const a = cellFor(row({ updatedAt: new Date(2026, 9, 12, 12).getTime() }), col('updatedAt'), noPage, now);
    const b = cellFor(row({ updatedAt: new Date(2025, 9, 12, 12).getTime() }), col('updatedAt'), noPage, now);
    expect(a).toMatchObject({ kind: 'date', text: expect.not.stringContaining('2026') });
    expect(b).toMatchObject({ kind: 'date', text: expect.stringContaining('2025') });
    expect(cellFor(row({ facet: { date: '2026-03-04' } }), col('facet.date'), noPage, now)).toMatchObject({ kind: 'date', iso: '2026-03-04' });
  });

  it('turns tags and multiselects into chips, urls into host links, and refuses unsafe urls', () => {
    const c = cx({ props: [prop('tagsx', { type: 'multiselect', options: ['a', 'b'] }), prop('site', { type: 'url' })] });
    expect(cellFor(row({ tags: ['x', 'y'] }), col('tags'), noPage)).toEqual({ kind: 'chips', items: ['x', 'y'] });
    expect(cellFor(row({ tags: [] }), col('tags'), noPage)).toEqual({ kind: 'empty' });
    expect(cellFor(row({ props: { tagsx: ['a', 'b'] } }), col('prop.tagsx', c), noPage)).toEqual({ kind: 'chips', items: ['a', 'b'] });
    expect(cellFor(row({ props: { site: 'https://example.com/path' } }), col('prop.site', c), noPage)).toEqual({ kind: 'url', href: 'https://example.com/path', host: 'example.com' });
    expect(cellFor(row({ props: { site: 'javascript:alert(1)' } }), col('prop.site', c), noPage)).toEqual({ kind: 'empty' });
  });

  it('shows the type with its icon and label', () => {
    expect(cellFor(row({ type: 'npc' }), col('type'), noPage)).toMatchObject({ kind: 'type', label: 'NPC' });
  });
});

describe('query model: viewer sort', () => {
  const rows = [
    row({ id: 'a', title: 'Alpha', facet: { hpMax: 10, status: 'dead' }, type: 'pc' }),
    row({ id: 'b', title: 'Bravo', facet: { hpMax: null, status: 'alive' }, type: 'npc' }),
    row({ id: 'c', title: 'Charlie', facet: { hpMax: 2, status: 'missing' }, type: 'location' }),
    row({ id: 'd', title: 'Delta', facet: { hpMax: 10, status: 'alive' }, type: 'npc' }),
  ];
  const ids = (list: QueryRowDto[]) => list.map((r) => r.id).join('');
  const by = (key: string) => (r: QueryRowDto) => sortValue(r, key === 'title' ? 'title' : resolveColumn(key, cx())!, noPage);

  it('sorts numbers numerically with empty values last in both directions, and keeps ties stable', () => {
    expect(ids(sortRows(rows, by('facet.hpMax'), 'asc'))).toBe('cadb');
    expect(ids(sortRows(rows, by('facet.hpMax'), 'desc'))).toBe('adcb');
  });
  it('sorts by the raw value for select columns, as the server does', () => {
    expect(ids(sortRows(rows, by('facet.status'), 'asc'))).toBe('bdac');
  });
  it('sorts the title and the type', () => {
    expect(ids(sortRows(rows, by('title'), 'desc'))).toBe('dcba');
    expect(ids(sortRows(rows, by('type'), 'asc'))).toBe('cbda');
  });
  it('sorts page links by the shown title and leaves unseen pages last', () => {
    const links = [row({ id: 'x', facet: { factionPageId: 'p1' } }), row({ id: 'y', facet: { factionPageId: 'p2' } }), row({ id: 'z', facet: { factionPageId: 'gone' } })];
    const titles: Record<string, string> = { p1: 'Zebras', p2: 'Ants' };
    const key = (r: QueryRowDto) => sortValue(r, resolveColumn('facet.factionPageId', cx())!, (id) => titles[id] ?? null);
    expect(ids(sortRows(links, key, 'asc'))).toBe('yxz');
    expect(ids(sortRows(links, key, 'desc'))).toBe('xyz');
  });
  it('does not change the input array', () => {
    const copy = [...rows];
    sortRows(rows, by('title'), 'desc');
    expect(rows).toEqual(copy);
  });
});
