import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { TrashEntryDto } from '@cn/shared';
import { CampaignStore } from './campaign.store';
import { CampaignTrash } from './trash';

const settle = () => new Promise((r) => setTimeout(r));
async function tick(f: ComponentFixture<unknown>) {
  await settle();
  f.detectChanges();
  await settle();
  f.detectChanges();
}
const DAY = 86_400_000;
const entry = (id: string, title: string, extra: Partial<TrashEntryDto> = {}): TrashEntryDto => ({ id, title, type: 'location', icon: null, subpageCount: 0, deletedAt: Date.now(), ...extra });
const err = (r: TestRequest, status: number, body: object = {}) => r.flush(body, { status, statusText: String(status) });

async function mount(items: TrashEntryDto[] | number = []) {
  const reloadPages = vi.fn(async () => undefined);
  const clearUndoFor = vi.fn();
  TestBed.configureTestingModule({
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: CampaignStore, useValue: { id: signal('c1'), reloadPages, clearUndoFor } }],
  });
  const fixture = TestBed.createComponent(CampaignTrash);
  const http = TestBed.inject(HttpTestingController);
  document.body.append(fixture.nativeElement);
  fixture.detectChanges();
  const req = http.expectOne('/api/campaigns/c1/trash');
  if (typeof items === 'number') err(req, items, { error: 'Forbidden' });
  else req.flush({ items });
  await tick(fixture);
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, http, reloadPages, clearUndoFor, rows: () => Array.from(el.querySelectorAll('li')), btn: (row: number, a: string) => el.querySelectorAll('li')[row].querySelector<HTMLButtonElement>(`[data-action="${a}"]`)! };
}

