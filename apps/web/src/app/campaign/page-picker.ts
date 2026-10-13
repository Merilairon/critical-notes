import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import type { PageType } from '@cn/shared';
import { CampaignStore } from './campaign.store';

/** Select a page of a given type in this campaign. */
@Component({
  selector: 'cn-page-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<select class="w-full rounded-md border border-line bg-bg px-2 py-1.5 text-sm" (change)="selected.emit($any($event.target).value || null)">
    <option value="" [selected]="!value()">— none —</option>
    @for (p of options(); track p.id) {
      <option [value]="p.id" [selected]="p.id === value()">{{ p.title }}</option>
    }
  </select>`,
})
export class PagePicker {
  readonly pageType = input<PageType | undefined>(undefined);
  readonly value = input<string | null>(null);
  readonly exclude = input<string | null>(null);
  readonly selected = output<string | null>();
  private readonly store = inject(CampaignStore);
  protected readonly options = computed(() => {
    const type = this.pageType();
    return (type ? this.store.pagesOfType(type) : this.store.pages()).filter((p) => p.id !== this.exclude());
  });
}
