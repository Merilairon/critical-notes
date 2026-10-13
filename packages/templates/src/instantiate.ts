/**
 * Turning template content into page content.
 *
 * - Text placeholders become typed content: text, a `{@dice}` tag, a `[[page]]` link, a `{@creature …}` tag.
 * - Attribute bindings: `{"$var": "creature"}` (e.g. a reference embed's uid), `{"$rulesetRef": "condition:poisoned"}`
 *   (the uid for the campaign's edition) and `{"$rulesetTag": "condition:poisoned"}` (a tag's markup).
 * - `{{rules.race}}` is the ruleset's own term ("Race" in 2014, "Species" in 2024).
 * - Fill mode drops variables without a value; fields mode keeps them as placeholder fields to fill in later.
 * Block ids are removed so every insertion gets fresh ones.
 */
import type { BlockNode, Mark } from '@cn/blocks';
import { isKind, KINDS, toTitleCase, type EntityKind } from '@cn/fivetools';
import { tokenize } from './tokenize';
import { coerceValue, formatType, parseType, RULES_PREFIX, type TemplateValue, type TemplateVariable, type VariableType } from './variables';

export type InstantiateMode = 'fill' | 'fields';

export interface InstantiateOptions {
  mode: InstantiateMode;
  values: Record<string, TemplateValue>;
  variables?: readonly TemplateVariable[];
  /** Ruleset terminology for `{{rules.*}}` (e.g. { race: 'Species' }). */
  terminology?: Record<string, string>;
  /** Ruleset canonical references ("condition:poisoned" → uid) for `$rulesetRef` / `$rulesetTag`. */
  canonicalRef?: (key: string) => string | null;
  /** Display name and source of a referenced entity, as written in the data. */
  describeRef?: (uid: string) => { name: string; source: string } | null;
  /** Current title of a linked page (for the link label). */
  pageTitle?: (pageId: string) => string | null;
}

interface Ctx extends InstantiateOptions {
  types: Map<string, VariableType>;
  defaults: Map<string, TemplateValue>;
}

/** uid "monster:goblin|mm" → { kind, name, source } (display name falls back to title case). */
export function parseUid(uid: string, describe?: InstantiateOptions['describeRef']): { kind: EntityKind; name: string; source: string } | null {
  const colon = uid.indexOf(':');
  const pipe = uid.lastIndexOf('|');
  if (colon < 1 || pipe < colon) return null;
  const kind = uid.slice(0, colon);
  if (!isKind(kind)) return null;
  const info = describe?.(uid);
  return { kind, name: info?.name ?? toTitleCase(uid.slice(colon + 1, pipe)), source: info?.source ?? uid.slice(pipe + 1).toUpperCase() };
}

function tagMarkup(uid: string, describe?: InstantiateOptions['describeRef']): string | null {
  const ref = parseUid(uid, describe);
  return ref ? `{@${KINDS[ref.kind].tag} ${ref.name}|${ref.source}}` : null;
}

function context(opts: InstantiateOptions): Ctx {
  const types = new Map<string, VariableType>();
  const defaults = new Map<string, TemplateValue>();
  for (const v of opts.variables ?? []) {
    types.set(v.name, parseType(v.type) ?? { kind: 'text' });
    if (v.default !== undefined) defaults.set(v.name, v.default);
  }
  return { ...opts, types, defaults };
}

function valueFor(ctx: Ctx, name: string, typeExpr?: string, inlineDefault?: string): { type: VariableType; value?: TemplateValue } {
  const type = ctx.types.get(name) ?? parseType(typeExpr) ?? { kind: 'text' };
  let value: TemplateValue | undefined = ctx.values[name] ?? ctx.defaults.get(name);
  if (value === undefined && inlineDefault !== undefined) value = coerceValue(type, inlineDefault).value;
  return value === undefined ? { type } : { type, value };
}

/** A value as plain text (attributes, captions). */
function valueText(ctx: Ctx, type: VariableType, value: TemplateValue): string {
  if (type.kind === 'boolean') return value ? 'Yes' : 'No';
  if (type.kind === 'reference') return parseUid(String(value), ctx.describeRef)?.name ?? String(value);
  if (type.kind === 'pageLink') return ctx.pageTitle?.(String(value)) ?? '';
  return String(value);
}

/** A value as inline content. */
function valueNodes(ctx: Ctx, type: VariableType, value: TemplateValue, marks: Mark[] | undefined): BlockNode[] {
  const withMarks = (n: BlockNode): BlockNode => (marks?.length ? { ...n, marks } : n);
  switch (type.kind) {
    case 'dice':
      return [{ type: 'tag', attrs: { markup: `{@dice ${String(value)}}` } }];
    case 'reference': {
      const markup = tagMarkup(String(value), ctx.describeRef);
      return markup ? [{ type: 'tag', attrs: { markup } }] : [];
    }
    case 'pageLink':
      return [{ type: 'pageLink', attrs: { pageId: String(value), label: ctx.pageTitle?.(String(value)) ?? '' } }];
    default: {
      const text = valueText(ctx, type, value);
      return text ? [withMarks({ type: 'text', text })] : [];
    }
  }
}

