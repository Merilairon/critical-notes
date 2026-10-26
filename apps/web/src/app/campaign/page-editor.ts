import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import type { OnDestroy} from '@angular/core';
import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, input, signal, untracked, viewChild } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { Router, RouterLink } from '@angular/router';
import {
  facetTypeFor,
  PAGE_TYPE_ICONS,
  PAGE_TYPE_LABELS,
  PAGE_TYPES,
  VISIBILITY_VALUES,
  type BlockDoc,
  type PageDto,
  type PageType,
  type PageVisibility,
  type UpdatePageInput,
} from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { BlockView } from '../blocks/block-view';
import { errorMessage } from '../core/http.interceptor';
import { LayoutService } from '../core/layout.service';
import { pageTitle } from '../core/page-title';
import { BlockEditor } from '../editor/block-editor';
import { AutosizeTitle, singleLine } from './autosize-title';
import { pcDigest } from './facet-digest';
import { BacklinksPanel } from './backlinks-panel';
import { CampaignStore } from './campaign.store';
import { HistoryPanel, type HistoryPrepared } from './history-panel';
import { FacetForm } from './facet-form';
import { LiveService } from './live/live.service';
import { NpcStatblock } from './npc-statblock';
import { PropertiesPanel } from './properties-panel';
import { PageTemplateDialog } from '../templates/page-template-dialog';

const SAVE_DELAY = 700;
const NO_IDS: readonly string[] = [];

const VISIBILITY_LABELS: Record<PageVisibility, string> = { dm: 'DM only', all: 'All players', selected: 'Selected players' };

