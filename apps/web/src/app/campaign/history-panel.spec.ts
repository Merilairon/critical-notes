import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { PageDto } from '@cn/shared';
import { CampaignStore } from './campaign.store';
import { HistoryPanel, sizeText, whenText, whoText, type HistoryDetail, type HistoryItem } from './history-panel';

const settle = () => new Promise((r) => setTimeout(r));
async function tick(f: ComponentFixture<unknown>) {
  await settle();
  f.detectChanges();
  await settle();
  f.detectChanges();
}
const BASE = '/api/campaigns/c1/pages/p1/history';
const doc = (...lines: string[]) => ({ type: 'doc', content: lines.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) });
const item = (revision: number, extra: Partial<HistoryItem> = {}): HistoryItem => ({
  revision,
  createdAt: Date.now() - (20 - revision) * 3_600_000,
  author: { id: 'u1', displayName: 'Jan' },
  source: 'web',
  tokenName: null,
  cause: 'edit',
  restoredFrom: null,
  title: 'Old Harbour',
  bytes: 3100,
  ...extra,
});
const detail = (revision: number, lines: string[], extra: Partial<HistoryDetail> = {}): HistoryDetail => ({
  ...item(revision),
  type: 'location',
  body: doc(...lines),
  details: null,
  properties: {},
  ...extra,
});
const page = (revision: number, lines: string[] = ['now']): PageDto =>
  ({ id: 'p1', campaignId: 'c1', title: 'Old Harbour', type: 'location', revision, body: doc(...lines), facet: null, props: {}, createdAt: 0 }) as unknown as PageDto;
const alerts = (el: HTMLElement) => Array.from(el.querySelectorAll('[role="alert"]')).map((a) => a.textContent).join(' ');
const err = (r: TestRequest, status: number, body: object = {}) => r.flush(body, { status, statusText: String(status) });

async function mount(items: HistoryItem[] | number, opts: { revision?: number; prepare?: () => Promise<{ ok: boolean; revision: number }>; adopt?: boolean } = {}) {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), { provide: CampaignStore, useValue: { id: signal('c1'), propertyDefs: signal([]) } }],
  });
  const fixture = TestBed.createComponent(HistoryPanel);
  const prepare = opts.prepare ?? vi.fn(async () => ({ ok: true, revision: opts.revision ?? 5 }));
  fixture.componentRef.setInput('page', page(opts.revision ?? 5));
  fixture.componentRef.setInput('prepare', prepare);
  const restored = vi.fn();
  const stale = vi.fn();
  const closed = vi.fn();
  const busy = vi.fn();
  fixture.componentRef.setInput('adopt', (p: PageDto, why: 'restored' | 'stale') => {
    (why === 'restored' ? restored : stale)(p);
    return opts.adopt ?? true;
  });
  fixture.componentInstance.busy.subscribe(busy);
  fixture.componentInstance.closed.subscribe(closed);
  const http = TestBed.inject(HttpTestingController);
  document.body.append(fixture.nativeElement);
  fixture.detectChanges();
  const req = http.expectOne(`${BASE}?limit=50`);
  if (typeof items === 'number') err(req, items, { error: 'boom' });
  else req.flush({ items });
  await tick(fixture);
  const el = fixture.nativeElement as HTMLElement;
  const box = (rev: number) => el.querySelector<HTMLInputElement>(`input[data-rev="${rev}"]`)!;
  const restoreBtn = (rev: number) => el.querySelector<HTMLButtonElement>(`[data-restore="${rev}"]`)!;
  const button = (text: string) => Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
  const reload = async (list: HistoryItem[] = Array.isArray(items) ? items : []) => {
    // the fresh look at the newest row that comes before the restore request
    http.expectOne(`${BASE}?limit=1`).flush({ items: list.slice(0, 1) });
    await settle();
  };
  const tickBox = async (rev: number, d?: HistoryDetail) => {
    box(rev).click();
    if (d) http.expectOne(`${BASE}/${rev}`).flush(d);
    await tick(fixture);
  };
  return { fixture, el, http, reload, prepare, restored, stale, closed, busy, box, restoreBtn, button, tickBox, rows: () => Array.from(el.querySelectorAll('li')) };
}

