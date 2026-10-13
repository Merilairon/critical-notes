/**
 * Merges blocks parsed from Markdown with the version they were made from, so a rewrite through Markdown
 * changes only what was changed: unchanged blocks are kept as they were (id, alignment, underline,
 * highlight…), and a changed block keeps its id and the attributes Markdown can't express. Kept ids are what
 * lets a player's save leave the blocks they can't see in place (`mergePlayerEdit`).
 */
import { splitByTags } from '@cn/fivetools';
import type { BlockNode, Mark } from '../doc';
import { blockType } from '../registry';
import { sanitizeDoc } from '../sanitize';
import { edgeSpaceOutside, isUnrepresented } from './to-markdown';

/** Attributes Markdown does not carry (kept from the previous version when a block is edited). */
const UNEXPRESSED: Record<string, string[]> = {
  paragraph: ['textAlign'],
  image: ['style'],
  tableCell: ['colwidth'],
  tableHeader: ['colwidth'],
};
const UNEXPRESSED_MARKS = new Set(['underline', 'highlight']);
/** Above this many comparisons, matching falls back to a greedy scan. */
const LCS_LIMIT = 4_000_000;

/** What a block says, ignoring what Markdown can't express: equal keys mean an unchanged block. */
export function blockKey(block: BlockNode): string {
  const { doc } = sanitizeDoc({ type: 'doc', content: [block] });
  return JSON.stringify(normalize(doc.content?.[0]));
}

function normalize(node: BlockNode | undefined): unknown {
  if (!node) return null;
  if (node.type === 'text') return { t: node.text, m: (node.marks ?? []).filter((m) => !UNEXPRESSED_MARKS.has(m.type)).map(markKey) };
  const attrs = { ...node.attrs };
  delete attrs['id'];
  for (const k of UNEXPRESSED[node.type] ?? []) delete attrs[k];
  // Empty paragraphs don't show in Markdown, so they don't make a block different
  return { type: node.type, attrs, content: node.content ? splitTextTags(node.content).filter((c) => !isUnrepresented(c)).map(normalize) : undefined };
}

const markKey = (m: Mark) => (m.type === 'link' ? `link:${String(m.attrs?.['href'] ?? '')}` : m.type);

/** Tags typed as text count the same as tag nodes; neighbouring texts with the same marks are one text. */
function splitTextTags(nodes: BlockNode[]): BlockNode[] {
  const out: BlockNode[] = [];
  for (const node of nodes) {
    const parts =
      node.type === 'text' && !(node.marks ?? []).some((m) => m.type === 'code')
        ? splitByTags(node.text ?? '').flatMap((p): BlockNode[] =>
            p.startsWith('{@') && p.endsWith('}')
              ? [{ type: 'tag', attrs: { markup: p } }]
              : edgeSpaceOutside(p, node.marks ?? []).map(([text, marks]) => ({ type: 'text', text, marks })),
          )
        : [node];
    for (const part of parts) {
      const prev = out[out.length - 1];
      const marks = (n: BlockNode) => JSON.stringify((n.marks ?? []).filter((m) => !UNEXPRESSED_MARKS.has(m.type)).map(markKey));
      if (prev?.type === 'text' && part.type === 'text' && marks(prev) === marks(part)) out[out.length - 1] = { ...prev, text: (prev.text ?? '') + (part.text ?? '') };
      else if (part.type !== 'text' || part.text) out.push(part);
    }
  }
  return out;
}

/** Pairs of equal keys (old index, new index), in order: longest common subsequence. */
function matchKeys(a: string[], b: string[]): [number, number][] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const mid = A.length * B.length <= LCS_LIMIT ? lcs(A, B) : greedy(A, B);
  return [
    ...Array.from({ length: pre }, (_, i): [number, number] => [i, i]),
    ...mid.map(([i, j]): [number, number] => [i + pre, j + pre]),
    ...Array.from({ length: suf }, (_, k): [number, number] => [a.length - suf + k, b.length - suf + k]),
  ];
}

