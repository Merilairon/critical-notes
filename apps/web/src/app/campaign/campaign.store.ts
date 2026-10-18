import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import type { RulesetId } from '@cn/fivetools';
import { isGameMaster, type MemberDto, type CampaignDto, type CreatePageInput, type CreatePropertyInput, type PageDto, type PageSummaryDto, type PageType, type PropertyDefDto, type UpdateCampaignInput } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { ContextService } from '../core/context.service';

/** State for one campaign workspace: campaign settings and the page tree. Provided by the campaign shell. */
@Injectable()
export class CampaignStore {
  private readonly http = inject(HttpClient);
  private readonly context = inject(ContextService);

  readonly campaign = signal<CampaignDto | null>(null);
  readonly pages = signal<PageSummaryDto[]>([]);
  readonly propertyDefs = signal<PropertyDefDto[]>([]);
  readonly members = signal<MemberDto[]>([]);
  /** The latest page delete, offered as "Deleted · Undo" by the campaign shell. */
  readonly undo = signal<{ pageId: string; title: string; subpages: number } | null>(null);
  readonly undoFailed = signal(false);
  /** Short confirmation text (no button), e.g. after an undo. */
  readonly toast = signal<string | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly id = computed(() => this.campaign()?.id ?? null);
  private readonly auth = inject(AuthService);
  readonly role = computed(() => this.campaign()?.role ?? 'player');
  /** Owner DM or co-DM: sees and edits everything. */
  readonly isGm = computed(() => isGameMaster(this.role()));
  /** The campaign's owner (members, roles, edition changes). */
  readonly isOwner = computed(() => this.role() === 'dm');
  readonly myId = computed(() => this.auth.user()?.id ?? null);

  /** Game masters edit every page; players only their own character. */
  canEdit(page: { type: string; facet: Record<string, unknown> | null }): boolean {
    return this.isGm() || (page.type === 'pc' && !!this.myId() && page.facet?.['playerUserId'] === this.myId());
  }
  readonly byId = computed(() => new Map(this.pages().map((p) => [p.id, p])));
  readonly childrenOf = computed(() => {
    const map = new Map<string | null, PageSummaryDto[]>();
    for (const p of this.pages()) {
      const key = p.parentId && this.byId().has(p.parentId) ? p.parentId : null;
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    for (const list of map.values()) list.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    return map;
  });

  private base(path = '') {
    return `/api/campaigns/${this.id()}${path}`;
  }

  async load(campaignId: string) {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [campaign, pages, props] = await Promise.all([
        firstValueFrom(this.http.get<CampaignDto>(`/api/campaigns/${campaignId}`)),
        firstValueFrom(this.http.get<{ pages: PageSummaryDto[] }>(`/api/campaigns/${campaignId}/pages`)),
        firstValueFrom(this.http.get<{ properties: PropertyDefDto[] }>(`/api/campaigns/${campaignId}/properties`)),
      ]);
      this.setCampaign(campaign);
      this.pages.set(pages.pages);
      this.propertyDefs.set(props.properties);
    } catch {
      this.error.set('Campaign not found or not accessible.');
    } finally {
      this.loading.set(false);
    }
  }

  private setCampaign(c: CampaignDto) {
    this.campaign.set(c);
    this.context.campaign.set({ id: c.id, name: c.name, ruleset: c.ruleset as RulesetId, crossEdition: c.crossEdition, overrides: c.sourceOverrides, role: c.role });
  }

  leave() {
    this.undo.set(null);
    this.undoFailed.set(false);
    this.toast.set(null);
    this.context.campaign.set(null);
  }

  async reloadPages() {
    const res = await firstValueFrom(this.http.get<{ pages: PageSummaryDto[] }>(this.base('/pages')));
    this.pages.set(res.pages);
  }

  async createPage(input: CreatePageInput): Promise<PageDto> {
    const page = await firstValueFrom(this.http.post<PageDto>(this.base('/pages'), input));
    await this.reloadPages();
    return page;
  }

