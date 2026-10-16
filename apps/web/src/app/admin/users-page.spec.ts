import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { AdminUserDto, OwnedCampaignDto } from '@cn/shared';
import { AuthService } from '../core/auth.service';
import { UsersPage } from './users-page';

const settle = () => new Promise((resolve) => setTimeout(resolve));
const user = (id: string, extra: Partial<AdminUserDto> = {}): AdminUserDto => ({ id, username: id, displayName: id, isAdmin: false, disabledAt: null, createdAt: 1_700_000_000_000, ownedCampaignCount: 0, ...extra });
const member = (userId: string, role: string, disabled = false) => ({ userId, displayName: userId, role, disabled });

const USERS = [user('zed', { displayName: 'Zed' }), user('me', { displayName: 'Me', isAdmin: true }), user('bob', { displayName: 'bob', isAdmin: true }), user('tom', { displayName: 'Tom', disabledAt: 1_700_000_100_000 })];

async function mount(users: AdminUserDto[] = USERS) {
  const me = signal({ id: 'me', username: 'me', displayName: 'Me', isAdmin: true });
  const refresh = vi.fn(async () => undefined);
  TestBed.configureTestingModule({
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: AuthService, useValue: { user: me, refresh } }],
  });
  const fixture = TestBed.createComponent(UsersPage);
  const http = TestBed.inject(HttpTestingController);
  document.body.append(fixture.nativeElement);
  fixture.detectChanges();
  http.expectOne('/api/admin/users').flush({ users });
  await tick(fixture);
  return { fixture, el: fixture.nativeElement as HTMLElement, http, refresh };
}

async function tick(fixture: ComponentFixture<unknown>) {
  await settle();
  fixture.detectChanges();
  await settle();
  fixture.detectChanges();
}

const button = (el: HTMLElement, label: string) => el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const dialog = (el: HTMLElement) => el.querySelector<HTMLElement>('[role="dialog"]');
const password = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input[name="currentPassword"]')!;
const submitDialog = (el: HTMLElement, pw: string) => {
  password(el).value = pw;
  password(el).form!.dispatchEvent(new Event('submit'));
};
const alertText = (el: HTMLElement) => dialog(el)!.querySelector('[role="alert"]')!.textContent!.trim();
const status = (el: HTMLElement) => el.querySelector('div[role="status"]')!.textContent!.trim();
const respond = (r: TestRequest, body: object | string | null, status = 200, headers: Record<string, string> = {}) => r.flush(body, { status, statusText: String(status), headers });

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('UsersPage list', () => {
  it('sorts by display name, shows badges and counts', async () => {
    const { el } = await mount();
    const names = Array.from(el.querySelectorAll('table tbody th strong')).map((e) => e.textContent);
    expect(names).toEqual(['bob', 'Me', 'Tom', 'Zed']);
    expect(el.textContent).toContain('4 users');
    const rows = Array.from(el.querySelectorAll('table tbody tr'));
    expect(rows[1]!.textContent).toContain('You');
    expect(rows[2]!.textContent).toContain('Disabled');
    expect(el.querySelectorAll('ul li').length).toBe(4);
  });

  it('keeps unavailable actions in place with a visible reason', async () => {
    const { el } = await mount();
    const disable = el.querySelector<HTMLButtonElement>('table button[aria-label="Disable Me"]')!;
    expect(disable.getAttribute('aria-disabled')).toBe('true');
    expect(disable.hasAttribute('disabled')).toBe(false);
    expect(el.querySelector(`#${disable.getAttribute('aria-describedby')}`)!.textContent).toBe('You cannot disable your own account.');
    disable.click();
    expect(dialog(el)).toBeNull();
    expect(el.querySelector('table button[aria-label="Reset link for Tom"]')!.getAttribute('aria-disabled')).toBe('true');
    expect(el.querySelector('table button[aria-label="Delete Me"]')!.getAttribute('aria-disabled')).toBe('true');
  });

  it('shows a retryable error when the list cannot be loaded', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: AuthService, useValue: { user: signal({ id: 'me', isAdmin: true }), refresh: vi.fn() } }] });
    const fixture = TestBed.createComponent(UsersPage);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    respond(http.expectOne('/api/admin/users'), { error: 'Boom' }, 500);
    await tick(fixture);
    expect(fixture.nativeElement.textContent).toContain('Boom');
    fixture.nativeElement.querySelector('button')!.click();
    respond(http.expectOne('/api/admin/users'), { users: [user('me', { isAdmin: true })] });
    await tick(fixture);
    expect(fixture.nativeElement.textContent).toContain('1 user');
  });
});

