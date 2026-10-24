/**
 * The per-player reveal detector (docs/design/reveal.md 2.3). Runs on committed page writes, compares the stored old and new state
 * and publishes `page-shared` / `block-revealed` pointers on the campaign bus. Nothing a client sends is trusted: the events are
 * inferred from saves, for every writer (web, co-DM, player edit, MCP).
 */
import { eq } from 'drizzle-orm';
import { droppedForPlayers, type BlockDocument, type BlockNode, type ProjectContext } from '@cn/blocks';
import { isGameMaster, MAX_REVEALED_BLOCK_IDS, type CampaignRole } from '@cn/shared';
import type { AppDb } from '../db';
import { campaignMembers, characterFacets } from '../db/schema';
import type { CampaignEventBus } from './event-bus';
import type { PageChange, PageState } from './pages';
import { viewerOf, type VisibilityService } from './visibility';

/** More `page-shared` events than this in one flush collapse into a single `resync` for that player. */
export const MAX_SHARED_EVENTS_PER_FLUSH = 3;

const stripReveal = (node: BlockNode): BlockNode => {
  const { revealed: _r, visibility: _v, ...attrs } = node.attrs ?? {};
  const out: BlockNode = { ...node, attrs };
  if (node.content) out.content = node.content.map(stripReveal);
  return out;
};
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : val,
  );
/** Same id and same content, ignoring `revealed` and `visibility` all the way down. */
const fingerprint = (node: BlockNode) => canonical(stripReveal(node));
const idOf = (node: BlockNode) => (typeof node.attrs?.id === 'string' && node.attrs.id ? node.attrs.id : '');

/**
 * Ids of the blocks that the player's projection of `oldDoc` drops (tops of hidden subtrees) and that the projection of
 * `newDoc` shows, matched by (id, fingerprint) as a multiset. The same `ctx` serves both bodies, so only the body change counts.
 */
export function newlyVisibleBlockIds(oldDoc: BlockDocument | null, newDoc: BlockDocument | null, ctx: ProjectContext): string[] {
  const tops: BlockNode[] = [];
  const walkOld = (nodes: BlockNode[] | undefined) => {
    for (const n of nodes ?? []) {
      if (droppedForPlayers(n, ctx)) tops.push(n);
      else walkOld(n.content);
    }
  };
  walkOld(oldDoc?.content);
  if (!tops.length) return [];
  const pool = new Map<string, number>();
  const walkNew = (nodes: BlockNode[] | undefined) => {
    for (const n of nodes ?? []) {
      if (droppedForPlayers(n, ctx)) continue;
      const id = idOf(n);
      if (id) {
        const key = `${id}\u0000${fingerprint(n)}`;
        pool.set(key, (pool.get(key) ?? 0) + 1);
      }
      walkNew(n.content);
    }
  };
  walkNew(newDoc?.content);
  const out: string[] = [];
  for (const top of tops) {
    const id = idOf(top);
    if (!id) continue;
    const key = `${id}\u0000${fingerprint(top)}`;
    const left = pool.get(key) ?? 0;
    if (left > 0) {
      pool.set(key, left - 1);
      out.push(id);
    }
  }
  return [...new Set(out)].slice(0, MAX_REVEALED_BLOCK_IDS);
}

export class RevealService {
  constructor(
    private readonly db: AppDb,
    private readonly visibility: VisibilityService,
    private readonly bus: CampaignEventBus,
  ) {}

  /** Entry point for `PageService.onCommitted`: one flush (possibly several pages, several campaigns). */
  handle(changes: PageChange[]): void {
    // Several writes to one page in a flush are one change: the first `before` and the last `after`
    const merged = new Map<string, PageChange>();
    for (const c of changes) {
      const prev = merged.get(c.pageId);
      merged.set(c.pageId, prev ? { ...c, before: prev.before } : c);
    }
    const byCampaign = new Map<string, PageChange[]>();
    for (const c of merged.values()) byCampaign.set(c.campaignId, [...(byCampaign.get(c.campaignId) ?? []), c]);
    for (const [campaignId, list] of byCampaign) this.handleCampaign(campaignId, list);
  }

  private players(campaignId: string): string[] {
    return this.db
      .select({ userId: campaignMembers.userId, role: campaignMembers.role })
      .from(campaignMembers)
      .where(eq(campaignMembers.campaignId, campaignId))
      .all()
      .filter((m) => !isGameMaster(m.role as CampaignRole))
      .map((m) => m.userId);
  }

  private handleCampaign(campaignId: string, changes: PageChange[]) {
    const players = this.players(campaignId);
    if (!players.length) return;
    const shared: { pageId: string; audience: Set<string> }[] = [];
    const revealed: { pageId: string; blockIds: string[]; audience: Set<string> }[] = [];
    for (const change of changes) {
      const { before, after, pageId } = change;
      const ownerId = this.db.select({ id: characterFacets.playerUserId }).from(characterFacets).where(eq(characterFacets.pageId, pageId)).get()?.id ?? null;
      const sees = (s: PageState | null, userId: string) =>
        !!s && s.deletedAt === null && (s.visibility === 'all' || (s.visibility === 'selected' && s.viewers.includes(userId)) || ownerId === userId);
      const bodyChanged = !!before && JSON.stringify(before.body) !== JSON.stringify(after.body);
      const sharedTo = new Set<string>();
      const byIds = new Map<string, Set<string>>();
      for (const userId of players) {
        const before_ = sees(before, userId);
        const after_ = sees(after, userId);
        if (!before_ && after_) sharedTo.add(userId);
        else if (before_ && after_ && bodyChanged) {
          const viewer = viewerOf(userId, 'player');
          const ctx: ProjectContext = { role: 'player', canSeePage: (id) => this.visibility.canSee(campaignId, viewer, id) };
          const ids = newlyVisibleBlockIds(before!.body as BlockDocument | null, after.body as BlockDocument | null, ctx);
          if (ids.length) byIds.set(ids.join('\u0000'), (byIds.get(ids.join('\u0000')) ?? new Set()).add(userId));
        }
      }
      if (sharedTo.size) shared.push({ pageId, audience: sharedTo });
      for (const [key, audience] of byIds) revealed.push({ pageId, blockIds: key.split('\u0000'), audience });
    }
    // More than 3 new pages for one player in a flush (template instantiation): one resync, not one toast each
    const counts = new Map<string, number>();
    for (const s of shared) for (const u of s.audience) counts.set(u, (counts.get(u) ?? 0) + 1);
    const collapsed = new Set([...counts].filter(([, n]) => n > MAX_SHARED_EVENTS_PER_FLUSH).map(([u]) => u));
    for (const s of shared) {
      for (const u of collapsed) s.audience.delete(u);
      if (s.audience.size) this.bus.publish(campaignId, { kind: 'page-shared', pageId: s.pageId, audience: s.audience, gm: true });
    }
    if (collapsed.size) this.bus.publish(campaignId, { kind: 'resync', audience: collapsed, gm: false });
    for (const r of revealed) this.bus.publish(campaignId, { kind: 'block-revealed', pageId: r.pageId, blockIds: r.blockIds, audience: r.audience, gm: true });
  }
}
