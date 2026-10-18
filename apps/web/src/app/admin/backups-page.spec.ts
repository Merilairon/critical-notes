import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { BackupDto, BackupListDto } from '@cn/shared';
import { AuthService } from '../core/auth.service';
import { BACKUP_NAVIGATE } from './backup-download';
import { adminGuard } from './admin.guard';
import { BackupsPage, BACKUP_WARNING } from './backups-page';
import { UsersPage } from './users-page';
import { routes } from '../app.routes';

const flush = () => (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise((r) => setTimeout(r)));
async function tick(fixture: ComponentFixture<unknown>) {
  await flush();
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
}
const respond = (r: TestRequest, body: object | null, status = 200, headers: Record<string, string> = {}) => r.flush(body, { status, statusText: String(status), headers });

const N1 = 'backup-20261016T101500Z.zip';
const N2 = 'backup-20261017T080000Z.zip';
const backup = (name: string, extra: Partial<BackupDto> = {}): BackupDto => ({
  name,
  size: 3 * 1024 * 1024,
  createdAt: `${name.slice(7, 11)}-${name.slice(11, 13)}-${name.slice(13, 15)}T${name.slice(16, 18)}:${name.slice(18, 20)}:${name.slice(20, 22)}Z`,
  trigger: 'api',
  appVersion: '1.2.3',
  migrationLevel: '0006_accounts',
  counts: { users: 2, campaigns: 1, uploads: 5 },
  missingUploads: null,
  ...extra,
});
const list = (extra: Partial<BackupListDto> = {}): BackupListDto => ({ backups: [backup(N2, { trigger: 'cli' }), backup(N1, { missingUploads: 2 })], running: null, lastError: null, lastWarnings: [], schedule: null, directory: '/data/app/backups', adminPrograms: { docker: 'docker compose run --rm app node admin.mjs', bare: 'node apps/server/dist/admin.mjs' }, ...extra });

async function mount(initial: BackupListDto | { error: string; status: number } = list()) {
  const navigate = vi.fn();
  const me = signal({ id: 'me', username: 'me', displayName: 'Me', isAdmin: true });
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: AuthService, useValue: { user: me, refresh: vi.fn(async () => undefined) } },
      { provide: BACKUP_NAVIGATE, useValue: navigate },
    ],
  });
  const fixture = TestBed.createComponent(BackupsPage);
  const http = TestBed.inject(HttpTestingController);
  document.body.append(fixture.nativeElement);
  fixture.detectChanges();
  const req = http.expectOne('/api/admin/backups');
  if ('error' in initial) respond(req, { error: initial.error }, initial.status);
  else req.flush(initial);
  await tick(fixture);
  return { fixture, el: fixture.nativeElement as HTMLElement, http, navigate };
}

