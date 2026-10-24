import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PAGE_TYPE_ICONS, PAGE_TYPE_LABELS, type QueryRowDto } from '@cn/shared';
import { CampaignStore } from '../../campaign/campaign.store';
import {
  cellFor,
  effectiveColumns,
  normalizeColumns,
  normalizeView,
  sortRows,
  sortValue,
  type Cell,
  type ColumnContext,
  type ColumnDef,
  type SortDir,
} from './query-model';

interface RowModel {
  row: QueryRowDto;
  cells: Cell[];
}

/** Cards show this many chosen columns in a narrow container (design 3.5, Q2). */
const NARROW_CARD_COLUMNS = 4;

/**
 * The rows of a query block as a list, a table or cards, with the loading, error and empty states. Shared by the
 * editor (`QueryView`) and the read-only renderer (`QueryBlock`); both own the request.
 */
@Component({
  selector: 'cn-query-results',
  imports: [RouterLink, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.aria-busy]': 'busy() ? "true" : null' },
  template: `
    <ng-template #cell let-c>
      @switch (c.kind) {
        @case ('empty') {<span aria-hidden="true">—</span><span class="sr-only">empty</span>}
        @case ('text') {<span [class.cn-clamp]="c.long">{{ c.text }}</span>}
        @case ('number') { {{ c.text }} }
        @case ('badge') {<span class="cn-badge-plain">{{ c.text }}</span>}
        @case ('chips') {<span class="cn-chips">@for (item of c.items; track $index) {<span class="cn-badge-plain">{{ item }}</span>}</span>}
        @case ('date') {<time [attr.datetime]="c.iso">{{ c.text }}</time>}
        @case ('bool') {<span [class.text-muted]="!c.yes">{{ c.yes ? 'Yes' : 'No' }}</span>}
        @case ('page') {<a class="cn-cell-link" [routerLink]="['/c', store?.id(), 'p', c.id]">{{ c.title }}</a>}
        @case ('url') {<a class="cn-cell-link" [href]="c.href" target="_blank" rel="noopener noreferrer">{{ c.host }}</a>}
        @case ('type') { <span aria-hidden="true">{{ c.icon }}</span> {{ c.label }} }
      }
    </ng-template>

    @if (error()) {
      <div class="cn-query-state cn-query-error" role="alert">
        <p>Could not load these pages.</p>
        <button type="button" class="cn-btn" (click)="retry.emit()">Try again</button>
      </div>
    } @else if (loading()) {
      <p class="cn-query-state text-muted">Loading pages...</p>
    } @else if (!rows().length) {
      <p class="cn-query-state text-muted">No matching pages.@if (editing()) { Change the filters in Configure.}</p>
    } @else if (mode() === 'table') {
      <div class="cn-table-wrap" role="region" aria-label="Scrollable table" tabindex="0">
        <table class="cn-table" [attr.aria-label]="title() ? null : 'Query results'">
          @if (title()) {<caption class="cn-table-title" [class.sr-only]="editing()">{{ title() }}</caption>}
          <thead>
            <tr>
              <th scope="col" class="cn-title-cell" [attr.aria-sort]="ariaSort('title')">
                <button type="button" (click)="toggleSort('title')">Title @if (indicator('title'); as glyph) {<span aria-hidden="true" class="cn-sort-glyph">{{ glyph }}</span>}</button>
              </th>
              @for (c of cols(); track c.key) {
                <th scope="col" [class.cn-num]="c.kind === 'number'" [attr.aria-sort]="ariaSort(c.key)">
                  <button type="button" (click)="toggleSort(c.key)">{{ c.label }} @if (indicator(c.key); as glyph) {<span aria-hidden="true" class="cn-sort-glyph">{{ glyph }}</span>}</button>
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (m of models(); track m.row.id) {
              <tr>
                <th scope="row" class="cn-title-cell">
                  <a class="cn-title-link" [routerLink]="['/c', store?.id(), 'p', m.row.id]"
                    ><span aria-hidden="true">{{ m.row.icon || icons[m.row.type] }}</span>
                    @if (!hasTypeColumn()) {<span class="sr-only">{{ labels[m.row.type] }}: </span>}{{ m.row.title }}</a
                  >
                </th>
                @for (c of cols(); track c.key; let i = $index) {
                  <td [class.cn-num]="c.kind === 'number'"><ng-container [ngTemplateOutlet]="cell" [ngTemplateOutletContext]="{ $implicit: m.cells[i] }" /></td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    } @else if (mode() === 'cards') {
      <ul class="cn-cards" role="list" [attr.aria-label]="title() || 'Query results'">
        @for (m of models(); track m.row.id) {
          <li class="cn-card">
            <div class="cn-card-head">
              <span aria-hidden="true">{{ m.row.icon || icons[m.row.type] }}</span>
              <a class="cn-card-link" [routerLink]="['/c', store?.id(), 'p', m.row.id]">{{ m.row.title }}</a>
            </div>
            @if (cols().length) {
              <dl class="cn-card-fields">
                @for (c of cols(); track c.key; let i = $index) {
                  @if (m.cells[i]!.kind !== 'empty') {
                    <div class="cn-card-pair" [class.cn-card-extra]="i >= narrowCap()">
                      <dt>{{ c.label }}</dt>
                      <dd><ng-container [ngTemplateOutlet]="cell" [ngTemplateOutletContext]="{ $implicit: m.cells[i] }" /></dd>
                    </div>
                  }
                }
              </dl>
            }
          </li>
        }
      </ul>
    } @else {
      <ul class="cn-query-results" [attr.aria-label]="title() || 'Query results'">
        @for (row of rows(); track row.id) {
          <li><a class="cn-list-link" [routerLink]="['/c', store?.id(), 'p', row.id]">{{ row.icon || icons[row.type] }} {{ row.title }}</a></li>
        }
      </ul>
    }
    <p class="cn-query-foot text-muted" role="status">{{ footer() }}</p>
  `,
})
export class QueryResults {
  readonly rows = input<QueryRowDto[]>([]);
  /** Saved `view` attribute (anything unknown is the list). */
  readonly view = input<unknown>('list');
  /** Saved `columns` attribute. */
  readonly columns = input<unknown>([]);
  readonly filter = input<unknown>(null);
  readonly title = input('');
  /** First load: nothing to show yet. */
  readonly loading = input(false);
  /** Any load in flight (a reload keeps the old rows and only sets aria-busy). */
  readonly busy = input(false);
  readonly error = input(false);
  /** Inside the editor: the empty state points at Configure and the caption is not shown twice. */
  readonly editing = input(false);
  readonly retry = output<void>();

