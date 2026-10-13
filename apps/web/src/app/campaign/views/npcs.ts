import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { CampaignStore } from '../campaign.store';
import { facetStr, typedPages, type TypedPage } from './typed-pages';

@Component({
  selector: 'cn-npc-list',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="mx-auto w-full max-w-6xl p-4 sm:p-6">
    <div class="flex flex-wrap items-center gap-2">
      <h1 class="font-display text-3xl font-bold">NPCs</h1>
      <input class="ml-auto rounded-md border border-line bg-panel px-3 py-1.5 text-sm" placeholder="Filter…" (input)="filter.set($any($event.target).value)" aria-label="Filter NPCs" />
      @if (store.isGm()) {
        <button type="button" class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink" (click)="create()">+ NPC</button>
      }
    </div>
    <div class="mt-4 overflow-x-auto rounded-lg border border-line bg-panel">
      <table class="w-full text-sm">
        <thead class="text-left text-xs text-muted uppercase">
          <tr><th class="px-3 py-2">Name</th><th class="px-3 py-2">Role</th><th class="px-3 py-2">Status</th><th class="px-3 py-2">Attitude</th><th class="px-3 py-2">Faction</th><th class="px-3 py-2">Location</th><th class="px-3 py-2">Statblock</th></tr>
        </thead>
        <tbody>
          @for (n of rows(); track n.id) {
            <tr class="border-t border-line hover:bg-panel-2">
              <td class="px-3 py-2"><a class="cn-link" [routerLink]="['/c', store.id(), 'p', n.id]">{{ n.title }}</a></td>
              <td class="px-3 py-2 text-muted">{{ str(n, 'role') ?? '' }}</td>
              <td class="px-3 py-2 capitalize">{{ str(n, 'status') }}</td>
              <td class="px-3 py-2 capitalize">{{ str(n, 'attitude') }}</td>
              <td class="px-3 py-2">{{ title(str(n, 'factionPageId')) }}</td>
              <td class="px-3 py-2">{{ title(str(n, 'locationPageId')) }}</td>
              <td class="px-3 py-2">
                @if (str(n, 'statblockHomebrewEntityId')) {<span class="cn-badge cn-badge-homebrew">custom</span>}
                @else if (str(n, 'statblockUid')) {<span class="cn-badge cn-badge-source">linked</span>}
              </td>
            </tr>
          } @empty {
            <tr><td colspan="7" class="px-3 py-4 text-muted">No NPCs yet.</td></tr>
          }
        </tbody>
      </table>
    </div>
  </div>`,
})
export class NpcList {
  protected readonly store = inject(CampaignStore);
  private readonly router = inject(Router);
  private readonly data = typedPages('npc');
  protected readonly filter = signal('');
  protected readonly rows = computed(() => {
    const q = this.filter().toLowerCase();
    return this.data.items().filter((n) => !q || n.title.toLowerCase().includes(q) || (facetStr(n, 'role') ?? '').toLowerCase().includes(q));
  });
  protected str = (p: TypedPage, k: string) => facetStr(p, k);
  protected title(id: string | null) {
    return id ? (this.store.byId().get(id)?.title ?? '—') : '—';
  }
  protected async create() {
    const p = await this.store.createPage({ type: 'npc', title: 'New NPC' });
    await this.router.navigate(['/c', this.store.id(), 'p', p.id]);
  }
}
