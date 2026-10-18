import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, ne } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { UserDto } from '@cn/shared';
import type { AppDb } from '../db';
import { sessions, users } from '../db/schema';
import { forbidden, unauthorized } from '../lib/http';

export const SESSION_COOKIE = 'cn_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

export type SessionUser = UserDto;

export interface AppEnv {
  Variables: {
    user: SessionUser | null;
    /** Set for calls made on behalf of an API token (the MCP server); read tokens may not write. */
    tokenScope?: 'read' | 'write';
    /** Stored id of the browser session behind this request (the token hash); unset for API tokens and anonymous calls. */
    sessionId?: string;
  };
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Marks an in-process call made by the MCP server for a token's user (`app.request(path, init, internalAuth(...))`).
 * The symbol never crosses HTTP: requests from the network carry the Node request objects in their env.
 */
export const INTERNAL_AUTH = Symbol('cn.internalAuth');
export interface InternalAuth {
  userId: string;
  scope: 'read' | 'write';
}
export const internalAuth = (auth: InternalAuth) => ({ [INTERNAL_AUTH]: auth });

export function createSession(db: AppDb, c: Context, userId: string, secure: boolean) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.insert(sessions).values({ id: hashToken(token), userId, expiresAt }).run();
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure, path: '/', expires: new Date(expiresAt) });
}

/** Deletes the user's sessions, optionally keeping one (by stored id, i.e. the token hash). */
export function endUserSessions(db: AppDb, userId: string, exceptSessionId?: string) {
  db.delete(sessions)
    .where(exceptSessionId ? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId)) : eq(sessions.userId, userId))
    .run();
}

export function destroySession(db: AppDb, c: Context) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) db.delete(sessions).where(eq(sessions.id, hashToken(token))).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

/** Loads the user for the session cookie (if any) and slides the expiry. */
export function sessionMiddleware(db: AppDb, secure: boolean): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('user', null);
    const internal = (c.env as Record<symbol, InternalAuth | undefined> | undefined)?.[INTERNAL_AUTH];
    if (internal) {
      const user = db.select().from(users).where(eq(users.id, internal.userId)).get();
      if (!user || user.disabledAt !== null) throw unauthorized();
      if (internal.scope === 'read' && !['GET', 'HEAD'].includes(c.req.method)) throw forbidden('This token can only read; create a read & write token to make changes');
      c.set('user', { id: user.id, username: user.username, displayName: user.displayName, isAdmin: user.isAdmin });
      c.set('tokenScope', internal.scope);
      return next();
    }
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      const id = hashToken(token);
      const now = Date.now();
      const row = db
        .select({ user: users, expiresAt: sessions.expiresAt })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.id, id), gt(sessions.expiresAt, now), isNull(users.disabledAt)))
        .get();
      if (row) {
        c.set('user', { id: row.user.id, username: row.user.username, displayName: row.user.displayName, isAdmin: row.user.isAdmin });
        c.set('sessionId', id);
        if (row.expiresAt - now < SESSION_TTL_MS - RENEW_AFTER_MS) {
          const expiresAt = now + SESSION_TTL_MS;
          db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id)).run();
          setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure, path: '/', expires: new Date(expiresAt) });
        }
      } else {
        deleteCookie(c, SESSION_COOKIE, { path: '/' });
      }
    }
    await next();
  };
}

export function purgeExpiredSessions(db: AppDb) {
  db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) throw unauthorized();
  await next();
};

/** Account routes need a browser session: an API token (MCP) never changes account details. */
export const rejectTokenScope: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('tokenScope')) throw forbidden('API tokens cannot change account details');
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user) throw unauthorized();
  // Even an admin's API token never runs admin actions (the MCP allowlist already excludes them).
  if (c.get('tokenScope')) throw forbidden('API tokens cannot do admin actions');
  if (!user.isAdmin) throw forbidden('Admins only');
  await next();
};

/**
 * CSRF defence for cookie auth: state-changing requests must come from our own origin and carry JSON
 * (cross-site HTML forms cannot send application/json without a CORS preflight).
 */
export function originCheck(allowedOrigins: string[]): MiddlewareHandler {
  const allowed = new Set(allowedOrigins.map((o) => o.replace(/\/$/, '')));
  return async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin) {
        let sameHost: boolean;
        try {
          sameHost = new URL(origin).host === c.req.header('host');
        } catch {
          sameHost = false;
        }
        if (!sameHost && !allowed.has(origin)) throw forbidden('Cross-origin request rejected');
      }
      const type = c.req.header('content-type') ?? '';
      const length = Number(c.req.header('content-length') ?? '0');
      const hasBody = length > 0 || !!c.req.header('transfer-encoding');
      if (hasBody && !type.includes('application/json') && !type.includes('multipart/form-data')) throw forbidden('Unsupported content type');
    }
    await next();
  };
}
