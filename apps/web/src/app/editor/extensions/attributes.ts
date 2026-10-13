import { Extension } from '@tiptap/core';

/** Block types that carry the common block attributes (id, visibility, revealed). */
export const BLOCK_NODE_TYPES = [
  'paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'horizontalRule',
  'callout', 'readAloud', 'secret', 'table', 'statGrid', 'image', 'gallery', 'refEmbed', 'pageEmbed', 'query', 'columns',
  'details', 'tabs', 'encounter', 'loot', 'templateInstance', 'unknownBlock',
];

/** Adds id / visibility / revealed to every block so per-block DM-only content and reveal toggles work. */
export const BlockAttributes = Extension.create({
  name: 'blockAttributes',
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_NODE_TYPES,
        attributes: {
          id: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => el.getAttribute('data-id'),
            renderHTML: (attrs) => (attrs['id'] ? { 'data-id': attrs['id'] } : {}),
          },
          visibility: {
            default: 'inherit',
            parseHTML: (el) => (el.getAttribute('data-visibility') === 'dm' ? 'dm' : 'inherit'),
            renderHTML: (attrs) => (attrs['visibility'] === 'dm' ? { 'data-visibility': 'dm' } : {}),
          },
          revealed: {
            default: false,
            parseHTML: (el) => el.getAttribute('data-revealed') === 'true',
            renderHTML: (attrs) => (attrs['revealed'] ? { 'data-revealed': 'true' } : {}),
          },
        },
      },
    ];
  },
});

/** JSON-valued attribute stored in a data-* attribute for copy/paste round trips. */
export function jsonAttr<T>(name: string, fallback: T) {
  return {
    default: fallback,
    parseHTML: (el: HTMLElement) => {
      const raw = el.getAttribute(`data-${name}`);
      if (!raw) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    },
    renderHTML: (attrs: Record<string, unknown>) => ({ [`data-${name}`]: JSON.stringify(attrs[name] ?? fallback) }),
  };
}

export function stringAttr(name: string, fallback: string | null = null) {
  return {
    default: fallback,
    parseHTML: (el: HTMLElement) => el.getAttribute(`data-${name}`) ?? fallback,
    renderHTML: (attrs: Record<string, unknown>) => (attrs[name] != null ? { [`data-${name}`]: String(attrs[name]) } : {}),
  };
}
