/**
 * Markdown → blocks (the dialect `to-markdown.ts` writes). Never throws: anything it can't use is kept as
 * text, and every such decision is reported as a warning.
 */
import type { Image, List, Nodes, PhrasingContent, RootContent, Table } from 'mdast';
import { directiveFromMarkdown, type ContainerDirective, type LeafDirective } from 'mdast-util-directive';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { directive } from 'micromark-extension-directive';
import { gfm } from 'micromark-extension-gfm';
import { walk, type BlockDocument, type BlockNode, type Mark } from '../doc';
import { protect, restoreText, splitTokens, type Token } from './protect';
import { PLACEHOLDER_PREFIX } from './to-markdown';

export type PageResolution = { pageId: string; label: string } | { error: string };

export interface FromMarkdownOptions {
  mode?: 'page' | 'template';
  /** The document the Markdown was made from: placeholders and template fields are taken from it. */
  base?: BlockDocument | null;
  /** Resolves `[[Title]]` (by exact title) or `[[page:<id>|Label]]`; null when there is no such page. */
  resolvePage?(ref: { id?: string; title?: string; label?: string }): PageResolution | null;
}

const CALLOUT_TONES = new Set(['note', 'info', 'tip', 'warning', 'danger']);
const SAFE_URL = /^(https?:|mailto:|\/)/i;
const PLACEHOLDER_RE = new RegExp(`^<!--\\s*${PLACEHOLDER_PREFIX}\\s+(@?[\\w.-]+)`);
const UPLOAD_RE = /^\/api\/uploads\/([0-9a-f-]{36})$/;

/** A block with its visibility spelled out (so merging with an older version never keeps a stale value). */
const blk = (type: string, attrs: Record<string, unknown> = {}, content?: BlockNode[]): BlockNode => ({
  type,
  attrs: { visibility: 'inherit', revealed: false, ...attrs },
  ...(content ? { content } : {}),
});

class Reader {
  readonly warnings: string[] = [];
  private readonly byId = new Map<string, BlockNode>();
  private readonly fields = new Map<string, BlockNode>();

  constructor(
    private readonly source: string,
    private readonly tokens: Token[],
    private readonly opts: FromMarkdownOptions,
  ) {
    walk(opts.base?.content, (n) => {
      if (typeof n.attrs?.id === 'string' && n.attrs.id) this.byId.set(n.attrs.id, n);
      if (n.type === 'placeholder' && typeof n.attrs?.name === 'string') this.fields.set(n.attrs.name, n);
    });
  }