const status = (el: HTMLElement) => el.querySelector('div[role="status"]')!.textContent!.trim();
const actionError = (el: HTMLElement) => el.querySelector('div[role="alert"]')!.textContent!.trim();
const backupNow = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('#backup-now')!;
const dialog = (el: HTMLElement) => el.querySelector<HTMLElement>('[role="dialog"]');
const password = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input[name="currentPassword"]')!;
const dlButton = (el: HTMLElement, name: string) => el.querySelector<HTMLButtonElement>(`table button[data-name="${name}"]`)!;
const dialogAlert = (el: HTMLElement) => dialog(el)!.querySelector('[role="alert"]')!.textContent!.trim();
const submit = (el: HTMLElement, pw: string) => {
  password(el).value = pw;
  password(el).form!.dispatchEvent(new Event('submit'));
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('BackupsPage list', () => {
  it('shows the backups newest first with trigger text, version, level, counts and the missing uploads warning', async () => {
    const { el } = await mount();
    const rows = Array.from(el.querySelectorAll('table tbody tr'));
    expect(rows.length).toBe(2);
    expect(rows[0]!.textContent).toContain(N2);
    expect(rows[0]!.textContent).toContain('Command line');
    expect(rows[1]!.textContent).toContain('Web page');
    expect(rows[1]!.textContent).toContain('App 1.2.3 · database 0006_accounts · 2 users · 1 campaign · 5 uploads');
    expect(rows[1]!.textContent).toContain('Warning: 2 uploads had no file when this backup was made.');
    expect(rows[0]!.textContent).not.toContain('Warning');
    expect(rows[0]!.textContent).toContain('3.0 MB');
    expect(el.querySelectorAll('ul li').length).toBe(2);
    expect(el.textContent).toContain('2 backups');
  });

  it('shows the schedule line: off, every N hours with the next run, and without a next run yet', async () => {
    let m = await mount();
    expect(m.el.querySelector('#backup-schedule')!.textContent!.trim()).toBe('Scheduled backups: off');
    m.fixture.destroy();
    TestBed.resetTestingModule();
    m = await mount(list({ schedule: { everyHours: 24, nextRunAt: '2026-10-18T08:00:00.000Z' } }));
    const text = m.el.querySelector('#backup-schedule')!.textContent!.trim();
    expect(text).toMatch(/^Scheduled backups: every 24 hours, next run .+2026/);
    m.fixture.destroy();
    TestBed.resetTestingModule();
    m = await mount(list({ schedule: { everyHours: 1, nextRunAt: null } }));
    expect(m.el.querySelector('#backup-schedule')!.textContent!.trim()).toBe('Scheduled backups: every hour');
  });

  it('shows the security warning next to the download action', async () => {
    const { el } = await mount();
    expect(el.querySelector('#backup-warning')!.textContent).toContain(BACKUP_WARNING);
    expect(dlButton(el, N2).getAttribute('aria-describedby')).toContain('backup-warning');
  });

  it('handles a backup without a readable manifest', async () => {
    const { el } = await mount(list({ backups: [backup(N1, { appVersion: null, migrationLevel: null, counts: null })] }));
    expect(el.querySelector('table tbody')!.textContent).toContain('Details unknown');
  });

  it('shows an empty state and no download warning', async () => {
    const { el } = await mount(list({ backups: [] }));
    expect(el.textContent).toContain('There are no backups yet');
    expect(el.querySelector('table')).toBeNull();
  });

  it('shows a loading state, then a retryable error', async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: AuthService, useValue: { user: signal({ id: 'me', isAdmin: true }), refresh: vi.fn() } }],
    });
    const fixture = TestBed.createComponent(BackupsPage);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Loading backups');
    respond(http.expectOne('/api/admin/backups'), { error: 'Boom' }, 500);
    await tick(fixture);
    expect(fixture.nativeElement.textContent).toContain('Boom');
    fixture.nativeElement.querySelector('section button')!.click();
    http.expectOne('/api/admin/backups').flush(list());
    await tick(fixture);
    expect(fixture.nativeElement.querySelectorAll('table tbody tr').length).toBe(2);
  });

  it('offers a way back when the server says not an admin', async () => {
    const { el } = await mount({ error: 'Admins only', status: 403 });
    expect(el.textContent).toContain('Admins only');
    expect(el.querySelector('section a')!.textContent).toContain('Back to campaigns');
  });

  it('shows lastError and lastWarnings as plain text', async () => {
    const { el } = await mount(list({ lastError: 'Not enough <b>space</b>', lastWarnings: ['2 uploads <img src=x onerror=alert(1)> skipped'] }));
    expect(el.textContent).toContain('Not enough <b>space</b>');
    expect(el.textContent).toContain('<img src=x onerror=alert(1)> skipped');
    expect(el.querySelector('b, img')).toBeNull();
  });

  it('explains restore and retention, with no delete or restore button', async () => {
    const { el } = await mount();
    const t = el.textContent!;
    expect(t).toContain('docker compose stop app');
    expect(t).toContain('protected for 7 days');
    const labels = Array.from(el.querySelectorAll('button')).map((b) => b.textContent!.trim().toLowerCase());
    expect(labels.some((l) => /delete|restore|remove/.test(l))).toBe(false);
  });

  const code = (el: HTMLElement) => Array.from(el.querySelectorAll('pre')).map((p) => p.textContent!.split('\n'));

  it('builds the restore hints from the DTO, --check first, for Docker and a bare install', async () => {
    const { el } = await mount(list({ directory: '/srv/cn/backups', adminPrograms: { docker: 'DOCK admin', bare: 'BARE admin' } }));
    const [docker, bare, backup] = code(el);
    expect(docker).toEqual(['docker compose stop app', `DOCK admin restore /srv/cn/backups/${N2} --check`, `DOCK admin restore /srv/cn/backups/${N2} --yes`]);
    expect(bare).toEqual([`BARE admin restore /srv/cn/backups/${N2} --check`, `BARE admin restore /srv/cn/backups/${N2} --yes`]);
    expect(backup).toEqual(['DOCK admin backup', 'BARE admin backup']);
    expect(el.textContent).toContain('Backups folder the server reports: /srv/cn/backups');
  });

  it('uses <file> when there is no backup yet and trims a trailing slash', async () => {
    const { el } = await mount(list({ backups: [], directory: '/b/' }));
    expect(code(el)[1][0]).toBe('node apps/server/dist/admin.mjs restore /b/<file> --check');
  });

  it('shows the README pointer instead of commands when the server reports nothing', async () => {
    const { el } = await mount({ ...list(), directory: undefined, adminPrograms: undefined } as unknown as BackupListDto);
    expect(el.querySelectorAll('pre').length).toBe(0);
    expect(el.querySelector('#hints-missing')!.textContent).toContain('README');
    expect(el.textContent).not.toContain('admin.mjs');
  });

  it('wraps the restore commands so no keyboard-unreachable scroll area exists', async () => {
    const { el } = await mount();
    const pres = Array.from(el.querySelectorAll('pre'));
    expect(pres.length).toBe(3);
    for (const pre of pres) {
      expect(pre.className).toContain('whitespace-pre-wrap');
      expect(pre.className).not.toContain('overflow-x-auto');
    }
  });

  it('announces a load error and pauses Back up now with a visible reason', async () => {
    const { el } = await mount({ error: 'Something went wrong', status: 500 });
    expect(el.querySelector('section [role="alert"]')!.textContent).toContain('Something went wrong');
    const b = backupNow(el);
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(el.querySelector(`#${b.getAttribute('aria-describedby')}`)!.textContent).toContain('could not be loaded');
    b.click();
    const { http } = { http: TestBed.inject(HttpTestingController) };
    http.expectNone({ method: 'POST', url: '/api/admin/backups' });
  });

  it('has the admin section nav with Backups current', async () => {
    const { el } = await mount();
    const nav = el.querySelector('nav[aria-label="Admin sections"]')!;
    const links = Array.from(nav.querySelectorAll('a'));
    expect(links.map((a) => a.textContent!.trim())).toEqual(['Users', 'Backups']);
    expect(links[0]!.getAttribute('aria-current')).toBeNull();
    expect(links[1]!.getAttribute('aria-current')).toBe('page');
  });
});

