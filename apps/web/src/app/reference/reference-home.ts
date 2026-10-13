import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { KindCountDto } from '@cn/shared';
import { api } from '../core/api';
import { ContextService } from '../core/context.service';
import { kindLabel } from './kind-labels';

@Component({
  selector: 'cn-reference-home',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="mx-auto max-w-5xl p-4 sm:p-6">
    <h1 class="font-display text-3xl font-bold">Reference</h1>
    <p class="mt-1 text-muted">
      Rules content for <strong class="text-ink">{{ context.ruleset().label }}</strong>
      {{ context.crossEdition() ? '(including other-edition content)' : '' }}. Press
      <kbd class="rounded border border-line bg-panel px-1 text-xs">Ctrl K</kbd> to search everything.
    </p>
    @if (kinds.hasValue()) {
      <div class="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        @for (k of visibleKinds(); track k.kind) {
          <a
            [routerLink]="[...context.referenceBase(), k.kind]"
            class="flex items-baseline justify-between rounded-lg border border-line bg-panel px-3 py-3 transition hover:border-accent hover:shadow-sm"
          >
            <span class="font-medium">{{ label(k.kind) }}</span>
            <span class="text-sm text-muted">{{ k.count.toLocaleString() }}</span>
          </a>
        }
      </div>
      @if (!visibleKinds().length) {
        <p class="mt-6 rounded-lg border border-dashed border-line p-4 text-muted">
          No reference data is available. Make sure the 5etools data is cloned (<code>pnpm data:clone</code>) and indexed (<code>pnpm index</code>).
        </p>
      }
    } @else if (kinds.error()) {
      <p class="mt-6 text-accent">Could not reach the server.</p>
    }
  </div>`,
})
export class ReferenceHome {
  protected readonly context = inject(ContextService);
  protected readonly kinds = httpResource<{ kinds: KindCountDto[] }>(() => ({ url: api.kinds, params: this.context.params() }));
  protected readonly visibleKinds = computed(() => (this.kinds.hasValue() ? this.kinds.value().kinds.filter((k) => k.count > 0) : []));
  protected label(kind: string) {
    return kindLabel(kind, this.context.ruleset(), true);
  }
}
