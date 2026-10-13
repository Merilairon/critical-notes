import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { docLinks, mergePlayerEdit, projectDoc, queryFilterSchema, runQuery, sanitizeDoc, type BlockDocument, type QueryablePage, type QueryFilterInput } from '@cn/blocks';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { generateKeyBetween } from 'fractional-indexing';
import {
  facetTypeFor,
  FACET_DM_ONLY_FIELDS,
  projectFacetForPlayers,
  FACET_FIELDS,
  FACET_SCHEMAS,
  type BlockDoc,
  type CreatePageInput,
  type FacetType,
  type MovePageInput,
  type PageDto,
  type PageSummaryDto,
  type PageType,
  type PageVisibility,
  type UpdatePageInput,
  type BacklinkDto,
  type QueryRowDto,
} from '@cn/shared';
import type { AppDb } from '../db';
import {
  characterFacets,
  factionFacets,
  itemFacets,
  locationFacets,
  npcFacets,
  pages,
  pageTags,
  pageViewers,
  questFacets,
  sessionFacets,
} from '../db/schema';
import { badRequest, conflict, notFound } from '../lib/http';
import { newId } from '../lib/ids';
import type { PageIndexer } from './page-index';
import type { PropertyService } from './properties';
import type { Viewer } from './visibility';

/** Short random id for blocks inside documents. */
export const newBlockId = () => `b${randomBytes(6).toString('base64url')}`;

type FacetTable = SQLiteTable & { pageId: typeof npcFacets.pageId };

export const FACET_TABLES: Record<FacetType, FacetTable> = {
  npc: npcFacets,
  location: locationFacets,
  session: sessionFacets,
  quest: questFacets,
  faction: factionFacets,
  pc: characterFacets,
  item: itemFacets,
} as unknown as Record<FacetType, FacetTable>;

export const EMPTY_DOC: BlockDoc = { type: 'doc', schemaVersion: 1, content: [{ type: 'paragraph' }] };

type PageRow = typeof pages.$inferSelect;

export function toSummary(p: PageRow): PageSummaryDto {
  return {
    id: p.id,
    parentId: p.parentId,
    sortKey: p.sortKey,
    type: p.type as PageType,
    title: p.title,
    icon: p.icon,
    visibility: p.visibility as PageVisibility,
    updatedAt: p.updatedAt,
  };
}

export class PageService {
  constructor(
    private readonly db: AppDb,
    private readonly properties: PropertyService,
    private readonly indexer: PageIndexer,
  ) {}

  private sanitizeBody(body: unknown) {
    return sanitizeDoc(body, { newId: newBlockId }).doc as BlockDoc;
  }

  /** Recomputes backlinks, entity references and search text for a page. */
  reindex(campaignId: string, pageId: string) {
    const p = this.db.select().from(pages).where(and(eq(pages.id, pageId), eq(pages.campaignId, campaignId))).get();
    if (!p || p.deletedAt) return;
    this.indexer.update({
      id: p.id,
      campaignId,
      type: p.type,
      title: p.title,
      icon: p.icon,
      visibility: p.visibility,
      body: p.body,
      facet: this.facetOf(p.type as PageType, p.id),
      propertyPageLinks: this.properties.linkedPages(campaignId, p.id),
    });
  }

  /** Rebuilds derived data for every live page (startup when the search index is empty). */
  reindexAll(): number {
    const rows = this.db.select({ id: pages.id, campaignId: pages.campaignId }).from(pages).where(isNull(pages.deletedAt)).all();
    for (const r of rows) this.reindex(r.campaignId, r.id);
    return rows.length;
  }

  private livePages(campaignId: string) {
    return this.db
      .select()
      .from(pages)
      .where(and(eq(pages.campaignId, campaignId), isNull(pages.deletedAt)))
      .orderBy(asc(pages.sortKey))
      .all();
  }

  tree(campaignId: string): PageSummaryDto[] {
    return this.livePages(campaignId).map(toSummary);
  }

  private row(campaignId: string, pageId: string): PageRow {
    const row = this.db
      .select()
      .from(pages)
      .where(and(eq(pages.id, pageId), eq(pages.campaignId, campaignId), isNull(pages.deletedAt)))
      .get();
    if (!row) throw notFound('Page not found');
    return row;
  }

