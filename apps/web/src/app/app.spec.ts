import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { UserDto } from '@cn/shared';
import { App } from './app';
import { AuthService } from './core/auth.service';
import { ContextService } from './core/context.service';
import { DiceService } from './core/dice.service';
import { LayoutService } from './core/layout.service';

function mount(user: UserDto | null): ComponentFixture<App> {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
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
});
