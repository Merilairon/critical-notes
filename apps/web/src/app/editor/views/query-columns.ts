import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, input, output, signal, untracked } from '@angular/core';
import { CampaignStore } from '../../campaign/campaign.store';
import { columnCatalog, defaultColumns, MAX_COLUMNS, normalizeColumns, resolveColumn, staleReason, type ColumnContext, type QueryViewMode } from './query-model';

let nextId = 0;

interface Item {
  key: string;
  label: string;
  dmOnly: boolean;
  stale: string | null;
}

/**
 * The column picker in the Configure panel (design section 4): the chosen columns as an ordered list with
 * move up, move down and remove, an "Add a column" select, and Reset. Plain native controls, so it works with a
 * keyboard, a screen reader and at 390 px. Changes are announced in one polite live region.
 */
@Component({
  selector: 'cn-query-columns',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cn-qcols">
      <span class="cn-label" [id]="uid + '-h'">Columns</span>
      @if (mode() === 'list') {
        <p class="text-muted">Switch to Table or Cards to choose columns.</p>
      } @else {
        @if (!items().length) {
          <p class="text-muted">Using the default columns for these pages: {{ defaultLabels() }}.</p>
        } @else {
          <ol class="cn-qcols-list" aria-label="Columns shown, in order">
            @for (it of items(); track it.key; let i = $index; let first = $first; let last = $last) {
              <li class="cn-qcols-item" [class.cn-qcols-stale]="it.stale" [attr.aria-describedby]="it.dmOnly ? uid + '-w-' + i : null">
                <span class="cn-qcols-name">
                  <span class="text-muted">{{ i + 1 }}</span>
                  <span>{{ it.stale ?? it.label }}</span>
                  @if (it.dmOnly) {<span class="cn-badge-plain">DM only</span>}
                  @if (it.stale) {<span class="cn-badge-plain">Not shown</span>}
                </span>
                <span class="cn-qcols-actions">
                  <button type="button" class="cn-btn" data-act="up" [attr.data-key]="it.key" [attr.aria-label]="'Move ' + name(it) + ' up'" [attr.aria-disabled]="first ? 'true' : null" (click)="move(i, -1)">Up</button>
                  <button type="button" class="cn-btn" data-act="down" [attr.data-key]="it.key" [attr.aria-label]="'Move ' + name(it) + ' down'" [attr.aria-disabled]="last ? 'true' : null" (click)="move(i, 1)">Down</button>
                  <button type="button" class="cn-btn" data-act="remove" [attr.aria-label]="'Remove ' + name(it)" (click)="remove(i)">Remove</button>
                </span>
                @if (it.dmOnly) {<p class="cn-qcols-note text-muted" [id]="uid + '-w-' + i">Players will not see this column.</p>}
              </li>
            }
          </ol>
        }
        @if (full()) {
          <p class="text-muted" tabindex="-1" data-act="end-hint">{{ max }} columns is the maximum.</p>
        } @else if (!hasChoices()) {
          <p class="text-muted" tabindex="-1" data-act="end-hint">All available columns are shown.</p>
        } @else {
          <div class="cn-qcols-add">
            <label class="sr-only" [for]="uid + '-sel'">Add a column</label>
            <select #sel class="cn-input" [id]="uid + '-sel'" data-act="add-select">
              <option value="" selected disabled>Add a column</option>
              @if (offered().page.length) {
                <optgroup label="Page">@for (c of offered().page; track c.key) {<option [value]="c.key">{{ c.label }}</option>}</optgroup>
              }
              @if (offered().details.length) {
                <optgroup label="Details">@for (c of offered().details; track c.key) {<option [value]="c.key">{{ c.label }}{{ c.dmOnly ? ' (DM only)' : '' }}</option>}</optgroup>
              }
              @if (offered().properties.length) {
                <optgroup label="Properties">@for (c of offered().properties; track c.key) {<option [value]="c.key">{{ c.label }}{{ c.dmOnly ? ' (DM only)' : '' }}</option>}</optgroup>
              }
            </select>
            <button type="button" class="cn-btn" data-act="add" (click)="add(sel.value); sel.value = ''">Add</button>
          </div>
        }
        <button type="button" class="cn-btn cn-qcols-reset" data-act="reset" (click)="reset()">Reset to default columns</button>
      }
      <div class="sr-only" role="status" aria-live="polite">{{ announcement() }}</div>
    </div>
  `,
})
export class QueryColumns {
  /** The saved `columns` attribute. */
  readonly columns = input<unknown>([]);
  readonly types = input<readonly string[]>([]);
  readonly mode = input<QueryViewMode>('table');
  readonly columnsChange = output<string[]>();

  private readonly store = inject(CampaignStore, { optional: true });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly uid = `cn-qcols-${nextId++}`;
  protected readonly max = MAX_COLUMNS;
  protected readonly announcement = signal('');
  private after: (() => void) | null = null;

  private readonly cx = computed<ColumnContext>(() => ({ types: this.types(), props: this.store?.propertyDefs() ?? [], isGm: this.store?.isGm() ?? false }));
  private readonly keys = computed(() => normalizeColumns(this.columns()));
  protected readonly items = computed<Item[]>(() =>
    this.keys().map((key) => {
      const col = resolveColumn(key, this.cx());
      return { key, label: col?.label ?? key, dmOnly: !!col?.dmOnly, stale: col ? null : staleReason(key, this.cx()) };
    }),
  );
  protected readonly offered = computed(() => {
    const chosen = new Set(this.keys());
    const cat = columnCatalog(this.cx());
    const free = (list: typeof cat.page) => list.filter((c) => !chosen.has(c.key));
    return { page: free(cat.page), details: free(cat.details), properties: free(cat.properties) };
  });
  protected readonly hasChoices = computed(() => {
    const o = this.offered();
    return o.page.length + o.details.length + o.properties.length > 0;
  });
  protected readonly full = computed(() => this.keys().length >= MAX_COLUMNS);
  protected readonly defaultLabels = computed(() =>
    defaultColumns(this.types(), this.mode() === 'cards' ? 'cards' : 'table', this.cx())
      .map((k) => resolveColumn(k, this.cx())?.label ?? k)
      .join(', ') || 'Title only',
  );

  constructor() {
    // A message about the other view is not news after switching
    effect(() => {
      this.mode();
      untracked(() => this.announcement.set(''));
    });
    // Focus is put back once the new list is on screen
    afterRenderEffect(() => {
      this.keys();
      const run = this.after;
      this.after = null;
      run?.();
    });
  }

  protected name(it: Item): string {
    return it.stale ? it.key : it.label;
  }
  private focus(selector: string) {
    this.after = () => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus();
  }
  private emit(next: string[]) {
    // Nothing will change, so no re-render will run the pending focus: drop it
    if (JSON.stringify(next) === JSON.stringify(this.keys())) this.after = null;
    this.columnsChange.emit(next);
  }

  protected add(key: string) {
    if (!key || this.keys().includes(key) || this.keys().length >= MAX_COLUMNS) return;
    // The first choice starts from the columns that were being shown by default
    const base = this.keys().length ? this.keys() : defaultColumns(this.types(), this.mode() === 'cards' ? 'cards' : 'table', this.cx());
    const next = [...base, key].slice(0, MAX_COLUMNS);
    const label = resolveColumn(key, this.cx())?.label ?? key;
    this.announcement.set(`Added ${label}. ${next.length} ${next.length === 1 ? 'column' : 'columns'} shown.`);
    // At the maximum (or with nothing left to add) the select is gone: the hint takes the focus
    this.focus('[data-act="add-select"], [data-act="end-hint"]');
    this.emit(next);
  }

  protected remove(i: number) {
    const keys = this.keys();
    const it = this.items()[i];
    if (!it) return;
    const next = keys.filter((_, ix) => ix !== i);
    this.announcement.set(`Removed ${this.name(it)}. ${next.length} ${next.length === 1 ? 'column' : 'columns'} shown.`);
    // The Remove button now at this position, else the previous one, else the select
    const target = next.length ? `.cn-qcols-item:nth-child(${Math.min(i, next.length - 1) + 1}) [data-act="remove"]` : '[data-act="add-select"]';
    this.focus(target);
    this.emit(next);
  }

  protected move(i: number, by: -1 | 1) {
    const keys = [...this.keys()];
    const it = this.items()[i];
    const j = i + by;
    if (!it) return;
    if (j < 0 || j >= keys.length) {
      this.announcement.set(`${this.name(it)} is already ${by < 0 ? 'first' : 'last'}.`);
      return;
    }
    [keys[i], keys[j]] = [keys[j]!, keys[i]!];
    this.announcement.set(`${this.name(it)} moved to position ${j + 1} of ${keys.length}.`);
    this.focus(`[data-act="${by < 0 ? 'up' : 'down'}"][data-key="${CSS.escape(it.key)}"]`);
    this.emit(keys);
  }

  protected reset() {
    this.announcement.set('Columns reset to the default for these pages.');
    this.focus('[data-act="reset"]');
    this.emit([]);
  }
}
