import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { UserDto } from '@cn/shared';
import { App } from './app';
import { AuthService } from './core/auth.service';
import { ConfirmService } from './core/confirm.service';
import { ContextService } from './core/context.service';
import { DiceService } from './core/dice.service';
import { LayoutService } from './core/layout.service';

function mount(user: UserDto | null): ComponentFixture<App> {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', children: [] }]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: AuthService, useValue: { user: signal(user), logout: async () => undefined } },
    ],
  });
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  return fixture;
}
function header(user: UserDto | null) {
  return mount(user).nativeElement as HTMLElement;
}
const usersLink = (el: HTMLElement) => el.querySelector('a[href="/admin/users"]');
const admin: UserDto = { id: 'a', username: 'a', displayName: 'A', isAdmin: true };
const player: UserDto = { id: 'p', username: 'p', displayName: 'P', isAdmin: false };
const button = (el: HTMLElement, name: string) => el.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
const menu = (el: HTMLElement) => el.querySelector('#app-menu');

describe('header', () => {
  it('swallows Ctrl+K while a confirm dialog is open (no browser search) and opens the palette otherwise', () => {
    const fixture = mount(player);
    const press = () => {
      const e = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true });
      document.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const confirm = TestBed.inject(ConfirmService);
    void confirm.ask({ title: 'Sure?', message: 'Sure?', confirmLabel: 'Yes' });
    expect(press()).toBe(true);
    expect((fixture.componentInstance as unknown as { paletteOpen: () => boolean }).paletteOpen()).toBe(false);
    confirm.settle(false);
    expect(press()).toBe(true);
    expect((fixture.componentInstance as unknown as { paletteOpen: () => boolean }).paletteOpen()).toBe(true);
  });

  it('shows the Users link to admins only', () => {
    expect(usersLink(header(admin))?.textContent?.trim()).toBe('Users');
    TestBed.resetTestingModule();
    expect(usersLink(header(player))).toBeNull();
    TestBed.resetTestingModule();
    expect(usersLink(header(null))).toBeNull();
  });

  it('has no menu button and no popovers when signed out, only the theme button', () => {
    const el = header(null);
    expect(button(el, 'Menu')).toBeNull();
    expect(el.querySelector('header button[aria-label^="Theme:"]')).not.toBeNull();
  });

  it('keeps the compact header free of headings, badges and Create/Delete buttons (the e2e specs select those)', () => {
    const el = header(admin);
    button(el, 'Menu')!.click();
    const h = el.querySelector('header')!;
    for (const b of Array.from(h.querySelectorAll('button')))
      expect(b.textContent).not.toMatch(/^\s*(Create|Delete)\s*$/);
    expect(h.querySelector('h1, h2, h3, .cn-badge')).toBeNull();
  });

  it('renders the app menu only while open, with the groups in order and 44px rows', () => {
    const fixture = mount(admin);
    const el = fixture.nativeElement as HTMLElement;
    expect(menu(el)).toBeNull();
    const btn = button(el, 'Menu')!;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    btn.click();
    fixture.detectChanges();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const m = menu(el)!;
    expect(Array.from(m.querySelectorAll('[role="group"] > p')).map((p) => p.textContent?.trim())).toEqual([
      'Navigate',
      'Rules',
      'Administration',
      'Preferences',
      'Account',
    ]);
    expect(
      Array.from(m.querySelectorAll('[role="group"]')[0]!.querySelectorAll('a')).map((a) => a.textContent?.trim()),
    ).toEqual(['Campaigns', 'Reference', 'Homebrew', 'Templates']);
    expect(
      Array.from(m.querySelectorAll('[role="group"]')[2]!.querySelectorAll('a')).map((a) => a.textContent?.trim()),
    ).toEqual(['Users', 'Backups']);
    expect(m.textContent).toContain('Sign out');
    expect(m.querySelector('h1, h2, h3')).toBeNull();
    for (const row of Array.from(m.querySelectorAll('a, button'))) expect(row.className).toContain('min-h-[44px]');
  });

  it('hides the Administration group from players and shows the rules edition choice off campaign pages', () => {
    const fixture = mount(player);
    const el = fixture.nativeElement as HTMLElement;
    button(el, 'Menu')!.click();
    fixture.detectChanges();
    const m = menu(el)!;
    expect(m.textContent).not.toContain('Administration');
    expect(m.querySelector('select')).not.toBeNull();
    expect(m.textContent).toContain('Sources');
  });

  it('shows the campaign name and a read-only rules line on campaign pages', () => {
    const fixture = mount(player);
    const el = fixture.nativeElement as HTMLElement;
    TestBed.inject(ContextService).campaign.set({
      id: 'c1',
      name: 'Lantern Coast',
      ruleset: '2014' as never,
      crossEdition: false,
      overrides: {},
      role: 'player',
    } as never);
    fixture.detectChanges();
    const drawerBtn = button(el, 'Campaign navigation')!;
    expect(drawerBtn.getAttribute('aria-controls')).toBe('campaign-drawer');
    expect(el.querySelector('header a[href="/c/c1"]')?.textContent?.trim()).toBe('Lantern Coast');
    button(el, 'Menu')!.click();
    fixture.detectChanges();
    expect(menu(el)!.querySelector('select')).toBeNull();
    expect(menu(el)!.textContent).toContain('Lantern Coast');
    drawerBtn.click();
    fixture.detectChanges();
    expect(TestBed.inject(LayoutService).drawerOpen()).toBe(true);
  });

  it('closes the menu on Escape, on an outside tap and when the dice log opens (they never stay open together)', () => {
    const fixture = mount(admin);
    const el = fixture.nativeElement as HTMLElement;
    const open = () => {
      button(el, 'Menu')!.click();
      fixture.detectChanges();
    };
    open();
    el.querySelector('header')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(menu(el)).toBeNull();

    open();
    el.querySelector<HTMLElement>('header > .fixed.inset-0')!.click();
    fixture.detectChanges();
    expect(menu(el)).toBeNull();

    open();
    button(el, 'Dice log')!.click();
    fixture.detectChanges();
    expect(menu(el)).toBeNull();
    expect(el.querySelector('#dice-log')).not.toBeNull();
    open();
    expect(el.querySelector('#dice-log')).toBeNull();
    expect(menu(el)).not.toBeNull();
  });

  it('closes the menu when focus moves outside the header, but not for a null target (native pickers)', () => {
    const fixture = mount(admin);
    const el = fixture.nativeElement as HTMLElement;
    const hdr = el.querySelector('header')!;
    button(el, 'Menu')!.click();
    fixture.detectChanges();
    hdr.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    fixture.detectChanges();
    expect(menu(el)).not.toBeNull();
    hdr.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: hdr.querySelector('a') }));
    fixture.detectChanges();
    expect(menu(el)).not.toBeNull();
    hdr.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
    fixture.detectChanges();
    expect(menu(el)).toBeNull();
  });

  it('makes the header inert while the campaign drawer is open and closes the menu', () => {
    const fixture = mount(admin);
    const el = fixture.nativeElement as HTMLElement;
    const hdr = el.querySelector('header')!;
    expect(hdr.hasAttribute('inert')).toBe(false);
    button(el, 'Menu')!.click();
    fixture.detectChanges();
    TestBed.inject(LayoutService).drawerOpen.set(true);
    fixture.detectChanges();
    expect(hdr.hasAttribute('inert')).toBe(true);
    expect(menu(el)).toBeNull();
    TestBed.inject(LayoutService).drawerOpen.set(false);
    fixture.detectChanges();
    expect(hdr.hasAttribute('inert')).toBe(false);
  });

  it('shows the dice toast only while the log is closed; the log lists rolls as a live log', () => {
    const fixture = mount(player);
    const el = fixture.nativeElement as HTMLElement;
    const dice = TestBed.inject(DiceService);
    dice.roll('1d20', 'Test');
    fixture.detectChanges();
    expect(el.querySelector('[role="status"]')).not.toBeNull();
    button(el, 'Dice log')!.click();
    fixture.detectChanges();
    expect(el.querySelector('[role="status"]')).toBeNull();
    const log = el.querySelector('#dice-log')!;
    expect(log.tagName).toBe('SECTION');
    expect(log.querySelector('ol[role="log"] li')).not.toBeNull();
    expect(log.querySelector('h1, h2, h3')).toBeNull();
    log.querySelector<HTMLButtonElement>('button[aria-label="Close dice log"]')!.click();
    fixture.detectChanges();
    expect(el.querySelector('#dice-log')).toBeNull();
  });

  it('moves focus to the first menu row on open and back to the drawer button when the drawer closes', async () => {
    const fixture = mount(admin);
    const el = fixture.nativeElement as HTMLElement;
    document.body.append(el);
    TestBed.inject(ContextService).campaign.set({ id: 'c1', name: 'Lantern Coast', ruleset: '2014' as never, crossEdition: false, overrides: {}, role: 'player' } as never);
    fixture.detectChanges();
    button(el, 'Menu')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement).toBe(menu(el)!.querySelector('a'));

    const layout = TestBed.inject(LayoutService);
    layout.drawerOpen.set(true);
    fixture.detectChanges();
    layout.drawerOpen.set(false);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement).toBe(button(el, 'Campaign navigation'));
    el.remove();
  });

  it('keeps the dice log open for a tap on a roll target, closes it for other taps below lg, never closes it on a wide window', () => {
    const fixture = mount(player);
    const el = fixture.nativeElement as HTMLElement;
    document.body.append(el);
    const roll = document.createElement('span');
    roll.className = 'cn-roll';
    const other = document.createElement('div');
    document.body.append(roll, other);
    const down = (t: Element) => t.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    const open = () => {
      if (!el.querySelector('#dice-log')) button(el, 'Dice log')!.click();
      fixture.detectChanges();
    };
    TestBed.inject(LayoutService).compact.set(true);
    open();
    down(roll);
    fixture.detectChanges();
    expect(el.querySelector('#dice-log')).not.toBeNull();
    // focus moving to a roll target does not close it either
    el.querySelector('header')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: roll }));
    fixture.detectChanges();
    expect(el.querySelector('#dice-log')).not.toBeNull();
    down(other);
    fixture.detectChanges();
    expect(el.querySelector('#dice-log')).toBeNull();

    TestBed.inject(LayoutService).compact.set(false);
    fixture.detectChanges();
    open();
    down(other);
    el.querySelector('header')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: other }));
    fixture.detectChanges();
    expect(el.querySelector('#dice-log')).not.toBeNull();
    el.remove();
    roll.remove();
    other.remove();
  });

  it('hides the dice toast while the menu is open and closes the menu on a tap of a link', async () => {
    const fixture = mount(player);
    const el = fixture.nativeElement as HTMLElement;
    TestBed.inject(DiceService).roll('1d20', 'Test');
    fixture.detectChanges();
    expect(el.querySelector('[role="status"]')).not.toBeNull();
    button(el, 'Menu')!.click();
    fixture.detectChanges();
    expect(el.querySelector('[role="status"]')).toBeNull();
    const link = menu(el)!.querySelector<HTMLAnchorElement>('a')!;
    link.addEventListener('click', (e) => e.preventDefault());
    link.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(menu(el)).toBeNull();
  });
});

