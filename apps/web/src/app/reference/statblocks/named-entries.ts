import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { isObject } from '@cn/fivetools';
import { Entry } from '../render/entry';

/** Statblock-style list of `{name, entries}` (traits, actions, …): bold-italic name, then text. */
@Component({
  selector: 'cn-named-entries',
  imports: [Entry],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `@for (item of list(); track $index) {
    @if (isNamed(item)) {
      <p>
        <span class="cn-inline-head">{{ $any(item).name }}.</span>&ngsp;
        @if (first(item); as f) {<cn-entry [entry]="f" [inlineMode]="true" />}
      </p>
      @for (rest of restOf(item); track $index) {
        <cn-entry [entry]="rest" [depth]="2" />
      }
    } @else {
      <cn-entry [entry]="item" [depth]="2" />
    }
  }`,
})
export class NamedEntries {
  readonly items = input<unknown>([]);

  protected list(): unknown[] {
    const v = this.items();
    return Array.isArray(v) ? v : [];
  }
  protected isNamed(item: unknown): boolean {
    return isObject(item) && typeof item['name'] === 'string' && Array.isArray(item['entries']) && (item['type'] == null || item['type'] === 'entries' || item['type'] === 'item');
  }
  protected first(item: unknown): unknown {
    const entries = (item as { entries: unknown[] }).entries;
    return typeof entries[0] === 'string' ? entries[0] : null;
  }
  protected restOf(item: unknown): unknown[] {
    const entries = (item as { entries: unknown[] }).entries;
    return typeof entries[0] === 'string' ? entries.slice(1) : entries;
  }
}
