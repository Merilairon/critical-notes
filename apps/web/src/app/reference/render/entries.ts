import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Entry } from './entry';

/** Renders a 5etools `entries` array. */
@Component({
  selector: 'cn-entries',
  imports: [Entry],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `@for (e of entries() ?? []; track $index) {
    <cn-entry [entry]="e" [depth]="depth()" />
  }`,
})
export class Entries {
  readonly entries = input<unknown[] | null | undefined>([]);
  readonly depth = input(0);
}
