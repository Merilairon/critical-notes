import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { CampaignStore } from '../campaign.store';
import { facetStr, typedPages, type TypedPage } from './typed-pages';

const KIND_ICON: Record<string, string> = { world: '🌍', region: '🗺️', settlement: '🏘️', site: '📍', room: '🚪', other: '•' };

@Component({
  selector: 'cn-location-node',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ul [class.ml-5]="depth() > 0" [class.border-l]="depth() > 0" class="border-line">
    @for (loc of children(); track loc.id) {
      <li class="py-0.5 pl-2">
        <a class="inline-flex items-center gap-1.5 rounded px-1 hover:bg-panel-2" [routerLink]="['/c', store.id(), 'p', loc.id]">
          <span>{{ icon(loc) }}</span><span>{{ loc.title }}</span><span class="text-xs text-muted capitalize">{{ kind(loc) }}</span>
        </a>
        <cn-location-node [all]="all()" [parentId]="loc.id" [depth]="depth() + 1" />
      </li>
    }
  </ul>`,
})
export class LocationNode {
  readonly all = input.required<TypedPage[]>();
  readonly parentId = input<string | null>(null);
  readonly depth = input(0);
  protected readonly store = inject(CampaignStore);
  protected readonly children = computed(() => {
    const ids = new Set(this.all().map((l) => l.id));
    return this.all().filter((l) => {
      const parent = facetStr(l, 'parentLocationPageId');
      return this.parentId() === null ? !parent || !ids.has(parent) : parent === this.parentId();
    });
  });
  protected icon = (l: TypedPage) => KIND_ICON[facetStr(l, 'kind') ?? 'other'] ?? '•';
  protected kind = (l: TypedPage) => facetStr(l, 'kind') ?? '';
}

@Component({
  selector: 'cn-location-list',
  imports: [LocationNode],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="mx-auto w-full max-w-4xl p-4 sm:p-6">
    <div class="flex items-center gap-2">
      <h1 class="font-display text-3xl font-bold">Locations</h1>
      @if (store.isGm()) {
        <button type="button" class="ml-auto rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink" (click)="create()">+ Location</button>
      }
    </div>
    <p class="mt-1 text-sm text-muted">World → region → settlement → site, from each location's “Part of” property.</p>
    <div class="mt-4 rounded-lg border border-line bg-panel p-3">
      @if (data.items().length) {
        <cn-location-node [all]="data.items()" [parentId]="null" />
      } @else {
        <p class="text-sm text-muted">No locations yet.</p>
      }
    </div>
  </div>`,
})
export class LocationList {
  protected readonly store = inject(CampaignStore);
  private readonly router = inject(Router);
  protected readonly data = typedPages('location');
  protected async create() {
    const p = await this.store.createPage({ type: 'location', title: 'New Location' });
    await this.router.navigate(['/c', this.store.id(), 'p', p.id]);
  }
}
