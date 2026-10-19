import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/http.interceptor';

/** First-run: create the admin account. */
@Component({
  selector: 'cn-setup',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="flex min-h-full items-center justify-center p-4">
    <form class="w-full max-w-sm rounded-xl border border-line bg-panel p-4 shadow-sm sm:p-6" (ngSubmit)="submit()">
      <h1 class="font-display text-2xl font-bold text-accent">Welcome</h1>
      <p class="mb-4 text-sm text-muted">Create the administrator account for this Critical Notes instance.</p>
      <label class="mb-3 block text-sm">
        <span class="mb-1 block font-medium">Display name</span>
        <input class="cn-input px-3 py-2" name="displayName" [(ngModel)]="displayName" required />
      </label>
      <label class="mb-3 block text-sm">
        <span class="mb-1 block font-medium">Username</span>
        <input class="cn-input px-3 py-2" name="username" autocomplete="username" [(ngModel)]="username" required />
      </label>
      <label class="mb-4 block text-sm">
        <span class="mb-1 block font-medium">Password (8+ characters)</span>
        <input class="cn-input px-3 py-2" type="password" name="password" autocomplete="new-password" [(ngModel)]="password" required minlength="8" />
      </label>
      @if (error()) {
        <p class="mb-3 text-sm text-accent" role="alert">{{ error() }}</p>
      }
      <button class="cn-btn-primary w-full px-3 py-2 text-base" [disabled]="busy()">Create account</button>
    </form>
  </div>`,
})
export class Setup {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected displayName = '';
  protected username = '';
  protected password = '';
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  protected async submit() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.setup(this.username, this.displayName, this.password);
      await this.router.navigate(['/campaigns']);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
