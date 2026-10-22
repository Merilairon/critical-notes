import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PAGE_TYPE_ICONS, type BacklinkDto } from '@cn/shared';
import { CampaignStore } from './campaign.store';

const KIND_LABELS: Record<BacklinkDto['kinds'][number], string> = { mention: 'mentioned', embed: 'embedded', property: 'linked' };

/** Pages that link to this one ([[mentions]], embeds and page-link properties/facets). */
@Component({
  selector: 'cn-backlinks-panel',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<h2 class="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Linked from</h2>
    <ul class="grid gap-1 sm:grid-cols-2">
      @for (b of links(); track b.id) {
        <li>
          <a class="flex items-center gap-2 rounded px-2 py-1 hover:bg-panel-2" [routerLink]="['/c', store.id(), 'p', b.id]">
            <span>{{ b.icon || icons[b.type] }}</span>
            <span class="min-w-0 [overflow-wrap:anywhere]">{{ b.title }}</span>
            <span class="ml-auto shrink-0 text-xs text-muted">{{ label(b) }}</span>
          </a>
        </li>
      } @empty {
        <li class="px-2 text-sm text-muted">{{ backlinks.isLoading() ? 'Loading…' : 'No other pages link here yet. Type [[ in another page to link it.' }}</li>
      }
    </ul>`,
})
export class BacklinksPanel {
  readonly pageId = input.required<string>();
  /** Bump to refetch (e.g. after this page was saved). */
  readonly refresh = input(0);
  protected readonly store = inject(CampaignStore);
  protected readonly icons = PAGE_TYPE_ICONS;
  protected readonly backlinks = httpResource<{ backlinks: BacklinkDto[] }>(() => {
    this.refresh();
    return `/api/campaigns/${this.store.id()}/pages/${this.pageId()}/backlinks`;
  });
  protected readonly links = computed(() => (this.backlinks.hasValue() ? this.backlinks.value().backlinks : []));
  protected label(b: BacklinkDto) {
    return b.kinds.map((k) => KIND_LABELS[k]).join(', ');
  }
}
