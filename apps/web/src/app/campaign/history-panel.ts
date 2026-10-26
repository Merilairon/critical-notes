import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { afterNextRender, ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, Injector, input, output, signal, untracked, viewChild } from '@angular/core';
import { docText, type BlockDocument } from '@cn/blocks';
import { FACET_FIELDS, facetTypeFor, PAGE_TYPE_LABELS, type PageDto, type PageType } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../core/http.interceptor';
import { CampaignStore } from './campaign.store';
import { collapse, diffDegrades, diffFields, diffLines, summarize, summaryText, type DiffItem } from './history-diff';

/** One row of `GET .../history` (a revision without content). */
export interface HistoryItem {
  revision: number;
  createdAt: number;
  author: { id: string; displayName: string } | null;
  source: 'web' | 'player' | 'mcp' | 'system';
  tokenName: string | null;
  cause: string;
  restoredFrom: number | null;
  title: string;
  bytes: number;
}

/** `GET .../history/:rev`: a row plus its content. */
export interface HistoryDetail extends HistoryItem {
  type: string;
  body: unknown;
  details: Record<string, unknown> | null;
  properties: Record<string, unknown>;
}

interface RestoreResult {
  page: PageDto;
  restored: boolean;
  warnings: string[];
}

/** What the panel needs from the editor before a restore: pending edits saved, and the page revision after that. */
export interface HistoryPrepared {
  ok: boolean;
  revision: number;
}

interface Row {
  item: HistoryItem;
  current: boolean;
  who: string;
  when: string;
  iso: string;
  cause: string;
  size: string;
  renamedFrom: string | null;
}

const PAGE_SIZE = 50;
const SCOPE = 'Restoring brings back the title, type, text, details and properties. Visibility, who can see it, position, tags, icon, cover and which player owns a character stay as they are.';

const CAUSES: Record<string, string> = {
  create: 'Created',
  template_sync: 'Template sync',
  template_apply: 'Template applied',
  edition_migration: 'Edition migration',
  import: 'Imported',
  tracker: 'Combat update',
  baseline: 'Earlier version',
};

const pad = (n: number) => String(n).padStart(2, '0');
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** `Today 14:32`, `Yesterday 21:40`, otherwise the date with the time. */
export function whenText(ms: number, now = new Date()): string {
  const d = new Date(ms);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, now)) return `Today ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} ${time}`;
}

export function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Who made a version, from its source (design section 2). */
export function whoText(item: HistoryItem): string {
  if (item.source === 'system') return 'Earlier version (before history started)';
  const name = item.author ? item.author.displayName : 'Deleted user';
  if (item.source === 'player') return `${name} (player)`;
  if (item.source === 'mcp') return `${name} via AI assistant (${item.tokenName ?? 'deleted token'})`;
  return name;
}

function causeText(item: HistoryItem): string {
  if (item.cause === 'restore') return `Restored from version ${item.restoredFrom ?? '?'}`;
  return CAUSES[item.cause] ?? '';
}

/**
 * Version history of one page: compare two versions and restore one (task N1.4; docs/design/history-ui.md). GM only: the editor
 * does not render it for players, and the server refuses them regardless. Snapshots (DM-only content included) live in this
 * component's memory only and go away when it closes.
 */
@Component({
  selector: 'cn-history-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './history-panel.html',
})
export class HistoryPanel {
  /** The editor's page (its saved state; the compare-with-current side). */
  readonly page = input.required<PageDto>();
  /** Bumps after each editor save: the first page of the list reloads quietly. */
  readonly refresh = input(0);
  /** Saves pending edits and reports the page revision to restore over. */
  readonly prepare = input.required<() => Promise<HistoryPrepared>>();
  /**
   * Hands the editor the page a restore produced (`restored`) or the newer page after a 409 (`stale`). Returns whether the editor
   * took it: it refuses while it holds typing that is not saved yet, and the panel then says so instead of offering an Undo.
   */
  readonly adopt = input.required<(page: PageDto, why: 'restored' | 'stale') => boolean>();
  /** True from the moment a restore starts writing until it ends: the editor holds back its autosave meanwhile. */
  readonly busy = output<boolean>();
  readonly closed = output<void>();