describe('enable', () => {
  it('enables a non-admin without a dialog', async () => {
    const { fixture, el, http } = await mount();
    button(el, 'Enable Tom').click();
    const req = http.expectOne({ method: 'PATCH', url: '/api/admin/users/tom' });
    expect(req.request.body).toEqual({ disabled: false });
    respond(req, { user: user('tom') });
    await settle();
    http.expectOne('/api/admin/users').flush({ users: USERS.map((u) => (u.id === 'tom' ? { ...u, disabledAt: null } : u)) });
    await tick(fixture);
    expect(status(el)).toBe('Tom is enabled. They need a new password link to sign in.');
    expect(el.querySelector('table button[aria-label="Enable Tom"]')).toBeNull();
  });

  it('asks for the password to enable a disabled admin', async () => {
    const users = [...USERS, user('ada', { displayName: 'Ada', isAdmin: true, disabledAt: 5 })];
    const { fixture, el, http } = await mount(users);
    button(el, 'Enable Ada').click();
    await tick(fixture);
    expect(dialog(el)!.textContent).toContain('Enable Ada');
    http.expectNone('/api/admin/users/ada');
    submitDialog(el, 'secret');
    const req = http.expectOne({ method: 'PATCH', url: '/api/admin/users/ada' });
    expect(req.request.body).toEqual({ disabled: false, currentPassword: 'secret' });
  });
});

