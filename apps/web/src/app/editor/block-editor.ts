import { HttpClient } from '@angular/common/http';
import { afterNextRender, ChangeDetectionStrategy, Component, effect, ElementRef, inject, Injector, input, output, signal, untracked, viewChild, type OnDestroy, type WritableSignal } from '@angular/core';
import { Editor, Extension, type JSONContent } from '@tiptap/core';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { DragHandle } from '@tiptap/extension-drag-handle';
import { Highlight } from '@tiptap/extension-highlight';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { UniqueID } from '@tiptap/extension-unique-id';
import { Placeholder } from '@tiptap/extensions';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Selection, TextSelection, type Transaction } from '@tiptap/pm/state';
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
import { newTableNameScope, TableNames } from '../blocks/table-names';

const SAFE_URL = (url: string) => /^(https?:|mailto:)/i.test(url);
/**
 * A table, callout, embed or rule as the last block leaves no place for a caret below it. A menu action that can
 * leave one there adds an empty paragraph in the same transaction (undo removes both). Opening a page never does:
 * that would count as an edit.
 */
function keepTrailingParagraph(tr: Transaction) {
  const last = tr.doc.lastChild;
  if (last && last.type.name !== 'paragraph' && last.type.name !== 'heading') tr.insert(tr.doc.content.size, tr.doc.type.schema.nodes['paragraph']!.create());
}

const newBlockId = () => `b${Math.random().toString(36).slice(2, 10)}`;

