import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, InjectionToken, signal } from '@angular/core';
import type { BlockRevealedEvent, PageDto, PageSharedEvent } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { CampaignStore } from '../campaign.store';
import { CampaignEventStream, type StreamState } from './event-stream';

/** Fetch used by the event stream; tests replace it. */
export const LIVE_FETCH = new InjectionToken<typeof fetch>('LIVE_FETCH', { providedIn: 'root', factory: () => (...args) => globalThis.fetch(...args) });

/** Several toasts inside this window become one ("{n} new things"). */
export const COLLAPSE_MS = 3000;
export const TOAST_MS = 8000;
/** A "New" page badge or block highlight clears after this long in view. */
export const SEEN_MS = 2000;
/** Players refetch after a random 0..JITTER_MS so a table of phones does not hit the server in one beat. */
export const JITTER_MS = 300;
/** After a reconnect refetch, wait this long for replayed events before summarising what is left over. */
export const GRACE_MS = 1500;
const TITLE_MAX = 40;
const GM_REFRESH_MS = 300;

export type LiveItemKind = 'shared' | 'private' | 'details-here' | 'details-there';
export interface LiveItem {
  kind: LiveItemKind;
  pageId: string;
  title: string;
}
export interface LiveToast {
  /** Changes on every update of the toast (restarts its timer). */
  seq: number;
  /** Identifies the card: kept when more items merge into it, new when a fresh toast replaces it. */
  id: number;
  items: LiveItem[];
  /** After a resync: number of new pages (the items are those pages). */
  summary: number | null;
  /** The open page changed while the player was editing: offer Reload instead of overwriting. */
  reload: boolean;
}

/** The page editor registers itself so the stream can refresh the open page without knowing the editor. */
export interface OpenPage {
  id: string;
  /** Unsaved or saving edits: the page must not be overwritten. */
  isDirty(): boolean;
  apply(page: PageDto): void;
  reload(): void;
}