  protected readonly store = inject(CampaignStore, { optional: true });
  protected readonly icons = PAGE_TYPE_ICONS;
  protected readonly labels = PAGE_TYPE_LABELS;

  protected readonly mode = computed(() => normalizeView(this.view()));
  private readonly spec = computed(() => {
    const f = (this.filter() ?? {}) as { types?: unknown; sort?: { field?: unknown; dir?: unknown }; limit?: unknown };
    return {
      types: Array.isArray(f.types) ? f.types.filter((t): t is string => typeof t === 'string') : [],
      sortField: typeof f.sort?.field === 'string' ? f.sort.field : 'title',
      sortDir: (f.sort?.dir === 'desc' ? 'desc' : 'asc') as SortDir,
      limit: typeof f.limit === 'number' ? f.limit : 100,
    };
  });
  private readonly context = computed<ColumnContext>(() => ({ types: this.spec().types, props: this.store?.propertyDefs() ?? [], isGm: this.store?.isGm() ?? false }));
  private readonly explicit = computed(() => normalizeColumns(this.columns()));
  /** The columns shown: the chosen ones that still resolve, or the defaults when none were chosen. */
  protected readonly cols = computed<ColumnDef[]>(() => {
    return effectiveColumns(this.explicit(), this.spec().types, this.mode(), this.context());
  });
  protected readonly hasTypeColumn = computed(() => this.cols().some((c) => c.key === 'type'));
  protected readonly narrowCap = computed(() => (this.explicit().length ? NARROW_CARD_COLUMNS : Number.MAX_SAFE_INTEGER));

  private readonly pageTitle = (id: string) => this.store?.byId().get(id)?.title ?? null;

  // The viewer's own sort (table only): not saved, gone on reload
  protected readonly viewerSort = signal<{ key: string; dir: SortDir } | null>(null);
  /** Viewer sort when its column is still shown, else the saved default sort. */
  protected readonly shownSort = computed<{ key: string; dir: SortDir; viewer: boolean } | null>(() => {
    const v = this.viewerSort();
    if (v && (v.key === 'title' || this.cols().some((c) => c.key === v.key))) return { ...v, viewer: true };
    const s = this.spec();
    return s.sortField === 'title' || this.cols().some((c) => c.key === s.sortField) ? { key: s.sortField, dir: s.sortDir, viewer: false } : null;
  });

  protected readonly models = computed<RowModel[]>(() => {
    const cols = this.cols();
    const models = this.rows().map((row) => ({ row, cells: cols.map((c) => cellFor(row, c, this.pageTitle)) }));
    const v = this.viewerSort();
    if (this.mode() !== 'table' || !v) return models;
    const col = v.key === 'title' ? 'title' : cols.find((c) => c.key === v.key);
    return col ? sortRows(models, (m) => sortValue(m.row, col, this.pageTitle), v.dir) : models;
  });

  protected readonly footer = computed(() => {
    if (this.error() || this.loading() || !this.rows().length) return '';
    const n = this.rows().length;
    const capped = n === this.spec().limit;
    let text = `${n} ${n === 1 ? 'page' : 'pages'}.`;
    if (capped) text += ` Showing the first ${n}. Narrow the filters to see others.`;
    const v = this.viewerSort();
    if (this.mode() === 'table' && v && this.shownSort()?.viewer) {
      const label = v.key === 'title' ? 'Title' : (this.cols().find((c) => c.key === v.key)?.label ?? v.key);
      text += ` Sorted by ${label}, ${v.dir === 'asc' ? 'ascending' : 'descending'}.`;
      if (capped) text += ` Only the ${n} loaded pages are sorted.`;
    }
    return text;
  });

  protected ariaSort(key: string): 'ascending' | 'descending' | null {
    const s = this.shownSort();
    return s?.key === key ? (s.dir === 'asc' ? 'ascending' : 'descending') : null;
  }
  protected indicator(key: string): string {
    const s = this.ariaSort(key);
    return s === 'ascending' ? '▲' : s === 'descending' ? '▼' : '';
  }
  /** Ascending, then descending, then back to the order the server sent. */
  protected toggleSort(key: string) {
    const cur = this.viewerSort();
    if (cur?.key === key) {
      this.viewerSort.set(cur.dir === 'asc' ? { key, dir: 'desc' } : null);
      return;
    }
    const def = this.spec();
    this.viewerSort.set({ key, dir: def.sortField === key && def.sortDir === 'asc' ? 'desc' : 'asc' });
  }
}
