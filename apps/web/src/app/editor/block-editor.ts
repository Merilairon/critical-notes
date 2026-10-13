import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, effect, inject, Injector, input, output, signal, untracked, type OnDestroy, type WritableSignal } from '@angular/core';
import { Editor, Extension, type JSONContent } from '@tiptap/core';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { DragHandle } from '@tiptap/extension-drag-handle';
import { Highlight } from '@tiptap/extension-highlight';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { UniqueID } from '@tiptap/extension-unique-id';
import { Placeholder } from '@tiptap/extensions';
import type { Node as PMNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { TiptapEditorDirective } from 'ngx-tiptap';
import { firstValueFrom } from 'rxjs';
import type { BlockDoc, PageSearchHitDto, SearchHitDto } from '@cn/shared';
import { CampaignStore } from '../campaign/campaign.store';
import { api } from '../core/api';
import { ContextService } from '../core/context.service';
import { BLOCK_NODE_TYPES, BlockAttributes, stringAttr } from './extensions/attributes';
import { customNodes } from './extensions/nodes';
import { EDITOR_CONTEXT } from './editor-context';
import { createSuggestions } from './suggestion/extensions';
import { TemplateInsert } from '../templates/template-insert';
import type { BlockNode } from '@cn/blocks';

const SAFE_URL = (url: string) => /^(https?:|mailto:)/i.test(url);
const newBlockId = () => `b${Math.random().toString(36).slice(2, 10)}`;

interface MenuState {
  pos: number;
  node: PMNode;
  x: number;
  y: number;
}

/** Keyboard shortcuts for DM-only visibility (game masters only). */
const VisibilityShortcuts = Extension.create<{ enabled: () => boolean }>({
  name: 'visibilityShortcuts',
  addOptions() {
    return { enabled: () => true };
  },
  addKeyboardShortcuts() {
    const toggle = (attr: 'visibility' | 'revealed') => () => {
      if (!this.options.enabled()) return false;
      const { state } = this.editor;
      const $from = state.selection.$from;
      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (!BLOCK_NODE_TYPES.includes(node.type.name)) continue;
        const pos = $from.before(d);
        const value = attr === 'visibility' ? (node.attrs['visibility'] === 'dm' ? 'inherit' : 'dm') : !node.attrs['revealed'];
        return this.editor.commands.command(({ tr }) => {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, [attr]: value });
          return true;
        });
      }
      return false;
    };
    return { 'Mod-Shift-d': toggle('visibility'), 'Mod-Shift-r': toggle('revealed') };
  },
});

/**
 * Notion-style block editor on TipTap/ProseMirror. Emits Block Document JSON; the server sanitizes and
 * projects it. Custom blocks render through Angular node views.
 */
@Component({
  selector: 'cn-block-editor',
  imports: [TiptapEditorDirective, TemplateInsert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: EDITOR_CONTEXT, useFactory: () => ({ pageId: signal<string | null>(null) }) }],
  template: `@if (editable()) {
      <div class="sticky top-0 z-10 mb-2 flex flex-wrap items-center gap-1 rounded-md border border-line bg-panel/95 p-1 text-sm backdrop-blur" role="toolbar" aria-label="Formatting">
        @for (b of buttons; track b.label) {
          @if (!b.gm || gm()) {
            <button type="button" class="rounded px-2 py-0.5 hover:bg-panel-2" [title]="b.title" (mousedown)="$event.preventDefault()" (click)="b.run()">{{ b.label }}</button>
          }
        }
        <span class="ml-auto px-2 text-xs text-muted">Type <kbd>/</kbd> for blocks, <kbd>[[</kbd> to link a page, <kbd>{{ '{' }}&#64;</kbd> for rules</span>
      </div>
    }
    <tiptap-editor [editor]="editor" class="cn-editor cn-prose block" />
    @if (templateAt() !== null && store?.id(); as campaignId) {
      <cn-template-insert [campaignId]="campaignId" (inserted)="insertTemplate($event)" (closed)="templateAt.set(null)" />
    }
    @if (menu(); as m) {
      <div class="fixed inset-0 z-40" (click)="menu.set(null)"></div>
      <div class="cn-block-menu" role="menu" [style.left.px]="m.x" [style.top.px]="m.y">
        <div class="cn-block-menu-label">{{ m.node.type.name }}</div>
        @if (gm()) {
          <button type="button" role="menuitemcheckbox" [attr.aria-checked]="m.node.attrs['visibility'] === 'dm'" (click)="toggleAttr(m, 'visibility')">
            {{ m.node.attrs['visibility'] === 'dm' ? '✓ ' : '' }}DM only <kbd>Ctrl⇧D</kbd>
          </button>
          @if (m.node.attrs['visibility'] === 'dm' || m.node.type.name === 'secret') {
            <button type="button" role="menuitemcheckbox" [attr.aria-checked]="!!m.node.attrs['revealed']" (click)="toggleAttr(m, 'revealed')">
              {{ m.node.attrs['revealed'] ? '✓ ' : '' }}Revealed to players <kbd>Ctrl⇧R</kbd>
            </button>
          }
          <hr />
        }
        <button type="button" role="menuitem" (click)="turnInto(m, 'paragraph')">Turn into text</button>
        <button type="button" role="menuitem" (click)="turnInto(m, 'heading')">Turn into heading</button>
        @if (gm()) {
          <button type="button" role="menuitem" (click)="wrap(m, 'secret')">Wrap in DM secret</button>
        }
        <button type="button" role="menuitem" (click)="wrap(m, 'callout')">Wrap in callout</button>
        <button type="button" role="menuitem" (click)="wrap(m, 'readAloud')">Wrap in read-aloud</button>
        <hr />
        <button type="button" role="menuitem" (click)="duplicate(m)">Duplicate</button>
        <button type="button" role="menuitem" class="text-accent" (click)="remove(m)">Delete</button>
      </div>
    }`,
})
export class BlockEditor implements OnDestroy {
  readonly doc = input<BlockDoc | null>(null);
  readonly editable = input(true);
  readonly placeholder = input('Write something, or type / for blocks…');
  readonly pageId = input<string | null>(null);
  readonly changed = output<BlockDoc>();

