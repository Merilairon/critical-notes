import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { PAGE_TYPE_LABELS, PAGE_TYPES, PROPERTY_TYPES, VISIBILITY_VALUES, type TemplateSummaryDto } from '@cn/shared';
import type { PageTemplateDef, TemplateChild, TemplateProperty } from '@cn/templates';
import { JsonField } from '../homebrew/forms/json-field';

export type PageFields = Omit<PageTemplateDef, 'body' | 'variables'>;

const VISIBILITY_LABELS: Record<string, string> = { dm: 'DM only', all: 'All players', selected: 'Selected players' };

/** Settings of a page template: page type, parent template, defaults, facet values, properties and subpages. */
@Component({
  selector: 'cn-page-template-fields',
  imports: [JsonField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@let d = def();
    <div class="grid gap-3 text-sm sm:grid-cols-2" [class.pointer-events-none]="!editable()">
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted">Creates a</span>
        <select class="cn-prop-input" (change)="patch({ pageType: $any($event.target).value })" aria-label="Page type">
          @for (t of pageTypes; track t) {<option [value]="t" [selected]="t === d.pageType">{{ typeLabels[t] }}</option>}
        </select>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted">Extends</span>
        <select class="cn-prop-input" (change)="patch({ extendsRef: $any($event.target).value || null })" aria-label="Extends">
          <option value="" [selected]="!d.extendsRef">— nothing —</option>
          @for (t of parents(); track t.id) {<option [value]="ref(t)" [selected]="ref(t) === d.extendsRef || t.id === d.extendsRef">{{ t.name }}{{ t.scope === 'global' ? ' (built-in)' : '' }}</option>}
        </select>
      </label>
      @if (d.extendsRef) {
        <fieldset class="flex gap-4 sm:col-span-2">
          <legend class="text-xs text-muted">This template's content</legend>
          <label class="flex items-center gap-1"><input type="radio" name="bodyMode" [checked]="d.bodyMode === 'append'" (change)="patch({ bodyMode: 'append' })" /> comes after the parent's</label>
          <label class="flex items-center gap-1"><input type="radio" name="bodyMode" [checked]="d.bodyMode === 'replace'" (change)="patch({ bodyMode: 'replace' })" /> replaces the parent's</label>
        </fieldset>
      }
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted">Default title</span>
        <input class="cn-prop-input" [value]="d.defaults.title ?? ''" [placeholder]="'e.g. Session ' + field('number')" (change)="defaults({ title: $any($event.target).value || undefined })" aria-label="Default title" />
      </label>
      <div class="grid grid-cols-[4rem_1fr] gap-2">
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted">Icon</span>
          <input class="cn-prop-input text-center" maxlength="8" [value]="d.defaults.icon ?? ''" (change)="defaults({ icon: $any($event.target).value || null })" aria-label="Default icon" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted">Visible to</span>
          <select class="cn-prop-input" (change)="defaults({ visibility: $any($event.target).value || undefined })" aria-label="Default visibility">
            <option value="">— default (DM only) —</option>
            @for (v of visibilities; track v) {<option [value]="v" [selected]="v === d.defaults.visibility">{{ visibilityLabels[v] }}</option>}
          </select>
        </label>
      </div>
      <label class="flex flex-col gap-1 sm:col-span-2">
        <span class="text-xs text-muted">Tags (comma separated)</span>
        <input class="cn-prop-input" [value]="(d.defaults.tags ?? []).join(', ')" (change)="setTags($any($event.target).value)" aria-label="Default tags" />
      </label>
      <label class="flex flex-col gap-1 sm:col-span-2">
        <span class="text-xs text-muted">{{ typeLabel(d.pageType) }} details (JSON; values may use {{ field('fields') }})</span>
        <cn-json-field [value]="d.facet" label="Details" [placeholder]="facetExample" (changed)="patch({ facet: $any($event) ?? {} })" />
      </label>
    </div>

    <h2 class="mt-4 mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Properties</h2>
    <p class="mb-1 text-xs text-muted">Added to the campaign if missing, and set on new pages.</p>
    @for (p of d.properties; track $index; let i = $index) {
      <div class="mb-1 flex flex-wrap items-center gap-1 text-sm">
        <input class="cn-prop-input w-36" [value]="p.label" placeholder="Label" (change)="setProperty(i, { label: $any($event.target).value })" aria-label="Property label" />
        <select class="cn-prop-input" (change)="setProperty(i, { type: $any($event.target).value })" aria-label="Property type">
          @for (t of propertyTypes; track t) {<option [value]="t" [selected]="t === p.type">{{ t }}</option>}
        </select>
        @if (p.type === 'select' || p.type === 'multiselect') {
          <input class="cn-prop-input w-40" [value]="(p.options ?? []).join(', ')" placeholder="Options, comma separated" (change)="setProperty(i, { options: split($any($event.target).value) })" aria-label="Options" />
        }
        <input class="cn-prop-input w-32" [value]="$any(p.default) ?? ''" placeholder="Default" (change)="setProperty(i, { default: $any($event.target).value || undefined })" aria-label="Default value" />
        <label class="flex items-center gap-1 text-xs"><input type="checkbox" [checked]="!!p.dmOnly" (change)="setProperty(i, { dmOnly: $any($event.target).checked })" /> DM only</label>
        <button type="button" class="text-muted hover:text-accent" (click)="removeProperty(i)" aria-label="Remove property">✕</button>
      </div>
    }
    @if (editable()) {<button type="button" class="text-xs text-muted hover:text-accent" (click)="addProperty()">+ Property</button>}

    <h2 class="mt-4 mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Subpages</h2>
    @for (c of d.children; track $index; let i = $index) {
      <div class="mb-1 flex flex-wrap items-center gap-1 text-sm">
        <input class="cn-prop-input w-48" [value]="c.title" placeholder="Title" (change)="setChild(i, { title: $any($event.target).value || 'Untitled' })" aria-label="Subpage title" />
        <select class="cn-prop-input" (change)="setChild(i, { templateRef: $any($event.target).value || null })" aria-label="Subpage template">
          <option value="">Empty page</option>
          @for (t of pageTemplates(); track t.id) {<option [value]="ref(t)" [selected]="ref(t) === c.templateRef || t.id === c.templateRef">{{ t.name }}</option>}
        </select>
        <button type="button" class="text-muted hover:text-accent" (click)="removeChild(i)" aria-label="Remove subpage">✕</button>
      </div>
    }
    @if (editable()) {<button type="button" class="text-xs text-muted hover:text-accent" (click)="addChild()">+ Subpage</button>}`,
})
export class PageTemplateFields {
  readonly def = input.required<PageFields>();
  /** Page templates available as parents and subpage templates. */
  readonly pageTemplates = input<TemplateSummaryDto[]>([]);
  readonly selfId = input<string | null>(null);
  readonly editable = input(true);
  readonly changed = output<Partial<PageFields>>();

  protected readonly pageTypes = PAGE_TYPES;
  protected readonly typeLabels = PAGE_TYPE_LABELS;
  protected readonly visibilities = VISIBILITY_VALUES;
  protected readonly visibilityLabels = VISIBILITY_LABELS;
  protected readonly propertyTypes = PROPERTY_TYPES;
  protected readonly facetExample = '{"status": "alive", "role": "{{role}}"}';
  /** Renders `{{text}}` (Angular interpolation cannot contain a literal closing brace pair). */
  protected readonly field = (text: string) => `{{${text}}}`;

  protected typeLabel(t: string) {
    return PAGE_TYPE_LABELS[t as keyof typeof PAGE_TYPE_LABELS] ?? 'Page';
  }
  protected parents() {
    return this.pageTemplates().filter((t) => t.id !== this.selfId());
  }
  /** Built-ins are referenced by key so the reference survives reinstalls. */
  protected ref(t: TemplateSummaryDto) {
    return t.builtinKey ? `builtin:${t.builtinKey}` : t.id;
  }
  protected patch(change: Partial<PageFields>) {
    this.changed.emit(change);
  }
  protected defaults(change: Partial<PageFields['defaults']>) {
    const next = { ...this.def().defaults, ...change };
    for (const k of Object.keys(change) as (keyof PageFields['defaults'])[]) if (next[k] === undefined) delete next[k];
    this.patch({ defaults: next });
  }
  protected split(raw: string) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  protected setTags(raw: string) {
    const tags = this.split(raw).map((t) => t.toLowerCase());
    this.defaults({ tags: tags.length ? tags : undefined });
  }
  protected setProperty(i: number, change: Partial<TemplateProperty>) {
    const props = this.def().properties.map((p, j) => {
      if (j !== i) return p;
      const next = { ...p, ...change };
      if (change.label !== undefined) next.key = slug(change.label);
      return next;
    });
    this.patch({ properties: props });
  }
  protected addProperty() {
    this.patch({ properties: [...this.def().properties, { key: `property_${this.def().properties.length + 1}`, label: 'Property', type: 'text' }] });
  }
  protected removeProperty(i: number) {
    this.patch({ properties: this.def().properties.filter((_, j) => j !== i) });
  }
  protected setChild(i: number, change: Partial<TemplateChild>) {
    this.patch({ children: this.def().children.map((c, j) => (j === i ? { ...c, ...change } : c)) });
  }
  protected addChild() {
    this.patch({ children: [...this.def().children, { title: 'Subpage', templateRef: null }] });
  }
  protected removeChild(i: number) {
    this.patch({ children: this.def().children.filter((_, j) => j !== i) });
  }
}

function slug(label: string) {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'property'
  );
}
