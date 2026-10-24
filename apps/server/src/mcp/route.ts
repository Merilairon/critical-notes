/**
 * `/mcp`: the MCP endpoint (Streamable HTTP) for AI assistants. A personal API token (`Authorization: Bearer
 * cn_…`) is required; it is the only place tokens are accepted.
 */
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import type { AppEnv } from '../auth/session';
import type { ApiTokenService } from '../services/api-tokens';
import { buildMcpServer } from './server';

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return '';
  }
};

export function mcpRoutes(deps: { app: Hono<AppEnv>; tokens: ApiTokenService; publicUrl: string }) {
  const handler = createMcpHandler((ctx) => {
    const extra = ctx.authInfo?.extra as { userId: string; scope: 'read' | 'write'; tokenId: string } | undefined;
    // The route below only serves requests with a verified token
    if (!extra) throw new Error('Missing authentication');
    return buildMcpServer(deps.app, { userId: extra.userId, scope: extra.scope, tokenId: extra.tokenId });
  });
  const publicOrigin = new URL(deps.publicUrl).origin;
  const route = new Hono<AppEnv>();
  route.all('/', async (c) => {
    // Browsers on other sites may not drive the endpoint (DNS rebinding, stolen tabs)
    const origin = c.req.header('origin');
    if (origin && hostOf(origin) !== c.req.header('host') && origin !== publicOrigin) return c.json({ error: 'Cross-origin request rejected' }, 403);
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const verified = token ? deps.tokens.verify(token) : null;
    if (!token || !verified) {
      return c.json({ error: 'An API token is required (Authorization: Bearer cn_…). Make one in Critical Notes under Account → AI assistants.' }, 401, {
        'WWW-Authenticate': 'Bearer realm="critical-notes"',
      });
    }
    return handler.fetch(c.req.raw, {
      authInfo: { token, clientId: verified.tokenId, scopes: [verified.scope], extra: { userId: verified.user.id, scope: verified.scope, tokenId: verified.tokenId } },
    });
  });
  return route;
}
