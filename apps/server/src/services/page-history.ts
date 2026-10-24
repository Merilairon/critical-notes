/**
 * Page history, reading and restoring side (task N1.2; the HTTP endpoints are task N1.3). A revision is a full copy of the stored
 * page including DM-only content, so this service is the ONLY reader of `page_revisions` and every caller must check
 * `viewer.gm` first (the routes of N1.3 do). Nothing here is ever added to a page DTO.
 */
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import { facetTypeFor, FACET_ACCESS_FIELDS, FACET_FIELDS, type BlockDoc, type PageDto, type PageType } from '@cn/shared';
import type { AppDb } from '../db';
import { apiTokens, pageRevisions, pages, users } from '../db/schema';
import { conflict, notFound } from '../lib/http';
import type { PageService } from './pages';
import type { PropertyService } from './properties';
import { snapshotHash, type PageSnapshot, type RevisionCause, type RevisionSource, type WriteContext } from './revisions';

export interface RevisionListItem {
  revision: number;
  createdAt: number;
  author: { id: string; displayName: string } | null;
  source: RevisionSource;
  /** The token's current name when `source` is `mcp`; null when it was deleted. */
  tokenName: string | null;
  cause: RevisionCause;
  restoredFrom: number | null;
  title: string;
  bytes: number;
}

export interface RevisionDetail extends RevisionListItem, PageSnapshot {
  type: string;
}

export interface RestoreResult {
  page: PageDto;
  /** False when the live page already had this content: nothing was written. */
  restored: boolean;
  warnings: string[];
}

export const MAX_HISTORY_PAGE = 100;

export class PageHistoryService {
  constructor(
    private readonly db: AppDb,
    private readonly pages: PageService,
    private readonly properties: PropertyService,
  ) {}

  private live(campaignId: string, pageId: string) {
    const p = this.db.select({ id: pages.id }).from(pages).where(and(eq(pages.id, pageId), eq(pages.campaignId, campaignId), isNull(pages.deletedAt))).get();
    if (!p) throw notFound('Page not found');
  }

  private columns() {
    return {
      revision: pageRevisions.revision,
      createdAt: pageRevisions.createdAt,
      authorId: users.id,
      authorName: users.displayName,
      source: pageRevisions.source,
      tokenName: apiTokens.name,
      cause: pageRevisions.cause,
      restoredFrom: pageRevisions.restoredFrom,
      title: pageRevisions.title,
      bytes: pageRevisions.bytes,
    };
  }

  private item(r: { revision: number; createdAt: number; authorId: string | null; authorName: string | null; source: string; tokenName: string | null; cause: string; restoredFrom: number | null; title: string; bytes: number }): RevisionListItem {
    return {
      revision: r.revision,
      createdAt: r.createdAt,
      author: r.authorId ? { id: r.authorId, displayName: r.authorName ?? '' } : null,
      source: r.source as RevisionSource,
      tokenName: r.tokenName,
      cause: r.cause as RevisionCause,
      restoredFrom: r.restoredFrom,
      title: r.title,
      bytes: r.bytes,
    };
  }

