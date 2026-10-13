import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { JsonField } from './json-field';

type Rows = unknown[][];

/** Grid editor for 5etools table rows (strings). Rows with structured cells fall back to JSON. */
@Component({
  selector: 'cn-table-rows',
  imports: [JsonField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (simple()) {
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          @if (labels().length) {
            <thead>
              <tr>
                @for (l of labels(); track $index) {<th class="px-1 text-left text-xs text-muted">{{ l }}</th>}
                <th></th>
              </tr>
            </thead>
          }
          <tbody>
            @for (row of rows(); track $index; let r = $index) {
              <tr>
                @for (cell of row; track $index; let c = $index) {
                  <td class="p-0.5">
                    <input class="w-full rounded border border-line bg-bg px-1.5 py-0.5" [value]="cell" [attr.aria-label]="'Row ' + (r + 1) + ' column ' + (c + 1)" (change)="setCell(r, c, $any($event.target).value)" />
                  </td>
                }
                <td class="w-6"><button type="button" class="text-muted hover:text-accent" (click)="removeRow(r)" [attr.aria-label]="'Remove row ' + (r + 1)">✕</button></td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <div class="mt-1 flex gap-3 text-xs">
        <button type="button" class="text-muted hover:text-accent" (click)="addRow()">+ Row</button>
        <button type="button" class="text-muted hover:text-accent" (click)="addColumn()">+ Column</button>
      </div>
    } @else {
      <cn-json-field [value]="rows()" label="Rows" (changed)="changed.emit($any($event))" />
    }`,
})
export class TableRows {
  readonly rows = input<Rows>([]);
  readonly labels = input<string[]>([]);
  readonly changed = output<Rows>();
  protected readonly simple = computed(() => this.rows().every((r) => Array.isArray(r) && r.every((c) => typeof c === 'string')));
  private width() {
    return Math.max(this.labels().length, ...this.rows().map((r) => r.length), 1);
  }
  protected setCell(r: number, c: number, v: string) {
    this.changed.emit(this.rows().map((row, i) => (i === r ? row.map((cell, j) => (j === c ? v : cell)) : row)));
  }
  protected addRow() {
    this.changed.emit([...this.rows(), Array.from({ length: this.width() }, () => '')]);
  }
  protected addColumn() {
    this.changed.emit(this.rows().map((row) => [...row, '']));
  }
  protected removeRow(r: number) {
    this.changed.emit(this.rows().filter((_, i) => i !== r));
  }
}
