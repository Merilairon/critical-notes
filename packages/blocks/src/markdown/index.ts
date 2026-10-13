/**
 * Block Documents as Markdown, for AI assistants (the MCP server). `docToMarkdown` writes the dialect,
 * `markdownToDoc` reads it back and merges it with the version it was made from, so whatever the model did
 * not touch (and every block Markdown can't express) survives exactly.
 */
import { SCHEMA_VERSION, type BlockDocument } from '../doc';
import { sanitizeDoc } from '../sanitize';
import { parseMarkdown, type FromMarkdownOptions } from './from-markdown';
import { reconcile } from './reconcile';

export { blocksToMarkdown, docToMarkdown, OPAQUE_TYPES, type ToMarkdownOptions } from './to-markdown';
export { parseMarkdown, type FromMarkdownOptions, type PageResolution } from './from-markdown';
export { blockKey, reconcile } from './reconcile';

/** Markdown → Block Document, merged with `opts.base` when given. Warnings say what could not be kept as written. */
export function markdownToDoc(markdown: string, opts: FromMarkdownOptions = {}): { doc: BlockDocument; warnings: string[] } {
  const parsed = parseMarkdown(markdown, opts);
  const content = opts.base ? reconcile(opts.base.content ?? [], parsed.blocks) : parsed.blocks;
  // Template content carries variable bindings in attributes; the template service validates it
  if (opts.mode === 'template') return { doc: { type: 'doc', schemaVersion: SCHEMA_VERSION, content }, warnings: parsed.warnings };
  const { doc, issues } = sanitizeDoc({ type: 'doc', schemaVersion: SCHEMA_VERSION, content });
  return { doc, warnings: [...parsed.warnings, ...issues] };
}
