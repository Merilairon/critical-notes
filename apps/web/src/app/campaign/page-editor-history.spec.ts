import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { DeferBlockBehavior, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { PageDto } from '@cn/shared';
import { LayoutService } from '../core/layout.service';
import { CampaignStore } from './campaign.store';
import { PageEditor } from './page-editor';

const NO_RECT = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => NO_RECT as DOMRect;
Element.prototype.getClientRects ??= () => [] as unknown as DOMRectList;

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const reply = (extra: object = {}) => ({
  id: 'p1', type: 'location', title: 'Harbour', icon: null, visibility: 'all', tags: [], viewers: [], props: {}, revision: 1, facet: null,
  body: { schemaVersion: 1, type: 'doc', content: [] }, ...extra,
});

async function mount(gm: boolean) {
  const store = {
    id: signal('c1'),
    isGm: () => gm,
    canEdit: () => gm,
    members: signal([]),
    loadMembers: async () => undefined,
    ancestors: () => [],
    childrenOf: () => new Map(),
    campaign: signal({ name: 'C' }),
    pages: signal([]),
    pagesOfType: () => [],
    propertyDefs: signal([]),
    byId: () => new Map(),
    patchSummary: () => undefined,
  };
  TestBed.configureTestingModule({
    deferBlockBehavior: DeferBlockBehavior.Playthrough,
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: CampaignStore, useValue: store }, { provide: LayoutService, useValue: { phone: signal(false) } }],
  });
  const fixture = TestBed.createComponent(PageEditor);
  fixture.componentRef.setInput('pageId', 'p1');
  document.body.append(fixture.nativeElement);
  fixture.detectChanges();
  await settle();
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/campaigns/c1/pages/p1').flush(reply());
  await settle();
  fixture.detectChanges();
  // The block editor may save its normalised empty document once: let that finish so nothing is pending
  await settle();
  http.match((r) => r.method === 'PATCH').forEach((r) => r.flush(reply({ revision: 2 })));
  await settle();
  fixture.detectChanges();
  // Drop what the block editor queued while loading, so tests start with nothing pending
  const internals = fixture.componentInstance as unknown as { pending: object; timer: ReturnType<typeof setTimeout> };
  clearTimeout(internals.timer);
  internals.pending = {};
  const el = fixture.nativeElement as HTMLElement;
  const historyBtn = () => Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('History')) as HTMLButtonElement | undefined;
  const panel = () => el.querySelector('cn-history-panel');
  const open = async () => {
    historyBtn()!.click();
    for (let i = 0; i < 40 && !panel(); i++) {
      fixture.detectChanges();
      await settle();
    }
    fixture.detectChanges();
    await settle();
    http.match((r) => r.url.includes('/history')).forEach((r) => r.flush({ items: [] }));
    await settle();
    fixture.detectChanges();
  };
  const editor = fixture.componentInstance as unknown as {
    adoptHistory(p: PageDto): boolean;
    queue(c: object, immediate?: boolean): void;
    onHistoryBusy(busy: boolean): void;
    page(): PageDto;
    status(): string;
    pending: object;
    flush(): Promise<void>;
  };
  return { fixture, el, http, historyBtn, panel, open, editor };
}

describe('PageEditor history wiring', () => {
  afterEach(() => document.body.replaceChildren());

  it('shows no History button to a player', async () => {
    const { historyBtn } = await mount(false);
    expect(historyBtn()).toBeUndefined();
  });

  it('opens and closes the panel from the toolbar button, which reports aria-expanded', async () => {
    const { historyBtn, panel, open, fixture } = await mount(true);
    expect(historyBtn()!.getAttribute('aria-expanded')).toBe('false');
    expect(panel()).toBeNull();
    await open();
    expect(historyBtn()!.getAttribute('aria-expanded')).toBe('true');
    expect(panel()).not.toBeNull();
    historyBtn()!.click();
    fixture.detectChanges();
    expect(panel()).toBeNull();
  });

  it('Close returns focus to the History button', async () => {
    const { el, historyBtn, open, fixture } = await mount(true);
    await open();
    Array.from(el.querySelectorAll('cn-history-panel button')).find((b) => b.textContent?.trim() === 'Close')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    await settle();
    expect(document.activeElement).toBe(historyBtn());
  });

  it('closes the panel and hides the button when previewing as a player', async () => {
    const { historyBtn, panel, open, fixture, el, http } = await mount(true);
    await open();
    Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Preview as player'))!.click();
    await settle();
    http.expectOne((r) => r.url === '/api/campaigns/c1/pages/p1' && r.params.get('as') === 'player').flush(reply());
    await settle();
    fixture.detectChanges();
    expect(panel()).toBeNull();
    expect(historyBtn()).toBeUndefined();
  });

  it('adoptHistory ignores a page with another id', async () => {
    const { editor } = await mount(true);
    editor.adoptHistory(reply({ id: 'other', title: 'Elsewhere' }) as unknown as PageDto);
    expect(editor.page().title).toBe('Harbour');
  });

  it('adoptHistory replaces the page when nothing is pending', async () => {
    const { editor } = await mount(true);
    expect(editor.adoptHistory(reply({ title: 'Restored', revision: 4 }) as unknown as PageDto)).toBe(true);
    expect(editor.page().title).toBe('Restored');
  });

  it('adoptHistory keeps edits typed meanwhile and shows the conflict banner instead of losing them', async () => {
    const { editor, fixture, el } = await mount(true);
    editor.queue({ title: 'Typed meanwhile' });
    expect(editor.adoptHistory(reply({ title: 'Restored', revision: 4 }) as unknown as PageDto)).toBe(false);
    fixture.detectChanges();
    expect(editor.page().title).toBe('Typed meanwhile');
    expect(editor.status()).toBe('conflict');
    expect(el.textContent).toContain('Someone else changed this page');
  });

  it('holds the autosave back while a restore is writing, then saves the typing if there was no conflict', async () => {
    const { editor, http } = await mount(true);
    editor.onHistoryBusy(true);
    editor.queue({ title: 'Typed during restore' }, true);
    await settle();
    http.expectNone({ method: 'PATCH', url: '/api/campaigns/c1/pages/p1' });
    editor.onHistoryBusy(false);
    await settle();
    http.expectOne({ method: 'PATCH', url: '/api/campaigns/c1/pages/p1' }).flush(reply({ title: 'Typed during restore', revision: 2 }));
  });

  it('refuses the restored page when typing arrived during the restore, and does not save it afterwards', async () => {
    const { editor, http } = await mount(true);
    editor.onHistoryBusy(true);
    editor.queue({ title: 'Typed during restore' }, true);
    await settle();
    expect(editor.adoptHistory(reply({ title: 'Restored', revision: 4 }) as unknown as PageDto)).toBe(false);
    editor.onHistoryBusy(false);
    await settle();
    http.expectNone({ method: 'PATCH', url: '/api/campaigns/c1/pages/p1' });
    expect(editor.page().title).toBe('Typed during restore');
    expect(editor.status()).toBe('conflict');
  });

  it('keeps the unsent changes when a save hits a conflict, so a later restore sees them', async () => {
    const { editor, http } = await mount(true);
    editor.queue({ title: 'Mine' }, true);
    await settle();
    http.expectOne({ method: 'PATCH', url: '/api/campaigns/c1/pages/p1' }).flush({ error: 'changed' }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(editor.status()).toBe('conflict');
    expect(editor.pending).toEqual({ title: 'Mine' });
    expect(editor.adoptHistory(reply({ title: 'Restored', revision: 4 }) as unknown as PageDto)).toBe(false);
  });
});
