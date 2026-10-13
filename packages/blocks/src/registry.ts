/**
 * Block registry (framework-independent half). Every node type declares its attribute schema, allowed
 * content, visibility behaviour and text/link extraction. The web app registers the matching TipTap
 * extension, editor NodeView and read-only renderer under the same name. New block types register here;
 * the core never changes.
 */
import { z } from 'zod';
import { queryFilterSchema } from './query';
import type { BlockNode } from './doc';

export type NodeKind = 'block' | 'inline' | 'text';
/** What a node may contain: inline content, blocks, nothing, or a fixed list of child types. */
export type ContentRule = 'inline' | 'blocks' | 'none' | { only: string[] };

export interface ProjectContext {
  role: 'dm' | 'player';
  /** Whether the viewer may see a page (for page links/embeds). */
  canSeePage(pageId: string): boolean;
}

export interface BlockTypeDef {
  name: string;
  kind: NodeKind;
  /** Validated (and defaulted) type-specific attributes. Common attrs (id/visibility/revealed) are added for blocks. */
  attrs: z.ZodType<Record<string, unknown>>;
  content: ContentRule;
  /** Always DM-only unless revealed (e.g. the "secret" block). */
  secretByDefault?: boolean;
  /** Custom projection for players (after the generic visibility check). Return null to drop the node. */
  project?(node: BlockNode, ctx: ProjectContext): BlockNode | null;
  /** Custom plain-text extraction (defaults to children's text). */
  text?(node: BlockNode): string;
  label: string;
}

const empty = z.object({}).passthrough().transform(() => ({}));
const safeUrl = z
  .string()
  .max(2048)
  .refine((u) => /^(https?:|mailto:)/i.test(u) || u.startsWith('/'), 'Only http(s), mailto and app-relative links are allowed');

