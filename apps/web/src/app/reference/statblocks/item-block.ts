import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { itemPropertiesLine, itemTypeLine, itemValueWeight, styleForEdition, type JsonObject } from '@cn/fivetools';
import type { EntityDto } from '@cn/shared';
import { Entries } from '../render/entries';
import { Inline } from '../render/inline';

@Component({
  selector: 'cn-item-block',
  imports: [Inline, Entries],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cn-statblock">
    @if (showName()) {
      <h2 class="cn-sb-name">{{ entity().name }}</h2>
    }
    @if (typeLine()) {
      <div class="cn-sb-sub"><cn-inline [text]="typeLine()" /></div>
    }
    @if (props() || valueWeight()) {
      <div class="cn-sb-rule"></div>
      @if (props()) {
        <div><cn-inline [text]="props()" /></div>
      }
      @if (valueWeight()) {
        <div class="text-muted">{{ valueWeight() }}</div>
      }
    }
    <div class="cn-sb-rule"></div>
    <div class="cn-prose">
      <cn-entries [entries]="list(i()['entries'])" [depth]="1" />
      @if (list(i()['additionalEntries']).length) {
        <cn-entries [entries]="list(i()['additionalEntries'])" [depth]="1" />
      }
      @if (list(i()['items']).length) {
        <p class="cn-inline-head">Items in this group</p>
        <ul class="cn-list-plain">
          @for (it of list(i()['items']); track $index) {
            <li><cn-inline [text]="'{@item ' + it + '}'" /></li>
          }
        </ul>
      }
    </div>
  </div>`,
})
export class ItemBlock {
  readonly entity = input.required<EntityDto>();
  readonly showName = input(true);
  protected readonly i = computed(() => this.entity().data as JsonObject);
  protected readonly typeLine = computed(() => itemTypeLine(this.i(), styleForEdition(this.entity().edition)));
  protected readonly props = computed(() => itemPropertiesLine(this.i()));
  protected readonly valueWeight = computed(() => itemValueWeight(this.i()));
  protected list(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
  }
}
