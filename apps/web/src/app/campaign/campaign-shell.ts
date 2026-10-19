import type { ElementRef, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  HostListener,
  inject,
  Injector,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, firstValueFrom } from 'rxjs';
import { PAGE_TYPE_ICONS, PAGE_TYPE_LABELS, PAGE_TYPES, type PageDto, type PageType } from '@cn/shared';
import { PageTemplateDialog } from '../templates/page-template-dialog';
import { ContextService } from '../core/context.service';
import { LayoutService } from '../core/layout.service';
import { CampaignStore } from './campaign.store';
import { PageTree } from './page-tree';
import { UndoToast } from './undo-toast';

@Component({
  selector: 'cn-campaign-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, PageTree, PageTemplateDialog, UndoToast],
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
        id="campaign-drawer"
        class="flex w-72 shrink-0 flex-col border-r border-line bg-panel max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-40 max-lg:w-[min(20rem,85vw)] max-lg:overflow-y-auto max-lg:overscroll-contain max-lg:pt-[env(safe-area-inset-top)] max-lg:pb-[env(safe-area-inset-bottom)] max-lg:pl-[env(safe-area-inset-left)] max-lg:shadow-xl"
        [class.max-lg:hidden]="!layout.drawerOpen()"
        [attr.role]="layout.compact() ? 'dialog' : null"
        [attr.aria-modal]="layout.compact() ? 'true' : null"
        aria-label="Campaign navigation"
      >
        <div class="border-b border-line p-3">
          <div class="flex items-center justify-between gap-2">
            <a
              routerLink="/campaigns"
              class="flex min-h-[44px] items-center text-sm text-muted hover:text-accent lg:min-h-0 lg:text-xs"
              (click)="layout.drawerOpen.set(false)"
              >← All campaigns</a
            >
            <button
              type="button"
              #closeBtn
              class="cn-hdr-btn lg:hidden"
              aria-label="Close campaign navigation"
              (click)="layout.drawerOpen.set(false)"
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 class="min-w-0 font-display text-lg font-bold break-words">{{ store.campaign()?.name }}</h2>
            <span class="cn-badge cn-badge-source">{{ context.ruleset().shortLabel }}</span>
          </div>
        </div>
        <nav class="flex flex-col p-2 text-sm short:grid short:grid-cols-2 short:gap-x-1" aria-label="Campaign">
          @for (combat of activeCombats(); track combat.id) {
            <a
              class="mb-1 flex min-h-[44px] items-center rounded bg-accent/10 px-3 text-base font-semibold text-accent short:col-span-2 lg:min-h-0 lg:px-2 lg:py-1 lg:text-sm"
              [routerLink]="combatLink(combat.id)"
              (click)="layout.drawerOpen.set(false)"
              >⚔️ {{ combat.name }} · round {{ combat.round }}</a
            >
          }
          @for (item of visibleNav(); track item.path) {
            <a
              [routerLink]="['/c', id(), ...item.path]"
              routerLinkActive="bg-panel-2 font-semibold text-ink"
              [routerLinkActiveOptions]="{ exact: item.path.length === 0 }"
              class="flex min-h-[44px] items-center gap-2 rounded px-3 text-base text-muted hover:text-ink lg:min-h-0 lg:px-2 lg:py-1 lg:text-sm"
              (click)="layout.drawerOpen.set(false)"
              >{{ item.icon }} {{ item.label }}</a
            >
          }
        </nav>
        <div class="flex items-center justify-between border-t border-line px-3 pt-3 pb-1">
          <span class="text-xs font-semibold tracking-wide text-muted uppercase">Pages</span>
          <div class="relative" [hidden]="!store.isGm()">
            <button
              type="button"
              class="rounded px-2 text-sm text-muted hover:bg-panel-2 hover:text-accent max-lg:min-h-[44px] max-lg:min-w-[44px]"
              (click)="newMenu.set(!newMenu())"
              aria-haspopup="menu"
            >
              + New
            </button>
            @if (newMenu()) {
              <div
                class="absolute right-0 z-20 mt-1 w-48 rounded-md border border-line bg-panel p-1 shadow-lg"
                role="menu"
              >
                @for (t of pageTypes; track t) {
                  <button
                    type="button"
                    role="menuitem"
                    class="block w-full rounded px-2 py-1 text-left text-sm hover:bg-panel-2 touch:min-h-[44px]"
                    (click)="newPage(t)"
                  >
                    {{ icons[t] }} {{ labels[t] }}
                  </button>
                }
                <hr class="my-1 border-line" />
                <button
                  type="button"
                  role="menuitem"
                  class="block w-full rounded px-2 py-1 text-left text-sm hover:bg-panel-2 touch:min-h-[44px]"
                  (click)="newMenu.set(false); fromTemplate.set(true)"
                >
                  🧩 From template…
                </button>
              </div>
            }
          </div>
        </div>
        <div class="px-2 pb-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          <cn-page-tree />
          @if (!store.pages().length && !store.loading()) {
            <p class="px-2 py-3 text-sm text-muted">No pages yet.</p>
          }
        </div>
      </aside>
      @if (layout.drawerOpen()) {
        <div class="fixed inset-0 z-35 bg-black/30 lg:hidden" (click)="layout.drawerOpen.set(false)"></div>
      }
      @if (fromTemplate()) {
        <cn-page-template-dialog [campaignId]="id()" (done)="created($event)" (closed)="fromTemplate.set(false)" />
      }
      <section class="flex min-h-0 min-w-0 flex-1 flex-col" [attr.inert]="layout.drawerOpen() ? '' : null">
        <div
          class="flex min-h-0 flex-1 flex-col overflow-y-auto"
          [style.padding-bottom]="toastShown() ? 'calc(8rem + env(safe-area-inset-bottom))' : null"
          [class.scroll-pb-32]="toastShown()"
          data-campaign-main
          tabindex="-1"
        >
          @if (store.campaign()) {
            <router-outlet />
          }
        </div>
      </section>
      <cn-undo-toast />
    }`,
})
export class CampaignShell implements OnDestroy {
  readonly campaignId = input.required<string>();
  protected readonly store = inject(CampaignStore);
  protected readonly context = inject(ContextService);
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  protected readonly layout = inject(LayoutService);
  private readonly injector = inject(Injector);
  private readonly closeBtn = viewChild<ElementRef<HTMLElement>>('closeBtn');
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
    { path: ['trash'], label: 'Trash', icon: '🗑️', gm: true },
    { path: ['settings'], label: 'Settings', icon: '⚙️' },
  ];
  protected readonly visibleNav = computed(() =>
    this.nav
      .filter((n) => !('gm' in n && n.gm) || this.store.isGm())
      // Players get members and house rules there, not settings
      .map((n) =>
        n.path[0] === 'settings' && !this.store.isGm() ? { ...n, label: 'Members & rules', icon: '👥' } : n,
      ),
  );
  /** The fixed toast covers the bottom of the content: leave room so focused elements scroll clear of it. */
  protected readonly toastShown = computed(() => !!this.store.undo() || !!this.store.toast());
  protected readonly activeCombats = signal<{ id: string; name: string; round: number }[]>([]);
  /** Game masters run the combat; players open the player view. */
  protected combatLink(trackerId: string) {
    return this.store.isGm()
      ? ['/c', this.campaignId(), 'trackers', trackerId]
      : ['/c', this.campaignId(), 'trackers', trackerId, 'view'];
  }

  constructor() {
    effect(() => {
      const id = this.campaignId();
      untracked(() => {
        void this.store.load(id);
        firstValueFrom(
          this.http.get<{ trackers: { id: string; name: string; round: number }[] }>(
            `/api/campaigns/${id}/trackers/active`,
          ),
        )
          .then((r) => this.activeCombats.set(r.trackers))
          .catch(() => this.activeCombats.set([]));
      });
    });
    // Any navigation (tree links included) closes the drawer
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.layout.drawerOpen.set(false));
    // Opening the drawer puts focus on its close button
    effect(() => {
      if (this.layout.drawerOpen())
        afterNextRender(() => this.closeBtn()?.nativeElement.focus(), { injector: this.injector });
    });
    this.store.navigateTo = (pageId) => this.router.navigate(['/c', this.campaignId(), 'p', pageId]);
  }

  protected async newPage(type: PageType) {
    this.newMenu.set(false);
    const page = await this.store.createPage({ type, title: `New ${PAGE_TYPE_LABELS[type]}` });
    this.layout.drawerOpen.set(false);
    await this.router.navigate(['/c', this.campaignId(), 'p', page.id]);
  }

  protected async created(page: PageDto) {
    this.fromTemplate.set(false);
    await Promise.all([this.store.reloadPages(), this.store.reloadProperties()]);
    this.layout.drawerOpen.set(false);
    await this.router.navigate(['/c', this.campaignId(), 'p', page.id]);
  }

  @HostListener('document:keydown.escape')
  protected onEscape() {
    if (this.layout.drawerOpen() && !this.fromTemplate()) this.layout.drawerOpen.set(false);
  }

  ngOnDestroy() {
    this.layout.drawerOpen.set(false);
    this.store.leave();
  }
}
