import { HttpClient, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { ResetPage } from './reset';

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'; // 43 base64url characters
const INFO = { username: 'marie', displayName: 'Marie Dupont', expiresAt: 1_800_000_000_000 };
const settle = () => new Promise((resolve) => setTimeout(resolve));

async function tick(fixture: ComponentFixture<unknown>) {
  await settle();
  fixture.detectChanges();
  await settle();
  fixture.detectChanges();
}

async function mount(hash: string, signedIn: { displayName: string } | null = null, before?: () => void) {
  history.replaceState(null, '', `/reset${hash}`);
  const refresh = vi.fn(async () => undefined);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: AuthService, useValue: { user: signal(signedIn), ensureLoaded: async () => undefined, refresh } },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  before?.();
  const fixture = TestBed.createComponent(ResetPage);
  document.body.append(fixture.nativeElement);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, http, refresh, navigate };
}

const field = (el: HTMLElement, name: string) => el.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const submit = async (fixture: ComponentFixture<unknown>, el: HTMLElement, a: string, b: string) => {
  field(el, 'newPassword').value = a;
  field(el, 'newPasswordAgain').value = b;
  field(el, 'newPassword').form!.dispatchEvent(new Event('submit'));
  await tick(fixture);
};
const ready = async (hash = `#${TOKEN}`, signedIn: { displayName: string } | null = null) => {
  const m = await mount(hash, signedIn);
  m.http.expectOne(`/api/auth/reset/${TOKEN}`).flush(INFO);
  await tick(m.fixture);
  return m;
};

