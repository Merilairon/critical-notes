/**
 * Names content tables after the nearest heading above them (aria-labelledby), without a caption field
 * in the data: the heading gets an id, the table points at it, and a table with no heading above it stays
 * unnamed. Only headings that are in the same rendered view count, so a heading the viewer cannot see
 * (a DM-only block, a player's view) never names a table.
 */
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { BASE_LEVEL, clampLevel } from './heading-levels';

let nextScope = 0;
/** Heading ids already handed out per read-only scope: a counter that only goes up, so a heading inserted mid-view never reuses an id. */
const issued = new Map<string, number>();

/** A prefix that is unique to one editor or one read-only view on the page. */
export const newTableNameScope = () => `tn${++nextScope}`;

// ---- read-only views (the rendered DOM) ----

const HEADINGS = 'h1,h2,h3,h4,h5,h6';
/** Reference embeds bring their own headings and tables: not part of the page's own content, so they never name a page table (heading-levels.ts still levels them). */
const SKIP = '.cn-embed';

/** Gives every heading above a content table an id and points the table at the nearest one. Idempotent. */
export function nameTablesInDom(root: HTMLElement, scope: string): void {
  let heading: HTMLElement | null = null;
  for (const el of root.querySelectorAll<HTMLElement>(`${HEADINGS},table`)) {
    if (el.closest(SKIP)) continue;
    if (el.matches(HEADINGS)) {
      heading = el.textContent?.trim() ? el : null;
      if (heading && !heading.id) {
        const n = issued.get(scope) ?? 0;
        issued.set(scope, n + 1);
        heading.id = `${scope}-h${n}`;
      }
    } else if (heading) {
      if (el.getAttribute('aria-labelledby') !== heading.id) el.setAttribute('aria-labelledby', heading.id);
    } else if (el.getAttribute('aria-labelledby')?.startsWith(`${scope}-`)) {
      el.removeAttribute('aria-labelledby');
    }
  }
}

// ---- the editor (ProseMirror) ----

export interface TableNamePlan {
  /** Heading nodes that need an id (document position and id) and the level to expose when it differs from the tag. */
  headings: { pos: number; size: number; id: string; level: number | null }[];
  /** Table nodes in document order: position and the id of the heading that names each (null: none above it). */
  tables: { pos: number; label: string | null }[];
}

/**
 * Pure: which heading names which table, by document order, and which headings need an `aria-level`.
 * Empty headings name nothing. Like the DOM pass it also looks inside table cells. Computed once per document by the plugin.
 */
export function planTableNames(doc: PMNode, scope: string): TableNamePlan {
  const plan: TableNamePlan = { headings: [], tables: [] };
  let current: string | null = null;
  let previous = BASE_LEVEL;
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const id = `${scope}-h${plan.headings.length}`;
      const natural = Number(node.attrs['level']) || 2;
      const level = clampLevel(natural, previous);
      previous = level;
      plan.headings.push({ pos, size: node.nodeSize, id, level: level !== natural ? level : null });
      current = node.textContent.trim() ? id : null;
      return false;
    }
    if (node.type.name === 'table') plan.tables.push({ pos, label: current });
    return true;
  });
  return plan;
}

const key = new PluginKey('tableNames');

/** Editor extension: heading ids as decorations (not saved) and aria-labelledby on each table element. */
export const TableNames = Extension.create<{ scope: string }>({
  name: 'tableNames',
  addOptions: () => ({ scope: 'tn0' }),
  addProseMirrorPlugins() {
    const scope = this.options.scope;
    // One plan per document: the decorations and the table pass share it
    let cachedDoc: PMNode | null = null;
    let cachedPlan: TableNamePlan = { headings: [], tables: [] };
    let cachedSet = DecorationSet.empty;
    const planFor = (doc: PMNode) => {
      if (doc !== cachedDoc) {
        cachedDoc = doc;
        cachedPlan = planTableNames(doc, scope);
        cachedSet = DecorationSet.create(
          doc,
          cachedPlan.headings.map((h) => Decoration.node(h.pos, h.pos + h.size, { id: h.id, ...(h.level ? { 'aria-level': String(h.level) } : {}) })),
        );
      }
      return cachedPlan;
    };
    return [
      new Plugin({
        key,
        props: {
          decorations: (state) => {
            planFor(state.doc);
            return cachedSet;
          },
        },
        view: (initial) => {
          const apply = (view: EditorView) => {
            for (const { pos, label } of planFor(view.state.doc).tables) {
              const dom = view.nodeDOM(pos) as HTMLElement | null;
              const table = dom instanceof HTMLTableElement ? dom : dom?.querySelector('table');
              if (!table) continue;
              if (label) {
                if (table.getAttribute('aria-labelledby') !== label) table.setAttribute('aria-labelledby', label);
              } else if (table.hasAttribute('aria-labelledby')) table.removeAttribute('aria-labelledby');
            }
          };
          apply(initial);
          return { update: (view, prev) => (view.state.doc !== prev.doc ? apply(view) : undefined) };
        },
      }),
    ];
  },
});
