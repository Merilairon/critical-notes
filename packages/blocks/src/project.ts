/**
 * Visibility projection: the server runs every page body through this before sending it to a player.
 * DM-only blocks (and secret blocks) that are not revealed are removed with their whole subtree; block
 * types can further transform nodes (e.g. links to pages the player cannot see become plain text).
 */
import type { BlockDocument, BlockNode } from './doc';
import { blockType, type ProjectContext } from './registry';

export function isHiddenFromPlayers(node: BlockNode): boolean {
  const def = blockType(node.type);
  if (!def || def.kind === 'text') return false;
  const revealed = node.attrs?.revealed === true;
  if (def.secretByDefault) return !revealed;
  return node.attrs?.visibility === 'dm' && !revealed;
}

function projectNodes(nodes: BlockNode[] | undefined, ctx: ProjectContext): BlockNode[] {
  const out: BlockNode[] = [];
  for (const node of nodes ?? []) {
    if (isHiddenFromPlayers(node)) continue;
    const def = blockType(node.type);
    // Unknown types never reach players (they might hide anything)
    if (!def) continue;
    let projected: BlockNode | null = node;
    if (def.project) projected = def.project(node, ctx);
    if (!projected) continue;
    if (projected.content) projected = { ...projected, content: projectNodes(projected.content, ctx) };
    out.push(projected);
  }
  return out;
}

export function projectDoc(doc: BlockDocument | null | undefined, ctx: ProjectContext): BlockDocument | null {
  if (!doc) return doc ?? null;
  if (ctx.role === 'dm') return doc;
  return { ...doc, content: projectNodes(doc.content, ctx) };
}

/** True if the player projection drops this node (and its subtree). */
export function droppedForPlayers(node: BlockNode, ctx: ProjectContext): boolean {
  if (isHiddenFromPlayers(node)) return true;
  const def = blockType(node.type);
  if (!def) return true;
  return def.kind === 'block' && !!def.project && def.project(node, ctx) === null;
}

const isBlockList = (nodes: BlockNode[]) => nodes.some((n) => blockType(n.type)?.kind === 'block');

/** Hidden blocks inside a visible block (not descending into the hidden ones). */
function hiddenDescendants(node: BlockNode, ctx: ProjectContext): BlockNode[] {
  return (node.content ?? []).flatMap((c) => (droppedForPlayers(c, ctx) ? [c] : hiddenDescendants(c, ctx)));
}

/** Puts back the links to hidden pages that the player only saw as their label text, if that text is still there. */
function restoreHiddenLinks(before: BlockNode, n: BlockNode, ctx: ProjectContext): BlockNode {
  let content = n.content ?? [];
  for (const link of before.content ?? []) {
    if (link.type !== 'pageLink' || ctx.canSeePage(String(link.attrs?.pageId))) continue;
    const label = String(link.attrs?.label ?? '');
    const i = label ? content.findIndex((c) => c.type === 'text' && !c.marks?.length && c.text?.includes(label)) : -1;
    if (i < 0) continue;
    const t = content[i]!;
    const at = t.text!.indexOf(label);
    const parts = [{ ...t, text: t.text!.slice(0, at) }, link, { ...t, text: t.text!.slice(at + label.length) }].filter((x) => x.type !== 'text' || x.text);
    content = [...content.slice(0, i), ...parts, ...content.slice(i + 1)];
  }
  return { ...n, content };
}

function mergeLevel(stored: BlockNode[], submitted: BlockNode[], ctx: ProjectContext): BlockNode[] {
  // Blocks the player never saw, keyed by the id of the visible block they followed ('' = the start)
  const anchored = new Map<string, BlockNode[]>();
  const anchorOf = new Map<BlockNode, string>();
  const visibleById = new Map<string, BlockNode>();
  let anchor = '';
  for (const n of stored) {
    if (droppedForPlayers(n, ctx)) {
      anchored.set(anchor, [...(anchored.get(anchor) ?? []), n]);
      anchorOf.set(n, anchor);
      continue;
    }
    const id = n.attrs?.id;
    if (typeof id === 'string' && id) {
      anchor = id;
      visibleById.set(id, n);
    }
  }
  const submittedIds = new Set(submitted.map((n) => n.attrs?.id).filter((id): id is string => typeof id === 'string' && !!id));
  const out: BlockNode[] = [...(anchored.get('') ?? [])];
  const placed = new Set(['']);
  for (const n of submitted) {
    const id = typeof n.attrs?.id === 'string' ? n.attrs.id : '';
    const before = id ? visibleById.get(id) : undefined;
    // Containers the player edited keep their hidden children too
    let merged = n;
    if (before && JSON.stringify(projectNodes([before], ctx)) === JSON.stringify([n])) merged = before;
    else if (before?.content && n.content) merged = isBlockList(before.content) ? { ...n, content: mergeLevel(before.content, n.content, ctx) } : restoreHiddenLinks(before, n, ctx);
    out.push(merged);
    if (id && anchored.has(id) && !placed.has(id)) {
      out.push(...anchored.get(id)!);
      placed.add(id);
    }
  }
  // Nothing hidden is ever lost: blocks whose neighbour the player deleted, and hidden blocks inside
  // visible blocks the player deleted, go to the end (in their original order)
  for (const n of stored) {
    if (anchorOf.has(n)) {
      if (!placed.has(anchorOf.get(n)!)) out.push(n);
      continue;
    }
    const id = n.attrs?.id;
    if (typeof id === 'string' && id && !submittedIds.has(id)) out.push(...hiddenDescendants(n, ctx));
  }
  return out;
}

/**
 * Applies a player's edit of a page they may edit (their own character) without losing what they cannot
 * see: blocks hidden from them are put back after the visible block they followed, at every nesting level
 * (blocks are matched by id). The player only ever received the projection, so they could not have
 * edited those blocks.
 */
export function mergePlayerEdit(stored: BlockDocument | null, submitted: BlockDocument, ctx: ProjectContext): BlockDocument {
  if (!stored?.content?.length) return submitted;
  return { ...submitted, content: mergeLevel(stored.content, submitted.content ?? [], ctx) };
}
