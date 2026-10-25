import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { PageDto, PageSummaryDto } from '@cn/shared';
import { AuthService } from '../../core/auth.service';
import { CampaignStore } from '../campaign.store';
import { COLLAPSE_MS, GRACE_MS, JITTER_MS, LIVE_FETCH, LiveService, SEEN_MS, TOAST_MS, toastAction, toastText, type OpenPage } from './live.service';

const summary = (id: string, title = id): PageSummaryDto => ({ id, parentId: null, title, type: 'generic', sortKey: id }) as PageSummaryDto;
const doc = (...ids: string[]) => ({ type: 'doc', content: ids.map((id) => ({ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text: 'x' }] })) });
const full = (id: string, title: string, over: Partial<PageDto> = {}): PageDto => ({ ...summary(id, title), visibility: 'all', body: doc('b1', 'b2'), revision: 1, ...over }) as unknown as PageDto;

function setup(role: 'dm' | 'player' = 'player') {
  const conns: { push(t: string): void; end(): void }[] = [];
  const fetchFn = (async (_u: unknown, init?: RequestInit) => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
    init?.signal?.addEventListener('abort', () => {
      try {
        ctl.error(new DOMException('aborted', 'AbortError'));
      } catch {
        /* closed */
      }
    });
    const enc = new TextEncoder();
    conns.push({ push: (t) => ctl.enqueue(enc.encode(t)), end: () => ctl.close() });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), CampaignStore, LiveService, { provide: LIVE_FETCH, useValue: fetchFn }, { provide: AuthService, useValue: { user: signal(null) } }],
  });
  const store = TestBed.inject(CampaignStore);
  store.campaign.set({ id: 'c1', role, ruleset: 'x' } as never);
  store.pages.set([summary('a', 'Harbour')]);
  const http = TestBed.inject(HttpTestingController);
  const live = TestBed.inject(LiveService);
  const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
  const treeReq = (pages: PageSummaryDto[]) => http.expectOne('/api/campaigns/c1/pages').flush({ pages });
  /** start, hello, answer the sync refetch of the tree */
  const connect = async (pages = [summary('a', 'Harbour')]) => {
    live.start('c1');
    await tick();
    conns[0]!.push('event: hello\ndata: {"replayed":false}\n\n');
    await tick();
    treeReq(pages);
    await tick(GRACE_MS + 10);
  };
  const frame = (event: string, data: object) => conns[0]!.push(`id: t${Math.random()}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return { live, store, http, conns, tick, treeReq, connect, frame };
}

describe('LiveService (player)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
  });
  afterEach(() => {
    TestBed.inject(LiveService).stop();
    vi.useRealTimers();
  });

  it('refetches the tree on the first connect and shows no toast', async () => {
    const { live, http, connect } = setup();
    await connect([summary('a', 'Harbour'), summary('b', 'Old news')]);
    expect(live.toast()).toBeNull();
    expect(live.state()).toBe('live');
    http.verify();
  });

  it('toasts "New: title" only after the refetch succeeded, never from the event', async () => {
    const { live, http, tick, frame, connect } = setup();
    await connect();
    frame('page-shared', { pageId: 'p1' });
    await tick(JITTER_MS + 1);
    const pageReq = http.expectOne('/api/campaigns/c1/pages/p1');
    const treeReq = http.expectOne('/api/campaigns/c1/pages');
    expect(live.toast()).toBeNull();
    pageReq.flush(full('p1', 'Letter from the duke'));
    treeReq.flush({ pages: [summary('a'), summary('p1', 'Letter from the duke')] });
    await tick();
    expect(toastText(live.toast()!)).toBe('New: Letter from the duke');
    expect(toastAction(live.toast()!)).toBe('open');
    expect(live.isNew('p1')).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('cn.live.new.c1')!).pages).toEqual(['p1']);
  });

  it('says nothing when the page cannot be fetched (404) and "Just for you" for selected pages', async () => {
    const { live, http, tick, frame, connect } = setup();
    await connect();
    frame('page-shared', { pageId: 'gone' });
    await tick(JITTER_MS + 1);
    http.expectOne('/api/campaigns/c1/pages/gone').flush('', { status: 404, statusText: 'Not found' });
    http.expectOne('/api/campaigns/c1/pages').flush({ pages: [] });
    await tick();
    expect(live.toast()).toBeNull();
    frame('page-shared', { pageId: 'mine' });
    await tick(JITTER_MS + 1);
    http.expectOne('/api/campaigns/c1/pages/mine').flush(full('mine', 'Your map', { visibility: 'selected' }));
    http.expectOne('/api/campaigns/c1/pages').flush({ pages: [] });
    await tick();
    expect(toastText(live.toast()!)).toBe('Just for you: Your map');
  });

  it('collapses several arrivals inside 3 s into one toast', async () => {
    const { live, http, tick, frame, connect } = setup();
    await connect();
    for (const [id, title] of [['p1', 'Map'], ['p2', 'Letter'], ['p3', 'Key']] as const) {
      frame('page-shared', { pageId: id });
      await tick(JITTER_MS + 1);
      http.expectOne(`/api/campaigns/c1/pages/${id}`).flush(full(id, title));
      http.expectOne('/api/campaigns/c1/pages').flush({ pages: [] });
      await tick(100);
    }
    expect(toastText(live.toast()!)).toBe('3 new things: Map and 2 more');
    expect(toastAction(live.toast()!)).toBe('view');
    await tick(COLLAPSE_MS + 100);
    frame('page-shared', { pageId: 'p4' });
    await tick(JITTER_MS + 1);
    http.expectOne('/api/campaigns/c1/pages/p4').flush(full('p4', 'Later'));
    http.expectOne('/api/campaigns/c1/pages').flush({ pages: [] });
    await tick();
    expect(toastText(live.toast()!)).toBe('New: Later');
  });

  it('block-revealed on another page: toast names the page, highlight ids come from the fetched document', async () => {
    const { live, http, tick, frame, connect } = setup();
    await connect();
    frame('block-revealed', { pageId: 'a', blockIds: ['b2', 'not-in-my-copy'] });
    await tick(JITTER_MS + 1);
    http.expectOne('/api/campaigns/c1/pages/a').flush(full('a', 'Harbour'));
    await tick();
    expect(toastText(live.toast()!)).toBe('New on Harbour');
    expect(live.newBlocks()['a']).toEqual(['b2']);
    expect(live.isNew('a')).toBe(true);
    // an event naming only blocks the player does not have is silent
    live.dismissToast();
    frame('block-revealed', { pageId: 'a', blockIds: ['zzz'] });
    await tick(JITTER_MS + 1);
    http.expectOne('/api/campaigns/c1/pages/a').flush(full('a', 'Harbour'));
    await tick();
    expect(live.toast()).toBeNull();
  });

  it('refreshes the open page in place and offers Show; the badge clears after it was open for 2 s', async () => {
    const { live, http, tick, frame, connect } = setup();
    await connect();
    const applied: PageDto[] = [];
    const open: OpenPage = { id: 'a', isDirty: () => false, apply: (p) => void applied.push(p), reload: () => undefined };
    live.registerOpen(open);
    frame('block-revealed', { pageId: 'a', blockIds: ['b1'] });
    await tick(JITTER_MS + 1);
    http.expectOne('/api/campaigns/c1/pages/a').flush(full('a', 'Harbour'));
    await tick();
    expect(applied).toHaveLength(1);
    expect(toastText(live.toast()!)).toBe('New details on this page');
    expect(toastAction(live.toast()!)).toBe('show');
    expect(live.isNew('a')).toBe(false);
    expect(live.newBlocks()['a']).toEqual(['b1']);
    live.clearBlocks('a', ['b1']);
    expect(live.newBlocks()['a']).toBeUndefined();
    live.unregisterOpen('a');
  });

  it('never overwrites an open page with unsaved edits: Reload instead', async () => {
    const { live, http, tick, frame, connect } = setup();
    await connect();
    const applied: PageDto[] = [];
    let reloaded = 0;
    live.registerOpen({ id: 'a', isDirty: () => true, apply: (p) => void applied.push(p), reload: () => void reloaded++ });
    frame('block-revealed', { pageId: 'a', blockIds: ['b1'] });
    await tick(JITTER_MS + 1);
    http.expectOne('/api/campaigns/c1/pages/a').flush(full('a', 'Harbour'));
    await tick();
    expect(applied).toEqual([]);
    expect(toastAction(live.toast()!)).toBe('reload');
    live.act();
    expect(reloaded).toBe(1);
    expect(live.toast()).toBeNull();
  });

  it('keeps the Reload offer and the card id when another arrival merges into a dirty-page toast; nothing is written after stop', async () => {
    const { live, http, tick, frame, connect } = setup();
    await connect();
    live.registerOpen({ id: 'a', isDirty: () => true, apply: () => undefined, reload: () => undefined });
    frame('block-revealed', { pageId: 'a', blockIds: ['b1'] });
    await tick(JITTER_MS + 1);
    http.expectOne('/api/campaigns/c1/pages/a').flush(full('a', 'Harbour'));
    await tick();
    const id = live.toast()!.id;
    frame('page-shared', { pageId: 'p9' });
    await tick(JITTER_MS + 1);
    http.expectOne('/api/campaigns/c1/pages/p9').flush(full('p9', 'Key'));
    http.expectOne('/api/campaigns/c1/pages').flush({ pages: [] });
    await tick();
    expect(live.toast()!.items).toHaveLength(2);
    expect(live.toast()!.reload).toBe(true);
    expect(live.toast()!.id).toBe(id);
    live.stop();
    sessionStorage.clear();
    live.clearBlocks('a');
    live.clearPage('a');
    expect(sessionStorage.getItem('cn.live.new.null')).toBeNull();
  });

  it('a page badge clears once the page has been open for 2 s, and block highlights clear on leaving', async () => {
    const { live, http, tick, frame, connect } = setup();
    await connect();
    frame('block-revealed', { pageId: 'a', blockIds: ['b1'] });
    await tick(JITTER_MS + 1);
    http.expectOne('/api/campaigns/c1/pages/a').flush(full('a', 'Harbour'));
    await tick();
    expect(live.isNew('a')).toBe(true);
    live.registerOpen({ id: 'a', isDirty: () => false, apply: () => undefined, reload: () => undefined });
    await tick(SEEN_MS - 100);
    expect(live.isNew('a')).toBe(true);
    await tick(200);
    expect(live.isNew('a')).toBe(false);
    live.unregisterOpen('a');
    expect(live.newBlocks()['a']).toBeUndefined();
  });

  it('after a reconnect: refetches the tree and the open page, replayed events only add toasts, leftovers get one summary', async () => {
    const { live, http, conns, tick, treeReq, connect } = setup();
    await connect();
    const applied: PageDto[] = [];
    live.registerOpen({ id: 'a', isDirty: () => false, apply: (p) => void applied.push(p), reload: () => undefined });
    conns[0]!.end();
    await tick(31_000);
    expect(conns).toHaveLength(2);
    conns[1]!.push('event: hello\ndata: {"replayed":false}\n\nevent: resync\ndata: {}\n\n');
    await tick();
    treeReq([summary('a', 'Harbour'), summary('n1', 'One'), summary('n2', 'Two')]);
    await tick();
    http.expectOne('/api/campaigns/c1/pages/a').flush(full('a', 'Harbour'));
    await tick(GRACE_MS + 10);
    // a second tree fetch may be queued by the resync coalescing
    http.match('/api/campaigns/c1/pages').forEach((r) => r.flush({ pages: [summary('a', 'Harbour'), summary('n1', 'One'), summary('n2', 'Two')] }));
    http.match('/api/campaigns/c1/pages/a').forEach((r) => r.flush(full('a', 'Harbour')));
    await tick(GRACE_MS + 10);
    expect(applied.length).toBeGreaterThanOrEqual(1);
    expect(toastText(live.toast()!)).toBe('You have 2 new pages');
    expect(toastAction(live.toast()!)).toBe('view');
  });

  it('keeps the toast for 8 s and the New markers survive a new service instance (sessionStorage)', async () => {
    const { live, http, tick, frame, connect } = setup();
    await connect();
    frame('block-revealed', { pageId: 'a', blockIds: ['b1'] });
    await tick(JITTER_MS + 1);
    http.expectOne('/api/campaigns/c1/pages/a').flush(full('a', 'Harbour'));
    await tick();
    expect(live.toast()).not.toBeNull();
    live.stop();
    live.start('c1');
    expect(live.newBlocks()['a']).toEqual(['b1']);
    expect(live.isNew('a')).toBe(true);
    expect(TOAST_MS).toBe(8000);
  });
});

describe('LiveService (game master)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
  });
  afterEach(() => {
    TestBed.inject(LiveService).stop();
    vi.useRealTimers();
  });

  it('only refetches the tree: no toast, no page fetch, no badge', async () => {
    const { live, http, tick, frame, treeReq, conns } = setup('dm');
    live.start('c1');
    await tick();
    conns[0]!.push('event: hello\ndata: {"replayed":false}\n\n');
    await tick();
    treeReq([summary('a')]);
    await tick();
    frame('page-shared', { pageId: 'p1' });
    frame('block-revealed', { pageId: 'a', blockIds: ['b1'] });
    await tick(500);
    http.expectOne('/api/campaigns/c1/pages').flush({ pages: [summary('a'), summary('p1')] });
    await tick();
    http.verify();
    expect(live.toast()).toBeNull();
    expect(live.newPages().size).toBe(0);
  });
});

describe('toast text', () => {
  const t = (items: { kind: 'shared' | 'private' | 'details-here' | 'details-there'; title: string }[], summary: number | null = null, reload = false) => ({
    seq: 1,
    id: 1,
    summary,
    reload,
    items: items.map((i, n) => ({ ...i, pageId: `p${n}` })),
  });
  it('follows the design wording', () => {
    expect(toastText(t([{ kind: 'shared', title: 'Map' }]))).toBe('New: Map');
    expect(toastText(t([{ kind: 'private', title: 'Map' }]))).toBe('Just for you: Map');
    expect(toastText(t([{ kind: 'details-here', title: 'Map' }]))).toBe('New details on this page');
    expect(toastText(t([{ kind: 'details-there', title: 'Map' }]))).toBe('New on Map');
    expect(toastText(t([{ kind: 'shared', title: 'A' }, { kind: 'shared', title: 'B' }]))).toBe('2 new things: A and 1 more');
    expect(toastText(t([], 5))).toBe('You have 5 new pages');
    expect(toastText(t([], 1))).toBe('You have 1 new page');
  });
  it('truncates long titles to about 40 characters and never contains markup handling', () => {
    const text = toastText(t([{ kind: 'shared', title: 'x'.repeat(100) }]));
    expect(text.length).toBeLessThanOrEqual(46);
    expect(text.endsWith('…')).toBe(true);
    expect(toastText(t([{ kind: 'shared', title: '<b>hi</b>' }]))).toBe('New: <b>hi</b>');
  });
});