describe('CampaignTrash', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('shows the loading state, then the empty state', async () => {
    const { el } = await mount([]);
    expect(el.textContent).toContain('The trash is empty.');
    expect(el.querySelector('ul')).toBeNull();
  });

  it('lists newest first with subpage count and age text', async () => {
    const { rows, el } = await mount([entry('a', 'Old', { deletedAt: Date.now() - 28 * DAY, subpageCount: 3 }), entry('b', 'New', { subpageCount: 1 })]);
    expect(rows().map((r) => r.querySelector('p')!.textContent!.trim())).toEqual(['📍 New', '📍 Old']);
    expect(rows()[0].textContent).toContain('1 subpage');
    expect(rows()[0].textContent).toContain('Deleted today');
    expect(rows()[0].textContent).toContain('purged in 30 days');
    expect(rows()[1].textContent).toContain('3 subpages');
    expect(rows()[1].textContent).toContain('Deleted 28 days ago');
    expect(rows()[1].textContent).toContain('purged in 2 days');
    expect(rows()[1].querySelector('p.text-accent')).not.toBeNull();
    expect(rows()[0].querySelector('p.text-accent')).toBeNull();
    expect(el.querySelector('[aria-label="Restore Old"]')).not.toBeNull();
  });

  it('shows the error with Try again, and a way back on 403', async () => {
    const { el, http, fixture } = await mount(403);
    expect(Array.from(el.querySelectorAll('[role="alert"]')).map((a) => a.textContent).join()).toContain('Forbidden');
    expect(el.textContent).toContain('Back to the campaign');
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Try again')) as HTMLButtonElement).click();
    http.expectOne('/api/campaigns/c1/trash').flush({ items: [] });
    await tick(fixture);
    expect(el.textContent).toContain('The trash is empty.');
  });

  it('restores a row, reports subpages, reloads the tree and moves focus to the next row', async () => {
    const { el, http, fixture, btn, rows, reloadPages } = await mount([entry('a', 'Harbour', { deletedAt: Date.now() }), entry('b', 'Aldric', { deletedAt: Date.now() - DAY })]);
    btn(0, 'restore').click();
    const req = http.expectOne('/api/campaigns/c1/pages/a/restore');
    expect(req.request.method).toBe('POST');
    req.flush({ restored: ['a', 'x', 'y'] });
    await tick(fixture);
    expect(rows().length).toBe(1);
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Restored "Harbour" with 2 subpages.');
    expect(el.querySelector('[role="status"] a')!.textContent).toContain('Open page');
    expect(reloadPages).toHaveBeenCalled();
    expect(document.activeElement).toBe(btn(0, 'restore'));
  });

  it('asks before deleting permanently, naming subpages; cancel does nothing', async () => {
    const { http, fixture, btn, rows, el } = await mount([entry('a', 'Harbour', { subpageCount: 3 })]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    btn(0, 'purge').click();
    expect(confirmSpy).toHaveBeenLastCalledWith('Permanently delete "Harbour" and its 3 subpages? This cannot be undone.');
    http.expectNone('/api/campaigns/c1/pages/a/purge');
    btn(0, 'purge').click();
    const req = http.expectOne('/api/campaigns/c1/pages/a/purge');
    expect(req.request.method).toBe('DELETE');
    req.flush({ purged: ['a', '1', '2', '3'] });
    await tick(fixture);
    expect(rows().length).toBe(0);
    expect(el.textContent).toContain('Permanently deleted "Harbour" and 3 subpages.');
    expect(document.activeElement).toBe(el.querySelector('h1'));
  });

  it('treats 404 as no longer in the trash and refreshes the list', async () => {
    const { el, http, fixture, btn, rows } = await mount([entry('a', 'Harbour'), entry('b', 'Aldric', { deletedAt: Date.now() - DAY })]);
    btn(0, 'restore').click();
    err(http.expectOne('/api/campaigns/c1/pages/a/restore'), 404, { error: 'Not found' });
    await settle();
    // The refresh is silent: the list stays mounted and focus survives it
    expect(el.querySelector('ul')).not.toBeNull();
    http.expectOne('/api/campaigns/c1/trash').flush({ items: [entry('b', 'Aldric', { deletedAt: Date.now() - DAY })] });
    await tick(fixture);
    expect(rows().length).toBe(1);
    expect(document.activeElement).toBe(btn(0, 'restore'));
    expect(el.textContent).toContain('"Harbour" is no longer in the trash.');
    expect(el.querySelector('[role="alert"]')!.textContent!.trim()).toBe('');
  });

  it('keeps the row and shows an alert on other failures', async () => {
    const { el, http, fixture, btn, rows } = await mount([entry('a', 'Harbour')]);
    btn(0, 'restore').click();
    err(http.expectOne('/api/campaigns/c1/pages/a/restore'), 500, { error: 'Boom' });
    await tick(fixture);
    expect(rows().length).toBe(1);
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('Boom');
  });

  it('shows the busy state and ignores a second click while a request runs', async () => {
    const { http, fixture, btn, el } = await mount([entry('a', 'Harbour'), entry('b', 'Aldric', { deletedAt: Date.now() - DAY })]);
    btn(0, 'restore').click();
    fixture.detectChanges();
    expect(btn(0, 'restore').getAttribute('aria-disabled')).toBe('true');
    expect(btn(0, 'restore').textContent).toContain('Restoring…');
    btn(1, 'restore').click();
    btn(0, 'restore').click();
    http.expectOne('/api/campaigns/c1/pages/a/restore').flush({ restored: ['a'] });
    http.expectNone('/api/campaigns/c1/pages/b/restore');
    await tick(fixture);
    expect(el.querySelectorAll('li').length).toBe(1);
  });

  it('treats 400 on restore as no longer in the trash', async () => {
    const { el, http, fixture, btn } = await mount([entry('a', 'Harbour')]);
    btn(0, 'restore').click();
    err(http.expectOne('/api/campaigns/c1/pages/a/restore'), 400, { error: 'Not deleted' });
    await settle();
    http.expectOne('/api/campaigns/c1/trash').flush({ items: [] });
    await tick(fixture);
    expect(el.textContent).toContain('"Harbour" is no longer in the trash.');
  });

  it('treats 404 on purge as no longer in the trash', async () => {
    const { el, http, fixture, btn, rows } = await mount([entry('a', 'Harbour')]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    btn(0, 'purge').click();
    err(http.expectOne('/api/campaigns/c1/pages/a/purge'), 404, { error: 'Not found' });
    await settle();
    http.expectOne('/api/campaigns/c1/trash').flush({ items: [] });
    await tick(fixture);
    expect(rows().length).toBe(0);
    expect(el.textContent).toContain('"Harbour" is no longer in the trash.');
  });

  it('clears a toast that still offers the restored page', async () => {
    const { http, fixture, btn, clearUndoFor } = await mount([entry('a', 'Harbour')]);
    btn(0, 'restore').click();
    http.expectOne('/api/campaigns/c1/pages/a/restore').flush({ restored: ['a'] });
    await tick(fixture);
    expect(clearUndoFor).toHaveBeenCalledWith('a');
  });

  it('Try again moves focus to the heading', async () => {
    const { el, http, fixture } = await mount(500);
    const retry = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Try again')) as HTMLButtonElement;
    retry.focus();
    retry.click();
    http.expectOne('/api/campaigns/c1/trash').flush({ items: [] });
    await tick(fixture);
    expect(document.activeElement).toBe(el.querySelector('h1'));
  });

  it('marks the busy row button aria-busy', async () => {
    const { fixture, btn } = await mount([entry('a', 'Harbour')]);
    btn(0, 'restore').click();
    fixture.detectChanges();
    expect(btn(0, 'restore').getAttribute('aria-busy')).toBe('true');
  });
});
