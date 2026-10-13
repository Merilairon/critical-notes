/**
 * Client-side filtering for reference lists. Pure functions, so they can be unit-tested without Angular.
 * Filter values come from the URL (`?level=1,2&class=wizard`), including `{@filter}` links from 5etools data.
 */
import type { ListItemDto } from '@cn/shared';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterDef {
  key: string;
  label: string;
  /** Extracts the item's values for this filter (lower-cased). */
  values: (item: ListItemDto) => string[];
  /** Orders options; defaults to label order. */
  sort?: (a: FilterOption, b: FilterOption) => number;
  /** Formats an option value for display. */
  format?: (value: string) => string;
}

const s = (v: unknown) => (v == null ? '' : String(v));
const lower = (v: unknown) => s(v).toLowerCase();
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(lower) : v == null || v === '' ? [] : [lower(v)]);

const crSortValue = (cr: string) => {
  if (cr.includes('/')) {
    const [a, b] = cr.split('/').map(Number);
    return (a ?? 0) / (b || 1);
  }
  const n = Number(cr);
  return Number.isFinite(n) ? n : 999;
};

const SPELL_LEVEL_LABEL = (v: string) => (v === '0' ? 'Cantrip' : `Level ${v}`);
const RARITY_ORDER = ['none', 'common', 'uncommon', 'rare', 'very rare', 'legendary', 'artifact', 'varies', 'unknown', 'unknown (magic)'];

export const SOURCE_FILTER: FilterDef = { key: 'source', label: 'Source', values: (i) => [lower(i.source)], format: (v) => v.toUpperCase() };

export const KIND_FILTERS: Record<string, FilterDef[]> = {
  monster: [
    { key: 'cr', label: 'CR', values: (i) => arr(i.summary['cr']), sort: (a, b) => crSortValue(a.value) - crSortValue(b.value) },
    { key: 'type', label: 'Type', values: (i) => arr(i.summary['type']) },
    { key: 'size', label: 'Size', values: (i) => arr(i.summary['size']) },
    { key: 'environment', label: 'Environment', values: (i) => arr(i.summary['environment']) },
  ],
  spell: [
    { key: 'level', label: 'Level', values: (i) => arr(i.summary['level']), sort: (a, b) => Number(a.value) - Number(b.value), format: SPELL_LEVEL_LABEL },
    { key: 'school', label: 'School', values: (i) => arr(i.summary['school']) },
    { key: 'class', label: 'Class', values: (i) => arr(i.summary['classes']) },
    { key: 'concentration', label: 'Concentration', values: (i) => [i.summary['concentration'] ? 'yes' : 'no'] },
    { key: 'ritual', label: 'Ritual', values: (i) => [i.summary['ritual'] ? 'yes' : 'no'] },
  ],
  item: [
    {
      key: 'rarity',
      label: 'Rarity',
      values: (i) => arr(i.summary['rarity'] ?? 'none'),
      sort: (a, b) => RARITY_ORDER.indexOf(a.value) - RARITY_ORDER.indexOf(b.value),
    },
    { key: 'category', label: 'Category', values: (i) => arr(i.summary['category']) },
    { key: 'attunement', label: 'Attunement', values: (i) => [i.summary['attunement'] ? 'yes' : 'no'] },
  ],
  race: [{ key: 'size', label: 'Size', values: (i) => arr(i.summary['size']) }],
  feat: [{ key: 'category', label: 'Category', values: (i) => arr(i.summary['category']) }],
  optionalfeature: [{ key: 'type', label: 'Type', values: (i) => arr(i.summary['featureType']) }],
  deity: [{ key: 'pantheon', label: 'Pantheon', values: (i) => arr(i.summary['pantheon']) }],
};

export function filtersFor(kind: string): FilterDef[] {
  return [...(KIND_FILTERS[kind] ?? []), SOURCE_FILTER];
}

/** Parses `?key=a,b` / `a;b` values (as produced by `{@filter}` tags) into lower-cased sets. */
export function parseFilterParams(params: Record<string, string | undefined>, defs: FilterDef[]): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  for (const def of defs) {
    const raw = params[def.key];
    if (!raw) continue;
    const values = raw
      .split(/[,;]/)
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
    if (values.length) out[def.key] = new Set(values);
  }
  return out;
}

export function normalizeSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

export function applyFilters(items: ListItemDto[], defs: FilterDef[], active: Record<string, Set<string>>, query: string): ListItemDto[] {
  const q = normalizeSearch(query);
  const activeDefs = defs.filter((d) => active[d.key]?.size);
  return items.filter((item) => {
    if (q && !normalizeSearch(item.name).includes(q)) return false;
    for (const def of activeDefs) {
      const wanted = active[def.key]!;
      if (!def.values(item).some((v) => wanted.has(v))) return false;
    }
    return true;
  });
}

export function filterOptions(items: ListItemDto[], def: FilterDef): FilterOption[] {
  const seen = new Map<string, number>();
  for (const item of items) for (const v of def.values(item)) if (v) seen.set(v, (seen.get(v) ?? 0) + 1);
  const options = [...seen.keys()].map((value) => ({ value, label: def.format ? def.format(value) : value.replace(/\b\w/g, (c) => c.toUpperCase()) }));
  return options.sort(def.sort ?? ((a, b) => a.label.localeCompare(b.label)));
}

export type SortKey = 'name' | 'source' | 'cr' | 'level' | 'rarity';

export function sortItems(items: ListItemDto[], key: SortKey, dir: 1 | -1): ListItemDto[] {
  const value = (i: ListItemDto): string | number => {
    switch (key) {
      case 'cr':
        return crSortValue(s(i.summary['cr']));
      case 'level':
        return Number(i.summary['level'] ?? 99);
      case 'rarity':
        return RARITY_ORDER.indexOf(lower(i.summary['rarity'] ?? 'none'));
      case 'source':
        return i.source.toLowerCase();
      default:
        return i.name.toLowerCase();
    }
  };
  return [...items].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
    return (cmp || a.name.localeCompare(b.name)) * dir;
  });
}
