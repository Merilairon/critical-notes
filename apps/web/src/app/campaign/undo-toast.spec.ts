import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { PageSummaryDto } from '@cn/shared';
import { AuthService } from '../core/auth.service';
import { CampaignStore } from './campaign.store';
import { UndoToast, UNDO_SECONDS } from './undo-toast';

const page = (id: string, parentId: string | null, title = id): PageSummaryDto => ({ id, parentId, title, type: 'location', sortKey: id } as PageSummaryDto);
const flushAll = async (f: { detectChanges(): void }) => {
  await vi.advanceTimersByTimeAsync(0);
  f.detectChanges();
  await vi.advanceTimersByTimeAsync(0);
  f.detectChanges();
};

async function setup() {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), CampaignStore, { provide: AuthService, useValue: { user: signal(null) } }],
  });
  const store = TestBed.inject(CampaignStore);
  store.campaign.set({ id: 'c1', role: 'dm', ruleset: 'x' } as never);
  store.pages.set([page('a', null, 'Harbour'), page('b', 'a'), page('c', 'b'), page('d', null)]);
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(UndoToast);
  document.body.append(fixture.nativeElement);
  fixture.detectChanges();
  const del = async (id: string) => {
    const p = store.deletePage(id);
    http.expectOne({ method: 'DELETE', url: `/api/campaigns/c1/pages/${id}` }).flush(null);
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('/api/campaigns/c1/pages').flush({ pages: store.pages().filter((x) => x.id !== id && x.parentId !== id) });
    await p;
    await flushAll(fixture);
  };
  return { store, http, fixture, el: fixture.nativeElement as HTMLElement, del };
}

