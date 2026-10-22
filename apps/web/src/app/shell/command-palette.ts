import { httpResource } from '@angular/common/http';
import type { ElementRef} from '@angular/core';
import { ChangeDetectionStrategy, Component, computed, effect, inject, output, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import type { PageSearchHitDto, SearchHitDto } from '@cn/shared';
// Zod-free entry point: the palette is in the initial bundle
import { PAGE_TYPE_ICONS, PAGE_TYPE_LABELS } from '@cn/shared/page-types';
import { api } from '../core/api';
import { ContextService } from '../core/context.service';
import { kindLabel } from '../reference/kind-labels';

interface PaletteItem {
  key: string;
  heading: string | null;
  page?: PageSearchHitDto;
  ref?: SearchHitDto;
}

/** Ctrl/Cmd+K search: the active campaign's pages (DM text included) and all reference content. */
@Component({
  selector: 'cn-command-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="fixed inset-0 z-60 flex items-start justify-center bg-black/40 p-3 pt-[12vh]" (click)="closed.emit()">
    <div
      class="w-full max-w-xl overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-label="Search"
      (click)="$event.stopPropagation()"
    >
      <input
        #input
        type="search"
        class="w-full border-b border-control bg-transparent px-4 py-3 text-base outline-none"
        [placeholder]="context.campaign() ? 'Search pages, spells, monsters, items…' : 'Search spells, monsters, items, rules…'"
        [value]="text()"
        (input)="onInput($any($event.target).value)"
        (keydown)="onKey($event)"
        aria-controls="cn-palette-results"
      />
      <ul id="cn-palette-results" class="max-h-[55vh] overflow-y-auto py-1" role="listbox">
        @for (item of items(); track item.key; let i = $index) {
          @if (item.heading) {
            <li class="px-4 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted uppercase" role="presentation">{{ item.heading }}</li>
          }
          <li role="option" [attr.aria-selected]="i === active()">
            <button
              type="button"
              class="flex w-full items-baseline gap-2 px-4 py-2 text-left"
              [class.bg-panel-2]="i === active()"
              (mouseenter)="active.set(i)"
              (click)="go(item)"
            >
              @if (item.page; as page) {
                <span class="shrink-0">{{ page.icon || pageIcons[page.type] }}</span>
                <span class="truncate font-medium">{{ page.title }}</span>
                <span class="shrink-0 text-xs text-muted">{{ pageLabels[page.type] }}</span>
                @if (page.snippet) {
                  <span class="truncate text-xs text-muted">{{ page.snippet }}</span>
                }
              } @else if (item.ref; as hit) {
                <span class="truncate font-medium">{{ hit.name }}</span>
                <span class="shrink-0 text-xs text-muted">{{ label(hit.kind) }} · {{ hit.source }}</span>
                @if (hit.badge) {
                  <span class="cn-badge" [class.cn-badge-legacy]="hit.badge === 'legacy'" [class.cn-badge-modern]="hit.badge === 'modern'">{{
                    hit.badge === 'legacy' ? 'Legacy' : '2024'
                  }}</span>
                }
              }
            </button>
          </li>
        } @empty {
          @if (query()) {
            <li class="px-4 py-3 text-sm text-muted">{{ results.isLoading() || pageResults.isLoading() ? 'Searching…' : 'No results' }}</li>
          } @else {
            <li class="px-4 py-3 text-sm text-muted">Type to search. ↑↓ to move, Enter to open, Esc to close.</li>
          }
        }
      </ul>
    </div>
  </div>`,
})
export class CommandPalette {
  readonly closed = output<void>();
  private readonly router = inject(Router);
  protected readonly context = inject(ContextService);
  private readonly inputEl = viewChild.required<ElementRef<HTMLInputElement>>('input');

  protected readonly text = signal('');
  protected readonly query = signal('');
  protected readonly active = signal(0);
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly results = httpResource<{ hits: SearchHitDto[] }>(() =>
    this.query() ? { url: api.search, params: { ...this.context.params(), q: this.query(), limit: 25 } } : undefined,
  );
  protected readonly pageResults = httpResource<{ pages: PageSearchHitDto[] }>(() => {
    const campaign = this.context.campaign();
    return campaign && this.query() ? { url: `/api/campaigns/${campaign.id}/search`, params: { q: this.query(), limit: 8 } } : undefined;
  });
  protected readonly pageIcons = PAGE_TYPE_ICONS;
  protected readonly pageLabels = PAGE_TYPE_LABELS;

  protected readonly items = computed<PaletteItem[]>(() => {
    if (!this.query()) return [];
    const pages = this.context.campaign() && this.pageResults.hasValue() ? this.pageResults.value().pages : [];
    const refs = this.results.hasValue() ? this.results.value().hits : [];
    const out: PaletteItem[] = pages.map((page, i) => ({ key: `p:${page.pageId}`, heading: i === 0 ? 'Campaign pages' : null, page }));
    refs.forEach((ref, i) => out.push({ key: `r:${ref.uid}`, heading: i === 0 && pages.length ? 'Reference' : null, ref }));
    return out;
  });

  constructor() {
    effect(() => this.inputEl().nativeElement.focus());
    effect(() => {
      this.items();
      this.active.set(0);
    });
  }

  protected onInput(value: string) {
    this.text.set(value);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.query.set(value.trim()), 150);
  }

  protected onKey(event: KeyboardEvent) {
    const hits = this.items();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closed.emit();
    }
    else if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.active.update((i) => Math.min(hits.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.active.update((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter' && hits[this.active()]) {
      this.go(hits[this.active()]!);
    }
  }

  protected go(item: PaletteItem) {
    this.closed.emit();
    const campaign = this.context.campaign();
    if (item.page && campaign) this.router.navigate(['/c', campaign.id, 'p', item.page.pageId]);
    else if (item.ref) this.router.navigate([...this.context.referenceBase(), item.ref.kind, item.ref.uid]);
  }

  protected label(kind: string) {
    return kindLabel(kind, this.context.ruleset());
  }
}
