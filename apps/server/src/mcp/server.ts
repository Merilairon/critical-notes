/** The MCP server for one request: the tools a token may use, acting as its user. */
import { McpServer } from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import type { AppEnv, InternalAuth } from '../auth/session';
import { Api } from './api';
import { INSTRUCTIONS } from './instructions';
import { campaignTools } from './tools/campaign';
import { libraryTools } from './tools/library';
import { pageTools } from './tools/pages';
import { playTools } from './tools/play';
import { Tools } from './tools';

export const MCP_SERVER_NAME = 'critical-notes';

export function buildMcpServer(app: Hono<AppEnv>, auth: InternalAuth): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, title: 'Critical Notes', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const tools = new Tools(server, new Api(app, auth), auth.scope === 'write');
  campaignTools(tools);
  pageTools(tools);
  playTools(tools);
  libraryTools(tools);
  return server;
}
