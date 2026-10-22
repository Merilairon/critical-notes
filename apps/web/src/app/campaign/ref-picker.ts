import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import type { EntityDto, SearchHitDto } from '@cn/shared';
import { api } from '../core/api';
import { ContextService } from '../core/context.service';
import { EntityLink } from '../reference/render/entity-link';

let nextListId = 0;

/** Picks a reference entity of one kind (autocomplete within the campaign's rules). */
@Component({
  selector: 'cn-ref-picker',
  imports: [EntityLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="relative">
    @if (value() && !editing()) {
      <div class="flex flex-wrap items-center gap-x-2 rounded-md border border-line bg-bg px-2 py-1.5 text-sm touch:min-h-[44px]">
        @if (current.hasValue()) {
          <cn-entity-link [uid]="current.value().uid" [kind]="kind()">{{ current.value().name }}</cn-entity-link>
          <span class="text-xs text-muted">{{ current.value().source }}</span>
        } @else {
          <span class="text-muted">{{ value() }}</span>
        }
        <button type="button" class="cn-edit-only ml-auto text-xs text-muted hover:text-accent touch:min-h-[44px] touch:px-2 touch:text-sm" (click)="editing.set(true)" [attr.aria-label]="'Change ' + kind()">change</button>
        <button type="button" class="cn-edit-only text-xs text-muted hover:text-accent touch:min-h-[44px] touch:min-w-[44px] touch:text-sm" (click)="selected.emit(null)" [attr.aria-label]="'Clear ' + kind()"><span aria-hidden="true">✕</span></button>
      </div>
    } @else {
      <input
        type="search"
        role="combobox"
        class="cn-input px-2"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        [attr.aria-expanded]="hits().length ? 'true' : 'false'"
        [attr.aria-controls]="hits().length ? listId : null"
        [attr.aria-activedescendant]="hits().length ? listId + '-' + active() : null"
        [attr.aria-label]="placeholder()"
        [placeholder]="placeholder()"
        [value]="query()"
        (input)="onInput($any($event.target).value)"
        (keydown)="onKey($event)"
        (blur)="onBlur()"
      />
      <div class="sr-only" role="status">{{ status() }}</div>
      @if (hits().length) {
        <ul [id]="listId" class="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-line bg-panel py-1 shadow-lg" role="listbox" [attr.aria-label]="placeholder()">
          @for (hit of hits(); track hit.uid; let i = $index) {
            <li
              role="option"
              [id]="listId + '-' + i"
              class="flex w-full cursor-pointer items-baseline gap-2 px-3 py-1 text-left text-sm hover:bg-panel-2 touch:min-h-[44px] touch:items-center"
              [class.bg-panel-2]="i === active()"
              [attr.aria-selected]="i === active()"
              (mousedown)="$event.preventDefault()"
              (click)="pick(hit)"
            >
              <span>{{ hit.name }}</span><span class="text-xs text-muted">{{ hit.source }}</span>
            </li>
          }
        </ul>
      }
    }
  </div>`,
})
export class RefPicker {
  readonly kind = input.required<string>();
  readonly value = input<string | null>(null);
  readonly placeholder = input('Search…');
  readonly selected = output<string | null>();
  private readonly context = inject(ContextService);

  protected readonly editing = signal(false);
  protected readonly query = signal('');
  private readonly debounced = signal('');
  protected readonly active = signal(0);
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly current = httpResource<EntityDto>(() => {
    const uid = this.value();
    return uid ? { url: api.entity(uid), params: this.context.params() } : undefined;
  });
  private readonly results = httpResource<{ hits: SearchHitDto[] }>(() =>
    this.debounced() ? { url: api.autocomplete(this.kind()), params: { ...this.context.params(), q: this.debounced() } } : undefined,
  );
  protected readonly hits = computed(() => (this.debounced() && this.results.hasValue() ? this.results.value().hits : []));
  protected readonly listId = `cn-ref-list-${nextListId++}`;
  /** Read out by screen readers when the results change (live region). */
  protected readonly status = computed(() => {
    if (!this.debounced() || this.results.isLoading()) return '';
    const n = this.hits().length;
    return n ? `${n} ${n === 1 ? 'result' : 'results'}. Use the up and down arrow keys, Enter to choose.` : 'No results';
  });

  protected onInput(v: string) {
    this.query.set(v);
    this.active.set(0);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.debounced.set(v.trim()), 150);
  }

  protected onKey(e: KeyboardEvent) {
    if (e.isComposing || e.keyCode === 229) return; // an IME is choosing a candidate: Enter and arrows are its own
    const hits = this.hits();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.active.update((i) => Math.min(hits.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.active.update((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && hits[this.active()]) {
      e.preventDefault();
      this.pick(hits[this.active()]!);
    } else if (e.key === 'Escape') {
      this.reset();
    }
  }

  protected onBlur() {
    setTimeout(() => this.reset(), 150);
  }

  protected pick(hit: SearchHitDto) {
    this.selected.emit(hit.uid);
    this.reset();
  }

  private reset() {
    this.query.set('');
    this.debounced.set('');
    this.editing.set(false);
  }
}