@Component({
  selector: 'cn-page-editor',
  imports: [RouterLink, AutosizeTitle, BlockEditor, BlockView, FacetForm, NpcStatblock, PropertiesPanel, BacklinksPanel, PageTemplateDialog, HistoryPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './page-editor.html',
})
export class PageEditor implements OnDestroy {
  readonly pageId = input.required<string>();
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly title = inject(Title);
  protected readonly store = inject(CampaignStore);
  protected readonly live = inject(LiveService, { optional: true });
  /** Block ids a player was just shown ("New" highlight), from the live stream. */
  protected readonly newBlockIds = computed(() => this.live?.newBlocks()[this.pageId()] ?? NO_IDS);

  protected readonly page = signal<PageDto | null>(null);
  /** The document last loaded from the server (input to the editor; edits are not fed back). */
  protected readonly loadedDoc = signal<BlockDoc | null>(null);
  protected readonly status = signal<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>('idle');
  protected readonly error = signal('');
  protected readonly deleting = signal(false);
  protected readonly notFound = signal(false);
  /** Increments after each successful save (refreshes backlinks). */
  protected readonly savedCount = signal(0);
  /** The page as a player would receive it (server-side projection), while previewing. */
  protected readonly playerView = signal<PageDto | null>(null);
  protected readonly previewing = signal(false);
  protected readonly showProps = signal(false);
  protected readonly applying = signal(false);
  protected readonly historyOpen = signal(false);
  private readonly historyBtn = viewChild<ElementRef<HTMLElement>>('historyBtn');
  private readonly layout = inject(LayoutService);
  /** On a phone (portrait, or short landscape) the character sheet is a collapsible section; otherwise it is always open. */
  protected readonly collapsible = this.layout.phone;
  protected readonly sheetOpen = signal(false);
  /** One line for the collapsed sheet of a character: HP, AC and speed. */
  protected readonly digest = computed(() => (this.page()?.type === 'pc' ? pcDigest(this.page()?.facet) : ''));
  protected readonly canEdit = computed(() => {
    const p = this.page();
    return !!p && this.store.canEdit(p);
  });
  protected readonly hasProps = computed(() => Object.keys(this.page()?.props ?? {}).length > 0);
  protected readonly players = computed(() => this.store.members().filter((m) => m.role === 'player'));

  protected readonly types = PAGE_TYPES;
  protected readonly typeLabels = PAGE_TYPE_LABELS;
  protected readonly icons = PAGE_TYPE_ICONS;
  protected readonly visibilities = VISIBILITY_VALUES;
  protected readonly visibilityLabels = VISIBILITY_LABELS;
  protected readonly facetType = computed(() => (this.page() ? facetTypeFor(this.page()!.type) : null));
  protected readonly breadcrumbs = computed(() => (this.page() ? this.store.ancestors(this.page()!.id) : []));
  protected readonly children = computed(() => (this.page() ? (this.store.childrenOf().get(this.page()!.id) ?? []) : []));

  protected readonly shareUndo = signal<{ pageId: string; visibility: PageVisibility; viewers: string[]; text: string } | null>(null);
  private shareTimer: ReturnType<typeof setTimeout> | undefined;
  private pending: Omit<UpdatePageInput, 'revision'> = {};
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | null = null;
  private readonly editor = viewChild(BlockEditor);

  constructor() {
    effect(() => {
      const id = this.pageId();
      // Only the route id is a dependency: flush() and load() read and write page state
      untracked(() => void this.flush().finally(() => this.load(id)));
    });
    // The live stream refreshes this page through this handle, and never over unsaved edits
    effect((onCleanup) => {
      const live = this.live;
      const id = this.pageId();
      if (!live) return;
      untracked(() =>
        live.registerOpen({
          id,
          isDirty: () => Object.keys(this.pending).length > 0 || this.saving !== null || this.status() === 'saving',
          apply: (page) => this.applyLive(page),
          reload: () => void this.saveAndReload(id),
        }),
      );
      onCleanup(() => live.unregisterOpen(id));
    });
    effect(() => {
      const p = this.page();
      if (p) this.title.setTitle(pageTitle(p.title, this.store.campaign()?.name));
    });
    // Game masters choose who sees "selected" pages and who plays a character
    effect(() => {
      if (this.store.isGm() && this.store.id()) untracked(() => void this.store.loadMembers().catch(() => undefined));
    });
  }

  private async load(id: string) {
    this.clearShare();
    this.notFound.set(false);
    this.previewing.set(false);
    this.historyOpen.set(false);
    this.playerView.set(null);
    try {
      const page = await firstValueFrom(this.http.get<PageDto>(`/api/campaigns/${this.store.id()}/pages/${id}`));
      this.page.set(page);
      this.loadedDoc.set(page.body);
      this.showProps.set(Object.keys(page.props).length > 0);
      this.status.set('idle');
    } catch {
      this.page.set(null);
      this.notFound.set(true);
    }
  }

  /**
   * "Save and reload" from the live toast: save the pending edit first, and only reload when that worked. If the save
   * hit a conflict (the DM changed the page) or failed, the page stays as it is with its banner, so the player can still copy their text.
   */
  protected async saveAndReload(id: string) {
    // Typing during a save lands in a new pending change: save again until nothing is left, so no edit is dropped or sent late
    do {
      await this.flush();
      if (this.status() === 'conflict' || this.status() === 'error') return;
    } while (Object.keys(this.pending).length);
    clearTimeout(this.timer);
    await this.load(id);
  }

  /** A fresher copy from the live stream: adopt it (the caller checked that nothing is unsaved). */
  private applyLive(page: PageDto) {
    if (page.id !== this.page()?.id) return;
    this.page.set(page);
    this.loadedDoc.set(page.body);
    this.store.patchSummary(page);
  }

  /** Queue a change; saves are debounced and merged. */
  protected queue(change: Omit<UpdatePageInput, 'revision'>, immediate = false) {
    const p = this.page();
    if (!p) return;
    this.pending = {
      ...this.pending,
      ...change,
      ...(change.facet ? { facet: { ...(this.pending.facet ?? {}), ...change.facet } } : {}),
      ...(change.props ? { props: { ...(this.pending.props ?? {}), ...change.props } } : {}),
    };
    // Reflect summary changes immediately in the UI
    const local: Partial<PageDto> = {};
    if (change.title !== undefined) local.title = change.title;
    if (change.icon !== undefined) local.icon = change.icon;
    if (change.visibility !== undefined) local.visibility = change.visibility;
    if (change.tags !== undefined) local.tags = change.tags;
    if (change.facet) local.facet = { ...(p.facet ?? {}), ...change.facet };
    if (change.props) local.props = withoutNulls({ ...p.props, ...change.props });
    if (Object.keys(local).length) this.page.set({ ...p, ...local });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), immediate ? 0 : SAVE_DELAY);
  }

  private async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.saving) await this.saving;
    const p = this.page();
    if (!p || !Object.keys(this.pending).length) return;
    const change = this.pending;
    this.pending = {};
    this.status.set('saving');
    this.saving = (async () => {
      try {
        const saved = await firstValueFrom(this.http.patch<PageDto>(`/api/campaigns/${this.store.id()}/pages/${p.id}`, { ...change, revision: p.revision }));
        // Keep local unsaved edits (e.g. typing during the request) and adopt the server's state otherwise
        this.page.set({ ...saved, body: this.page()?.body ?? saved.body });
        this.store.patchSummary(saved);
        this.status.set('saved');
        this.savedCount.update((n) => n + 1);
      } catch (err) {
        if (err instanceof HttpErrorResponse && err.status === 409) {
          this.status.set('conflict');
        } else {
          this.pending = { ...change, ...this.pending };
          this.status.set('error');
          this.error.set(errorMessage(err));
        }
      } finally {
        this.saving = null;
      }
    })();
    await this.saving;
  }

  /** Saves pending edits first, so a reveal save carries only the reveal (the live-event detector ignores a block edited in the same save). */
  protected readonly beforeReveal = () => this.flush();

  /** A one-click action (reveal) saves now instead of after the debounce; true only when the save succeeded. */
  protected readonly commit = async (): Promise<boolean> => {
    await this.flush();
    return this.status() === 'saved';
  };

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private shareFocused = false;

  private clearShare() {
    clearTimeout(this.shareTimer);
    this.shareUndo.set(null);
  }

  protected onShareFocus(inside: boolean) {
    this.shareFocused = inside;
  }

  /** Handout "Share now": visible to all players, or to chosen players, with an Undo shown once the save worked. */
  protected async shareNow(to: 'all' | 'selected') {
    const p = this.page();
    if (!p) return;
    this.clearShare();
    await this.flush();
    const prev = { pageId: p.id, visibility: p.visibility, viewers: [...p.viewers] };
    if (!(await this.saveVisibility(p.id, to, to === 'all' ? [] : p.viewers, prev))) return;
    this.shareUndo.set({ ...prev, text: to === 'all' ? 'Shared with all players' : 'Shared with chosen players: pick who below' });
    // The auto-dismiss waits while the notice has keyboard focus
    const tick = () => {
      if (this.shareFocused) this.shareTimer = setTimeout(tick, 5000);
      else this.shareUndo.set(null);
    };
    this.shareTimer = setTimeout(tick, 15000);
  }

  /** Saves a visibility change at once. If the save fails (error or conflict) the page model goes back to `back`, so the screen never shows a share the server does not have. */
  private async saveVisibility(pageId: string, visibility: PageVisibility, viewers: string[], back: { visibility: PageVisibility; viewers: string[] }): Promise<boolean> {
    this.queue({ visibility, viewers }, true);
    await this.flush();
    if (this.page()?.id !== pageId) return false;
    if (this.status() === 'saved') return true;
    const { visibility: _v, viewers: _w, ...rest } = this.pending;
    this.pending = rest;
    const p = this.page();
    if (p) this.page.set({ ...p, visibility: back.visibility, viewers: back.viewers });
    const summary = this.page();
    if (summary) this.store.patchSummary(summary);
    return false;
  }

  protected async undoShare() {
    const u = this.shareUndo();
    this.clearShare();
    this.shareFocused = false;
    if (!u || this.page()?.id !== u.pageId) return;
    const now = this.page();
    if (now) void this.saveVisibility(u.pageId, u.visibility, u.viewers, { visibility: now.visibility, viewers: [...now.viewers] });
    // The focused Undo button is gone: focus moves to the share buttons
    setTimeout(() => this.host.nativeElement.querySelector<HTMLElement>('[aria-label="Share this handout"] button, textarea[aria-label="Page title"]')?.focus());
  }

  protected onBody(doc: BlockDoc) {
    this.editor()?.markLoaded(doc);
    const p = this.page();
    if (p) this.page.set({ ...p, body: doc });
    this.queue({ body: doc });
  }

  protected onTitle(value: string) {
    this.queue({ title: singleLine(value).trim() ? singleLine(value) : 'Untitled' });
  }

  /** On a phone the choice is remembered for the page; the always-open sheet does not count as a choice. */
  protected onSheetToggle(open: boolean) {
    if (this.collapsible()) this.sheetOpen.set(open);
  }

  protected setType(type: string) {
    this.queue({ type: type as PageType }, true);
  }

  protected addTag(input: HTMLInputElement) {
    const tag = input.value.trim().toLowerCase();
    input.value = '';
    const p = this.page();
    if (!tag || !p || p.tags.includes(tag)) return;
    this.queue({ tags: [...p.tags, tag].sort() }, true);
  }

  protected removeTag(tag: string) {
    const p = this.page();
    if (p) this.queue({ tags: p.tags.filter((t) => t !== tag) }, true);
  }

  protected onFacet(change: Record<string, unknown>) {
    this.queue({ facet: change }, true);
  }

  protected toggleViewer(userId: string, on: boolean) {
    const p = this.page();
    if (!p) return;
    const viewers = on ? [...new Set([...p.viewers, userId])] : p.viewers.filter((v) => v !== userId);
    this.page.set({ ...p, viewers });
    this.queue({ viewers }, true);
  }

  protected onProps(change: Record<string, unknown>) {
    this.queue({ props: change }, true);
  }

  protected async togglePreview() {
    if (this.previewing()) {
      this.previewing.set(false);
      return;
    }
    const p = this.page();
    if (!p) return;
    await this.flush();
    this.historyOpen.set(false);
    try {
      this.playerView.set(await firstValueFrom(this.http.get<PageDto>(`/api/campaigns/${this.store.id()}/pages/${p.id}`, { params: { as: 'player' } })));
      this.previewing.set(true);
    } catch (err) {
      this.status.set('error');
      this.error.set(errorMessage(err));
    }
  }

  protected toggleHistory() {
    if (this.historyOpen()) this.closeHistory();
    else this.historyOpen.set(true);
  }

  protected closeHistory() {
    this.historyOpen.set(false);
    setTimeout(() => this.historyBtn()?.nativeElement.focus());
  }

  /** The History panel restores over the saved page: save pending edits first and report the revision. */
  protected readonly prepareHistory = async (): Promise<HistoryPrepared> => {
    await this.flush();
    const ok = this.status() !== 'conflict' && this.status() !== 'error';
    return { ok, revision: this.page()?.revision ?? 0 };
  };

  /** A restore (or the newer page after a stale restore) replaces what the editor shows. */
  protected adoptHistory(page: PageDto) {
    if (page.id !== this.page()?.id) return;
    this.pending = {};
    clearTimeout(this.timer);
    this.page.set(page);
    this.loadedDoc.set(page.body);
    this.showProps.set(Object.keys(page.props).length > 0);
    this.status.set('idle');
    this.store.patchSummary(page);
    this.savedCount.update((n) => n + 1);
  }

  protected async openApply() {
    await this.flush();
    this.applying.set(true);
  }

  /** A template was applied on the server: show the new content and properties. */
  protected async applied(page: PageDto) {
    this.applying.set(false);
    await this.store.reloadProperties();
    this.page.set(page);
    this.loadedDoc.set(page.body);
    this.showProps.set(Object.keys(page.props).length > 0);
    this.store.patchSummary(page);
  }

  protected replacePage(page: PageDto) {
    this.page.set(page);
    this.store.patchSummary(page);
  }

  protected async reloadAfterConflict() {
    this.pending = {};
    clearTimeout(this.timer);
    await this.load(this.pageId());
  }

  protected async addSubpage() {
    const p = this.page();
    if (!p) return;
    await this.flush();
    const child = await this.store.createPage({ title: 'Untitled', parentId: p.id });
    await this.router.navigate(['/c', this.store.id(), 'p', child.id]);
  }

  protected async remove() {
    const p = this.page();
    // No confirm: the "Deleted · Undo" toast and the 30-day trash make this recoverable
    if (!p || this.deleting()) return;
    this.deleting.set(true);
    clearTimeout(this.timer);
    this.pending = {};
    try {
      await this.store.deletePage(p.id);
    } catch (err) {
      // deletePage offers Undo before it reloads: only a failed DELETE leaves the page in place
      if (this.store.undo()?.pageId !== p.id) {
        this.status.set('error');
        this.error.set(errorMessage(err));
        this.deleting.set(false);
        return;
      }
    }
    this.deleting.set(false);
    await this.router.navigate(['/c', this.store.id()]);
  }

  ngOnDestroy() {
    clearTimeout(this.shareTimer);
    void this.flush();
  }
}

function withoutNulls(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined));
}