  /** Revisions of a live page, newest first, without content. */
  list(campaignId: string, pageId: string, opts: { before?: number; limit?: number } = {}): RevisionListItem[] {
    this.live(campaignId, pageId);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_HISTORY_PAGE);
    return this.db
      .select(this.columns())
      .from(pageRevisions)
      .leftJoin(users, eq(users.id, pageRevisions.authorUserId))
      .leftJoin(apiTokens, eq(apiTokens.id, pageRevisions.tokenId))
      .where(and(eq(pageRevisions.pageId, pageId), eq(pageRevisions.campaignId, campaignId), opts.before === undefined ? undefined : lt(pageRevisions.revision, opts.before)))
      .orderBy(desc(pageRevisions.revision))
      .limit(limit)
      .all()
      .map((r) => this.item(r));
  }

  /** One revision with its full content. */
  get(campaignId: string, pageId: string, revision: number): RevisionDetail {
    this.live(campaignId, pageId);
    const r = this.db
      .select({ ...this.columns(), type: pageRevisions.type, body: pageRevisions.body, details: pageRevisions.details, properties: pageRevisions.properties })
      .from(pageRevisions)
      .leftJoin(users, eq(users.id, pageRevisions.authorUserId))
      .leftJoin(apiTokens, eq(apiTokens.id, pageRevisions.tokenId))
      .where(and(eq(pageRevisions.pageId, pageId), eq(pageRevisions.campaignId, campaignId), eq(pageRevisions.revision, revision)))
      .get();
    if (!r) throw notFound('Revision not found');
    return { ...this.item(r), type: r.type, body: r.body ?? null, details: (r.details as Record<string, unknown> | null) ?? null, properties: (r.properties as Record<string, unknown>) ?? {} };
  }

  private pageExists(campaignId: string, id: unknown, type?: PageType): boolean {
    if (typeof id !== 'string') return false;
    const row = this.db.select({ type: pages.type }).from(pages).where(and(eq(pages.id, id), eq(pages.campaignId, campaignId), isNull(pages.deletedAt))).get();
    return !!row && (!type || row.type === type);
  }

  /**
   * Brings back the content of a revision as a normal update (a new revision with `cause = restore`; nothing is deleted, so a
   * restore can be undone). Restores title, type, body, details and properties only: never visibility, viewers, parent, tags, icon,
   * cover, nor access-bearing details (`playerUserId` keeps its live value). Links to things that are gone are cleared with a warning.
   */
  restore(campaignId: string, pageId: string, revision: number, expectedRevision: number, ctx: WriteContext): RestoreResult {
    const current = this.pages.get(campaignId, pageId);
    if (current.revision !== expectedRevision) throw conflict('This page was changed by someone else', { current });
    const snap = this.get(campaignId, pageId, revision);
    const warnings: string[] = [];
    const snapType = snap.type as PageType;
    const facetType = facetTypeFor(snapType);

    let details: Record<string, unknown> | null = null;
    if (facetType && snap.details) {
      details = { ...snap.details };
      const liveSameFacet = facetTypeFor(current.type) === facetType ? current.facet : null;
      for (const key of FACET_ACCESS_FIELDS[facetType]) details[key] = liveSameFacet?.[key] ?? null;
      for (const f of FACET_FIELDS[facetType]) {
        if (f.type === 'pageLink' && details[f.key] && !this.pageExists(campaignId, details[f.key], f.pageType)) {
          details[f.key] = null;
          warnings.push(`The page linked in "${f.label ?? f.key}" no longer exists; the link was cleared`);
        }
      }
    }

    const defs = new Map(this.properties.list(campaignId).map((d) => [d.key, d]));
    const target: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(snap.properties)) {
      const def = defs.get(key);
      if (!def) {
        warnings.push(`The property "${key}" no longer exists; its value was skipped`);
        continue;
      }
      if (def.type === 'pageLink' && value && !this.pageExists(campaignId, value)) {
        warnings.push(`The page linked in "${def.label}" no longer exists; the link was cleared`);
        continue;
      }
      target[key] = value;
    }

    const wanted: PageSnapshot = { title: snap.title, type: snap.type, body: snap.body ?? current.body, details, properties: target };
    const liveSnap: PageSnapshot = { title: current.title, type: current.type, body: current.body, details: current.facet, properties: current.props };
    if (snapshotHash(wanted) === snapshotHash(liveSnap)) return { page: current, restored: false, warnings };

    const props: Record<string, unknown> = { ...target };
    for (const key of Object.keys(current.props)) if (!(key in target)) props[key] = null;
    const page = this.pages.update(
      campaignId,
      pageId,
      {
        revision: expectedRevision,
        title: snap.title,
        type: snapType,
        ...(snap.body ? { body: snap.body as BlockDoc } : {}),
        ...(details ? { facet: details } : {}),
        props,
      },
      { ...ctx, cause: 'restore', restoredFrom: revision },
    );
    return { page, restored: true, warnings };
  }
}
