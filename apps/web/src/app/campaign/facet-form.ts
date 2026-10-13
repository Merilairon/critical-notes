import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { ABILITY_KEYS, FACET_FIELDS, type FacetFieldDef, type FacetType, type PageType } from '@cn/shared';
import { PagePicker } from './page-picker';
import { RefPicker } from './ref-picker';

/** Typed page properties (facet) form, generated from the shared field descriptors. */
@Component({
  selector: 'cn-facet-form',
  imports: [PagePicker, RefPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="grid gap-x-4 gap-y-2 sm:grid-cols-2">
    @for (field of fields(); track field.key) {
      <label class="block text-sm" [class.sm:col-span-2]="field.type === 'longtext'">
        <span class="mb-0.5 block text-xs font-semibold tracking-wide text-muted uppercase">{{ field.label }}</span>
        @switch (field.type) {
          @case ('select') {
            <select class="w-full rounded-md border border-line bg-bg px-2 py-1.5 text-sm" (change)="set(field.key, $any($event.target).value)">
              @for (o of field.options ?? []; track o.value) {
                <option [value]="o.value" [selected]="o.value === value()[field.key]">{{ o.label }}</option>
              }
            </select>
          }
          @case ('number') {
            <input
              type="number"
              class="w-full rounded-md border border-line bg-bg px-2 py-1.5 text-sm"
              [value]="value()[field.key] ?? ''"
              (change)="setNumber(field.key, $any($event.target).value)"
            />
          }
          @case ('date') {
            <input type="date" class="w-full rounded-md border border-line bg-bg px-2 py-1.5 text-sm" [value]="value()[field.key] ?? ''" (change)="set(field.key, $any($event.target).value || null)" />
          }
          @case ('checkbox') {
            <input type="checkbox" class="mt-1" [checked]="!!value()[field.key]" (change)="set(field.key, $any($event.target).checked)" />
          }
          @case ('longtext') {
            <textarea class="w-full rounded-md border border-line bg-bg px-2 py-1.5 text-sm" rows="3" [value]="value()[field.key] ?? ''" (change)="set(field.key, $any($event.target).value)"></textarea>
          }
          @case ('pageLink') {
            <cn-page-picker [pageType]="field.pageType" [value]="str(field)" [exclude]="pageId()" (selected)="set(field.key, $event)" />
          }
          @case ('refLink') {
            <cn-ref-picker [kind]="field.refKind ?? 'monster'" [value]="str(field)" (selected)="set(field.key, $event)" />
          }
          @default {
            <input type="text" class="w-full rounded-md border border-line bg-bg px-2 py-1.5 text-sm" [value]="value()[field.key] ?? ''" (change)="set(field.key, $any($event.target).value)" />
          }
        }
      </label>
    }
  </div>

  @if (facetType() === 'pc') {
    <div class="mt-3">
      <span class="mb-1 block text-xs font-semibold tracking-wide text-muted uppercase">Classes</span>
      @for (cls of classes(); track $index; let i = $index) {
        <div class="mb-1 grid grid-cols-[1fr_1fr_4rem_auto] items-center gap-2">
          <cn-ref-picker kind="class" [value]="cls.classUid" (selected)="setClass(i, { classUid: $event ?? '' })" placeholder="Class" />
          <cn-ref-picker kind="subclass" [value]="cls.subclassUid" (selected)="setClass(i, { subclassUid: $event })" placeholder="Subclass" />
          <input type="number" min="1" max="20" class="rounded-md border border-line bg-bg px-2 py-1.5 text-sm" [value]="cls.level" (change)="setClass(i, { level: +$any($event.target).value || 1 })" aria-label="Level" />
          <button type="button" class="text-muted hover:text-accent" (click)="removeClass(i)" aria-label="Remove class">✕</button>
        </div>
      }
      <button type="button" class="text-sm text-muted underline" (click)="addClass()">+ add class</button>

      <span class="mt-3 mb-1 block text-xs font-semibold tracking-wide text-muted uppercase">Ability scores</span>
      <div class="grid grid-cols-3 gap-2 sm:grid-cols-6">
        @for (a of abilities; track a) {
          <label class="text-center text-xs">
            <span class="block font-semibold uppercase">{{ a }}</span>
            <input type="number" min="1" max="30" class="w-full rounded-md border border-line bg-bg px-1 py-1 text-center text-sm" [value]="ability(a)" (change)="setAbility(a, $any($event.target).value)" />
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
  readonly changed = output<Record<string, unknown>>();

  protected readonly abilities = ABILITY_KEYS;
  protected readonly fields = computed(() => FACET_FIELDS[this.facetType()].filter((f) => !(this.facetType() === 'npc' && f.key === 'statblockUid')));
  protected readonly classes = computed(() => (Array.isArray(this.value()['classes']) ? (this.value()['classes'] as { classUid: string; subclassUid: string | null; level: number }[]) : []));

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