  private warn(message: string) {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  private slice(node: Nodes): string {
    const { start, end } = node.position ?? {};
    return start?.offset !== undefined && end?.offset !== undefined ? this.source.slice(start.offset, end.offset) : '';
  }

  flow(nodes: RootContent[]): BlockNode[] {
    return nodes.flatMap((n) => this.block(n));
  }

  private block(node: RootContent): BlockNode[] {
    switch (node.type) {
      case 'paragraph': {
        const kids = node.children.filter((c) => !(c.type === 'text' && !c.value.trim()));
        if (kids.length === 1 && kids[0]!.type === 'image') return [this.image(kids[0]!)];
        const content = this.inline(node.children);
        return content.length ? [blk('paragraph', {}, content)] : [];
      }
      case 'heading':
        if (node.depth > 4) this.warn('Headings go down to level 4 (####); deeper ones became level 4');
        return [blk('heading', { level: Math.min(node.depth, 4) }, this.inline(node.children))];
      case 'thematicBreak':
        return [blk('horizontalRule')];
      case 'blockquote':
        return [blk('blockquote', {}, this.children(node.children))];
      case 'list':
        return [this.list(node)];
      case 'table':
        return [this.table(node)];
      case 'code': {
        this.warn('Code blocks are not supported; their lines were kept as code-formatted text');
        const lines = restoreText(node.value, this.tokens).split('\n');
        const content = lines.flatMap((line, i): BlockNode[] => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line, marks: [{ type: 'code' }] }] : [])]);
        return [blk('paragraph', {}, content)];
      }
      case 'html':
        return this.html(restoreText(node.value, this.tokens));
      case 'containerDirective':
        return this.container(node);
      case 'leafDirective':
        return this.leaf(node);
      case 'definition':
        return [];
      case 'footnoteDefinition':
        this.warn('Footnotes are not supported; their text was kept in place');
        return this.flow(node.children);
      default:
        return this.asText(node);
    }
  }

  /** Blocks for a container's content (never empty). */
  private children(nodes: RootContent[]): BlockNode[] {
    const blocks = this.flow(nodes);
    return blocks.length ? blocks : [blk('paragraph')];
  }

  /** Anything not understood: its source as a paragraph of text. */
  private asText(node: Nodes): BlockNode[] {
    const text = restoreText(this.slice(node), this.tokens).trim();
    return text ? [blk('paragraph', {}, [{ type: 'text', text }])] : [];
  }

  private html(value: string): BlockNode[] {
    const m = PLACEHOLDER_RE.exec(value.trim());
    if (m) {
      const block = this.lookup(m[1]!);
      if (block) return [block];
      this.warn(`No block "${m[1]}" to restore; that placeholder was dropped`);
      return [];
    }
    if (/^<br\s*\/?>$/i.test(value.trim())) return [];
    this.warn('HTML is not supported; it was kept as text');
    return [blk('paragraph', {}, [{ type: 'text', text: value }])];
  }

  /** The original block for a placeholder: by id (pages) or by position (`@2.1`, templates). */
  private lookup(ref: string): BlockNode | null {
    if (!ref.startsWith('@')) return this.byId.get(ref) ?? null;
    let nodes = this.opts.base?.content;
    let found: BlockNode | undefined;
    for (const part of ref.slice(1).split('.')) {
      found = nodes?.[Number(part)];
      nodes = found?.content;
    }
    return found ?? null;
  }

  private list(node: List): BlockNode {
    // "- [ ]" with nothing after it is an empty checklist item (GFM reads it as text)
    const empty = (item: List['children'][number]) => {
      const only = item.children.length === 1 && item.children[0]!.type === 'paragraph' ? item.children[0].children : null;
      const text = only?.length === 1 && only[0]!.type === 'text' ? only[0].value.trim() : '';
      return text === '[ ]' ? false : /^\[[xX]\]$/.test(text) ? true : null;
    };
    const checked = node.children.map((item) => (typeof item.checked === 'boolean' ? item.checked : empty(item)));
    const task = checked.some((c) => typeof c === 'boolean');
    const items = node.children.map((item, i) =>
      blk(task ? 'taskItem' : 'listItem', task ? { checked: !!checked[i] } : {}, empty(item) !== null ? [blk('paragraph')] : this.children(item.children)),
    );
    if (task) return blk('taskList', {}, items);
    return node.ordered ? blk('orderedList', { start: node.start ?? 1 }, items) : blk('bulletList', {}, items);
  }

  private table(node: Table, roll: string | null = null): BlockNode {
    const rows = node.children.map((row, r) =>
      blk(
        'tableRow',
        {},
        row.children.map((cell) => blk(r === 0 ? 'tableHeader' : 'tableCell', {}, [blk('paragraph', {}, this.inline(cell.children))])),
      ),
    );
    return blk('table', { roll }, rows);
  }

  private image(node: Image): BlockNode {
    const url = node.url;
    const upload = UPLOAD_RE.exec(url);
    const src = upload ? { kind: 'upload', id: upload[1] } : url.startsWith('/img/') ? { kind: 'img', path: decodeURI(url.slice(5)) } : /^https:\/\//i.test(url) ? { kind: 'url', url } : null;
    if (!src) {
      this.warn('Images need an https:// address, an /api/uploads/… or an /img/… path; others were kept as their text');
      return blk('paragraph', {}, node.alt ? [{ type: 'text', text: node.alt }] : []);
    }
    return blk('image', { src, alt: node.alt ?? '', caption: node.title ?? '' });
  }

  private container(node: ContainerDirective): BlockNode[] {
    const attrs = node.attributes ?? {};
    const labelNode = node.children[0]?.type === 'paragraph' && node.children[0].data?.directiveLabel ? node.children[0] : null;
    const body = labelNode ? node.children.slice(1) : node.children;
    if (!/\n[ \t>]*:{3,}$/.test(this.slice(node).trimEnd())) this.warn(`":::${node.name}" was not closed, so it runs to the end of what contains it`);
    const dm = (blocks: BlockNode[]) => (attrs['dm'] !== undefined ? blocks.map((b) => hide(b, attrs['revealed'] !== undefined)) : blocks);
    const label = labelNode ? this.flow([labelNode]) : [];
    switch (node.name.toLowerCase()) {
      case 'dm':
        return this.flow(body).map((b) => hide(b, attrs['revealed'] !== undefined));
      case 'secret':
        return dm([blk('secret', { note: String(attrs['note'] ?? '').slice(0, 200), revealed: attrs['revealed'] !== undefined }, [...label, ...this.children(body)])]);
      case 'callout': {
        const tone = String(attrs['tone'] ?? 'note').toLowerCase();
        if (!CALLOUT_TONES.has(tone)) this.warn(`Callout tones are note, info, tip, warning and danger; "${tone}" became note`);
        return dm([
          blk('callout', { tone: CALLOUT_TONES.has(tone) ? tone : 'note', icon: attrs['icon'] ? String(attrs['icon']).slice(0, 8) : null }, [...label, ...this.children(body)]),
        ]);
      }
      case 'read-aloud':
      case 'readaloud':
        return dm([blk('readAloud', {}, [...label, ...this.children(body)])]);
      case 'details': {
        const summary = labelNode ? this.inline(labelNode.children) : [{ type: 'text', text: 'Details' }];
        return dm([blk('details', { open: attrs['open'] !== undefined }, [blk('detailsSummary', {}, summary), blk('detailsContent', {}, this.children(body))])]);
      }
      case 'roll-table': {
        const tables = body.filter((c): c is Table => c.type === 'table');
        if (tables.length !== 1 || body.length !== 1) {
          this.warn('":::roll-table" must contain exactly one table; its content was kept as is');
          return this.flow(body);
        }
        return dm([this.table(tables[0]!, String(attrs['dice'] ?? attrs['roll'] ?? 'd6').slice(0, 20))]);
      }
      case 'columns':
      case 'tabs': {
        const kind = node.name.toLowerCase() === 'columns' ? 'column' : 'tab';
        const parts: BlockNode[] = [];
        const loose: RootContent[] = [];
        for (const child of body) {
          if (child.type === 'containerDirective' && child.name.toLowerCase() === kind) parts.push(...this.part(child, kind));
          else loose.push(child);
        }
        if (loose.length) {
          this.warn(`Content directly inside ":::${node.name}" belongs in ":::${kind}" sections; it was put in one`);
          parts.push(blk(kind, kind === 'tab' ? { title: 'Tab' } : {}, this.children(loose)));
        }
        return dm([blk(kind === 'column' ? 'columns' : 'tabs', {}, parts)]);
      }
      case 'column':
      case 'tab':
        this.warn(`":::${node.name}" only works inside ":::${node.name === 'tab' ? 'tabs' : 'columns'}"; its content was kept`);
        return this.flow(body);
      default:
        this.warn(`Unknown container ":::${node.name}" was kept as text`);
        return this.asText(node);
    }
  }

  /** A column or tab inside `:::columns` / `:::tabs`. */
  private part(node: ContainerDirective, kind: 'column' | 'tab'): BlockNode[] {
    const attrs = node.attributes ?? {};
    const labelNode = node.children[0]?.type === 'paragraph' && node.children[0].data?.directiveLabel ? node.children[0] : null;
    const body = labelNode ? node.children.slice(1) : node.children;
    const title = labelNode ? restoreText(labelNode.children.map((c) => this.slice(c)).join(''), this.tokens).trim().slice(0, 80) || 'Tab' : 'Tab';
    const part = blk(kind, kind === 'tab' ? { title } : {}, this.children(body));
    return [attrs['dm'] !== undefined ? hide(part, attrs['revealed'] !== undefined) : part];
  }

  private leaf(node: LeafDirective): BlockNode[] {
    const attrs = node.attributes ?? {};
    if (node.name.toLowerCase() === 'embed') {
      const uid = String(attrs['uid'] ?? '').trim();
      if (/^[a-z]+:.+\|.+$/i.test(uid)) {
        const block = blk('refEmbed', { uid: uid.toLowerCase(), kind: uid.split(':')[0]!.toLowerCase(), display: attrs['display'] === 'compact' ? 'compact' : 'full' });
        return [attrs['dm'] !== undefined ? hide(block, attrs['revealed'] !== undefined) : block];
      }
      this.warn('"::embed" needs a uid like "monster:goblin|mm" (search_rules gives it)');
      return [];
    }
    this.warn(`Unknown "::${node.name}" was kept as text`);
    return this.asText(node);
  }

  /** Inline content with marks; tags, page links and fields come back from their tokens. */
  inline(nodes: PhrasingContent[], marks: Mark[] = []): BlockNode[] {
    const out: BlockNode[] = [];
    for (const node of nodes) {
      switch (node.type) {
        case 'text':
          out.push(...this.text(node.value, marks));
          break;
        case 'strong':
          out.push(...this.inline(node.children, [...marks, { type: 'bold' }]));
          break;
        case 'emphasis':
          out.push(...this.inline(node.children, [...marks, { type: 'italic' }]));
          break;
        case 'delete':
          out.push(...this.inline(node.children, [...marks, { type: 'strike' }]));
          break;
        case 'inlineCode':
          out.push({ type: 'text', text: restoreText(node.value, this.tokens), marks: [...marks, { type: 'code' }] });
          break;
        case 'link':
          if (SAFE_URL.test(node.url)) out.push(...this.inline(node.children, [...marks, { type: 'link', attrs: { href: node.url } }]));
          else {
            this.warn('Links need an http(s), mailto or /… address; others were kept as their text');
            out.push(...this.inline(node.children, marks));
          }
          break;
        case 'break':
          out.push({ type: 'hardBreak' });
          break;
        case 'image':
          this.warn('Images must stand alone on their line; inline images were kept as their text');
          if (node.alt) out.push({ type: 'text', text: node.alt, ...(marks.length ? { marks } : {}) });
          break;
        case 'html':
          if (/^<br\s*\/?>$/i.test(node.value)) out.push({ type: 'hardBreak' });
          else out.push(...this.text(restoreText(node.value, this.tokens), marks));
          break;
        case 'linkReference':
          out.push(...this.inline(node.children, marks));
          break;
        default:
          // Text directives (from "Status:Hostile") and anything else: the text as written
          out.push(...this.text(this.slice(node), marks));
      }
    }
    return mergeText(out);
  }

  private text(value: string, marks: Mark[]): BlockNode[] {
    const withMarks = (text: string): BlockNode => ({ type: 'text', text, ...(marks.length ? { marks } : {}) });
    return splitTokens(value, this.tokens).map((part) => (typeof part === 'string' ? withMarks(part) : this.token(part, withMarks)));
  }

  private token(token: Token, asText: (text: string) => BlockNode): BlockNode {
    if (token.kind === 'tag') {
      const markup = token.source.replace(/\\\|/g, '|');
      return markup.length <= 500 ? { type: 'tag', attrs: { markup } } : asText(markup);
    }
    const inner = token.source.slice(2, -2).trim();
    if (token.kind === 'field') {
      const field = this.opts.mode !== 'template' ? this.fields.get(inner.split(':')[0]!.trim()) : undefined;
      return field ? { type: 'placeholder', attrs: { ...field.attrs } } : asText(token.source);
    }
    const byId = /^page:([\w-]+)(?:\|(.*))?$/.exec(inner);
    const ref = byId ? { id: byId[1]!, ...(byId[2] ? { label: byId[2].trim() } : {}) } : { title: inner };
    const found = this.opts.resolvePage?.(ref) ?? null;
    if (found && 'pageId' in found) return { type: 'pageLink', attrs: { pageId: found.pageId, label: (byId?.[2]?.trim() || found.label).slice(0, 200) } };
    this.warn(found && 'error' in found ? found.error : `No page "${byId ? byId[1] : inner}" to link; it was kept as text`);
    return asText(token.source);
  }
}

