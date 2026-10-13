import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { CampaignStore } from '../campaign.store';
import { facetStr, typedPages, type TypedPage } from './typed-pages';

const COLUMNS = ['rumor', 'active', 'completed', 'failed', 'abandoned'];

@Component({
  selector: 'cn-quest-board',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="w-full p-4 sm:p-6">
    <div class="flex items-center gap-2">
      <h1 class="font-display text-3xl font-bold">Quests</h1>
      @if (store.isGm()) {
        <button type="button" class="ml-auto rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink" (click)="create()">+ Quest</button>
      }
    </div>
    <div class="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-5">
      @for (col of columns(); track col.status) {
        <section class="rounded-lg border border-line bg-panel-2/40 p-2">
          <h2 class="mb-2 px-1 text-xs font-semibold tracking-wide text-muted uppercase">{{ col.status }} · {{ col.items.length }}</h2>
          @for (q of col.items; track q.id) {
            <a class="mb-1.5 block rounded-md border border-line bg-panel p-2 text-sm hover:border-accent" [routerLink]="['/c', store.id(), 'p', q.id]">
              <span class="font-medium">{{ q.title }}</span>
              @if (str(q, 'priority') === 'high') {<span class="ml-1 text-accent">!</span>}
              @if (giver(q); as g) {<span class="block text-xs text-muted">from {{ g }}</span>}
            </a>
          }
        </section>
      }
    </div>
  </div>`,
})
export class QuestBoard {
  protected readonly store = inject(CampaignStore);
  private readonly router = inject(Router);
  private readonly data = typedPages('quest');
  protected str = (p: TypedPage, k: string) => facetStr(p, k);
  protected giver = (q: TypedPage) => {
    const id = facetStr(q, 'giverPageId');
    return id ? (this.store.byId().get(id)?.title ?? null) : null;
  };
  protected readonly columns = computed(() => COLUMNS.map((status) => ({ status, items: this.data.items().filter((q) => (facetStr(q, 'status') ?? 'rumor') === status) })));
  protected async create() {
    const p = await this.store.createPage({ type: 'quest', title: 'New Quest' });
    await this.router.navigate(['/c', this.store.id(), 'p', p.id]);
  }
}