describe('Users page nav', () => {
  it('links to Backups with Users current', async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: AuthService, useValue: { user: signal({ id: 'me', isAdmin: true }), refresh: vi.fn() } }],
    });
    const fixture = TestBed.createComponent(UsersPage);
    TestBed.inject(HttpTestingController).expectOne('/api/admin/users').flush({ users: [] });
    fixture.detectChanges();
    const links = Array.from<HTMLAnchorElement>(fixture.nativeElement.querySelectorAll('nav[aria-label="Admin sections"] a'));
    expect(links.map((a) => [a.textContent!.trim(), a.getAttribute('aria-current')])).toEqual([
      ['Users', 'page'],
      ['Backups', null],
    ]);
    expect(links[1]!.getAttribute('href')).toBe('/admin/backups');
  });
});

describe('route', () => {
  it('is lazy, titled and guarded by adminGuard inside the auth guard', () => {
    const shell = routes.find((r) => r.children && r.canActivate)!;
    const route = shell.children!.find((r) => r.path === 'admin/backups')!;
    expect(route.canActivate).toEqual([adminGuard]);
    expect(route.loadComponent).toBeTypeOf('function');
    expect(route.title).toContain('Backups');
  });
});

describe('Back up now', () => {
  it('posts, announces start and finish, and stops polling when not running', async () => {
    vi.useFakeTimers();
    const { fixture, el, http } = await mount(list({ backups: [] }));
    backupNow(el).click();
    const post = http.expectOne({ method: 'POST', url: '/api/admin/backups' });
    fixture.detectChanges();
    expect(backupNow(el).getAttribute('aria-disabled')).toBe('true');
    respond(post, { name: null, status: 'running' }, 202);
    await tick(fixture);
    http.expectOne('/api/admin/backups').flush(list({ backups: [], running: { name: null, startedAt: 'x' } }));
    await tick(fixture);
    expect(status(el)).toBe('Backup started.');
    // disabled with a visible reason while running
    expect(backupNow(el).getAttribute('aria-disabled')).toBe('true');
    const reason = el.querySelector(`#${backupNow(el).getAttribute('aria-describedby')}`)!;
    expect(reason.textContent).toContain('A backup is running');
    backupNow(el).click();
    http.expectNone({ method: 'POST', url: '/api/admin/backups' });
    // poll every 2 s
    await vi.advanceTimersByTimeAsync(1900);
    http.expectNone('/api/admin/backups');
    await vi.advanceTimersByTimeAsync(200);
    http.expectOne('/api/admin/backups').flush(list({ running: { name: N2, startedAt: 'x' } }));
    await tick(fixture);
    await vi.advanceTimersByTimeAsync(2000);
    http.expectOne('/api/admin/backups').flush(list());
    await tick(fixture);
    expect(status(el)).toBe('The backup finished.');
    expect(backupNow(el).getAttribute('aria-disabled')).toBeNull();
    // polling stopped
    await vi.advanceTimersByTimeAsync(10_000);
    http.expectNone('/api/admin/backups');
  });

  it('handles 202 done: refreshes once and announces the result, a failure with its fixed sentence', async () => {
    vi.useFakeTimers();
    const { fixture, el, http } = await mount();
    backupNow(el).click();
    respond(http.expectOne({ method: 'POST', url: '/api/admin/backups' }), { name: N2, status: 'done' }, 202);
    await tick(fixture);
    http.expectOne('/api/admin/backups').flush(list({ lastError: 'The last backup failed. Nothing was kept; check the server log.' }));
    await tick(fixture);
    expect(status(el)).toBe('The last backup failed. Nothing was kept; check the server log.');
    expect(el.textContent).toContain('The last backup failed');
    await vi.advanceTimersByTimeAsync(10_000);
    http.expectNone('/api/admin/backups');
  });

  it('stops polling when the page is destroyed', async () => {
    vi.useFakeTimers();
    const { fixture, http } = await mount(list({ running: { name: null, startedAt: 'x' } }));
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(10_000);
    http.expectNone('/api/admin/backups');
  });

  it('backs off when the list fails while a backup runs, and recovers', async () => {
    vi.useFakeTimers();
    const { fixture, el, http } = await mount(list({ running: { name: null, startedAt: 'x' } }));
    await vi.advanceTimersByTimeAsync(2000);
    respond(http.expectOne('/api/admin/backups'), { error: 'x' }, 500);
    await tick(fixture);
    expect(status(el)).toContain('Could not refresh');
    expect(el.querySelectorAll('table tbody tr').length).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    http.expectNone('/api/admin/backups');
    await vi.advanceTimersByTimeAsync(2100);
    http.expectOne('/api/admin/backups').flush(list());
    await tick(fixture);
    expect(status(el)).toBe('The backup finished.');
  });

  it('does not poll while the tab is hidden and refreshes when it is visible again', async () => {
    vi.useFakeTimers();
    const { fixture, http } = await mount(list({ running: { name: null, startedAt: 'x' } }));
    let hidden = true;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    await vi.advanceTimersByTimeAsync(5000);
    http.expectNone('/api/admin/backups');
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    http.expectOne('/api/admin/backups').flush(list());
    await tick(fixture);
  });

  async function refuse(status: number, body: object, headers: Record<string, string> = {}) {
    const ctx = await mount();
    backupNow(ctx.el).click();
    respond(ctx.http.expectOne({ method: 'POST', url: '/api/admin/backups' }), body, status, headers);
    await tick(ctx.fixture);
    return ctx;
  }

  it('maps 409 busy and refreshes the list', async () => {
    const { el, http, fixture } = await refuse(409, { error: 'A backup is already running' });
    expect(actionError(el)).toBe('A backup is already running. This page updates when it is done.');
    http.expectOne('/api/admin/backups').flush(list({ running: { name: null, startedAt: 'x' } }));
    await tick(fixture);
    expect(backupNow(el).getAttribute('aria-disabled')).toBe('true');
  });

  it('maps 409 restore in progress', async () => {
    const { el } = await refuse(409, { error: 'A restore is running or was interrupted; backups are refused until it is finished' });
    expect(actionError(el)).toBe('A restore is running or was interrupted, so backups are refused until it is finished.');
  });

  it('maps the API cap to a page sentence that points at the help, not at server text', async () => {
    const { el } = await refuse(409, { error: 'Too many recent backups were made from the web page (21); older ones are released after 7 days. Use the command line instead (see the help on the Backups page).' });
    expect(actionError(el)).toBe('Too many backups were made from this page recently. Use the command line instead (see the help below).');
    expect(el.textContent).toContain('docker compose run --rm app node admin.mjs backup');
    expect(el.textContent).toContain('node apps/server/dist/admin.mjs backup');
  });

  it('maps 429 with Retry-After', async () => {
    const { el } = await refuse(429, { error: 'x' }, { 'Retry-After': '540' });
    expect(actionError(el)).toBe('You can make 3 backups from this page every 10 minutes. Try again in 9 min.');
  });

  it('maps 507 no space', async () => {
    const { el } = await refuse(507, { error: 'raw server text with /var/path' });
    expect(actionError(el)).toBe('Not enough free disk space for a backup. Lower BACKUP_KEEP, free space or point BACKUP_DIR at a larger disk.');
    expect(backupNow(el).getAttribute('aria-disabled')).toBeNull();
  });
});

