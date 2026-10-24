/**
 * Pure logic of the query block's table and card views (docs/design/query-views.md): which columns exist, how a
 * column key resolves, the default columns, how a value becomes a cell, and how rows sort in the browser.
 * Nothing here touches Angular, so it is unit tested directly.
 */
import {
  facetTypeFor,
  FACET_DM_ONLY_FIELDS,
  FACET_FIELDS,
  FACET_TYPES,
  PAGE_TYPE_ICONS,
  PAGE_TYPE_LABELS,
  type FacetFieldDef,
  type FacetType,
  type PageType,
  type PropertyDefDto,
  type QueryRowDto,
} from '@cn/shared';

export type QueryViewMode = 'list' | 'table' | 'cards';
export type ValueKind = FacetFieldDef['type'] | 'multiselect' | 'url';
export type ColumnKind = ValueKind | 'type' | 'tags' | 'datetime';

export const MAX_COLUMNS = 10;

export interface ColumnDef {
  /** `type`, `tags`, `updatedAt`, `createdAt`, `facet.<key>` or `prop.<key>` (the title is implicit). */
  key: string;
  label: string;
  kind: ColumnKind;
  dmOnly: boolean;
  options: { value: string; label: string }[] | null;
  /** May be the persisted default sort: the server sorts these meaningfully. */
  scalar: boolean;
}

/** What column resolution depends on: the query's types, the property definitions the viewer got, and the role. */
export interface ColumnContext {
  types: readonly string[];
  props: readonly PropertyDefDto[];
  isGm: boolean;
}

export const normalizeView = (v: unknown): QueryViewMode => (v === 'table' || v === 'cards' ? v : 'list');

/** The saved list, cleaned: strings only, no title (implicit), no duplicates (first wins). */
export function normalizeColumns(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const k of v) if (typeof k === 'string' && k && k !== 'title' && !out.includes(k)) out.push(k);
  return out;
}

const SCALAR_KINDS: ReadonlySet<ColumnKind> = new Set(['type', 'datetime', 'number', 'date', 'text', 'select', 'checkbox']);
const BUILTIN: Record<string, { label: string; kind: ColumnKind }> = {
  type: { label: 'Type', kind: 'type' },
  tags: { label: 'Tags', kind: 'tags' },
  updatedAt: { label: 'Updated', kind: 'datetime' },
  createdAt: { label: 'Created', kind: 'datetime' },
};

const def = (key: string, label: string, kind: ColumnKind, dmOnly = false, options: ColumnDef['options'] = null): ColumnDef => ({ key, label, kind, dmOnly, options, scalar: SCALAR_KINDS.has(kind) });

/** Facet types a query can return rows of (all of them when no type is chosen). */
function facetTypesFor(types: readonly string[]): FacetType[] {
  if (!types.length) return FACET_TYPES;
  return [...new Set(types.map((t) => facetTypeFor(t as PageType)).filter((t): t is FacetType => !!t))];
}

/** Facet fields offered for these types: the union by key, first label wins. */
function facetColumns(types: readonly string[], includeDmOnly: boolean): ColumnDef[] {
  const out = new Map<string, ColumnDef>();
  for (const ft of facetTypesFor(types)) {
    const dmOnly = new Set(FACET_DM_ONLY_FIELDS[ft]);
    for (const f of FACET_FIELDS[ft]) {
      const hidden = dmOnly.has(f.key);
      if (hidden && !includeDmOnly) continue;
      const key = `facet.${f.key}`;
      const prev = out.get(key);
      if (prev) {
        // The same key on another type (status): keep the first, but know every option
        if (f.options && prev.options) for (const o of f.options) if (!prev.options.some((p) => p.value === o.value)) prev.options.push(o);
        continue;
      }
      out.set(key, def(key, f.label, f.type, hidden, f.options ? [...f.options] : null));
    }
  }
  return [...out.values()];
}

function propColumn(p: PropertyDefDto): ColumnDef {
  return def(`prop.${p.key}`, p.label, p.type, p.dmOnly, p.options ? p.options.map((o) => ({ value: o, label: o })) : null);
}