  private readonly http = inject(HttpClient);
  private readonly store = inject(CampaignStore);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');

  protected readonly scope = SCOPE;
  protected readonly items = signal<HistoryItem[]>([]);
  protected readonly loading = signal(true);
  protected readonly retrying = signal(false);
  protected readonly loadingMore = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly unavailable = signal(false);
  /** True once the oldest version is on screen. */
  protected readonly done = signal(false);
  protected readonly selected = signal<number[]>([]);
  protected readonly status = signal('');
  protected readonly alert = signal('');
  protected readonly warnings = signal<string[]>([]);
  protected readonly undoTarget = signal<number | null>(null);
  protected readonly busyRev = signal<number | null>(null);
  protected readonly busyUndo = signal(false);
  protected readonly expanded = signal<ReadonlySet<number>>(new Set());

  private readonly cache = signal<ReadonlyMap<number, HistoryDetail>>(new Map());
  protected readonly detailLoading = signal(false);
  protected readonly detailError = signal<{ rev: number; text: string } | null>(null);
  /** The newest revision seen in the last list or head fetch (the current page's version number in the compare heading). */
  private readonly newestKnown = signal<number | null>(null);
  private readonly pageId = computed(() => this.page().id);
  private generation = 0;
  private lastPageId = '';

  constructor() {
    // First load, then a quiet reload after every editor save. Async work runs untracked.
    effect(() => {
      this.refresh();
      const pageId = this.pageId();
      untracked(() => {
        if (this.lastPageId && this.lastPageId !== pageId) {
          this.cache.set(new Map());
          this.selected.set([]);
          this.items.set([]);
          this.newestKnown.set(null);
          this.done.set(false);
          this.clearResult();
        }
        void this.loadFirst(this.loading() || this.lastPageId !== pageId).finally(() => (this.lastPageId = pageId));
      });
    });
    afterNextRender(() => {
      const h = this.heading().nativeElement;
      h.focus();
      h.scrollIntoView?.({ block: 'nearest' });
    });
  }

  private url(path = '') {
    return `/api/campaigns/${this.store.id()}/pages/${this.page().id}/history${path}`;
  }

  private focusAfterRender(fn: () => HTMLElement | null | undefined) {
    afterNextRender(() => fn()?.focus(), { injector: this.injector });
  }

  // region list

  protected readonly rows = computed<Row[]>(() => {
    const list = this.items();
    return list.map((item, i) => {
      const below = list[i + 1];
      return {
        item,
        current: i === 0,
        who: whoText(item),
        when: whenText(item.createdAt),
        iso: new Date(item.createdAt).toISOString(),
        cause: causeText(item),
        size: sizeText(item.bytes),
        renamedFrom: below && below.title !== item.title ? below.title : null,
      };
    });
  });

  protected readonly oldest = computed(() => this.items().at(-1)?.revision ?? null);