/** Image source: an upload id, a 5etools-img path, or an https URL. */
export const imageSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upload'), id: z.string().max(64) }),
  z.object({ kind: z.literal('img'), path: z.string().max(512) }),
  z.object({ kind: z.literal('url'), url: z.string().max(2048).regex(/^https:\/\//i) }),
]);
export type ImageSource = z.infer<typeof imageSourceSchema>;

const imageAttrs = z.object({
  src: imageSourceSchema.nullable().default(null),
  alt: z.string().max(300).default(''),
  caption: z.string().max(500).default(''),
  /** map: zoomable, full width */
  style: z.enum(['inline', 'wide', 'map']).default('inline'),
});

export const statGridItemSchema = z.object({ label: z.string().max(80), value: z.string().max(500) });

const defs: BlockTypeDef[] = [
  // region Text blocks
  { name: 'paragraph', label: 'Text', kind: 'block', attrs: z.object({ textAlign: z.enum(['left', 'center', 'right']).nullable().default(null) }), content: 'inline' },
  { name: 'heading', label: 'Heading', kind: 'block', attrs: z.object({ level: z.number().int().min(1).max(4).default(2) }), content: 'inline' },
  { name: 'blockquote', label: 'Quote', kind: 'block', attrs: empty, content: 'blocks' },
  { name: 'bulletList', label: 'Bulleted list', kind: 'block', attrs: empty, content: { only: ['listItem'] } },
  { name: 'orderedList', label: 'Numbered list', kind: 'block', attrs: z.object({ start: z.number().int().min(0).max(100000).default(1) }), content: { only: ['listItem'] } },
  { name: 'listItem', label: 'List item', kind: 'block', attrs: empty, content: 'blocks' },
  { name: 'taskList', label: 'Checklist', kind: 'block', attrs: empty, content: { only: ['taskItem'] } },
  { name: 'taskItem', label: 'Checklist item', kind: 'block', attrs: z.object({ checked: z.boolean().default(false) }), content: 'blocks' },
  { name: 'horizontalRule', label: 'Divider', kind: 'block', attrs: empty, content: 'none' },
  {
    name: 'callout',
    label: 'Callout',
    kind: 'block',
    attrs: z.object({ tone: z.enum(['note', 'info', 'tip', 'warning', 'danger']).default('note'), icon: z.string().max(8).nullable().default(null) }),
    content: 'blocks',
  },
  { name: 'readAloud', label: 'Read-aloud', kind: 'block', attrs: empty, content: 'blocks' },
  { name: 'secret', label: 'DM secret', kind: 'block', attrs: z.object({ note: z.string().max(200).default('') }), content: 'blocks', secretByDefault: true },
  // endregion

  // region Tables
  { name: 'table', label: 'Table', kind: 'block', attrs: z.object({ roll: z.string().max(20).nullable().default(null) }), content: { only: ['tableRow'] } },
  { name: 'tableRow', label: 'Table row', kind: 'block', attrs: empty, content: { only: ['tableCell', 'tableHeader'] } },
  {
    name: 'tableCell',
    label: 'Cell',
    kind: 'block',
    attrs: z.object({ colspan: z.number().int().min(1).max(20).default(1), rowspan: z.number().int().min(1).max(50).default(1), colwidth: z.array(z.number()).nullable().default(null) }),
    content: 'blocks',
  },
  {
    name: 'tableHeader',
    label: 'Header cell',
    kind: 'block',
    attrs: z.object({ colspan: z.number().int().min(1).max(20).default(1), rowspan: z.number().int().min(1).max(50).default(1), colwidth: z.array(z.number()).nullable().default(null) }),
    content: 'blocks',
  },
  {
    name: 'statGrid',
    label: 'Stat grid',
    kind: 'block',
    attrs: z.object({ items: z.array(statGridItemSchema).max(60).default([]), columns: z.number().int().min(1).max(4).default(2) }),
    content: 'none',
    text: (n) => ((n.attrs?.items as { label: string; value: string }[] | undefined) ?? []).map((i) => `${i.label}: ${i.value}`).join(' '),
  },
  // endregion

  // region Media
  { name: 'image', label: 'Image', kind: 'block', attrs: imageAttrs, content: 'none', text: (n) => `${String(n.attrs?.alt ?? '')} ${String(n.attrs?.caption ?? '')}` },
  {
    name: 'gallery',
    label: 'Gallery',
    kind: 'block',
    attrs: z.object({ images: z.array(z.object({ src: imageSourceSchema, caption: z.string().max(300).default('') })).max(40).default([]) }),
    content: 'none',
  },
  // endregion

  // region Embeds
  {
    name: 'refEmbed',
    label: 'Reference embed',
    kind: 'block',
    attrs: z.object({ uid: z.string().max(300).nullable().default(null), kind: z.string().max(40).nullable().default(null), display: z.enum(['full', 'compact']).default('full') }),
    content: 'none',
  },
  {
    name: 'pageEmbed',
    label: 'Page link card',
    kind: 'block',
    attrs: z.object({ pageId: z.string().max(64).nullable().default(null), mode: z.enum(['card', 'inline']).default('card') }),
    content: 'none',
    project: (node, ctx) => (node.attrs?.pageId && ctx.canSeePage(String(node.attrs.pageId)) ? node : null),
  },
  {
    name: 'query',
    label: 'Query',
    kind: 'block',
    attrs: z.object({
      title: z.string().max(120).default(''),
      filter: queryFilterSchema.default(queryFilterSchema.parse({})),
      view: z.enum(['list', 'table', 'cards']).default('list'),
      columns: z.array(z.string().max(80)).max(10).default([]),
    }),
    content: 'none',
  },
  // endregion

  // region Layout
  { name: 'columns', label: 'Columns', kind: 'block', attrs: empty, content: { only: ['column'] } },
  { name: 'column', label: 'Column', kind: 'block', attrs: empty, content: 'blocks' },
  { name: 'details', label: 'Collapsible section', kind: 'block', attrs: z.object({ open: z.boolean().default(false) }), content: { only: ['detailsSummary', 'detailsContent'] } },
  { name: 'detailsSummary', label: 'Summary', kind: 'block', attrs: empty, content: 'inline' },
  { name: 'detailsContent', label: 'Details', kind: 'block', attrs: empty, content: 'blocks' },
  { name: 'tabs', label: 'Tabs', kind: 'block', attrs: empty, content: { only: ['tab'] } },
  { name: 'tab', label: 'Tab', kind: 'block', attrs: z.object({ title: z.string().max(80).default('Tab') }), content: 'blocks' },
  // endregion

  // region Game blocks (filled in by later milestones)
  {
    name: 'encounter',
    label: 'Encounter',
    kind: 'block',
    attrs: z.object({ encounterId: z.string().max(64).nullable().default(null) }),
    content: 'none',
    // What the party will face is the DM's business
    project: () => null,
  },
  {
    name: 'loot',
    label: 'Loot',
    kind: 'block',
    attrs: z.object({
      items: z.array(z.object({ uid: z.string().max(300).nullable().default(null), name: z.string().max(200).default(''), qty: z.number().int().min(1).max(100000).default(1), note: z.string().max(300).default('') })).max(100).default([]),
      coins: z.object({ cp: z.number().int().min(0).default(0), sp: z.number().int().min(0).default(0), ep: z.number().int().min(0).default(0), gp: z.number().int().min(0).default(0), pp: z.number().int().min(0).default(0) }).default({ cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 }),
      /** Set once the loot was added to an inventory. */
      awarded: z.object({ at: z.number().int(), to: z.string().max(64) }).nullable().default(null),
    }),
    content: 'none',
  },
  {
    name: 'templateInstance',
    label: 'Linked template',
    kind: 'block',
    attrs: z.object({ templateId: z.string().max(64).nullable().default(null), version: z.number().int().min(0).default(0), values: z.record(z.string(), z.unknown()).default({}), detached: z.boolean().default(false) }),
    content: 'blocks',
  },
  // endregion

  // region Inline nodes
  { name: 'text', label: 'Text', kind: 'text', attrs: empty, content: 'none' },
  { name: 'hardBreak', label: 'Line break', kind: 'inline', attrs: empty, content: 'none', text: () => '\n' },
  {
    name: 'pageLink',
    label: 'Page link',
    kind: 'inline',
    attrs: z.object({ pageId: z.string().max(64), label: z.string().max(200).default('') }),
    content: 'none',
    text: (n) => String(n.attrs?.label ?? ''),
    project: (node, ctx) => (ctx.canSeePage(String(node.attrs?.pageId)) ? node : { type: 'text', text: String(node.attrs?.label ?? '') }),
  },
  {
    name: 'tag',
    label: '5etools reference',
    kind: 'inline',
    // A single 5etools inline tag such as "{@spell fireball|xphb}" or "{@dice 2d6}"
    attrs: z.object({ markup: z.string().max(500).regex(/^\{@[A-Za-z0-9_]+[\s\S]*\}$/) }),
    content: 'none',
  },
  {
    name: 'placeholder',
    label: 'Template field',
    kind: 'inline',
    attrs: z.object({ name: z.string().max(60), valueType: z.string().max(60).default('text'), label: z.string().max(120).default('') }),
    content: 'none',
    text: (n) => `{{${String(n.attrs?.name ?? '')}}}`,
  },
  // endregion

  // Fallback for anything unknown: preserved losslessly, never shown to players
  { name: 'unknownBlock', label: 'Unsupported block', kind: 'block', attrs: z.object({ raw: z.unknown().optional() }).passthrough(), content: 'none', project: () => null, text: () => '' },
];

export const BLOCK_TYPES: ReadonlyMap<string, BlockTypeDef> = new Map(defs.map((d) => [d.name, d]));

export const MARK_TYPES: Record<string, z.ZodType<Record<string, unknown>>> = {
  bold: empty,
  italic: empty,
  underline: empty,
  strike: empty,
  code: empty,
  highlight: z.object({ color: z.string().regex(/^#[0-9a-f]{3,8}$/i).nullable().default(null) }),
  link: z.object({ href: safeUrl, target: z.enum(['_blank']).nullable().default('_blank'), rel: z.string().max(80).nullable().default('noopener noreferrer nofollow') }),
};

/** Attributes shared by every block node. */
export const commonBlockAttrs = z.object({
  id: z.string().max(64).nullable().default(null),
  visibility: z.enum(['inherit', 'dm']).default('inherit'),
  revealed: z.boolean().default(false),
});

export function blockType(name: string): BlockTypeDef | undefined {
  return BLOCK_TYPES.get(name);
}

/** Registers an additional block type (plugins / later milestones). */
export function registerBlockType(def: BlockTypeDef) {
  (BLOCK_TYPES as Map<string, BlockTypeDef>).set(def.name, def);
}