interface MenuState {
  pos: number;
  node: PMNode;
  x: number;
  y: number;
  /** The control that opened the menu; Esc and Tab give focus back to it (the editor when there is none). */
  opener: HTMLElement | null;
  fromToolbar: boolean;
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

/** Ctrl+. opens the block options menu for the block holding the caret (Ctrl, also on a Mac: Cmd+. stops loading in Safari). */
const BlockMenuShortcut = Extension.create<{ open: () => boolean }>({
  name: 'blockMenuShortcut',
  addOptions() {
    return { open: () => false };
  },
  addKeyboardShortcuts() {
    return { 'Ctrl-.': () => this.options.open() };
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
      <div class="sticky top-0 z-10 mb-2 flex flex-wrap items-center gap-1 touch:static rounded-md border border-line bg-panel/95 p-1 text-sm backdrop-blur" role="toolbar" aria-label="Formatting">
        @for (b of buttons; track b.label) {
          @if (!b.gm || gm()) {
            <button type="button" class="inline-flex min-h-6 min-w-6 items-center justify-center rounded px-2 py-0.5 hover:bg-panel-2 touch:min-h-[44px] touch:min-w-[44px]" [title]="b.title" (mousedown)="$event.preventDefault()" (click)="b.run()">{{ b.label }}</button>
          }
        }
        <button
          type="button"
          class="inline-flex min-h-6 min-w-6 items-center justify-center rounded px-2 py-0.5 hover:bg-panel-2 touch:min-h-[44px] touch:min-w-[44px]"
          aria-label="Block options"
          title="Block options (Ctrl+.)"
          aria-haspopup="menu"
          aria-keyshortcuts="Control+Period"
          [attr.aria-expanded]="menu()?.fromToolbar ? 'true' : 'false'"
          (mousedown)="$event.preventDefault()"
          (click)="openFromToolbar($event)"
        >
          <span aria-hidden="true">⋯</span>
        </button>
        <span class="ml-auto px-2 text-xs text-muted">Type <kbd>/</kbd> for blocks, <kbd>[[</kbd> to link a page, <kbd>{{ '{' }}&#64;</kbd> for rules, <kbd>Ctrl+.</kbd> for block options</span>
      </div>
    }
    <tiptap-editor [editor]="editor" class="cn-editor cn-prose block" />
    <div class="sr-only" role="status">{{ status() }}</div>
    @if (notice(); as n) {
      <div class="cn-reveal-notice sticky bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-20 mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2 text-sm shadow-xl" role="group" aria-label="Reveal confirmation" (focusin)="noticeFocused = true" (focusout)="noticeFocused = false">
        <span class="min-w-0" [class.text-accent]="n.failed" [attr.role]="n.failed ? 'alert' : null">{{ n.text }}</span>
        @if (n.failed) {
          <button type="button" class="cn-btn ml-auto min-h-6 px-2 py-0.5 text-sm font-normal touch:min-h-[44px] touch:min-w-[44px]" (click)="clearNotice()">Dismiss</button>
        } @else {
          <button type="button" class="cn-btn ml-auto min-h-6 px-2 py-0.5 text-sm font-normal touch:min-h-[44px] touch:min-w-[44px]" (click)="undoReveal()">Undo</button>
        }
      </div>
    }
    @if (templateAt() !== null && store?.id(); as campaignId) {
      <cn-template-insert [campaignId]="campaignId" (inserted)="insertTemplate($event)" (closed)="templateAt.set(null)" />
    }
    @if (menu(); as m) {
      <div class="fixed inset-0 z-40" (click)="menu.set(null)"></div>
      <div #blockMenu class="cn-block-menu" role="menu" tabindex="0" [attr.aria-label]="'Block options: ' + m.node.type.name" [style.left.px]="m.x" [style.top.px]="m.y" (keydown)="onMenuKey($event)">
        <div class="cn-block-menu-label" aria-hidden="true">{{ m.node.type.name }}</div>
        @if (gm()) {
          <button type="button" tabindex="-1" role="menuitemcheckbox" [attr.aria-checked]="m.node.attrs['visibility'] === 'dm'" (click)="toggleAttr(m, 'visibility')">
            @if (m.node.attrs['visibility'] === 'dm') {<span aria-hidden="true">✓ </span>}DM only <kbd aria-hidden="true">Ctrl⇧D</kbd>
          </button>
          @if (m.node.attrs['visibility'] === 'dm' || m.node.type.name === 'secret') {
            <button type="button" tabindex="-1" role="menuitemcheckbox" [attr.aria-checked]="!!m.node.attrs['revealed']" (click)="toggleAttr(m, 'revealed')">
              @if (m.node.attrs['revealed']) {<span aria-hidden="true">✓ </span>}Revealed to players <kbd aria-hidden="true">Ctrl⇧R</kbd>
            </button>
          }
          @if (canRevealNow(m.node)) {
            <button type="button" tabindex="-1" role="menuitem" [attr.title]="revealHint" (click)="revealNow(m)">Reveal now</button>
          }
          <hr />
        }
        <button type="button" tabindex="-1" role="menuitem" (click)="turnInto(m, 'paragraph')">Turn into text</button>
        <button type="button" tabindex="-1" role="menuitem" (click)="turnInto(m, 'heading')">Turn into heading</button>
        @if (gm()) {
          <button type="button" tabindex="-1" role="menuitem" (click)="wrap(m, 'secret')">Wrap in DM secret</button>
        }
        <button type="button" tabindex="-1" role="menuitem" (click)="wrap(m, 'callout')">Wrap in callout</button>
        <button type="button" tabindex="-1" role="menuitem" (click)="wrap(m, 'readAloud')">Wrap in read-aloud</button>
        <hr />
        @if (canMove(m, -1)) {
          <button type="button" tabindex="-1" role="menuitem" (click)="move(m, -1)">Move up</button>
        }
        @if (canMove(m, 1)) {
          <button type="button" tabindex="-1" role="menuitem" (click)="move(m, 1)">Move down</button>
        }
        <button type="button" tabindex="-1" role="menuitem" (click)="duplicate(m)">Duplicate</button>
        <button type="button" tabindex="-1" role="menuitem" class="text-accent" (click)="remove(m)">Delete</button>
      </div>
    }`,
})
export class BlockEditor implements OnDestroy {
  readonly doc = input<BlockDoc | null>(null);
  readonly editable = input(true);
  readonly placeholder = input('Write something, or type / for blocks…');
  /** The accessible name of the editing area (several editors can share a page). */
  readonly label = input('Page content');
  readonly pageId = input<string | null>(null);
  readonly changed = output<BlockDoc>();
  /** The host should save now (a reveal is one click, not a debounced edit). Emitted after `changed`. */
  readonly saveNow = output<void>();
  /** Awaited before a reveal: saves pending edits first, so the reveal save changes only the reveal flag. */
  readonly beforeReveal = input<(() => Promise<void>) | null>(null);
  /** Saves now and resolves true when the save worked (the reveal notice appears only then). */
  readonly commit = input<(() => Promise<boolean>) | null>(null);
  protected readonly revealHint = 'Players see it right away. If you edit this same block in the same save as the reveal, they get no live notice.';
  /** Confirmation (with Undo) after "Reveal now". */
  protected readonly notice = signal<{ text: string; blockId: string; failed: boolean } | null>(null);
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly editorContext = inject(EDITOR_CONTEXT) as { pageId: WritableSignal<string | null> };
  readonly pageIdSignal = this.editorContext.pageId;
  protected readonly menu = signal<MenuState | null>(null);
  /** Polite status line: what a block menu action did. */
  protected readonly status = signal('');
  /** Where a chosen template goes (set by the "/" menu's Template… item). */
  protected readonly templateAt = signal<number | null>(null);

  private readonly http = inject(HttpClient);
  protected readonly store = inject(CampaignStore, { optional: true });
  private readonly context = inject(ContextService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly menuEl = viewChild<ElementRef<HTMLElement>>('blockMenu');
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
      TableNames.configure({ scope: newTableNameScope() }),
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
      BlockMenuShortcut.configure({ open: () => this.openAtCaret(null) }),
      Placeholder.configure({ placeholder: () => this.placeholder(), includeChildren: false }),
    ],
    editorProps: { attributes: { class: 'min-h-48 outline-none pl-6', spellcheck: 'true' } },
    onUpdate: ({ editor }) => this.changed.emit({ ...(editor.getJSON() as BlockDoc), schemaVersion: 1 }),
  });

  private loadedFrom: BlockDoc | null | undefined = undefined;

  constructor() {
    effect(() => this.pageIdSignal.set(this.pageId()));
    // A menu that appears takes focus (its first item)
    effect(() => {
      const el = this.menuEl()?.nativeElement;
      if (!el) return;
      untracked(() => {
        // Keep the whole menu in the viewport (it scrolls when taller than the window)
        const m = this.menu();
        const y = m ? Math.max(8, Math.min(m.y, window.innerHeight - el.offsetHeight - 8)) : 0;
        if (m && y !== m.y) this.menu.set({ ...m, y });
        this.items()[0]?.focus();
      });
    });
    effect(() => {
      const doc = this.doc();
      untracked(() => {
        if (doc === this.loadedFrom) return;
        this.loadedFrom = doc;
        this.clearNotice();
        this.editor.commands.setContent((doc as JSONContent | null) ?? { type: 'doc', content: [{ type: 'paragraph' }] }, { emitUpdate: false });
      });
    });
    effect(() => this.editor.setEditable(this.editable()));
    effect(() => {
      const label = this.label();
      untracked(() =>
        this.editor.setOptions({
          editorProps: { attributes: { class: 'min-h-48 outline-none pl-6', spellcheck: 'true', 'aria-label': label } },
        }),
      );
    });
  }

  private createHandle(): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cn-drag-handle';
    el.textContent = '⠿';
    el.title = 'Drag to move · click for options';
    el.setAttribute('aria-label', 'Drag or open block options');
    // Hidden until the extension shows it next to a block (it would sit in the page's top-left corner)
    el.style.visibility = 'hidden';
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const pos = this.blockPosAtHandle(el);
      if (pos == null) return;
      const node = this.editor.state.doc.nodeAt(pos);
      if (!node) return;
      const rect = el.getBoundingClientRect();
      this.openMenu({ pos, node, x: rect.left, y: rect.bottom + 4, opener: el, fromToolbar: false });
    });
    return el;
  }

  /** Opens the menu for the top-level block that holds the caret; false when there is none. */
  private openAtCaret(opener: HTMLElement | null): boolean {
    if (!this.editable()) return false;
    const { state, view } = this.editor;
    // The "/", "[[" and "{@" popup owns the keys while it is open
    if (view.dom.getAttribute('aria-expanded') === 'true') return false;
    const { $from, head } = state.selection;
    const pos = $from.depth > 0 ? $from.before(1) : $from.pos;
    const node = state.doc.nodeAt(pos);
    if (!node) return false;
    let x: number;
    let y: number;
    if (opener) {
      const rect = opener.getBoundingClientRect();
      x = rect.left;
      y = rect.bottom + 4;
    } else {
      const caret = view.coordsAtPos(Math.min(head, state.doc.content.size));
      x = caret.left;
      y = caret.bottom + 4;
    }
    this.openMenu({ pos, node, x, y, opener, fromToolbar: !!opener });
    return true;
  }

  protected openFromToolbar(event: Event) {
    this.openAtCaret(event.currentTarget as HTMLElement);
  }

  private openMenu(m: MenuState) {
    // Keep the 15rem menu inside the viewport
    const x = Math.max(8, Math.min(m.x, window.innerWidth - 248));
    this.menu.set({ ...m, x, y: Math.max(8, m.y) });
  }

  private items(): HTMLElement[] {
    return Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('.cn-block-menu [role^="menuitem"]'));
  }

  /** Menu keyboard pattern: arrows (wrapping), Home/End, Esc closes and returns focus, Tab closes. */
  protected onMenuKey(event: KeyboardEvent) {
    const items = this.items();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      event.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        return go(at + 1);
      case 'ArrowUp':
        return go(at < 0 ? -1 : at - 1);
      case 'Home':
        return go(0);
      case 'End':
        return go(-1);
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        return this.closeMenu();
      case 'Tab':
        // Focus returns to the opener first, so Tab then moves on from there
        return this.closeMenu();
    }
  }

  private closeMenu() {
    const opener = this.menu()?.opener;
    this.menu.set(null);
    if (opener?.isConnected) opener.focus();
    if (!opener?.isConnected || document.activeElement !== opener) this.editor.view.focus();
  }

  private announce(message: string) {
    clearTimeout(this.statusTimer);
    this.status.set('');
    afterNextRender(() => this.status.set(message), { injector: this.injector });
    // Not left in the page for a screen reader's reading cursor to find later
    this.statusTimer = setTimeout(() => this.status.set(''), 3000);
  }
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  protected canMove(m: MenuState, dir: -1 | 1): boolean {
    return dir < 0 ? m.pos > 0 : m.pos + m.node.nodeSize < this.editor.state.doc.content.size;
  }

  protected move(m: MenuState, dir: -1 | 1) {
    const { doc } = this.editor.state;
    const node = doc.nodeAt(m.pos);
    const sibling = dir < 0 ? doc.resolve(m.pos).nodeBefore : doc.resolve(m.pos + (node?.nodeSize ?? 0)).nodeAfter;
    if (!node || !sibling) return this.menu.set(null);
    const target = dir < 0 ? m.pos - sibling.nodeSize : m.pos + sibling.nodeSize;
    this.editor.view.focus();
    this.editor
      .chain()
      .command(({ tr }) => {
        tr.delete(m.pos, m.pos + node.nodeSize).insert(target, node);
        keepTrailingParagraph(tr);
        // An atom or leaf block (rule, embed) has no text to hold a caret: select the block itself
        tr.setSelection(node.isAtom || node.isLeaf ? NodeSelection.create(tr.doc, target) : TextSelection.near(tr.doc.resolve(target + 1))).scrollIntoView();
        return true;
      })
      .run();
    this.menu.set(null);
    const index = this.editor.state.doc.resolve(target).index(0) + 1;
    this.announce(`Block moved ${dir < 0 ? 'up' : 'down'}, now ${index} of ${this.editor.state.doc.childCount}`);
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
    this.editor.view.focus();
    this.editor.chain().command(({ tr }) => {
      tr.setNodeMarkup(m.pos, undefined, { ...node.attrs, [attr]: value });
      return true;
    }).run();
    this.menu.set(null);
    const on = attr === 'visibility' ? value === 'dm' : !!value;
    this.announce(attr === 'visibility' ? (on ? 'Block marked DM only' : 'Block no longer DM only') : on ? 'Block revealed to players' : 'Block hidden from players');
  }

  /** Secrets and DM-only blocks that players cannot see yet. */
  protected canRevealNow(node: PMNode): boolean {
    return (node.type.name === 'secret' || node.attrs['visibility'] === 'dm') && !node.attrs['revealed'];
  }

  /** The block with this `attrs.id` (ids survive saves, so a reveal finds its block again after an await). */
  private findBlock(id: string): { pos: number; node: PMNode } | null {
    let found: { pos: number; node: PMNode } | null = null;
    this.editor.state.doc.descendants((node, pos) => {
      if (found) return false;
      if (node.attrs['id'] === id) found = { pos, node };
      return !found;
    });
    return found;
  }

  private setRevealed(id: string, revealed: boolean): boolean {
    const hit = this.findBlock(id);
    if (!hit) return false;
    // Only the flag changes: every attrs.id (the block's and its children's) stays, or the server's detector sees a changed block
    this.editor.chain().command(({ tr }) => {
      tr.setNodeMarkup(hit.pos, undefined, { ...hit.node.attrs, revealed });
      return true;
    }).run();
    return true;
  }

  /** One click: reveals the block and saves through the normal page save, with an Undo. */
  protected async revealNow(m: MenuState) {
    const id = this.editor.state.doc.nodeAt(m.pos)?.attrs['id'] as string | undefined;
    this.closeMenu();
    if (!id || !this.canRevealNow(m.node)) return;
    const page = this.pageId();
    await this.beforeReveal()?.();
    // The page or the block may have changed while the pending edits were saved
    const hit = this.findBlock(id);
    if (page !== this.pageId() || !hit || !this.canRevealNow(hit.node)) return;
    this.setRevealed(id, true);
    this.saveNow.emit();
    if ((await this.commit()?.()) === false) {
      // The server still has it hidden: show that, here and on the block
      if (page === this.pageId()) this.setRevealed(id, false);
      return this.showNotice('Not saved. The block is still hidden from players.', id, true);
    }
    if (page === this.pageId() && this.findBlock(id)?.node.attrs['revealed']) this.showNotice('Revealed to players', id);
  }

  protected async undoReveal() {
    const id = this.notice()?.blockId;
    const page = this.pageId();
    this.clearNotice();
    if (!id || !this.setRevealed(id, false)) return;
    this.saveNow.emit();
    this.editor.view.focus();
    if ((await this.commit()?.()) === false) {
      if (page === this.pageId()) this.setRevealed(id, true);
      return this.showNotice('Not saved. The block is still revealed to players.', id, true);
    }
    this.announce('Hidden from players again');
  }

  private showNotice(text: string, blockId: string, failed = false) {
    this.notice.set({ text, blockId, failed });
    // A failure is announced once, by the notice's own role="alert"
    if (!failed) this.announce(text);
    this.armNotice();
  }

  /** Auto-dismiss after 15 s; waits while the notice has keyboard focus. */
  private armNotice() {
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => (this.noticeFocused ? this.armNotice() : this.notice.set(null)), 15000);
  }
  protected noticeFocused = false;

  protected clearNotice() {
    clearTimeout(this.noticeTimer);
    this.notice.set(null);
  }

  protected turnInto(m: MenuState, type: 'paragraph' | 'heading') {
    this.editor.chain().focus().setTextSelection(m.pos + 1)[type === 'heading' ? 'setHeading' : 'setParagraph']({ level: 2 } as never).run();
    this.menu.set(null);
    this.announce(type === 'heading' ? 'Turned into heading' : 'Turned into text');
  }

  protected wrap(m: MenuState, type: 'secret' | 'callout' | 'readAloud') {
    const node = this.editor.state.doc.nodeAt(m.pos);
    if (!node) return;
    const json = node.toJSON();
    this.editor.view.focus();
    this.editor
      .chain()
      .insertContentAt({ from: m.pos, to: m.pos + node.nodeSize }, { type, content: [json] })
      .command(({ tr }) => {
        keepTrailingParagraph(tr);
        return true;
      })
      .run();
    this.menu.set(null);
    this.announce(`Block wrapped in ${{ secret: 'DM secret', callout: 'callout', readAloud: 'read-aloud' }[type]}`);
  }

  protected duplicate(m: MenuState) {
    const node = this.editor.state.doc.nodeAt(m.pos);
    if (!node) return;
    const json = node.toJSON() as { attrs?: Record<string, unknown> };
    if (json.attrs) json.attrs = { ...json.attrs, id: null };
    this.editor.view.focus();
    this.editor
      .chain()
      .insertContentAt(m.pos + node.nodeSize, json)
      .command(({ tr }) => {
        keepTrailingParagraph(tr);
        return true;
      })
      .run();
    this.menu.set(null);
    this.announce('Block duplicated');
  }

  protected remove(m: MenuState) {
    const node = this.editor.state.doc.nodeAt(m.pos);
    this.editor.view.focus();
    if (node) {
      this.editor
        .chain()
        .command(({ tr }) => {
          tr.delete(m.pos, m.pos + node.nodeSize);
          // The caret goes to the end of the block before (or the start of the one after)
          tr.setSelection(Selection.near(tr.doc.resolve(Math.min(m.pos, tr.doc.content.size)), -1)).scrollIntoView();
          return true;
        })
        .run();
    }
    this.menu.set(null);
    if (node) this.announce('Block deleted');
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
    clearTimeout(this.statusTimer);
    clearTimeout(this.noticeTimer);
    this.editor.destroy();
    this.handle.remove();
  }
}