function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const len = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i * width + j] = a[i] === b[j] ? len[(i + 1) * width + j + 1]! + 1 : Math.max(len[(i + 1) * width + j]!, len[i * width + j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (len[(i + 1) * width + j]! >= len[i * width + j + 1]!) i++;
    else j++;
  }
  return pairs;
}

function greedy(a: string[], b: string[]): [number, number][] {
  const positions = new Map<string, number[]>();
  a.forEach((k, i) => positions.set(k, [...(positions.get(k) ?? []), i]));
  const pairs: [number, number][] = [];
  let last = -1;
  b.forEach((k, j) => {
    const i = positions.get(k)?.find((p) => p > last);
    if (i !== undefined) {
      pairs.push([i, j]);
      last = i;
    }
  });
  return pairs;
}

const hasBlockContent = (type: string) => {
  const rule = blockType(type)?.content;
  return rule === 'blocks' || (typeof rule === 'object' && rule !== null);
};

/** An edited block: the new content, with the old id and the attributes Markdown does not carry. */
function merge(old: BlockNode, next: BlockNode): BlockNode {
  const attrs = { ...old.attrs, ...next.attrs };
  const content = next.content && old.content && hasBlockContent(next.type) ? reconcile(old.content, next.content) : next.content;
  return { ...next, attrs, ...(content ? { content } : {}) };
}

/**
 * Merges `next` (parsed from Markdown) into `base` (what that Markdown was made from), level by level.
 * Blocks Markdown doesn't show (empty paragraphs) stay after the block they followed.
 */
export function reconcile(base: BlockNode[], next: BlockNode[]): BlockNode[] {
  const shown: BlockNode[] = [];
  const after = new Map<number, BlockNode[]>();
  for (const block of base) {
    if (isUnrepresented(block)) after.set(shown.length - 1, [...(after.get(shown.length - 1) ?? []), block]);
    else shown.push(block);
  }
  const oldKeys = shown.map(blockKey);
  const newKeys = next.map(blockKey);
  const pairs = matchKeys(oldKeys, newKeys);
  const from = new Map<number, number>(pairs.map(([i, j]) => [j, i]));
  const used = new Set(pairs.map(([i]) => i));
  // Unchanged blocks that moved are the same blocks too
  const unused = new Map<string, number[]>();
  oldKeys.forEach((k, i) => {
    if (!used.has(i)) unused.set(k, [...(unused.get(k) ?? []), i]);
  });
  newKeys.forEach((k, j) => {
    const i = from.has(j) ? undefined : unused.get(k)?.shift();
    if (i !== undefined) {
      from.set(j, i);
      used.add(i);
    }
  });
  const kept = new Set(from.keys());
  // Between two blocks kept in order, edited blocks pair with old blocks of the same type, in order
  const bounds: [number, number][] = [[-1, -1], ...pairs, [shown.length, next.length]];
  for (let g = 0; g + 1 < bounds.length; g++) {
    const [i0, j0] = bounds[g]!;
    const [i1, j1] = bounds[g + 1]!;
    let cursor = i0 + 1;
    for (let j = j0 + 1; j < j1; j++) {
      if (from.has(j)) continue;
      let i = cursor;
      while (i < i1 && (used.has(i) || shown[i]!.type !== next[j]!.type)) i++;
      if (i < i1) {
        from.set(j, i);
        used.add(i);
        cursor = i + 1;
      }
    }
  }
  const out: BlockNode[] = [...(after.get(-1) ?? [])];
  next.forEach((block, j) => {
    const i = from.get(j);
    if (i === undefined) {
      out.push(block);
      return;
    }
    out.push(kept.has(j) ? shown[i]! : merge(shown[i]!, block));
    out.push(...(after.get(i) ?? []));
  });
  return out;
}
