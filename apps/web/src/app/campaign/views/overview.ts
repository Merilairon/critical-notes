import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { PAGE_TYPE_ICONS, PAGE_TYPE_LABELS, type PageType } from '@cn/shared';
import { ContextService } from '../../core/context.service';
import { CampaignStore } from '../campaign.store';

@Component({
  selector: 'cn-campaign-overview',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="mx-auto w-full max-w-5xl p-4 sm:p-6">
    <h1 class="font-display text-3xl font-bold">{{ store.campaign()?.name }}</h1>
    @if (store.campaign()?.description) {
      <p class="mt-1 text-muted">{{ store.campaign()?.description }}</p>
    }
    <p class="mt-1 text-sm text-muted">{{ context.ruleset().label }}</p>

    <div class="mt-5 grid grid-cols-[repeat(auto-fill,minmax(min(100%,7rem),1fr))] gap-2 sm:grid-cols-4">
      @for (c of counts(); track c.type) {
        <a [routerLink]="c.link" class="rounded-lg border border-line bg-panel px-3 py-3 hover:border-accent">
          <div class="text-2xl">{{ icons[c.type] }}</div>
          <div class="mt-1 flex flex-wrap items-baseline justify-between gap-x-2"><span class="min-w-0 font-medium [overflow-wrap:anywhere]">{{ c.label }}</span><span class="text-muted">{{ c.count }}</span></div>
        </a>
      }
    </div>

    @if (store.isGm()) {
      <div class="mt-5 flex flex-wrap gap-2">
        @for (t of quickTypes; track t) {
          <button type="button" class="rounded-md border border-line px-3 py-1.5 text-sm hover:border-accent touch:min-h-[44px]" (click)="create(t)">+ {{ labels[t] }}</button>
        }
      </div>
    }

    <h2 class="mt-6 mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Recently edited</h2>
    <ul class="divide-y divide-line rounded-lg border border-line bg-panel">
      @for (p of recent(); track p.id) {
        <li>
          <a class="flex items-center gap-2 px-3 py-2 hover:bg-panel-2 touch:min-h-[44px]" [routerLink]="['/c', store.id(), 'p', p.id]">
            <span>{{ p.icon || icons[p.type] }}</span><span class="min-w-0 flex-1 [overflow-wrap:anywhere]">{{ p.title }}</span>
            <span class="shrink-0 text-xs text-muted">{{ labels[p.type] }}</span>
          </a>
        </li>
      } @empty {
        <li class="px-3 py-3 text-sm text-muted">Nothing yet — create a page to get started.</li>
      }
    </ul>
  </div>`,
})
export class CampaignOverview {
  protected readonly store = inject(CampaignStore);
  protected readonly context = inject(ContextService);
  private readonly router = inject(Router);
  protected readonly icons = PAGE_TYPE_ICONS;
  protected readonly labels = PAGE_TYPE_LABELS;
  protected readonly quickTypes: PageType[] = ['session', 'npc', 'location', 'quest'];

  protected readonly counts = computed(() => {
    const id = this.store.id();
    const n = (t: PageType) => this.store.pages().filter((p) => p.type === t).length;
    return [
      { type: 'npc' as PageType, label: 'NPCs', count: n('npc'), link: ['/c', id, 'npcs'] },
      { type: 'location' as PageType, label: 'Locations', count: n('location'), link: ['/c', id, 'locations'] },
      { type: 'session' as PageType, label: 'Sessions', count: n('session'), link: ['/c', id, 'sessions'] },
      { type: 'quest' as PageType, label: 'Quests', count: n('quest'), link: ['/c', id, 'quests'] },
      { type: 'faction' as PageType, label: 'Factions', count: n('faction'), link: ['/c', id, 'factions'] },
      { type: 'pc' as PageType, label: 'Party', count: n('pc'), link: ['/c', id, 'party'] },
    ];
  });
  protected readonly recent = computed(() => [...this.store.pages()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10));

  protected async create(type: PageType) {
    const page = await this.store.createPage({ type, title: `New ${PAGE_TYPE_LABELS[type]}` });
    await this.router.navigate(['/c', this.store.id(), 'p', page.id]);
  }
}
