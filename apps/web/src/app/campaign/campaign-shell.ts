import type { OnDestroy} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PAGE_TYPE_ICONS, PAGE_TYPE_LABELS, PAGE_TYPES, type PageDto, type PageType } from '@cn/shared';
import { PageTemplateDialog } from '../templates/page-template-dialog';
import { ContextService } from '../core/context.service';
import { CampaignStore } from './campaign.store';
import { PageTree } from './page-tree';

@Component({
  selector: 'cn-campaign-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, PageTree, PageTemplateDialog],
  providers: [CampaignStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-0 flex-1' },
  template: `@if (store.error()) {
      <div class="m-auto max-w-md p-6 text-center">
        <p class="text-muted">{{ store.error() }}</p>
        <a class="cn-link" routerLink="/campaigns">Back to campaigns</a>
      </div>
    } @else {
      <aside
        class="flex w-72 shrink-0 flex-col border-r border-line bg-panel max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-30 max-lg:shadow-xl"
        [class.max-lg:hidden]="!sidebarOpen()"
      >
        <div class="border-b border-line p-3">
          <a routerLink="/campaigns" class="text-xs text-muted hover:text-accent">← All campaigns</a>
          <div class="mt-1 flex items-center justify-between gap-2">
            <h2 class="truncate font-display text-lg font-bold">{{ store.campaign()?.name }}</h2>
            <span class="cn-badge cn-badge-source">{{ context.ruleset().shortLabel }}</span>
          </div>
        </div>
        <nav class="flex flex-col p-2 text-sm" aria-label="Campaign">
          @for (combat of activeCombats(); track combat.id) {
            <a class="mb-1 rounded bg-accent/10 px-2 py-1 font-semibold text-accent" [routerLink]="combatLink(combat.id)" (click)="sidebarOpen.set(false)">⚔️ {{ combat.name }} · round {{ combat.round }}</a>
          }
          @for (item of visibleNav(); track item.path) {
            <a
              [routerLink]="['/c', id(), ...item.path]"
              routerLinkActive="bg-panel-2 font-semibold text-ink"
              [routerLinkActiveOptions]="{ exact: item.path.length === 0 }"
              class="rounded px-2 py-1 text-muted hover:text-ink"
              (click)="sidebarOpen.set(false)"
              >{{ item.icon }} {{ item.label }}</a
            >
          }
        </nav>
        <div class="flex items-center justify-between border-t border-line px-3 pt-3 pb-1">
          <span class="text-xs font-semibold tracking-wide text-muted uppercase">Pages</span>
          <div class="relative" [hidden]="!store.isGm()">
            <button type="button" class="rounded px-2 text-sm text-muted hover:bg-panel-2 hover:text-accent" (click)="newMenu.set(!newMenu())" aria-haspopup="menu">
              + New
            </button>
            @if (newMenu()) {
              <div class="absolute right-0 z-20 mt-1 w-48 rounded-md border border-line bg-panel p-1 shadow-lg" role="menu">
                @for (t of pageTypes; track t) {
                  <button type="button" role="menuitem" class="block w-full rounded px-2 py-1 text-left text-sm hover:bg-panel-2" (click)="newPage(t)">
                    {{ icons[t] }} {{ labels[t] }}
                  </button>
                }
                <hr class="my-1 border-line" />
                <button type="button" role="menuitem" class="block w-full rounded px-2 py-1 text-left text-sm hover:bg-panel-2" (click)="newMenu.set(false); fromTemplate.set(true)">
                  🧩 From template…
                </button>
              </div>
            }
          </div>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <cn-page-tree />
          @if (!store.pages().length && !store.loading()) {
            <p class="px-2 py-3 text-sm text-muted">No pages yet.</p>
          }
        </div>
      </aside>
      @if (sidebarOpen()) {
        <div class="fixed inset-0 z-20 bg-black/30 lg:hidden" (click)="sidebarOpen.set(false)"></div>
      }
      @if (fromTemplate()) {
        <cn-page-template-dialog [campaignId]="id()" (done)="created($event)" (closed)="fromTemplate.set(false)" />
      }
      <section class="flex min-h-0 min-w-0 flex-1 flex-col">
        <button type="button" class="m-2 self-start rounded border border-line px-2 py-1 text-sm lg:hidden" (click)="sidebarOpen.set(true)">☰ Campaign</button>
        <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
          @if (store.campaign()) {
            <router-outlet />
          }
        </div>
      </section>
    }`,
})
export class CampaignShell implements OnDestroy {
  readonly campaignId = input.required<string>();
  protected readonly store = inject(CampaignStore);
  protected readonly context = inject(ContextService);
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  protected readonly sidebarOpen = signal(false);
  protected readonly newMenu = signal(false);
  protected readonly fromTemplate = signal(false);
  protected readonly pageTypes = PAGE_TYPES;
  protected readonly icons = PAGE_TYPE_ICONS;
  protected readonly labels = PAGE_TYPE_LABELS;
  protected readonly id = this.campaignId;

  /** gm: only game masters see the entry. */
  protected readonly nav = [
    { path: [] as string[], label: 'Overview', icon: '🏠' },
    { path: ['npcs'], label: 'NPCs', icon: PAGE_TYPE_ICONS.npc },
    { path: ['locations'], label: 'Locations', icon: PAGE_TYPE_ICONS.location },
    { path: ['sessions'], label: 'Sessions', icon: PAGE_TYPE_ICONS.session },
    { path: ['quests'], label: 'Quests', icon: PAGE_TYPE_ICONS.quest },
    { path: ['factions'], label: 'Factions', icon: PAGE_TYPE_ICONS.faction },
    { path: ['party'], label: 'Party', icon: PAGE_TYPE_ICONS.pc },
    { path: ['encounters'], label: 'Encounters', icon: '🐉', gm: true },
    { path: ['inventory'], label: 'Inventory', icon: '💰' },
    { path: ['reference'], label: 'Reference', icon: '📚' },
    { path: ['templates'], label: 'Templates', icon: '🧩', gm: true },
    { path: ['settings'], label: 'Settings', icon: '⚙️' },
  ];
  protected readonly visibleNav = computed(() =>
    this.nav
      .filter((n) => !('gm' in n && n.gm) || this.store.isGm())
      // Players get members and house rules there, not settings
      .map((n) => (n.path[0] === 'settings' && !this.store.isGm() ? { ...n, label: 'Members & rules', icon: '👥' } : n)),
  );
  protected readonly activeCombats = signal<{ id: string; name: string; round: number }[]>([]);
  /** Game masters run the combat; players open the player view. */
  protected combatLink(trackerId: string) {
    return this.store.isGm() ? ['/c', this.campaignId(), 'trackers', trackerId] : ['/c', this.campaignId(), 'trackers', trackerId, 'view'];
  }

  constructor() {
    effect(() => {
      const id = this.campaignId();
      untracked(() => {
        void this.store.load(id);
        firstValueFrom(this.http.get<{ trackers: { id: string; name: string; round: number }[] }>(`/api/campaigns/${id}/trackers/active`))
          .then((r) => this.activeCombats.set(r.trackers))
          .catch(() => this.activeCombats.set([]));
      });
    });
    this.store.navigateTo = (pageId) => this.router.navigate(['/c', this.campaignId(), 'p', pageId]);
  }

  protected async newPage(type: PageType) {
    this.newMenu.set(false);
    const page = await this.store.createPage({ type, title: `New ${PAGE_TYPE_LABELS[type]}` });
    this.sidebarOpen.set(false);
    await this.router.navigate(['/c', this.campaignId(), 'p', page.id]);
  }

  protected async created(page: PageDto) {
    this.fromTemplate.set(false);
    await Promise.all([this.store.reloadPages(), this.store.reloadProperties()]);
    this.sidebarOpen.set(false);
    await this.router.navigate(['/c', this.campaignId(), 'p', page.id]);
  }

  ngOnDestroy() {
    this.store.leave();
  }
}