describe('step-up dialog', () => {
  async function openDisable() {
    const ctx = await mount();
    button(ctx.el, 'Disable Zed').click();
    await tick(ctx.fixture);
    return ctx;
  }

  it('names the person and the consequences, and starts focus on the password (cdk does the focusing in a real browser)', async () => {
    const { el } = await openDisable();
    const d = dialog(el)!;
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(d.textContent).toContain('Disable Zed');
    expect(d.textContent).toContain('API tokens');
    expect(password(el).hasAttribute('cdkFocusInitial')).toBe(true);
    // the page behind is inert while the dialog is open
    expect(el.querySelector('h1')!.parentElement!.hasAttribute('inert')).toBe(true);
  });

  it('refuses an empty password without a request', async () => {
    const { fixture, el, http } = await openDisable();
    submitDialog(el, '');
    await tick(fixture);
    http.expectNone('/api/admin/users/zed');
    expect(alertText(el)).toBe('Enter your password.');
    expect(password(el).getAttribute('aria-invalid')).toBe('true');
  });

  it('answers a wrong password inline, clears the field and keeps the dialog', async () => {
    const { fixture, el, http } = await openDisable();
    submitDialog(el, 'nope');
    respond(http.expectOne('/api/admin/users/zed'), { error: 'Your password is wrong' }, 403);
    await tick(fixture);
    expect(alertText(el)).toBe('Your password is wrong.');
    expect(password(el).value).toBe('');
    expect(password(el).getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(password(el));
  });

  it('counts down after a 429 and enables Confirm again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { fixture, el, http } = await openDisable();
    submitDialog(el, 'x');
    respond(http.expectOne('/api/admin/users/zed'), { error: 'Too many' }, 429, { 'Retry-After': '3' });
    await tick(fixture);
    const confirm = el.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(alertText(el)).toBe('Too many attempts. Try again in 3 s.');
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    expect(dialog(el)!.textContent).toContain('You can try again in 3 s.');
    // a click while waiting sends nothing
    submitDialog(el, 'x');
    http.expectNone('/api/admin/users/zed');
    vi.advanceTimersByTime(1000);
    fixture.detectChanges();
    // the alert region keeps the first message: only the visible countdown ticks
    expect(alertText(el)).toBe('Too many attempts. Try again in 3 s.');
    expect(dialog(el)!.textContent).toContain('You can try again in 2 s.');
    vi.advanceTimersByTime(2000);
    fixture.detectChanges();
    expect(confirm.getAttribute('aria-disabled')).toBeNull();
    expect(alertText(el)).toBe('');
  });

  it('disables the account on success, announces it and refreshes the list', async () => {
    const { fixture, el, http } = await openDisable();
    submitDialog(el, 'good');
    const req = http.expectOne({ method: 'PATCH', url: '/api/admin/users/zed' });
    expect(req.request.body).toEqual({ disabled: true, currentPassword: 'good' });
    respond(req, { user: user('zed') });
    await settle();
    http.expectOne('/api/admin/users').flush({ users: USERS.map((u) => (u.id === 'zed' ? { ...u, disabledAt: 9 } : u)) });
    await tick(fixture);
    expect(dialog(el)).toBeNull();
    expect(status(el)).toBe('Zed is disabled. Their sessions and API tokens were ended.');
    expect(el.querySelector('table button[aria-label="Enable Zed"]')).not.toBeNull();
  });

  it('shows a rule violation verbatim and refreshes behind the dialog', async () => {
    const { fixture, el, http } = await openDisable();
    submitDialog(el, 'good');
    respond(http.expectOne('/api/admin/users/zed'), { error: 'There must be at least one admin' }, 409);
    await settle();
    http.expectOne('/api/admin/users').flush({ users: USERS });
    await tick(fixture);
    expect(alertText(el)).toBe('There must be at least one admin');
    expect(dialog(el)).not.toBeNull();
  });

  it('empties the password field after a network error and after success', async () => {
    const { fixture, el, http } = await openDisable();
    submitDialog(el, 'pw');
    http.expectOne('/api/admin/users/zed').error(new ProgressEvent('error'));
    await tick(fixture);
    expect(password(el).value).toBe('');
    submitDialog(el, 'pw2');
    const req = http.expectOne('/api/admin/users/zed');
    const input = password(el);
    respond(req, { user: user('zed') });
    await tick(fixture);
    expect(input.value).toBe('');
  });

  it('returns focus to the row button and removes inert after Cancel and after Esc', async () => {
    const { fixture, el } = await openDisable();
    const opener = el.querySelector<HTMLElement>('table [data-key="zed:disable"]')!;
    const close = async (how: 'cancel' | 'esc') => {
      if (how === 'cancel') Array.from(dialog(el)!.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!.click();
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await tick(fixture);
      expect(dialog(el)).toBeNull();
      expect(el.querySelectorAll('[inert]').length).toBe(0);
      expect(document.activeElement).toBe(opener);
    };
    await close('cancel');
    opener.click();
    await tick(fixture);
    await close('esc');
  });

  it('closes on Escape and never on a click outside', async () => {
    const { fixture, el } = await openDisable();
    (dialog(el)!.parentElement as HTMLElement).click();
    await tick(fixture);
    expect(dialog(el)).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await tick(fixture);
    expect(dialog(el)).toBeNull();
  });

  it('leaves for the campaign list when the admin has lost their rights', async () => {
    const { fixture, el, http, refresh } = await openDisable();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    submitDialog(el, 'good');
    respond(http.expectOne('/api/admin/users/zed'), { error: 'Admins only' }, 403);
    await tick(fixture);
    expect(dialog(el)!.textContent).toContain('You are no longer an admin.');
    dialog(el)!.querySelector('button')!.click();
    await settle();
    expect(refresh).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/campaigns');
  });
});

describe('admin rights', () => {
  it('grants admin with the privilege sentence and sends the password', async () => {
    const { fixture, el, http } = await mount();
    button(el, 'Make admin for Zed').click();
    await tick(fixture);
    expect(dialog(el)!.textContent).toContain('manage every account');
    submitDialog(el, 'pw');
    expect(http.expectOne('/api/admin/users/zed').request.body).toEqual({ isAdmin: true, currentPassword: 'pw' });
  });

  it('names an admin target and warns when you remove your own rights', async () => {
    const { fixture, el, http } = await mount();
    button(el, 'Remove admin from bob').click();
    await tick(fixture);
    expect(dialog(el)!.textContent).toContain('bob is an admin.');
    expect(dialog(el)!.textContent).not.toContain('You will lose access');
    dialog(el)!.querySelectorAll('button')[0]!.click();
    await tick(fixture);
    button(el, 'Remove admin from Me').click();
    await tick(fixture);
    expect(dialog(el)!.textContent).toContain('You will lose access to this page');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    submitDialog(el, 'pw');
    respond(http.expectOne('/api/admin/users/me'), { user: user('me') });
    await tick(fixture);
    expect(navigate).toHaveBeenCalledWith('/campaigns');
  });
});

describe('reset link', () => {
  const clipboard = { writeText: vi.fn(async () => undefined) };
  beforeEach(() => Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true }));

  async function create(revoke: boolean) {
    const ctx = await mount();
    button(ctx.el, 'Reset link for Zed').click();
    await tick(ctx.fixture);
    if (revoke) {
      const box = dialog(ctx.el)!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      box.checked = true;
    }
    submitDialog(ctx.el, 'pw');
    const req = ctx.http.expectOne({ method: 'POST', url: '/api/admin/users/zed/reset-link' });
    respond(req, { url: 'https://notes.example/reset#TOKEN', expiresAt: Date.now() + 24 * 3_600_000 }, 201);
    await tick(ctx.fixture);
    return { ...ctx, req };
  }

  it('does not revoke tokens unless asked', async () => {
    const { req } = await create(false);
    expect(req.request.body).toEqual({ currentPassword: 'pw' });
  });

  it('shows the link once, focuses it, copies with a live confirmation and forgets it on Done', async () => {
    const { fixture, el, req, http } = await create(true);
    expect(req.request.body).toEqual({ currentPassword: 'pw', revokeTokens: true });
    const link = el.querySelector<HTMLInputElement>('input[aria-label="Reset link"]')!;
    expect(link.value).toBe('https://notes.example/reset#TOKEN');
    expect(link.readOnly).toBe(true);
    expect(document.activeElement).toBe(link);
    expect(dialog(el)!.textContent).toContain('Not shown again');
    expect(dialog(el)!.textContent).toContain('API tokens were revoked');
    expect(password(el)).toBeNull();
    Array.from(dialog(el)!.querySelectorAll('button')).find((b) => b.textContent!.includes('Copy link'))!.click();
    await tick(fixture);
    expect(clipboard.writeText).toHaveBeenCalledWith('https://notes.example/reset#TOKEN');
    expect(Array.from(dialog(el)!.querySelectorAll('[role="status"]')).map((s) => s.textContent!.trim())).toContain('Link copied.');
    Array.from(dialog(el)!.querySelectorAll('button')).find((b) => b.textContent!.trim() === 'Done')!.click();
    await settle();
    http.expectOne('/api/admin/users').flush({ users: USERS });
    await tick(fixture);
    expect(dialog(el)).toBeNull();
    expect(el.innerHTML).not.toContain('TOKEN');
    expect(status(el)).toContain('Reset link created for Zed.');
  });

  it('says so when the clipboard is unavailable', async () => {
    const { fixture, el } = await create(false);
    clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    Array.from(dialog(el)!.querySelectorAll('button')).find((b) => b.textContent!.includes('Copy link'))!.click();
    await tick(fixture);
    expect(dialog(el)!.textContent).toContain('Could not copy. Select the link and copy it by hand.');
  });
});