  /** Reloads the first page. `quiet` keeps what is on screen (no loading state); ticks are kept by revision where the row still exists. */
  protected async loadFirst(initial: boolean) {
    const gen = ++this.generation;
    if (initial) {
      this.loading.set(true);
      this.status.set('Loading history…');
    }
    this.loadError.set(null);
    this.unavailable.set(false);
    try {
      const res = await firstValueFrom(this.http.get<{ items: HistoryItem[] }>(this.url(`?limit=${PAGE_SIZE}`)));
      if (gen !== this.generation) return;
      const first = res.items;
      const lowest = first.at(-1)?.revision;
      // Older pages loaded earlier stay when the first page is full (they lie below it)
      const older = first.length === PAGE_SIZE && lowest !== undefined ? this.items().filter((i) => i.revision < lowest) : [];
      const merged = [...first, ...older];
      this.items.set(merged);
      this.newestKnown.set(first[0]?.revision ?? null);
      if (first.length < PAGE_SIZE) this.done.set(true);
      else if (!older.length) this.done.set(false);
      const have = new Set(merged.map((i) => i.revision));
      this.selected.update((s) => s.filter((r) => have.has(r)));
      if (initial) this.status.set('');
    } catch (err) {
      if (gen !== this.generation) return;
      this.loadError.set(errorMessage(err));
      this.unavailable.set(err instanceof HttpErrorResponse && (err.status === 403 || err.status === 404));
      if (initial) this.status.set('');
    } finally {
      if (gen === this.generation) {
        if (this.status() === 'Loading history…') this.status.set('');
        this.loading.set(false);
        this.retrying.set(false);
      }
    }
  }

  protected async retry() {
    if (this.retrying()) return;
    this.retrying.set(true);
    await this.loadFirst(false);
    if (this.loadError()) this.focusAfterRender(() => this.host.nativeElement.querySelector<HTMLElement>('[data-action="retry"]'));
  }

  protected async loadOlder() {
    const before = this.oldest();
    if (this.loadingMore() || before === null) return;
    this.loadingMore.set(true);
    this.alert.set('');
    const pid = this.pageId();
    try {
      const res = await firstValueFrom(this.http.get<{ items: HistoryItem[] }>(this.url(`?before=${before}&limit=${PAGE_SIZE}`)));
      if (pid !== this.pageId()) return;
      const have = new Set(this.items().map((i) => i.revision));
      const fresh = res.items.filter((i) => !have.has(i.revision));
      this.items.update((l) => [...l, ...fresh]);
      if (res.items.length < PAGE_SIZE) this.done.set(true);
      this.status.set(`${fresh.length} older ${fresh.length === 1 ? 'version' : 'versions'} loaded`);
      const firstNew = fresh[0]?.revision;
      if (firstNew !== undefined) this.focusAfterRender(() => this.host.nativeElement.querySelector<HTMLElement>(`[data-rev="${firstNew}"]`));
    } catch (err) {
      if (pid !== this.pageId()) return;
      this.alert.set(`Could not load older versions: ${errorMessage(err)}`);
    } finally {
      this.loadingMore.set(false);
    }
  }

  // endregion
  // region compare

  protected readonly full = computed(() => this.selected().length >= 2);

  protected toggle(rev: number, event: Event) {
    const s = this.selected();
    if (!s.includes(rev) && s.length >= 2) {
      event.preventDefault();
      return;
    }
    this.selected.set(s.includes(rev) ? s.filter((r) => r !== rev) : [...s, rev]);
    this.expanded.set(new Set());
    this.detailError.set(null);
    if (!s.includes(rev)) void this.ensure(rev);
  }

  private async ensure(rev: number) {
    if (this.cache().has(rev)) return;
    this.detailLoading.set(true);
    this.detailError.set(null);
    const pid = this.pageId();
    try {
      const d = await firstValueFrom(this.http.get<HistoryDetail>(this.url(`/${rev}`)));
      if (pid !== this.pageId()) return;
      this.cache.update((m) => new Map(m).set(rev, d));
    } catch (err) {
      // A late failure for a version that was unticked meanwhile, or for another page, is not news
      if (pid !== this.pageId() || !this.selected().includes(rev)) return;
      const gone = err instanceof HttpErrorResponse && err.status === 404;
      this.detailError.set({ rev, text: gone ? `Version ${rev} no longer exists.` : `Could not load version ${rev}.` });
      if (gone) {
        this.selected.update((s) => s.filter((r) => r !== rev));
        void this.loadFirst(false);
      }
    } finally {
      this.detailLoading.set(false);
    }
  }

