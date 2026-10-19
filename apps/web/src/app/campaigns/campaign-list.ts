import { HttpClient, httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { getRuleset, RULESET_IDS, type RulesetId } from '@cn/fivetools';
import type { CampaignDto, CampaignImportReportDto, CampaignSummaryDto } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../core/http.interceptor';

@Component({
  selector: 'cn-campaign-list',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="mx-auto max-w-4xl p-4 sm:p-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="min-w-0 font-display text-3xl font-bold">Campaigns</h1>
      <span class="flex w-full gap-2 sm:w-auto">
        <label class="cn-btn cursor-pointer px-3 py-2 text-sm font-normal focus-within:ring-2 focus-within:ring-[var(--color-focus)] max-sm:flex-1" [class.opacity-60]="importing()">
          {{ importing() ? 'Importing…' : 'Import campaign' }}
          <input type="file" class="sr-only" accept=".zip,application/zip" [disabled]="importing()" (change)="importFile($any($event.target))" />
        </label>
        <button type="button" class="cn-btn-primary px-3 py-2 text-sm max-sm:flex-1" (click)="creating.set(!creating())">
          {{ creating() ? 'Cancel' : 'New campaign' }}
        </button>
      </span>
    </div>

    @if (imported(); as r) {
      <div class="mt-4 rounded-xl border border-accent/50 bg-accent/5 p-4 text-sm" role="status">
        Imported {{ r.pages }} pages, {{ r.encounters }} encounters, {{ r.templates }} templates, {{ r.homebrew }} homebrew entries and {{ r.uploads }} images.
        <a class="cn-link" [routerLink]="['/c', r.campaignId]">Open the campaign</a>
        @if (r.warnings.length) {
          <ul class="mt-2 list-disc pl-5 text-xs text-muted">@for (w of r.warnings; track $index) {<li>{{ w }}</li>}</ul>
        }
      </div>
    }
    @if (importError()) {<p class="mt-4 text-sm text-accent" role="alert">{{ importError() }}</p>}

    @if (creating()) {
      <form class="mt-4 rounded-xl border border-line bg-panel p-4" (submit)="$event.preventDefault(); create()">
        <label class="mb-3 block text-sm">
          <span class="mb-1 block font-medium">Name</span>
          <input class="cn-input px-3 py-2" name="name" [value]="name()" (input)="name.set($any($event.target).value)" required maxlength="120" />
        </label>
        <label class="mb-3 block text-sm">
          <span class="mb-1 block font-medium">Description</span>
          <textarea class="cn-input px-3 py-2" name="description" rows="2" [value]="description()" (input)="description.set($any($event.target).value)"></textarea>
        </label>
        <fieldset class="mb-3">
          <legend class="mb-1 text-sm font-medium">Rules edition</legend>
          <p class="mb-2 text-xs text-muted">Each campaign uses one edition. You can migrate later, but it is a deliberate, guided step.</p>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-2 sm:grid-cols-2">
            @for (id of rulesets; track id) {
              <label class="flex min-h-[44px] cursor-pointer gap-3 rounded-lg border p-3 text-sm" [class]="ruleset() === id ? 'border-accent bg-accent/5' : 'border-line'">
                <input type="radio" name="ruleset" [value]="id" [checked]="ruleset() === id" (change)="ruleset.set(id)" />
                <span>
                  <span class="block font-semibold">{{ label(id) }}</span>
                  <span class="text-xs text-muted">Core books: {{ core(id) }}</span>
                </span>
              </label>
            }
          </div>
        </fieldset>
        <label class="mb-4 flex min-h-[44px] items-center gap-3 text-sm">
          <input type="checkbox" name="cross" [checked]="crossEdition()" (change)="crossEdition.set($any($event.target).checked)" />
          {{ crossLabel() }}
        </label>
        @if (error()) {
          <p class="mb-3 text-sm text-accent" role="alert">{{ error() }}</p>
        }
        <button class="cn-btn-primary w-full px-3 py-2 text-sm sm:w-auto" [disabled]="busy() || !name().trim()">
          Create campaign
        </button>
      </form>
    }

    @if (list.hasValue()) {
      <div class="mt-5 grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-3 sm:grid-cols-2">
        @for (c of list.value().campaigns; track c.id) {
          <a [routerLink]="['/c', c.id]" class="block rounded-xl border border-line bg-panel p-4 transition hover:border-accent hover:shadow-sm">
            <div class="flex items-start justify-between gap-2">
              <h2 class="min-w-0 font-display text-xl font-bold [overflow-wrap:anywhere]">{{ c.name }}</h2>
              <span class="cn-badge cn-badge-source shrink-0">{{ c.ruleset }}</span>
            </div>
            @if (c.description) {
              <p class="mt-1 line-clamp-2 text-sm text-muted">{{ c.description }}</p>
            }
            <p class="mt-2 text-xs text-muted">
              {{ roleLabel(c.role) }} · {{ c.pageCount }} pages{{ c.status === 'archived' ? ' · archived' : '' }}
            </p>
          </a>
        } @empty {
          @if (!creating()) {
            <p class="rounded-xl border border-dashed border-line p-6 text-muted [grid-column:1/-1]">No campaigns yet. Create your first one.</p>
          }
        }
      </div>
    }
  </div>`,
})
export class CampaignList {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  protected readonly list = httpResource<{ campaigns: CampaignSummaryDto[] }>(() => '/api/campaigns');
  protected readonly rulesets = RULESET_IDS;
  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly name = signal('');
  protected readonly description = signal('');
  protected readonly ruleset = signal<RulesetId>(RULESET_IDS[1]!);
  protected readonly crossEdition = signal(false);

  protected readonly importing = signal(false);
  protected readonly imported = signal<CampaignImportReportDto | null>(null);
  protected readonly importError = signal('');

  protected roleLabel(role: CampaignSummaryDto['role']) {
    return role === 'dm' ? 'Dungeon Master' : role === 'codm' ? 'Co-DM' : 'Player';
  }

  /** A campaign exported from this or another instance becomes a new campaign you own. */
  protected async importFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.importing.set(true);
    this.importError.set('');
    this.imported.set(null);
    try {
      const body = new FormData();
      body.append('file', file);
      this.imported.set(await firstValueFrom(this.http.post<CampaignImportReportDto>('/api/campaigns/import', body)));
      this.list.reload();
    } catch (err) {
      this.importError.set(errorMessage(err));
    } finally {
      this.importing.set(false);
    }
  }

  protected label(id: RulesetId) {
    return getRuleset(id).label;
  }
  protected core(id: RulesetId) {
    return getRuleset(id).coreSources.join(', ');
  }
  protected crossLabel() {
    return getRuleset(this.ruleset()).terminology.crossEditionToggle;
  }

  protected async create() {
    this.busy.set(true);
    this.error.set('');
    try {
      const c = await firstValueFrom(
        this.http.post<CampaignDto>('/api/campaigns', { name: this.name(), description: this.description(), ruleset: this.ruleset(), crossEdition: this.crossEdition() }),
      );
      await this.router.navigate(['/c', c.id]);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
