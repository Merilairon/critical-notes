import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ApiTokenDto } from '@cn/shared';
import { AuthService } from '../core/auth.service';
import { AccountPage } from './account-page';

const settle = () => new Promise((resolve) => setTimeout(resolve));
const token = (id: string, extra: Partial<ApiTokenDto> = {}): ApiTokenDto => ({ id, name: id, scope: 'write', createdAt: 0, lastUsedAt: null, expiresAt: null, ...extra });

async function mount(tokens: ApiTokenDto[] = []) {
  const user = signal({ id: 'u', username: 'jan', displayName: 'Jan', isAdmin: true });
  TestBed.configureTestingModule({
    imports: [AccountPage],
    providers: [provideHttpClient(), provideHttpClientTesting(), { provide: AuthService, useValue: { user } }],
  });
  const fixture = TestBed.createComponent(AccountPage);
  const http = TestBed.inject(HttpTestingController);
  document.body.append(fixture.nativeElement);
  fixture.detectChanges();
  http.expectOne('/api/auth/tokens').flush({ tokens });
  await settle();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, http, user };
}

describe('AccountPage', () => {
  it('creates a token and shows it once with the setup for MCP clients', async () => {
    const { fixture, el, http } = await mount([]);
    expect(el.textContent).toContain('No tokens yet.');
    el.querySelector<HTMLInputElement>('input[aria-label="Token name"]')!.value = 'Claude';
    el.querySelector<HTMLInputElement>('input[aria-label="Token name"]')!.form!.dispatchEvent(new Event('submit'));
    const req = http.expectOne({ method: 'POST', url: '/api/auth/tokens' });
    expect(req.request.body).toEqual({ name: 'Claude', scope: 'write', expiresInDays: 90 });
    req.flush({ ...token('t1', { name: 'Claude' }), token: 'cn_secret' });
    await settle();
    http.expectOne('/api/auth/tokens').flush({ tokens: [token('t1', { name: 'Claude' })] });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector<HTMLInputElement>('input[aria-label="New token"]')!.value).toBe('cn_secret');
    expect(el.querySelector('pre[aria-label="Claude Code"]')!.textContent).toBe(`claude mcp add --transport http critical-notes ${location.origin}/mcp --header "Authorization: Bearer cn_secret"`);
    expect(el.textContent).toContain('Read and write');
  });

  it('shows the server version from /api/health, small, and hides it when the call fails', async () => {
    const { fixture, el, http } = await mount([]);
    http.expectOne('/api/health').flush({ ok: true, version: '1.2.3-dev' });
    fixture.detectChanges();
    expect(el.textContent).toContain('Critical Notes 1.2.3-dev');
    TestBed.resetTestingModule();
    const second = await mount([]);
    second.http.expectOne('/api/health').flush('x', { status: 500, statusText: 'err' });
    second.fixture.detectChanges();
    expect(second.el.textContent).not.toContain('Critical Notes 1');
  });

  it('lists tokens, marks expired ones and revokes', async () => {
    const { fixture, el, http } = await mount([token('old', { expiresAt: 1, scope: 'read' }), token('new')]);
    expect(el.textContent).toContain('Expired');
    expect(el.textContent).toContain('Read only');
    const confirmSpy = vi.spyOn(window, 'confirm');
    el.querySelector<HTMLButtonElement>('button[aria-label="Revoke old"]')!.click();
    fixture.detectChanges();
    expect(confirmSpy).not.toHaveBeenCalled(); // the app's own dialog, not the browser's
    const dialog = el.querySelector('[role="alertdialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('Revoke “old”?');
    http.expectNone({ method: 'DELETE', url: '/api/auth/tokens/old' });
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Revoke token')!.click();
    http.expectOne({ method: 'DELETE', url: '/api/auth/tokens/old' }).flush(null);
    await settle();
    http.expectOne('/api/auth/tokens').flush({ tokens: [token('new')] });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[role="alertdialog"]')).toBeNull();
    expect(el.querySelector('button[aria-label="Revoke old"]')).toBeNull();
  });

  it('cancelling the revoke dialog (button or Escape) revokes nothing and returns focus to the Revoke button', async () => {
    const { fixture, el, http } = await mount([token('keep')]);
    const open = () => {
      const button = el.querySelector<HTMLButtonElement>('button[aria-label="Revoke keep"]')!;
      button.focus();
      button.click();
      fixture.detectChanges();
      return button;
    };
    let button = open();
    expect(el.querySelector('[role="alertdialog"]')).not.toBeNull();
    [...el.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent === 'Cancel')!.dispatchEvent(new Event('click'));
    fixture.detectChanges();
    expect(el.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(button);
    button = open();
    el.querySelector('[role="alertdialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(el.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(button);
    http.expectNone({ method: 'DELETE', url: '/api/auth/tokens/keep' });
  });

  it('signs out the other sessions, announces the result and keeps focus on the button', async () => {
    const { fixture, el, http } = await mount();
    const section = el.querySelector('section[aria-labelledby="sessions-heading"]')!;
    const button = section.querySelector('button')!;
    button.focus();
    button.click();
    fixture.detectChanges();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    http.expectOne({ method: 'POST', url: '/api/auth/sessions/end-others' }).flush({ ended: 2 });
    await settle();
    fixture.detectChanges();
    expect(section.querySelector('[role="status"]')!.textContent).toContain('Signed out 2 other sessions');
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(document.activeElement).toBe(button);
    button.click();
    http.expectOne('/api/auth/sessions/end-others').flush({ ended: 0 });
    await settle();
    fixture.detectChanges();
    expect(section.querySelector('[role="status"]')!.textContent).toContain('No other sessions');
  });

  it('shows a failed sign-out of other sessions in an alert and keeps focus on the button', async () => {
    const { fixture, el, http } = await mount();
    const section = el.querySelector('section[aria-labelledby="sessions-heading"]')!;
    const button = section.querySelector('button')!;
    button.click();
    http.expectOne('/api/auth/sessions/end-others').flush({ error: 'Nope' }, { status: 500, statusText: 'err' });
    await settle();
    fixture.detectChanges();
    expect(section.querySelector('[role="alert"]')!.textContent!.trim()).not.toBe('');
    expect(section.querySelector('[role="status"]')!.textContent!.trim()).toBe('');
    expect(document.activeElement).toBe(button);
  });

  const fill = (el: HTMLElement, name: string, value: string) => (el.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.value = value);
  const submit = (el: HTMLElement, name: string) => el.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.form!.dispatchEvent(new Event('submit'));

  it('renames the user and updates the shown name', async () => {
    const { fixture, el, http, user } = await mount();
    expect(el.querySelector<HTMLInputElement>('input[name="displayName"]')!.value).toBe('Jan');
    fill(el, 'displayName', ' Janne ');
    submit(el, 'displayName');
    const req = http.expectOne({ method: 'PATCH', url: '/api/auth/me' });
    expect(req.request.body).toEqual({ displayName: 'Janne' });
    req.flush({ user: { id: 'u', username: 'jan', displayName: 'Janne', isAdmin: true } });
    await settle();
    fixture.detectChanges();
    expect(user().displayName).toBe('Janne');
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Janne');
  });

  it('keeps focus on the name button after a save', async () => {
    const { fixture, el, http } = await mount();
    const button = el.querySelector<HTMLButtonElement>('section[aria-labelledby="profile-heading"] button')!;
    button.focus();
    fill(el, 'displayName', 'Janne');
    submit(el, 'displayName');
    fixture.detectChanges();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button);
    http.expectOne('/api/auth/me').flush({ user: { id: 'u', username: 'jan', displayName: 'Janne', isAdmin: true } });
    await settle();
    fixture.detectChanges();
    expect(document.activeElement).toBe(button);
  });

  it('rejects an empty display name without a request', async () => {
    const { fixture, el, http } = await mount();
    fill(el, 'displayName', '  ');
    submit(el, 'displayName');
    fixture.detectChanges();
    http.expectNone('/api/auth/me');
    expect(el.querySelector('#name-error')!.textContent).toContain('display name');
    expect(document.activeElement).toBe(el.querySelector('input[name="displayName"]'));
  });

  it('shows mismatch and weak-password errors inline, with no request', async () => {
    const { fixture, el, http } = await mount();
    fill(el, 'currentPassword', 'old-password');
    fill(el, 'newPassword', 'short');
    fill(el, 'newPasswordAgain', 'short');
    submit(el, 'newPassword');
    fixture.detectChanges();
    expect(el.querySelector('#pw-error')!.textContent).toContain('At least 8 characters');
    expect(el.querySelector('input[name="newPassword"]')!.getAttribute('aria-invalid')).toBe('true');
    fill(el, 'newPassword', 'long-enough-1');
    submit(el, 'newPassword');
    fixture.detectChanges();
    expect(el.querySelector('#pw-error')!.textContent).toContain('do not match');
    expect(el.querySelector('input[name="newPasswordAgain"]')!.getAttribute('aria-describedby')).toBe('pw-error');
    http.expectNone('/api/auth/password');
  });

  it('changes the password, clears the fields and says other devices are signed out', async () => {
    const { fixture, el, http } = await mount();
    fill(el, 'currentPassword', 'old-password');
    fill(el, 'newPassword', 'long-enough-1');
    fill(el, 'newPasswordAgain', 'long-enough-1');
    submit(el, 'newPassword');
    fixture.detectChanges();
    expect(el.querySelector<HTMLButtonElement>('section[aria-labelledby="password-heading"] button')!.getAttribute('aria-disabled')).toBe('true');
    const req = http.expectOne({ method: 'POST', url: '/api/auth/password' });
    expect(req.request.body).toEqual({ currentPassword: 'old-password', newPassword: 'long-enough-1' });
    req.flush({ ok: true });
    await settle();
    fixture.detectChanges();
    for (const n of ['currentPassword', 'newPassword', 'newPasswordAgain']) expect(el.querySelector<HTMLInputElement>(`input[name="${n}"]`)!.value).toBe('');
    expect(document.activeElement).toBe(el.querySelector('input[name="currentPassword"]'));
    expect(el.textContent).toContain('signed out on your other devices');
    expect(el.querySelector<HTMLButtonElement>('section[aria-labelledby="password-heading"] button')!.getAttribute('aria-disabled')).toBeNull();
  });

  it('reports a wrong current password and a rate limit with a retry hint', async () => {
    const { fixture, el, http } = await mount();
    const send = async () => {
      fill(el, 'currentPassword', 'nope');
      fill(el, 'newPassword', 'long-enough-1');
      fill(el, 'newPasswordAgain', 'long-enough-1');
      submit(el, 'newPassword');
      return http.expectOne('/api/auth/password');
    };
    (await send()).flush({ error: 'Invalid credentials' }, { status: 401, statusText: 'Unauthorized' });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('#pw-error')!.textContent).toContain('current password is not correct');
    expect(document.activeElement).toBe(el.querySelector('input[name="currentPassword"]'));
    (await send()).flush({ error: 'Too many' }, { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '42' } });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('#pw-error')!.textContent).toContain('Try again in 42 s');
  });

  async function sendPassword(el: HTMLElement, http: HttpTestingController) {
    fill(el, 'currentPassword', 'nope');
    fill(el, 'newPassword', 'long-enough-1');
    fill(el, 'newPasswordAgain', 'long-enough-1');
    submit(el, 'newPassword');
    return http.expectOne('/api/auth/password');
  }

  it('rounds a long Retry-After to minutes and falls back without the header', async () => {
    const { fixture, el, http } = await mount();
    (await sendPassword(el, http)).flush({ error: 'x' }, { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '120' } });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('#pw-error')!.textContent).toContain('Try again in 2 min');
    (await sendPassword(el, http)).flush({ error: 'x' }, { status: 429, statusText: 'Too Many Requests' });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('#pw-error')!.textContent).toContain('Try again in a minute');
  });

  it('maps a 400 issues response to an inline message', async () => {
    const { fixture, el, http } = await mount();
    (await sendPassword(el, http)).flush({ error: 'Invalid', issues: [{ path: 'newPassword', message: 'Too common' }] }, { status: 400, statusText: 'Bad Request' });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('#pw-error')!.textContent).toContain('newPassword: Too common');
  });

  it('ignores a second submit while a request is pending', async () => {
    const { el, http } = await mount();
    fill(el, 'currentPassword', 'old-password');
    fill(el, 'newPassword', 'long-enough-1');
    fill(el, 'newPasswordAgain', 'long-enough-1');
    submit(el, 'newPassword');
    submit(el, 'newPassword');
    http.expectOne('/api/auth/password');
    fill(el, 'displayName', 'Janne');
    submit(el, 'displayName');
    submit(el, 'displayName');
    http.expectOne('/api/auth/me');
  });
});
