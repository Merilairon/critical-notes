/**
 * Template variables. A variable is declared by its first `{{name: type = default}}` placeholder and stored
 * normalized; values are typed and validated before substitution.
 */
import { isKind, parseDice } from '@cn/fivetools';

export type VariableType =
  | { kind: 'text' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'date' }
  | { kind: 'dice' }
  | { kind: 'pageLink'; pageType?: string }
  | { kind: 'select'; options: string[] }
  | { kind: 'reference'; refKind: string };

/** Values as stored: references are entity uids, page links page ids, dates YYYY-MM-DD. */
export type TemplateValue = string | number | boolean;

export interface TemplateVariable {
  name: string;
  /** Type expression as written: text, number, boolean, date, dice, pageLink, select(a|b), reference<monster>. */
  type: string;
  label?: string;
  default?: TemplateValue;
  required?: boolean;
}

/** Names under this prefix come from the campaign's ruleset (e.g. `{{rules.race}}` → "Race" or "Species"). */
export const RULES_PREFIX = 'rules.';

export function parseType(expr: string | undefined): VariableType | null {
  const raw = (expr ?? 'text').trim();
  const lower = raw.toLowerCase();
  switch (lower) {
    case '':
    case 'text':
    case 'string':
      return { kind: 'text' };
    case 'number':
    case 'int':
      return { kind: 'number' };
    case 'boolean':
    case 'bool':
      return { kind: 'boolean' };
    case 'date':
      return { kind: 'date' };
    case 'dice':
      return { kind: 'dice' };
    case 'page':
    case 'pagelink':
      return { kind: 'pageLink' };
  }
  const generic = /^(\w+)\s*<\s*([\w-]+)\s*>$/.exec(raw);
  if (generic) {
    const [, base, arg] = generic as unknown as [string, string, string];
    if (['reference', 'ref'].includes(base.toLowerCase()) && isKind(arg)) return { kind: 'reference', refKind: arg };
    if (['pagelink', 'page'].includes(base.toLowerCase())) return { kind: 'pageLink', pageType: arg };
    return null;
  }
  const select = /^select\s*\((.*)\)$/i.exec(raw);
  if (select) {
    const options = select[1]!
      .split(/[|,]/)
      .map((o) => o.trim())
      .filter(Boolean);
    return options.length ? { kind: 'select', options } : null;
  }
  return null;
}

/** The canonical type expression (as stored). */
export function formatType(t: VariableType): string {
  switch (t.kind) {
    case 'select':
      return `select(${t.options.join('|')})`;
    case 'reference':
      return `reference<${t.refKind}>`;
    case 'pageLink':
      return t.pageType ? `pageLink<${t.pageType}>` : 'pageLink';
    default:
      return t.kind;
  }
}

export interface ValueIssue {
  variable: string;
  message: string;
}

/** Coerces one raw value (from a form or JSON) to the variable's type. `undefined` means "no value". */
export function coerceValue(type: VariableType, raw: unknown): { value?: TemplateValue; error?: string } {
  if (raw === undefined || raw === null || raw === '') return {};
  switch (type.kind) {
    case 'text': {
      const s = String(raw);
      return s.length > 2000 ? { error: 'Text is too long (max 2000 characters)' } : { value: s };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      return Number.isFinite(n) ? { value: n } : { error: 'Must be a number' };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw };
      const s = String(raw).trim().toLowerCase();
      if (['true', 'yes', '1', 'on'].includes(s)) return { value: true };
      if (['false', 'no', '0', 'off'].includes(s)) return { value: false };
      return { error: 'Must be yes or no' };
    }
    case 'date': {
      const s = String(raw).trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? { value: s } : { error: 'Use YYYY-MM-DD' };
    }
    case 'dice': {
      const s = String(raw).trim();
      return parseDice(s) ? { value: s } : { error: `"${s}" is not a dice expression` };
    }
    case 'select': {
      const s = String(raw);
      return type.options.includes(s) ? { value: s } : { error: `Must be one of: ${type.options.join(', ')}` };
    }
    case 'reference': {
      const s = String(raw).trim().toLowerCase();
      if (!/^[a-z]+:[^|]+\|.+$/.test(s)) return { error: 'Not a reference' };
      return s.startsWith(`${type.refKind.toLowerCase()}:`) ? { value: s } : { error: `Must be a ${type.refKind}` };
    }
    case 'pageLink': {
      const s = String(raw).trim();
      return s.length <= 64 ? { value: s } : { error: 'Not a page' };
    }
  }
}

/** Validates and types a set of values; defaults fill gaps, required variables must end up with a value. */
export function coerceValues(
  variables: readonly TemplateVariable[],
  raw: Record<string, unknown>,
  { requireAll = true }: { requireAll?: boolean } = {},
): { values: Record<string, TemplateValue>; issues: ValueIssue[] } {
  const values: Record<string, TemplateValue> = {};
  const issues: ValueIssue[] = [];
  for (const v of variables) {
    const type = parseType(v.type) ?? { kind: 'text' };
    const { value, error } = coerceValue(type, raw[v.name]);
    if (error) issues.push({ variable: v.name, message: error });
    const finalValue = value ?? v.default;
    if (finalValue !== undefined) values[v.name] = finalValue;
    else if (v.required && requireAll && !error) issues.push({ variable: v.name, message: 'A value is required' });
  }
  return { values, issues };
}
