/** Template definitions, page-template inheritance, and the import/export format with migrations. */
import type { BlockNode } from '@cn/blocks';
import type { TemplateVariable } from './variables';

export type TemplateKind = 'block' | 'page';

export interface BlockTemplateDef {
  variables: TemplateVariable[];
  content: BlockNode[];
}

/** A custom property a page template adds to the campaign (if missing) and sets on new pages. */
export interface TemplateProperty {
  key: string;
  label: string;
  type: string;
  options?: string[] | null;
  required?: boolean;
  default?: unknown;
  dmOnly?: boolean;
  refKind?: string | null;
}

/** A child page created with the page; `templateRef` is a template id or `builtin:<key>`. */
export interface TemplateChild {
  title: string;
  templateRef?: string | null;
}

export interface PageTemplateDef {
  pageType: string;
  /** Parent template (id or `builtin:<key>`). */
  extendsRef?: string | null;
  /** How this template's body combines with its parent's. */
  bodyMode: 'append' | 'replace';
  defaults: { title?: string; icon?: string | null; visibility?: 'dm' | 'all' | 'selected'; tags?: string[] };
  /** Typed-facet field defaults (e.g. an NPC's status). */
  facet: Record<string, unknown>;
  properties: TemplateProperty[];
  variables: TemplateVariable[];
  body: BlockNode[];
  children: TemplateChild[];
}

export type TemplateDef = BlockTemplateDef | PageTemplateDef;

export const MAX_EXTENDS_DEPTH = 8;

export class TemplateError extends Error {}

/**
 * Merges a page template with its `extends` chain (root first): properties and variables merge by key/name
 * (the more specific template wins), facet and defaults merge, tags and children accumulate, and the body is
 * appended to or replaces the parent's.
 */
export function resolvePageTemplate(ref: string, lookup: (ref: string) => { id: string; def: PageTemplateDef } | null): { def: PageTemplateDef; chain: string[] } {
  const chain: { id: string; def: PageTemplateDef }[] = [];
  const seen = new Set<string>();
  let cur: string | null | undefined = ref;
  while (cur) {
    const t = lookup(cur);
    if (!t) throw new TemplateError(chain.length ? `The parent template "${cur}" was not found` : 'Template not found');
    if (seen.has(t.id)) throw new TemplateError('Templates extend each other in a loop');
    if (chain.length >= MAX_EXTENDS_DEPTH) throw new TemplateError(`Templates can extend at most ${MAX_EXTENDS_DEPTH} levels deep`);
    seen.add(t.id);
    chain.unshift(t);
    cur = t.def.extendsRef;
  }
  const merged = chain.reduce<PageTemplateDef>(
    (acc, { def }) => ({
      pageType: def.pageType || acc.pageType,
      extendsRef: null,
      bodyMode: 'append',
      defaults: {
        ...acc.defaults,
        ...Object.fromEntries(Object.entries(def.defaults).filter(([, v]) => v !== undefined)),
        tags: [...new Set([...(acc.defaults.tags ?? []), ...(def.defaults.tags ?? [])])],
      },
      facet: { ...acc.facet, ...def.facet },
      properties: mergeBy(acc.properties, def.properties, (p) => p.key),
      variables: mergeBy(acc.variables, def.variables, (v) => v.name),
      body: def.bodyMode === 'replace' ? [...def.body] : [...acc.body, ...def.body],
      children: [...acc.children, ...def.children],
    }),
    { pageType: 'generic', extendsRef: null, bodyMode: 'append', defaults: {}, facet: {}, properties: [], variables: [], body: [], children: [] },
  );
  return { def: merged, chain: chain.map((c) => c.id) };
}

function mergeBy<T>(base: readonly T[], over: readonly T[], key: (t: T) => string): T[] {
  const out = new Map(base.map((b) => [key(b), b]));
  for (const o of over) out.set(key(o), { ...(out.get(key(o)) ?? {}), ...o });
  return [...out.values()];
}

// region Import/export format

export const TEMPLATE_FORMAT = 'critical-notes/template';
export const LIBRARY_FORMAT = 'critical-notes/template-library';
/** Bump when the exported shape changes, and add a migration from the previous version. */
export const TEMPLATE_SCHEMA_VERSION = 1;

export interface ExportedTemplate {
  kind: TemplateKind;
  name: string;
  description?: string;
  icon?: string | null;
  tags?: string[];
  version?: number;
  /** Built-in templates keep their key so re-imports can be recognized. */
  builtinKey?: string | null;
  definition: TemplateDef;
}

export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/** migrations[n] upgrades a document from schema version n to n + 1. */
export const MIGRATIONS: Record<number, Migration> = {};

export function exportTemplates(templates: ExportedTemplate[]): Record<string, unknown> {
  return templates.length === 1
    ? { format: TEMPLATE_FORMAT, schemaVersion: TEMPLATE_SCHEMA_VERSION, template: templates[0] }
    : { format: LIBRARY_FORMAT, schemaVersion: TEMPLATE_SCHEMA_VERSION, templates };
}

/**
 * Reads an exported template or library, upgrading older schema versions step by step. Files from a newer
 * version are refused with a clear message instead of being half-imported.
 */
export function readTemplateExport(
  raw: unknown,
  { migrations = MIGRATIONS, current = TEMPLATE_SCHEMA_VERSION }: { migrations?: Record<number, Migration>; current?: number } = {},
): { templates: ExportedTemplate[]; skipped: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TemplateError('Not a Critical Notes template file');
  let doc = raw as Record<string, unknown>;
  if (doc.format !== TEMPLATE_FORMAT && doc.format !== LIBRARY_FORMAT) throw new TemplateError('Not a Critical Notes template file (unknown "format")');
  const version = doc.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) throw new TemplateError('The file has no valid "schemaVersion"');
  if (version > current) {
    throw new TemplateError(`This file uses template format ${version}, made by a newer version of Critical Notes (this one reads up to ${current}). Update the app to import it.`);
  }
  for (let v = version; v < current; v++) {
    const m = migrations[v];
    if (!m) throw new TemplateError(`No upgrade from template format ${v} to ${v + 1}`);
    doc = { ...m(doc), schemaVersion: v + 1 };
  }
  const list = doc.format === TEMPLATE_FORMAT ? [doc.template] : Array.isArray(doc.templates) ? doc.templates : [];
  const templates: ExportedTemplate[] = [];
  const skipped: string[] = [];
  for (const [i, t] of list.entries()) {
    const problem = templateProblem(t);
    if (problem) skipped.push(`Template ${i + 1}: ${problem}`);
    else templates.push(t as ExportedTemplate);
  }
  return { templates, skipped };
}

function templateProblem(t: unknown): string | null {
  if (!t || typeof t !== 'object') return 'not an object';
  const o = t as Record<string, unknown>;
  if (o.kind !== 'block' && o.kind !== 'page') return 'unknown kind';
  if (typeof o.name !== 'string' || !o.name.trim()) return 'no name';
  const def = o.definition as Record<string, unknown> | undefined;
  if (!def || typeof def !== 'object') return 'no definition';
  if (o.kind === 'block' && !Array.isArray(def.content)) return 'a block template needs "content"';
  if (o.kind === 'page' && (!Array.isArray(def.body) || typeof def.pageType !== 'string')) return 'a page template needs "pageType" and "body"';
  return null;
}

// endregion
