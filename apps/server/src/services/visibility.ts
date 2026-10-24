/**
 * Who may see which page. Game masters (owner DM and co-DMs) see everything; a player sees pages shared
 * with all players, pages shared with them by name ("selected"), and the characters assigned to them.
 * Every endpoint that returns campaign content asks this service before answering a player.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { isGameMaster, type CampaignRole } from '@cn/shared';
import type { AppDb } from '../db';
import { characterFacets, pages, pageViewers } from '../db/schema';

export interface Viewer {
  userId: string;
  role: CampaignRole;
  /** Owner DM or co-DM. */
  gm: boolean;
}

export const viewerOf = (userId: string, role: CampaignRole): Viewer => ({ userId, role, gm: isGameMaster(role) });

export class VisibilityService {
  constructor(private readonly db: AppDb) {}

  /** Characters assigned to this user in the campaign (they may see and edit them). */
  ownCharacterIds(campaignId: string, userId: string): Set<string> {
    return new Set(
      this.db
        .select({ id: characterFacets.pageId })
        .from(characterFacets)
        .innerJoin(pages, eq(pages.id, characterFacets.pageId))
        .where(and(eq(characterFacets.playerUserId, userId), eq(pages.campaignId, campaignId), isNull(pages.deletedAt)))
        .all()
        .map((r) => r.id),
    );
  }

  /** Ids of the live pages the viewer may see. */
  visiblePageIds(campaignId: string, viewer: Viewer): Set<string> {
    const live = this.db
      .select({ id: pages.id, visibility: pages.visibility })
      .from(pages)
      .where(and(eq(pages.campaignId, campaignId), isNull(pages.deletedAt)))
      .all();
    if (viewer.gm) return new Set(live.map((p) => p.id));
    const selected = new Set(
      this.db
        .select({ id: pageViewers.pageId })
        .from(pageViewers)
        .innerJoin(pages, eq(pages.id, pageViewers.pageId))
        .where(and(eq(pageViewers.userId, viewer.userId), eq(pages.campaignId, campaignId)))
        .all()
        .map((r) => r.id),
    );
    const own = this.ownCharacterIds(campaignId, viewer.userId);
    return new Set(live.filter((p) => p.visibility === 'all' || (p.visibility === 'selected' && selected.has(p.id)) || own.has(p.id)).map((p) => p.id));
  }

  /**
   * Whether the viewer may see one page right now: the same answer as `visiblePageIds(...).has(pageId)`, in one or two indexed
   * lookups instead of loading the whole campaign (the event stream asks once per recipient per event).
   */
  canSee(campaignId: string, viewer: Viewer, pageId: string): boolean {
    const page = this.db
      .select({ visibility: pages.visibility })
      .from(pages)
      .where(and(eq(pages.id, pageId), eq(pages.campaignId, campaignId), isNull(pages.deletedAt)))
      .get();
    if (!page) return false;
    if (viewer.gm || page.visibility === 'all') return true;
    if (page.visibility === 'selected') {
      const row = this.db
        .select({ id: pageViewers.pageId })
        .from(pageViewers)
        .where(and(eq(pageViewers.pageId, pageId), eq(pageViewers.userId, viewer.userId)))
        .get();
      if (row) return true;
    }
    return !!this.db
      .select({ id: characterFacets.pageId })
      .from(characterFacets)
      .where(and(eq(characterFacets.pageId, pageId), eq(characterFacets.playerUserId, viewer.userId)))
      .get();
  }

  /** Game masters edit everything; players only the characters assigned to them. */
  canEdit(campaignId: string, viewer: Viewer, pageId: string): boolean {
    return viewer.gm || this.ownCharacterIds(campaignId, viewer.userId).has(pageId);
  }
}
