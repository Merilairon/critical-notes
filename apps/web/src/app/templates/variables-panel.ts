import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { TemplateVariable } from '@cn/templates';

const TYPE_SUGGESTIONS = [
  'text',
  'number',
  'boolean',
  'date',
  'dice',
  'pageLink',
  'pageLink<npc>',
  'pageLink<location>',
  'select(a|b|c)',
  'reference<monster>',
  'reference<item>',
  'reference<spell>',
  'reference<condition>',
];

/** The template's variables (found in its content) with their labels, types, defaults and required flags. */
@Component({
  selector: 'cn-variables-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<datalist id="cn-var-types">
      @for (t of types; track t) {<option [value]="t"></option>}
    </datalist>
    @if (variables().length) {
      <ul class="flex flex-col gap-2">
        @for (v of variables(); track v.name) {
          <li class="rounded-lg border border-line p-2">
            <div class="mb-1 flex items-center gap-2">
              <code class="min-w-0 flex-1 truncate text-xs font-semibold">{{ v.name }}</code>
              <label class="flex items-center gap-1 text-xs text-muted">
                <input type="checkbox" [checked]="!!v.required" [disabled]="!editable()" (change)="patch(v, { required: $any($event.target).checked || undefined })" [attr.aria-label]="v.name + ' required'" />
                required
              </label>
            </div>
            <div class="grid grid-cols-2 gap-1">
              <input class="cn-prop-input col-span-2" list="cn-var-types" [value]="v.type" [disabled]="!editable() || typed().has(v.name)" [title]="typed().has(v.name) ? 'Set in the content: ' + field(v.name + ': ' + v.type) : 'Type'" (change)="patch(v, { type: $any($event.target).value.trim() || 'text' })" [attr.aria-label]="v.name + ' type'" />
              <input class="cn-prop-input" [value]="v.label ?? ''" [disabled]="!editable()" placeholder="Label" (change)="patch(v, { label: $any($event.target).value.trim() || undefined })" [attr.aria-label]="v.name + ' label'" />
              <input class="cn-prop-input" [value]="v.default ?? ''" [disabled]="!editable()" placeholder="Default" (change)="patch(v, { default: $any($event.target).value === '' ? undefined : $any($event.target).value })" [attr.aria-label]="v.name + ' default'" />
            </div>
          </li>
        }
      </ul>
    } @else {
      <p class="text-sm text-muted">No fields yet. Type <code>{{ field('name') }}</code> in the content to add one.</p>
    }
    @for (issue of issues(); track issue) {<p class="mt-1 text-xs text-accent">{{ issue }}</p>}`,
})
export class VariablesPanel {
  readonly variables = input<TemplateVariable[]>([]);
  readonly typed = input<Set<string>>(new Set());
  readonly issues = input<string[]>([]);
  readonly editable = input(true);
  readonly changed = output<TemplateVariable>();
  protected readonly types = TYPE_SUGGESTIONS;
  /** Renders `{{text}}` (Angular interpolation cannot contain a literal closing brace pair). */
  protected readonly field = (text: string) => `{{${text}}}`;

  protected patch(v: TemplateVariable, change: Partial<TemplateVariable>) {
    const next: TemplateVariable = { ...v, ...change };
    for (const k of Object.keys(change) as (keyof TemplateVariable)[]) if (next[k] === undefined) delete next[k];
    this.changed.emit(next);
  }
}