/** Resolves a key to its definition, or null when it does not (any more) apply for this viewer. */
export function resolveColumn(key: string, cx: ColumnContext): ColumnDef | null {
  const built = BUILTIN[key];
  if (built) return def(key, built.label, built.kind);
  if (key.startsWith('facet.')) return facetColumns(cx.types, cx.isGm).find((c) => c.key === key) ?? null;
  if (key.startsWith('prop.')) {
    const p = cx.props.find((d) => d.key === key.slice(5));
    return p && (cx.isGm || !p.dmOnly) ? propColumn(p) : null;
  }
  return null;
}

/** Why a saved key no longer resolves, for the editor's warning (null when it is fine). */
export function staleReason(key: string, cx: ColumnContext): string | null {
  if (resolveColumn(key, cx)) return null;
  if (key.startsWith('prop.')) return `Removed property (${key})`;
  return `Not available for these pages (${key})`;
}

export interface ColumnCatalog {
  page: ColumnDef[];
  details: ColumnDef[];
  properties: ColumnDef[];
}

/**
 * The columns the picker offers. Reference links stay out until a batch name lookup exists (design Q4); DM-only
 * entries are for the DM only.
 */
export function columnCatalog(cx: ColumnContext): ColumnCatalog {
  const noRef = (c: ColumnDef) => c.kind !== 'refLink';
  const wanted = (p: PropertyDefDto) => (cx.isGm || !p.dmOnly) && (!p.appliesTo || !cx.types.length || p.appliesTo.some((t) => cx.types.includes(t)));
  return {
    page: ['type', 'tags', 'updatedAt', 'createdAt'].map((k) => resolveColumn(k, cx)!),
    details: facetColumns(cx.types, cx.isGm).filter(noRef),
    properties: cx.props.filter(wanted).map(propColumn).filter(noRef),
  };
}

const PC_DEFAULTS = ['playerName', 'hpMax', 'ac'];

/** Default columns when none are chosen (design 5.3). Resolved at render time, never saved. */
export function defaultColumns(types: readonly string[], mode: QueryViewMode, cx: ColumnContext): string[] {
  if (mode === 'list') return [];
  const single = types.length === 1 ? types[0]! : null;
  const ft = single ? facetTypeFor(single as PageType) : null;
  let keys: string[];
  if (single) {
    const hidden = new Set(ft ? FACET_DM_ONLY_FIELDS[ft] : []);
    const plain = ft ? FACET_FIELDS[ft].filter((f) => f.type !== 'longtext' && f.type !== 'refLink' && !hidden.has(f.key)) : [];
    // A character's useful trio is not its first three fields (design 5.3: Player, Max HP, AC)
    const fields = ft === 'pc' ? plain.filter((f) => PC_DEFAULTS.includes(f.key)) : plain.slice(0, 3);
    keys = [...fields.map((f) => `facet.${f.key}`), 'updatedAt'];
  } else {
    keys = ['type', 'updatedAt'];
  }
  keys = keys.filter((k) => resolveColumn(k, cx));
  return mode === 'cards' ? keys.slice(0, 3) : keys;
}

/** The columns shown: the chosen ones that still resolve, or the defaults when none are chosen. */
export function effectiveColumns(chosen: readonly string[], types: readonly string[], mode: QueryViewMode, cx: ColumnContext): ColumnDef[] {
  if (mode === 'list') return [];
  const keys = chosen.length ? chosen : defaultColumns(types, mode, cx);
  return keys.map((k) => resolveColumn(k, cx)).filter((c): c is ColumnDef => !!c);
}

// region Cells

export type Cell =
  | { kind: 'empty' }
  | { kind: 'text'; text: string; long: boolean }
  | { kind: 'number'; text: string }
  | { kind: 'badge'; text: string }
  | { kind: 'chips'; items: string[] }
  | { kind: 'date'; iso: string; text: string }
  | { kind: 'bool'; yes: boolean }
  | { kind: 'page'; id: string; title: string }
  | { kind: 'url'; href: string; host: string }
  | { kind: 'type'; icon: string; label: string };

const EMPTY: Cell = { kind: 'empty' };

/** `Oct 12`, and `Oct 12, 2025` when the year is not the current one. */
export function shortDate(d: Date, now = new Date()): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