function placeholder(name: string, type: VariableType, label?: string): BlockNode {
  return { type: 'placeholder', attrs: { name, valueType: formatType(type), label: label ?? '' } };
}

function label(ctx: Ctx, name: string) {
  return ctx.variables?.find((v) => v.name === name)?.label;
}

function textNodes(ctx: Ctx, node: BlockNode): BlockNode[] {
  const text = node.text ?? '';
  if (!text.includes('{{') && !text.includes('\\{{')) return text ? [node] : [];
  const out: BlockNode[] = [];
  const marks = node.marks;
  for (const seg of tokenize(text)) {
    if (seg.t === 'text') {
      out.push(marks?.length ? { type: 'text', text: seg.text, marks } : { type: 'text', text: seg.text });
      continue;
    }
    if (seg.name.startsWith(RULES_PREFIX)) {
      const term = ctx.terminology?.[seg.name.slice(RULES_PREFIX.length)];
      if (term) out.push(marks?.length ? { type: 'text', text: term, marks } : { type: 'text', text: term });
      continue;
    }
    const { type, value } = valueFor(ctx, seg.name, seg.type, seg.default);
    if (value !== undefined) out.push(...valueNodes(ctx, type, value, marks));
    else if (ctx.mode === 'fields') out.push(placeholder(seg.name, type, label(ctx, seg.name)));
  }
  return out;
}

/** Strings get text substitution; binding objects get typed values. */
function instAttr(ctx: Ctx, value: unknown): unknown {
  if (typeof value === 'string') {
    if (!value.includes('{{')) return value;
    return tokenize(value)
      .map((seg) => {
        if (seg.t === 'text') return seg.text;
        if (seg.name.startsWith(RULES_PREFIX)) return ctx.terminology?.[seg.name.slice(RULES_PREFIX.length)] ?? '';
        const { type, value: v } = valueFor(ctx, seg.name, seg.type, seg.default);
        // Attributes cannot hold field nodes: an unfilled variable is left empty there
        return v === undefined ? '' : valueText(ctx, type, v);
      })
      .join('');
  }
  if (Array.isArray(value)) return value.map((v) => instAttr(ctx, v));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && typeof obj.$var === 'string') return valueFor(ctx, obj.$var).value ?? null;
    if (keys.length === 1 && typeof obj.$rulesetRef === 'string') return ctx.canonicalRef?.(obj.$rulesetRef) ?? null;
    if (keys.length === 1 && typeof obj.$rulesetTag === 'string') {
      const uid = ctx.canonicalRef?.(obj.$rulesetTag);
      return uid ? tagMarkup(uid, ctx.describeRef) : null;
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, instAttr(ctx, v)]));
  }
  return value;
}

function instNodes(ctx: Ctx, nodes: readonly BlockNode[]): BlockNode[] {
  const out: BlockNode[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      out.push(...textNodes(ctx, node));
      continue;
    }
    if (node.type === 'placeholder') {
      const name = String(node.attrs?.['name'] ?? '');
      const { type, value } = valueFor(ctx, name, String(node.attrs?.['valueType'] ?? 'text'));
      if (value !== undefined) out.push(...valueNodes(ctx, type, value, node.marks));
      else if (ctx.mode === 'fields') out.push(placeholder(name, type, String(node.attrs?.['label'] ?? '') || label(ctx, name)));
      continue;
    }
    const next: BlockNode = { type: node.type };
    if (node.attrs) {
      const { id: _id, ...attrs } = node.attrs;
      // Tag markup is a whole binding (e.g. $rulesetTag); dropping a tag whose binding resolved to nothing
      const resolved = instAttr(ctx, attrs) as Record<string, unknown>;
      if (node.type === 'tag' && typeof resolved['markup'] !== 'string') continue;
      if (Object.keys(resolved).length) next.attrs = resolved;
    }
    if (node.marks) next.marks = node.marks;
    if (node.content) next.content = instNodes(ctx, node.content);
    out.push(next);
  }
  return out;
}

/** Instantiates a plain value the way block attributes are (titles, facet defaults, property defaults). */
export function instantiateValue(value: unknown, opts: InstantiateOptions): unknown {
  return instAttr(context(opts), value);
}

/** Instantiates template content (block nodes) with values. */
export function instantiate(content: readonly BlockNode[], opts: InstantiateOptions): BlockNode[] {
  return instNodes(context(opts), content);
}

/**
 * Re-renders a linked template instance from (new) template content and the instance's stored values.
 * Detached instances are returned unchanged.
 */
export function renderLinked(instance: BlockNode, template: { content: readonly BlockNode[]; variables: readonly TemplateVariable[]; version: number }, opts: Omit<InstantiateOptions, 'mode' | 'values' | 'variables'>): BlockNode {
  if (instance.attrs?.['detached']) return instance;
  const values = (instance.attrs?.['values'] as Record<string, TemplateValue> | undefined) ?? {};
  const content = instantiate(template.content, { ...opts, mode: 'fill', values, variables: template.variables });
  return { ...instance, attrs: { ...instance.attrs, version: template.version }, content: content.length ? content : [{ type: 'paragraph' }] };
}
