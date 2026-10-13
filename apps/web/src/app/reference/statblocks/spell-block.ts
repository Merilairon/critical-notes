import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import {
  isModern,
  spellClassesText,
  spellComponentsText,
  spellDurationText,
  spellLevelSchool,
  spellRangeText,
  spellTimeText,
  styleForEdition,
  type JsonObject,
} from '@cn/fivetools';
import type { EntityDto } from '@cn/shared';
import { ContextService } from '../../core/context.service';
import { Entries } from '../render/entries';
import { Inline } from '../render/inline';

@Component({
  selector: 'cn-spell-block',
  imports: [Inline, Entries],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cn-statblock">
    @if (showName()) {
      <h2 class="cn-sb-name">{{ entity().name }}</h2>
    }
    <div class="cn-sb-sub">{{ levelSchool() }}</div>
    <div class="cn-sb-rule"></div>
    <div><span class="cn-sb-label">Casting Time:</span>&ngsp;<cn-inline [text]="time()" /></div>
    <div><span class="cn-sb-label">Range:</span>&ngsp;{{ range() }}</div>
    <div><span class="cn-sb-label">Components:</span>&ngsp;<cn-inline [text]="components()" /></div>
    <div><span class="cn-sb-label">Duration:</span>&ngsp;{{ duration() }}</div>
    <div class="cn-sb-rule"></div>
    <div class="cn-prose">
      <cn-entries [entries]="list(s()['entries'])" [depth]="1" />
      @if (list(s()['entriesHigherLevel']).length) {
        <cn-entries [entries]="list(s()['entriesHigherLevel'])" [depth]="2" />
      }
    </div>
    @if (classes()) {
      <div class="cn-sb-rule"></div>
      <div class="text-sm"><span class="cn-sb-label">{{ classesLabel() }}:</span>&ngsp;<cn-inline [text]="classes()" /></div>
    }
  </div>`,
})
export class SpellBlock {
  readonly entity = input.required<EntityDto>();
  readonly showName = input(true);
  private readonly context = inject(ContextService);
  protected readonly s = computed(() => this.entity().data as JsonObject);
  protected readonly style = computed(() => styleForEdition(this.entity().edition));
  protected readonly levelSchool = computed(() => spellLevelSchool(this.s(), this.style()));
  protected readonly time = computed(() => spellTimeText(this.s(), this.style()));
  protected readonly range = computed(() => spellRangeText(this.s()));
  protected readonly components = computed(() => spellComponentsText(this.s()));
  protected readonly duration = computed(() => spellDurationText(this.s()));
  protected readonly classes = computed(() => spellClassesText(this.s()));
  protected readonly classesLabel = computed(() => (isModern(this.style()) ? 'Spell Lists' : 'Classes'));
  protected readonly ruleset = this.context.ruleset;
  protected list(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
  }
}