export function rawValue(row: QueryRowDto, col: ColumnDef): unknown {
  if (col.key === 'type') return row.type;
  if (col.key === 'tags') return row.tags;
  if (col.key === 'updatedAt') return row.updatedAt;
  if (col.key === 'createdAt') return row.createdAt;
  if (col.key.startsWith('facet.')) return row.facet?.[col.key.slice(6)] ?? null;
  return row.props?.[col.key.slice(5)] ?? null;
}

const optionLabel = (col: ColumnDef, v: string) => col.options?.find((o) => o.value === v)?.label ?? v;

/** A value as a cell. `pageTitle` gives the title of a page the viewer can see (null otherwise: never an id). */
export function cellFor(row: QueryRowDto, col: ColumnDef, pageTitle: (id: string) => string | null, now = new Date()): Cell {
  const v = rawValue(row, col);
  switch (col.kind) {
    case 'type':
      return { kind: 'type', icon: PAGE_TYPE_ICONS[row.type as PageType] ?? '', label: PAGE_TYPE_LABELS[row.type as PageType] ?? row.type };
    case 'tags':
      return Array.isArray(v) && v.length ? { kind: 'chips', items: v.map(String) } : EMPTY;
    case 'datetime': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return EMPTY;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? EMPTY : { kind: 'date', iso: d.toISOString(), text: shortDate(d, now) };
    }
    case 'date': {
      const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
      return m ? { kind: 'date', iso: m[0], text: shortDate(new Date(+m[1]!, +m[2]! - 1, +m[3]!), now) } : EMPTY;
    }
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? { kind: 'number', text: String(v) } : EMPTY;
    case 'checkbox':
      return typeof v === 'boolean' ? { kind: 'bool', yes: v } : EMPTY;
    case 'select':
      return typeof v === 'string' && v ? { kind: 'badge', text: optionLabel(col, v) } : EMPTY;
    case 'multiselect':
      return Array.isArray(v) && v.length ? { kind: 'chips', items: v.map((x) => optionLabel(col, String(x))) } : EMPTY;
    case 'pageLink': {
      const title = typeof v === 'string' && v ? pageTitle(v) : null;
      return title && typeof v === 'string' ? { kind: 'page', id: v, title } : EMPTY;
    }
    case 'url': {
      if (typeof v !== 'string' || !/^(https?:|mailto:)/i.test(v)) return EMPTY;
      try {
        const u = new URL(v);
        return { kind: 'url', href: v, host: u.protocol === 'mailto:' ? v.slice(7) : u.host };
      } catch {
        return EMPTY;
      }
    }
    case 'longtext':
    case 'text':
      return typeof v === 'string' && v ? { kind: 'text', text: v, long: col.kind === 'longtext' } : EMPTY;
    default:
      // refLink: no cheap name for a reference uid on the client yet (design Q4), so the empty cell
      return EMPTY;
  }
}

// endregion

// region Sorting

export type SortDir = 'asc' | 'desc';

const isEmpty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

/** Same comparison as the server's query sort. */
export function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** The key a row sorts by: raw for what the server sorts too, the shown text for what it cannot sort meaningfully. */
export function sortValue(row: QueryRowDto, col: ColumnDef | 'title', pageTitle: (id: string) => string | null): unknown {
  if (col === 'title') return row.title;
  const v = rawValue(row, col);
  if (isEmpty(v)) return null;
  switch (col.kind) {
    case 'tags':
    case 'multiselect':
      return Array.isArray(v) ? v.join(', ') : null;
    case 'pageLink':
      return typeof v === 'string' ? pageTitle(v) : null;
    case 'refLink':
      return null;
    default:
      return v;
  }
}

/** Stable sort; empty values go last in both directions. Returns a new array. */
export function sortRows<T>(items: readonly T[], key: (item: T) => unknown, dir: SortDir): T[] {
  const keyed = items.map((item, i) => ({ item, i, k: key(item) }));
  keyed.sort((a, b) => {
    const ae = isEmpty(a.k);
    const be = isEmpty(b.k);
    if (ae || be) return ae && be ? a.i - b.i : ae ? 1 : -1;
    return compareValues(a.k, b.k) * (dir === 'desc' ? -1 : 1) || a.i - b.i;
  });
  return keyed.map((x) => x.item);
}

// endregion