  protected retryDetail() {
    const e = this.detailError();
    if (e) void this.ensure(e.rev);
  }

  /** The two sides in older-to-newer order; the current page stands in as the newer side when only one is ticked. */
  private readonly sides = computed(() => {
    const s = [...this.selected()].sort((a, b) => a - b);
    if (!s.length) return null;
    const cache = this.cache();
    const p = this.page();
    const current: HistoryDetail = {
      revision: this.newestKnown() ?? this.items()[0]?.revision ?? p.revision,
      createdAt: p.createdAt,
      author: null,
      source: 'web',
      tokenName: null,
      cause: 'edit',
      restoredFrom: null,
      title: p.title,
      bytes: 0,
      type: p.type,
      body: p.body,
      details: p.facet,
      properties: p.props,
    };
    const from = cache.get(s[0]);
    const to = s.length === 2 ? cache.get(s[1]) : current;
    return from && to ? { from, to } : null;
  });

  protected readonly heading2 = computed(() => {
    const s = this.sides();
    return s ? `Changes from version ${s.from.revision} to version ${s.to.revision}` : '';
  });

  private readonly texts = computed(() => {
    const s = this.sides();
    return s ? { from: docText(s.from.body as BlockDocument | null, 'dm'), to: docText(s.to.body as BlockDocument | null, 'dm') } : null;
  });
  private readonly lines = computed(() => {
    const x = this.texts();
    return x ? diffLines(x.from, x.to) : [];
  });
  protected readonly degraded = computed(() => {
    const x = this.texts();
    return !!x && diffDegrades(x.from, x.to);
  });

  protected readonly summary = computed(() => summaryText(summarize(this.lines())));
  protected readonly diffItems = computed<DiffItem[]>(() => collapse(this.lines(), this.expanded()));

  protected readonly otherChanges = computed(() => {
    const s = this.sides();
    if (!s) return [];
    const facetLabel = (key: string) => {
      for (const d of [s.to, s.from]) {
        const ft = facetTypeFor(d.type as PageType);
        const f = ft ? FACET_FIELDS[ft].find((x) => x.key === key) : undefined;
        if (f) return f.label;
      }
      return undefined;
    };
    const defs = this.store.propertyDefs();
    return diffFields(s.from, s.to, {
      type: (t) => PAGE_TYPE_LABELS[t as PageType] ?? t,
      details: facetLabel,
      property: (key) => defs.find((d) => d.key === key)?.label,
    });
  });

  protected readonly identical = computed(() => !!this.sides() && !this.lines().some((l) => l.kind !== 'equal') && !this.otherChanges().length);
  protected readonly compareLoading = computed(() => this.selected().length > 0 && !this.sides() && !this.detailError());

  protected expand(id: number) {
    this.expanded.update((s) => new Set(s).add(id));
    this.focusAfterRender(() => this.host.nativeElement.querySelector<HTMLElement>('[data-diff]'));
  }

  // endregion
  // region restore

  private clearResult() {
    this.status.set('');
    this.alert.set('');
    this.warnings.set([]);
    this.undoTarget.set(null);
  }

  protected restoreLabel(rev: number) {
    return this.busyRev() === rev ? 'Restoring…' : 'Restore';
  }

  protected async restore(rev: number, event?: Event) {
    if (this.busyRev() !== null || this.busyUndo()) return;
    const pressed = event?.currentTarget as HTMLElement | undefined;
    this.clearResult();
    this.busyRev.set(rev);
    try {
      await this.run(rev, pressed, false);
    } finally {
      this.busyRev.set(null);
    }
  }

  protected async undo() {
    const target = this.undoTarget();
    if (target === null || this.busyRev() !== null || this.busyUndo()) return;
    this.clearResult();
    this.busyUndo.set(true);
    try {
      await this.run(target, undefined, true);
    } finally {
      this.busyUndo.set(false);
    }
  }

