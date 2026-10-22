import { HttpClient, httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { EntityDto, PageDto } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { api } from '../core/api';
import { ContextService } from '../core/context.service';
import { errorMessage } from '../core/http.interceptor';
import { EntityView } from '../reference/entity-view';
import { CampaignStore } from './campaign.store';
import { RefPicker } from './ref-picker';

/** Statblock for an NPC page: link a bestiary entry, or clone it as a campaign-only `_copy` and customize. */
@Component({
  selector: 'cn-npc-statblock',
  imports: [EntityView, RefPicker, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="rounded-xl border border-line bg-panel p-3 sm:p-4">
    <div class="mb-2 flex flex-wrap items-center gap-2">
      <h2 class="font-display text-lg font-bold">Statblock</h2>
      @if (homebrewId()) {
        <span class="cn-badge cn-badge-homebrew">Customized</span>
      }
      <div class="ml-auto flex flex-wrap gap-2 text-sm">
        @if (uid() && !homebrewId()) {
          <button type="button" class="rounded-md border border-line px-2 py-1 hover:border-accent" (click)="customize()" [disabled]="busy()">Customize copy</button>
        }
        @if (homebrewId()) {
          <button type="button" class="rounded-md border border-line px-2 py-1 hover:border-accent" (click)="openJson()">{{ jsonOpen() ? 'Close editor' : 'Edit statblock JSON' }}</button>
        }
        @if (uid()) {
          <button type="button" class="rounded-md border border-line px-2 py-1 text-muted hover:border-accent" (click)="unlink()">Unlink</button>
        }
      </div>
    </div>

    @if (!uid()) {
      <p class="mb-2 text-sm text-muted">Pick a creature from the bestiary to use as this NPC's statblock.</p>
      <cn-ref-picker kind="monster" placeholder="Search the bestiary…" (selected)="link($event)" />
    } @else if (entity.hasValue()) {
      @if (jsonOpen()) {
        <div class="mb-3">
          <p class="mb-1 text-xs text-muted">
            Stored as a 5etools <code>_copy</code> of the original: only your changes are saved, everything else is inherited. Full editors arrive with homebrew support.
          </p>
          <textarea class="h-64 w-full rounded-md border border-control bg-bg p-2 font-mono text-xs" [(ngModel)]="jsonText" spellcheck="false" aria-label="Statblock JSON"></textarea>
          <div class="mt-1 flex items-center gap-2">
            <button type="button" class="rounded-md bg-accent px-3 py-1 text-sm font-medium text-accent-ink" (click)="saveJson()" [disabled]="busy()">Save</button>
            @if (jsonError()) {
              <span class="text-sm text-accent">{{ jsonError() }}</span>
            }
          </div>
        </div>
      }
      <cn-entity-view [entity]="entity.value()" [compact]="true" />
    } @else if (entity.error()) {
      <p class="text-sm text-muted">The linked statblock is not available in this campaign's sources.</p>
    }
    @if (error()) {
      <p class="mt-2 text-sm text-accent">{{ error() }}</p>
    }
  </section>`,
})
export class NpcStatblock {
  readonly page = input.required<PageDto>();
  readonly facetChange = output<Record<string, unknown>>();
  readonly pageReplaced = output<PageDto>();

  private readonly http = inject(HttpClient);
  private readonly store = inject(CampaignStore);
  private readonly context = inject(ContextService);

  protected readonly uid = computed(() => (this.page().facet?.['statblockUid'] as string | null) ?? null);
  protected readonly homebrewId = computed(() => (this.page().facet?.['statblockHomebrewEntityId'] as string | null) ?? null);
  protected readonly entity = httpResource<EntityDto>(() => {
    const uid = this.uid();
    return uid ? { url: api.entity(uid), params: this.context.params() } : undefined;
  });
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly jsonOpen = signal(false);
  protected readonly jsonError = signal('');
  protected jsonText = '';

  protected link(uid: string | null) {
    this.facetChange.emit({ statblockUid: uid, statblockHomebrewEntityId: null });
  }

  protected unlink() {
    this.jsonOpen.set(false);
    this.facetChange.emit({ statblockUid: null, statblockHomebrewEntityId: null });
  }

  protected async customize() {
    this.busy.set(true);
    this.error.set('');
    try {
      const res = await firstValueFrom(
        this.http.post<{ page: PageDto }>(`/api/campaigns/${this.store.id()}/npc-statblocks`, { pageId: this.page().id, baseUid: this.uid() }),
      );
      this.pageReplaced.emit(res.page);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async openJson() {
    if (this.jsonOpen()) return this.jsonOpen.set(false);
    const res = await firstValueFrom(this.http.get<{ data: unknown }>(`/api/campaigns/${this.store.id()}/homebrew/${this.homebrewId()}`));
    this.jsonText = JSON.stringify(res.data, null, 2);
    this.jsonError.set('');
    this.jsonOpen.set(true);
  }

  protected async saveJson() {
    let data: unknown;
    try {
      data = JSON.parse(this.jsonText);
    } catch (e) {
      this.jsonError.set(`Invalid JSON: ${(e as Error).message}`);
      return;
    }
    this.busy.set(true);
    this.jsonError.set('');
    try {
      await firstValueFrom(this.http.put(`/api/campaigns/${this.store.id()}/homebrew/${this.homebrewId()}`, { data }));
      const page = await firstValueFrom(this.http.get<PageDto>(`/api/campaigns/${this.store.id()}/pages/${this.page().id}`));
      this.pageReplaced.emit(page);
      this.entity.reload();
    } catch (err) {
      this.jsonError.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