  private facetOf(type: PageType, pageId: string): Record<string, unknown> | null {
    const facetType = facetTypeFor(type);
    if (!facetType) return null;
    const table = FACET_TABLES[facetType];
    const row = this.db.select().from(table).where(eq(table.pageId, pageId)).get() as Record<string, unknown> | undefined;
    if (!row) return FACET_SCHEMAS[facetType].parse({}) as Record<string, unknown>;
    const { pageId: _ignored, ...rest } = row;
    return rest;
  }

  get(campaignId: string, pageId: string): PageDto {
    const p = this.row(campaignId, pageId);
    const tags = this.db.select({ tag: pageTags.tag }).from(pageTags).where(eq(pageTags.pageId, pageId)).all();
    const viewers = this.db.select({ userId: pageViewers.userId }).from(pageViewers).where(eq(pageViewers.pageId, pageId)).all();
    return {
      ...toSummary(p),
      campaignId: p.campaignId,
      cover: p.cover,
      body: (p.body as BlockDoc | null) ?? EMPTY_DOC,
      revision: p.revision,
      tags: tags.map((t) => t.tag).sort(),
      viewers: viewers.map((v) => v.userId),
      facet: this.facetOf(p.type as PageType, p.id),
      props: this.properties.valuesFor(campaignId, [p.id]).get(p.id) ?? {},
      createdAt: p.createdAt,
    };
  }

  /** Pages of one type with their facets (for the NPC list, location tree, session log, …). */
  listWithFacets(campaignId: string, type: PageType): (PageSummaryDto & { facet: Record<string, unknown> | null; tags: string[] })[] {
    const rows = this.db
      .select()
      .from(pages)
      .where(and(eq(pages.campaignId, campaignId), eq(pages.type, type), isNull(pages.deletedAt)))
      .orderBy(asc(pages.title))
      .all();
    const facetType = facetTypeFor(type);
    const facets = new Map<string, Record<string, unknown>>();
    if (facetType && rows.length) {
      const table = FACET_TABLES[facetType];
      for (const f of this.db.select().from(table).where(inArray(table.pageId, rows.map((r) => r.id))).all() as Record<string, unknown>[]) {
        const { pageId, ...rest } = f;
        facets.set(String(pageId), rest);
      }
    }
    const tags = new Map<string, string[]>();
    if (rows.length) {
      for (const t of this.db.select().from(pageTags).where(inArray(pageTags.pageId, rows.map((r) => r.id))).all()) {
        tags.set(t.pageId, [...(tags.get(t.pageId) ?? []), t.tag]);
      }
    }
    return rows.map((r) => ({
      ...toSummary(r),
      facet: facets.get(r.id) ?? (facetType ? (FACET_SCHEMAS[facetType].parse({}) as Record<string, unknown>) : null),
      tags: (tags.get(r.id) ?? []).sort(),
    }));
  }

