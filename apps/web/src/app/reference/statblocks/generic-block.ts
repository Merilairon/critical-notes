import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { JsonObject } from '@cn/fivetools';
import type { EntityDto } from '@cn/shared';
import { Entries } from '../render/entries';
import { Entry } from '../render/entry';

/** Fallback renderer: name + entries (works for rules, conditions, tables, deities, …). */
@Component({
  selector: 'cn-generic-block',
  imports: [Entries, Entry],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cn-prose">
    @if (showName()) {
      <h2>{{ entity().name }}</h2>
    }
    @if (isTable()) {
      <cn-entry [entry]="asTable()" />
    }
    <cn-entries [entries]="list(d()['entries'] ?? d()['entry'])" [depth]="1" />
    @if (list(d()['tables']).length) {
      @for (t of list(d()['tables']); track $index) {
        <cn-entry [entry]="t" [depth]="1" />
      }
    }
  </div>`,
})
export class GenericBlock {
  readonly entity = input.required<EntityDto>();
  readonly showName = input(true);
  protected readonly d = computed(() => this.entity().data as JsonObject);
  protected readonly isTable = computed(() => Array.isArray(this.d()['rows']));
  protected readonly asTable = computed(() => ({ ...this.d(), type: 'table', name: undefined }));
  protected list(v: unknown): unknown[] {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
  }
}
