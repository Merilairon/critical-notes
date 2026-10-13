/** Slash menu, [[page link]] and {@reference} suggestions. */
import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import { kindForTag, KINDS } from '@cn/fivetools';
import { createPopupRenderer, type SuggestionItem } from './popup';
import { TAG_CHOICES } from './tag-choices';
// Command typings (setHeading, insertTable, …) come from these extensions' module augmentations
import type {} from '@tiptap/extension-list';
import type {} from '@tiptap/extension-table';
import type {} from '@tiptap/starter-kit';

export interface SuggestionContext {
  /** Search campaign pages (title/text). */
  searchPages(query: string): Promise<{ id: string; title: string; icon: string | null; type: string }[]>;
  createPage(title: string): Promise<{ id: string; title: string } | null>;
  /** Autocomplete reference entities of a kind within the campaign's rules. */
  searchReference(kind: string, query: string): Promise<{ name: string; source: string }[]>;
  /** Opens the template picker; the chosen template is inserted at `pos`. Absent outside campaigns. */
  openTemplatePicker?: (pos: number) => void;
  /** False for players (editing their own character): no DM tools, templates or new pages. Defaults to true. */
  gm?: () => boolean;
}

type SlashContext = Pick<SuggestionContext, 'openTemplatePicker' | 'gm'>;

/** Blocks only a game master can use (players would hide them from themselves, or cannot run them). */
const GM_ONLY_ITEMS = new Set(['DM secret', 'Encounter', 'Loot', 'Template…']);

const insert = (editor: Editor, range: Range, content: unknown) => editor.chain().focus().deleteRange(range).insertContent(content as never).run();

const p = (text = '') => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });

export type SlashItem = SuggestionItem & { keywords: string; /** The inserted block JSON, for block items. */ content?: unknown };

