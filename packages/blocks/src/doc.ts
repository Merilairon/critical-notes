/**
 * Block Document v1: ProseMirror-compatible JSON of the app's own schema.
 *
 *   { "type": "doc", "schemaVersion": 1, "content": [Block…] }
 *   Block  = { type, attrs?: { id, visibility, revealed, …typeAttrs }, content?: (Block | Inline)[] }
 *   Inline = text (with marks) | pageLink | tag | placeholder | hardBreak
 */

export const SCHEMA_VERSION = 1;

export interface Mark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface BlockNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: BlockNode[];
  marks?: Mark[];
  text?: string;
}

export interface BlockDocument {
  type: 'doc';
  schemaVersion?: number;
  content?: BlockNode[];
}

export type Visibility = 'inherit' | 'dm';

export const emptyDoc = (): BlockDocument => ({ type: 'doc', schemaVersion: SCHEMA_VERSION, content: [{ type: 'paragraph' }] });

export function isBlockNode(v: unknown): v is BlockNode {
  return !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as BlockNode).type === 'string';
}

/** Depth-first walk; return false from the visitor to skip a node's children. */
export function walk(nodes: BlockNode[] | undefined, visit: (node: BlockNode, parent: BlockNode | null) => boolean | void, parent: BlockNode | null = null) {
  for (const node of nodes ?? []) {
    if (visit(node, parent) === false) continue;
    if (node.content) walk(node.content, visit, node);
  }
}

/** Collects every node of the given types (including nested). */
export function findNodes(doc: BlockDocument | null | undefined, types: string[]): BlockNode[] {
  const out: BlockNode[] = [];
  walk(doc?.content, (n) => {
    if (types.includes(n.type)) out.push(n);
  });
  return out;
}
