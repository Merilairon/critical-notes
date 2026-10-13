import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { TemplateSummaryDto } from '@cn/shared';

const SCOPE_LABELS = { campaign: 'This campaign', user: 'Mine', global: 'Built-in' } as const;

/** A filterable list of templates, grouped by scope. */
@Component({
  selector: 'cn-template-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<input type="search" class="cn-prop-input mb-2 w-full" placeholder="Filter templates…" aria-label="Filter templates" [value]="filter()" (input)="filter.set($any($event.target).value)" />
    <div class="max-h-[50vh] overflow-y-auto">
      @for (g of groups(); track g.scope) {
        <h3 class="mt-2 mb-1 text-xs font-semibold tracking-wide text-muted uppercase">{{ g.label }}</h3>
        <ul class="grid gap-1 sm:grid-cols-2">
          @for (t of g.items; track t.id) {
            <li>
              <button type="button" class="flex w-full items-start gap-2 rounded-lg border border-line p-2 text-left hover:border-accent" (click)="picked.emit(t)">
                <span class="text-xl">{{ t.icon || (t.kind === 'page' ? '📄' : '🧩') }}</span>
                <span class="min-w-0">
                  <span class="block truncate font-semibold">{{ t.name }}</span>
                  <span class="line-clamp-2 block text-xs text-muted">{{ t.description }}</span>
                </span>
              </button>
            </li>
          }
        </ul>
      } @empty {
        <p class="text-sm text-muted">{{ templates().length ? 'Nothing matches.' : 'No templates yet.' }}</p>
      }
    </div>`,
})
export class TemplatePicker {
  readonly templates = input<TemplateSummaryDto[]>([]);
  readonly picked = output<TemplateSummaryDto>();
  protected readonly filter = signal('');
  protected readonly groups = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const items = this.templates().filter((t) => !q || t.name.toLowerCase().includes(q) || t.tags.some((g) => g.includes(q)) || t.description.toLowerCase().includes(q));
    return (['campaign', 'user', 'global'] as const)
      .map((scope) => ({ scope, label: SCOPE_LABELS[scope], items: items.filter((t) => t.scope === scope) }))
      .filter((g) => g.items.length);
  });
}