/** Blocks offered by the "/" menu. */
export function slashItems(ctx?: SlashContext): SlashItem[] {
  const block = (title: string, icon: string, keywords: string, content: unknown) => ({
    title,
    icon,
    keywords,
    content,
    run: ({ editor, range }: { editor: Editor; range: Range }) => insert(editor, range, content),
  });
  const cmd = (title: string, icon: string, keywords: string, fn: (editor: Editor, range: Range) => void) => ({
    title,
    icon,
    keywords,
    run: ({ editor, range }: { editor: Editor; range: Range }) => fn(editor, range),
  });
  const items: SlashItem[] = [
    cmd('Text', '¶', 'paragraph plain', (e, r) => e.chain().focus().deleteRange(r).setParagraph().run()),
    cmd('Heading', 'H2', 'title h2 section', (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run()),
    cmd('Subheading', 'H3', 'h3', (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run()),
    cmd('Small heading', 'H4', 'h4', (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 4 }).run()),
    cmd('Bulleted list', '•', 'ul unordered', (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run()),
    cmd('Numbered list', '1.', 'ol ordered', (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run()),
    cmd('Checklist', '☑', 'todo task prep', (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run()),
    cmd('Quote', '❝', 'blockquote', (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run()),
    cmd('Divider', '—', 'hr rule line', (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run()),
    block('Callout', '💡', 'note info warning box', { type: 'callout', attrs: { tone: 'note' }, content: [p()] }),
    block('Read-aloud', '📖', 'boxed text narration', { type: 'readAloud', content: [p()] }),
    block('DM secret', '🔒', 'hidden private gm', { type: 'secret', content: [p()] }),
    cmd('Table', '▦', 'grid', (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()),
    block('Roll table', '🎲', 'random encounter d6 d20', {
      type: 'table',
      attrs: { roll: 'd6' },
      content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', content: [p('d6')] }, { type: 'tableHeader', content: [p('Result')] }] },
        ...['1', '2', '3', '4', '5', '6'].map((n) => ({ type: 'tableRow', content: [{ type: 'tableCell', content: [p(n)] }, { type: 'tableCell', content: [p()] }] })),
      ],
    }),
    block('Stat grid', '📊', 'facts key value', { type: 'statGrid', attrs: { items: [{ label: '', value: '' }], columns: 2 } }),
    block('Image or map', '🖼️', 'picture upload map', { type: 'image' }),
    block('Reference embed', '📚', 'statblock monster spell item embed', { type: 'refEmbed' }),
    block('Page card', '🔗', 'embed link page', { type: 'pageEmbed' }),
    block('Query', '🔎', 'list filter database npcs here', { type: 'query' }),
    block('2 columns', '▥', 'layout side', { type: 'columns', content: [{ type: 'column', content: [p()] }, { type: 'column', content: [p()] }] }),
    block('3 columns', '▥', 'layout', { type: 'columns', content: [0, 1, 2].map(() => ({ type: 'column', content: [p()] })) }),
    block('Collapsible section', '▸', 'details toggle fold', {
      type: 'details',
      content: [{ type: 'detailsSummary', content: [{ type: 'text', text: 'Details' }] }, { type: 'detailsContent', content: [p()] }],
    }),
    block('Tabs', '🗂️', 'tab layout', { type: 'tabs', content: [{ type: 'tab', attrs: { title: 'Tab 1' }, content: [p()] }, { type: 'tab', attrs: { title: 'Tab 2' }, content: [p()] }] }),
    block('Encounter', '⚔️', 'combat fight initiative', { type: 'encounter' }),
    block('Loot', '💰', 'treasure reward', { type: 'loot' }),
    ...(ctx?.openTemplatePicker
      ? [
          cmd('Template…', '🧩', 'template insert trap npc snippet', (e, r) => {
            e.chain().focus().deleteRange(r).run();
            ctx.openTemplatePicker!(e.state.selection.from);
          }),
        ]
      : []),
    cmd('Page link', '[[', 'mention link', (e, r) => e.chain().focus().deleteRange(r).insertContent('[[').run()),
    cmd('5etools reference', '{@', 'spell creature item condition tag', (e, r) => e.chain().focus().deleteRange(r).insertContent('{@').run()),
  ];
  return ctx?.gm?.() === false ? items.filter((i) => !GM_ONLY_ITEMS.has(i.title)) : items;
}

/** Slash-menu items matching what was typed after "/" (title substring or keyword). */
export function filterSlashItems(query: string, limit = 30, ctx?: SlashContext): SlashItem[] {
  const q = query.trim().toLowerCase();
  const items = slashItems(ctx);
  if (!q) return items.slice(0, limit);
  // Titles that start with the query first, then titles containing it, then keyword matches
  const score = (i: SlashItem) => (i.title.toLowerCase().startsWith(q) ? 0 : i.title.toLowerCase().includes(q) ? 1 : i.keywords.includes(q) ? 2 : -1);
  return items
    .map((item, ix) => ({ item, ix, s: score(item) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.ix - b.ix)
    .map((x) => x.item)
    .slice(0, limit);
}

function insertTag(editor: Editor, range: Range, markup: string) {
  editor.chain().focus().deleteRange(range).insertContent([{ type: 'tag', attrs: { markup } }, { type: 'text', text: ' ' }]).run();
}

export function createSuggestions(ctx: SuggestionContext) {
  const render = createPopupRenderer();

  const SlashCommand = Extension.create({
    name: 'slashCommand',
    addProseMirrorPlugins() {
      return [
        Suggestion<SuggestionItem>({
          editor: this.editor,
          pluginKey: new PluginKey('slashCommand'),
          char: '/',
          startOfLine: false,
          allowSpaces: false,
          items: ({ query }) => {
            const q = query.toLowerCase();
            return filterSlashItems(q, 30, ctx);
          },
          command: ({ editor, range, props }) => props.run({ editor, range } as never),
          render,
        }),
      ];
    },
  });

  const PageLinkSuggestion = Extension.create({
    name: 'pageLinkSuggestion',
    addProseMirrorPlugins() {
      return [
        Suggestion<SuggestionItem>({
          editor: this.editor,
          pluginKey: new PluginKey('pageLinkSuggestion'),
          char: '[[',
          allowSpaces: true,
          items: async ({ query }) => {
            const q = query.replace(/\]+$/, '').trim();
            const pages = q ? await ctx.searchPages(q).catch(() => []) : [];
            const items: SuggestionItem[] = pages.map((pg) => ({
              title: pg.title,
              icon: pg.icon ?? '📄',
              subtitle: pg.type,
              run: ({ editor, range }) =>
                editor.chain().focus().deleteRange(range).insertContent([{ type: 'pageLink', attrs: { pageId: pg.id, label: pg.title } }, { type: 'text', text: ' ' }]).run(),
            }));
            if (q && ctx.gm?.() !== false && !pages.some((pg) => pg.title.toLowerCase() === q.toLowerCase())) {
              items.push({
                title: `Create page “${q}”`,
                icon: '＋',
                run: async ({ editor, range }) => {
                  const created = await ctx.createPage(q);
                  if (created) editor.chain().focus().deleteRange(range).insertContent([{ type: 'pageLink', attrs: { pageId: created.id, label: created.title } }, { type: 'text', text: ' ' }]).run();
                },
              });
            }
            return items;
          },
          command: ({ editor, range, props }) => props.run({ editor, range } as never),
          render,
        }),
      ];
    },
  });

  const TagSuggestion = Extension.create({
    name: 'tagSuggestion',
    addProseMirrorPlugins() {
      return [
        Suggestion<SuggestionItem>({
          editor: this.editor,
          pluginKey: new PluginKey('tagSuggestion'),
          char: '{@',
          allowSpaces: true,
          items: async ({ query }) => {
            const [tagPart = '', ...rest] = query.replace(/\}+$/, '').split(' ');
            const text = rest.join(' ').trim();
            const choice = TAG_CHOICES.find((t) => t.tag === tagPart.toLowerCase());
            if (!choice || query.indexOf(' ') < 0) {
              return TAG_CHOICES.filter((t) => !tagPart || t.tag.startsWith(tagPart.toLowerCase()) || t.label.toLowerCase().includes(tagPart.toLowerCase())).map((t) => ({
                title: t.label,
                subtitle: `{@${t.tag} …}`,
                icon: '{@',
                run: ({ editor, range }) => editor.chain().focus().insertContentAt(range, `{@${t.tag} `).run(),
              }));
            }
            if (choice.free) {
              const value = text || choice.free;
              return [{ title: `{@${choice.tag} ${value}}`, subtitle: 'Insert', icon: '🎲', run: ({ editor, range }) => insertTag(editor, range, `{@${choice.tag} ${value}}`) }];
            }
            const kind = kindForTag(choice.tag);
            if (!kind || !text) return [];
            const hits = await ctx.searchReference(kind, text).catch(() => []);
            return hits.map((h) => ({
              title: h.name,
              subtitle: `${KINDS[kind].label} · ${h.source}`,
              run: ({ editor, range }) => insertTag(editor, range, `{@${choice.tag} ${h.name}|${h.source}}`),
            }));
          },
          command: ({ editor, range, props }) => props.run({ editor, range } as never),
          render,
        }),
      ];
    },
  });

  return [SlashCommand, PageLinkSuggestion, TagSuggestion];
}
