import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { EncounterSummaryDto, TrackerSummaryDto } from '@cn/shared';
import { CampaignStore } from '../campaign/campaign.store';
import { errorMessage } from '../core/http.interceptor';
import { PlayApi } from './play-api';

/** A campaign's encounters and combats. */
@Component({
  selector: 'cn-encounters-page',
  imports: [RouterLink, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="mx-auto w-full max-w-5xl p-4 sm:p-6">
    <div class="flex flex-wrap items-center gap-2">
      <h1 class="flex-1 font-display text-3xl font-bold">Encounters</h1>
      <button type="button" class="rounded-md border border-line px-3 py-1.5 text-sm hover:border-accent" (click)="newTracker()">New combat</button>
      <button type="button" class="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink" (click)="newEncounter()">New encounter</button>
    </div>
    @if (error()) {<p class="mt-2 text-sm text-accent" role="alert">{{ error() }}</p>}
    @if (trackers().length) {
      <h2 class="mt-5 mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Combats</h2>
      <ul class="grid gap-2 sm:grid-cols-2">
        @for (t of trackers(); track t.id) {
          <li>
            <a class="flex items-center gap-2 rounded-xl border border-line bg-panel p-3 hover:border-accent" [routerLink]="['/c', store.id(), 'trackers', t.id]">
              <span class="text-xl">{{ t.status === 'active' ? '⚔️' : '🏁' }}</span>
              <span class="min-w-0 flex-1"><span class="block truncate font-semibold">{{ t.name }}</span>
                <span class="text-xs text-muted">{{ t.status === 'active' ? (t.round ? 'Round ' + t.round : 'Not started') : 'Ended' }} · {{ t.combatants }} combatants · {{ t.updatedAt | date: 'short' }}</span></span>
            </a>
          </li>
        }
      </ul>
    }
    <h2 class="mt-5 mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Encounters</h2>
    <ul class="grid gap-2 sm:grid-cols-2">
      @for (e of encounters(); track e.id) {
        <li>
          <a class="flex items-center gap-2 rounded-xl border border-line bg-panel p-3 hover:border-accent" [routerLink]="['/c', store.id(), 'encounters', e.id]">
            <span class="min-w-0 flex-1"><span class="block truncate font-semibold">{{ e.name }}</span><span class="text-xs text-muted">{{ e.creatureCount }} creature{{ e.creatureCount === 1 ? '' : 's' }}</span></span>
          </a>
        </li>
      } @empty {
        <li class="text-sm text-muted">No encounters yet. Build one here, or add an encounter block to a page with <kbd>/</kbd>.</li>
      }
    </ul>
  </div>`,
})
export class EncountersPage {
  private readonly api = inject(PlayApi);
  private readonly router = inject(Router);
  protected readonly store = inject(CampaignStore);
  protected readonly encounters = signal<EncounterSummaryDto[]>([]);
  protected readonly trackers = signal<TrackerSummaryDto[]>([]);
  protected readonly error = signal('');

  constructor() {
    this.api
      .encounters(this.store.id()!)
      .then((r) => {
        this.encounters.set(r.encounters);
        this.trackers.set(r.trackers);
      })
      .catch((err: unknown) => this.error.set(errorMessage(err)));
  }

  protected async newEncounter() {
    try {
      const e = await this.api.createEncounter(this.store.id()!, { name: 'New encounter' });
      await this.router.navigate(['/c', this.store.id(), 'encounters', e.id]);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  protected async newTracker() {
    try {
      const t = await this.api.createTracker(this.store.id()!, 'Combat');
      await this.router.navigate(['/c', this.store.id(), 'trackers', t.id]);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }
}