@Component({ selector: 'cn-test-a', template: '<h1>Page A</h1>' })
class PageA {}
@Component({ selector: 'cn-test-b', template: '<h1>Page B</h1>' })
class PageB {}
@Component({ selector: 'cn-test-c', template: '<p>No heading</p>' })
class PageC {}

describe('focus on route change', () => {
  async function setup() {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'a', component: PageA },
          { path: 'b', component: PageB },
          { path: 'c', component: PageC },
          { path: 'c/:id/trackers/:t/view', component: PageB },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { user: signal(player), logout: async () => undefined } },
      ],
    });
    const fixture = TestBed.createComponent(App);
    document.body.append(fixture.nativeElement);
    fixture.detectChanges();
    const router = TestBed.inject(Router);
    const go = async (url: string) => {
      await router.navigateByUrl(url);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    return { fixture, el: fixture.nativeElement as HTMLElement, go };
  }

  it('leaves focus alone on the first load, then moves it to the new h1 and keeps it for query changes', async () => {
    const { el, go } = await setup();
    await go('/a');
    expect(document.activeElement).toBe(document.body);
    await go('/b');
    expect(document.activeElement).toBe(el.querySelector('main h1'));
    expect(document.activeElement?.textContent).toBe('Page B');
    (document.activeElement as HTMLElement).blur();
    await go('/b?x=1');
    expect(document.activeElement).toBe(document.body);
    el.remove();
  });

  it('focuses <main> and announces the title when the page has no heading', async () => {
    const { fixture, el, go } = await setup();
    document.title = 'Plain page';
    await go('/a');
    await go('/c');
    await new Promise((r) => setTimeout(r, 1600));
    fixture.detectChanges();
    expect(document.activeElement).toBe(el.querySelector('main'));
    expect(el.querySelector('[aria-live="polite"][aria-atomic]')?.textContent).toBe('Plain page');
    el.remove();
  });

  it('never pulls focus out of a field the person is typing in', async () => {
    const { el, go } = await setup();
    await go('/a');
    const field = document.createElement('input');
    el.append(field);
    field.focus();
    await go('/b');
    expect(document.activeElement).toBe(field);
    el.remove();
  });

  it('does not move focus on the bare table screen', async () => {
    const { el, go } = await setup();
    await go('/a');
    await go('/c/1/trackers/2/view');
    expect(document.activeElement).toBe(document.body);
    el.remove();
  });
});