describe('download', () => {
  async function open(ctx: Awaited<ReturnType<typeof mount>>) {
    dlButton(ctx.el, N2).click();
    await tick(ctx.fixture);
  }

  it('opens the step-up dialog with the security warning, nothing requested yet', async () => {
    const ctx = await mount();
    await open(ctx);
    ctx.http.expectNone(() => true);
    expect(dialog(ctx.el)!.textContent).toContain(BACKUP_WARNING);
    expect(dialog(ctx.el)!.textContent).toContain(`Download ${N2}`);
    expect(ctx.navigate).not.toHaveBeenCalled();
  });

  it('exchanges the password for a ticket, navigates to the right URL and keeps nothing', async () => {
    const ctx = await mount();
    await open(ctx);
    const pw = password(ctx.el);
    submit(ctx.el, 'hunter2');
    const req = ctx.http.expectOne({ method: 'POST', url: `/api/admin/backups/${N2}/ticket` });
    expect(req.request.body).toEqual({ currentPassword: 'hunter2' });
    respond(req, { ticket: 'T1CKET_abc-123', expiresInSec: 60 });
    await tick(ctx.fixture);
    expect(ctx.navigate).toHaveBeenCalledTimes(1);
    expect(ctx.navigate).toHaveBeenCalledWith(`/api/admin/backups/${N2}?ticket=T1CKET_abc-123`);
    expect(pw.value).toBe('');
    expect(dialog(ctx.el)).toBeNull();
    ctx.http.expectNone(() => true);
    // the ticket is nowhere: not in the DOM, a signal, the router state or storage
    expect(document.body.innerHTML).not.toContain('T1CKET');
    expect(JSON.stringify(Object.values(ctx.fixture.componentInstance as object).map((v) => (typeof v === 'function' && 'set' in v ? (v as () => unknown)() : null)))).not.toContain('T1CKET');
    expect(JSON.stringify(history.state ?? null)).not.toContain('T1CKET');
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('T1CKET');
    expect(TestBed.inject(Router).url).not.toContain('ticket');
    expect(status(ctx.el)).toBe(`Download of ${N2} started. Your browser saves it to disk.`);
  });

  it('disables the button after the click so the ticket cannot be used twice, then re-enables it', async () => {
    vi.useFakeTimers();
    const ctx = await mount();
    await open(ctx);
    submit(ctx.el, 'pw');
    respond(ctx.http.expectOne(`/api/admin/backups/${N2}/ticket`), { ticket: 't', expiresInSec: 60 });
    await tick(ctx.fixture);
    const btn = dlButton(ctx.el, N2);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    btn.click();
    await tick(ctx.fixture);
    expect(dialog(ctx.el)).toBeNull();
    expect(dlButton(ctx.el, N1).getAttribute('aria-disabled')).toBeNull();
    await vi.advanceTimersByTimeAsync(5100);
    ctx.fixture.detectChanges();
    expect(btn.getAttribute('aria-disabled')).toBeNull();
  });

  it('answers a wrong password inline, clears the field and does not navigate', async () => {
    const ctx = await mount();
    await open(ctx);
    submit(ctx.el, 'nope');
    respond(ctx.http.expectOne(`/api/admin/backups/${N2}/ticket`), { error: 'Your password is wrong' }, 403);
    await tick(ctx.fixture);
    expect(dialogAlert(ctx.el)).toBe('Your password is wrong.');
    expect(password(ctx.el).value).toBe('');
    expect(ctx.navigate).not.toHaveBeenCalled();
    expect(dialog(ctx.el)).not.toBeNull();
  });

  it('shows the wait message after a 429 and sends nothing while waiting', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const ctx = await mount();
    await open(ctx);
    submit(ctx.el, 'x');
    respond(ctx.http.expectOne(`/api/admin/backups/${N2}/ticket`), { error: 'Too many' }, 429, { 'Retry-After': '30' });
    await tick(ctx.fixture);
    expect(dialogAlert(ctx.el)).toBe('Too many attempts. Try again in 30 s.');
    expect(dialog(ctx.el)!.textContent).toContain('You can try again in 30 s.');
    submit(ctx.el, 'x');
    ctx.http.expectNone(() => true);
    expect(ctx.navigate).not.toHaveBeenCalled();
  });

  it('closes the dialog on Escape without a request', async () => {
    const ctx = await mount();
    await open(ctx);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await tick(ctx.fixture);
    expect(dialog(ctx.el)).toBeNull();
    ctx.http.expectNone(() => true);
  });

  it('never uses fetch or HEAD for a download', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    const ctx = await mount();
    await open(ctx);
    submit(ctx.el, 'pw');
    respond(ctx.http.expectOne(`/api/admin/backups/${N2}/ticket`), { ticket: 't', expiresInSec: 60 });
    await tick(ctx.fixture);
    expect(f).not.toHaveBeenCalled();
    ctx.http.expectNone((r) => r.method === 'HEAD' || r.url.includes('ticket='));
  });
});

describe('default navigation seam', () => {
  it('clicks a temporary same-tab anchor with download and noreferrer, and removes it', () => {
    const nav = TestBed.inject(BACKUP_NAVIGATE);
    let connected = false;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      connected = this.isConnected;
    });
    nav('/api/admin/backups/x.zip?ticket=abc');
    expect(click).toHaveBeenCalledTimes(1);
    const seen = click.mock.contexts[0] as HTMLAnchorElement;
    expect(connected).toBe(true);
    expect(seen.getAttribute('href')).toBe('/api/admin/backups/x.zip?ticket=abc');
    expect(seen.hasAttribute('download')).toBe(true);
    expect(seen.rel).toBe('noreferrer');
    expect(seen.target).toBe('');
    expect(seen.isConnected).toBe(false);
  });
});
