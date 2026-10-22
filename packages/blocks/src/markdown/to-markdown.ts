/**
 * Block Document → Markdown. Blocks Markdown can express become Markdown (with `:::` containers for
 * secrets, callouts, read-aloud boxes, DM-only runs and layouts); everything else becomes a placeholder
 * comment, `<!-- cn:block <ref> <type>: <summary> -->`, which `markdownToDoc` turns back into the original
 * block.
 */
import type { BlockContent, Image, ListItem, Paragraph, PhrasingContent, Root, RootContent, Table, TableCell, TableRow } from 'mdast';
import { directiveToMarkdown, type ContainerDirective, type LeafDirective } from 'mdast-util-directive';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown, type Options, type Unsafe } from 'mdast-util-to-markdown';
import { splitByTags } from '@cn/fivetools';
import type { BlockDocument, BlockNode, Mark } from '../doc';
import { docText } from '../extract';

export interface ToMarkdownOptions {
  /** `template`: blocks have no ids; placeholders refer to blocks by position (`@2.1`). */
  mode?: 'page' | 'template';
  /** How a page link is written: its title when it names one page, else `page:<id>|Label`. */
  pageRef?(pageId: string, label: string): string;
  /** A page's title, for placeholder summaries of page cards. */
  pageTitle?(pageId: string): string | null;
}

/** Block types that are always written as placeholders. */
export const OPAQUE_TYPES = new Set(['statGrid', 'gallery', 'pageEmbed', 'query', 'encounter', 'loot', 'templateInstance', 'unknownBlock']);
export const PLACEHOLDER_PREFIX = 'cn:block';

type Raw = { type: 'cnRaw'; value: string };
type Flow = RootContent;

const MARK_ORDER = ['link', 'bold', 'italic', 'strike'] as const;

function directiveExtension() {
  const ext = directiveToMarkdown();
  // Prose colons ("Status: hostile", "12:30") need no escaping: the parser reads stray directives as text
  const keep = (u: Unsafe) => !(u.character === ':' && [u.inConstruct].flat().includes('phrasing'));
  return { ...ext, unsafe: (ext.unsafe ?? []).filter(keep) };
}

const OPTIONS: Options = {
  extensions: [gfmToMarkdown(), directiveExtension()],
  handlers: { cnRaw: (node: Raw) => node.value } as never,
  bullet: '-',
  listItemIndent: 'one',
  rule: '-',
  emphasis: '*',
  strong: '*',
  fences: true,
};

const hasBinding = (value: unknown): boolean =>
  !!value &&
  typeof value === 'object' &&
  (Array.isArray(value) ? value.some(hasBinding) : Object.keys(value).some((k) => k.startsWith('$')) || Object.values(value).some(hasBinding));

const isEmptyParagraph = (b: BlockNode) => b.type === 'paragraph' && (b.content ?? []).every((c) => c.type === 'text' && !c.text);

/** Text split into plain runs and `{{fields}}`, which are written as they are (never escaped). */
const FIELD_RE = /(\{\{[^{}\n]+\}\})/;

/** Empty paragraphs (spacing) do not appear in Markdown; `reconcile` keeps them in place. */
export const isUnrepresented = isEmptyParagraph;

class Writer {
  constructor(private readonly opts: ToMarkdownOptions) {}

  /** Blocks at one level; runs of DM-only blocks are grouped in `:::dm`. */
  flow(blocks: BlockNode[], path: number[]): Flow[] {
    const out: Flow[] = [];
    let i = 0;
    while (i < blocks.length) {
      const block = blocks[i]!;
      if (block.attrs?.visibility === 'dm') {
        const revealed = !!block.attrs?.revealed;
        const group: Flow[] = [];
        while (i < blocks.length && blocks[i]!.attrs?.visibility === 'dm' && !!blocks[i]!.attrs?.revealed === revealed) {
          group.push(...this.block(blocks[i]!, [...path, i]));
          i++;
        }
        out.push(directive('dm', revealed ? { revealed: '' } : {}, group));
      } else {
        out.push(...this.block(block, [...path, i]));
        i++;
      }
    }
    return out;
  }