describe('delete', () => {
  const campaigns: OwnedCampaignDto[] = [
    { campaignId: 'c1', name: 'Sunken Crown', members: [member('zed', 'dm'), member('ann', 'codm'), member('pat', 'player')] },
    { campaignId: 'c2', name: 'Ashes', members: [member('zed', 'dm'), member('kim', 'player'), member('lou', 'player')] },
  ];

  async function openDelete(owned: OwnedCampaignDto[]) {
    const ctx = await mount();
    button(ctx.el, 'Delete Zed').click();
    await tick(ctx.fixture);
    respond(ctx.http.expectOne('/api/admin/users/zed/owned-campaigns'), { campaigns: owned });
    await tick(ctx.fixture);
    return ctx;
  }
  const select = (el: HTMLElement, name: string) => el.querySelector<HTMLSelectElement>(`select[aria-label="New owner of ${name}"]`)!;

  it('loads the plan, presets a co-DM, makes you choose for the rest and sends exactly the owned set', async () => {
    const { fixture, el, http } = await openDelete(campaigns);
    expect(select(el, 'Sunken Crown').value).toBe('ann');
    expect(select(el, 'Ashes').value).toBe('');
    expect(el.querySelector<HTMLInputElement>('input[name="choice-c2"][aria-describedby]')!.disabled).toBe(true);
    submitDialog(el, 'pw');
    await tick(fixture);
    http.expectNone('/api/admin/users/zed/delete');
    expect(alertText(el)).toBe('1 campaign still needs a choice: Ashes.');
    expect(select(el, 'Ashes').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(select(el, 'Ashes'));
    select(el, 'Ashes').value = 'lou';
    select(el, 'Ashes').dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(dialog(el)!.textContent).toContain('2 campaigns: 2 transferred, 0 archived.');
    submitDialog(el, 'pw');
    const req = http.expectOne({ method: 'POST', url: '/api/admin/users/zed/delete' });
    expect(req.request.body).toEqual({
      currentPassword: 'pw',
      campaigns: [
        { campaignId: 'c1', action: 'transfer', toUserId: 'ann' },
        { campaignId: 'c2', action: 'transfer', toUserId: 'lou' },
      ],
    });
    respond(req, null, 204);
    await settle();
    http.expectOne('/api/admin/users').flush({ users: USERS.filter((u) => u.id !== 'zed') });
    await tick(fixture);
    expect(status(el)).toBe('Zed was deleted. 2 campaigns were transferred.');
    expect(dialog(el)).toBeNull();
    expect(document.activeElement).toBe(el.querySelector('h1'));
  });

  it('archives where a co-DM exists and says what that costs', async () => {
    const { fixture, el, http } = await openDelete([campaigns[0]!]);
    expect(dialog(el)!.textContent).toContain('it will have no owner');
    el.querySelector<HTMLInputElement>('input[name="choice-c1"][aria-describedby]')!.click();
    fixture.detectChanges();
    submitDialog(el, 'pw');
    expect(http.expectOne('/api/admin/users/zed/delete').request.body.campaigns).toEqual([{ campaignId: 'c1', action: 'archive' }]);
  });

  it('blocks a solo campaign and offers to disable instead', async () => {
    const { fixture, el, http } = await openDelete([{ campaignId: 'c3', name: 'Solo Notes', members: [member('zed', 'dm')] }]);
    expect(dialog(el)!.textContent).toContain('Blocked.');
    const confirm = el.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    expect(dialog(el)!.querySelector(`#${confirm.getAttribute('aria-describedby')}`)!.textContent).toContain('Delete is blocked by 1 campaign');
    expect(document.activeElement!.textContent).toContain('Disable instead');
    submitDialog(el, 'pw');
    http.expectNone('/api/admin/users/zed/delete');
    (document.activeElement as HTMLElement).click();
    await tick(fixture);
    expect(dialog(el)!.querySelector('h2')!.textContent).toBe('Disable Zed');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await tick(fixture);
    expect(dialog(el)).toBeNull();
    expect(el.querySelectorAll('[inert]').length).toBe(0);
    expect(document.activeElement).toBe(el.querySelector('table [data-key="zed:delete"]'));
  });

  it('shows disabled members in the list but not as a choice, and rebuilds the plan after a 400', async () => {
    const { fixture, el, http } = await openDelete([{ campaignId: 'c1', name: 'Sunken Crown', members: [member('zed', 'dm'), member('ann', 'codm', true), member('pat', 'player')] }]);
    const opts = Array.from(select(el, 'Sunken Crown').options);
    expect(opts.find((o) => o.value === 'ann')!.disabled).toBe(true);
    expect(opts.find((o) => o.value === 'ann')!.textContent).toContain('account disabled');
    expect(select(el, 'Sunken Crown').value).toBe('pat');
    submitDialog(el, 'pw');
    respond(http.expectOne('/api/admin/users/zed/delete'), { error: 'Choose what happens to every campaign this user owns' }, 400);
    await settle();
    respond(http.expectOne('/api/admin/users/zed/owned-campaigns'), { campaigns: [] });
    await tick(fixture);
    const texts = Array.from(dialog(el)!.querySelectorAll('[role="alert"]')).map((x) => x.textContent!.trim()).filter(Boolean);
    expect(texts).toEqual(['Choose what happens to every campaign this user owns']);
  });
});
