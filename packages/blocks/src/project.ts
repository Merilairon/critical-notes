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

/** Puts back the links to hidden pages that the player only saw as their label text, if that text is still there (marked or not; the occurrence nearest to where the link was). */
function restoreHiddenLinks(before: BlockNode, n: BlockNode, ctx: ProjectContext): BlockNode {
  const hidden = (c: BlockNode) => c.type === 'pageLink' && !ctx.canSeePage(String(c.attrs?.pageId));
  // Length each node had in the text the player saw (a hidden link was its label, other inline nodes count 1)
  const seenLength = (c: BlockNode) => (c.type === 'text' ? (c.text ?? '').length : hidden(c) ? String(c.attrs?.label ?? '').length : 1);
  let content = n.content ?? [];
  let seenAt = 0;
  for (const link of before.content ?? []) {
    if (!hidden(link)) {
      seenAt += seenLength(link);
      continue;
    }
    const was = seenAt;
    seenAt += seenLength(link);
    const label = String(link.attrs?.label ?? '');
    const flat = content.map((c) => (c.type === 'text' ? (c.text ?? '') : '\0')).join('');
    let at = -1;
    for (let i = label ? flat.indexOf(label) : -1; i >= 0; i = flat.indexOf(label, i + 1)) if (at < 0 || Math.abs(i - was) < Math.abs(at - was)) at = i;
    if (at < 0) continue;
    const end = at + label.length;
    const next: BlockNode[] = [];
    let pos = 0;
    let placed = false;
    for (const c of content) {
      const start = pos;
      pos += c.type === 'text' ? (c.text ?? '').length : 1;
      if (c.type !== 'text' || pos <= at || start >= end) {
        next.push(c);
        continue;
      }
      const left = c.text!.slice(0, Math.max(at - start, 0));
      const right = c.text!.slice(end - start);
      if (left) next.push({ ...c, text: left });
      if (!placed) next.push(c.marks?.length ? { ...link, marks: c.marks } : link);
      placed = true;
      if (right) next.push({ ...c, text: right });
    }
    content = next;
  }
  return { ...n, content };
}

/** A player cannot reveal anything: a block they author never arrives revealed (children included). */
function clearRevealed(node: BlockNode): BlockNode {
  const attrs = node.attrs?.revealed ? { ...node.attrs, revealed: false } : node.attrs;
  const out = attrs === node.attrs ? node : { ...node, attrs };
  return out.content ? { ...out, content: out.content.map(clearRevealed) } : out;
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
  const usedIds = new Set<string>();
  const out: BlockNode[] = [...(anchored.get('') ?? [])];
  const placed = new Set(['']);
  for (let n of submitted) {
    let id = typeof n.attrs?.id === 'string' ? n.attrs.id : '';
    if (id && usedIds.has(id)) {
      const { id: _dropped, ...attrs } = n.attrs!;
      n = { ...n, attrs };
      id = '';
    }
    if (id) usedIds.add(id);
    const before = id ? visibleById.get(id) : undefined;
    // Containers the player edited keep their hidden children too
    let merged = n;
    if (before && JSON.stringify(projectNodes([before], ctx)) === JSON.stringify([n])) merged = before;
    else if (before?.content && isBlockList(before.content)) merged = { ...n, content: mergeLevel(before.content, n.content ?? [], ctx) };
    else if (before) {
      // No stored blocks to match against (inline content, or an empty container): everything the player added is new, so it starts unrevealed
      const restored = before.content ? restoreHiddenLinks(before, n, ctx) : n;
      merged = restored.content ? { ...restored, content: restored.content.map(clearRevealed) } : restored;
    }
    // Block types put back what their own projection took out (a query block's DM-only columns)
    if (before && merged !== before) merged = blockType(n.type)?.restoreHidden?.(before, merged, ctx) ?? merged;
    // Players cannot change `revealed`: a stored block keeps its flag, a new block starts unrevealed
    if (!before) merged = clearRevealed(merged);
    else if (!!merged.attrs?.revealed !== !!before.attrs?.revealed) merged = { ...merged, attrs: { ...merged.attrs, revealed: !!before.attrs?.revealed } };
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
export function mergePlayerEdit(stored: BlockDocument | null, submittedDoc: BlockDocument, ctx: ProjectContext): BlockDocument {
  // A link the player submits to a page they cannot see is forged (they never received such a link): keep its label as text.
  // The DM's own links come back from the stored block in restoreHiddenLinks.
  const flattenHiddenLinks = (node: BlockNode): BlockNode[] => {
    if (node.type === 'pageLink' && !ctx.canSeePage(String(node.attrs?.pageId))) {
      const text = String(node.attrs?.label ?? '');
      return text ? [{ type: 'text', text }] : [];
    }
    return [node.content ? { ...node, content: node.content.flatMap(flattenHiddenLinks) } : node];
  };
  const submitted = { ...submittedDoc, content: submittedDoc.content?.flatMap(flattenHiddenLinks) };
  if (!stored?.content?.length) return { ...submitted, content: submitted.content?.map(clearRevealed) };
  // The player never held an id of a block they cannot see, so any submitted block carrying one (at any depth) gets a new id on save
  const hiddenIds = new Set<string>();
  const collectAll = (node: BlockNode) => {
    if (typeof node.attrs?.id === 'string') hiddenIds.add(node.attrs.id);
    node.content?.forEach(collectAll);
  };
  const collectHidden = (node: BlockNode) => (droppedForPlayers(node, ctx) ? collectAll(node) : node.content?.forEach(collectHidden));
  stored.content.forEach(collectHidden);
  const stripHidden = (node: BlockNode): BlockNode => {
    let out = node;
    if (typeof node.attrs?.id === 'string' && hiddenIds.has(node.attrs.id)) {
      const { id: _dropped, ...attrs } = node.attrs;
      out = { ...node, attrs };
    }
    return out.content ? { ...out, content: out.content.map(stripHidden) } : out;
  };
  return { ...submitted, content: mergeLevel(stored.content, (submitted.content ?? []).map(stripHidden), ctx) };
}
