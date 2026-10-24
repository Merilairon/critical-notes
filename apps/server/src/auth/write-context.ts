import type { Context } from 'hono';
import { contextFor, type RevisionCause, type WriteContext, type WriteOrigin } from '../services/revisions';
import type { AppEnv } from './session';

/**
 * Where a page write came from, taken from the request and never from anything the client sends: an MCP call (`tokenScope` is
 * set, with its token id) is `mcp` whatever the token owner's role; otherwise `player` when `asPlayer`, else `web`.
 */
export function writeOrigin(c: Context<AppEnv>, asPlayer = false): WriteOrigin {
  if (c.get('tokenScope')) return { source: 'mcp', ...(c.get('tokenId') ? { tokenId: c.get('tokenId') } : {}) };
  return { source: asPlayer ? 'player' : 'web' };
}

/** The `WriteContext` of the signed-in user's page write. */
export function writeContext(c: Context<AppEnv>, cause: RevisionCause, asPlayer = false, extra: Pick<WriteContext, 'restoredFrom' | 'operationId'> = {}): WriteContext {
  return contextFor(c.get('user')!.id, writeOrigin(c, asPlayer), cause, extra);
}
