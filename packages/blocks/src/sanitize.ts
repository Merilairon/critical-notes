/**
 * Validates and sanitizes a Block Document before it is stored. Never throws: problems are reported as
 * issues and the offending part is repaired (defaults), neutralized (unknown blocks are wrapped as
 * `unknownBlock`, preserving the raw JSON) or dropped (unsafe marks, invalid inline nodes).
 */
import { stripTags } from '@cn/fivetools';
import { SCHEMA_VERSION, type BlockDocument, type BlockNode, type Mark } from './doc';
import { blockType, commonBlockAttrs, MARK_TYPES } from './registry';

export interface SanitizeOptions {
  /** Assigns ids to blocks that lack one. */
  newId?: () => string;
  maxNodes?: number;
  maxDepth?: number;
  maxTextLength?: number;
}

export interface SanitizeResult {
  doc: BlockDocument;
  issues: string[];
}

const DEFAULTS = { maxNodes: 20000, maxDepth: 40, maxTextLength: 100_000 };

export function sanitizeDoc(input: unknown, opts: SanitizeOptions = {}): SanitizeResult {
  const issues: string[] = [];
  const limits = { ...DEFAULTS, ...opts };
  let count = 0;
  const seenIds = new Set<string>();

  if (!input || typeof input !== 'object' || (input as { type?: unknown }).type !== 'doc') {
    if (input != null) issues.push('Document is not a block document; replaced with an empty one');
    return { doc: { type: 'doc', schemaVersion: SCHEMA_VERSION, content: [{ type: 'paragraph', attrs: blockAttrs('paragraph', {}) }] }, issues };
  }

  function blockAttrs(type: string, raw: unknown): Record<string, unknown> {
    const def = blockType(type)!;
    const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const common = commonBlockAttrs.safeParse(source);
    const specific = def.attrs.safeParse(source);
    if (!specific.success) issues.push(`Invalid attributes on ${type}: ${specific.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    const commonData = common.success ? common.data : commonBlockAttrs.parse({});
    let id = commonData.id;
    if (!id || seenIds.has(id)) id = opts.newId ? opts.newId() : id;
    if (id) seenIds.add(id);
    return { ...(specific.success ? specific.data : def.attrs.parse({})), ...commonData, id };
  }

  function sanitizeMarks(marks: unknown): Mark[] | undefined {
    if (!Array.isArray(marks)) return undefined;
    const out: Mark[] = [];
    for (const m of marks) {
      if (!m || typeof m !== 'object' || typeof (m as Mark).type !== 'string') continue;
      const schema = MARK_TYPES[(m as Mark).type];
      if (!schema) {
        issues.push(`Dropped unknown mark "${(m as Mark).type}"`);
        continue;
      }
      const parsed = schema.safeParse((m as Mark).attrs ?? {});
      if (!parsed.success) {
        issues.push(`Dropped invalid ${(m as Mark).type} mark`);
        continue;
      }
      out.push(Object.keys(parsed.data).length ? { type: (m as Mark).type, attrs: parsed.data } : { type: (m as Mark).type });
    }
    return out.length ? out : undefined;
  }

  function inline(node: unknown): BlockNode[] {
    if (++count > limits.maxNodes) return [];
    if (!node || typeof node !== 'object') return [];
    const n = node as BlockNode;
    if (n.type === 'text') {
      const text = typeof n.text === 'string' ? n.text.slice(0, limits.maxTextLength) : '';
      if (!text) return [];
      const marks = sanitizeMarks(n.marks);
      return [marks ? { type: 'text', text, marks } : { type: 'text', text }];
    }
    const def = blockType(n.type);
    if (def && def.kind === 'inline') {
      const parsed = def.attrs.safeParse(n.attrs ?? {});
      if (parsed.success) return [Object.keys(parsed.data).length ? { type: n.type, attrs: parsed.data } : { type: n.type }];
      issues.push(`Invalid ${n.type} replaced by text`);
      const fallback = n.type === 'tag' ? stripTags(String(n.attrs?.markup ?? '')) : String(n.attrs?.label ?? n.text ?? '');
      return fallback ? [{ type: 'text', text: fallback }] : [];
    }
    if (def && def.kind === 'block') {
      // A block where inline content is expected: keep its text
      issues.push(`Flattened ${n.type} inside inline content`);
      return (n.content ?? []).flatMap(inline);
    }
    issues.push(`Dropped unknown inline node "${String(n.type)}"`);
    return typeof n.text === 'string' && n.text ? [{ type: 'text', text: n.text }] : [];
  }

  function block(node: unknown, depth: number): BlockNode[] {
    if (++count > limits.maxNodes) {
      if (count === limits.maxNodes + 1) issues.push('Document too large; truncated');
      return [];
    }
    if (!node || typeof node !== 'object') return [];
    const n = node as BlockNode;
    const def = blockType(n.type);
    if (!def || def.kind === 'text') {
      if (n.type === 'text' || def?.kind === 'inline') {
        // Inline content at block level: wrap in a paragraph
        const children = inline(n);
        return children.length ? [{ type: 'paragraph', attrs: blockAttrs('paragraph', {}), content: children }] : [];
      }
      issues.push(`Unknown block "${String(n.type)}" preserved as unsupported content`);
      return [{ type: 'unknownBlock', attrs: { ...blockAttrs('unknownBlock', {}), raw: n } }];
    }
    if (def.kind === 'inline') {
      return [{ type: 'paragraph', attrs: blockAttrs('paragraph', {}), content: inline(n) }];
    }
    const out: BlockNode = { type: n.type, attrs: blockAttrs(n.type, n.attrs) };
    if (depth >= limits.maxDepth) {
      issues.push('Document nested too deeply; truncated');
      return [out];
    }
    const children = Array.isArray(n.content) ? n.content : [];
    const rule = def.content;
    if (rule === 'inline') {
      const content = children.flatMap(inline);
      if (content.length) out.content = content;
    } else if (rule === 'blocks') {
      const content = children.flatMap((c) => block(c, depth + 1));
      out.content = content.length ? content : [{ type: 'paragraph', attrs: blockAttrs('paragraph', {}) }];
    } else if (typeof rule === 'object') {
      const content = children.flatMap((c) => {
        if (c && typeof c === 'object' && rule.only.includes((c as BlockNode).type)) return block(c, depth + 1);
        issues.push(`Removed ${String((c as BlockNode)?.type)} from ${n.type}`);
        return [];
      });
      if (content.length) out.content = content;
    }
    return [out];
  }

  const content = (Array.isArray((input as BlockDocument).content) ? (input as BlockDocument).content! : []).flatMap((c) => block(c, 0));
  return {
    doc: { type: 'doc', schemaVersion: SCHEMA_VERSION, content: content.length ? content : [{ type: 'paragraph', attrs: blockAttrs('paragraph', {}) }] },
    issues,
  };
}
