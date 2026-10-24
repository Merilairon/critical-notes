/**
 * Query block DSL: a live list of pages filtered by type, tags, parent and properties.
 * Evaluated server-side per viewer (so players never see pages they cannot access).
 */
import * as z from 'zod';

export const CURRENT_PAGE = { $ctx: 'currentPage' } as const;

const ctxValue = z.object({ $ctx: z.literal('currentPage') });
const scalar = z.union([z.string().max(300), z.number(), z.boolean(), z.null()]);

export const queryConditionSchema = z.object({
  /** `title`, `type`, `tags`, `updatedAt`, `createdAt`, `facet.<key>`, `prop.<key>` */
  field: z.string().max(80),
  op: z.enum(['eq', 'neq', 'contains', 'in', 'gt', 'lt', 'empty', 'notEmpty']),
  value: z.union([scalar, z.array(scalar).max(50), ctxValue]).optional(),
});
export type QueryCondition = z.infer<typeof queryConditionSchema>;

export const queryFilterSchema = z.object({
  types: z.array(z.string().max(20)).max(10).default([]),
  /** Pages must carry all of these tags. */
  tags: z.array(z.string().max(48)).max(10).default([]),
  /** Direct children of this page (or of the page containing the block). */
  parent: z.union([z.string().max(64), ctxValue, z.null()]).default(null),
  where: z.array(queryConditionSchema).max(20).default([]),
  sort: z.object({ field: z.string().max(80), dir: z.enum(['asc', 'desc']) }).default({ field: 'title', dir: 'asc' }),
  limit: z.number().int().min(1).max(500).default(100),
});
export type QueryFilter = z.infer<typeof queryFilterSchema>;
export type QueryFilterInput = z.input<typeof queryFilterSchema>;

export interface QueryablePage {
  id: string;
  parentId: string | null;
  type: string;
  title: string;
  tags: string[];
  facet: Record<string, unknown> | null;
  props: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export function fieldValue(page: QueryablePage, field: string): unknown {
  if (field.startsWith('facet.')) return page.facet?.[field.slice(6)] ?? null;
  if (field.startsWith('prop.')) return page.props[field.slice(5)] ?? null;
  switch (field) {
    case 'title':
      return page.title;
    case 'type':
      return page.type;
    case 'tags':
      return page.tags;
    case 'updatedAt':
      return page.updatedAt;
    case 'createdAt':
      return page.createdAt;
    case 'parentId':
      return page.parentId;
    default:
      return null;
  }
}

const isEmpty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
const norm = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);

function matches(cond: QueryCondition, page: QueryablePage, ctxPageId: string | null): boolean {
  const actual = fieldValue(page, cond.field);
  const expected = cond.value && typeof cond.value === 'object' && !Array.isArray(cond.value) && '$ctx' in cond.value ? ctxPageId : cond.value;
  switch (cond.op) {
    case 'empty':
      return isEmpty(actual);
    case 'notEmpty':
      return !isEmpty(actual);
    case 'eq':
      return Array.isArray(actual) ? actual.map(norm).includes(norm(expected)) : norm(actual) === norm(expected);
    case 'neq':
      return Array.isArray(actual) ? !actual.map(norm).includes(norm(expected)) : norm(actual) !== norm(expected);
    case 'contains':
      if (Array.isArray(actual)) return actual.some((a) => String(a).toLowerCase().includes(String(expected ?? '').toLowerCase()));
      return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'in': {
      const list = (Array.isArray(expected) ? expected : [expected]).map(norm);
      return Array.isArray(actual) ? actual.some((a) => list.includes(norm(a))) : list.includes(norm(actual));
    }
    case 'gt':
      return actual != null && expected != null && (actual as number) > (expected as number);
    case 'lt':
      return actual != null && expected != null && (actual as number) < (expected as number);
    default:
      return false;
  }
}

const isEmptyValue = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

/** Compares two non-empty values. */
function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Applies a (parsed) query filter to pages. `ctxPageId` is the page containing the query block. */
export function runQuery(pages: QueryablePage[], filter: QueryFilter, ctxPageId: string | null): QueryablePage[] {
  const parent = filter.parent && typeof filter.parent === 'object' ? ctxPageId : filter.parent;
  const tags = filter.tags.map((t) => t.toLowerCase());
  const out = pages.filter((p) => {
    if (filter.types.length && !filter.types.includes(p.type)) return false;
    if (tags.length && !tags.every((t) => p.tags.map((x) => x.toLowerCase()).includes(t))) return false;
    if (parent !== null && parent !== undefined && p.parentId !== parent) return false;
    if (p.id === ctxPageId) return false;
    return filter.where.every((c) => matches(c, p, ctxPageId));
  });
  const dir = filter.sort.dir === 'desc' ? -1 : 1;
  // Empty values go last in both directions (the browser's header sort does the same)
  out.sort((a, b) => {
    const x = fieldValue(a, filter.sort.field);
    const y = fieldValue(b, filter.sort.field);
    const xe = isEmptyValue(x);
    const ye = isEmptyValue(y);
    const order = xe || ye ? (xe === ye ? 0 : xe ? 1 : -1) : compare(x, y) * dir;
    return order || a.title.localeCompare(b.title);
  });
  return out.slice(0, filter.limit);
}
