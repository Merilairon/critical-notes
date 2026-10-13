import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { CampaignStore } from '../campaign.store';
import { facetStr, typedPages, type TypedPage } from './typed-pages';

@Component({
  selector: 'cn-session-log',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="mx-auto w-full max-w-4xl p-4 sm:p-6">
    <div class="flex items-center gap-2">
      <h1 class="font-display text-3xl font-bold">Session log</h1>
      @if (store.isGm()) {
        <button type="button" class="ml-auto rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink" (click)="create()">+ Next session</button>
      }
    </div>
    <ol class="mt-4 flex flex-col gap-2">
      @for (s of sorted(); track s.id) {
        <li class="rounded-lg border border-line bg-panel p-3">
          <div class="flex flex-wrap items-baseline gap-2">
            <a class="font-display text-lg font-bold hover:text-accent" [routerLink]="['/c', store.id(), 'p', s.id]">{{ s.title }}</a>
            @if (num(s) !== null) {<span class="text-sm text-muted">#{{ num(s) }}</span>}
            <span class="text-sm text-muted">{{ str(s, 'date') ?? 'no date' }}</span>
            <span class="cn-badge" [class.cn-badge-modern]="str(s, 'status') === 'planned'" [class.cn-badge-source]="str(s, 'status') !== 'planned'">{{ str(s, 'status') }}</span>
          </div>
          @if (str(s, 'summary'); as summary) {
            <p class="mt-1 text-sm whitespace-pre-line">{{ summary }}</p>
          }
        </li>
      } @empty {
        <li class="text-sm text-muted">No sessions yet.</li>
      }
    </ol>
  </div>`,
})
export class SessionLog {
  protected readonly store = inject(CampaignStore);
  private readonly router = inject(Router);
  private readonly data = typedPages('session');
  protected str = (p: TypedPage, k: string) => facetStr(p, k);
  protected num = (p: TypedPage) => (typeof p.facet?.['number'] === 'number' ? (p.facet['number'] as number) : null);
  protected readonly sorted = computed(() =>
    [...this.data.items()].sort((a, b) => (this.num(b) ?? -1) - (this.num(a) ?? -1) || (facetStr(b, 'date') ?? '').localeCompare(facetStr(a, 'date') ?? '')),
  );

  protected async create() {
    const next = Math.max(0, ...this.data.items().map((s) => this.num(s) ?? 0)) + 1;
    const today = new Date().toISOString().slice(0, 10);
    const p = await this.store.createPage({ type: 'session', title: `Session ${next}`, facet: { number: next, date: today, status: 'planned' } });
    await this.router.navigate(['/c', this.store.id(), 'p', p.id]);
  }
}