  private placeholder(block: BlockNode, path: number[]): Flow {
    const ref = this.opts.mode !== 'template' && typeof block.attrs?.id === 'string' && block.attrs.id ? block.attrs.id : `@${path.join('.')}`;
    const summary = this.summary(block)
      .replace(/-->|--|[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return { type: 'html', value: `<!-- ${PLACEHOLDER_PREFIX} ${ref} ${block.type}${summary ? `: ${summary}` : ''} -->` };
  }

  private summary(block: BlockNode): string {
    const a = block.attrs ?? {};
    switch (block.type) {
      case 'pageEmbed':
        return (typeof a['pageId'] === 'string' && this.opts.pageTitle?.(a['pageId'])) || 'page card';
      case 'query':
        return String(a['title'] || 'list of pages');
      case 'loot':
        return ((a['items'] as { name?: string }[] | undefined) ?? []).map((i) => i.name).filter(Boolean).join(', ') || 'loot';
      case 'statGrid':
        return ((a['items'] as { label: string; value: string }[] | undefined) ?? []).map((i) => `${i.label}: ${i.value}`).join('; ');
      case 'gallery':
        return `${((a['images'] as unknown[]) ?? []).length} images`;
      case 'unknownBlock':
        return 'unsupported block';
      default:
        return docText({ type: 'doc', content: [block] });
    }
  }

  private opaque(block: BlockNode): boolean {
    if (OPAQUE_TYPES.has(block.type) || hasBinding(block.attrs)) return true;
    const kids = block.content ?? [];
    switch (block.type) {
      case 'paragraph':
      case 'heading':
        return kids.some((k) => hasBinding(k.attrs) || (k.type !== 'text' && k.type !== 'tag' && k.type !== 'pageLink' && k.type !== 'placeholder' && k.type !== 'hardBreak'));
      case 'image':
        return !block.attrs?.src;
      case 'refEmbed':
        return typeof block.attrs?.uid !== 'string';
      case 'table':
        return !simpleTable(block);
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        // A hidden list item cannot be marked inside a Markdown list
        return kids.some((k) => k.attrs?.visibility === 'dm' || !!k.attrs?.revealed);
      case 'details':
        return kids.length !== 2 || kids[0]!.type !== 'detailsSummary' || kids[1]!.type !== 'detailsContent' || kids.some((k) => k.attrs?.visibility === 'dm');
      case 'columns':
        return kids.some((k) => k.type !== 'column');
      case 'tabs':
        return kids.some((k) => k.type !== 'tab');
      default:
        return !WRITABLE.has(block.type);
    }
  }

  block(block: BlockNode, path: number[]): Flow[] {
    if (isEmptyParagraph(block)) return [];
    if (this.opaque(block)) return [this.placeholder(block, path)];
    const a = block.attrs ?? {};
    const kids = block.content ?? [];
    const children = () => this.flow(kids, path) as BlockContent[];
    switch (block.type) {
      case 'paragraph':
        return [{ type: 'paragraph', children: this.inline(kids) }];
      case 'heading':
        return [{ type: 'heading', depth: Math.min(4, Math.max(1, Number(a['level'] ?? 2))) as 1 | 2 | 3 | 4, children: this.inline(kids) }];
      case 'blockquote':
        return [{ type: 'blockquote', children: children() }];
      case 'horizontalRule':
        return [{ type: 'thematicBreak' }];
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        return [
          {
            type: 'list',
            ordered: block.type === 'orderedList',
            ...(block.type === 'orderedList' ? { start: Number(a['start'] ?? 1) } : {}),
            spread: false,
            children: kids.map((item, i): ListItem => {
              const children = this.flow(item.content ?? [], [...path, i]) as BlockContent[];
              const task = block.type === 'taskList';
              // An empty checklist item: GFM needs text after the box, so the box itself is written as text
              if (task && !children.length) return { type: 'listItem', spread: false, checked: null, children: [{ type: 'paragraph', children: [raw(item.attrs?.checked ? '[x]' : '[ ]')] }] };
              return { type: 'listItem', spread: false, checked: task ? !!item.attrs?.checked : null, children };
            }),
          },
        ];
      case 'callout':
        return [directive('callout', { tone: String(a['tone'] ?? 'note'), ...(a['icon'] ? { icon: String(a['icon']) } : {}) }, children())];
      case 'readAloud':
        return [directive('read-aloud', {}, children())];
      case 'secret':
        return [directive('secret', { ...(a['note'] ? { note: String(a['note']) } : {}), ...(a['revealed'] ? { revealed: '' } : {}) }, children())];
      case 'details': {
        const [summary, content] = kids as [BlockNode, BlockNode];
        return [directive('details', a['open'] ? { open: '' } : {}, this.flow(content.content ?? [], [...path, 1]), this.inline(summary.content ?? []))];
      }
      case 'columns':
        return [directive('columns', {}, kids.map((col, i) => directive('column', dmAttrs(col), this.flow(col.content ?? [], [...path, i]))))];
      case 'tabs':
        return [
          directive(
            'tabs',
            {},
            kids.map((tab, i) => directive('tab', dmAttrs(tab), this.flow(tab.content ?? [], [...path, i]), [{ type: 'text', value: String(tab.attrs?.title ?? 'Tab') }])),
          ),
        ];
      case 'table': {
        const table = this.table(block);
        return [a['roll'] ? directive('roll-table', { dice: String(a['roll']) }, [table]) : table];
      }
      case 'image':
        return [{ type: 'paragraph', children: [imageNode(block)] }];
      case 'refEmbed':
        return [leaf('embed', { uid: String(a['uid']), ...(a['display'] === 'compact' ? { display: 'compact' } : {}) })];
      default:
        return [this.placeholder(block, path)];
    }
  }

  private table(block: BlockNode): Table {
    const rows = (block.content ?? []).map(
      (row): TableRow => ({
        type: 'tableRow',
        children: (row.content ?? []).map((cell): TableCell => ({ type: 'tableCell', children: this.inline(cell.content?.[0]?.content ?? []) })),
      }),
    );
    return { type: 'table', align: rows[0]?.children.map(() => null) ?? [], children: rows };
  }

  /** Inline nodes as Markdown phrasing: marks become emphasis, links, code; tags and page links stay as written. */
  inline(nodes: BlockNode[]): PhrasingContent[] {
    const out: PhrasingContent[] = [];
    for (const node of nodes) {
      if (node.type === 'text') {
        const marks = node.marks ?? [];
        // Tags typed as text are written like tag nodes (they are the same reference)
        const pieces = marks.some((m) => m.type === 'code') ? [node.text ?? ''] : splitByTags(node.text ?? '');
        const code = marks.some((m) => m.type === 'code');
        for (const piece of pieces) {
          if (piece.startsWith('{@') && piece.endsWith('}') && !code) out.push(raw(piece));
          else
            for (const [text, m] of edgeSpaceOutside(piece, marks))
              for (const part of code ? [text] : text.split(FIELD_RE)) {
                // A field is text: it keeps its formatting
                if (!code && part.startsWith('{{') && FIELD_RE.test(part)) out.push(wrap(part, m, raw(part)));
                else if (part) out.push(wrap(part, m));
              }
        }
      } else if (node.type === 'tag') out.push(raw(String(node.attrs?.markup ?? '')));
      else if (node.type === 'pageLink') {
        const id = String(node.attrs?.pageId ?? '');
        const label = String(node.attrs?.label ?? '');
        out.push(raw(`[[${this.opts.pageRef ? this.opts.pageRef(id, label) : `page:${id}|${label}`}]]`));
      } else if (node.type === 'placeholder') out.push(raw(`{{${String(node.attrs?.name ?? '')}}}`));
      else if (node.type === 'hardBreak') out.push({ type: 'break' });
    }
    return mergePhrasing(out);
  }
}

const WRITABLE = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'horizontalRule',
  'bulletList',
  'orderedList',
  'taskList',
  'callout',
  'readAloud',
  'secret',
  'details',
  'columns',
  'tabs',
  'table',
  'image',
  'refEmbed',
]);

