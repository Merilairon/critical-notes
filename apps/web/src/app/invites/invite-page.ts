import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { InviteInfoDto } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/http.interceptor';

/** Where an invite link leads: join the campaign, signing up first if needed. */
@Component({
  selector: 'cn-invite-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="mx-auto w-full max-w-md p-4 sm:p-6">
    @if (info(); as i) {
      <h1 class="font-display text-3xl font-bold">You're invited</h1>
      <p class="mt-2">to join <strong>{{ i.campaignName }}</strong> as {{ i.role === 'codm' ? 'a co-DM' : 'a player' }}.</p>
      @if (!i.valid && !i.alreadyMember) {
        <p class="mt-4 rounded-md border border-accent/50 bg-accent/5 px-3 py-2 text-sm" role="alert">{{ i.reason }}. Ask your DM for a new link.</p>
      } @else if (auth.user(); as user) {
        <p class="mt-4 text-sm text-muted">Signed in as {{ user.displayName }}.</p>
        <button type="button" class="cn-btn-primary mt-2 w-full" [disabled]="busy()" (click)="join()">{{ i.alreadyMember ? 'Open the campaign' : 'Join the campaign' }}</button>
      } @else {
        <form class="mt-4 flex flex-col gap-3" (submit)="$event.preventDefault(); register(u.value, d.value, p.value)">
          <h2 class="font-semibold">Create your account</h2>
          <label class="flex flex-col gap-1 text-sm"><span class="text-muted">Your name (shown to the group)</span><input #d name="displayName" class="cn-input" required maxlength="80" autocomplete="nickname" /></label>
          <label class="flex flex-col gap-1 text-sm"><span class="text-muted">Username</span><input #u name="username" class="cn-input" required autocomplete="username" /></label>
          <label class="flex flex-col gap-1 text-sm"><span class="text-muted">Password (8 characters or more)</span><input #p name="password" type="password" class="cn-input" required minlength="8" autocomplete="new-password" /></label>
          <button type="submit" class="cn-btn-primary w-full" [disabled]="busy()">Create account and join</button>
        </form>
        <p class="mt-4 text-sm">Already have an account? <a class="cn-link" [routerLink]="['/login']" [queryParams]="{ next: '/invite/' + token() }">Sign in</a> first.</p>
      }
      @if (error()) {<p class="mt-3 text-sm text-accent" role="alert">{{ error() }}</p>}
    } @else if (error()) {
      <p class="text-muted">{{ error() }}</p>
    } @else {
      <p class="text-muted">Loading…</p>
    }
  </div>`,
})
export class InvitePage {
  readonly token = input.required<string>();
  protected readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  protected readonly info = signal<InviteInfoDto | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  constructor() {
    effect(() => {
      const token = this.token();
      untracked(() => void this.load(token));
    });
  }

  private async load(token: string) {
    try {
      await this.auth.ensureLoaded();
      this.info.set(await firstValueFrom(this.http.get<InviteInfoDto>(`/api/invites/${encodeURIComponent(token)}`)));
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  protected async join() {
    this.busy.set(true);
    try {
      const res = await firstValueFrom(this.http.post<{ campaignId: string }>(`/api/invites/${encodeURIComponent(this.token())}/accept`, {}));
      await this.router.navigate(['/c', res.campaignId]);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async register(username: string, displayName: string, password: string) {
    this.busy.set(true);
    this.error.set('');
    try {
      const campaignId = await this.auth.register(this.token(), username.trim(), displayName.trim(), password);
      await this.router.navigate(['/c', campaignId]);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
