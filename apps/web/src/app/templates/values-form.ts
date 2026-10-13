import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { TemplateVariableDto } from '@cn/shared';
import { parseType, type VariableType } from '@cn/templates';
import { PagePicker } from '../campaign/page-picker';
import { RefPicker } from '../campaign/ref-picker';

/** Typed inputs for a template's variables (used when inserting or creating from a template). */
@Component({
  selector: 'cn-template-values',
  imports: [PagePicker, RefPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="grid gap-3 sm:grid-cols-2">
    @for (v of variables(); track v.name) {
      @let type = typeOf(v);
      <label class="flex flex-col gap-1 text-sm" [class.sm:col-span-2]="type.kind === 'reference'">
        <span class="text-xs text-muted">{{ v.label || v.name }}@if (v.required) {<span class="text-accent"> *</span>}</span>
        @switch (type.kind) {
          @case ('number') {
            <input type="number" class="cn-prop-input" [value]="value(v) ?? ''" [placeholder]="placeholder(v)" (input)="set(v, $any($event.target).value)" [attr.aria-label]="v.label || v.name" />
          }
          @case ('boolean') {
            <input type="checkbox" [checked]="!!(value(v) ?? v.default)" (change)="set(v, $any($event.target).checked)" [attr.aria-label]="v.label || v.name" />
          }
          @case ('date') {
            <input type="date" class="cn-prop-input" [value]="value(v) ?? v.default ?? ''" (input)="set(v, $any($event.target).value)" [attr.aria-label]="v.label || v.name" />
          }
          @case ('select') {
            <select class="cn-prop-input" (change)="set(v, $any($event.target).value)" [attr.aria-label]="v.label || v.name">
              <option value="">—</option>
              @for (o of $any(type).options; track o) {<option [value]="o" [selected]="o === (value(v) ?? v.default)">{{ o }}</option>}
            </select>
          }
          @case ('pageLink') {
            <cn-page-picker [pageType]="$any(type).pageType" [value]="$any(value(v)) ?? null" (selected)="set(v, $event)" />
          }
          @case ('reference') {
            <cn-ref-picker [kind]="$any(type).refKind" [value]="$any(value(v)) ?? null" [placeholder]="'Search ' + $any(type).refKind + '…'" (selected)="set(v, $event)" />
          }
          @default {
            <input class="cn-prop-input" [value]="value(v) ?? ''" [placeholder]="placeholder(v)" (input)="set(v, $any($event.target).value)" [attr.aria-label]="v.label || v.name" />
          }
        }
      </label>
    } @empty {
      <p class="text-sm text-muted sm:col-span-2">This template has no fields to fill in.</p>
    }
  </div>`,
})
export class TemplateValuesForm {
  readonly variables = input<TemplateVariableDto[]>([]);
  readonly values = input<Record<string, unknown>>({});
  readonly changed = output<Record<string, unknown>>();

  protected typeOf(v: TemplateVariableDto): VariableType {
    return parseType(v.type) ?? { kind: 'text' };
  }
  protected value(v: TemplateVariableDto): string | number | boolean | undefined {
    return this.values()[v.name] as string | number | boolean | undefined;
  }
  protected placeholder(v: TemplateVariableDto) {
    return v.default !== undefined ? `Default: ${String(v.default)}` : this.typeOf(v).kind === 'dice' ? 'e.g. 2d6' : '';
  }
  protected set(v: TemplateVariableDto, raw: unknown) {
    const next = { ...this.values() };
    if (raw === '' || raw === null || raw === undefined) delete next[v.name];
    else next[v.name] = raw;
    this.changed.emit(next);
  }
}
