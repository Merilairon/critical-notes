import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/http.interceptor';

@Component({
  selector: 'cn-login',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="flex min-h-full items-center justify-center p-4">
    <form class="w-full max-w-sm rounded-xl border border-line bg-panel p-4 shadow-sm sm:p-6" (ngSubmit)="submit()">
      <h1 class="font-display text-2xl font-bold text-accent">Critical Notes</h1>
      <p class="mb-4 text-sm text-muted">Sign in to your campaigns.</p>
      <label class="mb-3 block text-sm">
        <span class="mb-1 block font-medium">Username</span>
        <input class="cn-input px-3 py-2" name="username" autocomplete="username" [(ngModel)]="username" required />
      </label>
      <label class="mb-4 block text-sm">
        <span class="mb-1 block font-medium">Password</span>
        <input class="cn-input px-3 py-2" type="password" name="password" autocomplete="current-password" [(ngModel)]="password" required />
      </label>
      @if (error()) {
        <p class="mb-3 text-sm text-accent" role="alert">{{ error() }}</p>
      }
      <button class="cn-btn-primary w-full px-3 py-2 text-base aria-disabled:opacity-60" [attr.aria-disabled]="busy() ? 'true' : null">Sign in</button>
    </form>
  </div>`,
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected username = '';
  protected password = '';
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  constructor() {
    this.auth.ensureLoaded().then(() => {
      if (this.auth.setupRequired()) this.router.navigate(['/setup']);
      else if (this.auth.user()) this.router.navigateByUrl(this.next());
    });
  }

  private next(): string {
    const next = this.route.snapshot.queryParamMap.get('next');
    return next && next.startsWith('/') && !next.startsWith('//') ? next : '/campaigns';
  }

  protected async submit() {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.login(this.username, this.password);
      await this.router.navigateByUrl(this.next());
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
