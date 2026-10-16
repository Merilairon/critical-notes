/**
 * User administration (Task M2.4, design: docs/design/accounts.md 4.1, 4.3 to 4.5, 4.7).
 *
 * Transaction rules: every write an admin triggers runs in ONE synchronous transaction (the callback is never
 * async, so nothing can interleave with it in this single-writer process) whose first statement re-reads the
 * acting admin (`assertActor`): the middleware's earlier check is stale after the awaited password check.
 * If Postgres is ever used at runtime, `assertNotLastAdmin` needs `SELECT ... FOR UPDATE` on the admin rows
 * or serializable isolation.
 */
import { randomBytes } from 'node:crypto';
import { and, count, eq, gt, inArray, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';
import type { AdminUserDto, DeleteUserInput, OwnedCampaignDto, ResetInfoDto, ResetLinkDto } from '@cn/shared';
import { hashToken } from '../auth/session';
import type { AppDb } from '../db';
import { apiTokens, campaignInvites, campaignMembers, campaigns, homebrewSources, passwordResets, sessions, users } from '../db/schema';
import { audit } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/http';
import { newId } from '../lib/ids';
import { verifyPassword } from '../lib/password';

type Tx = Parameters<Parameters<AppDb['transaction']>[0]>[0];
type Db = AppDb | Tx;

export const RESET_TTL_MS = 24 * 60 * 60 * 1000;

/** The link format lives here only, so the admin route and the command line cannot diverge. */
export const resetUrl = (baseUrl: string, token: string) => `${baseUrl.replace(/\/+$/, '')}/reset#${token}`;

export interface CreatedResetLink extends ResetLinkDto {
  /** How many still-open links of that user this one replaced. */
  superseded: number;
}

/**
 * Issues a single-use reset link for a user. Pure service function (no Hono context), reused by the CLI with
 * `createdBy = null`. The token is returned once and only its hash is stored. A newer link supersedes the
 * user's open ones. `guard` runs first inside the transaction (the admin path re-checks the actor there).
 */
export function createResetLink(
  db: AppDb,
  userId: string,
  createdBy: string | null,
  baseUrl: string,
  opts: { revokeTokens?: boolean; guard?: (tx: Tx) => void; now?: number } = {},
): CreatedResetLink {
  const token = randomBytes(32).toString('base64url');
  const now = opts.now ?? Date.now();
  const expiresAt = now + RESET_TTL_MS;
  const superseded = db.transaction((tx) => {
    opts.guard?.(tx);
    const user = tx.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw notFound('User not found');
    if (user.disabledAt !== null) throw conflict('Enable the account first');
    const old = tx.update(passwordResets).set({ usedAt: now }).where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt))).run().changes;
    if (opts.revokeTokens) tx.update(apiTokens).set({ revokedAt: now }).where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt))).run();
    tx.insert(passwordResets).values({ id: newId(), userId, tokenHash: hashToken(token), createdBy, expiresAt }).run();
    return old;
  });
  return { url: resetUrl(baseUrl, token), expiresAt, superseded };
}

