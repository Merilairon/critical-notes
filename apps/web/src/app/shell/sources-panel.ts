import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { isSourceEnabled, isSourceEnabledByDefault, type CampaignPolicy } from '@cn/fivetools';
import type { SourceDto } from '@cn/shared';
import { api } from '../core/api';
import { ContextService, withListedHomebrew } from '../core/context.service';

interface SourceGroup {
  title: string;
  sources: SourceDto[];
}

/** Per-source toggles for the current rules context. */
@Component({
  selector: 'cn-sources-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="fixed inset-0 z-40 flex justify-end bg-black/30" (click)="closed.emit()">
    <aside class="flex h-full w-full max-w-md flex-col bg-panel shadow-2xl" (click)="$event.stopPropagation()" aria-label="Sources">
      <header class="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 class="font-display text-lg font-bold">Sources</h2>
        <button type="button" class="rounded px-2 py-1 text-muted hover:bg-panel-2" (click)="closed.emit()" aria-label="Close">✕</button>
      </header>
      <div class="flex-1 overflow-y-auto px-4 py-3">
        <p class="mb-3 text-sm text-muted">
          Books enabled for {{ context.ruleset().label }}.
          @if (!context.crossEdition()) {
            Turn on “{{ crossLabel() }}” to also choose books from the other edition.
          }
        </p>
        @for (group of groups(); track group.title) {
          <h3 class="mt-3 mb-1 text-xs font-semibold tracking-wide text-muted uppercase">{{ group.title }}</h3>
          @for (s of group.sources; track s.id) {
            <label class="flex items-center gap-2 py-1 text-sm" [class.opacity-50]="!selectable(s)">
              <input type="checkbox" [checked]="enabled(s)" [disabled]="!selectable(s)" (change)="toggle(s, $any($event.target).checked)" />
              <span class="w-16 shrink-0 font-mono text-xs text-muted">{{ s.abbreviation }}</span>
              <span class="truncate">{{ s.name }}</span>
              @if (s.legacy) {
                <span class="cn-badge cn-badge-legacy">Legacy</span>
              }
            </label>
          }
        }
      </div>
      <footer class="flex justify-between border-t border-line px-4 py-3 text-sm">
        <button type="button" class="text-muted underline" (click)="reset()">Reset to defaults</button>
        <button type="button" class="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-ink" (click)="closed.emit()">Done</button>
      </footer>
    </aside>
  </div>`,
})
export class SourcesPanel {
  readonly closed = output<void>();
  protected readonly context = inject(ContextService);
  protected readonly sources = httpResource<{ sources: SourceDto[] }>(() => api.sources);

  protected readonly crossLabel = computed(() => this.context.ruleset().terminology.crossEditionToggle);

  protected readonly groups = computed<SourceGroup[]>(() => {
    if (!this.sources.hasValue()) return [];
    const policy = this.policy();
    const all = this.sources.value().sources.filter((s) => s.entityCount > 0);
    const homebrew = all.filter((s) => s.origin === 'homebrew');
    const list = all.filter((s) => s.origin !== 'homebrew');
    const inEdition = list.filter((s) => isSourceEnabledByDefault(s, { ...policy, crossEdition: false }));
    const other = list.filter((s) => !inEdition.includes(s));
    const byKind = (arr: SourceDto[], prefix: string): SourceGroup[] => [
      { title: `${prefix} — books`, sources: arr.filter((s) => s.kind !== 'adventure').sort(this.order) },
      { title: `${prefix} — adventures`, sources: arr.filter((s) => s.kind === 'adventure').sort(this.order) },
    ];
    return [...byKind(inEdition, 'This edition'), { title: 'Your homebrew', sources: homebrew.sort(this.order) }, ...byKind(other, 'Other edition')].filter(
      (g) => g.sources.length,
    );
  });

  private readonly policy = computed<CampaignPolicy>(() =>
    withListedHomebrew(this.context.policy(), this.sources.hasValue() ? this.sources.value().sources : []),
  );

  private readonly order = (a: SourceDto, b: SourceDto) => (a.published ?? '').localeCompare(b.published ?? '') || a.name.localeCompare(b.name);

  protected enabled(s: SourceDto): boolean {
    return isSourceEnabled(s, this.policy());
  }

  protected selectable(s: SourceDto): boolean {
    const policy: CampaignPolicy = this.policy();
    return policy.crossEdition || isSourceEnabledByDefault(s, { ...policy, crossEdition: false });
  }

  protected toggle(s: SourceDto, on: boolean) {
    const byDefault = isSourceEnabledByDefault(s, this.policy());
    this.context.setSource(s.id, on === byDefault ? null : on);
  }

  protected reset() {
    this.context.overrides.set({});
  }
}
