import { and, asc, eq, inArray } from 'drizzle-orm';
import { generateKeyBetween } from 'fractional-indexing';
import { normalizePropertyValue, type CreatePropertyInput, type PageType, type PropertyDefDto, type PropertyType, type UpdatePropertyInput } from '@cn/shared';
import type { AppDb } from '../db';
import { pagePropertyValues, propertyDefs } from '../db/schema';
import { badRequest, notFound } from '../lib/http';
import { newId } from '../lib/ids';

type DefRow = typeof propertyDefs.$inferSelect;

function toDto(d: DefRow): PropertyDefDto {
  return {
    id: d.id,
    key: d.key,
    label: d.label,
    type: d.type as PropertyType,
    options: (d.options as string[] | null) ?? null,
    appliesTo: (d.appliesTo as PageType[] | null) ?? null,
    dmOnly: d.dmOnly,
    refKind: d.refKind,
  };
}

function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'property'
  );
}

/** Campaign-wide custom properties (Notion-style typed fields) and their per-page values. */
export class PropertyService {
  constructor(private readonly db: AppDb) {}

  list(campaignId: string): PropertyDefDto[] {
    return this.db.select().from(propertyDefs).where(eq(propertyDefs.campaignId, campaignId)).orderBy(asc(propertyDefs.sortKey)).all().map(toDto);
  }

  private def(campaignId: string, id: string): DefRow {
    const d = this.db.select().from(propertyDefs).where(and(eq(propertyDefs.id, id), eq(propertyDefs.campaignId, campaignId))).get();
    if (!d) throw notFound('Property not found');
    return d;
  }

  create(campaignId: string, input: CreatePropertyInput & { type: PropertyType }): PropertyDefDto {
    const existing = this.list(campaignId);
    let key = slugify(input.label);
    for (let i = 2; existing.some((e) => e.key === key); i++) key = `${slugify(input.label)}_${i}`;
    if ((input.type === 'select' || input.type === 'multiselect') && !input.options?.length) throw badRequest('Select properties need options');
    const last = this.db.select({ k: propertyDefs.sortKey }).from(propertyDefs).where(eq(propertyDefs.campaignId, campaignId)).orderBy(asc(propertyDefs.sortKey)).all().at(-1);
    const id = newId();
    this.db
      .insert(propertyDefs)
      .values({
        id,
        campaignId,
        key,
        label: input.label,
        type: input.type,
        options: input.options ?? null,
        appliesTo: input.appliesTo ?? null,
        dmOnly: input.dmOnly ?? false,
        refKind: input.refKind ?? null,
        sortKey: generateKeyBetween(last?.k ?? null, null),
      })
      .run();
    return toDto(this.def(campaignId, id));
  }

  update(campaignId: string, id: string, input: UpdatePropertyInput): PropertyDefDto {
    this.def(campaignId, id);
    const patch: Partial<typeof propertyDefs.$inferInsert> = {};
    if (input.label !== undefined) patch.label = input.label;
    if (input.options !== undefined) patch.options = input.options;
    if (input.appliesTo !== undefined) patch.appliesTo = input.appliesTo;
    if (input.dmOnly !== undefined) patch.dmOnly = input.dmOnly;
    if (Object.keys(patch).length) this.db.update(propertyDefs).set(patch).where(eq(propertyDefs.id, id)).run();
    return toDto(this.def(campaignId, id));
  }

  remove(campaignId: string, id: string) {
    this.def(campaignId, id);
    this.db.delete(propertyDefs).where(eq(propertyDefs.id, id)).run();
  }

  /** Values for pages, keyed by page id then property key. */
  valuesFor(campaignId: string, pageIds: string[]): Map<string, Record<string, unknown>> {
    const out = new Map<string, Record<string, unknown>>();
    if (!pageIds.length) return out;
    const keys = new Map(this.list(campaignId).map((d) => [d.id, d.key]));
    const rows = this.db.select().from(pagePropertyValues).where(inArray(pagePropertyValues.pageId, pageIds)).all();
    for (const r of rows) {
      const key = keys.get(r.defId);
      if (!key) continue;
      const map = out.get(r.pageId) ?? {};
      map[key] = r.value;
      out.set(r.pageId, map);
    }
    return out;
  }

  /** Validates and stores values by key (null clears). Returns page ids referenced by pageLink values. */
  setValues(campaignId: string, pageId: string, values: Record<string, unknown>, assertPage: (id: string) => void) {
    const defs = new Map(this.list(campaignId).map((d) => [d.key, d]));
    const issues: string[] = [];
    const writes: { defId: string; value: unknown }[] = [];
    for (const [key, raw] of Object.entries(values)) {
      const def = defs.get(key);
      if (!def) {
        issues.push(`Unknown property "${key}"`);
        continue;
      }
      try {
        const value = normalizePropertyValue(def, raw);
        if (def.type === 'pageLink' && typeof value === 'string') assertPage(value);
        writes.push({ defId: def.id, value });
      } catch (err) {
        issues.push(`${def.label}: ${(err as Error).message.split('\n')[0]}`);
      }
    }
    if (issues.length) throw badRequest('Invalid property values', issues);
    this.db.transaction((tx) => {
      for (const w of writes) {
        if (w.value === null) tx.delete(pagePropertyValues).where(and(eq(pagePropertyValues.pageId, pageId), eq(pagePropertyValues.defId, w.defId))).run();
        else
          tx.insert(pagePropertyValues)
            .values({ pageId, defId: w.defId, value: w.value })
            .onConflictDoUpdate({ target: [pagePropertyValues.pageId, pagePropertyValues.defId], set: { value: w.value } })
            .run();
      }
    });
  }

  /** Page ids referenced by pageLink property values of a page. */
  linkedPages(campaignId: string, pageId: string): string[] {
    const linkDefs = this.list(campaignId).filter((d) => d.type === 'pageLink');
    const values = this.valuesFor(campaignId, [pageId]).get(pageId) ?? {};
    return linkDefs.map((d) => values[d.key]).filter((v): v is string => typeof v === 'string');
  }
}