/** The reset link a token names, only while it is live: unused, unexpired, and its user enabled. Read-only. */
export function findLiveReset(db: Db, token: string, now = Date.now()): (ResetInfoDto & { userId: string }) | null {
  const row = db
    .select({ userId: users.id, username: users.username, displayName: users.displayName, expiresAt: passwordResets.expiresAt })
    .from(passwordResets)
    .innerJoin(users, eq(users.id, passwordResets.userId))
    .where(and(eq(passwordResets.tokenHash, hashToken(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, now), isNull(users.disabledAt)))
    .get();
  return row ?? null;
}

class ResetLost extends Error {}

/**
 * Consumes a live link and sets the new password, in ONE synchronous transaction (design 4.1 step 6d).
 * The conditional UPDATE is the single-use gate: exactly one concurrent caller sees `changes === 1`.
 * Returns the user id, or null when the link was lost (raced, expired meanwhile, user disabled meanwhile);
 * nothing is changed in that case, so a failed reset does not burn the link. Ends all of the user's sessions
 * and the session row of the incoming cookie (it may belong to someone else signed in on this browser).
 */
export function redeemReset(db: AppDb, token: string, passwordHash: string, incomingSessionId?: string, now = Date.now()): string | null {
  const th = hashToken(token);
  try {
    return db.transaction((tx) => {
      const row = tx.select({ userId: passwordResets.userId }).from(passwordResets).where(eq(passwordResets.tokenHash, th)).get();
      const used = tx
        .update(passwordResets)
        .set({ usedAt: now })
        .where(and(eq(passwordResets.tokenHash, th), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, now)))
        .run().changes;
      if (used !== 1 || !row) throw new ResetLost();
      const u = tx.select({ d: users.disabledAt }).from(users).where(eq(users.id, row.userId)).get();
      if (!u || u.d !== null) throw new ResetLost();
      tx.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, row.userId)).run();
      tx.delete(sessions).where(eq(sessions.userId, row.userId)).run();
      if (incomingSessionId) tx.delete(sessions).where(eq(sessions.id, incomingSessionId)).run();
      tx.update(passwordResets).set({ usedAt: now }).where(and(eq(passwordResets.userId, row.userId), isNull(passwordResets.usedAt))).run();
      return row.userId;
    });
  } catch (e) {
    if (e instanceof ResetLost) return null;
    throw e;
  }
}

/** Start-up housekeeping: expired and used (consumed or superseded) reset rows. */
export function purgeOldResets(db: AppDb, now = Date.now()) {
  db.delete(passwordResets).where(or(lt(passwordResets.expiresAt, now), isNotNull(passwordResets.usedAt))).run();
}

/** Refuses when `userId` is an enabled admin and no OTHER enabled admin exists. Call inside the transaction. */
export function assertNotLastAdmin(tx: Db, userId: string) {
  const target = tx.select({ a: users.isAdmin, d: users.disabledAt }).from(users).where(eq(users.id, userId)).get();
  if (!target || !target.a || target.d !== null) return;
  const others = tx.select({ n: count() }).from(users).where(and(eq(users.isAdmin, true), isNull(users.disabledAt), ne(users.id, userId))).get()?.n ?? 0;
  if (others === 0) throw conflict('There must be at least one admin');
}

/** First statement of every admin write: the actor must still be an enabled admin. */
function assertActor(tx: Db, actorId: string) {
  const a = tx.select({ a: users.isAdmin, d: users.disabledAt }).from(users).where(eq(users.id, actorId)).get();
  if (!a || !a.a || a.d !== null) throw forbidden('Admins only');
}

type UserRow = typeof users.$inferSelect;

export class UserAdminService {
  constructor(private readonly db: AppDb) {}

  private dto(u: UserRow, owned: number): AdminUserDto {
    return { id: u.id, username: u.username, displayName: u.displayName, isAdmin: u.isAdmin, disabledAt: u.disabledAt, createdAt: u.createdAt, ownedCampaignCount: owned };
  }

  private ownedCount(userId: string): number {
    return this.db.select({ n: count() }).from(campaignMembers).where(and(eq(campaignMembers.userId, userId), eq(campaignMembers.role, 'dm'))).get()?.n ?? 0;
  }

  private user(db: Db, id: string): UserRow {
    const u = db.select().from(users).where(eq(users.id, id)).get();
    if (!u) throw notFound('User not found');
    return u;
  }

  list(): AdminUserDto[] {
    const owned = new Map(
      this.db
        .select({ userId: campaignMembers.userId, n: count() })
        .from(campaignMembers)
        .where(eq(campaignMembers.role, 'dm'))
        .groupBy(campaignMembers.userId)
        .all()
        .map((r) => [r.userId, r.n]),
    );
    return this.db
      .select()
      .from(users)
      .all()
      .sort((a, b) => a.username.localeCompare(b.username))
      .map((u) => this.dto(u, owned.get(u.id) ?? 0));
  }

