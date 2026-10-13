import { ChangeDetectionStrategy, Component, computed, forwardRef, input, output } from '@angular/core';
import { ABILITY_KEYS } from '@cn/shared';
import { EntriesEditor, type EntriesPatch } from '../entries-editor';
import { JsonField } from './json-field';
import { getAt, normalizeValue, type JsonPath } from './path';
import { FORM_SPECS, unlistedFields, type FieldSpec } from './specs';
import { TableRows } from './table-rows';

type Data = Record<string, unknown>;

/** A change at one path. Applied by the editor to its current value, so quick successive edits never overwrite each other. */
export interface FieldPatch {
  path: JsonPath;
  value: unknown;
}

/** One field of a form spec, bound to a path in the entity. */
@Component({
  selector: 'cn-form-field',
  imports: [JsonField, TableRows, forwardRef(() => EntriesEditor), forwardRef(() => NamedEntries)],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.sm:col-span-2]': 'spec().span === 2' },
  template: `@let f = spec();
    @let v = value();
    @if (f.kind === 'checkbox') {
      <label class="flex items-center gap-2 text-sm">
        <input type="checkbox" [checked]="!!v" (change)="set($any($event.target).checked || undefined)" />
        {{ f.label }}
      </label>
    } @else {
      <label class="mb-0.5 block text-xs font-semibold tracking-wide text-muted uppercase" [attr.for]="id()">{{ f.label }}</label>
      @if (fallbackToJson()) {
        <cn-json-field [value]="v" [label]="f.label" (changed)="set($event)" />
        <p class="mt-0.5 text-xs text-muted">This value uses a format the form does not cover; edit it as JSON.</p>
      } @else {
        @switch (f.kind) {
          @case ('text') {
            <input [id]="id()" class="cn-prop-input w-full" [value]="v ?? ''" [placeholder]="f.placeholder ?? ''" [attr.list]="f.suggestions ? id() + '-list' : null" (change)="set($any($event.target).value.trim())" />
            @if (f.suggestions) {
              <datalist [id]="id() + '-list'">
                @for (s of f.suggestions; track s) {<option [value]="s"></option>}
              </datalist>
            }
          }
          @case ('textarea') {
            <textarea [id]="id()" class="cn-prop-input w-full" rows="3" [value]="v ?? ''" (change)="set($any($event.target).value)"></textarea>
          }
          @case ('number') {
            <input [id]="id()" type="number" class="cn-prop-input w-full" [value]="v ?? ''" [placeholder]="f.placeholder ?? ''" (change)="set($any($event.target).value === '' ? undefined : +$any($event.target).value)" />
          }
          @case ('select') {
            <select [id]="id()" class="cn-prop-input w-full" (change)="setOption($any($event.target).value)">
              <option value="" [selected]="v === undefined">—</option>
              @for (o of f.options ?? []; track o.value) {<option [value]="o.value" [selected]="o.value === v">{{ o.label }}</option>}
            </select>
          }
          @case ('multiselect') {
            <div class="flex flex-wrap gap-1" role="group" [attr.aria-label]="f.label">
              @for (o of f.options ?? []; track o.value) {
                <button type="button" class="rounded-full border px-2 py-0.5 text-xs" [class.border-accent]="has(o.value)" [class.text-accent]="has(o.value)" [class.border-line]="!has(o.value)" [attr.aria-pressed]="has(o.value)" (click)="toggle(o.value)">
                  {{ o.label }}
                </button>
              }
            </div>
          }
          @case ('stringList') {
            <input [id]="id()" class="cn-prop-input w-full" [value]="$any(v ?? []).join(', ')" [placeholder]="f.placeholder ?? ''" (change)="setList($any($event.target).value)" />
            <p class="mt-0.5 text-xs text-muted">Separate with commas.</p>
          }
          @case ('attune') {
            <div class="flex items-center gap-2">
              <input type="checkbox" [checked]="!!v" aria-label="Requires attunement" (change)="set($any($event.target).checked ? true : undefined)" />
              <input class="cn-prop-input flex-1" [value]="typeof v === 'string' ? v : ''" placeholder="by a spellcaster (optional)" [disabled]="!v" aria-label="Attunement condition" (change)="set($any($event.target).value.trim() || true)" />
            </div>
          }
          @case ('abilities') {
            <div class="grid grid-cols-3 gap-2 sm:grid-cols-6">
              @for (a of abilities; track a) {
                <label class="text-center text-xs uppercase">
                  {{ a }}
                  <input type="number" class="cn-prop-input w-full text-center" [value]="ability(a)" (change)="setAbility(a, $any($event.target).value)" />
                </label>
              }
            </div>
          }
          @case ('entries') {
            <cn-entries-editor [entries]="$any(v ?? [])" [searchParams]="searchParams()" (changed)="relay($event)" />
          }
          @case ('namedEntries') {
            <cn-named-entries [items]="$any(v ?? [])" [label]="f.label" [searchParams]="searchParams()" (changed)="relay($event)" />
          }
          @case ('tableRows') {
            <cn-table-rows [rows]="$any(v ?? [])" [labels]="$any(data()['colLabels'] ?? [])" (changed)="set($event)" />
          }
          @default {
            <cn-json-field [value]="v" [label]="f.label" [placeholder]="f.placeholder ?? ''" (changed)="set($event)" />
          }
        }
      }
      @if (f.hint) {<p class="mt-0.5 text-xs text-muted">{{ f.hint }}</p>}
    }`,
})
export class FormField {
  readonly spec = input.required<FieldSpec>();
  readonly data = input.required<Data>();
  readonly searchParams = input<Record<string, string>>({});
  readonly changed = output<FieldPatch>();
  protected readonly abilities = ABILITY_KEYS;
  protected readonly id = computed(() => `hb-${this.spec().path.join('-') || this.spec().kind}`);
  protected readonly value = computed(() => getAt(this.data(), this.spec().path));