  private siblingKeys(campaignId: string, parentId: string | null): { id: string; sortKey: string }[] {
    return this.db
      .select({ id: pages.id, sortKey: pages.sortKey })
      .from(pages)
      .where(and(eq(pages.campaignId, campaignId), parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId), isNull(pages.deletedAt)))
      .orderBy(asc(pages.sortKey))
      .all();
  }

  private assertPageInCampaign(campaignId: string, pageId: string | null | undefined, expectedType?: PageType) {
    if (!pageId) return;
    const row = this.db.select({ id: pages.id, type: pages.type }).from(pages).where(and(eq(pages.id, pageId), eq(pages.campaignId, campaignId), isNull(pages.deletedAt))).get();
    if (!row) throw badRequest(`Linked page ${pageId} not found in this campaign`);
    if (expectedType && row.type !== expectedType) throw badRequest(`Linked page must be a ${expectedType}`);
  }

  private validateFacet(campaignId: string, facetType: FacetType, input: unknown): Record<string, unknown> {
    const parsed = FACET_SCHEMAS[facetType].safeParse(input ?? {});
    if (!parsed.success) throw badRequest('Invalid page properties', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const data = parsed.data as Record<string, unknown>;
    for (const field of FACET_FIELDS[facetType]) {
      if (field.type === 'pageLink') this.assertPageInCampaign(campaignId, data[field.key] as string | null, field.pageType);
    }
    return data;
  }

  create(campaignId: string, userId: string, input: CreatePageInput & { type: PageType; parentId: string | null; visibility: PageVisibility; tags: string[] }): PageDto {
    this.assertPageInCampaign(campaignId, input.parentId);
    const siblings = this.siblingKeys(campaignId, input.parentId);
    let sortKey: string;
    if (input.afterId) {
      const ix = siblings.findIndex((s) => s.id === input.afterId);
      if (ix < 0) throw badRequest('afterId is not a sibling');
      sortKey = generateKeyBetween(siblings[ix]!.sortKey, siblings[ix + 1]?.sortKey ?? null);
    } else sortKey = generateKeyBetween(siblings.at(-1)?.sortKey ?? null, null);

    const facetType = facetTypeFor(input.type);
    const facet = facetType ? this.validateFacet(campaignId, facetType, input.facet) : null;
    const id = newId();
    const now = Date.now();
    this.db.transaction((tx) => {
      tx.insert(pages)
        .values({
          id,
          campaignId,
          parentId: input.parentId,
          sortKey,
          type: input.type,
          title: input.title,
          icon: input.icon ?? null,
          visibility: input.visibility,
          body: this.sanitizeBody(input.body ?? EMPTY_DOC),
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      if (facetType && facet) tx.insert(FACET_TABLES[facetType]).values({ pageId: id, ...facet } as never).run();
      for (const tag of new Set(input.tags)) tx.insert(pageTags).values({ pageId: id, tag }).run();
      // Same connection, same transaction: an invalid value undoes the whole page
      if (input.props) this.properties.setValues(campaignId, id, input.props, (pid) => this.assertPageInCampaign(campaignId, pid));
    });
    this.reindex(campaignId, id);
    return this.get(campaignId, id);
  }

  update(campaignId: string, pageId: string, input: UpdatePageInput): PageDto {
    const current = this.row(campaignId, pageId);
    if (current.revision !== input.revision) {
      throw conflict('This page was changed by someone else', { current: this.get(campaignId, pageId) });
    }
    const nextType = (input.type ?? current.type) as PageType;
    const oldFacetType = facetTypeFor(current.type as PageType);
    const newFacetType = facetTypeFor(nextType);
    let facet: Record<string, unknown> | null = null;
    if (newFacetType && (input.facet !== undefined || newFacetType !== oldFacetType)) {
      const base = newFacetType === oldFacetType ? (this.facetOf(nextType, pageId) ?? {}) : {};
      facet = this.validateFacet(campaignId, newFacetType, { ...base, ...(input.facet ?? {}) });
    }
    if (input.props) this.properties.setValues(campaignId, pageId, input.props, (id) => this.assertPageInCampaign(campaignId, id));

    this.db.transaction((tx) => {
      const patch: Partial<typeof pages.$inferInsert> = { updatedAt: Date.now(), revision: current.revision + 1 };
      if (input.title !== undefined) patch.title = input.title;
      if (input.icon !== undefined) patch.icon = input.icon;
      if (input.cover !== undefined) patch.cover = input.cover;
      if (input.visibility !== undefined) patch.visibility = input.visibility;
      if (input.body !== undefined) patch.body = this.sanitizeBody(input.body);
      if (input.type !== undefined) patch.type = input.type;
      tx.update(pages).set(patch).where(eq(pages.id, pageId)).run();

      if (oldFacetType && oldFacetType !== newFacetType) tx.delete(FACET_TABLES[oldFacetType]).where(eq(FACET_TABLES[oldFacetType].pageId, pageId)).run();
      if (newFacetType && facet) {
        const table = FACET_TABLES[newFacetType];
        tx.insert(table)
          .values({ pageId, ...facet } as never)
          .onConflictDoUpdate({ target: table.pageId, set: facet as never })
          .run();
      }
      if (input.tags !== undefined) {
        tx.delete(pageTags).where(eq(pageTags.pageId, pageId)).run();
        for (const tag of new Set(input.tags)) tx.insert(pageTags).values({ pageId, tag }).run();
      }
      if (input.viewers !== undefined) {
        tx.delete(pageViewers).where(eq(pageViewers.pageId, pageId)).run();
        for (const userId of new Set(input.viewers)) tx.insert(pageViewers).values({ pageId, userId }).run();
      }
    });
    this.reindex(campaignId, pageId);
    return this.get(campaignId, pageId);
  }

  move(campaignId: string, pageId: string, input: MovePageInput): PageSummaryDto {
    const page = this.row(campaignId, pageId);
    const parentId = input.parentId ?? null;
    if (parentId) {
      this.assertPageInCampaign(campaignId, parentId);
      // Prevent cycles: the new parent must not be the page itself or one of its descendants
      const all = this.livePages(campaignId);
      const parentOf = new Map(all.map((p) => [p.id, p.parentId]));
      for (let cur: string | null | undefined = parentId; cur; cur = parentOf.get(cur)) {
        if (cur === pageId) throw badRequest('Cannot move a page into itself');
      }
    }
    const siblings = this.siblingKeys(campaignId, parentId).filter((s) => s.id !== pageId);
    const keyOf = (id: string | null | undefined) => (id ? (siblings.find((s) => s.id === id)?.sortKey ?? null) : null);
    let lower: string | null;
    let upper: string | null;
    if (input.afterId) {
      lower = keyOf(input.afterId);
      if (lower == null) throw badRequest('afterId is not a sibling');
      const ix = siblings.findIndex((s) => s.id === input.afterId);
      upper = siblings[ix + 1]?.sortKey ?? null;
    } else if (input.beforeId) {
      upper = keyOf(input.beforeId);
      if (upper == null) throw badRequest('beforeId is not a sibling');
      const ix = siblings.findIndex((s) => s.id === input.beforeId);
      lower = ix > 0 ? siblings[ix - 1]!.sortKey : null;
    } else {
      lower = siblings.at(-1)?.sortKey ?? null;
      upper = null;
    }
    const sortKey = generateKeyBetween(lower, upper);
    this.db.update(pages).set({ parentId, sortKey, updatedAt: Date.now() }).where(eq(pages.id, page.id)).run();
    return toSummary({ ...page, parentId, sortKey });
  }

  /** Points NPC facets that use a homebrew statblock at its (possibly renamed) uid. */
  relinkStatblock(entityId: string, uid: string | null) {
    this.db.update(npcFacets).set({ statblockUid: uid }).where(eq(npcFacets.statblockHomebrewEntityId, entityId)).run();
  }

  /** Soft-deletes a page and its descendants. Returns the deleted ids. */
  /**
   * Brings back a deleted page and the subpages deleted with it. If its parent is still deleted, it comes
   * back at the top level.
   */
  restore(campaignId: string, pageId: string): string[] {
    const row = this.db.select().from(pages).where(and(eq(pages.id, pageId), eq(pages.campaignId, campaignId))).get();
    if (!row) throw notFound('Page not found');
    if (row.deletedAt === null) throw badRequest('This page is not deleted');
    const together = this.db.select({ id: pages.id, parentId: pages.parentId }).from(pages).where(and(eq(pages.campaignId, campaignId), eq(pages.deletedAt, row.deletedAt))).all();
    const children = new Map<string | null, string[]>();
    for (const p of together) children.set(p.parentId, [...(children.get(p.parentId) ?? []), p.id]);
    const ids: string[] = [];
    const walk = (id: string) => {
      ids.push(id);
      for (const c of children.get(id) ?? []) walk(c);
    };
    walk(pageId);
    const parentLive = row.parentId !== null && !!this.db.select({ id: pages.id }).from(pages).where(and(eq(pages.id, row.parentId), isNull(pages.deletedAt))).get();
    this.db.transaction((tx) => {
      tx.update(pages).set({ deletedAt: null, updatedAt: Date.now() }).where(inArray(pages.id, ids)).run();
      if (row.parentId !== null && !parentLive) {
        const last = this.siblingKeys(campaignId, null).filter((s) => s.id !== pageId).at(-1)?.sortKey ?? null;
        tx.update(pages).set({ parentId: null, sortKey: generateKeyBetween(last, null) }).where(eq(pages.id, pageId)).run();
      }
    });
    for (const id of ids) this.reindex(campaignId, id);
    return ids;
  }

  remove(campaignId: string, pageId: string): string[] {
    this.row(campaignId, pageId);
    const all = this.livePages(campaignId);
    const children = new Map<string | null, string[]>();
    for (const p of all) children.set(p.parentId, [...(children.get(p.parentId) ?? []), p.id]);
    const ids: string[] = [];
    const walk = (id: string) => {
      ids.push(id);
      for (const c of children.get(id) ?? []) walk(c);
    };
    walk(pageId);
    this.db.update(pages).set({ deletedAt: Date.now() }).where(inArray(pages.id, ids)).run();
    this.indexer.remove(ids);
    return ids;
  }

  // region Player views

  /**
   * A page as a player may see it: DM-only and secret blocks removed, links to pages they cannot see flattened,
   * DM-only facet fields and properties left out, and the list of named viewers hidden.
   */
  projectPage(campaignId: string, page: PageDto, visible: ReadonlySet<string>): PageDto {
    const canSeePage = (id: string) => visible.has(id);
    const body = projectDoc(page.body as BlockDocument | null, { role: 'player', canSeePage }) as BlockDoc | null;
    const facetType = facetTypeFor(page.type);
    const defs = this.properties.list(campaignId);
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(page.props)) {
      const def = defs.find((d) => d.key === key);
      if (!def || def.dmOnly) continue;
      if (def.type === 'pageLink' && typeof value === 'string' && !canSeePage(value)) continue;
      props[key] = value;
    }
    return {
      ...page,
      parentId: page.parentId && canSeePage(page.parentId) ? page.parentId : null,
      body,
      facet: facetType ? projectFacetForPlayers(facetType, page.facet, canSeePage) : page.facet,
      props,
      viewers: [],
    };
  }

  /** The DM's "preview as player": what a player who is shown every shared page receives. */
  projectForPlayers(campaignId: string, page: PageDto): PageDto {
    const shared = new Set(this.livePages(campaignId).filter((p) => p.visibility === 'all').map((p) => p.id));
    return this.projectPage(campaignId, page, shared);
  }

  /** The page tree a viewer sees (pages under a hidden parent move to the top level). */
  treeFor(campaignId: string, viewer: Viewer, visible: ReadonlySet<string>): PageSummaryDto[] {
    const all = this.tree(campaignId);
    if (viewer.gm) return all;
    return all.filter((p) => visible.has(p.id)).map((p) => (p.parentId && !visible.has(p.parentId) ? { ...p, parentId: null } : p));
  }

  getFor(campaignId: string, viewer: Viewer, pageId: string, visible: ReadonlySet<string>): PageDto {
    if (!viewer.gm && !visible.has(pageId)) throw notFound('Page not found');
    const page = this.get(campaignId, pageId);
    return viewer.gm ? page : this.projectPage(campaignId, page, visible);
  }

  /** Backlinks a viewer may know about: only from pages they see, and only links in what they see of them. */
  backlinksFor(campaignId: string, viewer: Viewer, pageId: string, visible: ReadonlySet<string>): BacklinkDto[] {
    const all = this.backlinks(campaignId, pageId);
    if (viewer.gm) return all;
    return all.filter((b) => {
      if (!visible.has(b.id)) return false;
      const page = this.projectPage(campaignId, this.get(campaignId, b.id), visible);
      const links = docLinks(page.body as BlockDocument | null).pages.some((l) => l.pageId === pageId);
      const facetType = facetTypeFor(page.type);
      const facetLink = !!facetType && FACET_FIELDS[facetType].some((f) => f.type === 'pageLink' && page.facet?.[f.key] === pageId);
      const propLink = Object.values(page.props).includes(pageId);
      return links || facetLink || propLink;
    });
  }

  /** Query rows over what the viewer sees (players cannot filter on hidden fields either). */
  queryFor(campaignId: string, viewer: Viewer, filterInput: QueryFilterInput, ctxPageId: string | null, visible: ReadonlySet<string>): QueryRowDto[] {
    if (viewer.gm) return this.query(campaignId, filterInput, ctxPageId);
    const parsed = queryFilterSchema.safeParse(filterInput ?? {});
    if (!parsed.success) throw badRequest('Invalid query', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const defs = this.properties.list(campaignId);
    const hiddenProps = new Set(defs.filter((d) => d.dmOnly).map((d) => d.key));
    const canSeePage = (id: string) => visible.has(id);
    const rows = this.queryable(campaignId)
      .filter((p) => visible.has(p.id))
      .map((p) => {
        const facetType = facetTypeFor(p.type as PageType);
        const props = Object.fromEntries(Object.entries(p.props).filter(([k]) => !hiddenProps.has(k)));
        return {
          ...p,
          parentId: p.parentId && canSeePage(p.parentId) ? p.parentId : null,
          facet: facetType ? projectFacetForPlayers(facetType, p.facet, canSeePage) : p.facet,
          props,
          summary: { ...p.summary, parentId: p.parentId && canSeePage(p.parentId) ? p.parentId : null },
        };
      });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return runQuery(rows, parsed.data, ctxPageId && canSeePage(ctxPageId) ? ctxPageId : null).map((p) => {
      const full = byId.get(p.id)!;
      return { ...full.summary, tags: full.tags, facet: full.facet, props: full.props };
    });
  }

  /**
   * A player's edit of their own character: content, details and (non-DM) properties. Blocks they cannot see
   * are kept; they cannot change type, visibility or who may see the page.
   */
  updateAsPlayer(campaignId: string, pageId: string, input: UpdatePageInput, visible: ReadonlySet<string>): PageDto {
    const current = this.get(campaignId, pageId);
    if (input.type !== undefined || input.visibility !== undefined || input.viewers !== undefined) throw badRequest('Only the DM can change who sees a page or its type');
    const hiddenProps = new Set(this.properties.list(campaignId).filter((d) => d.dmOnly).map((d) => d.key));
    if (input.props && Object.keys(input.props).some((k) => hiddenProps.has(k))) throw badRequest('That property is for the DM');
    const facetType = facetTypeFor(current.type);
    const dmFields = new Set(facetType ? FACET_DM_ONLY_FIELDS[facetType] : []);
    if (input.facet && Object.keys(input.facet).some((k) => dmFields.has(k) || k === 'playerUserId')) throw badRequest('Those details are for the DM');
    const body = input.body
      ? (mergePlayerEdit(current.body as BlockDocument | null, input.body as BlockDocument, { role: 'player', canSeePage: (id) => visible.has(id) }) as BlockDoc)
      : undefined;
    const saved = this.update(campaignId, pageId, { ...input, ...(body ? { body } : {}) });
    return this.projectPage(campaignId, saved, visible);
  }

  // endregion

  backlinks(campaignId: string, pageId: string): BacklinkDto[] {
    this.row(campaignId, pageId);
    const links = this.indexer.backlinks(pageId);
    const byPage = new Map<string, Set<string>>();
    for (const l of links) byPage.set(l.fromPageId, (byPage.get(l.fromPageId) ?? new Set()).add(l.kind));
    if (!byPage.size) return [];
    return this.db
      .select()
      .from(pages)
      .where(and(inArray(pages.id, [...byPage.keys()]), isNull(pages.deletedAt)))
      .orderBy(asc(pages.title))
      .all()
      .map((p) => ({ ...toSummary(p), kinds: [...(byPage.get(p.id) ?? [])] as BacklinkDto['kinds'] }));
  }

  /** All live pages of a campaign in queryable form (facets, tags, props). */
  queryable(campaignId: string): (QueryablePage & { summary: PageSummaryDto })[] {
    const rows = this.livePages(campaignId);
    const ids = rows.map((r) => r.id);
    const tags = new Map<string, string[]>();
    if (ids.length) for (const t of this.db.select().from(pageTags).where(inArray(pageTags.pageId, ids)).all()) tags.set(t.pageId, [...(tags.get(t.pageId) ?? []), t.tag]);
    const facets = new Map<string, Record<string, unknown>>();
    for (const [type, table] of Object.entries(FACET_TABLES) as [FacetType, FacetTable][]) {
      const typed = rows.filter((r) => facetTypeFor(r.type as PageType) === type).map((r) => r.id);
      if (!typed.length) continue;
      for (const f of this.db.select().from(table).where(inArray(table.pageId, typed)).all() as Record<string, unknown>[]) {
        const { pageId, ...rest } = f;
        facets.set(String(pageId), rest);
      }
    }
    const props = this.properties.valuesFor(campaignId, ids);
    return rows.map((r) => ({
      id: r.id,
      parentId: r.parentId,
      type: r.type,
      title: r.title,
      tags: tags.get(r.id) ?? [],
      facet: facets.get(r.id) ?? null,
      props: props.get(r.id) ?? {},
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      summary: toSummary(r),
    }));
  }

  query(campaignId: string, filterInput: QueryFilterInput, ctxPageId: string | null, canSee: (pageId: string) => boolean = () => true): QueryRowDto[] {
    const parsed = queryFilterSchema.safeParse(filterInput ?? {});
    if (!parsed.success) throw badRequest('Invalid query', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const all = this.queryable(campaignId).filter((p) => canSee(p.id));
    const byId = new Map(all.map((p) => [p.id, p]));
    return runQuery(all, parsed.data, ctxPageId).map((p) => {
      const full = byId.get(p.id)!;
      return { ...full.summary, tags: full.tags, facet: full.facet, props: full.props };
    });
  }
}