describe('undo toast', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('keeps its live region in the DOM and announces the subpage count and time limit', async () => {
    const { el, del } = await setup();
    expect(el.querySelector('[role="status"]')).not.toBeNull();
    await del('a');
    expect(el.textContent).toContain('Deleted "Harbour" and 2 subpages');
    expect(el.textContent).toContain(`Undo is available for ${UNDO_SECONDS} seconds.`);
  });

  it('says nothing about subpages for a leaf', async () => {
    const { el, del } = await setup();
    await del('d');
    expect(el.textContent).toContain('Deleted "d"');
    expect(el.textContent).not.toContain('subpage');
  });

  it('expires after 10 seconds, pausing while hovered', async () => {
    const { store, el, del, fixture } = await setup();
    await del('d');
    const card = el.querySelector('[role="status"] > div') as HTMLElement;
    card.dispatchEvent(new Event('mouseenter'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(store.undo()).not.toBeNull();
    card.dispatchEvent(new Event('mouseleave'));
    await flushAll(fixture);
    await vi.advanceTimersByTimeAsync(UNDO_SECONDS * 1000);
    expect(store.undo()).toBeNull();
  });

  it('undo restores, navigates to the page and confirms', async () => {
    const { store, el, http, del, fixture } = await setup();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await del('d');
    (el.querySelector('button[aria-label^="Undo delete"]') as HTMLButtonElement).click();
    http.expectOne({ method: 'POST', url: '/api/campaigns/c1/pages/d/restore' }).flush({ restored: ['d'] });
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('/api/campaigns/c1/pages').flush({ pages: [page('d', null)] });
    await flushAll(fixture);
    expect(nav).toHaveBeenCalledWith(['/c', 'c1', 'p', 'd']);
    expect(store.undo()).toBeNull();
    expect(el.textContent).toContain('Restored "d"');
  });

  it('shows a persistent alert with a Trash link when undo fails, and only one toast for two deletes', async () => {
    const { store, el, http, del, fixture } = await setup();
    await del('d');
    await del('a');
    expect(store.undo()?.pageId).toBe('a');
    (el.querySelector('button[aria-label^="Undo delete"]') as HTMLButtonElement).click();
    http.expectOne('/api/campaigns/c1/pages/a/restore').flush({ error: 'x' }, { status: 500, statusText: 'err' });
    await flushAll(fixture);
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('Could not undo. Open the trash to restore it.');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.undo()).not.toBeNull();
  });

  it('records the subpage count of the delete on the store', async () => {
    const { store, del } = await setup();
    await del('a');
    expect(store.undo()).toEqual({ pageId: 'a', title: 'Harbour', subpages: 2 });
  });

  it('after a failed undo, a new delete shows a normal toast with a running timer', async () => {
    const { store, el, http, del, fixture } = await setup();
    await del('a');
    (el.querySelector('button[aria-label^="Undo delete"]') as HTMLButtonElement).click();
    http.expectOne('/api/campaigns/c1/pages/a/restore').flush({}, { status: 500, statusText: 'err' });
    await flushAll(fixture);
    expect(store.undoFailed()).toBe(true);
    await del('d');
    expect(store.undoFailed()).toBe(false);
    expect(el.querySelector('button[aria-label^="Undo delete"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(UNDO_SECONDS * 1000);
    expect(store.undo()).toBeNull();
  });

  it('Escape and the dismiss button remove the offer', async () => {
    const { store, el, del, fixture } = await setup();
    await del('d');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushAll(fixture);
    expect(store.undo()).toBeNull();
    await del('a');
    (el.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement).click();
    await flushAll(fixture);
    expect(store.undo()).toBeNull();
  });

  it('pauses while focus is inside and a replacing delete does not inherit the pause', async () => {
    const { store, el, del, fixture } = await setup();
    await del('d');
    const card = el.querySelector('[role="status"] > div') as HTMLElement;
    card.dispatchEvent(new Event('focusin'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(store.undo()).not.toBeNull();
    await del('a');
    await vi.advanceTimersByTimeAsync(UNDO_SECONDS * 1000);
    expect(store.undo()).toBeNull();
    void fixture;
  });

  it('leave() clears the offer and the notice', async () => {
    const { store, del } = await setup();
    await del('d');
    store.toast.set('x');
    store.leave();
    expect(store.undo()).toBeNull();
    expect(store.toast()).toBeNull();
  });

  it('the Restored notice disappears after 4 seconds', async () => {
    const { store, fixture } = await setup();
    store.toast.set('Restored "d"');
    await flushAll(fixture);
    await vi.advanceTimersByTimeAsync(4000);
    expect(store.toast()).toBeNull();
  });

  it('a stale undo result does not touch a newer offer', async () => {
    const { store, el, http, del, fixture } = await setup();
    await del('a');
    (el.querySelector('button[aria-label^="Undo delete"]') as HTMLButtonElement).click();
    const req = http.expectOne('/api/campaigns/c1/pages/a/restore');
    await del('d');
    req.flush({}, { status: 500, statusText: 'err' });
    await flushAll(fixture);
    expect(store.undo()?.pageId).toBe('d');
    expect(store.undoFailed()).toBe(false);
  });

  it('clearUndoFor drops only the matching offer', async () => {
    const { store, del } = await setup();
    await del('d');
    store.clearUndoFor('zzz');
    expect(store.undo()).not.toBeNull();
    store.clearUndoFor('d');
    expect(store.undo()).toBeNull();
  });

  function addMain() {
    const main = document.createElement('div');
    main.setAttribute('data-campaign-main', '');
    main.tabIndex = -1;
        document.body.append(main);
    return main;
  }

  it('Dismiss puts focus on the content container when the page has no focusable heading', async () => {
    const { el, del, fixture } = await setup();
    const main = addMain();
    await del('d');
    const dismiss = el.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement;
    dismiss.focus();
    dismiss.click();
    await flushAll(fixture);
    await vi.advanceTimersByTimeAsync(10);
    expect(document.activeElement).toBe(main);
  });

  it('after Undo, focus waits for the restored page title field', async () => {
    const { el, http, del, fixture } = await setup();
    const main = addMain();
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await del('d');
    (el.querySelector('button[aria-label^="Undo delete"]') as HTMLButtonElement).click();
    http.expectOne('/api/campaigns/c1/pages/d/restore').flush({ restored: ['d'] });
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('/api/campaigns/c1/pages').flush({ pages: [] });
    await flushAll(fixture);
    await vi.advanceTimersByTimeAsync(120);
    expect(document.activeElement).not.toBe(main);
    const input = document.createElement('input');
    input.setAttribute('aria-label', 'Page title');
    main.append(input);
    await vi.advanceTimersByTimeAsync(100);
    expect(document.activeElement).toBe(input);
  });

  it('after a failed Undo, focus moves to the Trash link', async () => {
    const { el, http, del, fixture } = await setup();
    await del('d');
    const undo = el.querySelector('button[aria-label^="Undo delete"]') as HTMLButtonElement;
    undo.focus();
    undo.click();
    http.expectOne('/api/campaigns/c1/pages/d/restore').flush({}, { status: 500, statusText: 'err' });
    await flushAll(fixture);
    await vi.advanceTimersByTimeAsync(10);
    fixture.detectChanges();
    expect(document.activeElement).toBe(el.querySelector('a'));
  });
});
