import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { LayoutService } from '../core/layout.service';
import { CampaignShell } from './campaign-shell';
import { CampaignStore } from './campaign.store';

async function setup(isGm = true) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', children: [] }]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: AuthService, useValue: { user: signal(null) } },
    ],
  });
  const fixture = TestBed.createComponent(CampaignShell);
  fixture.componentRef.setInput('campaignId', 'c1');
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  http
    .match('/api/campaigns/c1')
    .forEach((r) =>
      r.flush({
        id: 'c1',
        name: 'The Lantern Coast Chronicles',
        ruleset: '2014',
        crossEdition: false,
        sourceOverrides: {},
        role: isGm ? 'dm' : 'player',
      }),
    );
  http.match('/api/campaigns/c1/pages').forEach((r) => r.flush({ pages: [] }));
  http.match('/api/campaigns/c1/properties').forEach((r) => r.flush({ properties: [] }));
  http.match('/api/campaigns/c1/trackers/active').forEach((r) => r.flush({ trackers: [] }));
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, layout: TestBed.inject(LayoutService), store: TestBed.inject(CampaignStore, null) };
}

describe('campaign drawer', () => {
  it('has no own "Campaign" button any more; the header opens the drawer through the layout service', async () => {
    const { el } = await setup();
    expect(Array.from(el.querySelectorAll('button')).some((b) => b.textContent?.includes('☰'))).toBe(false);
  });

  it('is named, gets a close button, 44px rows and a non-truncated campaign name', async () => {
    const { el, fixture, layout } = await setup();
    const drawer = el.querySelector<HTMLElement>('#campaign-drawer')!;
    expect(drawer.getAttribute('aria-label')).toBe('Campaign navigation');
    expect(drawer.className).toContain('max-lg:hidden');
    layout.drawerOpen.set(true);
    fixture.detectChanges();
    expect(drawer.className).not.toContain('max-lg:hidden');
    const close = drawer.querySelector<HTMLButtonElement>('button[aria-label="Close campaign navigation"]')!;
    expect(close).not.toBeNull();
    const name = drawer.querySelector('h2')!;
    expect(name.textContent).toContain('The Lantern Coast Chronicles');
    expect(name.className).not.toContain('truncate');
    for (const a of Array.from(drawer.querySelectorAll('nav a'))) expect(a.className).toContain('min-h-[44px]');
    expect(drawer.querySelector('nav')!.className).toContain('short:grid-cols-2');
  });

  it('makes the content inert while open; the close button, Escape and the backdrop close it', async () => {
    const { el, fixture, layout } = await setup();
    const content = el.querySelector('section')!;
    expect(content.hasAttribute('inert')).toBe(false);
    layout.drawerOpen.set(true);
    fixture.detectChanges();
    expect(content.hasAttribute('inert')).toBe(true);
    el.querySelector<HTMLButtonElement>('button[aria-label="Close campaign navigation"]')!.click();
    expect(layout.drawerOpen()).toBe(false);

    layout.drawerOpen.set(true);
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(layout.drawerOpen()).toBe(false);

    layout.drawerOpen.set(true);
    fixture.detectChanges();
    el.querySelector<HTMLElement>('.z-35')!.click();
    expect(layout.drawerOpen()).toBe(false);
  });

  it('closes when a link is followed and when the shell is destroyed', async () => {
    const { el, fixture, layout } = await setup();
    layout.drawerOpen.set(true);
    fixture.detectChanges();
    el.querySelector<HTMLElement>('nav a')!.click();
    await fixture.whenStable();
    expect(layout.drawerOpen()).toBe(false);
    layout.drawerOpen.set(true);
    fixture.destroy();
    expect(layout.drawerOpen()).toBe(false);
  });
});

describe('drawer focus trap', () => {
  it('wraps Tab from the last control to the first and Shift+Tab the other way', async () => {
    const { el, fixture, layout } = await setup();
    document.body.append(el);
    layout.compact.set(true);
    layout.drawerOpen.set(true);
    fixture.detectChanges();
    const drawer = el.querySelector<HTMLElement>('#campaign-drawer')!;
    // jsdom has no layout: give every control a client rect so the trap sees them
    for (const e of Array.from(drawer.querySelectorAll<HTMLElement>('a[href], button'))) e.getClientRects = () => [{}] as unknown as DOMRectList;
    const items = Array.from(drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
    const first = items[0]!;
    const last = items[items.length - 1]!;
    last.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    last.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    first.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    el.remove();
  });
});

describe('layout service', () => {
  it('resets the drawer when the window grows past lg', () => {
    let listener: ((e: { matches: boolean }) => void) | undefined;
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: true,
      media: q,
      addEventListener: (_: string, l: typeof listener) => (listener = l),
    })) as never;
    try {
      const layout = TestBed.inject(LayoutService);
      expect(layout.compact()).toBe(true);
      layout.drawerOpen.set(true);
      listener?.({ matches: false });
      expect(layout.compact()).toBe(false);
      expect(layout.drawerOpen()).toBe(false);
    } finally {
      window.matchMedia = original;
    }
  });
});
