import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { afterNextRender, ChangeDetectionStrategy, Component, inject, Injector, signal, viewChild, type ElementRef } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { passwordSchema, type ResetInfoDto } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { errorMessage, requestError } from '../core/http.interceptor';

type State = 'checking' | 'ready' | 'invalid' | 'limited' | 'failed' | 'signing' | 'signin-failed';

/** `randomBytes(32).toString('base64url')` is exactly 43 characters. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Password reset through a one-time link, `/reset#<token>`. The token is in the URL fragment so it never reaches a server log or a
 * `Referer`; it is read once, stripped from the address bar before any request, and kept only in a private field.
 */
@Component({
  selector: 'cn-reset',
  imports: [DatePipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="flex min-h-full items-center justify-center p-4">
    <div class="w-full max-w-md rounded-xl border border-line bg-panel p-6 shadow-sm">
      @switch (state()) {
        @case ('checking') {
          <p role="status" class="text-sm text-muted">Checking your link…</p>
        }
        @case ('invalid') {
          <h1 #heading tabindex="-1" class="font-display text-2xl font-bold text-accent">This reset link is not valid</h1>
          <p class="mt-3 text-sm">It may have been used already, or it may have expired or been replaced by a newer link. Ask the person who runs this server for a new one.</p>
          <a routerLink="/login" rel="noreferrer" class="mt-4 inline-block rounded-md bg-accent px-3 py-2 font-medium text-accent-ink">Go to sign in</a>
        }
        @case ('limited') {
          <h1 #heading tabindex="-1" class="font-display text-2xl font-bold text-accent">Please wait a moment</h1>
          <p class="mt-3 text-sm">{{ notice() }}</p>
          <button type="button" class="mt-4 rounded-md bg-accent px-3 py-2 font-medium text-accent-ink" (click)="check()">Retry</button>
        }
        @case ('failed') {
          <h1 #heading tabindex="-1" class="font-display text-2xl font-bold text-accent">We could not check this link</h1>
          <p class="mt-3 text-sm">We could not check this link. Try again.</p>
          <p class="mt-1 text-sm text-muted">{{ notice() }}</p>
          <button type="button" class="mt-4 rounded-md bg-accent px-3 py-2 font-medium text-accent-ink" (click)="check()">Retry</button>
        }
        @case ('signin-failed') {
          <h1 #heading tabindex="-1" class="font-display text-2xl font-bold text-accent">Password changed</h1>
          <p class="mt-3 text-sm">Your password was changed, but signing in failed. Sign in with your new password.</p>
          <a routerLink="/login" rel="noreferrer" class="mt-4 inline-block rounded-md bg-accent px-3 py-2 font-medium text-accent-ink">Go to sign in</a>
        }
        @default {
          @if (info(); as i) {
            <h1 #heading tabindex="-1" class="font-display text-2xl font-bold text-accent">Choose a new password</h1>
            <p class="mt-3 text-sm">For {{ i.displayName }} ({{ i.username }}).</p>
            <p class="text-sm text-muted">This link works once and expires on {{ i.expiresAt | date: 'medium' }}.</p>
            <p class="mt-1 text-sm text-muted">Not your account? Close this page and tell the person who sent you the link.</p>
            @if (auth.user(); as other) {
              <p class="mt-2 text-sm text-muted">You are signed in as {{ other.displayName }}. Setting this password will sign you out and sign you in as {{ i.displayName }}.</p>
            }
            <form novalidate class="mt-4 flex flex-col gap-3 text-sm" (submit)="$event.preventDefault(); submit(next.value, again.value)">
              <input type="text" name="username" autocomplete="username" class="sr-only" aria-hidden="true" tabindex="-1" [value]="i.username" />
              <label class="flex flex-col gap-1">
                <span class="font-medium">New password (at least 8 characters)</span>
                <input #next type="password" name="newPassword" class="w-full rounded-md border border-line bg-bg px-3 py-2" autocomplete="new-password" required minlength="8"
                  [attr.aria-invalid]="field() === 'new' ? 'true' : null" [attr.aria-describedby]="field() === 'new' ? 'reset-error' : null" />
              </label>
              <label class="flex flex-col gap-1">
                <span class="font-medium">New password again</span>
                <input #again type="password" name="newPasswordAgain" class="w-full rounded-md border border-line bg-bg px-3 py-2" autocomplete="new-password" required
                  [attr.aria-invalid]="field() === 'again' ? 'true' : null" [attr.aria-describedby]="field() === 'again' ? 'reset-error' : null" />
              </label>
              <div role="alert" class="text-sm text-accent"><p id="reset-error">{{ error() }}</p></div>
              <button type="submit" class="w-full rounded-md bg-accent px-3 py-2 font-medium text-accent-ink aria-disabled:opacity-60" [attr.aria-disabled]="busy() ? 'true' : null">
                {{ busy() ? 'Setting password…' : 'Set password and sign in' }}
              </button>
            </form>
          }
        }
      }
      <div role="status" class="text-sm">{{ state() === 'signing' ? 'Password set. Signing you in…' : '' }}</div>
    </div>
  </div>`,
})
export class ResetPage {
  protected readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);

  /** The live credential. Deliberately a plain private field: never a signal, never rendered, stored or logged. */
  private token = '';

  protected readonly state = signal<State>('checking');
  protected readonly info = signal<ResetInfoDto | null>(null);
  protected readonly notice = signal('');
  protected readonly error = signal('');
  protected readonly field = signal<'new' | 'again' | null>(null);
  protected readonly busy = signal(false);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly nextEl = viewChild<ElementRef<HTMLInputElement>>('next');
  private readonly againEl = viewChild<ElementRef<HTMLInputElement>>('again');

  constructor() {
    // Before anything else, including any HTTP call: take the token out of the address bar and the current history entry.
    this.token = location.hash.slice(1);
    if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
    // Only to tell who is signed in on this browser; failure is ignored.
    void this.auth.ensureLoaded().catch(() => undefined);
    if (!TOKEN_SHAPE.test(this.token)) this.invalid();
    else void this.check();
  }

  protected async check() {
    this.state.set('checking');
    try {
      this.info.set(await firstValueFrom(this.http.get<ResetInfoDto>(`/api/auth/reset/${this.token}`)));
      this.state.set('ready');
      this.focusAfterRender(() => this.nextEl() ?? this.heading());
    } catch (err) {
      const status = err instanceof HttpErrorResponse ? err.status : 0;
      if (status === 404) return this.invalid();
      this.notice.set(status === 429 ? requestError(err) : errorMessage(err));
      this.state.set(status === 429 ? 'limited' : 'failed');
      this.focusAfterRender(() => this.heading());
    }
  }

  protected async submit(newPassword: string, again: string) {
    if (this.busy()) return;
    this.error.set('');
    this.field.set(null);
    const fail = (field: 'new' | 'again', message: string) => {
      this.field.set(field);
      this.error.set(message);
      (field === 'new' ? this.nextEl() : this.againEl())?.nativeElement.focus();
    };
    const weak = passwordSchema.safeParse(newPassword);
    if (!weak.success) return fail('new', `New password: ${weak.error.issues[0]?.message ?? 'not allowed'}.`);
    if (newPassword !== again) return fail('again', 'The two passwords do not match.');
    this.busy.set(true);
    try {
      await firstValueFrom(this.http.post(`/api/auth/reset/${this.token}`, { newPassword }));
    } catch (err) {
      this.busy.set(false);
      const status = err instanceof HttpErrorResponse ? err.status : 0;
      if (status === 404) return this.invalid();
      return fail('new', status === 429 ? requestError(err) : errorMessage(err));
    }
    this.token = '';
    this.state.set('signing');
    try {
      await this.auth.refresh();
    } catch {
      this.busy.set(false);
      this.state.set('signin-failed');
      this.focusAfterRender(() => this.heading());
      return;
    }
    await this.router.navigateByUrl('/campaigns', { replaceUrl: true });
  }

  /** The one screen for every dead link: no reason, no username. */
  private invalid() {
    this.token = '';
    this.info.set(null);
    this.state.set('invalid');
    this.focusAfterRender(() => this.heading());
  }

  private focusAfterRender(target: () => ElementRef<HTMLElement> | undefined) {
    afterNextRender(() => target()?.nativeElement.focus(), { injector: this.injector });
  }
}
