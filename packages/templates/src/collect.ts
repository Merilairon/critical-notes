/** Finding the variables a template uses: placeholders in text and attributes, `$var` bindings, field nodes. */
import type { BlockNode } from '@cn/blocks';
import { tokenize } from './tokenize';
import { coerceValue, formatType, parseType, RULES_PREFIX, type TemplateValue, type TemplateVariable } from './variables';

export interface CollectResult {
  variables: TemplateVariable[];
  issues: string[];
  /** Variables whose type is written in the content (others take the type set on the template). */
  typed: Set<string>;
}

interface Declared {
  variable: TemplateVariable;
  explicitType: boolean;
}

export function collectVariables(content: readonly BlockNode[]): CollectResult {
  const found = new Map<string, Declared>();
  const issues: string[] = [];

  const declare = (name: string, typeExpr: string | undefined, dflt?: string, label?: string) => {
    if (!name || name.startsWith(RULES_PREFIX)) return;
    const parsed = typeExpr ? parseType(typeExpr) : null;
    if (typeExpr && !parsed) issues.push(`Unknown type "${typeExpr}" for {{${name}}} (using text)`);
    const type = parsed ?? { kind: 'text' as const };
    let defaultValue: TemplateValue | undefined;
    if (dflt !== undefined && dflt !== '') {
      const c = coerceValue(type, dflt);
      if (c.error) issues.push(`Default for {{${name}}}: ${c.error}`);
      defaultValue = c.value;
    }
    const existing = found.get(name);
    if (!existing) {
      found.set(name, {
        variable: { name, type: formatType(type), ...(label ? { label } : {}), ...(defaultValue !== undefined ? { default: defaultValue } : {}) },
        explicitType: !!parsed,
      });
      return;
    }
    if (parsed && !existing.explicitType) {
      existing.variable.type = formatType(parsed);
      existing.explicitType = true;
    } else if (parsed && existing.variable.type !== formatType(parsed)) {
      issues.push(`{{${name}}} is declared as ${existing.variable.type} and as ${formatType(parsed)} (the first one wins)`);
    }
    if (defaultValue !== undefined && existing.variable.default === undefined) existing.variable.default = defaultValue;
    if (label && !existing.variable.label) existing.variable.label = label;
  };

  const scanString = (s: string) => {
    if (!s.includes('{{')) return;
    for (const seg of tokenize(s)) if (seg.t === 'var') declare(seg.name, seg.type, seg.default);
  };
  const scanAttr = (v: unknown) => {
    if (typeof v === 'string') scanString(v);
    else if (Array.isArray(v)) v.forEach(scanAttr);
    else if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      if (typeof obj.$var === 'string' && Object.keys(obj).length === 1) declare(obj.$var, undefined);
      else Object.values(obj).forEach(scanAttr);
    }
  };
  const visit = (nodes: readonly BlockNode[]) => {
    for (const n of nodes) {
      if (n.type === 'text') scanString(n.text ?? '');
      else if (n.type === 'placeholder') declare(String(n.attrs?.['name'] ?? ''), String(n.attrs?.['valueType'] ?? 'text'), undefined, String(n.attrs?.['label'] ?? '') || undefined);
      else if (n.type === 'templateInstance') continue; // a nested linked template brings its own values
      else if (n.attrs) scanAttr(n.attrs);
      if (n.content) visit(n.content);
    }
  };
  visit(content);
  return {
    variables: [...found.values()].map((d) => d.variable),
    issues,
    typed: new Set([...found.values()].filter((d) => d.explicitType).map((d) => d.variable.name)),
  };
}

/**
 * The variables of edited content, keeping what the author set on the stored ones (label, required, and the
 * default when the type did not change). Variables no longer used are dropped.
 */
export function syncVariables(content: readonly BlockNode[], stored: readonly TemplateVariable[]): CollectResult {
  const { variables, issues, typed } = collectVariables(content);
  const byName = new Map(stored.map((v) => [v.name, v]));
  return {
    issues,
    typed,
    variables: variables.map((v) => {
      const old = byName.get(v.name);
      if (!old) return v;
      const type = typed.has(v.name) ? v.type : old.type;
      const sameType = old.type === type;
      return {
        ...v,
        type,
        ...(old.label ? { label: old.label } : {}),
        ...(old.required ? { required: true } : {}),
        ...(sameType && old.default !== undefined && v.default === undefined ? { default: old.default } : {}),
      };
    }),
  };
}