  private async run(rev: number, pressed: HTMLElement | undefined, isUndo: boolean) {
    const prepared = await this.prepare()();
    if (!prepared.ok) {
      this.alert.set('Resolve the save problem on the page first.');
      return;
    }
    const before = prepared.revision;
    this.busy.emit(true);
    try {
      // Flushing pending edits can add, or fold into, a history row. The version to go back to is the newest row as the server has it
      // now, fetched here on its own: the shared list may be mid-reload (the editor's save bumps `refresh`) and superseded.
      // The page revision can be higher than the newest row because saves that change nothing add no row. No answer: no Undo.
      const newest = await this.fetchNewest();
      const out = await firstValueFrom(this.http.post<RestoreResult>(this.url(`/${rev}/restore`), { revision: before }));
      const applied = this.adopt()(out.page, 'restored');
      this.warnings.set(out.warnings);
      if (!applied) {
        this.status.set(
          out.restored
            ? `Version ${rev} was restored. Your unsaved typing was kept and was not saved. Reload the page to see the restored version (this discards the typing).`
            : `Version ${rev} already matches the saved page, so nothing changed. Your unsaved typing was kept.`,
        );
      } else if (out.restored) {
        this.status.set(
          isUndo
            ? `Undone. The page is back to version ${rev}. Saved as version ${out.page.revision}.`
            : `Restored version ${rev}. Saved as version ${out.page.revision}. Visibility, tags and other settings were not changed.`,
        );
        this.undoTarget.set(isUndo ? null : newest);
        this.selected.set([]);
      } else {
        this.status.set(`Version ${rev} already matches the current page, so nothing changed.`);
      }
      await this.loadFirst(false);
      this.focusAfterRender(() => this.heading().nativeElement);
    } catch (err) {
      await this.fail(err, rev, pressed);
    } finally {
      this.busy.emit(false);
    }
  }

  /** The newest revision number from a fresh `limit=1` request, or null when it could not be read. */
  private async fetchNewest(): Promise<number | null> {
    try {
      const res = await firstValueFrom(this.http.get<{ items: HistoryItem[] }>(this.url('?limit=1')));
      const n = res.items[0]?.revision ?? null;
      if (n !== null) this.newestKnown.set(n);
      return n;
    } catch {
      return null;
    }
  }

  private async fail(err: unknown, rev: number, pressed: HTMLElement | undefined) {
    const status = err instanceof HttpErrorResponse ? err.status : 0;
    if (status === 409) {
      const body = (err as HttpErrorResponse).error as { details?: { current?: PageDto } } | null;
      let current = body?.details?.current;
      if (!current) {
        try {
          current = await firstValueFrom(this.http.get<PageDto>(`/api/campaigns/${this.store.id()}/pages/${this.page().id}`));
        } catch {
          current = undefined;
        }
      }
      const applied = current ? this.adopt()(current, 'stale') : true;
      this.alert.set(
        applied
          ? `This page was changed by someone else just now. The newest version is loaded. Review it and press Restore again if you still want version ${rev}.`
          : 'This page was changed by someone else just now. Your unsaved typing was kept and was not saved. Reload the page to see the newest version (this discards the typing).',
      );
      if (!this.selected().includes(rev)) {
        this.selected.set([rev]);
        void this.ensure(rev);
      }
      await this.loadFirst(false);
    } else {
      this.alert.set(errorMessage(err));
      if (status === 404) {
        this.selected.update((s) => s.filter((r) => r !== rev));
        await this.loadFirst(false);
      }
    }
    this.focusAfterRender(() => (pressed?.isConnected ? pressed : this.host.nativeElement.querySelector<HTMLElement>(`[data-restore="${rev}"]`)));
  }

  protected dismissWarnings() {
    this.warnings.set([]);
    this.focusAfterRender(() => this.heading().nativeElement);
  }

  // endregion

  protected close() {
    this.cache.set(new Map());
    this.closed.emit();
  }
}