describe('HistoryPanel', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('lists newest first, marks the current version and gives it no Restore', async () => {
    const { rows, restoreBtn, el, box } = await mount([item(5), item(4, { title: 'Harbour' }), item(3)]);
    expect(rows()).toHaveLength(3);
    expect(rows()[0].textContent).toContain('Version 5');
    expect(rows()[0].textContent).toContain('Current');
    expect(rows()[0].textContent).toContain('3.0 KB');
    expect(restoreBtn(5)).toBeNull();
    expect(restoreBtn(4).getAttribute('aria-label')).toBe('Restore version 4');
    expect(restoreBtn(4).getAttribute('aria-describedby')).toBe('cn-history-scope');
    expect(box(4).getAttribute('aria-label')).toBe('Compare version 4');
    expect(rows()[0].textContent).toContain('(was "Harbour")');
    expect(rows()[2].textContent).not.toContain('(was');
    expect(el.querySelector('[role="status"]')).not.toBeNull();
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    expect(el.textContent).toContain('Pick a version to see what changed.');
  });

  it('shows who made each version', () => {
    expect(whoText(item(1, { source: 'player', author: { id: 'u2', displayName: 'Mira' } }))).toBe('Mira (player)');
    expect(whoText(item(1, { source: 'mcp', tokenName: 'Claude desktop' }))).toBe('Jan via AI assistant (Claude desktop)');
    expect(whoText(item(1, { source: 'mcp', tokenName: null }))).toBe('Jan via AI assistant (deleted token)');
    expect(whoText(item(1, { source: 'system', author: null }))).toBe('Earlier version (before history started)');
    expect(whoText(item(1, { author: null }))).toBe('Deleted user');
    expect(sizeText(800)).toBe('800 B');
  });

  it('shows cause labels and today/yesterday times', async () => {
    const { rows } = await mount([item(4, { cause: 'restore', restoredFrom: 2 }), item(3, { cause: 'template_sync' }), item(2, { cause: 'baseline', source: 'system', author: null })]);
    expect(rows()[0].textContent).toContain('Restored from version 2');
    expect(rows()[1].textContent).toContain('Template sync');
    expect(rows()[2].textContent).toContain('Earlier version');
    const now = new Date(2026, 9, 26, 15, 0);
    expect(whenText(new Date(2026, 9, 26, 9, 5).getTime(), now)).toBe('Today 09:05');
    expect(whenText(new Date(2026, 9, 25, 21, 40).getTime(), now)).toBe('Yesterday 21:40');
  });

  it('states the empty and single-version cases', async () => {
    const empty = await mount([]);
    expect(empty.el.textContent).toContain('No earlier versions yet.');
    expect(empty.el.querySelector('input[type="checkbox"]')).toBeNull();
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const one = await mount([item(1)]);
    expect(one.el.textContent).toContain('This is the only version so far.');
  });

  it('shows the list error with Try again, and a plain message on 403/404', async () => {
    const { el, http, fixture, button } = await mount(500);
    expect(alerts(el)).toContain('Could not load history: boom');
    button('Try again').click();
    http.expectOne(`${BASE}?limit=50`).flush({ items: [item(1)] });
    await tick(fixture);
    expect(el.textContent).toContain('This is the only version so far.');
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const gone = await mount(404);
    expect(gone.el.textContent).toContain('History is not available for this page.');
    expect(gone.button('Try again')).toBeUndefined();
  });

  it('compares one ticked version with the current page and marks added and removed text', async () => {
    const { el, tickBox } = await mount([item(5), item(4)], { revision: 5 });
    await tickBox(4, detail(4, ['The harbour master Aldric keeps the keys']));
    expect(el.querySelector('h3')!.textContent).toContain('Changes from version 4 to version 5');
    expect(el.textContent).toContain('Compares text only');
    expect(el.textContent).toContain('Text: 1 word added, 7 words removed in 1 place.');
    const region = el.querySelector<HTMLElement>('[data-diff]')!;
    expect(region.getAttribute('role')).toBe('region');
    expect(region.tabIndex).toBe(0);
    expect(region.getAttribute('aria-label')).toBe('Changes from version 4 to version 5');
    expect(Array.from(region.querySelectorAll('del')).map((d) => d.textContent)).toEqual(['removed: The harbour master Aldric keeps the keys']);
    expect(Array.from(region.querySelectorAll('ins')).map((d) => d.textContent)).toEqual(['added: now']);
    expect(region.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
  });

  it('orders two ticked versions older to newer whatever the tick order, and refuses a third', async () => {
    const { el, tickBox, box, fixture } = await mount([item(5), item(4), item(3)]);
    await tickBox(4, detail(4, ['four']));
    await tickBox(3, detail(3, ['three']));
    expect(el.querySelector('h3')!.textContent).toContain('Changes from version 3 to version 4');
    expect(el.textContent).toContain('Two versions selected. Untick one to choose another.');
    expect(box(5).getAttribute('aria-disabled')).toBe('true');
    box(5).click();
    await tick(fixture);
    expect(box(5).checked).toBe(false);
  });

  it('reports identical versions', async () => {
    const { el, tickBox } = await mount([item(5), item(4)]);
    await tickBox(4, detail(4, ['now']));
    expect(el.textContent).toContain('No text differences.');
    expect(el.textContent).toContain('These two versions are identical.');
  });

  it('lists other changes and a detail error with Try again; a 404 untick', async () => {
    const { el, tickBox, http, fixture, button } = await mount([item(5), item(4), item(3)]);
    await tickBox(4, detail(4, ['now'], { title: 'Older name', properties: { mood: 'calm' } }));
    expect(el.textContent).toContain('Other changes');
    expect(el.textContent).toContain('Title: "Older name" to "Old Harbour"');
    expect(el.textContent).toContain('mood: "calm" to empty');
    // detail failure
    el.querySelector<HTMLInputElement>('input[data-rev="3"]')!.click();
    err(http.expectOne(`${BASE}/3`), 500);
    await tick(fixture);
    expect(el.querySelector('[data-diff]')).toBeNull();
    expect(el.textContent).toContain('Could not load version 3.');
    button('Try again').click();
    http.expectOne(`${BASE}/3`).flush(detail(3, ['x']));
    await tick(fixture);
    expect(el.querySelector('[data-diff]')).not.toBeNull();
  });

  it('collapses long unchanged runs and expands them on request', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const { el, tickBox, button, fixture } = await mount([item(5), item(4)]);
    // current page has one more line than the old version
    fixture.componentRef.setInput('page', page(5, [...many, 'tail']));
    fixture.detectChanges();
    await tickBox(4, detail(4, many));
    const gap = button('unchanged lines');
    expect(gap.textContent).toMatch(/Show \d+ unchanged lines/);
    gap.click();
    await tick(fixture);
    expect(button('unchanged lines')).toBeUndefined();
    expect(document.activeElement).toBe(el.querySelector('[data-diff]'));
  });

  it('paginates: Load older appends without duplicates, announces and focuses the first new row', async () => {
    const first = Array.from({ length: 50 }, (_, i) => item(120 - i));
    const { el, http, fixture, button, rows } = await mount(first, { revision: 120 });
    expect(rows()).toHaveLength(50);
    button('Load older versions').click();
    const req = http.expectOne(`${BASE}?before=71&limit=50`);
    const second = [item(71), ...Array.from({ length: 19 }, (_, i) => item(70 - i))];
    req.flush({ items: second });
    await tick(fixture);
    expect(rows()).toHaveLength(69);
    expect(el.textContent).toContain('19 older versions loaded');
    expect(document.activeElement).toBe(el.querySelector('input[data-rev="70"]'));
    expect(el.textContent).toContain('That is the oldest saved version.');
    expect(button('Load older versions')).toBeUndefined();
  });

  it('keeps focus on Load older and shows an alert when it fails', async () => {
    const first = Array.from({ length: 50 }, (_, i) => item(120 - i));
    const { el, http, fixture, button } = await mount(first);
    const more = button('Load older versions');
    more.focus();
    more.click();
    err(http.expectOne(`${BASE}?before=71&limit=50`), 500);
    await tick(fixture);
    expect(alerts(el)).toContain('Could not load older versions');
    expect(document.activeElement).toBe(more);
  });

  it('restores a version with no confirm, tells the result, and offers Undo restore', async () => {
    const { reload, el, http, fixture, restoreBtn, restored, prepare, button } = await mount([item(5), item(4)], { revision: 5 });
    const confirmSpy = vi.spyOn(window, 'confirm');
    restoreBtn(4).click();
    await settle();
    await reload();
    fixture.detectChanges();
    expect(restoreBtn(4).getAttribute('aria-busy')).toBe('true');
    expect(restoreBtn(4).getAttribute('aria-disabled')).toBe('true');
    expect(restoreBtn(4).textContent).toContain('Restoring…');
    const req = http.expectOne(`${BASE}/4/restore`);
    expect(req.request.body).toEqual({ revision: 5 });
    const newPage = page(6, ['four']);
    req.flush({ page: newPage, restored: true, warnings: [] });
    await settle();
    http.expectOne(`${BASE}?limit=50`).flush({ items: [item(6, { cause: 'restore', restoredFrom: 4 }), item(5), item(4)] });
    await tick(fixture);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalled();
    expect(restored).toHaveBeenCalledWith(newPage);
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Restored version 4. Saved as version 6. Visibility, tags and other settings were not changed.');
    expect(el.querySelector('li')!.textContent).toContain('Restored from version 4');
    expect(document.activeElement).toBe(el.querySelector('h2'));
    expect(button('Undo restore')).toBeDefined();
  });

  it('undo restore restores the version that was current', async () => {
    const { reload, el, http, fixture, restoreBtn, button, restored } = await mount([item(5), item(4)], { revision: 5 });
    restoreBtn(4).click();
    await settle();
    await reload();
    http.expectOne(`${BASE}/4/restore`).flush({ page: page(6), restored: true, warnings: [] });
    await settle();
    http.expectOne(`${BASE}?limit=50`).flush({ items: [item(6), item(5), item(4)] });
    await tick(fixture);
    // the editor now shows revision 6
    const prepare = vi.fn(async () => ({ ok: true, revision: 6 }));
    fixture.componentRef.setInput('prepare', prepare);
    button('Undo restore').click();
    await settle();
    await reload([item(6), item(5), item(4)]);
    const req = http.expectOne(`${BASE}/5/restore`);
    expect(req.request.body).toEqual({ revision: 6 });
    req.flush({ page: page(7, ['five']), restored: true, warnings: [] });
    await settle();
    http.expectOne(`${BASE}?limit=50`).flush({ items: [item(7), item(6), item(5), item(4)] });
    await tick(fixture);
    expect(restored).toHaveBeenCalledTimes(2);
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Undone. The page is back to version 5.');
    expect(button('Undo restore')).toBeUndefined();
  });

  it('undoes to the newest row even when the page revision is higher (saves that change nothing add no row)', async () => {
    const { reload, http, fixture, restoreBtn, button, el } = await mount([item(5), item(4)], { revision: 7 });
    restoreBtn(4).click();
    await settle();
    await reload();
    const first = http.expectOne(`${BASE}/4/restore`);
    expect(first.request.body).toEqual({ revision: 7 });
    first.flush({ page: page(8), restored: true, warnings: [] });
    await settle();
    http.expectOne(`${BASE}?limit=50`).flush({ items: [item(8), item(5), item(4)] });
    await tick(fixture);
    fixture.componentRef.setInput('prepare', vi.fn(async () => ({ ok: true, revision: 8 })));
    button('Undo restore').click();
    await settle();
    await reload([item(8), item(5), item(4)]);
    expect(http.expectOne(`${BASE}/5/restore`).request.body).toEqual({ revision: 8 });
    expect(el).toBeTruthy();
  });

  it('reads the list again after prepare, so the undo target is the row the flush created or folded into', async () => {
    const { http, fixture, restoreBtn, button, reload } = await mount([item(5), item(4)], { revision: 5 });
    restoreBtn(4).click();
    await settle();
    // the flush folded row 5 into row 6: the list now starts at 6
    await reload([item(6), item(4)]);
    http.expectOne(`${BASE}/4/restore`).flush({ page: page(7), restored: true, warnings: [] });
    await settle();
    http.expectOne(`${BASE}?limit=50`).flush({ items: [item(7), item(6), item(4)] });
    await tick(fixture);
    fixture.componentRef.setInput('prepare', vi.fn(async () => ({ ok: true, revision: 7 })));
    button('Undo restore').click();
    await settle();
    await reload([item(7), item(6), item(4)]);
    expect(http.expectOne(`${BASE}/6/restore`).request.body).toEqual({ revision: 7 });
  });

  it('ignores a second press of Restore while one restore runs', async () => {
    const { http, restoreBtn, reload } = await mount([item(5), item(4), item(3)]);
    restoreBtn(4).click();
    restoreBtn(3).click();
    restoreBtn(4).click();
    await settle();
    await reload();
    http.expectOne(`${BASE}/4/restore`);
    http.expectNone(`${BASE}/3/restore`);
  });

  it('renders script and image markup in titles, names and warnings as plain text', async () => {
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    const { el, http, fixture, restoreBtn, reload } = await mount([item(5), item(4, { title: evil, author: { id: 'u', displayName: evil } })]);
    expect(el.querySelector('img, script')).toBeNull();
    expect(el.textContent).toContain(evil);
    restoreBtn(4).click();
    await settle();
    await reload();
    http.expectOne(`${BASE}/4/restore`).flush({ page: page(6), restored: true, warnings: [evil] });
    await settle();
    http.expectOne(`${BASE}?limit=50`).flush({ items: [item(6), item(5), item(4)] });
    await tick(fixture);
    expect(el.querySelector('img, script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('ignores a late detail failure for a version that was unticked meanwhile', async () => {
    const { el, http, fixture, box } = await mount([item(5), item(4)]);
    box(4).click();
    const req = http.expectOne(`${BASE}/4`);
    box(4).click();
    err(req, 500);
    await tick(fixture);
    expect(alerts(el)).not.toContain('Could not load version 4');
    expect(el.textContent).not.toContain('Could not load version 4.');
  });

  it('drops loaded versions and ticks when the page changes', async () => {
    const { el, http, fixture, tickBox, box } = await mount([item(5), item(4)]);
    await tickBox(4, detail(4, ['x']));
    fixture.componentRef.setInput('page', { ...page(2), id: 'p2' });
    fixture.detectChanges();
    http.expectOne('/api/campaigns/c1/pages/p2/history?limit=50').flush({ items: [item(2)] });
    await tick(fixture);
    expect(el.querySelector('[data-diff]')).toBeNull();
    expect(box(4)).toBeNull();
    expect(el.textContent).toContain('This is the only version so far.');
  });

  describe.each([
    ['folds into a newer row', [item(6), item(4)]],
    ['creates a new row', [item(6), item(5), item(4)]],
  ])('when the flush before a restore %s and bumps refresh', (_name, serverList: HistoryItem[]) => {
    it('Undo targets the newest row of the final list, even though the refresh reload is in flight', async () => {
      const { http, fixture, restoreBtn, button } = await mount([item(5), item(4)], { revision: 5 });
      fixture.componentRef.setInput('prepare', async () => {
        // what the editor's real flush does: the save finishes, `savedCount` goes up, the panel's effect reloads the list
        fixture.componentRef.setInput('refresh', 1);
        fixture.detectChanges();
        await settle();
        return { ok: true, revision: 6 };
      });
      restoreBtn(4).click();
      await settle();
      const refreshReload = http.expectOne(`${BASE}?limit=50`);
      const head = http.expectOne(`${BASE}?limit=1`);
      head.flush({ items: serverList.slice(0, 1) });
      await settle();
      const post = http.expectOne(`${BASE}/4/restore`);
      expect(post.request.body).toEqual({ revision: 6 });
      refreshReload.flush({ items: serverList });
      post.flush({ page: page(7), restored: true, warnings: [] });
      await settle();
      http.expectOne(`${BASE}?limit=50`).flush({ items: [item(7), ...serverList] });
      await tick(fixture);
      fixture.componentRef.setInput('prepare', vi.fn(async () => ({ ok: true, revision: 7 })));
      button('Undo restore').click();
      await settle();
      http.expectOne(`${BASE}?limit=1`).flush({ items: [item(7)] });
      await settle();
      expect(http.expectOne(`${BASE}/6/restore`).request.body).toEqual({ revision: 7 });
    });
  });

  it('offers no Undo when the newest row could not be read', async () => {
    const { el, http, fixture, restoreBtn, button } = await mount([item(5), item(4)]);
    restoreBtn(4).click();
    await settle();
    err(http.expectOne(`${BASE}?limit=1`), 500);
    await settle();
    http.expectOne(`${BASE}/4/restore`).flush({ page: page(6), restored: true, warnings: [] });
    await settle();
    http.expectOne(`${BASE}?limit=50`).flush({ items: [item(6), item(5), item(4)] });
    await tick(fixture);
    expect(el.textContent).toContain('Restored version 4.');
    expect(button('Undo restore')).toBeUndefined();
  });

  it('tells the editor when a restore starts and ends writing', async () => {
    const { http, fixture, restoreBtn, reload, busy } = await mount([item(5), item(4)]);
    restoreBtn(4).click();
    await settle();
    await reload();
    expect(busy.mock.calls).toEqual([[true]]);
    http.expectOne(`${BASE}/4/restore`).flush({ page: page(6), restored: true, warnings: [] });
    await settle();
    http.expectOne(`${BASE}?limit=50`).flush({ items: [item(6), item(5), item(4)] });
    await tick(fixture);
    expect(busy.mock.calls).toEqual([[true], [false]]);
  });

  it('says the typing was kept, and offers no Undo, when the editor refuses a restored page', async () => {
    const { el, http, fixture, restoreBtn, reload, button, restored } = await mount([item(5), item(4)], { adopt: false });
    restoreBtn(4).click();
    await settle();
    await reload();
    http.expectOne(`${BASE}/4/restore`).flush({ page: page(6), restored: true, warnings: [] });
    await settle();
    http.expectOne(`${BASE}?limit=50`).flush({ items: [item(6), item(5), item(4)] });
    await tick(fixture);
    expect(restored).toHaveBeenCalled();
    expect(el.querySelector('[role="status"]')!.textContent).toContain(
      'Version 4 was restored. Your unsaved typing was kept and was not saved. Reload the page to see the restored version (this discards the typing).',
    );
    expect(button('Undo restore')).toBeUndefined();
  });

  it('says the typing was kept when the editor refuses the newer page after a 409', async () => {
    const { el, http, fixture, restoreBtn, reload } = await mount([item(5), item(4)], { adopt: false });
    restoreBtn(4).click();
    await settle();
    await reload();
    err(http.expectOne(`${BASE}/4/restore`), 409, { error: 'changed', details: { current: page(6) } });
    await settle();
    http.expectOne(`${BASE}/4`).flush(detail(4, ['four']));
    http.expectOne(`${BASE}?limit=50`).flush({ items: [item(6), item(5), item(4)] });
    await tick(fixture);
    expect(alerts(el)).toContain('Your unsaved typing was kept and was not saved. Reload the page to see the newest version (this discards the typing).');
  });

  it('shows a notice when the change is too large to diff line by line', async () => {
    const lines = Array.from({ length: 1300 }, (_, i) => `x${i}`);
    const { el, fixture, tickBox } = await mount([item(5), item(4)]);
    fixture.componentRef.setInput('page', page(5, lines.map((l) => l.replace('x', 'y'))));
    fixture.detectChanges();
    await tickBox(4, detail(4, lines));
    expect(el.textContent).toContain('Large change, shown as a block.');
    expect(el.querySelectorAll('del').length).toBeGreaterThan(100);
  });

  it('says nothing changed when restored is false, with no Undo', async () => {
    const { reload, el, http, fixture, restoreBtn, button } = await mount([item(5), item(4)]);
    restoreBtn(4).click();
    await settle();
    await reload();
    http.expectOne(`${BASE}/4/restore`).flush({ page: page(5), restored: false, warnings: [] });
    await settle();
    http.expectOne(`${BASE}?limit=50`).flush({ items: [item(5), item(4)] });
    await tick(fixture);
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Version 4 already matches the current page, so nothing changed.');
    expect(button('Undo restore')).toBeUndefined();
  });

  it('shows warnings as text until dismissed', async () => {
    const { reload, el, http, fixture, restoreBtn, button } = await mount([item(5), item(4)]);
    restoreBtn(4).click();
    await settle();
    await reload();
    http.expectOne(`${BASE}/4/restore`).flush({ page: page(6), restored: true, warnings: ['The page linked in "Patron" no longer exists; the link was cleared', '<b>x</b>'] });
    await settle();
    http.expectOne(`${BASE}?limit=50`).flush({ items: [item(6), item(5), item(4)] });
    await tick(fixture);
    const status = el.querySelector('[role="status"]')!;
    expect(status.textContent).toContain('Restored with notes');
    expect(status.textContent).toContain('The page linked in "Patron" no longer exists; the link was cleared');
    expect(status.querySelector('b')).toBeNull();
    button('Dismiss').click();
    await tick(fixture);
    expect(status.textContent).not.toContain('Restored with notes');
  });

  it('on a stale 409 emits the newer page, keeps the target ticked, alerts and never retries', async () => {
    const { reload, el, http, fixture, restoreBtn, stale, restored, box } = await mount([item(5), item(4)], { revision: 5 });
    const button = restoreBtn(4);
    button.focus();
    button.click();
    await settle();
    await reload();
    const newer = page(6, ['someone else']);
    err(http.expectOne(`${BASE}/4/restore`), 409, { error: 'This page was changed by someone else', details: { current: newer } });
    await settle();
    http.expectOne(`${BASE}/4`).flush(detail(4, ['four']));
    http.expectOne(`${BASE}?limit=50`).flush({ items: [item(6), item(5), item(4)] });
    await tick(fixture);
    expect(stale).toHaveBeenCalledWith(newer);
    expect(restored).not.toHaveBeenCalled();
    expect(alerts(el)).toContain('This page was changed by someone else just now. The newest version is loaded.');
    expect(alerts(el)).toContain('version 4');
    expect(box(4).checked).toBe(true);
    expect(document.activeElement).toBe(restoreBtn(4));
    http.expectNone(`${BASE}/4/restore`);
  });

  it('fetches the page itself when the 409 body has none', async () => {
    const { reload, http, fixture, restoreBtn, stale } = await mount([item(5), item(4)]);
    restoreBtn(4).click();
    await settle();
    await reload();
    err(http.expectOne(`${BASE}/4/restore`), 409, { error: 'changed' });
    await settle();
    const newer = page(6);
    http.expectOne('/api/campaigns/c1/pages/p1').flush(newer);
    await settle();
    http.expectOne(`${BASE}/4`).flush(detail(4, ['four']));
    http.expectOne(`${BASE}?limit=50`).flush({ items: [item(6), item(5), item(4)] });
    await tick(fixture);
    expect(stale).toHaveBeenCalledWith(newer);
  });

  it('shows other restore errors and keeps focus on the pressed button', async () => {
    const { el, http, fixture, restoreBtn, restored, reload } = await mount([item(5), item(4)]);
    const b = restoreBtn(4);
    b.focus();
    b.click();
    await settle();
    await reload();
    err(http.expectOne(`${BASE}/4/restore`), 500, { error: 'Disk full' });
    await tick(fixture);
    expect(alerts(el)).toContain('Disk full');
    expect(restored).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(b);
    expect(b.getAttribute('aria-busy')).toBeNull();
  });

  it('does not call the server when the editor has a save problem', async () => {
    const prepare = vi.fn(async () => ({ ok: false, revision: 5 }));
    const { el, http, fixture, restoreBtn } = await mount([item(5), item(4)], { prepare });
    restoreBtn(4).click();
    await tick(fixture);
    expect(alerts(el)).toContain('Resolve the save problem on the page first.');
    http.expectNone(`${BASE}/4/restore`);
  });

  it('Close and Escape emit closed', async () => {
    const { el, closed, button } = await mount([item(5)]);
    button('Close').click();
    el.querySelector('section')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it('has an accessible name on the section and focuses the heading on open', async () => {
    const { el } = await mount([item(5)]);
    const section = el.querySelector('section')!;
    expect(section.getAttribute('aria-labelledby')).toBe('cn-history-h');
    expect(el.querySelector('#cn-history-h')!.textContent).toBe('History');
    expect(document.activeElement).toBe(el.querySelector('h2'));
    expect(el.querySelector('fieldset legend')!.textContent).toBe('Versions to compare');
  });
});
