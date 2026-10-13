import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import type { OnDestroy} from '@angular/core';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
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
import { BlockEditor } from '../editor/block-editor';
import { BacklinksPanel } from './backlinks-panel';
import { CampaignStore } from './campaign.store';
import { FacetForm } from './facet-form';
import { NpcStatblock } from './npc-statblock';
import { PropertiesPanel } from './properties-panel';
import { PageTemplateDialog } from '../templates/page-template-dialog';

const SAVE_DELAY = 700;

const VISIBILITY_LABELS: Record<PageVisibility, string> = { dm: 'DM only', all: 'All players', selected: 'Selected players' };

@Component({
  selector: 'cn-page-editor',
  imports: [RouterLink, BlockEditor, BlockView, FacetForm, NpcStatblock, PropertiesPanel, BacklinksPanel, PageTemplateDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './page-editor.html',
})
export class PageEditor implements OnDestroy {
  readonly pageId = input.required<string>();
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly title = inject(Title);
  protected readonly store = inject(CampaignStore);

  protected readonly page = signal<PageDto | null>(null);
  /** The document last loaded from the server (input to the editor; edits are not fed back). */
  protected readonly loadedDoc = signal<BlockDoc | null>(null);
  protected readonly status = signal<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>('idle');
  protected readonly error = signal('');
  protected readonly notFound = signal(false);
  /** Increments after each successful save (refreshes backlinks). */
  protected readonly savedCount = signal(0);
  /** The page as a player would receive it (server-side projection), while previewing. */
  protected readonly playerView = signal<PageDto | null>(null);
  protected readonly previewing = signal(false);
  protected readonly showProps = signal(false);
  protected readonly applying = signal(false);
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
    effect(() => {
      const p = this.page();
      if (p) this.title.setTitle(`${p.title} — ${this.store.campaign()?.name ?? 'Critical Notes'}`);
    });
    // Game masters choose who sees "selected" pages and who plays a character
    effect(() => {
      if (this.store.isGm() && this.store.id()) untracked(() => void this.store.loadMembers().catch(() => undefined));
    });
  }

  private async load(id: string) {
    this.notFound.set(false);
    this.previewing.set(false);
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

  protected onBody(doc: BlockDoc) {
    this.editor()?.markLoaded(doc);
    const p = this.page();
    if (p) this.page.set({ ...p, body: doc });
    this.queue({ body: doc });
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
    try {
      this.playerView.set(await firstValueFrom(this.http.get<PageDto>(`/api/campaigns/${this.store.id()}/pages/${p.id}`, { params: { as: 'player' } })));
      this.previewing.set(true);
    } catch (err) {
      this.status.set('error');
      this.error.set(errorMessage(err));
    }
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
    if (!p || !confirm(`Delete "${p.title}" and its subpages?`)) return;
    clearTimeout(this.timer);
    this.pending = {};
    await this.store.deletePage(p.id);
    await this.router.navigate(['/c', this.store.id()]);
  }

  ngOnDestroy() {
    void this.flush();
  }
}

function withoutNulls(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined));
}
