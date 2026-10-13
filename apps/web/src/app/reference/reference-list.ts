import { ScrollingModule } from '@angular/cdk/scrolling';
import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { EntityDto, ListItemDto } from '@cn/shared';
import { map } from 'rxjs';
import { api } from '../core/api';
import { ContextService } from '../core/context.service';
import { EntityView } from './entity-view';
import { kindLabel } from './kind-labels';
import { applyFilters, filterOptions, filtersFor, parseFilterParams, sortItems, type FilterDef, type SortKey } from './list-filters';

interface Column {
  label: string;
  sort?: SortKey;
  value: (i: ListItemDto) => string;
  width: string;
}

const COLUMNS: Record<string, Column[]> = {
  monster: [
    { label: 'CR', sort: 'cr', value: (i) => String(i.summary['cr'] ?? '—'), width: '3.5rem' },
    { label: 'Type', value: (i) => String(i.summary['type'] ?? ''), width: '8rem' },
  ],
  spell: [
    { label: 'Level', sort: 'level', value: (i) => (i.summary['level'] === 0 ? 'Cantrip' : String(i.summary['level'] ?? '')), width: '4.5rem' },
    { label: 'School', value: (i) => String(i.summary['school'] ?? ''), width: '7rem' },
  ],
  item: [{ label: 'Rarity', sort: 'rarity', value: (i) => String(i.summary['rarity'] ?? ''), width: '7rem' }],
};

@Component({
  selector: 'cn-reference-list',
  imports: [ScrollingModule, RouterLink, EntityView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './reference-list.html',
  host: { class: 'flex min-h-0 flex-1' },
})
export class ReferenceList {
  readonly kind = input.required<string>();
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly title = inject(Title);
  protected readonly context = inject(ContextService);

  private readonly queryParams = toSignal(this.route.queryParamMap.pipe(map((p) => Object.fromEntries(p.keys.map((k) => [k, p.get(k) ?? ''])))), {
    initialValue: {} as Record<string, string>,
  });

  protected readonly label = computed(() => kindLabel(this.kind(), this.context.ruleset(), true));
  protected readonly items = httpResource<{ items: ListItemDto[] }>(() => ({ url: api.list(this.kind()), params: this.context.params() }));
  protected readonly all = computed(() => (this.items.hasValue() ? this.items.value().items : []));

  protected readonly filterDefs = computed(() => filtersFor(this.kind()));
  protected readonly active = computed(() => parseFilterParams(this.queryParams(), this.filterDefs()));
  protected readonly query = signal('');
  protected readonly sortKey = signal<SortKey>('name');
  protected readonly sortDir = signal<1 | -1>(1);

  protected readonly filtered = computed(() =>
    sortItems(applyFilters(this.all(), this.filterDefs(), this.active(), this.query()), this.sortKey(), this.sortDir()),
  );
  protected readonly anyActive = computed(() => Object.values(this.active()).some((v) => v.size > 0));
  protected readonly columns = computed(() => COLUMNS[this.kind()] ?? []);
  protected readonly trackUid = (_: number, item: ListItemDto) => item.uid;
  protected readonly gridTemplate = computed(() => `minmax(0,1fr) ${this.columns().map((c) => c.width).join(' ')} 4.5rem`);

  protected readonly selectedUid = computed(() => this.queryParams()['e'] || null);
  protected readonly selected = httpResource<EntityDto>(() => {
    const uid = this.selectedUid();
    return uid ? { url: api.entity(uid), params: this.context.params() } : undefined;
  });

  private readonly wide = signal(globalThis.matchMedia?.('(min-width: 1024px)').matches ?? true);

  constructor() {
    globalThis.matchMedia?.('(min-width: 1024px)').addEventListener?.('change', (e) => this.wide.set(e.matches));
    effect(() => this.title.setTitle(`${this.label()} — Critical Notes`));
    // Keep the search text in sync with ?q= (e.g. when navigating from a {@filter} link)
    effect(() => {
      const q = this.queryParams()['q'] ?? '';
      untracked(() => this.query.set(q));
    });
  }

  protected options(def: FilterDef) {
    return filterOptions(this.all(), def);
  }

  protected isActive(def: FilterDef, value: string): boolean {
    return !!this.active()[def.key]?.has(value);
  }

  protected activeCount(def: FilterDef): number {
    return this.active()[def.key]?.size ?? 0;
  }

  protected toggle(def: FilterDef, value: string) {
    const current = new Set(this.active()[def.key] ?? []);
    if (current.has(value)) current.delete(value);
    else current.add(value);
    this.setParam(def.key, current.size ? [...current].join(',') : null);
  }

  protected clearFilters() {
    const params: Record<string, null> = {};
    for (const def of this.filterDefs()) params[def.key] = null;
    this.router.navigate([], { queryParams: { ...params, q: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected onSearch(value: string) {
    this.query.set(value);
    this.setParam('q', value || null);
  }

  protected setSort(key: SortKey) {
    if (this.sortKey() === key) this.sortDir.update((d) => (d === 1 ? -1 : 1));
    else {
      this.sortKey.set(key);
      this.sortDir.set(1);
    }
  }

  protected open(item: ListItemDto) {
    if (this.wide()) this.setParam('e', item.uid);
    else this.router.navigate([...this.context.referenceBase(), this.kind(), item.uid]);
  }

  protected onKey(event: KeyboardEvent) {
    const list = this.filtered();
    if (!list.length) return;
    const ix = list.findIndex((i) => i.uid === this.selectedUid());
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = list[Math.max(0, Math.min(list.length - 1, ix + (event.key === 'ArrowDown' ? 1 : -1)))]!;
      this.setParam('e', next.uid);
    } else if (event.key === 'Enter' && ix >= 0) {
      this.router.navigate([...this.context.referenceBase(), this.kind(), list[ix]!.uid]);
    }
  }

  private setParam(key: string, value: string | null) {
    this.router.navigate([], { queryParams: { [key]: value }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected badgeLabel(badge: string | null): string | null {
    return badge === 'legacy' ? 'Legacy' : badge === 'modern' ? '2024' : null;
  }
}