  async movePage(pageId: string, parentId: string | null, neighbors: { beforeId?: string | null; afterId?: string | null }) {
    // Optimistic: update locally, then sync with the server's keys
    await firstValueFrom(this.http.post<PageSummaryDto>(this.base(`/pages/${pageId}/move`), { parentId, ...neighbors }));
    await this.reloadPages();
  }

  /** Deletes a page tree (recoverable from the trash) and offers "Undo" for UNDO_SECONDS. */
  async deletePage(pageId: string) {
    const page = this.byId().get(pageId);
    const subpages = this.countDescendants(pageId);
    await firstValueFrom(this.http.delete(this.base(`/pages/${pageId}`)));
    // Offer Undo before the reload: the page is gone even if the reload fails
    this.toast.set(null);
    this.undoFailed.set(false);
    if (page) this.undo.set({ pageId, title: page.title, subpages });
    await this.reloadPages();
  }

  private countDescendants(pageId: string): number {
    let n = 0;
    const walk = (id: string, seen: Set<string>) => {
      for (const c of this.childrenOf().get(id) ?? []) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        n++;
        walk(c.id, seen);
      }
    };
    walk(pageId, new Set([pageId]));
    return n;
  }

  /** Restores the most recent delete. Returns the page id, or null when it failed (then `undoFailed` is set). */
  async undoDelete(): Promise<string | null> {
    const u = this.undo();
    const campaignId = this.id();
    if (!u) return null;
    const stale = () => this.undo() !== u || this.id() !== campaignId;
    try {
      await firstValueFrom(this.http.post(this.base(`/pages/${u.pageId}/restore`), {}));
      if (this.id() !== campaignId) return u.pageId;
      await this.reloadPages().catch(() => undefined);
      if (stale()) return u.pageId;
      this.undo.set(null);
      this.undoFailed.set(false);
      this.toast.set(`Restored "${u.title}"`);
      return u.pageId;
    } catch {
      if (!stale()) this.undoFailed.set(true);
      return null;
    }
  }

  /** The trash page restored or purged this page: a toast still offering it must go. */
  clearUndoFor(pageId: string) {
    if (this.undo()?.pageId === pageId) this.dismissUndo();
  }

  dismissUndo() {
    this.undo.set(null);
    this.undoFailed.set(false);
  }

  /** Updates a page's summary fields locally after an edit (title, icon, type) without refetching the tree. */
  patchSummary(page: PageSummaryDto) {
    this.pages.update((list) => list.map((p) => (p.id === page.id ? { ...p, ...page } : p)));
  }

  async updateCampaign(patch: UpdateCampaignInput) {
    const c = await firstValueFrom(this.http.patch<CampaignDto>(this.base(), patch));
    this.setCampaign(c);
    return c;
  }

  async loadMembers() {
    const res = await firstValueFrom(this.http.get<{ members: MemberDto[] }>(this.base('/members')));
    this.members.set(res.members);
    return res.members;
  }

  /** Templates can add properties; reload them after using one. */
  async reloadProperties() {
    const res = await firstValueFrom(this.http.get<{ properties: PropertyDefDto[] }>(this.base('/properties')));
    this.propertyDefs.set(res.properties);
  }

  async createProperty(input: CreatePropertyInput): Promise<PropertyDefDto> {
    const def = await firstValueFrom(this.http.post<PropertyDefDto>(this.base('/properties'), input));
    this.propertyDefs.update((list) => [...list, def]);
    return def;
  }

  async deleteProperty(id: string) {
    await firstValueFrom(this.http.delete(this.base(`/properties/${id}`)));
    this.propertyDefs.update((list) => list.filter((d) => d.id !== id));
  }

  /** Set by the shell so tree actions can open pages. */
  navigateTo?: (pageId: string) => void;

  pagesOfType(type: PageType): PageSummaryDto[] {
    return this.pages()
      .filter((p) => p.type === type)
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  ancestors(pageId: string): PageSummaryDto[] {
    const out: PageSummaryDto[] = [];
    for (let cur = this.byId().get(pageId)?.parentId; cur; cur = this.byId().get(cur)?.parentId) {
      const p = this.byId().get(cur);
      if (!p || out.includes(p)) break;
      out.unshift(p);
    }
    return out;
  }
}
