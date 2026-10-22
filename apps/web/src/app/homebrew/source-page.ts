import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { Router, RouterLink } from '@angular/router';
import {
  HOMEBREW_FORM_TYPES,
  HOMEBREW_TYPE_LABELS,
  type CampaignSummaryDto,
  type CreateHomebrewSourceInput,
  type HomebrewEntitySummaryDto,
  type HomebrewSourceDto,
} from '@cn/shared';
import { AuthService } from '../core/auth.service';
import { ConfirmService } from '../core/confirm.service';
import { errorMessage } from '../core/http.interceptor';
import { HomebrewApi } from './homebrew-api';
import { SourceForm } from './source-form';

/** One homebrew source: its entities by type, sharing, settings and export. */
@Component({
  selector: 'cn-homebrew-source',
  imports: [RouterLink, SourceForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (error()) {
      <p class="p-8 text-center text-muted">{{ error() }}</p>
    } @else if (source(); as s) {
      <div class="mx-auto w-full max-w-5xl p-4 sm:p-6">
        <nav class="mb-1 text-xs text-muted"><a class="hover:text-accent" routerLink="/homebrew">Homebrew</a> /</nav>
        <header class="flex flex-wrap items-center gap-2">
          @if (s.color) {<span class="h-4 w-4 rounded-full" [style.background]="'#' + s.color"></span>}
          <h1 class="min-w-0 flex-1 truncate font-display text-3xl font-bold">{{ s.campaign ? s.campaign.name + ' — campaign content' : s.fullName }}</h1>
          <a class="rounded-md border border-line px-3 py-1.5 text-sm hover:border-accent" [href]="exportUrl()" [attr.download]="s.jsonId + '.json'">Export</a>
          @if (s.canEdit && s.scope !== 'campaign') {
            <button type="button" class="rounded-md border border-line px-3 py-1.5 text-sm hover:border-accent" [attr.aria-expanded]="editing()" (click)="editing.set(!editing())">Settings</button>
          }
        </header>
        <p class="mt-1 text-sm text-muted">
          <span class="font-mono">{{ s.jsonId }}</span> · {{ s.abbreviation }} · {{ s.edition === 'any' ? 'both editions' : s.edition + ' rules' }} · v{{ s.version }}
          @if (s.authors.length) { · by {{ s.authors.join(', ') }} }
          @if (s.scope === 'instance') { · instance-wide }
          @if (!s.canEdit) { · read-only }
        </p>

        @if (editing()) {
          <section class="mt-4 rounded-xl border border-line bg-panel p-4" aria-label="Source settings">
            <cn-source-form [source]="s" [allowInstance]="auth.user()?.isAdmin ?? false" [error]="formError()" (saved)="update($event)" (cancelled)="editing.set(false)" />
            <div class="mt-4 border-t border-line pt-3">
              <button type="button" class="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:border-accent hover:text-accent" (click)="deleteSource()">Delete source</button>
            </div>
          </section>
        }

        @if (s.canEdit && s.scope === 'private' && myCampaigns().length) {
          <section class="mt-4 rounded-xl border border-line bg-panel p-4" aria-label="Campaigns">
            <h2 class="mb-1 text-sm font-semibold">Use in campaigns</h2>
            <div class="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              @for (c of myCampaigns(); track c.id) {
                <label class="flex items-center gap-2">
                  <input type="checkbox" [checked]="isShared(c.id)" (change)="setShared(c.id, $any($event.target).checked)" />
                  {{ c.name }} <span class="text-xs text-muted">({{ c.ruleset }})</span>
                </label>
              }
            </div>
          </section>
        }

        <section class="mt-6">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <input type="search" class="cn-prop-input min-w-0 flex-1" placeholder="Filter…" aria-label="Filter entries" [value]="filter()" (input)="filter.set($any($event.target).value)" />
            <label class="flex items-center gap-1 text-sm text-muted"><input type="checkbox" [checked]="showDeleted()" (change)="toggleDeleted($any($event.target).checked)" /> Show deleted</label>
            @if (s.canEdit) {
              <select class="cn-prop-input" aria-label="New entry" (change)="newEntity($any($event.target))">
                <option value="">+ New…</option>
                @for (t of formTypes; track t) {<option [value]="t">{{ labels[t] }}</option>}
              </select>
            }
          </div>
          @for (group of groups(); track group.type) {
            <h2 class="mt-4 mb-1 text-xs font-semibold tracking-wide text-muted uppercase">{{ labels[group.type] ?? group.type }} ({{ group.items.length }})</h2>
            <ul class="grid gap-1 sm:grid-cols-2">
              @for (e of group.items; track e.id) {
                <li>
                  <a class="flex items-center gap-2 rounded px-2 py-1 hover:bg-panel-2" [class.opacity-60]="e.deleted" [routerLink]="['/homebrew/e', e.id]">
                    <span class="truncate">{{ e.name }}</span>
                    @if (e.copyOf) {<span class="shrink-0 text-xs text-muted">variant of {{ e.copyOf.split('|')[0] }}</span>}
                    @if (e.deleted) {<span class="cn-badge cn-badge-legacy">Deleted</span>}
                    @if (!e.uid && !e.deleted) {<span class="cn-badge cn-badge-legacy" title="Could not be added to the reference; open it to see why">Not indexed</span>}
                  </a>
                </li>
              }
            </ul>
          } @empty {
            <p class="rounded-lg border border-dashed border-line p-6 text-center text-muted">{{ entities().length ? 'Nothing matches.' : 'No entries yet.' }}</p>
          }
        </section>
      </div>
    } @else {
      <p class="p-8 text-center text-muted">Loading…</p>
    }`,
})
export class HomebrewSourcePage {
  readonly sourceId = input.required<string>();
  private readonly confirm = inject(ConfirmService);
  protected readonly auth = inject(AuthService);
  private readonly api = inject(HomebrewApi);
  private readonly router = inject(Router);
  private readonly title = inject(Title);

  protected readonly source = signal<HomebrewSourceDto | null>(null);
  protected readonly entities = signal<HomebrewEntitySummaryDto[]>([]);
  protected readonly campaigns = signal<CampaignSummaryDto[]>([]);
  protected readonly error = signal('');
  protected readonly formError = signal('');
  protected readonly editing = signal(false);
  protected readonly filter = signal('');
  protected readonly showDeleted = signal(false);
  protected readonly formTypes = HOMEBREW_FORM_TYPES;
  protected readonly labels = HOMEBREW_TYPE_LABELS;

  protected readonly myCampaigns = computed(() => this.campaigns().filter((c) => c.role === 'dm'));
  protected readonly exportUrl = computed(() => this.api.exportUrl(this.sourceId()));
  protected readonly groups = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const byType = new Map<string, HomebrewEntitySummaryDto[]>();
    for (const e of this.entities()) {
      if (q && !e.name.toLowerCase().includes(q)) continue;
      byType.set(e.entityType, [...(byType.get(e.entityType) ?? []), e]);
    }
    return [...byType].map(([type, items]) => ({ type, items })).sort((a, b) => (this.labels[a.type] ?? a.type).localeCompare(this.labels[b.type] ?? b.type));
  });

  constructor() {
    effect(() => {
      const id = this.sourceId();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string) {
    this.error.set('');
    try {
      const [source, entities, campaigns] = await Promise.all([this.api.source(id), this.api.entities(id, this.showDeleted()), this.api.campaigns()]);
      this.source.set(source);
      this.entities.set(entities);
      this.campaigns.set(campaigns);
      this.title.setTitle(`${source.fullName} — Homebrew — Critical Notes`);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  protected async toggleDeleted(on: boolean) {
    this.showDeleted.set(on);
    this.entities.set(await this.api.entities(this.sourceId(), on));
  }

  protected isShared(campaignId: string) {
    return this.source()?.sharedWith.some((c) => c.id === campaignId) ?? false;
  }

  protected async setShared(campaignId: string, on: boolean) {
    const s = this.source();
    if (!s) return;
    const mine = new Set(this.myCampaigns().map((c) => c.id));
    const current = s.sharedWith.map((c) => c.id).filter((id) => mine.has(id));
    const next = on ? [...new Set([...current, campaignId])] : current.filter((id) => id !== campaignId);
    this.source.set(await this.api.share(s.id, next));
  }

  protected async update(input: CreateHomebrewSourceInput) {
    this.formError.set('');
    try {
      const { jsonId: _jsonId, ...patch } = input;
      this.source.set(await this.api.updateSource(this.sourceId(), patch));
      this.editing.set(false);
    } catch (err) {
      this.formError.set(errorMessage(err));
    }
  }

  protected async deleteSource() {
    const s = this.source();
    if (!s || !(await this.confirm.ask({ title: 'Delete source?', message: `Delete "${s.fullName}" and its ${s.entityCount} entries? Campaigns using it lose access.`, confirmLabel: 'Delete source' }))) return;
    await this.api.deleteSource(s.id);
    await this.router.navigate(['/homebrew']);
  }

  protected newEntity(select: HTMLSelectElement) {
    const type = select.value;
    select.value = '';
    if (type) void this.router.navigate(['/homebrew/s', this.sourceId(), 'new', type]);
  }
}
