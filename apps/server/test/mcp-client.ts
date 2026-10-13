/** An MCP client talking to the app in-process (the real protocol, through `/mcp`). */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { TestApp, TestClient } from './helpers';

export interface ToolResult {
  isError: boolean;
  /** Everything the tool returned, as text. */
  text: string;
  /** The tool's JSON (its first text part), when it succeeded. */
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  markdown: string | undefined;
}

export async function mcpClient(app: TestApp, token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: async (url, init) => app.request(String(url), init),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const res = await client.callTool({ name, arguments: args });
  const parts = ((res.content ?? []) as { type: string; text?: string }[]).filter((p) => p.type === 'text').map((p) => p.text ?? '');
  const isError = !!res.isError;
  return { isError, text: parts.join('\n'), data: isError ? null : JSON.parse(parts[0] ?? 'null'), markdown: parts[1] };
}

/** Makes an API token for the signed-in user of `client`. */
export async function makeToken(client: TestClient, scope: 'read' | 'write' = 'write', name = 'test'): Promise<string> {
  const res = await client.post('/api/auth/tokens', { name, scope, expiresInDays: 30 });
  if (res.status !== 201) throw new Error(`token: ${res.status} ${JSON.stringify(res.body)}`);
  return (res.body as { token: string }).token;
}
