import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { CampaignStore } from '../campaign.store';
import { LiveService, TOAST_MS, type LiveToast as Toast } from './live.service';
import { LiveToast } from './live-toast';

const toast = (seq: number, titles: string[]): Toast => ({ seq, id: seq, summary: null, reload: false, items: titles.map((t, i) => ({ kind: 'shared', pageId: `p${i}`, title: t })) });

async function setup() {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), CampaignStore, LiveService, { provide: AuthService, useValue: { user: signal(null) } }],
  });
  TestBed.inject(CampaignStore).campaign.set({ id: 'c1', role: 'player', ruleset: 'x' } as never);
  const live = TestBed.inject(LiveService);
  const fixture = TestBed.createComponent(LiveToast);
  document.body.append(fixture.nativeElement);
  fixture.detectChanges();
  const flush = async () => {
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
  };
  return { live, fixture, el: fixture.nativeElement as HTMLElement, flush };
}

describe('live toast', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('keeps its live region in the DOM, shows plain text and an Open button, and dismisses after 8 s', async () => {
    const { live, el, flush } = await setup();
    expect(el.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
    live.toast.set(toast(1, ['<b>Map</b>']));
    await flush();
    expect(el.textContent).toContain('New: <b>Map</b>');
    expect(el.querySelector('b')).toBeNull();
    expect(Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim())).toContain('Open');
    await vi.advanceTimersByTimeAsync(TOAST_MS - 100);
    await flush();
    expect(live.toast()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(live.toast()).toBeNull();
  });

  it('pauses on hover and dismisses on Escape', async () => {
    const { live, el, flush } = await setup();
    live.toast.set(toast(1, ['Map']));
    await flush();
    const card = el.querySelector('[role="status"] > div') as HTMLElement;
    card.dispatchEvent(new MouseEvent('mouseenter'));
    await flush();
    await vi.advanceTimersByTimeAsync(TOAST_MS * 2);
    expect(live.toast()).not.toBeNull();
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flush();
    expect(live.toast()).toBeNull();
  });

  it('a merge into a hovered toast keeps it paused; a fresh toast resets the pause; Escape stays inside the toast', async () => {
    const { live, el, flush } = await setup();
    live.toast.set(toast(1, ['Map']));
    await flush();
    const card = el.querySelector('[role="status"] > div') as HTMLElement;
    card.dispatchEvent(new MouseEvent('mouseenter'));
    await flush();
    live.toast.set({ ...toast(2, ['Map', 'Letter']), id: 1 });
    await flush();
    await vi.advanceTimersByTimeAsync(TOAST_MS * 2);
    expect(live.toast()).not.toBeNull();
    const outer = vi.fn();
    document.body.addEventListener('keydown', outer);
    (el.querySelector('[role="status"] > div') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(outer).not.toHaveBeenCalled();
    document.body.removeEventListener('keydown', outer);
    live.toast.set(toast(3, ['Other']));
    await flush();
    await vi.advanceTimersByTimeAsync(TOAST_MS + 100);
    expect(live.toast()).toBeNull();
  });

  it('a merged toast for an unsaved page still offers Reload, with the honest note', async () => {
    const { live, el, flush } = await setup();
    live.toast.set({ ...toast(1, ['Map', 'Letter']), reload: true });
    await flush();
    expect(Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim())).toContain('Reload');
    expect(el.textContent).toContain("The DM changed this page. If your unsaved text can't be saved it stays here until you copy it.");
  });

  it('collapsed toast opens a list of links with View', async () => {
    const { live, el, flush } = await setup();
    live.toast.set(toast(1, ['Map', 'Letter']));
    await flush();
    expect(el.textContent).toContain('2 new things: Map and 1 more');
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'View') as HTMLButtonElement).click();
    await flush();
    expect(Array.from(el.querySelectorAll('ul a')).map((a) => a.textContent?.trim())).toEqual(['Map', 'Letter']);
  });

  it('shows the paused notice with Resume', async () => {
    const { live, el, flush } = await setup();
    live.state.set('paused');
    await flush();
    expect(el.textContent).toContain('Live updates paused in this tab');
    expect(Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim())).toContain('Resume');
  });
});
