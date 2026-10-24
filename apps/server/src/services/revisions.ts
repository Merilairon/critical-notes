/**
 * Page history, recording side (task N1.2; design: docs/design/page-history.md). Every content write of a page leaves a full
 * snapshot in `page_revisions`, in the same transaction as the write. The pure parts (hash, fold rule) live here; the reads of
 * the page state live in `PageService`, which owns the facet tables.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { stableStringify } from '@cn/fivetools';
import type { AppDb } from '../db';
import { pageRevisions } from '../db/schema';

/** Why a revision row exists (design 3.1). `tracker` is the hit-point sync at the end of a combat. */
export type RevisionCause = 'create' | 'edit' | 'restore' | 'template_sync' | 'template_apply' | 'edition_migration' | 'import' | 'tracker' | 'baseline';

/** Who is behind a write. `system` is only the lazy baseline row and the start-up upgrade of built-in templates; no request carries it. */
export type RevisionSource = 'web' | 'player' | 'mcp' | 'system';

/** Where a request came from: built once per request by `writeOrigin` (routes) and passed down to services. */
export interface WriteOrigin {
  source: Exclude<RevisionSource, 'system'>;
  /** The `api_tokens.id` when `source` is `mcp`. */
  tokenId?: string;
}

/** The context of one page write. Required on every `PageService` write so the compiler finds each call site. */
export interface WriteContext {
  /** The account the write ran as (the token's owner for MCP); null only for the start-up template upgrade. */
  userId: string | null;
  source: RevisionSource;
  tokenId?: string;
  cause: RevisionCause;
  /** For `cause = 'restore'`: the revision whose content came back. */
  restoredFrom?: number;
  /**
   * One import or template instantiation (in memory, never stored): writes with the same id, author and source fold into the
   * page's creating row, so the create-then-fill of an import is one revision.
   */
  operationId?: string;
}

export const contextFor = (userId: string | null, origin: WriteOrigin, cause: RevisionCause, extra: Pick<WriteContext, 'restoredFrom' | 'operationId'> = {}): WriteContext => ({
  userId,
  source: origin.source,
  ...(origin.tokenId ? { tokenId: origin.tokenId } : {}),
  cause,
  ...extra,
});

/** The versioned content of a page (design 4.5): what is hashed, stored and compared. */
export interface PageSnapshot {
  title: string;
  type: string;
  body: unknown | null;
  details: Record<string, unknown> | null;
  /** By property key; `{}` when none. */
  properties: Record<string, unknown>;
}

export function snapshotHash(s: PageSnapshot): string {
  const { title, type, body, details, properties } = s;
  return createHash('sha256').update(stableStringify({ title, type, body, details, properties })).digest('hex');
}

export const snapshotBytes = (s: PageSnapshot): number => Buffer.byteLength(JSON.stringify([s.title, s.body, s.details, s.properties]), 'utf8');

export interface HistorySettings {
  /** Saves by the same author within this many minutes fold into one row; 0 turns folding off. */
  coalesceMinutes: number;
}

export const DEFAULT_HISTORY_COALESCE_MINUTES = 2;

type Handle = Pick<AppDb, 'select' | 'insert' | 'delete'>;
type RevisionRow = typeof pageRevisions.$inferSelect;

export interface PreState {
  snapshot: PageSnapshot;
  hash: string;
  revision: number;
  updatedAt: number;
}

/** Folds into the newest row only when it is the same person's, source's and kind of save, within the window (design 4.2). */
function mayFold(newest: RevisionRow, ctx: WriteContext, now: number, windowMs: number, sameOperation: boolean): boolean {
  if (newest.authorUserId !== ctx.userId || newest.source !== ctx.source || (newest.tokenId ?? null) !== (ctx.tokenId ?? null)) return false;
  if (sameOperation && (newest.cause === 'create' || newest.cause === 'import')) return true;
  if (ctx.source === 'mcp' || newest.cause !== 'edit' || ctx.cause !== 'edit') return false;
  return windowMs > 0 && now - newest.createdAt <= windowMs;
}

/**
 * Records the page state after a write. `pre` is the state read at the START of the same transaction (null for a new page).
 * Must run on the transaction handle. History never makes a save fail: the baseline and the new row use conflict clauses.
 */
export function recordRevision(
  tx: Handle,
  a: { pageId: string; campaignId: string; revision: number; post: PageSnapshot; pre: PreState | null; ctx: WriteContext; now: number; settings: HistorySettings; sameOperation: boolean },
): void {
  const post = a.post;
  const postHash = snapshotHash(post);
  if (a.pre && a.pre.hash === postHash) return; // visibility, tags or viewers only, or a no-op save

  const newestOf = () => tx.select().from(pageRevisions).where(eq(pageRevisions.pageId, a.pageId)).orderBy(desc(pageRevisions.revision)).limit(1).get();
  let newest = newestOf();

  // Baseline: the state this write overwrites was never recorded (page older than this feature, restored backup, bypassed write)
  if (a.pre && (!newest || newest.contentHash !== a.pre.hash)) {
    const row = {
      pageId: a.pageId,
      campaignId: a.campaignId,
      title: a.pre.snapshot.title,
      type: a.pre.snapshot.type,
      body: a.pre.snapshot.body,
      details: a.pre.snapshot.details,
      properties: a.pre.snapshot.properties,
      authorUserId: null,
      source: 'system',
      tokenId: null,
      cause: 'baseline',
      restoredFrom: null,
      contentHash: a.pre.hash,
      bytes: snapshotBytes(a.pre.snapshot),
      createdAt: a.pre.updatedAt,
    };
    const inserted = tx.insert(pageRevisions).values({ ...row, revision: a.pre.revision }).onConflictDoNothing().run().changes;
    if (!inserted) {
      // A row with this number but another hash is already there: number the baseline below the lowest one, never fail the save
      const low = tx.select({ m: sql<number>`min(${pageRevisions.revision})` }).from(pageRevisions).where(eq(pageRevisions.pageId, a.pageId)).get()?.m ?? a.pre.revision;
      tx.insert(pageRevisions).values({ ...row, revision: low - 1 }).onConflictDoNothing().run();
    }
    newest = newestOf();
  }

  if (newest && newest.contentHash === postHash) return;

  let createdAt = a.now;
  let cause: RevisionCause = a.ctx.cause;
  if (newest && a.pre && newest.contentHash === a.pre.hash && mayFold(newest, a.ctx, a.now, a.settings.coalesceMinutes * 60_000, a.sameOperation)) {
    createdAt = newest.createdAt; // a run is one entry starting when it began
    if (a.sameOperation && (newest.cause === 'create' || newest.cause === 'import')) cause = newest.cause as RevisionCause;
    tx.delete(pageRevisions).where(and(eq(pageRevisions.pageId, a.pageId), eq(pageRevisions.revision, newest.revision))).run();
  }
  const values = {
    pageId: a.pageId,
    revision: a.revision,
    campaignId: a.campaignId,
    title: post.title,
    type: post.type,
    body: post.body,
    details: post.details,
    properties: post.properties,
    authorUserId: a.ctx.userId,
    source: a.ctx.source,
    tokenId: a.ctx.tokenId ?? null,
    cause,
    restoredFrom: a.ctx.restoredFrom ?? null,
    contentHash: postHash,
    bytes: snapshotBytes(post),
    createdAt,
  };
  tx.insert(pageRevisions)
    .values(values)
    .onConflictDoUpdate({ target: [pageRevisions.pageId, pageRevisions.revision], set: values })
    .run();
}