  /** Step-up: the acting admin's own password, checked before the (synchronous) write transaction. */
  async verifyActorPassword(actorId: string, password: string): Promise<boolean> {
    const a = this.db.select({ h: users.passwordHash }).from(users).where(eq(users.id, actorId)).get();
    if (!a) throw unauthorized();
    return verifyPassword(a.h, password);
  }

  ownedCampaigns(userId: string): OwnedCampaignDto[] {
    this.user(this.db, userId);
    return this.ownedRows(this.db, userId).map((c) => ({
      campaignId: c.id,
      name: c.name,
      members: this.db
        .select({ userId: users.id, displayName: users.displayName, role: campaignMembers.role, disabledAt: users.disabledAt })
        .from(campaignMembers)
        .innerJoin(users, eq(users.id, campaignMembers.userId))
        .where(eq(campaignMembers.campaignId, c.id))
        .all()
        .map(({ disabledAt, ...m }) => ({ ...m, disabled: disabledAt !== null })),
    }));
  }

  private ownedRows(db: Db, userId: string) {
    return db
      .select({ id: campaigns.id, name: campaigns.name })
      .from(campaignMembers)
      .innerJoin(campaigns, eq(campaigns.id, campaignMembers.campaignId))
      .where(and(eq(campaignMembers.userId, userId), eq(campaignMembers.role, 'dm')))
      .all();
  }

  createResetLink(actorId: string, targetId: string, baseUrl: string, revokeTokens: boolean, ip?: string): ResetLinkDto {
    const target = this.user(this.db, targetId);
    const r = createResetLink(this.db, targetId, actorId, baseUrl, { revokeTokens, guard: (tx) => assertActor(tx, actorId) });
    audit('reset_link.created', { actor: actorId, target: targetId, targetIsAdmin: target.isAdmin, createdBy: actorId, revokeTokens, ip });
    if (r.superseded > 0) audit('reset_link.superseded', { actor: actorId, target: targetId, targetIsAdmin: target.isAdmin, count: r.superseded, ip });
    return { url: r.url, expiresAt: r.expiresAt };
  }

  /** Disable/enable and grant/revoke admin in one transaction. */
  update(actorId: string, targetId: string, change: { disabled?: boolean; isAdmin?: boolean; confirmed?: boolean }, ip?: string): AdminUserDto {
    const events: string[] = [];
    const before = this.db.transaction((tx) => {
      assertActor(tx, actorId);
      const t = this.user(tx, targetId);
      const nextDisabled = change.disabled === undefined ? t.disabledAt !== null : change.disabled;
      const nextAdmin = change.isAdmin ?? t.isAdmin;
      // Enabling an admin restores admin powers, so it needs the step-up password like the other protected actions.
      if (t.disabledAt !== null && !nextDisabled && nextAdmin && !change.confirmed) throw badRequest('Enter your password to enable an admin account');
      if (nextDisabled && t.disabledAt === null && targetId === actorId) throw conflict('You cannot disable your own account');
      const wasEnabledAdmin = t.isAdmin && t.disabledAt === null;
      if (wasEnabledAdmin && (!nextAdmin || nextDisabled)) assertNotLastAdmin(tx, targetId);
      const now = Date.now();
      const set: Partial<typeof users.$inferInsert> = {};
      if (nextAdmin !== t.isAdmin) {
        set.isAdmin = nextAdmin;
        events.push(nextAdmin ? 'admin.granted' : 'admin.revoked');
      }
      if (nextDisabled && t.disabledAt === null) {
        set.disabledAt = now;
        events.push('user.disabled');
        tx.delete(sessions).where(eq(sessions.userId, targetId)).run();
        tx.update(apiTokens).set({ revokedAt: now }).where(and(eq(apiTokens.userId, targetId), isNull(apiTokens.revokedAt))).run();
        tx.update(passwordResets).set({ usedAt: now }).where(and(eq(passwordResets.userId, targetId), isNull(passwordResets.usedAt))).run();
      } else if (!nextDisabled && t.disabledAt !== null) {
        set.disabledAt = null;
        events.push('user.enabled');
      }
      if (Object.keys(set).length) tx.update(users).set({ ...set, updatedAt: now }).where(eq(users.id, targetId)).run();
      return t;
    });
    for (const e of events) audit(e, { actor: actorId, target: targetId, targetIsAdmin: before.isAdmin, ip });
    return this.dto(this.user(this.db, targetId), this.ownedCount(targetId));
  }

