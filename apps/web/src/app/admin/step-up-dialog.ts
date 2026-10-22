import { HttpErrorResponse } from '@angular/common/http';
import { afterNextRender, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { A11yModule } from '@angular/cdk/a11y';
import { AuthService } from '../core/auth.service';
import { errorMessage, requestError } from '../core/http.interceptor';
import { inertOutside } from '../core/inert';

/**
 * The one confirmation dialog for every protected admin action: the acting admin's own password, focus
 * trap, Esc, busy state and the mapping of every server answer. The page supplies `submit` (the HTTP call,
 * which throws HttpErrorResponse) and projects the consequence text (default slot), extra controls
 * (`[extras]`) and, for the reset link, the result view (`[result]`, when `phase` is `result`).
 */
@Component({
  selector: 'cn-step-up-dialog',
  imports: [A11yModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'onEscape($event)' },
  template: `<div class="fixed inset-0 z-60 flex items-start justify-center overflow-y-auto bg-black/40 p-3 sm:pt-[8vh]">
    <div
      cdkTrapFocus
      cdkTrapFocusAutoCapture
      role="dialog"
      aria-modal="true"
      aria-labelledby="stepup-title"
      aria-describedby="stepup-desc"
      [attr.aria-busy]="busy() ? 'true' : null"
      class="max-h-[calc(100dvh-1.5rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-line bg-panel p-4 shadow-2xl"
    >
      <h2 id="stepup-title" class="font-display text-xl font-bold">{{ heading() }}</h2>
      @if (lost()) {
        <p id="stepup-desc" class="mt-3 text-sm">You are no longer an admin.</p>
        <div class="mt-4 flex justify-end">
          <button type="button" class="rounded-md bg-accent px-3 py-1.5 font-semibold text-accent-ink" (click)="rightsLost.emit()">Close</button>
        </div>
      } @else {
        <div id="stepup-desc" class="mt-2 space-y-2 text-sm"><ng-content /></div>
        @if (phase() === 'result') {
          <ng-content select="[result]" />
          <div class="mt-4 flex justify-end">
            <button type="button" class="rounded-md bg-accent px-3 py-1.5 font-semibold text-accent-ink" (click)="dismissed.emit()">Done</button>
          </div>
        } @else {
          <form novalidate class="mt-3 text-sm" (submit)="$event.preventDefault(); confirm()">
            <ng-content select="[extras]" />
            @if (askPassword()) {
              <input type="text" name="username" autocomplete="username" class="sr-only" aria-hidden="true" tabindex="-1" [value]="auth.user()?.username ?? ''" />
              <label class="mt-3 flex flex-col gap-1">
                <span class="font-medium">Confirm with your password</span>
                <input #pw type="password" name="currentPassword" class="cn-prop-input" autocomplete="current-password" required cdkFocusInitial
                  [attr.aria-invalid]="passwordInvalid() ? 'true' : null" [attr.aria-describedby]="passwordInvalid() ? 'stepup-hint stepup-error' : 'stepup-hint'" />
              </label>
              <p id="stepup-hint" class="mt-1 text-xs text-muted">Your own password, not the other person's.</p>
            }
            <div role="alert" class="mt-2 text-sm text-accent"><p id="stepup-error">{{ error() }}</p></div>
            @if (wait() > 0) {
              <p class="text-sm text-muted">You can try again in {{ wait() }} s.</p>
            }
            @if (disabledReason(); as reason) {
              <p id="stepup-reason" class="mt-2 text-sm font-medium">{{ reason }}</p>
              <ng-content select="[reason-action]" />
            }
            <div class="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" class="rounded-md border border-line px-3 py-1.5 aria-disabled:opacity-60" [attr.aria-disabled]="busy() ? 'true' : null" (click)="cancel()">Cancel</button>
              @if (gone()) {
                <button type="button" class="rounded-md bg-accent px-3 py-1.5 font-semibold text-accent-ink" (click)="dismissed.emit()">Close</button>
              } @else {
                <button type="submit" class="rounded-md bg-accent px-3 py-1.5 font-semibold text-accent-ink aria-disabled:opacity-60"
                  [attr.aria-disabled]="unavailable() ? 'true' : null" [attr.aria-describedby]="disabledReason() ? 'stepup-reason' : null">{{ busy() ? 'Working…' : confirmLabel() }}</button>
              }
            </div>
          </form>
        }
      }
    </div>
  </div>`,
})
export class StepUpDialog {
  protected readonly auth = inject(AuthService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly heading = input.required<string>();
  readonly confirmLabel = input.required<string>();
  /** The HTTP call. Throws HttpErrorResponse; its answer is mapped here. */
  readonly submit = input.required<(password: string) => Promise<unknown>>();
  /** When set, Confirm is unavailable and this reason is shown beside it. */
  readonly disabledReason = input<string>('');
  readonly phase = input<'form' | 'result'>('form');
  readonly askPassword = input(true);
  /** Runs before the password check; return false after showing your own message. */
  readonly precheck = input<() => boolean>(() => true);
  /** Extra sentence after a network error. */
  readonly networkHint = input('');
  readonly succeeded = output<void>();
  readonly dismissed = output<void>();
  /** The acting admin lost their rights: the page signs the change off and leaves. */
  readonly rightsLost = output<void>();
  /** The server refused for a reason the list may explain (409, 404): refresh behind the dialog. */
  readonly stale = output<void>();
  /** 400 from the server, with its sentence. */
  readonly rejected = output<string>();

  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly passwordInvalid = signal(false);
  protected readonly wait = signal(0);
  protected readonly lost = signal(false);
  protected readonly gone = signal(false);
  private readonly pw = viewChild<ElementRef<HTMLInputElement>>('pw');
  private timer: ReturnType<typeof setInterval> | undefined;

  protected readonly unavailable = () => this.busy() || this.wait() > 0 || !!this.disabledReason() || !this.askPassword();

  constructor() {
    let restore: (() => void) | undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    afterNextRender(() => (restore = inertOutside(this.host.nativeElement)));
    inject(DestroyRef).onDestroy(() => {
      restore?.();
      // The page was inert while we were open, so the focus trap's own restore may have failed: do it again
      if (opener?.isConnected) opener.focus();
      clearInterval(this.timer);
    });
  }

  protected onEscape(event: Event) {
    event.preventDefault();
    if (this.lost()) this.rightsLost.emit();
    else if (!this.busy()) this.dismissed.emit();
  }

  protected cancel() {
    if (!this.busy()) this.dismissed.emit();
  }

  focusPassword() {
    this.pw()?.nativeElement.focus();
  }

  private clearPassword() {
    const el = this.pw()?.nativeElement;
    if (el) el.value = '';
  }

  private fail(message: string, invalid: boolean) {
    this.error.set(message);
    this.passwordInvalid.set(invalid);
    this.clearPassword();
    this.focusPassword();
  }

  protected async confirm() {
    if (this.unavailable()) return;
    this.error.set('');
    this.passwordInvalid.set(false);
    if (!this.precheck()()) return;
    const password = this.pw()?.nativeElement.value ?? '';
    if (!password) return this.fail('Enter your password.', true);
    this.busy.set(true);
    try {
      await this.submit()(password);
      this.clearPassword();
      this.succeeded.emit();
    } catch (err) {
      this.onError(err);
    } finally {
      this.busy.set(false);
    }
  }

  private onError(err: unknown) {
    const status = err instanceof HttpErrorResponse ? err.status : 0;
    const message = errorMessage(err);
    if (status === 401) return this.dismissed.emit();
    if (status === 403) {
      if (message === 'Admins only') return this.lost.set(true);
      return this.fail('Your password is wrong.', true);
    }
    if (status === 429) {
      const secs = Number((err as HttpErrorResponse).headers.get('Retry-After'));
      this.fail(requestError(err), true);
      this.startCountdown(secs > 0 ? Math.ceil(secs) : 60);
      return;
    }
    if (status === 409 || status === 404) {
      this.fail(message, false);
      this.gone.set(status === 404);
      return this.stale.emit();
    }
    if (status === 400) {
      this.fail(message, false);
      return this.rejected.emit(message);
    }
    this.clearPassword();
    this.error.set(status === 0 && this.networkHint() ? `${message}. ${this.networkHint()}` : message);
  }

  private startCountdown(secs: number) {
    clearInterval(this.timer);
    this.wait.set(secs);
    this.timer = setInterval(() => {
      this.wait.update((n) => n - 1);
      if (this.wait() <= 0) {
        clearInterval(this.timer);
        this.error.set('');
        this.passwordInvalid.set(false);
      }
    }, 1000);
  }
}
