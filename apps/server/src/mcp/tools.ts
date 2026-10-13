/** Registering tools: read tools for every token, write tools only for read & write tokens; errors as tool results. */
import type { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { ApiError, type Api } from './api';

/** A mistake the model can fix (wrong input, a page that changed since it was read…). */
export class ToolError extends Error {}

/** What a tool returns: JSON-able data, optionally followed by Markdown shown as-is. */
export interface ToolOutput {
  data: unknown;
  markdown?: string;
}

type Run<S extends z.ZodObject> = (args: z.infer<S>) => Promise<ToolOutput>;

export class Tools {
  constructor(
    private readonly server: McpServer,
    readonly api: Api,
    readonly canWrite: boolean,
  ) {}

  /** A tool that only looks things up. */
  read<S extends z.ZodObject>(name: string, title: string, description: string, input: S, run: Run<S>) {
    this.register(name, title, description, input, run, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  }

  /** A tool that changes something (left out for read-only tokens). */
  write<S extends z.ZodObject>(name: string, title: string, description: string, input: S, run: Run<S>, opts: { destructive?: boolean; idempotent?: boolean } = {}) {
    if (!this.canWrite) return;
    this.register(name, title, description, input, run, { readOnlyHint: false, destructiveHint: !!opts.destructive, idempotentHint: !!opts.idempotent, openWorldHint: false });
  }

  private register<S extends z.ZodObject>(name: string, title: string, description: string, input: S, run: Run<S>, annotations: Record<string, boolean>) {
    this.server.registerTool(name, { title, description, inputSchema: input, annotations }, (async (args: z.infer<S>) => {
      try {
        const out = await run(args);
        return {
          content: [
            { type: 'text', text: JSON.stringify(out.data, null, 2) },
            ...(out.markdown !== undefined ? [{ type: 'text', text: out.markdown }] : []),
          ],
        };
      } catch (err) {
        if (err instanceof ApiError || err instanceof ToolError) return { isError: true, content: [{ type: 'text', text: err.message }] };
        throw err;
      }
    }) as never);
  }
}