  /** Values the form widget cannot represent (objects where it expects text, …) are edited as JSON. */
  protected readonly fallbackToJson = computed(() => {
    const v = this.value();
    if (v === undefined) return false;
    switch (this.spec().kind) {
      case 'text':
      case 'textarea':
        return typeof v !== 'string';
      case 'number':
        return typeof v !== 'number';
      case 'select':
        return typeof v === 'object';
      case 'multiselect':
      case 'stringList':
        return !Array.isArray(v) || v.some((x) => typeof x !== 'string');
      case 'attune':
        return typeof v !== 'string' && typeof v !== 'boolean';
      default:
        return false;
    }
  });

  protected set(value: unknown) {
    this.changed.emit({ path: this.spec().path, value: normalizeValue(value) });
  }
  /** A nested editor's change, relative to this field's value. */
  protected relay(p: EntriesPatch) {
    const value = p.path.length ? p.value : normalizeValue(p.value);
    this.changed.emit({ path: [...this.spec().path, ...p.path], value });
  }
  protected setOption(raw: string) {
    const opt = this.spec().options?.find((o) => String(o.value) === raw);
    this.set(opt ? opt.value : undefined);
  }
  protected has(o: string | number) {
    const v = this.value();
    return Array.isArray(v) && v.includes(o);
  }
  protected toggle(o: string | number) {
    const current = (Array.isArray(this.value()) ? this.value() : []) as (string | number)[];
    const next = current.includes(o) ? current.filter((x) => x !== o) : [...current, o];
    // Keep the option order (alignment: lawful–chaotic before good–evil)
    const order = (this.spec().options ?? []).map((x) => x.value);
    this.set(next.sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  }
  protected setList(raw: string) {
    this.set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  }
  protected ability(a: string) {
    const v = this.data()[a];
    return typeof v === 'number' ? v : '';
  }
  protected setAbility(a: string, raw: string) {
    this.changed.emit({ path: [a], value: raw === '' ? undefined : Number(raw) });
  }
}

/** Traits, actions, …: a list of `{name, entries}` blocks. */
@Component({
  selector: 'cn-named-entries',
  imports: [forwardRef(() => EntriesEditor)],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ol class="flex flex-col gap-2">
      @for (item of items(); track $index; let i = $index) {
        <li class="rounded-lg border border-line p-2">
          <div class="flex items-center gap-1">
            <input class="cn-prop-input min-w-0 flex-1 font-semibold" [value]="item.name ?? ''" placeholder="Name" [attr.aria-label]="label() + ' ' + (i + 1) + ' name'" (change)="patch(i, { name: $any($event.target).value })" />
            <button type="button" class="px-1 text-xs text-muted hover:text-ink disabled:opacity-30" [disabled]="i === 0" (click)="move(i, -1)" aria-label="Move up">↑</button>
            <button type="button" class="px-1 text-xs text-muted hover:text-ink disabled:opacity-30" [disabled]="i === items().length - 1" (click)="move(i, 1)" aria-label="Move down">↓</button>
            <button type="button" class="px-1 text-xs text-muted hover:text-accent" (click)="remove(i)" [attr.aria-label]="'Remove ' + (item.name || 'entry')">✕</button>
          </div>
          <div class="mt-1">
            <cn-entries-editor [entries]="$any(item.entries ?? [])" [searchParams]="searchParams()" (changed)="changed.emit({ path: [i, 'entries'].concat($event.path), value: $event.value })" />
          </div>
        </li>
      }
    </ol>
    <button type="button" class="mt-1 text-xs text-muted hover:text-accent" (click)="add()">+ {{ label() }}</button>`,
})
export class NamedEntries {
  readonly items = input<{ name?: string; entries?: unknown[] }[]>([]);
  readonly label = input('Entry');
  readonly searchParams = input<Record<string, string>>({});
  /** Changes relative to the list (`path: []` replaces it). */
  readonly changed = output<EntriesPatch>();

  protected patch(i: number, change: Record<string, unknown>) {
    for (const [k, v] of Object.entries(change)) this.changed.emit({ path: [i, k], value: v });
  }
  protected move(i: number, delta: number) {
    const next = [...this.items()];
    const [it] = next.splice(i, 1);
    next.splice(i + delta, 0, it!);
    this.changed.emit({ path: [], value: next });
  }
  protected remove(i: number) {
    this.changed.emit({ path: [], value: this.items().filter((_, j) => j !== i) });
  }
  protected add() {
    this.changed.emit({ path: [], value: [...this.items(), { name: '', entries: [''] }] });
  }
}

/** The form for one homebrew type (sections of fields), editing a copy of the full entity. */
@Component({
  selector: 'cn-entity-form',
  imports: [FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (section of sections(); track section.title) {
      <fieldset class="mb-4 rounded-xl border border-line p-3">
        <legend class="px-1 text-sm font-semibold">{{ section.title }}</legend>
        <div class="grid gap-3 sm:grid-cols-2">
          @for (f of section.fields; track pathKey(f.path)) {
            <cn-form-field [spec]="f" [data]="data()" [searchParams]="searchParams()" (changed)="changed.emit($event)" />
          }
        </div>
      </fieldset>
    } @empty {
      <p class="text-sm text-muted">There is no form for this type yet. Edit it in the JSON view.</p>
    }
    @if (unlisted().length) {
      <p class="text-xs text-muted">Also set (edit in JSON): {{ unlisted().join(', ') }}</p>
    }`,
})
export class EntityForm {
  readonly type = input.required<string>();
  readonly data = input.required<Data>();
  readonly searchParams = input<Record<string, string>>({});
  readonly changed = output<FieldPatch>();
  protected readonly sections = computed(() => FORM_SPECS[this.type()] ?? []);
  protected readonly unlisted = computed(() => (FORM_SPECS[this.type()] ? unlistedFields(this.type(), this.data()) : []));
  protected pathKey(p: JsonPath) {
    return p.join('.') || 'root';
  }
}
