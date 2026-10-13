/** Plain text, page links and entity references from a Block Document. */
import { findEntityRefs, parseEntityTag, splitTagArgs, stripTags, entityUid, type EntityKind } from '@cn/fivetools';
import { walk, type BlockDocument, type BlockNode } from './doc';
import { isHiddenFromPlayers } from './project';
import { blockType } from './registry';

const BLOCK_SEPARATOR_TYPES = new Set(['paragraph', 'heading', 'listItem', 'taskItem', 'tableCell', 'tableHeader', 'detailsSummary', 'tab']);

function nodeText(node: BlockNode, mode: 'dm' | 'player'): string {
  if (mode === 'player' && isHiddenFromPlayers(node)) return '';
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'tag') return stripTags(String(node.attrs?.markup ?? ''));
  const def = blockType(node.type);
  if (def?.text) return def.text(node);
  const inner = (node.content ?? []).map((c) => nodeText(c, mode)).join(def?.kind === 'block' ? '' : '');
  return BLOCK_SEPARATOR_TYPES.has(node.type) ? `${inner}\n` : inner;
}

/** Text for search indexing. `player` mode skips DM-only and secret blocks. */
export function docText(doc: BlockDocument | null | undefined, mode: 'dm' | 'player' = 'dm', maxLength = 50_000): string {
  return (doc?.content ?? [])
    .map((n) => nodeText(n, mode))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

export interface DocLinks {
  /** Pages referenced by `[[links]]` and page embeds. */
  pages: { pageId: string; kind: 'mention' | 'embed' }[];
  /** Reference entities referenced by inline tags and embeds. */
  entities: { uid: string; kind: EntityKind | string; via: 'tag' | 'embed' }[];
}

export function docLinks(doc: BlockDocument | null | undefined): DocLinks {
  const pages = new Map<string, 'mention' | 'embed'>();
  const entities = new Map<string, { uid: string; kind: string; via: 'tag' | 'embed' }>();
  walk(doc?.content, (node) => {
    if (node.type === 'pageLink' && typeof node.attrs?.pageId === 'string') {
      if (!pages.has(node.attrs.pageId)) pages.set(node.attrs.pageId, 'mention');
    } else if (node.type === 'pageEmbed' && typeof node.attrs?.pageId === 'string') {
      pages.set(node.attrs.pageId, 'embed');
    } else if (node.type === 'tag' && typeof node.attrs?.markup === 'string') {
      for (const ref of findEntityRefs(node.attrs.markup)) entities.set(ref.uid, { uid: ref.uid, kind: ref.kind, via: 'tag' });
    } else if (node.type === 'refEmbed' && typeof node.attrs?.uid === 'string') {
      entities.set(node.attrs.uid, { uid: node.attrs.uid, kind: String(node.attrs.kind ?? ''), via: 'embed' });
    } else if (node.type === 'text' && node.text?.includes('{@')) {
      // Raw markup typed as text still counts as a reference
      for (const ref of findEntityRefs(node.text)) entities.set(ref.uid, { uid: ref.uid, kind: ref.kind, via: 'tag' });
    }
  });
  return { pages: [...pages].map(([pageId, kind]) => ({ pageId, kind })), entities: [...entities.values()] };
}

/** Resolves an inline tag's markup to the entity it links (if any). */
export function tagEntity(markup: string): { uid: string; kind: EntityKind } | null {
  const m = /^\{@([A-Za-z0-9_]+)\s([\s\S]*)\}$/.exec(markup);
  if (!m) return null;
  const parsed = parseEntityTag(m[1]!, splitTagArgs(m[2]!));
  return parsed ? { uid: entityUid(parsed.kind, parsed.identity), kind: parsed.kind } : null;
}
