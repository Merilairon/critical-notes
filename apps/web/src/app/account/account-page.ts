import { A11yModule } from '@angular/cdk/a11y';
import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { afterNextRender, ChangeDetectionStrategy, Component, inject, Injector, signal, viewChild, type ElementRef } from '@angular/core';
import { passwordSchema, updateMeInput, type ApiTokenDto, type CreatedApiTokenDto, type UserDto } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { errorMessage, requestError } from '../core/http.interceptor';

/** Ready-to-paste setup for the common kinds of MCP clients. */
function setups(origin: string, token: string) {
  const url = `${origin}/mcp`;
  return [
    { label: 'Claude Code', text: `claude mcp add --transport http critical-notes ${url} --header "Authorization: Bearer ${token}"` },
    {
      label: 'Clients that connect over HTTP (JSON settings)',
      text: JSON.stringify({ mcpServers: { 'critical-notes': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    },
    {
      label: 'Clients that only start local programs, such as Claude Desktop (needs Node.js)',
      text: JSON.stringify(
        { mcpServers: { 'critical-notes': { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH_HEADER}'], env: { AUTH_HEADER: `Bearer ${token}` } } } },
        null,
        2,
      ),
    },
  ];
}

/** The signed-in user's account: display name, password, and API tokens for AI assistants (MCP). */
@Component({
  selector: 'cn-account-page',
  imports: [DatePipe, A11yModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="mx-auto max-w-3xl p-4 sm:p-6">
    <h1 class="font-display text-3xl font-bold">Account</h1>
    <p class="mt-1 text-muted">Signed in as {{ auth.user()?.displayName }} ({{ auth.user()?.username }}).</p>

    <section class="mt-6 rounded-xl border border-line bg-panel p-4" aria-labelledby="profile-heading">
      <h2 id="profile-heading" class="font-semibold">Display name</h2>
      <p class="mt-1 text-sm text-muted">The name other people see in campaigns. Your username ({{ auth.user()?.username }}) does not change.</p>
      <form novalidate class="mt-3 flex flex-wrap items-end gap-2 text-sm" (submit)="$event.preventDefault(); saveName(nameInput.value)">
        <label class="flex min-w-[min(12rem,100%)] flex-1 flex-col gap-1">
          <span class="text-xs text-muted">Display name</span>
          <input #nameInput class="cn-prop-input" name="displayName" autocomplete="nickname" required maxlength="80" (input)="nameDone.set('')" [value]="auth.user()?.displayName ?? ''"
            [attr.aria-invalid]="nameError() ? 'true' : null" [attr.aria-describedby]="nameError() ? 'name-error' : null" />
        </label>
        <button type="submit" class="cn-btn-primary w-full px-3 py-1.5 text-sm font-semibold aria-disabled:opacity-60 sm:w-auto" [attr.aria-disabled]="nameBusy() ? 'true' : null">Save name</button>
      </form>
      <div role="status" class="mt-2 text-sm">{{ nameDone() }}</div>
      <div role="alert" class="text-sm text-accent"><p id="name-error">{{ nameError() }}</p></div>
    </section>

    <section class="mt-6 rounded-xl border border-line bg-panel p-4" aria-labelledby="password-heading">
      <h2 id="password-heading" class="font-semibold">Password</h2>
      <p class="mt-1 text-sm text-muted">Changing your password signs you out on all your other devices. This one stays signed in.</p>
      <form novalidate class="mt-3 flex max-w-sm flex-col gap-3 text-sm" (submit)="$event.preventDefault(); changePassword(current.value, next.value, again.value)">
        <input type="text" name="username" autocomplete="username" class="sr-only" aria-hidden="true" tabindex="-1" [value]="auth.user()?.username ?? ''" />
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted">Current password</span>
          <input #current type="password" name="currentPassword" class="cn-prop-input" autocomplete="current-password" required
            [attr.aria-invalid]="pwField() === 'current' ? 'true' : null" [attr.aria-describedby]="pwField() === 'current' ? 'pw-error' : null" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted">New password (at least 8 characters)</span>
          <input #next type="password" name="newPassword" class="cn-prop-input" autocomplete="new-password" required minlength="8"
            [attr.aria-invalid]="pwField() === 'new' ? 'true' : null" [attr.aria-describedby]="pwField() === 'new' ? 'pw-error' : null" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted">New password again</span>
          <input #again type="password" name="newPasswordAgain" class="cn-prop-input" autocomplete="new-password" required
            [attr.aria-invalid]="pwField() === 'again' ? 'true' : null" [attr.aria-describedby]="pwField() === 'again' ? 'pw-error' : null" />
        </label>
        <button type="submit" class="cn-btn-primary w-full px-3 py-1.5 text-sm font-semibold aria-disabled:opacity-60 sm:w-auto sm:self-start" [attr.aria-disabled]="pwBusy() ? 'true' : null">Change password</button>
      </form>
      <div role="status" class="mt-2 text-sm">{{ pwDone() }}</div>
      <div role="alert" class="text-sm text-accent"><p id="pw-error">{{ pwError() }}</p></div>
    </section>

    <section class="mt-6 rounded-xl border border-line bg-panel p-4" aria-labelledby="sessions-heading">
      <h2 id="sessions-heading" class="font-semibold">Sessions</h2>
      <p class="mt-1 text-sm text-muted">Signed in somewhere you no longer use, or on a shared computer? Sign out everywhere else. This browser stays signed in, and your password and API tokens are not changed.</p>
      <button #endOthers type="button" class="cn-btn mt-3 w-full px-3 py-1.5 text-sm font-semibold aria-disabled:opacity-60 sm:w-auto" [attr.aria-disabled]="sessionsBusy() ? 'true' : null" (click)="endOtherSessions()">Sign out other sessions</button>
      <div role="status" class="mt-2 text-sm">{{ sessionsDone() }}</div>
      <div role="alert" class="text-sm text-accent"><p>{{ sessionsError() }}</p></div>
    </section>

    <section class="mt-6 rounded-xl border border-line bg-panel p-4" aria-label="AI assistants">
      <h2 class="font-semibold">AI assistants (MCP)</h2>
      <p class="mt-1 text-sm text-muted">
        An AI assistant that supports MCP (such as Claude) can read and write your campaigns: create NPCs and locations, write session notes,
        plan encounters, add homebrew. Give it an access token. It acts as you, with exactly your rights in each campaign: as a player it sees
        only what is shared with you and can edit only your own character.
      </p>

      <form class="mt-3 flex flex-wrap items-end gap-2 text-sm" (submit)="$event.preventDefault(); create(name.value, scope.value, days.value)">
        <label class="flex min-w-[min(12rem,100%)] flex-1 flex-col gap-1"
          ><span class="text-xs text-muted">Name</span><input #name class="cn-prop-input" required maxlength="60" placeholder="Claude on my laptop" aria-label="Token name"
        /></label>
        <label class="flex max-w-full min-w-0 flex-col gap-1"
          ><span class="text-xs text-muted">Access</span>
          <select #scope class="cn-prop-input max-w-full" aria-label="Access">
            <option value="write" selected>Read and write</option>
            <option value="read">Read only</option>
          </select>
        </label>
        <label class="flex max-w-full min-w-0 flex-col gap-1"
          ><span class="text-xs text-muted">Valid for</span>
          <select #days class="cn-prop-input max-w-full" aria-label="Valid for">
            <option value="30">30 days</option>
            <option value="90" selected>90 days</option>
            <option value="365">1 year</option>
            <option value="">No limit</option>
          </select>
        </label>
        <button type="submit" class="cn-btn-primary w-full px-3 py-1.5 text-sm font-semibold sm:w-auto" [disabled]="busy()">Create token</button>
      </form>

      @if (created(); as c) {
        <div class="mt-3 rounded-md border border-accent/50 bg-accent/5 p-3 text-sm" role="status">
          <p class="font-medium">Token “{{ c.name }}” created. Copy it now: it is shown only once.</p>
          <div class="mt-2 flex gap-2">
            <input #newToken class="cn-prop-input min-w-0 flex-1 font-mono text-xs" [value]="c.token" readonly aria-label="New token" (focus)="$any($event.target).select()" />
            <button type="button" class="cn-btn rounded px-2 py-0.5 font-normal" (click)="copy(c.token, 'token')">{{ copied() === 'token' ? 'Copied' : 'Copy' }}</button>
          </div>
          @for (s of setupFor(c.token); track s.label) {
            <div class="mt-3">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-medium text-muted">{{ s.label }}</span>
                <button type="button" class="cn-btn rounded px-2 py-0.5 text-xs font-normal" (click)="copy(s.text, s.label)">{{ copied() === s.label ? 'Copied' : 'Copy' }}</button>
              </div>
              <pre role="group" class="mt-1 overflow-x-auto rounded bg-panel-2 p-2 font-mono text-xs" [attr.aria-label]="s.label">{{ s.text }}</pre>
            </div>
          }
          <p class="mt-2 text-xs text-muted">The address is {{ endpoint }}. Anyone with the token can act as you: keep it like a password, and revoke it here if it leaks.</p>
        </div>
      }

      <h3 #tokensHeading tabindex="-1" class="mt-5 mb-1 text-sm font-semibold outline-none">Your tokens</h3>
      @if (tokens().length) {
        <table class="w-full text-sm">
          <thead class="text-left text-xs text-muted">
            <tr><th class="py-1">Name</th><th>Access</th><th>Created</th><th>Last used</th><th>Expires</th><th scope="col"><span class="sr-only">Actions</span></th></tr>
          </thead>
          <tbody>
            @for (t of tokens(); track t.id) {
              <tr class="border-t border-line">
                <td class="py-1.5 pr-2 font-medium">{{ t.name }}</td>
                <td class="pr-2">{{ t.scope === 'write' ? 'Read and write' : 'Read only' }}</td>
                <td class="pr-2 text-muted">{{ t.createdAt | date: 'mediumDate' }}</td>
                <td class="pr-2 text-muted">{{ t.lastUsedAt ? (t.lastUsedAt | date: 'short') : 'Never' }}</td>
                <td class="pr-2" [class.text-accent]="expired(t)">{{ t.expiresAt ? (expired(t) ? 'Expired' : (t.expiresAt | date: 'mediumDate')) : 'Never' }}</td>
                <td class="text-right"><button type="button" class="text-muted hover:text-accent touch:min-h-[44px] touch:px-2" (click)="revoke(t, $event)" [attr.aria-label]="'Revoke ' + t.name">Revoke</button></td>
              </tr>
            }
          </tbody>
        </table>
      } @else {
        <p class="text-sm text-muted">No tokens yet.</p>
      }
      @if (error()) {<p class="mt-2 text-sm text-accent" role="alert">{{ error() }}</p>}
    </section>
    @if (revoking(); as t) {
      <div class="fixed inset-0 z-60 flex items-start justify-center overflow-y-auto bg-black/40 p-3 sm:pt-[8vh]" (keydown.escape)="cancelRevoke()">
        <div cdkTrapFocus cdkTrapFocusAutoCapture role="alertdialog" aria-modal="true" aria-labelledby="revoke-title" aria-describedby="revoke-desc"
          class="w-full max-w-md rounded-xl border border-line bg-panel p-4 shadow-2xl">
          <h2 id="revoke-title" class="font-display text-xl font-bold">Revoke “{{ t.name }}”?</h2>
          <p id="revoke-desc" class="mt-2 text-sm">Assistants using this token stop working at once. This cannot be undone.</p>
          <div class="mt-4 flex flex-wrap justify-end gap-2 text-sm">
            <button type="button" class="rounded-md border border-line px-3 py-1.5 touch:min-h-[44px]" cdkFocusInitial (click)="cancelRevoke()">Cancel</button>
            <button type="button" class="rounded-md bg-accent px-3 py-1.5 font-semibold text-accent-ink touch:min-h-[44px]" (click)="confirmRevoke()">Revoke token</button>
          </div>
        </div>
      </div>
    }
    @if (version()) {<p class="mt-6 text-xs text-muted">Critical Notes {{ version() }}</p>}
  </div>`,
})
export class AccountPage {
  protected readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly injector = inject(Injector);
  protected readonly tokens = signal<ApiTokenDto[]>([]);
  protected readonly created = signal<CreatedApiTokenDto | null>(null);
  protected readonly copied = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  /** The server's version from `/api/health`; stays empty if that fails (the line is then hidden). */
  protected readonly version = signal('');
  protected readonly sessionsBusy = signal(false);
  protected readonly sessionsError = signal('');
  protected readonly sessionsDone = signal('');
  /** The token waiting for the revoke confirmation, and the button that opened it (focus goes back there on cancel). */
  protected readonly revoking = signal<ApiTokenDto | null>(null);
  private revokeOpener: HTMLElement | null = null;
  protected readonly nameBusy = signal(false);
  protected readonly nameError = signal('');
  protected readonly nameDone = signal('');
  protected readonly pwBusy = signal(false);
  protected readonly pwError = signal('');
  protected readonly pwDone = signal('');
  /** Which password field the current error belongs to (for aria-invalid and focus). */
  protected readonly pwField = signal<'current' | 'new' | 'again' | null>(null);
  private readonly nameEl = viewChild.required<ElementRef<HTMLInputElement>>('nameInput');
  private readonly currentEl = viewChild.required<ElementRef<HTMLInputElement>>('current');
  private readonly nextEl = viewChild.required<ElementRef<HTMLInputElement>>('next');
  private readonly againEl = viewChild.required<ElementRef<HTMLInputElement>>('again');
  private readonly endOthersEl = viewChild.required<ElementRef<HTMLButtonElement>>('endOthers');
  private readonly newTokenEl = viewChild<ElementRef<HTMLInputElement>>('newToken');
  private readonly tokensHeadingEl = viewChild<ElementRef<HTMLElement>>('tokensHeading');
  protected readonly endpoint = `${location.origin}/mcp`;
  private readonly now = signal(Date.now());
  protected readonly expired = (t: ApiTokenDto) => t.expiresAt !== null && t.expiresAt <= this.now();
  protected readonly setupFor = (token: string) => setups(location.origin, token);

  constructor() {
    void this.reload();
    this.http.get<{ version?: string }>('/api/health').subscribe({ next: (h) => this.version.set(h.version ?? ''), error: () => undefined });
  }

  protected async saveName(value: string) {
    if (this.nameBusy()) return;
    this.nameDone.set('');
    this.nameError.set('');
    this.pwError.set('');
    this.pwField.set(null);
    this.pwDone.set('');
    const parsed = updateMeInput.safeParse({ displayName: value });
    if (!parsed.success) {
      this.nameError.set('Enter a display name of 1 to 80 characters.');
      this.nameEl().nativeElement.focus();
      return;
    }
    this.nameBusy.set(true);
    try {
      const res = await firstValueFrom(this.http.patch<{ user: UserDto }>('/api/auth/me', parsed.data));
      this.auth.user.set(res.user);
      this.nameDone.set(`Display name changed to ${res.user.displayName}.`);
    } catch (err) {
      this.nameError.set(requestError(err));
      this.nameEl().nativeElement.focus();
    } finally {
      this.nameBusy.set(false);
    }
  }

  protected async changePassword(currentPassword: string, newPassword: string, again: string) {
    if (this.pwBusy()) return;
    this.nameDone.set('');
    this.nameError.set('');
    this.pwDone.set('');
    this.pwError.set('');
    this.pwField.set(null);
    const fail = (field: 'current' | 'new' | 'again', message: string) => {
      this.pwField.set(field);
      this.pwError.set(message);
      (field === 'current' ? this.currentEl() : field === 'new' ? this.nextEl() : this.againEl()).nativeElement.focus();
    };
    if (!currentPassword) return fail('current', 'Enter your current password.');
    const weak = passwordSchema.safeParse(newPassword);
    if (!weak.success) return fail('new', `New password: ${weak.error.issues[0]?.message ?? 'not allowed'}.`);
    if (newPassword !== again) return fail('again', 'The two new passwords do not match.');
    this.pwBusy.set(true);
    try {
      await firstValueFrom(this.http.post('/api/auth/password', { currentPassword, newPassword }));
      for (const el of [this.currentEl(), this.nextEl(), this.againEl()]) el.nativeElement.value = '';
      this.pwDone.set('Password changed. You were signed out on your other devices; this one stays signed in.');
      this.currentEl().nativeElement.focus();
    } catch (err) {
      const status = err instanceof HttpErrorResponse ? err.status : 0;
      fail(status === 401 || status === 429 ? 'current' : 'new', status === 401 ? 'The current password is not correct.' : requestError(err));
    } finally {
      this.pwBusy.set(false);
    }
  }

  private async reload() {
    try {
      this.tokens.set((await firstValueFrom(this.http.get<{ tokens: ApiTokenDto[] }>('/api/auth/tokens'))).tokens);
      this.now.set(Date.now());
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  protected async create(name: string, scope: string, days: string) {
    this.busy.set(true);
    this.error.set('');
    try {
      this.created.set(await firstValueFrom(this.http.post<CreatedApiTokenDto>('/api/auth/tokens', { name, scope, expiresInDays: days ? Number(days) : null })));
      this.copied.set(null);
      await this.reload();
      // The new token appears below the form and is shown only once: move focus to it (it is selected, ready to copy)
      afterNextRender(() => this.newTokenEl()?.nativeElement.focus(), { injector: this.injector });
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async copy(text: string, what: string) {
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    this.copied.set(what);
  }

  protected revoke(t: ApiTokenDto, event: Event) {
    this.revokeOpener = event.target instanceof HTMLElement ? event.target : null;
    this.revoking.set(t);
  }

  protected cancelRevoke() {
    this.revoking.set(null);
    this.revokeOpener?.focus();
  }

  protected async confirmRevoke() {
    const t = this.revoking();
    if (!t) return;
    this.revoking.set(null);
    this.error.set('');
    try {
      await firstValueFrom(this.http.delete(`/api/auth/tokens/${t.id}`));
      if (this.created()?.id === t.id) this.created.set(null);
      await this.reload();
      // The revoked row is gone, and so was the focus: put it on the list's heading
      afterNextRender(() => this.tokensHeadingEl()?.nativeElement.focus(), { injector: this.injector });
    } catch (err) {
      this.error.set(errorMessage(err));
      this.revokeOpener?.focus();
    }
  }

  protected async endOtherSessions() {
    if (this.sessionsBusy()) return;
    this.sessionsDone.set('');
    this.sessionsError.set('');
    this.sessionsBusy.set(true);
    try {
      const res = await firstValueFrom(this.http.post<{ ended: number }>('/api/auth/sessions/end-others', {}));
      this.sessionsDone.set(
        res.ended === 0 ? 'No other sessions were signed in.' : `Signed out ${res.ended} other ${res.ended === 1 ? 'session' : 'sessions'}. This browser stays signed in.`,
      );
    } catch (err) {
      this.sessionsError.set(requestError(err));
    } finally {
      this.sessionsBusy.set(false);
      this.endOthersEl().nativeElement.focus();
    }
  }
}
