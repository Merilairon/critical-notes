/** Personal API tokens: made and revoked by their user, used by AI assistants on the MCP endpoint. */
import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, or, count } from 'drizzle-orm';
import type { ApiTokenDto, ApiTokenScope, CreateApiTokenInput, CreatedApiTokenDto } from '@cn/shared';
import { hashToken, type SessionUser } from '../auth/session';
import type { AppDb } from '../db';
import { apiTokens, users } from '../db/schema';
import { badRequest, notFound } from '../lib/http';
import { newId } from '../lib/ids';

export const MAX_ACTIVE_TOKENS = 20;
const TOKEN_PREFIX = 'cn_';
const DAY_MS = 24 * 60 * 60 * 1000;
/** `last_used_at` is written at most this often. */
const TOUCH_EVERY_MS = 60_000;

type Row = typeof apiTokens.$inferSelect;

const dto = (r: Row): ApiTokenDto => ({ id: r.id, name: r.name, scope: r.scope as ApiTokenScope, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, expiresAt: r.expiresAt });

export interface VerifiedToken {
  tokenId: string;
  user: SessionUser;
  scope: ApiTokenScope;
}

export class ApiTokenService {
  constructor(private readonly db: AppDb) {}

  /** The user's tokens that are not revoked (expired ones included, so they can be cleaned up). */
  list(userId: string): ApiTokenDto[] {
    return this.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
      .all()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(dto);
  }

  create(userId: string, input: CreateApiTokenInput): CreatedApiTokenDto {
    const now = Date.now();
    const active =
      this.db
        .select({ n: count() })
        .from(apiTokens)
        .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now))))
        .get()?.n ?? 0;
    if (active >= MAX_ACTIVE_TOKENS) throw badRequest(`You have ${MAX_ACTIVE_TOKENS} active tokens; revoke one first`);
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const row: Row = {
      id: newId(),
      userId,
      name: input.name,
      tokenHash: hashToken(token),
      scope: input.scope,
      createdAt: now,
      lastUsedAt: null,
      expiresAt: input.expiresInDays === null ? null : now + input.expiresInDays * DAY_MS,
      revokedAt: null,
    };
    this.db.insert(apiTokens).values(row).run();
    return { ...dto(row), token };
  }

  revoke(userId: string, id: string) {
    const res = this.db
      .update(apiTokens)
      .set({ revokedAt: Date.now() })
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
      .run();
    if (!res.changes) throw notFound('Token not found');
  }

  /** The user and scope for a token, or null when it is unknown, revoked or expired. */
  verify(token: string): VerifiedToken | null {
    if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
    const row = this.db.select({ token: apiTokens, user: users }).from(apiTokens).innerJoin(users, eq(users.id, apiTokens.userId)).where(eq(apiTokens.tokenHash, hashToken(token))).get();
    const now = Date.now();
    if (!row || row.token.revokedAt !== null || (row.token.expiresAt !== null && row.token.expiresAt <= now) || row.user.disabledAt !== null) return null;
    if (row.token.lastUsedAt === null || now - row.token.lastUsedAt > TOUCH_EVERY_MS) {
      this.db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.token.id)).run();
    }
    const u = row.user;
    return { tokenId: row.token.id, scope: row.token.scope as ApiTokenScope, user: { id: u.id, username: u.username, displayName: u.displayName, isAdmin: u.isAdmin } };
  }
}