  /** Deletes a user, resolving every campaign they own as the plan says (D5 option C). */
  remove(actorId: string, targetId: string, plan: DeleteUserInput['campaigns'], ip?: string) {
    const result = this.db.transaction((tx) => {
      assertActor(tx, actorId);
      const t = this.user(tx, targetId);
      if (targetId === actorId) throw conflict('You cannot delete your own account');
      assertNotLastAdmin(tx, targetId);
      const owned = this.ownedRows(tx, targetId);
      const ownedIds = new Set(owned.map((c) => c.id));
      const planned = new Map<string, DeleteUserInput['campaigns'][number]>();
      for (const p of plan) {
        if (planned.has(p.campaignId)) throw badRequest('A campaign appears twice in the plan', { duplicate: p.campaignId });
        planned.set(p.campaignId, p);
      }
      const missing = owned.filter((c) => !planned.has(c.id)).map((c) => ({ campaignId: c.id, name: c.name }));
      const extra = [...planned.keys()].filter((id) => !ownedIds.has(id));
      if (missing.length || extra.length) throw badRequest('Choose what happens to every campaign this user owns', { missing, extra });
      const now = Date.now();
      for (const c of owned) {
        const p = planned.get(c.id)!;
        if (p.action === 'transfer') {
          if (p.toUserId === targetId) throw badRequest('Transfer to someone else', { campaignId: c.id });
          const m = tx.select().from(campaignMembers).where(and(eq(campaignMembers.campaignId, c.id), eq(campaignMembers.userId, p.toUserId))).get();
          if (!m) throw badRequest('The new owner must be a member of the campaign', { campaignId: c.id });
          const to = tx.select({ d: users.disabledAt }).from(users).where(eq(users.id, p.toUserId)).get();
          if (!to || to.d !== null) throw badRequest('The new owner\'s account is disabled; choose an active member', { campaignId: c.id });
          tx.update(campaignMembers).set({ role: 'dm' }).where(and(eq(campaignMembers.campaignId, c.id), eq(campaignMembers.userId, p.toUserId))).run();
          tx.update(homebrewSources).set({ ownerUserId: p.toUserId, updatedAt: now }).where(and(eq(homebrewSources.campaignId, c.id), eq(homebrewSources.scope, 'campaign'))).run();
        } else {
          const co = tx.select({ n: count() }).from(campaignMembers).where(and(eq(campaignMembers.campaignId, c.id), eq(campaignMembers.role, 'codm'))).get()?.n ?? 0;
          if (co === 0) throw badRequest('A campaign without a co-DM cannot be archived; transfer it, or disable the user instead', { campaignId: c.id });
          tx.update(campaigns).set({ status: 'archived', updatedAt: now }).where(eq(campaigns.id, c.id)).run();
        }
      }
      // Their open invites would lose their creator; nobody could manage them.
      tx.update(campaignInvites).set({ revokedAt: now }).where(and(eq(campaignInvites.createdBy, targetId), isNull(campaignInvites.revokedAt))).run();
      // Shared homebrew keeps working under the acting admin. Private sources and user templates stay ownerless (invisible).
      tx.update(homebrewSources).set({ ownerUserId: actorId, updatedAt: now }).where(and(eq(homebrewSources.ownerUserId, targetId), inArray(homebrewSources.scope, ['campaigns', 'instance']))).run();
      tx.delete(users).where(eq(users.id, targetId)).run();
      return { isAdmin: t.isAdmin, username: t.username };
    });
    audit('user.deleted', {
      actor: actorId,
      target: targetId,
      targetUsername: result.username,
      targetIsAdmin: result.isAdmin,
      plan: plan.map((p) => (p.action === 'transfer' ? { campaignId: p.campaignId, action: p.action, toUserId: p.toUserId } : { campaignId: p.campaignId, action: p.action })),
      ip,
    });
  }
}