  private readonly editorContext = inject(EDITOR_CONTEXT) as { pageId: WritableSignal<string | null> };
  readonly pageIdSignal = this.editorContext.pageId;
  protected readonly menu = signal<MenuState | null>(null);
  /** Where a chosen template goes (set by the "/" menu's Template… item). */
  protected readonly templateAt = signal<number | null>(null);

  private readonly http = inject(HttpClient);
  protected readonly store = inject(CampaignStore, { optional: true });
  private readonly context = inject(ContextService);
  private readonly injector = inject(Injector);
  /** Players edit only their own character: no DM-only controls. Outside a campaign, everything is offered. */
  protected readonly gm = () => this.store?.isGm() ?? true;
  private hovered: PMNode | null = null;
  private readonly handle = this.createHandle();

  readonly editor = new Editor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        codeBlock: false,
        link: { openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto'], isAllowedUri: SAFE_URL },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.extend({
        addAttributes() {
          return { ...this.parent?.(), roll: stringAttr('roll') };
        },
      }).configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Highlight,
      Details.configure({ persist: true }),
      DetailsSummary,
      DetailsContent,
      BlockAttributes,
      UniqueID.configure({ types: BLOCK_NODE_TYPES, attributeName: 'id', generateID: newBlockId }),
      ...customNodes(this.injector),
      ...createSuggestions({
        searchPages: async (q) => {
          const id = this.store?.id();
          if (!id) return [];
          const res = await firstValueFrom(this.http.get<{ pages: PageSearchHitDto[] }>(`/api/campaigns/${id}/search`, { params: { q, limit: 8 } }));
          const fromSearch = res.pages.map((h) => ({ id: h.pageId, title: h.title, icon: h.icon, type: h.type }));
          // include title matches from the local tree for pages not yet indexed
          const local = (this.store?.pages() ?? [])
            .filter((pg) => pg.title.toLowerCase().includes(q.toLowerCase()) && !fromSearch.some((f) => f.id === pg.id))
            .slice(0, 5)
            .map((pg) => ({ id: pg.id, title: pg.title, icon: pg.icon, type: pg.type }));
          return [...fromSearch, ...local].filter((pg) => pg.id !== this.pageIdSignal());
        },
        createPage: async (title) => {
          if (!this.store) return null;
          const page = await this.store.createPage({ title, parentId: null });
          return { id: page.id, title: page.title };
        },
        openTemplatePicker: (pos) => {
          if (this.store?.id() && this.gm()) this.templateAt.set(pos);
        },
        gm: this.gm,
        searchReference: async (kind, q) => {
          const res = await firstValueFrom(this.http.get<{ hits: SearchHitDto[] }>(api.autocomplete(kind), { params: { ...this.context.params(), q } }));
          return res.hits.map((h) => ({ name: h.name, source: h.source }));
        },
      }),
      DragHandle.configure({
        render: () => this.handle,
        onNodeChange: ({ node }) => (this.hovered = node),
      }),
      VisibilityShortcuts.configure({ enabled: this.gm }),
      Placeholder.configure({ placeholder: () => this.placeholder(), includeChildren: false }),
    ],
    editorProps: { attributes: { class: 'min-h-48 outline-none pl-6', spellcheck: 'true' } },
    onUpdate: ({ editor }) => this.changed.emit({ ...(editor.getJSON() as BlockDoc), schemaVersion: 1 }),
  });

  private loadedFrom: BlockDoc | null | undefined = undefined;

  constructor() {
    effect(() => this.pageIdSignal.set(this.pageId()));
    effect(() => {
      const doc = this.doc();
      untracked(() => {
        if (doc === this.loadedFrom) return;
        this.loadedFrom = doc;
        this.editor.commands.setContent((doc as JSONContent | null) ?? { type: 'doc', content: [{ type: 'paragraph' }] }, { emitUpdate: false });
      });
    });
    effect(() => this.editor.setEditable(this.editable()));
  }

  private createHandle(): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cn-drag-handle';
    el.textContent = '⠿';
    el.title = 'Drag to move · click for options';
    el.setAttribute('aria-label', 'Block options');
    // Hidden until the extension shows it next to a block (it would sit in the page's top-left corner)
    el.style.visibility = 'hidden';
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const pos = this.blockPosAtHandle(el);
      if (pos == null) return;
      const node = this.editor.state.doc.nodeAt(pos);
      if (!node) return;
      const rect = el.getBoundingClientRect();
      this.menu.set({ pos, node, x: Math.max(8, rect.left), y: rect.bottom + 4 });
    });
    return el;
  }

  /** Top-level block next to the drag handle. */
  private blockPosAtHandle(handle: HTMLElement): number | null {
    const rect = handle.getBoundingClientRect();
    const view = this.editor.view;
    const found = view.posAtCoords({ left: rect.right + 40, top: rect.top + rect.height / 2 });
    if (!found) return null;
    const $pos = view.state.doc.resolve(found.inside >= 0 ? found.inside : found.pos);
    if ($pos.depth === 0) return found.inside >= 0 ? found.inside : null;
    return $pos.before(1);
  }

  protected toggleAttr(m: MenuState, attr: 'visibility' | 'revealed') {
    const node = this.editor.state.doc.nodeAt(m.pos);
    if (!node) return;
    const value = attr === 'visibility' ? (node.attrs['visibility'] === 'dm' ? 'inherit' : 'dm') : !node.attrs['revealed'];
    this.editor.chain().focus().command(({ tr }) => {
      tr.setNodeMarkup(m.pos, undefined, { ...node.attrs, [attr]: value });
      return true;
    }).run();
    this.menu.set(null);
  }

  protected turnInto(m: MenuState, type: 'paragraph' | 'heading') {
    this.editor.chain().focus().setTextSelection(m.pos + 1)[type === 'heading' ? 'setHeading' : 'setParagraph']({ level: 2 } as never).run();
    this.menu.set(null);
  }

  protected wrap(m: MenuState, type: 'secret' | 'callout' | 'readAloud') {
    const node = this.editor.state.doc.nodeAt(m.pos);
    if (!node) return;
    const json = node.toJSON();
    this.editor
      .chain()
      .focus()
      .insertContentAt({ from: m.pos, to: m.pos + node.nodeSize }, { type, content: [json] })
      .run();
    this.menu.set(null);
  }

  protected duplicate(m: MenuState) {
    const node = this.editor.state.doc.nodeAt(m.pos);
    if (!node) return;
    const json = node.toJSON() as { attrs?: Record<string, unknown> };
    if (json.attrs) json.attrs = { ...json.attrs, id: null };
    this.editor.chain().focus().insertContentAt(m.pos + node.nodeSize, json).run();
    this.menu.set(null);
  }

  protected remove(m: MenuState) {
    const node = this.editor.state.doc.nodeAt(m.pos);
    if (node) this.editor.chain().focus().deleteRange({ from: m.pos, to: m.pos + node.nodeSize }).run();
    this.menu.set(null);
  }

  protected readonly buttons = [
    { label: 'B', title: 'Bold (Ctrl+B)', run: () => this.editor.chain().focus().toggleBold().run() },
    { label: 'I', title: 'Italic (Ctrl+I)', run: () => this.editor.chain().focus().toggleItalic().run() },
    { label: 'U', title: 'Underline (Ctrl+U)', run: () => this.editor.chain().focus().toggleUnderline().run() },
    { label: 'H2', title: 'Heading', run: () => this.editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: 'H3', title: 'Subheading', run: () => this.editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { label: '•', title: 'Bullet list', run: () => this.editor.chain().focus().toggleBulletList().run() },
    { label: '☑', title: 'Checklist', run: () => this.editor.chain().focus().toggleTaskList().run() },
    { label: '🔒', title: 'DM-only block (Ctrl+Shift+D)', run: () => this.editor.commands.keyboardShortcut('Mod-Shift-d'), gm: true },
  ];

  /** Called by the parent when it saved our own emitted doc, so the next input change is not re-applied. */
  protected insertTemplate(content: BlockNode[]) {
    const pos = this.templateAt();
    this.templateAt.set(null);
    if (pos === null || !content.length) return;
    const at = Math.min(pos, this.editor.state.doc.content.size);
    this.editor.chain().focus().insertContentAt(at, content as JSONContent[]).run();
  }

  markLoaded(doc: BlockDoc) {
    this.loadedFrom = doc;
  }

  ngOnDestroy() {
    this.editor.destroy();
    this.handle.remove();
  }
}
