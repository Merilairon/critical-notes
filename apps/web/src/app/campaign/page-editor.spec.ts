import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { BlockEditor } from '../editor/block-editor';
import { LayoutService } from '../core/layout.service';
import { CampaignStore } from './campaign.store';
import { PageEditor } from './page-editor';

// jsdom has no layout: ProseMirror's coordsAtPos and scrollIntoView need rects
const NO_RECT = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => NO_RECT as DOMRect;
Element.prototype.getClientRects ??= () => [] as unknown as DOMRectList;

const settle = () => new Promise((resolve) => setTimeout(resolve));

async function mount(phone: boolean) {
  const layout = { phone: signal(phone) };
  const store = {
    id: signal('c1'),
    isGm: () => false,
    canEdit: () => false,
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
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: CampaignStore, useValue: store }, { provide: LayoutService, useValue: layout }],
  });
  const fixture = TestBed.createComponent(PageEditor);
  fixture.componentRef.setInput('pageId', 'p1');
  fixture.detectChanges();
  await settle();
  TestBed.inject(HttpTestingController)
    .expectOne('/api/campaigns/c1/pages/p1')
    .flush({
      id: 'p1', type: 'pc', title: 'Wren', icon: null, visibility: 'all', tags: [], viewers: [], props: {}, revision: 1,
      facet: { hpCurrent: 24, hpMax: 31, ac: 16, speed: 30 }, body: { schemaVersion: 1, type: 'doc', content: [] },
    });
  await settle();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, layout, sheet: () => el.querySelector('details')! };
}

