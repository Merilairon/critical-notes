import { ChangeDetectionStrategy, Component, forwardRef, input, output, signal } from '@angular/core';
import type { JsonPath } from './forms/path';
import { JsonField } from './forms/json-field';
import { TableRows } from './forms/table-rows';
import { TagTextarea } from './tag-textarea';

type Entry = string | Record<string, unknown>;

/** A change relative to the edited array: `path: []` replaces the whole array. */
export interface EntriesPatch {
  path: JsonPath;
  value: unknown;
}

/** Entry types edited as a named block with nested entries. */
const CONTAINERS: Record<string, string> = {
  entries: 'Section',
  section: 'Chapter',
  inset: 'Inset',
  insetReadaloud: 'Read-aloud',
  quote: 'Quote',
  variant: 'Variant rule',
  variantInner: 'Variant (inner)',
  variantSub: 'Variant (sub)',
  inline: 'Inline group',
  inlineBlock: 'Inline block',
};

export type CardKind = 'text' | 'container' | 'list' | 'table' | 'raw';

export function cardKind(e: Entry): CardKind {
  if (typeof e === 'string') return 'text';
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'raw';
  const t = e['type'];
  if (typeof t === 'string' && t in CONTAINERS && Array.isArray(e['entries'] ?? [])) return 'container';
  if (t === 'list' && Array.isArray(e['items'] ?? [])) return 'list';
  if (t === 'table' && Array.isArray(e['rows'] ?? [])) return 'table';
  return 'raw';
}

const NEW_ENTRIES: { label: string; make: () => Entry }[] = [
  { label: 'Paragraph', make: () => '' },
  { label: 'Section', make: () => ({ type: 'entries', name: 'Heading', entries: [''] }) },
  { label: 'List', make: () => ({ type: 'list', items: [''] }) },
  { label: 'Table', make: () => ({ type: 'table', colLabels: ['d6', 'Result'], colStyles: ['col-2 text-center', 'col-10'], rows: [['1', ''], ['2', '']] }) },
  { label: 'Inset', make: () => ({ type: 'inset', name: 'Sidebar', entries: [''] }) },
  { label: 'Read-aloud', make: () => ({ type: 'insetReadaloud', entries: [''] }) },
  { label: 'Quote', make: () => ({ type: 'quote', entries: [''], by: '' }) },
  { label: 'Raw JSON', make: () => ({ type: 'hr' }) },
];

/**
 * Structured editor for a 5etools `entries` array: one card per entry. Strings get a tag-aware textarea;
 * sections, lists and tables get their own cards; anything else is a raw JSON card. Unknown properties of
 * entries are always kept (cards spread the original object).
 */
