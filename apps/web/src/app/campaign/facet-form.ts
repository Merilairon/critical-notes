import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { ABILITY_KEYS, FACET_FIELDS, type FacetFieldDef, type FacetType, type PageType } from '@cn/shared';
import { PagePicker } from './page-picker';
import { RefPicker } from './ref-picker';

/** Typed page properties (facet) form, generated from the shared field descriptors. */
@Component({
  selector: 'cn-facet-form',
  imports: [PagePicker, RefPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="grid grid-cols-2 gap-x-3 gap-y-3 sm:gap-x-4 sm:gap-y-2">
    @for (field of fields(); track field.key) {
      @if (field.type === 'checkbox') {
        <label class="block text-sm touch:flex touch:min-h-[44px] touch:items-center touch:gap-3">
          <span class="mb-0.5 block text-xs font-semibold tracking-wide text-muted uppercase touch:mb-0">{{ field.label }}</span>
          <input type="checkbox" class="mt-1 touch:mt-0" [checked]="!!value()[field.key]" (change)="set(field.key, $any($event.target).checked)" />
        </label>
      } @else {
        <label class="block min-w-0 text-sm" [class]="span(field)">
          <span class="mb-0.5 block text-xs font-semibold tracking-wide text-muted uppercase">{{ field.label }}</span>
          @if (readOnly() && isEmpty(field)) {
            <span class="block py-1.5 text-muted">–</span>
          } @else {
            @switch (field.type) {
              @case ('select') {
                <select class="cn-input px-2" (change)="set(field.key, $any($event.target).value)">
                  @for (o of field.options ?? []; track o.value) {
                    <option [value]="o.value" [selected]="o.value === value()[field.key]">{{ o.label }}</option>
                  }
                </select>
              }
              @case ('number') {
                <input type="number" inputmode="numeric" class="cn-input px-2" [value]="value()[field.key] ?? ''" (change)="setNumber(field.key, $any($event.target).value)" />
              }
              @case ('date') {
                <input type="date" class="cn-input px-2" [value]="value()[field.key] ?? ''" (change)="set(field.key, $any($event.target).value || null)" />
              }
              @case ('longtext') {
                <textarea class="cn-input px-2" rows="3" [value]="value()[field.key] ?? ''" (change)="set(field.key, $any($event.target).value)"></textarea>
              }
              @case ('pageLink') {
                <cn-page-picker [pageType]="field.pageType" [value]="str(field)" [exclude]="pageId()" (selected)="set(field.key, $event)" />
              }
              @case ('refLink') {
                <cn-ref-picker [kind]="field.refKind ?? 'monster'" [value]="str(field)" (selected)="set(field.key, $event)" />
              }
              @default {
                <input type="text" class="cn-input px-2" [value]="value()[field.key] ?? ''" (change)="set(field.key, $any($event.target).value)" />
              }
            }
          }
        </label>
      }
    }
  </div>

  @if (facetType() === 'pc') {
    <div class="mt-3">
      <span class="mb-1 block text-xs font-semibold tracking-wide text-muted uppercase">Classes</span>
      @for (cls of classes(); track $index; let i = $index) {
        <div class="mb-2 grid grid-cols-[minmax(0,1fr)_minmax(56px,72px)_44px] items-center gap-2 sm:mb-1 sm:grid-cols-[1fr_1fr_4rem_auto]">
          <cn-ref-picker class="min-w-0" kind="class" [value]="cls.classUid" (selected)="setClass(i, { classUid: $event ?? '' })" placeholder="Class" />
          <cn-ref-picker class="order-last col-span-3 min-w-0 sm:order-none sm:col-span-1" kind="subclass" [value]="cls.subclassUid" (selected)="setClass(i, { subclassUid: $event })" placeholder="Subclass" />
          <input type="number" inputmode="numeric" min="1" max="20" class="cn-input px-2" [value]="cls.level" (change)="setClass(i, { level: +$any($event.target).value || 1 })" aria-label="Level" />
          <button type="button" class="cn-edit-only inline-flex items-center justify-center text-muted hover:text-accent touch:min-h-[44px] touch:min-w-[44px]" (click)="removeClass(i)" aria-label="Remove class">✕</button>
        </div>
      }
      <button type="button" class="cn-edit-only text-sm text-muted underline touch:min-h-[44px]" (click)="addClass()">+ add class</button>

      <span class="mt-3 mb-1 block text-xs font-semibold tracking-wide text-muted uppercase">Ability scores</span>
      <div class="grid grid-cols-3 gap-2 sm:grid-cols-6">
        @for (a of abilities; track a) {
          <label class="block min-w-0 text-center text-xs">
            <span class="block text-xs font-semibold uppercase">{{ a }}</span>
            <input type="number" inputmode="numeric" min="1" max="30" class="cn-input px-1 py-1 text-center" [attr.aria-label]="abilityNames[a] + ' score'" [value]="ability(a)" (change)="setAbility(a, $any($event.target).value)" />
          </label>
        }
      </div>
    </div>
  }`,
})
export class FacetForm {
  readonly facetType = input.required<FacetType>();
  readonly value = input.required<Record<string, unknown>>();
  readonly pageId = input<string | null>(null);
  /** The reader cannot edit: empty values show an en dash instead of an empty box. */
  readonly readOnly = input(false);
  readonly changed = output<Record<string, unknown>>();

  protected readonly abilities = ABILITY_KEYS;
  protected readonly abilityNames: Record<string, string> = {
    str: 'Strength',
    dex: 'Dexterity',
    con: 'Constitution',
    int: 'Intelligence',
    wis: 'Wisdom',
    cha: 'Charisma',
  };
  protected readonly fields = computed(() => FACET_FIELDS[this.facetType()].filter((f) => !(this.facetType() === 'npc' && f.key === 'statblockUid')));
  protected readonly classes = computed(() => (Array.isArray(this.value()['classes']) ? (this.value()['classes'] as { classUid: string; subclassUid: string | null; level: number }[]) : []));

  protected span(field: FacetFieldDef): string {
    if (field.type === 'longtext') return 'col-span-full';
    return field.type === 'number' || field.type === 'date' ? '' : 'col-span-2 sm:col-span-1';
  }

  protected isEmpty(field: FacetFieldDef): boolean {
    const v = this.value()[field.key];
    return v === null || v === undefined || v === '';
  }

  protected str(field: FacetFieldDef): string | null {
    const v = this.value()[field.key];
    return typeof v === 'string' ? v : null;
  }

  protected set(key: string, v: unknown) {
    this.changed.emit({ [key]: v });
  }

  protected setNumber(key: string, raw: string) {
    this.changed.emit({ [key]: raw === '' ? null : Number(raw) });
  }

  protected setClass(i: number, patch: Partial<{ classUid: string; subclassUid: string | null; level: number }>) {
    const next = this.classes().map((c, ix) => (ix === i ? { ...c, ...patch } : c));
    this.changed.emit({ classes: next });
  }
  protected addClass() {
    this.changed.emit({ classes: [...this.classes(), { classUid: '', subclassUid: null, level: 1 }] });
  }
  protected removeClass(i: number) {
    this.changed.emit({ classes: this.classes().filter((_, ix) => ix !== i) });
  }

  protected ability(a: string): number | string {
    const abilities = this.value()['abilities'] as Record<string, number> | null;
    return abilities?.[a] ?? '';
  }
  protected setAbility(a: string, raw: string) {
    const current = { ...((this.value()['abilities'] as Record<string, number> | null) ?? {}) };
    if (raw === '') delete current[a];
    else current[a] = Math.max(1, Math.min(30, Number(raw)));
    this.changed.emit({ abilities: Object.keys(current).length ? current : null });
  }

  static pageTypeFacet(type: PageType): FacetType | null {
    return (['npc', 'location', 'session', 'quest', 'faction', 'pc', 'item'] as string[]).includes(type) ? (type as FacetType) : null;
  }
}