function clip(title: string): string {
  const t = title.trim() || 'Untitled';
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** The toast sentence (docs/design/reveal.md 9.1). Titles are plain text, never an excerpt. */
export function toastText(t: LiveToast): string {
  if (t.summary != null) return t.summary === 1 ? 'You have 1 new page' : `You have ${t.summary} new pages`;
  const first = t.items[0];
  if (!first) return '';
  if (t.items.length > 1) return `${t.items.length} new things: ${clip(first.title)} and ${t.items.length - 1} more`;
  switch (first.kind) {
    case 'shared':
      return `New: ${clip(first.title)}`;
    case 'private':
      return `Just for you: ${clip(first.title)}`;
    case 'details-here':
      return 'New details on this page';
    case 'details-there':
      return `New on ${clip(first.title)}`;
  }
}

export type ToastAction = 'open' | 'show' | 'reload' | 'view';
export function toastAction(t: LiveToast): ToastAction {
  if (t.summary != null || t.items.length > 1) return 'view';
  if (t.reload) return 'reload';
  return t.items[0]?.kind === 'details-here' ? 'show' : 'open';
}

function collectIds(node: unknown, out: Set<string>) {
  if (!node || typeof node !== 'object') return;
  const n = node as { attrs?: { id?: unknown }; content?: unknown };
  if (typeof n.attrs?.id === 'string') out.add(n.attrs.id);
  if (Array.isArray(n.content)) for (const c of n.content) collectIds(c, out);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Persisted {
  pages: string[];
  blocks: Record<string, readonly string[]>;
}

/**
 * Live updates for one campaign (task N3.4): owns the event stream, turns events into toasts and "New" markers for players,
 * refreshes the open page, and keeps the page tree fresh. Events are only pointers: everything shown comes from a
 * refetch through the normal projected API, and a toast appears only after that refetch succeeded.
 * One client rule: after every (re)connect refetch what is on screen; replayed events only add toasts.
 * Game masters get the stream but only refetch the page tree (no toasts, no overwrite of the editor).
 */
@Injectable()
export class LiveService {
  private readonly http = inject(HttpClient);
  private readonly store = inject(CampaignStore);
  private readonly fetchFn = inject(LIVE_FETCH);

  readonly state = signal<StreamState>('idle');
  readonly paused = computed(() => this.state() === 'paused');
  readonly toast = signal<LiveToast | null>(null);
  readonly viewOpen = signal(false);
  /** Pages with a "New" pill (tree and page header). */
  readonly newPages = signal<ReadonlySet<string>>(new Set());
  /** Block ids to highlight, per page. */
  readonly newBlocks = signal<Readonly<Record<string, readonly string[]>>>({});

  private stream: CampaignEventStream | null = null;
  private cid: string | null = null;
  private gen = 0;
  private seq = 0;
  private groupAt = 0;
  private open: OpenPage | null = null;
  private known: Set<string> | null = null;
  private toasted = new Set<string>();
  private syncing = false;
  private syncAgain = false;
  private gmTimer: ReturnType<typeof setTimeout> | undefined;
  private seenTimer: ReturnType<typeof setTimeout> | undefined;
  private seenCleanup: (() => void) | undefined;

  isNew(pageId: string): boolean {
    return this.newPages().has(pageId);
  }

  start(campaignId: string) {
    // The page editor may have registered before the stream (re)started: keep it
    const open = this.open;
    this.stop();
    this.open = open;
    this.cid = campaignId;
    const gen = ++this.gen;
    this.restore();
    this.stream = new CampaignEventStream(
      `/api/campaigns/${encodeURIComponent(campaignId)}/events`,
      {
        onHello: () => void this.sync(gen),
        onShared: (e) => void this.onShared(e, gen),
        onRevealed: (e) => void this.onRevealed(e, gen),
        onResync: () => void this.sync(gen),
        onState: (s) => this.state.set(s),
        onPoll: () => void this.sync(gen),
      },
      { fetchFn: this.fetchFn },
    );
    this.stream.start();
  }

  stop() {
    this.gen++;
    this.stream?.stop();
    this.stream = null;
    this.cid = null;
    this.open = null;
    this.known = null;
    this.toasted.clear();
    this.syncing = false;
    this.syncAgain = false;
    clearTimeout(this.gmTimer);
    this.cancelSeen();
    this.toast.set(null);
    this.viewOpen.set(false);
    this.state.set('idle');
  }

  resume() {
    this.stream?.resume();
  }

  // ---- the open page ----

  registerOpen(handle: OpenPage) {
    this.open = handle;
    this.cancelSeen();
    if (!this.isNew(handle.id)) return;
    // The page badge clears once the page has been open and visible for SEEN_MS
    const arm = () => {
      this.seenTimer = setTimeout(() => this.clearPage(handle.id), SEEN_MS);
    };
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') arm();
    else {
      const onVisible = () => {
        if (document.visibilityState === 'hidden') return;
        document.removeEventListener('visibilitychange', onVisible);
        arm();
      };
      document.addEventListener('visibilitychange', onVisible);
      this.seenCleanup = () => document.removeEventListener('visibilitychange', onVisible);
    }
  }

  unregisterOpen(pageId: string) {
    if (this.open?.id !== pageId) return;
    this.open = null;
    this.cancelSeen();
    // Highlighted blocks do not outlive the visit
    this.clearBlocks(pageId);
  }

  private cancelSeen() {
    clearTimeout(this.seenTimer);
    this.seenCleanup?.();
    this.seenCleanup = undefined;
  }

  clearPage(pageId: string) {
    if (!this.newPages().has(pageId)) return;
    this.newPages.update((s) => new Set([...s].filter((id) => id !== pageId)));
    this.persist();
  }

  /** Clears the highlight of the given blocks (all of the page's when `ids` is omitted). */
  clearBlocks(pageId: string, ids?: readonly string[]) {
    const have = this.newBlocks()[pageId];
    if (!have) return;
    const left = ids ? have.filter((b) => !ids.includes(b)) : [];
    if (left.length === have.length) return;
    this.newBlocks.update((m) => {
      const next = { ...m };
      if (left.length) next[pageId] = left;
      else delete next[pageId];
      return next;
    });
    this.persist();
  }

  // ---- stream handlers ----

  private current(gen: number) {
    return gen === this.gen && this.cid !== null;
  }

  private base() {
    return `/api/campaigns/${this.cid}`;
  }

  private fetchPage(id: string) {
    return firstValueFrom(this.http.get<PageDto>(`${this.base()}/pages/${encodeURIComponent(id)}`));
  }

  /** Refetch what is on screen: the page tree and the open page. Runs after every (re)connect and on each poll. */
  private async sync(gen: number): Promise<void> {
    if (!this.current(gen)) return;
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    this.syncing = true;
    try {
      const before = this.known;
      try {
        await this.store.reloadPages();
      } catch {
        return;
      }
      if (!this.current(gen)) return;
      const ids = new Set(this.store.pages().map((p) => p.id));
      this.known = ids;
      this.prune(ids);
      if (this.store.isGm()) return;
      await this.refetchOpen(gen);
      if (!before) return; // first connect: nothing to compare with, no toast
      await sleep(GRACE_MS);
      if (!this.current(gen)) return;
      const fresh = this.store.pages().filter((p) => !before.has(p.id) && !this.toasted.has(p.id));
      for (const p of fresh) this.toasted.add(p.id);
      this.markNew(fresh.map((p) => p.id));
      if (fresh.length) {
        this.push({ seq: ++this.seq, id: this.seq, summary: fresh.length, reload: false, items: fresh.map((p) => ({ kind: 'shared', pageId: p.id, title: p.title })) }, true);
      }
    } finally {
      this.syncing = false;
      if (this.syncAgain) {
        this.syncAgain = false;
        void this.sync(gen);
      }
    }
  }

  /** The open page after a reconnect: apply silently unless the player is mid-edit (then the next event or Reload handles it). */
  private async refetchOpen(gen: number) {
    const open = this.open;
    if (!open) return;
    try {
      const page = await this.fetchPage(open.id);
      if (this.current(gen) && this.open === open && !open.isDirty()) open.apply(page);
    } catch {
      /* gone or unreachable: the next navigation finds out */
    }
  }

  private async onShared(e: PageSharedEvent, gen: number) {
    if (!this.current(gen)) return;
    if (this.store.isGm()) return this.refreshTreeLater(gen);
    await sleep(Math.random() * JITTER_MS);
    if (!this.current(gen)) return;
    try {
      const [page] = await Promise.all([this.fetchPage(e.pageId), this.store.reloadPages()]);
      if (!this.current(gen)) return;
      this.known?.add(page.id);
      this.toasted.add(page.id);
      this.markNew([page.id]);
      this.add({ kind: page.visibility === 'selected' ? 'private' : 'shared', pageId: page.id, title: page.title });
    } catch {
      /* 404: no longer visible, so nothing to announce */
    }
  }

  private async onRevealed(e: BlockRevealedEvent, gen: number) {
    if (!this.current(gen)) return;
    if (this.store.isGm()) return this.refreshTreeLater(gen);
    await sleep(Math.random() * JITTER_MS);
    if (!this.current(gen)) return;
    let page: PageDto;
    try {
      page = await this.fetchPage(e.pageId);
    } catch {
      return;
    }
    if (!this.current(gen)) return;
    // Highlights come from the fetched document, so they can never point at a block the player does not have
    const present = new Set<string>();
    collectIds(page.body, present);
    const ids = e.blockIds.filter((b) => present.has(b));
    if (!ids.length) return;
    const open = this.open?.id === page.id ? this.open : null;
    const dirty = !!open?.isDirty();
    if (open && !dirty) open.apply(page);
    this.newBlocks.update((m) => ({ ...m, [page.id]: [...new Set([...(m[page.id] ?? []), ...ids])] }));
    if (!open) this.markNew([page.id]);
    this.persist();
    this.add({ kind: open ? 'details-here' : 'details-there', pageId: page.id, title: page.title }, dirty);
  }

  private refreshTreeLater(gen: number) {
    clearTimeout(this.gmTimer);
    this.gmTimer = setTimeout(() => {
      if (this.current(gen)) void this.store.reloadPages().catch(() => undefined);
    }, GM_REFRESH_MS);
  }

  // ---- toasts ----

  private add(item: LiveItem, reload = false) {
    const now = Date.now();
    const cur = this.toast();
    if (cur && cur.summary == null && now - this.groupAt < COLLAPSE_MS) {
      if (cur.items.some((i) => i.pageId === item.pageId && i.kind === item.kind)) return;
      // The Reload offer for a page with unsaved edits survives the merge
      this.toast.set({ ...cur, seq: ++this.seq, items: [...cur.items, item], reload: cur.reload || reload });
      return;
    }
    this.groupAt = now;
    this.push({ seq: ++this.seq, id: this.seq, items: [item], summary: null, reload }, true);
  }

  private push(t: LiveToast, fresh: boolean) {
    if (fresh) {
      this.groupAt = Date.now();
      this.viewOpen.set(false);
    }
    this.toast.set(t);
  }

  dismissToast() {
    this.toast.set(null);
    this.viewOpen.set(false);
  }

  /** The toast's main button. */
  act() {
    const t = this.toast();
    if (!t) return;
    switch (toastAction(t)) {
      case 'open': {
        const id = t.items[0]?.pageId;
        if (id) this.store.navigateTo?.(id);
        this.dismissToast();
        return;
      }
      case 'show':
        this.scrollToNew();
        this.dismissToast();
        return;
      case 'reload':
        this.reloadOpen();
        return;
      case 'view':
        this.viewOpen.update((v) => !v);
        return;
    }
  }

  /** "Save and reload" of the open page (also offered on a collapsed toast). */
  reloadOpen() {
    this.open?.reload();
    this.dismissToast();
  }

  /** Scrolls the first highlighted block into view. Never called on its own: the page does not move by itself. */
  private scrollToNew() {
    const el = document.querySelector('[data-campaign-main] .cn-new-block');
    if (!el) return;
    const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
  }

  // ---- "New" state (memory plus sessionStorage per campaign) ----

  private markNew(pageIds: string[]) {
    if (!pageIds.length) return;
    this.newPages.update((s) => new Set([...s, ...pageIds]));
    this.persist();
  }

  private prune(existing: Set<string>) {
    const pages = [...this.newPages()].filter((id) => existing.has(id));
    const blocks = Object.fromEntries(Object.entries(this.newBlocks()).filter(([id]) => existing.has(id)));
    if (pages.length !== this.newPages().size || Object.keys(blocks).length !== Object.keys(this.newBlocks()).length) {
      this.newPages.set(new Set(pages));
      this.newBlocks.set(blocks);
      this.persist();
    }
  }

  private key() {
    return `cn.live.new.${this.cid}`;
  }

  private persist() {
    if (!this.cid) return;
    try {
      const data: Persisted = { pages: [...this.newPages()], blocks: { ...this.newBlocks() } };
      sessionStorage.setItem(this.key(), JSON.stringify(data));
    } catch {
      /* private mode or blocked storage: the badges just do not survive a reload */
    }
  }

  private restore() {
    let data: Persisted | null;
    try {
      data = JSON.parse(sessionStorage.getItem(this.key()) ?? 'null') as Persisted | null;
    } catch {
      data = null;
    }
    const pages = Array.isArray(data?.pages) ? data.pages.filter((x) => typeof x === 'string') : [];
    const blocks: Record<string, string[]> = {};
    for (const [id, list] of Object.entries(data?.blocks ?? {})) {
      if (Array.isArray(list)) blocks[id] = list.filter((x) => typeof x === 'string');
    }
    this.newPages.set(new Set(pages));
    this.newBlocks.set(blocks);
  }
}