const raw = (value: string): PhrasingContent => ({ type: 'cnRaw', value }) as unknown as PhrasingContent;

function directive(name: string, attributes: Record<string, string>, children: Flow[], label?: PhrasingContent[]): ContainerDirective {
  const labelNode: Paragraph[] = label ? [{ type: 'paragraph', data: { directiveLabel: true }, children: label }] : [];
  return { type: 'containerDirective', name, attributes, children: [...labelNode, ...(children as BlockContent[])] };
}

const leaf = (name: string, attributes: Record<string, string>): LeafDirective => ({ type: 'leafDirective', name, attributes, children: [] });

const dmAttrs = (block: BlockNode): Record<string, string> => ({
  ...(block.attrs?.visibility === 'dm' ? { dm: '' } : {}),
  ...(block.attrs?.visibility === 'dm' && block.attrs?.revealed ? { revealed: '' } : {}),
});

/** A table Markdown can hold: rectangular, one header row, one paragraph per cell, no spans, nothing hidden. */
function simpleTable(table: BlockNode): boolean {
  const rows = table.content ?? [];
  if (!rows.length || rows.some((r) => r.type !== 'tableRow' || r.attrs?.visibility === 'dm')) return false;
  const width = rows[0]!.content?.length ?? 0;
  if (!width) return false;
  return rows.every(
    (row, r) =>
      row.content?.length === width &&
      row.content.every((cell) => {
        const a = cell.attrs ?? {};
        const kids = cell.content ?? [];
        return (
          cell.type === (r === 0 ? 'tableHeader' : 'tableCell') &&
          Number(a['colspan'] ?? 1) === 1 &&
          Number(a['rowspan'] ?? 1) === 1 &&
          a['visibility'] !== 'dm' &&
          kids.length <= 1 &&
          kids.every((p) => p.type === 'paragraph' && p.attrs?.visibility !== 'dm' && !(p.content ?? []).some((n) => n.type === 'hardBreak' || hasBinding(n.attrs)))
        );
      }),
  );
}

