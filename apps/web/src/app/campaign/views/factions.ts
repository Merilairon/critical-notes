import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { CampaignStore } from '../campaign.store';
import { facetStr, typedPages, type TypedPage } from './typed-pages';

@Component({
  selector: 'cn-faction-list',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="mx-auto w-full max-w-5xl p-4 sm:p-6">
    <div class="flex items-center gap-2">
      <h1 class="font-display text-3xl font-bold">Factions</h1>
      @if (store.isGm()) {
        <button type="button" class="ml-auto rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink" (click)="create()">+ Faction</button>
      }
    </div>
    <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      @for (f of data.items(); track f.id) {
        <a class="rounded-lg border border-line bg-panel p-3 hover:border-accent" [routerLink]="['/c', store.id(), 'p', f.id]">
          <div class="font-display text-lg font-bold">{{ f.icon ?? '🛡️' }} {{ f.title }}</div>
          <div class="mt-1 text-sm text-muted capitalize">{{ str(f, 'status') }} · {{ str(f, 'attitude') }} toward the party</div>
          <div class="mt-1 text-xs text-muted">{{ members(f) }} known members</div>
        </a>
      } @empty {
        <p class="text-sm text-muted">No factions yet.</p>
      }
    </div>
  </div>`,
})
export class FactionList {
  protected readonly store = inject(CampaignStore);
  private readonly router = inject(Router);
  protected readonly data = typedPages('faction');
  private readonly npcs = typedPages('npc');
  protected str = (p: TypedPage, k: string) => facetStr(p, k);
  protected members = (f: TypedPage) => this.npcs.items().filter((n) => facetStr(n, 'factionPageId') === f.id).length;
  protected async create() {
    const p = await this.store.createPage({ type: 'faction', title: 'New Faction' });
    await this.router.navigate(['/c', this.store.id(), 'p', p.id]);
  }
}