@Component({
  selector: 'cn-entries-editor',
  imports: [TagTextarea, JsonField, TableRows, forwardRef(() => EntriesEditor)],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ol class="flex flex-col gap-2">
      @for (entry of entries(); track $index; let i = $index) {
        <li class="rounded-lg border border-line bg-panel p-2">
          <div class="mb-1 flex items-center gap-1 text-xs text-muted">
            <span class="font-semibold">{{ title(entry) }}</span>
            <span class="ml-auto flex gap-1">
              <button type="button" class="px-1 hover:text-ink disabled:opacity-30" [disabled]="i === 0" (click)="move(i, -1)" [attr.aria-label]="'Move entry ' + (i + 1) + ' up'">↑</button>
              <button type="button" class="px-1 hover:text-ink disabled:opacity-30" [disabled]="i === entries().length - 1" (click)="move(i, 1)" [attr.aria-label]="'Move entry ' + (i + 1) + ' down'">↓</button>
              <button type="button" class="px-1 hover:text-accent" (click)="remove(i)" [attr.aria-label]="'Remove entry ' + (i + 1)">✕</button>
            </span>
          </div>
          @switch (kind(entry)) {
            @case ('text') {
              <cn-tag-textarea [value]="$any(entry)" [label]="'Paragraph ' + (i + 1)" [searchParams]="searchParams()" (changed)="set(i, $event)" />
            }
            @case ('container') {
              <div class="flex flex-wrap gap-2">
                <input class="min-w-0 flex-1 rounded-md border border-control bg-bg px-2 py-1 text-sm font-semibold" [value]="field(entry, 'name')" placeholder="Heading (optional)" aria-label="Heading" (change)="patch(i, { name: $any($event.target).value || undefined })" />
                @if (field(entry, 'type') === 'quote') {
                  <input class="min-w-0 flex-1 rounded-md border border-control bg-bg px-2 py-1 text-sm" [value]="field(entry, 'by')" placeholder="Quoted person" aria-label="Quoted person" (change)="patch(i, { by: $any($event.target).value || undefined })" />
                }
              </div>
              <div class="mt-2 border-l-2 border-line pl-2">
                <cn-entries-editor [entries]="list(entry, 'entries')" [searchParams]="searchParams()" (changed)="relay([i, 'entries'], $event)" />
              </div>
            }
            @case ('list') {
              <div class="border-l-2 border-line pl-2">
                <cn-entries-editor [entries]="list(entry, 'items')" [searchParams]="searchParams()" (changed)="relay([i, 'items'], $event)" />
              </div>
            }
            @case ('table') {
              <input class="mb-1 w-full rounded-md border border-control bg-bg px-2 py-1 text-sm" [value]="field(entry, 'caption')" placeholder="Caption" aria-label="Table caption" (change)="patch(i, { caption: $any($event.target).value || undefined })" />
              <input class="mb-1 w-full rounded-md border border-control bg-bg px-2 py-1 text-xs" [value]="labels(entry).join(' | ')" placeholder="Column labels, separated by |" aria-label="Column labels" (change)="setLabels(i, $any($event.target).value)" />
              <cn-table-rows [rows]="$any(list(entry, 'rows'))" [labels]="labels(entry)" (changed)="patch(i, { rows: $event })" />
            }
            @default {
              <cn-json-field [value]="entry" label="Entry JSON" (changed)="set(i, $any($event))" />
            }
          }
        </li>
      }
    </ol>
    <div class="relative mt-1">
      <button type="button" class="text-xs text-muted hover:text-accent" [attr.aria-expanded]="adding()" (click)="adding.set(!adding())">+ Add</button>
      @if (adding()) {
        <div class="mt-1 flex flex-wrap gap-1">
          @for (n of newEntries; track n.label) {
            <button type="button" class="rounded-full border border-line px-2 py-0.5 text-xs hover:border-accent" (click)="add(n.make())">{{ n.label }}</button>
          }
        </div>
      }
    </div>`,
})
export class EntriesEditor {
  readonly entries = input<Entry[]>([]);
  readonly searchParams = input<Record<string, string>>({});
  readonly changed = output<EntriesPatch>();
  protected readonly adding = signal(false);
  protected readonly newEntries = NEW_ENTRIES;
  protected readonly kind = cardKind;

  protected title(e: Entry): string {
    const k = cardKind(e);
    if (k === 'text') return 'Paragraph';
    if (k === 'container') return CONTAINERS[String((e as Record<string, unknown>)['type'])] ?? 'Section';
    if (k === 'list') return 'List';
    if (k === 'table') return 'Table';
    const t = typeof e === 'object' && e ? (e as Record<string, unknown>)['type'] : null;
    return typeof t === 'string' ? `${t} (JSON)` : 'JSON';
  }
  protected field(e: Entry, key: string): string {
    const v = typeof e === 'object' && e ? e[key] : undefined;
    return typeof v === 'string' ? v : '';
  }
  protected list(e: Entry, key: string): Entry[] {
    const v = typeof e === 'object' && e ? e[key] : undefined;
    return Array.isArray(v) ? (v as Entry[]) : [];
  }
  protected labels(e: Entry): string[] {
    const v = typeof e === 'object' && e ? e['colLabels'] : undefined;
    return Array.isArray(v) ? v.map(String) : [];
  }

  private emit(next: Entry[]) {
    this.changed.emit({ path: [], value: next });
  }
  protected relay(prefix: JsonPath, patch: EntriesPatch) {
    this.changed.emit({ path: [...prefix, ...patch.path], value: patch.value });
  }
  protected set(i: number, value: Entry) {
    this.changed.emit({ path: [i], value });
  }
  /** Sets or removes (undefined) properties of an object entry. */
  protected patch(i: number, change: Record<string, unknown>) {
    for (const [k, v] of Object.entries(change)) this.changed.emit({ path: [i, k], value: v });
  }
  protected setLabels(i: number, raw: string) {
    const labels = raw.split('|').map((l) => l.trim());
    this.patch(i, { colLabels: raw.trim() ? labels : undefined });
  }
  protected move(i: number, delta: number) {
    const next = [...this.entries()];
    const [item] = next.splice(i, 1);
    next.splice(i + delta, 0, item!);
    this.emit(next);
  }
  protected remove(i: number) {
    this.emit(this.entries().filter((_, j) => j !== i));
  }
  protected add(entry: Entry) {
    this.adding.set(false);
    this.emit([...this.entries(), entry]);
  }
}
