/**
 * Derived data maintained on every page save: backlinks (`page_links`), entity usage
 * (`entity_references`), linked template instances (`template_usage`) and the search index (DM and player text).
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { docLinks, docText, walk, type BlockDocument } from '@cn/blocks';
import { FACET_FIELDS, facetTypeFor, type PageType } from '@cn/shared';
import type { AppDb } from '../db';
import { entityReferences, pageLinks, pages, templateUsage } from '../db/schema';
import type { PageSearchIndex } from '../reference/page-search';

export interface IndexablePage {
  id: string;
  campaignId: string;
  type: string;
  title: string;
  icon: string | null;
  visibility: string;
  body: unknown;
  facet: Record<string, unknown> | null;
  propertyPageLinks: string[];
}

export class PageIndexer {
  constructor(
    private readonly db: AppDb,
    private readonly search: PageSearchIndex,
  ) {}

  update(page: IndexablePage) {
    const body = page.body as BlockDocument | null;
    const links = docLinks(body);
    const facetType = facetTypeFor(page.type as PageType);
    const facetPageLinks: string[] = [];
    const facetEntities: string[] = [];
    if (facetType && page.facet) {
      for (const f of FACET_FIELDS[facetType]) {
        const v = page.facet[f.key];
        if (typeof v !== 'string' || !v) continue;
        if (f.type === 'pageLink') facetPageLinks.push(v);
        if (f.type === 'refLink') facetEntities.push(v);
      }
      if (facetType === 'pc' && Array.isArray(page.facet['classes'])) {
        for (const c of page.facet['classes'] as { classUid?: string; subclassUid?: string | null }[]) {
          if (c.classUid) facetEntities.push(c.classUid);
          if (c.subclassUid) facetEntities.push(c.subclassUid);
        }
      }
    }

    // Only link to pages that exist in the same campaign
    const candidateIds = [...new Set([...links.pages.map((l) => l.pageId), ...facetPageLinks, ...page.propertyPageLinks])];
    const valid = new Set(
      candidateIds.length
        ? this.db
            .select({ id: pages.id })
            .from(pages)
            .where(and(inArray(pages.id, candidateIds), eq(pages.campaignId, page.campaignId)))
            .all()
            .map((r) => r.id)
        : [],
    );

    this.db.transaction((tx) => {
      tx.delete(pageLinks).where(eq(pageLinks.fromPageId, page.id)).run();
      const seen = new Set<string>();
      const add = (to: string, kind: string) => {
        const key = `${to}|${kind}`;
        if (!valid.has(to) || to === page.id || seen.has(key)) return;
        seen.add(key);
        tx.insert(pageLinks).values({ fromPageId: page.id, toPageId: to, kind }).run();
      };
      for (const l of links.pages) add(l.pageId, l.kind);
      for (const id of [...facetPageLinks, ...page.propertyPageLinks]) add(id, 'property');

      tx.delete(entityReferences).where(eq(entityReferences.pageId, page.id)).run();
      const refs = new Set<string>();
      for (const e of links.entities) refs.add(`${e.uid}\u0000${e.via}`);
      for (const uid of facetEntities) refs.add(`${uid}\u0000facet`);
      for (const r of refs) {
        const [uid, via] = r.split('\u0000') as [string, string];
        tx.insert(entityReferences).values({ pageId: page.id, uid, via }).run();
      }

      tx.delete(templateUsage).where(and(eq(templateUsage.pageId, page.id), eq(templateUsage.mode, 'linked'))).run();
      for (const l of linkedInstances(body)) {
        tx.insert(templateUsage).values({ templateId: l.templateId, pageId: page.id, blockId: l.blockId, version: l.version, mode: 'linked' }).onConflictDoNothing().run();
      }
    });

    this.search.upsert({
      pageId: page.id,
      campaignId: page.campaignId,
      type: page.type,
      icon: page.icon,
      visibility: page.visibility,
      title: page.title,
      textDm: docText(body, 'dm'),
      textPlayer: docText(body, 'player'),
    });
  }

  remove(pageIds: string[]) {
    this.search.remove(pageIds);
  }

  /** Pages that link to `pageId` (live pages only). */
  backlinks(pageId: string): { fromPageId: string; kind: string }[] {
    return this.db
      .select({ fromPageId: pageLinks.fromPageId, kind: pageLinks.kind })
      .from(pageLinks)
      .innerJoin(pages, eq(pages.id, pageLinks.fromPageId))
      .where(and(eq(pageLinks.toPageId, pageId), isNull(pages.deletedAt)))
      .all();
  }
}

/** Linked (not detached) template instances in a page body. */
export function linkedInstances(body: BlockDocument | null): { templateId: string; blockId: string; version: number }[] {
  const out: { templateId: string; blockId: string; version: number }[] = [];
  walk(body?.content, (n) => {
    if (n.type !== 'templateInstance') return;
    const id = n.attrs?.['templateId'];
    if (typeof id === 'string' && id && !n.attrs?.['detached']) out.push({ templateId: id, blockId: String(n.attrs?.['id'] ?? ''), version: Number(n.attrs?.['version'] ?? 0) });
    return false;
  });
  return out;
}