/** Marks a block DM-only (`:::dm`, or a container's `dm` flag). A secret keeps its own revealed flag. */
function hide(block: BlockNode, revealed: boolean): BlockNode {
  return { ...block, attrs: { ...block.attrs, visibility: 'dm', revealed: block.type === 'secret' ? !!block.attrs?.revealed || revealed : revealed } };
}

function sameMarks(a: Mark[] | undefined, b: Mark[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function mergeText(nodes: BlockNode[]): BlockNode[] {
  const out: BlockNode[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (node.type === 'text' && !node.text) continue;
    if (prev?.type === 'text' && node.type === 'text' && sameMarks(prev.marks, node.marks)) out[out.length - 1] = { ...prev, text: (prev.text ?? '') + (node.text ?? '') };
    else out.push(node);
  }
  return out;
}

/** Parses Markdown into blocks (not yet merged with the previous version: see `reconcile`). */
export function parseMarkdown(markdown: string, opts: FromMarkdownOptions = {}): { blocks: BlockNode[]; warnings: string[] } {
  const { text, tokens } = protect(markdown);
  const tree = fromMarkdown(text, { extensions: [gfm(), directive()], mdastExtensions: [gfmFromMarkdown(), directiveFromMarkdown()] });
  const reader = new Reader(text, tokens, opts);
  return { blocks: reader.flow(tree.children), warnings: reader.warnings };
}
