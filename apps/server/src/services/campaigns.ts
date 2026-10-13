import { createHash, randomBytes } from 'node:crypto';
import { and, count, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { makePolicy, type CampaignPolicy, type RulesetId } from '@cn/fivetools';
import {
  createInviteInput,
  isGameMaster,
  type CampaignDto,
  type CampaignRole,
  type CampaignSummaryDto,
  type CreateCampaignInput,
  type CreatedInviteDto,
  type CreateInviteInput,
  type InviteDto,
  type InviteInfoDto,
  type MemberDto,
  type UpdateCampaignInput,
} from '@cn/shared';
import type { AppDb } from '../db';
import { campaignInvites, campaignMembers, campaigns, campaignSourceOverrides, characterFacets, homebrewSources, homebrewSourceShares, pages, users } from '../db/schema';
import { badRequest, forbidden, notFound } from '../lib/http';
import { viewerOf, type Viewer } from './visibility';
import { newId } from '../lib/ids';
import type { HomebrewIndex } from '../reference/homebrew-index';

export interface CampaignAccess {
  campaign: typeof campaigns.$inferSelect;
  role: CampaignRole;
}

export class CampaignService {
  constructor(
    private readonly db: AppDb,
    private readonly homebrewIndex: HomebrewIndex,
    private readonly onSourcesChanged: () => void,
  ) {}

  /** Membership check; throws 404 for non-members so campaign ids do not leak. */
  access(campaignId: string, userId: string): CampaignAccess {
    const row = this.db
      .select({ campaign: campaigns, role: campaignMembers.role })
      .from(campaigns)
      .innerJoin(campaignMembers, and(eq(campaignMembers.campaignId, campaigns.id), eq(campaignMembers.userId, userId)))
      .where(eq(campaigns.id, campaignId))
      .get();
    if (!row) throw notFound('Campaign not found');
    return { campaign: row.campaign, role: row.role as CampaignRole };
  }

  /** Owner DM or co-DM. */
  requireDm(campaignId: string, userId: string): CampaignAccess {
    const access = this.access(campaignId, userId);
    if (!isGameMaster(access.role)) throw forbidden('Only the DM can do that');
    return access;
  }

  /** The campaign's owner (members, roles, edition changes). */
  requireOwner(campaignId: string, userId: string): CampaignAccess {
    const access = this.access(campaignId, userId);
    if (access.role !== 'dm') throw forbidden("Only the campaign's owner can do that");
    return access;
  }

  viewer(campaignId: string, userId: string): Viewer {
    return viewerOf(userId, this.access(campaignId, userId).role);
  }

  list(userId: string): CampaignSummaryDto[] {
    const rows = this.db
      .select({ campaign: campaigns, role: campaignMembers.role })
      .from(campaigns)
      .innerJoin(campaignMembers, and(eq(campaignMembers.campaignId, campaigns.id), eq(campaignMembers.userId, userId)))
      .orderBy(sql`${campaigns.updatedAt} desc`)
      .all();
    const counts = new Map(
      this.db
        .select({ campaignId: pages.campaignId, n: count() })
        .from(pages)
        .where(isNull(pages.deletedAt))
        .groupBy(pages.campaignId)
        .all()
        .map((r) => [r.campaignId, r.n]),
    );
    return rows.map(({ campaign: c, role }) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      ruleset: c.ruleset as RulesetId,
      status: c.status as 'active' | 'archived',
      role: role as CampaignRole,
      pageCount: counts.get(c.id) ?? 0,
      updatedAt: c.updatedAt,
    }));
  }

  create(userId: string, input: CreateCampaignInput & { description: string; crossEdition: boolean }): CampaignDto {
    const id = newId();
    const now = Date.now();
    const sourceRow = this.newCampaignSource(id, input.name, userId);
    this.db.transaction((tx) => {
      tx.insert(campaigns)
        .values({ id, name: input.name, description: input.description, ruleset: input.ruleset, crossEdition: input.crossEdition, createdBy: userId, createdAt: now, updatedAt: now })
        .run();
      tx.insert(campaignMembers).values({ campaignId: id, userId, role: 'dm' }).run();
      tx.insert(homebrewSources).values(sourceRow).run();
    });
    this.homebrewIndex.upsertSource({ ...sourceRow, color: null });
    this.onSourcesChanged();
    return this.get(id, userId);
  }

  /** Every campaign gets a hidden homebrew source for quick, campaign-only content (e.g. customized NPCs). */
  private newCampaignSource(campaignId: string, name: string, userId: string): typeof homebrewSources.$inferInsert {
    let jsonId: string;
    do {
      jsonId = `Camp${randomBytes(4).toString('hex')}`;
    } while (this.homebrewIndex.isOfficialSource(jsonId) || this.db.select().from(homebrewSources).where(eq(homebrewSources.jsonIdLower, jsonId.toLowerCase())).get());
    return {
      id: newId(),
      jsonId,
      jsonIdLower: jsonId.toLowerCase(),
      abbreviation: 'Campaign',
      fullName: `${name} (campaign)`,
      edition: 'any',
      scope: 'campaign',
      ownerUserId: userId,
      campaignId,
    };
  }

  campaignSource(campaignId: string) {
    return this.db
      .select()
      .from(homebrewSources)
      .where(and(eq(homebrewSources.campaignId, campaignId), eq(homebrewSources.scope, 'campaign'), isNull(homebrewSources.deletedAt)))
      .get();
  }

  get(campaignId: string, userId: string): CampaignDto {
    const { campaign: c, role } = this.access(campaignId, userId);
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      ruleset: c.ruleset as RulesetId,
      crossEdition: c.crossEdition,
      status: c.status as 'active' | 'archived',
      coverImage: c.coverImage,
      houseRules: c.houseRules ?? null,
      role,
      sourceOverrides: Object.fromEntries(this.overrides(c.id)),
      campaignSourceId: this.campaignSource(c.id)?.jsonId ?? null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  update(campaignId: string, userId: string, input: UpdateCampaignInput): CampaignDto {
    this.requireDm(campaignId, userId);
    const patch: Partial<typeof campaigns.$inferInsert> = { updatedAt: Date.now() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.crossEdition !== undefined) patch.crossEdition = input.crossEdition;
    if (input.houseRules !== undefined) patch.houseRules = input.houseRules;
    if (input.coverImage !== undefined) patch.coverImage = input.coverImage;
    if (input.status !== undefined) patch.status = input.status;
    this.db.transaction((tx) => {
      tx.update(campaigns).set(patch).where(eq(campaigns.id, campaignId)).run();
      for (const [sourceId, enabled] of Object.entries(input.sourceOverrides ?? {})) {
        const key = sourceId.toLowerCase();
        if (enabled === null) {
          tx.delete(campaignSourceOverrides).where(and(eq(campaignSourceOverrides.campaignId, campaignId), eq(campaignSourceOverrides.sourceId, key))).run();
        } else {
          tx.insert(campaignSourceOverrides)
            .values({ campaignId, sourceId: key, enabled })
            .onConflictDoUpdate({ target: [campaignSourceOverrides.campaignId, campaignSourceOverrides.sourceId], set: { enabled } })
            .run();
        }
      }
    });
    return this.get(campaignId, userId);
  }

  private overrides(campaignId: string): [string, boolean][] {
    return this.db
      .select()
      .from(campaignSourceOverrides)
      .where(eq(campaignSourceOverrides.campaignId, campaignId))
      .all()
      .map((o) => [o.sourceId, o.enabled]);
  }

  /** Homebrew sources a campaign may use: its own, shared with it, and instance-wide ones. */
  homebrewSourceIds(campaignId: string): string[] {
    const shared = this.db.select({ id: homebrewSourceShares.sourceId }).from(homebrewSourceShares).where(eq(homebrewSourceShares.campaignId, campaignId)).all();
    const rows = this.db
      .select({ jsonId: homebrewSources.jsonId })
      .from(homebrewSources)
      .where(
        and(
          isNull(homebrewSources.deletedAt),
          or(
            eq(homebrewSources.campaignId, campaignId),
            eq(homebrewSources.scope, 'instance'),
            shared.length ? inArray(homebrewSources.id, shared.map((s) => s.id)) : sql`0`,
          ),
        ),
      )
      .all();
    return rows.map((r) => r.jsonId);
  }

  /**
   * The campaign's rules for a member. Players do not get the campaign-only homebrew source: it holds the DM's
   * customized statblocks. Homebrew meant for players goes in a source shared with the campaign.
   */
  policy(campaignId: string, userId: string): CampaignPolicy {
    const { campaign, role } = this.access(campaignId, userId);
    const own = isGameMaster(role) ? null : this.campaignSource(campaignId)?.jsonId.toLowerCase();
    return makePolicy(campaign.ruleset as RulesetId, {
      crossEdition: campaign.crossEdition,
      sourceOverrides: this.overrides(campaignId),
      homebrewSources: this.homebrewSourceIds(campaignId).filter((id) => id.toLowerCase() !== own),
    });
  }

  // region Members

  members(campaignId: string, userId: string): MemberDto[] {
    this.access(campaignId, userId);
    const chars = this.db
      .select({ userId: characterFacets.playerUserId, pageId: pages.id, title: pages.title })
      .from(characterFacets)
      .innerJoin(pages, eq(pages.id, characterFacets.pageId))
      .where(and(eq(pages.campaignId, campaignId), isNull(pages.deletedAt)))
      .all();
    return this.db
      .select({ userId: users.id, displayName: users.displayName, role: campaignMembers.role, joinedAt: campaignMembers.joinedAt })
      .from(campaignMembers)
      .innerJoin(users, eq(users.id, campaignMembers.userId))
      .where(eq(campaignMembers.campaignId, campaignId))
      .all()
      .map((m) => ({
        ...m,
        role: m.role as CampaignRole,
        characters: chars.filter((c) => c.userId === m.userId).map((c) => ({ pageId: c.pageId, title: c.title })),
      }))
      .sort((a, b) => ['dm', 'codm', 'player'].indexOf(a.role) - ['dm', 'codm', 'player'].indexOf(b.role) || a.displayName.localeCompare(b.displayName));
  }

  setRole(campaignId: string, userId: string, memberId: string, role: 'codm' | 'player') {
    this.requireOwner(campaignId, userId);
    const member = this.access(campaignId, memberId);
    if (member.role === 'dm') throw badRequest("The owner's role cannot change");
    this.db.update(campaignMembers).set({ role }).where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.userId, memberId))).run();
  }

  /** The owner removes someone, or a member leaves. Their characters stay, unassigned. */
  removeMember(campaignId: string, userId: string, memberId: string) {
    if (memberId !== userId) this.requireOwner(campaignId, userId);
    const member = this.access(campaignId, memberId);
    if (member.role === 'dm') throw badRequest('The owner cannot leave their campaign');
    this.db.transaction((tx) => {
      tx.delete(campaignMembers).where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.userId, memberId))).run();
      const ids = tx.select({ id: pages.id }).from(pages).where(eq(pages.campaignId, campaignId)).all().map((p) => p.id);
      if (ids.length) tx.update(characterFacets).set({ playerUserId: null }).where(and(eq(characterFacets.playerUserId, memberId), inArray(characterFacets.pageId, ids))).run();
    });
  }

  isMember(campaignId: string, userId: string): boolean {
    return !!this.db.select({ r: campaignMembers.role }).from(campaignMembers).where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.userId, userId))).get();
  }

  // endregion

  // region Invites

  private static hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private inviteDto(r: typeof campaignInvites.$inferSelect): InviteDto {
    return { id: r.id, role: r.role as InviteDto['role'], createdAt: r.createdAt, expiresAt: r.expiresAt, maxUses: r.maxUses, uses: r.uses, revoked: !!r.revokedAt };
  }

  /** Game masters invite players; only the owner invites co-DMs. */
  createInvite(campaignId: string, userId: string, input: CreateInviteInput): CreatedInviteDto {
    const v = createInviteInput.parse(input);
    if (v.role === 'codm') this.requireOwner(campaignId, userId);
    else this.requireDm(campaignId, userId);
    const token = randomBytes(24).toString('base64url');
    const id = newId();
    this.db
      .insert(campaignInvites)
      .values({
        id,
        campaignId,
        tokenHash: CampaignService.hash(token),
        role: v.role,
        createdBy: userId,
        expiresAt: v.expiresInDays ? Date.now() + v.expiresInDays * 86_400_000 : null,
        maxUses: v.maxUses,
      })
      .run();
    return { invite: this.inviteDto(this.db.select().from(campaignInvites).where(eq(campaignInvites.id, id)).get()!), token };
  }

  invites(campaignId: string, userId: string): InviteDto[] {
    this.requireDm(campaignId, userId);
    return this.db
      .select()
      .from(campaignInvites)
      .where(eq(campaignInvites.campaignId, campaignId))
      .orderBy(sql`${campaignInvites.createdAt} desc`)
      .all()
      .map((r) => this.inviteDto(r));
  }

  revokeInvite(campaignId: string, userId: string, inviteId: string) {
    this.requireDm(campaignId, userId);
    this.db
      .update(campaignInvites)
      .set({ revokedAt: Date.now() })
      .where(and(eq(campaignInvites.id, inviteId), eq(campaignInvites.campaignId, campaignId)))
      .run();
  }

  private inviteByToken(token: string) {
    return this.db.select().from(campaignInvites).where(eq(campaignInvites.tokenHash, CampaignService.hash(token))).get();
  }

  private inviteProblem(r: typeof campaignInvites.$inferSelect): string | null {
    if (r.revokedAt) return 'This invite was withdrawn';
    if (r.expiresAt && r.expiresAt < Date.now()) return 'This invite has expired';
    if (r.maxUses !== null && r.uses >= r.maxUses) return 'This invite has been used up';
    return null;
  }

  /** What an invite link leads to (shown before signing in). */
  inviteInfo(token: string, userId: string | null): InviteInfoDto {
    const r = this.inviteByToken(token);
    if (!r) throw notFound('This invite link is not valid');
    const campaign = this.db.select({ name: campaigns.name }).from(campaigns).where(eq(campaigns.id, r.campaignId)).get();
    if (!campaign) throw notFound('This invite link is not valid');
    const reason = this.inviteProblem(r);
    return { campaignName: campaign.name, role: r.role as InviteInfoDto['role'], valid: !reason, reason, alreadyMember: !!userId && this.isMember(r.campaignId, userId) };
  }

  /** Joins the campaign with the invite's role (members keep their current role). Returns the campaign id. */
  acceptInvite(token: string, userId: string): string {
    const r = this.inviteByToken(token);
    if (!r) throw notFound('This invite link is not valid');
    if (this.isMember(r.campaignId, userId)) return r.campaignId;
    const problem = this.inviteProblem(r);
    if (problem) throw badRequest(problem);
    this.db.transaction((tx) => {
      tx.insert(campaignMembers).values({ campaignId: r.campaignId, userId, role: r.role }).run();
      tx.update(campaignInvites).set({ uses: r.uses + 1 }).where(eq(campaignInvites.id, r.id)).run();
    });
    return r.campaignId;
  }

  /** Checked before creating an account for an invite. */
  assertInviteUsable(token: string) {
    const r = this.inviteByToken(token);
    if (!r) throw notFound('This invite link is not valid');
    const problem = this.inviteProblem(r);
    if (problem) throw badRequest(problem);
  }

  // endregion

  touch(campaignId: string) {
    this.db.update(campaigns).set({ updatedAt: Date.now() }).where(eq(campaigns.id, campaignId)).run();
  }
}