afterEach(() => {
  document.body.replaceChildren();
  history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('ResetPage', () => {
  it('strips the fragment before the first request', async () => {
    const order: string[] = [];
    const m = await mount(`#${TOKEN}`, null, () => {
      const replace = history.replaceState.bind(history);
      vi.spyOn(history, 'replaceState').mockImplementation((...args) => (order.push('strip'), replace(...args)));
      const client = TestBed.inject(HttpClient);
      const get = client.get.bind(client) as (...args: unknown[]) => unknown;
      vi.spyOn(client, 'get').mockImplementation(((...args: unknown[]) => (order.push('get'), get(...args))) as never);
    });
    m.http.expectOne(`/api/auth/reset/${TOKEN}`).flush(INFO);
    expect(order).toEqual(['strip', 'get']);
  });

  it('removes #token from the address bar', async () => {
    const { http, fixture, el } = await mount(`#${TOKEN}`);
    expect(location.hash).toBe('');
    expect(location.pathname).toBe('/reset');
    http.expectOne(`/api/auth/reset/${TOKEN}`).flush(INFO);
    await tick(fixture);
    expect(el.textContent).not.toContain(TOKEN);
    expect(el.querySelector('h1')!.textContent).toBe('Choose a new password');
    expect(el.textContent).toContain('For Marie Dupont (marie).');
    expect(field(el, 'newPassword').autocomplete).toBe('new-password');
    expect(field(el, 'username').value).toBe('marie');
  });

  it('shows the uniform invalid state without a request when the token is missing or malformed', async () => {
    for (const hash of ['', '#short', `#${TOKEN}x`]) {
      const { http, fixture, el } = await mount(hash);
      await tick(fixture);
      http.expectNone(() => true);
      expect(el.querySelector('h1')!.textContent).toBe('This reset link is not valid');
      expect(document.activeElement).toBe(el.querySelector('h1'));
      expect(el.textContent).not.toContain('marie');
      TestBed.resetTestingModule();
      document.body.replaceChildren();
    }
  });

  it('shows the same invalid state for a 404 on the lookup', async () => {
    const { http, fixture, el } = await mount(`#${TOKEN}`);
    http.expectOne(`/api/auth/reset/${TOKEN}`).flush({ error: 'This reset link is not valid' }, { status: 404, statusText: 'Not Found' });
    await tick(fixture);
    expect(el.querySelector('h1')!.textContent).toBe('This reset link is not valid');
    expect(el.querySelector('a[href="/login"]')!.getAttribute('rel')).toBe('noreferrer');
  });

  it('shows a rate-limit variant on 429 and retries with the token kept in memory', async () => {
    const { http, fixture, el } = await mount(`#${TOKEN}`);
    http.expectOne(`/api/auth/reset/${TOKEN}`).flush({ error: 'Too many' }, { status: 429, statusText: 'Too Many', headers: { 'Retry-After': '120' } });
    await tick(fixture);
    expect(el.textContent).toContain('Too many attempts. Try again in 2 min.');
    expect(el.textContent).not.toContain('not valid');
    el.querySelector('button')!.click();
    http.expectOne(`/api/auth/reset/${TOKEN}`).flush(INFO);
    await tick(fixture);
    expect(el.querySelector('h1')!.textContent).toBe('Choose a new password');
  });

  it('shows a retry state on a network error', async () => {
    const { http, fixture, el } = await mount(`#${TOKEN}`);
    http.expectOne(`/api/auth/reset/${TOKEN}`).error(new ProgressEvent('error'));
    await tick(fixture);
    expect(el.textContent).toContain('We could not check this link. Try again.');
    expect(el.textContent).toContain('Cannot reach the server');
    expect(el.textContent).not.toContain(TOKEN);
  });

  it('tells a different signed-in user what will happen', async () => {
    const { el } = await ready(`#${TOKEN}`, { displayName: 'Jan Baetens' });
    expect(el.textContent).toContain('You are signed in as Jan Baetens. Setting this password will sign you out and sign you in as Marie Dupont.');
  });

  it('checks strength and match in the browser, without a request, and marks the field', async () => {
    const { http, fixture, el } = await ready();
    await submit(fixture, el, 'short', 'short');
    http.expectNone(() => true);
    expect(el.querySelector('#reset-error')!.textContent).toBe('New password: At least 8 characters.');
    expect(field(el, 'newPassword').getAttribute('aria-invalid')).toBe('true');
    expect(field(el, 'newPassword').getAttribute('aria-describedby')).toBe('reset-error');
    expect(el.querySelector('[role="alert"]')!.contains(el.querySelector('#reset-error'))).toBe(true);
    await submit(fixture, el, 'long enough 1', 'long enough 2');
    http.expectNone(() => true);
    expect(el.querySelector('#reset-error')!.textContent).toBe('The two passwords do not match.');
    expect(field(el, 'newPassword').getAttribute('aria-invalid')).toBeNull();
    expect(field(el, 'newPasswordAgain').getAttribute('aria-invalid')).toBe('true');
  });

  it('sets the password, refreshes the session and goes to the campaigns', async () => {
    const { http, fixture, el, refresh, navigate } = await ready();
    await submit(fixture, el, 'a good password', 'a good password');
    const post = http.expectOne(`/api/auth/reset/${TOKEN}`);
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({ newPassword: 'a good password' });
    post.flush({ ok: true });
    await tick(fixture);
    expect(refresh).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/campaigns', { replaceUrl: true });
    expect(el.textContent).not.toContain(TOKEN);
  });

  it('ignores a second submit while busy', async () => {
    const { http, fixture, el } = await ready();
    await submit(fixture, el, 'a good password', 'a good password');
    expect(el.querySelector('button[type="submit"]')!.getAttribute('aria-disabled')).toBe('true');
    await submit(fixture, el, 'a good password', 'a good password');
    http.expectOne(`/api/auth/reset/${TOKEN}`).flush({ ok: true });
  });

  it('lands in the invalid state when the link dies between lookup and submit', async () => {
    const { http, fixture, el } = await ready();
    await submit(fixture, el, 'a good password', 'a good password');
    http.expectOne(`/api/auth/reset/${TOKEN}`).flush({ error: 'This reset link is not valid' }, { status: 404, statusText: 'Not Found' });
    await tick(fixture);
    expect(el.querySelector('h1')!.textContent).toBe('This reset link is not valid');
    expect(el.querySelector('input')).toBeNull();
  });

  it('keeps the form on 429 with a retry hint, and on a server rejection of the password', async () => {
    const { http, fixture, el } = await ready();
    await submit(fixture, el, 'a good password', 'a good password');
    http.expectOne(`/api/auth/reset/${TOKEN}`).flush({ error: 'Too many' }, { status: 429, statusText: 'Too Many', headers: { 'Retry-After': '45' } });
    await tick(fixture);
    expect(el.querySelector('#reset-error')!.textContent).toBe('Too many attempts. Try again in 45 s.');
    expect(field(el, 'newPassword')).toBeTruthy();
    await submit(fixture, el, 'a good password', 'a good password');
    http.expectOne(`/api/auth/reset/${TOKEN}`).flush({ error: 'Invalid input', issues: [{ path: 'newPassword', message: 'Too common' }] }, { status: 400, statusText: 'Bad Request' });
    await tick(fixture);
    expect(el.querySelector('#reset-error')!.textContent).toBe('newPassword: Too common');
    expect(field(el, 'newPassword').getAttribute('aria-invalid')).toBe('true');
  });

  it('says so when the password changed but the session could not be loaded', async () => {
    const { http, fixture, el, refresh } = await ready();
    refresh.mockRejectedValueOnce(new Error('x'));
    await submit(fixture, el, 'a good password', 'a good password');
    http.expectOne(`/api/auth/reset/${TOKEN}`).flush({ ok: true });
    await tick(fixture);
    expect(el.textContent).toContain('Your password was changed, but signing in failed.');
    expect(el.querySelector('a[href="/login"]')).toBeTruthy();
  });
});