function imageNode(block: BlockNode): Image {
  const src = block.attrs?.src as { kind: string; id?: string; path?: string; url?: string };
  const url = src.kind === 'upload' ? `/api/uploads/${src.id}` : src.kind === 'img' ? `/img/${src.path}` : String(src.url);
  return { type: 'image', url, alt: String(block.attrs?.alt ?? ''), title: block.attrs?.caption ? String(block.attrs.caption) : null };
}

/**
 * Spaces at the edges of bold, italic or struck-out text are written outside it: `**a** b`, not `**a **b`
 * (which Markdown can only express with character references).
 */
export function edgeSpaceOutside(text: string, marks: Mark[]): [string, Mark[]][] {
  if (marks.some((m) => m.type === 'code') || !marks.some((m) => m.type === 'bold' || m.type === 'italic' || m.type === 'strike')) return [[text, marks]];
  const lead = text.length - text.trimStart().length;
  const core = text.slice(lead).trimEnd();
  const m = [text, text.slice(0, lead), core, text.slice(lead + core.length)];
  const outer = marks.filter((x) => x.type === 'link');
  return [
    ...(m[1] ? [[m[1], outer] as [string, Mark[]]] : []),
    ...(m[2] ? [[m[2], marks] as [string, Mark[]]] : []),
    ...(m[3] ? [[m[3], outer] as [string, Mark[]]] : []),
  ];
}

function wrap(text: string, marks: Mark[], leaf?: PhrasingContent): PhrasingContent {
  let node: PhrasingContent = leaf ?? (marks.some((m) => m.type === 'code') ? { type: 'inlineCode', value: text } : { type: 'text', value: text });
  for (const kind of [...MARK_ORDER].reverse()) {
    const mark = marks.find((m) => m.type === kind);
    if (!mark) continue;
    if (kind === 'strike') node = { type: 'delete', children: [node] };
    else if (kind === 'italic') node = { type: 'emphasis', children: [node] };
    else if (kind === 'bold') node = { type: 'strong', children: [node] };
    else node = { type: 'link', url: String(mark.attrs?.['href'] ?? ''), children: [node] };
  }
  return node;
}

/** Joins neighbours with the same formatting, so `**a** **b**` is written `**ab**` where the marks continue. */
function mergePhrasing(nodes: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (prev && prev.type === 'text' && node.type === 'text') prev.value += node.value;
    else if (prev && sameWrapper(prev, node)) (prev as { children: PhrasingContent[] }).children = mergePhrasing([...(prev as { children: PhrasingContent[] }).children, ...(node as { children: PhrasingContent[] }).children]);
    else out.push(node);
  }
  return out;
}

function sameWrapper(a: PhrasingContent, b: PhrasingContent): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'link') return a.url === (b as { url: string }).url;
  return a.type === 'strong' || a.type === 'emphasis' || a.type === 'delete';
}

/** Markdown for a list of blocks. */
export function blocksToMarkdown(blocks: BlockNode[], opts: ToMarkdownOptions = {}, path: number[] = []): string {
  const root: Root = { type: 'root', children: new Writer(opts).flow(blocks, path) };
  return toMarkdown(root, OPTIONS);
}

/** A whole document as Markdown. */
export function docToMarkdown(doc: BlockDocument | null | undefined, opts: ToMarkdownOptions = {}): string {
  return blocksToMarkdown(doc?.content ?? [], opts);
}
