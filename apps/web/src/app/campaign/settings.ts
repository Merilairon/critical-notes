import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { isSourceEnabled, isSourceEnabledByDefault } from '@cn/fivetools';
import { PAGE_TYPE_ICONS, PAGE_TYPE_LABELS, PAGE_TYPES, type BlockDoc, type HomebrewSourceDto, type PageType, type SourceDto, type TemplateSummaryDto } from '@cn/shared';
import { api } from '../core/api';
import { ContextService, withListedHomebrew } from '../core/context.service';
import { HomebrewApi } from '../homebrew/homebrew-api';
import { TemplateApi } from '../templates/template-api';
import { errorMessage } from '../core/http.interceptor';
import { BlockView } from '../blocks/block-view';
import { BlockEditor } from '../editor/block-editor';
import { CampaignStore } from './campaign.store';
import { EditionMigrationPanel } from './edition-migration';
import { MembersPanel } from './members-panel';

@Component({
  selector: 'cn-campaign-settings',
  imports: [BlockEditor, BlockView, EditionMigrationPanel, MembersPanel, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (store.campaign(); as c) {
    <div class="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <h1 class="font-display text-3xl font-bold">{{ store.isGm() ? 'Settings' : 'Campaign' }}</h1>
      @if (message()) {
        <p class="mt-2 text-sm" [class.text-accent]="isError()" role="status">{{ message() }}</p>
      }

      <section class="mt-4 rounded-xl border border-line bg-panel p-4" aria-label="Members">
        <h2 class="mb-2 font-semibold">Members</h2>
        <cn-members-panel />
      </section>

      @if (!store.isGm()) {
        <section class="mt-4 rounded-xl border border-line bg-panel p-4">
          <h2 class="mb-2 font-semibold">House rules</h2>
          @if (houseRules(); as hr) {<cn-block-view [doc]="$any(hr)" />} @else {<p class="text-sm text-muted">No house rules written down.</p>}
        </section>
      } @else {
      <section class="mt-4 rounded-xl border border-line bg-panel p-4">
        <h2 class="mb-2 font-semibold">General</h2>
        <label class="mb-3 block text-sm">
          <span class="mb-1 block text-muted">Name</span>
          <input class="w-full rounded-md border border-control bg-bg px-3 py-2" [value]="c.name" (change)="save({ name: $any($event.target).value })" />
        </label>
        <label class="mb-3 block text-sm">
          <span class="mb-1 block text-muted">Description</span>
          <textarea class="w-full rounded-md border border-control bg-bg px-3 py-2" rows="2" [value]="c.description" (change)="save({ description: $any($event.target).value })"></textarea>
        </label>
        <p class="text-sm">Rules: <strong>{{ context.ruleset().label }}</strong></p>
        <div class="mt-3 flex flex-wrap gap-2 text-sm">
          <a class="rounded-md border border-line px-3 py-1.5 hover:border-accent" [href]="exportUrl()" download>Export campaign</a>
          @if (c.status === 'active') {
            <button type="button" class="rounded-md border border-line px-3 py-1.5 hover:border-accent" (click)="save({ status: 'archived' })">Archive campaign</button>
          } @else {
            <button type="button" class="rounded-md border border-line px-3 py-1.5 hover:border-accent" (click)="save({ status: 'active' })">Unarchive</button>
          }
        </div>
      </section>

      <section class="mt-4 rounded-xl border border-line bg-panel p-4">
        <h2 class="mb-1 font-semibold">Sources</h2>
        <label class="mb-3 flex items-center gap-2 text-sm">
          <input type="checkbox" [checked]="c.crossEdition" (change)="save({ crossEdition: $any($event.target).checked })" />
          {{ context.ruleset().terminology.crossEditionToggle }}
          <span class="text-muted">— other-edition content is shown with a “{{ context.ruleset().terminology.otherEditionBadge }}” badge.</span>
        </label>
        <div class="grid max-h-96 gap-x-4 overflow-y-auto sm:grid-cols-2">
          @for (s of sources(); track s.id) {
            <label class="flex items-center gap-2 py-0.5 text-sm" [class.opacity-50]="!selectable(s)">
              <input type="checkbox" [checked]="enabled(s)" [disabled]="!selectable(s)" (change)="toggle(s, $any($event.target).checked)" />
              <span class="w-14 shrink-0 truncate font-mono text-xs text-muted" [title]="s.abbreviation">{{ s.abbreviation }}</span>
              <span class="truncate">{{ s.name }}</span>
              @if (s.origin === 'homebrew') {<span class="cn-badge cn-badge-homebrew">HB</span>}
            </label>
          }
        </div>
      </section>

      <section class="mt-4 rounded-xl border border-line bg-panel p-4" aria-label="Homebrew">
        <h2 class="mb-1 font-semibold">Homebrew</h2>
        <p class="mb-2 text-sm text-muted">Choose which of your homebrew sources this campaign uses. Players see that content in the campaign's reference.</p>
        @for (hb of shareable(); track hb.id) {
          <label class="flex items-center gap-2 py-0.5 text-sm">
            <input type="checkbox" [checked]="isShared(hb)" (change)="setShared(hb, $any($event.target).checked)" />
            <span class="truncate">{{ hb.fullName }}</span>
            <span class="font-mono text-xs text-muted">{{ hb.jsonId }}</span>
            <span class="text-xs text-muted">· {{ hb.entityCount }} entr{{ hb.entityCount === 1 ? 'y' : 'ies' }}</span>
          </label>
        } @empty {
          <p class="text-sm text-muted">You have no homebrew sources yet.</p>
        }
        <p class="mt-2 text-sm">
          @if (ownSource(); as own) {
            <a class="cn-link" [routerLink]="['/homebrew/s', own.id]">Campaign-only content ({{ own.entityCount }})</a> ·
          }
          <a class="cn-link" routerLink="/homebrew">Manage homebrew</a>
        </p>
      </section>

      <section class="mt-4 rounded-xl border border-line bg-panel p-4" aria-label="Templates">
        <h2 class="mb-1 font-semibold">Templates for new pages</h2>
        <p class="mb-2 text-sm text-muted">New pages of a type start from this page template (fields you have not filled in stay as fields).</p>
        <div class="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          @for (t of pageTypes; track t) {
            <label class="flex items-center gap-2 text-sm">
              <span class="w-32 shrink-0">{{ typeIcons[t] }} {{ typeLabels[t] }}</span>
              <select class="cn-prop-input min-w-0 flex-1" (change)="setDefault(t, $any($event.target).value || null)" [attr.aria-label]="'Template for ' + typeLabels[t]">
                <option value="" [selected]="!templateDefaults()[t]">— blank page —</option>
                @for (pt of pageTemplatesFor(t); track pt.id) {<option [value]="pt.id" [selected]="pt.id === templateDefaults()[t]">{{ pt.name }}</option>}
              </select>
            </label>
          }
        </div>
        <p class="mt-2 text-sm"><a class="cn-link" [routerLink]="['/c', store.id(), 'templates']">Manage templates</a></p>
      </section>

      <section class="mt-4 rounded-xl border border-line bg-panel p-4">
        <h2 class="mb-2 font-semibold">House rules</h2>
        <cn-block-editor label="House rules" [doc]="houseRules()" placeholder="Describe your table's house rules…" (changed)="queueHouseRules($event)" />
      </section>

      @if (store.isOwner()) {
        <section class="mt-4 rounded-xl border border-line bg-panel p-4" aria-label="Edition">
          <h2 class="mb-2 font-semibold">Change edition</h2>
          <cn-edition-migration />
        </section>
      }
      }
    </div>
  }`,
})
export class CampaignSettings {
  protected readonly store = inject(CampaignStore);
  protected readonly context = inject(ContextService);
  protected readonly message = signal('');
  protected readonly isError = signal(false);
  private readonly sourceList = httpResource<{ sources: SourceDto[] }>(() => (this.store.isGm() ? { url: api.sources, params: this.context.params() } : undefined));
  protected readonly exportUrl = computed(() => `/api/campaigns/${this.store.id()}/export`);
  protected readonly sources = computed(() =>
    (this.sourceList.hasValue() ? this.sourceList.value().sources : [])
      .filter((s) => s.entityCount > 0)
      .sort((a, b) => Number(!this.defaultOn(a)) - Number(!this.defaultOn(b)) || (a.published ?? '').localeCompare(b.published ?? '')),
  );
  protected readonly houseRules = computed(() => (this.store.campaign()?.houseRules as BlockDoc | null) ?? null);
  private readonly homebrewApi = inject(HomebrewApi);
  private readonly homebrew = signal<HomebrewSourceDto[]>([]);
  protected readonly shareable = computed(() => this.homebrew().filter((s) => s.canEdit && s.scope === 'private'));
  protected readonly ownSource = computed(() => this.homebrew().find((s) => s.campaign?.id === this.store.id()) ?? null);
  private readonly policy = computed(() => withListedHomebrew(this.context.policy(), this.sourceList.hasValue() ? this.sourceList.value().sources : []));

  private readonly templateApi = inject(TemplateApi);
  protected readonly pageTypes = PAGE_TYPES;
  protected readonly typeLabels = PAGE_TYPE_LABELS;
  protected readonly typeIcons = PAGE_TYPE_ICONS;
  protected readonly templateDefaults = signal<Record<string, string>>({});
  private readonly pageTemplates = signal<TemplateSummaryDto[]>([]);

  constructor() {
    // The campaign's tools are for game masters; players only see members and house rules
    effect(() => {
      const id = this.store.id();
      if (!id || !this.store.isGm()) return;
      untracked(() => {
        void this.homebrewApi.sources().then((s) => this.homebrew.set(s));
        void this.templateApi.defaults(id).then((d) => this.templateDefaults.set(d));
        void this.templateApi.list({ campaignId: id, kind: 'page' }).then((t) => this.pageTemplates.set(t));
      });
    });
  }

  /** Templates for this page type first, then the others. */
  protected pageTemplatesFor(type: PageType) {
    const all = this.pageTemplates();
    return [...all.filter((t) => t.pageType === type), ...all.filter((t) => t.pageType !== type)];
  }

  protected async setDefault(type: PageType, templateId: string | null) {
    try {
      this.templateDefaults.set(await this.templateApi.setDefault(this.store.id()!, type, templateId));
      this.isError.set(false);
      this.message.set('Saved');
    } catch (err) {
      this.isError.set(true);
      this.message.set(errorMessage(err));
    }
  }

  protected isShared(s: HomebrewSourceDto) {
    return s.sharedWith.some((c) => c.id === this.store.id());
  }

  protected async setShared(s: HomebrewSourceDto, on: boolean) {
    const id = this.store.id()!;
    const current = s.sharedWith.map((c) => c.id);
    const next = on ? [...new Set([...current, id])] : current.filter((c) => c !== id);
    try {
      const updated = await this.homebrewApi.share(s.id, next);
      this.homebrew.update((list) => list.map((x) => (x.id === updated.id ? updated : x)));
      this.sourceList.reload();
      this.message.set(on ? `${s.fullName} is now used in this campaign` : `${s.fullName} is no longer used here`);
      this.isError.set(false);
    } catch (err) {
      this.isError.set(true);
      this.message.set(errorMessage(err));
    }
  }
  private houseTimer: ReturnType<typeof setTimeout> | undefined;

  private defaultOn(s: SourceDto) {
    return isSourceEnabledByDefault(s, { ...this.policy(), crossEdition: false });
  }

  protected enabled(s: SourceDto) {
    return isSourceEnabled(s, this.policy());
  }

  protected selectable(s: SourceDto) {
    return this.policy().crossEdition || this.defaultOn(s);
  }

  protected toggle(s: SourceDto, on: boolean) {
    const byDefault = isSourceEnabledByDefault(s, this.policy());
    this.save({ sourceOverrides: { [s.id.toLowerCase()]: on === byDefault ? null : on } });
  }

  protected queueHouseRules(doc: BlockDoc) {
    clearTimeout(this.houseTimer);
    this.houseTimer = setTimeout(() => this.save({ houseRules: doc }, false), 800);
  }

  protected async save(patch: Parameters<CampaignStore['updateCampaign']>[0], announce = true) {
    try {
      await this.store.updateCampaign(patch);
      this.isError.set(false);
      if (announce) this.message.set('Saved');
    } catch (err) {
      this.isError.set(true);
      this.message.set(errorMessage(err));
    }
  }
}