describe('PageEditor save and reload (live toast)', () => {
  it('a stale revision keeps the page, the edit and the conflict banner: no reload', async () => {
    const { fixture, el } = await mount(false);
    const http = TestBed.inject(HttpTestingController);
    const editor = fixture.componentInstance as unknown as { queue(c: object): void; saveAndReload(id: string): Promise<void> };
    editor.queue({ title: 'Wren the Bold' });
    const done = editor.saveAndReload('p1');
    await settle();
    http.expectOne({ method: 'PATCH', url: '/api/campaigns/c1/pages/p1' }).flush('', { status: 409, statusText: 'Conflict' });
    await done;
    fixture.detectChanges();
    http.expectNone('/api/campaigns/c1/pages/p1');
    expect(el.textContent).toContain('Someone else changed this page');
    expect(el.querySelector('h1')!.textContent).toBe('Wren the Bold');
  });

  it('typing during the save is saved too before the reload, and no stale save fires afterwards', async () => {
    try {
      const { fixture } = await mount(false);
      const http = TestBed.inject(HttpTestingController);
      const editor = fixture.componentInstance as unknown as { queue(c: object): void; saveAndReload(id: string): Promise<void> };
      const reply = (rev: number, title: string) => ({ id: 'p1', type: 'pc', title, revision: rev, tags: [], viewers: [], props: {}, visibility: 'all', body: { type: 'doc', content: [] } });
      editor.queue({ title: 'One' });
      const done = editor.saveAndReload('p1');
      await settle();
      const first = http.expectOne({ method: 'PATCH', url: '/api/campaigns/c1/pages/p1' });
      editor.queue({ title: 'Two' }); // typed while the first save is in flight
      first.flush(reply(2, 'One'));
      await settle();
      const second = http.expectOne({ method: 'PATCH', url: '/api/campaigns/c1/pages/p1' });
      expect(second.request.body).toMatchObject({ title: 'Two', revision: 2 });
      second.flush(reply(3, 'Two'));
      await settle();
      http.expectOne({ method: 'GET', url: '/api/campaigns/c1/pages/p1' }).flush(reply(4, 'Two'));
      await done;
      await new Promise((r) => setTimeout(r, 900));
      http.expectNone({ method: 'PATCH', url: '/api/campaigns/c1/pages/p1' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reloads after a successful save', async () => {
    const { fixture } = await mount(false);
    const http = TestBed.inject(HttpTestingController);
    const editor = fixture.componentInstance as unknown as { queue(c: object): void; saveAndReload(id: string): Promise<void> };
    editor.queue({ title: 'Wren the Bold' });
    const done = editor.saveAndReload('p1');
    await settle();
    http.expectOne({ method: 'PATCH', url: '/api/campaigns/c1/pages/p1' }).flush({ id: 'p1', type: 'pc', title: 'Wren the Bold', revision: 2, tags: [], viewers: [], props: {}, visibility: 'all', body: { type: 'doc', content: [] } });
    await settle();
    await settle();
    http.expectOne({ method: 'GET', url: '/api/campaigns/c1/pages/p1' }).flush({ id: 'p1', type: 'pc', title: 'Wren the Bold', revision: 3, tags: [], viewers: [], props: {}, visibility: 'all', body: { type: 'doc', content: [] } });
    await done;
  });
});

describe('PageEditor character sheet', () => {
  it('on a phone it starts collapsed with a digest and toggles', async () => {
    const { fixture, el, sheet } = await mount(true);
    const summary = sheet().querySelector('summary')!;
    expect(sheet().open).toBe(false);
    expect(summary.classList.contains('hidden')).toBe(false);
    expect(summary.textContent).toContain('Character sheet');
    expect(summary.textContent).toContain('HP 24/31 · AC 16 · Speed 30 ft');
    expect(el.querySelector('h1')!.textContent).toBe('Wren');
    sheet().open = true;
    sheet().dispatchEvent(new Event('toggle'));
    fixture.detectChanges();
    expect(sheet().open).toBe(true);
  });

  it('on a wide window the sheet is always open and the summary is hidden; flipping to phone collapses it', async () => {
    const { fixture, layout, sheet } = await mount(false);
    expect(sheet().open).toBe(true);
    expect(sheet().querySelector('summary')!.classList.contains('hidden')).toBe(true);
    layout.phone.set(true);
    fixture.detectChanges();
    expect(sheet().open).toBe(false);
    expect(sheet().querySelector('summary')!.classList.contains('hidden')).toBe(false);
  });
});

describe('PageEditor handout sharing', () => {
  async function mountHandout(visibility: string, content: object[] = []) {
    const store = {
      id: signal('c1'), isGm: () => true, canEdit: () => true, members: signal([]), loadMembers: async () => undefined, ancestors: () => [],
      childrenOf: () => new Map(), campaign: signal({ name: 'C' }), pages: signal([]), pagesOfType: () => [], propertyDefs: signal([]),
      byId: () => new Map(), patchSummary: () => undefined,
    };
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: CampaignStore, useValue: store }, { provide: LayoutService, useValue: { phone: signal(false) } }],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(PageEditor);
    fixture.componentRef.setInput('pageId', 'p1');
    fixture.detectChanges();
    await settle();
    const page = { id: 'p1', type: 'handout', title: 'Letter', icon: null, visibility, tags: [], viewers: ['u1'], props: {}, revision: 1, facet: {}, body: { schemaVersion: 1, type: 'doc', content } };
    http.expectOne('/api/campaigns/c1/pages/p1').flush(page);
    await settle();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const btn = (text: string) => Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
    let revision = 1;
    /** The next visibility save. A body save the editor makes on load (it adds block ids) is answered on the way. */
    const visibilityPatch = (want: (body: Record<string, unknown>) => boolean = (b) => 'visibility' in b) => patchWhere(want);
    const patchWhere = async (want: (body: Record<string, unknown>) => boolean) => {
      for (let i = 0; i < 10; i++) {
        await settle();
        for (const req of http.match((r) => r.method === 'PATCH')) {
          if (want(req.request.body)) return req;
          req.flush({ ...page, revision: ++revision });
        }
      }
      throw new Error('no visibility save');
    };
    return { fixture, http, el, btn, page, visibilityPatch };
  }

  it('Share now saves visibility all at once and Undo restores the previous visibility', async () => {
    const t = await mountHandout('dm');
    t.btn('Share now')!.click();
    let req = await t.visibilityPatch();
    expect(req.request.body).toMatchObject({ visibility: 'all' });
    req.flush({ ...t.page, visibility: 'all', revision: 20 });
    await settle();
    t.fixture.detectChanges();
    expect(t.el.textContent).toContain('Shared with all players');
    expect(t.btn('Share now')).toBeUndefined();
    t.btn('Undo')!.click();
    req = await t.visibilityPatch();
    expect(req.request.body).toMatchObject({ visibility: 'dm', viewers: ['u1'], revision: 20 });
    req.flush({ ...t.page, visibility: 'dm', revision: 21 });
  });

  it('Share with chosen players selects visibility "selected"', async () => {
    const t = await mountHandout('dm');
    t.btn('Share with chosen players')!.click();
    const req = await t.visibilityPatch();
    expect(req.request.body).toMatchObject({ visibility: 'selected', viewers: ['u1'] });
    req.flush({ ...t.page, visibility: 'selected', revision: 2 });
  });

  it('navigating to another page drops the Undo: no write lands on the new page', async () => {
    const t = await mountHandout('dm');
    t.btn('Share now')!.click();
    const req = await t.visibilityPatch();
    req.flush({ ...t.page, visibility: 'all', revision: 20 });
    await settle();
    t.fixture.detectChanges();
    expect(t.btn('Undo')).toBeDefined();
    t.fixture.componentRef.setInput('pageId', 'p2');
    t.fixture.detectChanges();
    await settle();
    t.http.expectOne('/api/campaigns/c1/pages/p2').flush({ ...t.page, id: 'p2', title: 'Other', visibility: 'dm' });
    await settle();
    t.fixture.detectChanges();
    expect(t.btn('Undo')).toBeUndefined();
    expect(t.http.match((r) => r.method === 'PATCH' && r.url.endsWith('/p2'))).toEqual([]);
  });

  for (const status of [500, 409]) {
    it(`a failed share save (${status}) shows no confirmation and the page goes back to DM only`, async () => {
      const t = await mountHandout('dm');
      t.btn('Share now')!.click();
      const req = await t.visibilityPatch();
      req.flush({ message: 'boom' }, { status, statusText: 'Failed' });
      await settle();
      t.fixture.detectChanges();
      expect(t.el.textContent).not.toContain('Shared with all players');
      const select = Array.from(t.el.querySelectorAll('select')).find((s) => s.closest('label')?.textContent?.includes('Visible to'))!;
      expect(select.selectedOptions[0]!.textContent).toContain('DM only');
      expect(t.btn('Share now')).toBeDefined();
      expect(t.el.querySelector('[role="alert"]')).not.toBeNull();
    });
  }

  it('Reveal now in the real editor saves a PATCH with revealed:true and every block id', async () => {
    const para = (id: string, text: string) => ({ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }] });
    const t = await mountHandout('all', [{ type: 'secret', attrs: { id: 's1', revealed: false }, content: [para('c1', 'Hidden')] }, para('p9', 'After')]);
    const area = t.el.querySelector('.tiptap')!;
    // Put the caret in the secret, then open the block menu with Ctrl+.
    const be = t.fixture.debugElement.query(By.directive(BlockEditor)).componentInstance as BlockEditor;
    be.editor.chain().setTextSelection(3).run();
    area.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true, bubbles: true, cancelable: true }));
    await settle();
    t.fixture.detectChanges();
    const item = Array.from(t.el.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')).find((i) => i.textContent?.includes('Reveal now'))!;
    item.click();
    const req = await t.visibilityPatch((b) => JSON.stringify(b).includes('"revealed":true'));
    const ids = JSON.stringify(req.request.body.body).match(/"id":"(s1|c1|p9)"/g)!.sort();
    expect(ids).toEqual(['"id":"c1"', '"id":"p9"', '"id":"s1"']);
    req.flush({ ...t.page, revision: 30 });
  });

  it('offers nothing on a handout that is already shared with everyone', async () => {
    const t = await mountHandout('all');
    expect(t.btn('Share now')).toBeUndefined();
  });
});
