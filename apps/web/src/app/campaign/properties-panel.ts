import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { KINDS } from '@cn/fivetools';
import { PROPERTY_TYPES, type PageType, type PropertyDefDto, type PropertyType } from '@cn/shared';
import { ContextService } from '../core/context.service';
import { errorMessage } from '../core/http.interceptor';
import { kindLabel } from '../reference/kind-labels';
import { CampaignStore } from './campaign.store';
import { PagePicker } from './page-picker';
import { RefPicker } from './ref-picker';

const TYPE_LABELS: Record<PropertyType, string> = {
  text: 'Text',
  number: 'Number',
  select: 'Select',
  multiselect: 'Multi-select',
  date: 'Date',
  checkbox: 'Checkbox',
  pageLink: 'Page link',
  refLink: 'Reference',
  url: 'URL',
};

/** Custom campaign-defined properties for one page: value editors plus adding/removing definitions. */
@Component({
  selector: 'cn-properties-panel',
  imports: [PagePicker, RefPicker, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="grid gap-x-3 gap-y-1 sm:grid-cols-[10rem_1fr] sm:items-center sm:gap-y-2">
      @for (def of defs(); track def.id) {
        <div class="mt-2 flex items-center gap-1 text-sm text-muted sm:mt-0">
          <span class="min-w-0 [overflow-wrap:anywhere]">{{ def.label }}</span>
          @if (def.dmOnly) {<span title="DM only" aria-label="DM only">🔒</span>}
          @if (manage()) {
            <button type="button" class="cn-edit-only ml-auto inline-flex items-center justify-center text-xs opacity-40 hover:text-accent hover:opacity-100 focus:opacity-100 touch:min-h-[44px] touch:min-w-[44px] touch:opacity-100" (click)="removeDef(def)" [attr.aria-label]="'Delete property ' + def.label">✕</button>
          }
        </div>
        <div class="min-w-0">
          @if (readOnly() && isEmpty(def)) {
            <span class="block py-1 text-muted">–</span>
          } @else {
          @switch (def.type) {
            @case ('number') {
              <input type="number" inputmode="numeric" class="cn-prop-input w-32" [value]="value(def) ?? ''" (change)="set(def, $any($event.target).value === '' ? null : +$any($event.target).value)" [attr.aria-label]="def.label" />
            }
            @case ('date') {
              <input type="date" class="cn-prop-input" [value]="value(def) ?? ''" (change)="set(def, $any($event.target).value || null)" [attr.aria-label]="def.label" />
            }
            @case ('checkbox') {
              <label class="flex items-center touch:min-h-[44px]"><input type="checkbox" [checked]="!!value(def)" (change)="set(def, $any($event.target).checked)" [attr.aria-label]="def.label" /></label>
            }
            @case ('select') {
              <select class="cn-prop-input" (change)="set(def, $any($event.target).value || null)" [attr.aria-label]="def.label">
                <option value="" [selected]="!value(def)">—</option>
                @for (o of def.options ?? []; track o) {<option [value]="o" [selected]="o === value(def)">{{ o }}</option>}
              </select>
            }
            @case ('multiselect') {
              <div class="flex flex-wrap gap-1" role="group" [attr.aria-label]="def.label">
                @for (o of def.options ?? []; track o) {
                  <button type="button" class="rounded-full border px-2 py-0.5 text-xs touch:min-h-[44px] touch:px-3 touch:py-1 touch:text-sm" [class.border-accent]="has(def, o)" [class.text-accent]="has(def, o)" [class.border-line]="!has(def, o)" [attr.aria-pressed]="has(def, o)" (click)="toggle(def, o)">{{ o }}</button>
                }
              </div>
            }
            @case ('pageLink') {
              <div class="flex items-center gap-2">
                <div class="flex-1"><cn-page-picker [value]="$any(value(def))" [exclude]="pageId()" (selected)="set(def, $event)" /></div>
                @if (value(def)) {<a class="inline-flex items-center text-xs text-accent touch:min-h-[44px] touch:text-sm" [routerLink]="['/c', store.id(), 'p', value(def)]">open</a>}
              </div>
            }
            @case ('refLink') {
              <cn-ref-picker [kind]="def.refKind ?? 'monster'" [value]="$any(value(def))" (selected)="set(def, $event)" />
            }
            @case ('url') {
              <div class="flex items-center gap-2">
                <input type="url" class="cn-prop-input flex-1" [value]="value(def) ?? ''" placeholder="https://…" (change)="set(def, $any($event.target).value || null)" [attr.aria-label]="def.label" />
                @if (safeUrl(def); as u) {<a class="inline-flex items-center text-xs text-accent touch:min-h-[44px] touch:text-sm" [href]="u" target="_blank" rel="noopener noreferrer nofollow">open ↗</a>}
              </div>
            }
            @default {
              <input class="cn-prop-input w-full" [value]="value(def) ?? ''" (change)="set(def, $any($event.target).value || null)" [attr.aria-label]="def.label" />
            }
          }
          }
        </div>
      }
    </div>

    @if (adding()) {
      <form class="mt-3 grid gap-2 rounded-lg border border-line p-3 text-sm sm:grid-cols-2" (submit)="$event.preventDefault(); create(label.value, type.value, options.value, refKind.value, dmOnly.checked, onlyType.checked)">
        <label class="flex flex-col gap-1"><span class="text-xs text-muted">Name</span><input #label class="cn-prop-input" required maxlength="60" /></label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted">Type</span>
          <select #type class="cn-prop-input" (change)="newType.set($any($event.target).value)">
            @for (t of types; track t) {<option [value]="t">{{ typeLabels[t] }}</option>}
          </select>
        </label>
        <label class="flex flex-col gap-1 sm:col-span-2" [hidden]="newType() !== 'select' && newType() !== 'multiselect'">
          <span class="text-xs text-muted">Options (comma separated)</span><input #options class="cn-prop-input" />
        </label>
        <label class="flex flex-col gap-1" [hidden]="newType() !== 'refLink'">
          <span class="text-xs text-muted">Reference kind</span>
          <select #refKind class="cn-prop-input">
            @for (k of refKinds(); track k.kind) {<option [value]="k.kind">{{ k.label }}</option>}
          </select>
        </label>
        <div class="flex flex-wrap items-center gap-3 sm:col-span-2">
          <label class="flex items-center gap-1 touch:min-h-[44px] touch:gap-3"><input #dmOnly type="checkbox" /> DM only</label>
          <label class="flex items-center gap-1 touch:min-h-[44px] touch:gap-3"><input #onlyType type="checkbox" checked /> Only for {{ pageType() }} pages</label>
          <span class="ml-auto flex gap-2">
            <button type="button" class="cn-btn text-muted" (click)="adding.set(false)">Cancel</button>
            <button type="submit" class="cn-btn-primary">Add</button>
          </span>
        </div>
        @if (error()) {<p class="text-accent sm:col-span-2" role="alert">{{ error() }}</p>}
      </form>
    } @else if (manage()) {
      <button type="button" class="cn-edit-only cn-btn mt-2 w-full text-muted hover:text-accent sm:w-auto" (click)="adding.set(true)">+ Add property</button>
    }`,
})
export class PropertiesPanel {
  readonly pageId = input.required<string>();
  readonly pageType = input.required<PageType>();
  readonly values = input<Record<string, unknown>>({});
  /** Adding and deleting definitions (game masters). */
  readonly manage = input(true);
  /** The reader cannot edit: empty values show an en dash. */
  readonly readOnly = input(false);
  readonly changed = output<Record<string, unknown>>();
  protected readonly store = inject(CampaignStore);
  private readonly context = inject(ContextService);

  protected readonly types = PROPERTY_TYPES;
  protected readonly typeLabels = TYPE_LABELS;
  protected readonly adding = signal(false);
  protected readonly newType = signal<PropertyType>('text');
  protected readonly error = signal('');

  protected readonly defs = computed(() => this.store.propertyDefs().filter((d) => !d.appliesTo || d.appliesTo.includes(this.pageType())));
  protected readonly refKinds = computed(() =>
    Object.values(KINDS)
      .filter((k) => k.browsable)
      .map((k) => ({ kind: k.kind, label: kindLabel(k.kind, this.context.ruleset()) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  );

  protected value(def: PropertyDefDto): string | number | boolean | null {
    return (this.values()[def.key] as string | number | boolean | undefined) ?? null;
  }
  protected isEmpty(def: PropertyDefDto): boolean {
    const v = this.values()[def.key];
    if (def.type === 'checkbox') return false;
    return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
  }
  protected has(def: PropertyDefDto, option: string) {
    const v = this.values()[def.key];
    return Array.isArray(v) && v.includes(option);
  }
  protected safeUrl(def: PropertyDefDto) {
    const v = this.value(def);
    return typeof v === 'string' && /^(https?:|mailto:)/i.test(v) ? v : null;
  }

  protected set(def: PropertyDefDto, value: unknown) {
    this.changed.emit({ [def.key]: value });
  }
  protected toggle(def: PropertyDefDto, option: string) {
    const current = (this.values()[def.key] as string[] | undefined) ?? [];
    const next = current.includes(option) ? current.filter((o) => o !== option) : [...current, option];
    this.set(def, next.length ? next : null);
  }

  protected async create(label: string, type: string, options: string, refKind: string, dmOnly: boolean, onlyType: boolean) {
    this.error.set('');
    const t = type as PropertyType;
    try {
      await this.store.createProperty({
        label,
        type: t,
        options: t === 'select' || t === 'multiselect' ? options.split(',').map((o) => o.trim()).filter(Boolean) : null,
        refKind: t === 'refLink' ? refKind : null,
        dmOnly,
        appliesTo: onlyType ? [this.pageType()] : null,
      });
      this.adding.set(false);
      this.newType.set('text');
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  protected async removeDef(def: PropertyDefDto) {
    if (!confirm(`Delete the property "${def.label}" from every page in this campaign?`)) return;
    await this.store.deleteProperty(def.id);
  }
}
