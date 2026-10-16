import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, Injector, input, output, signal, viewChild, afterNextRender, type ElementRef } from '@angular/core';
import type { AdminUserDto, ResetLinkDto, ResetLinkInput } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { StepUpDialog } from './step-up-dialog';

export interface ResetLinkOutcome {
  expiresAt: number;
  revokedTokens: boolean;
}

/** Reset link for one person: choose, confirm with the admin's password, then the link is shown once. */
@Component({
  selector: 'cn-reset-link-dialog',
  imports: [StepUpDialog, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<cn-step-up-dialog
    [heading]="'Reset link for ' + user().displayName"
    [confirmLabel]="'Create link for ' + user().displayName"
    [submit]="create"
    [phase]="link() ? 'result' : 'form'"
    (succeeded)="shown()"
    (dismissed)="close()"
    (rightsLost)="rightsLost.emit()"
    (stale)="stale.emit()"
  >
    <span role="status" class="sr-only">{{ link() ? 'Reset link created.' : '' }}</span>
    @if (!link()) {
      @if (user().isAdmin) {<p class="font-medium">{{ user().displayName }} is an admin.</p>}
      <p>
        This creates a one-time link that lets {{ user().displayName }} choose a new password. Anyone who has the link can take over the account until it is
        used or expires in 24 hours. Any earlier link for this account stops working.
      </p>
    } @else {
      <p>Not shown again: if you lose this link, create a new one; the new link cancels this one.</p>
    }
    <div extras class="mt-2">
      <label class="flex items-start gap-2">
        <input #revoke type="checkbox" name="revokeTokens" class="mt-1" />
        <span>
          <span class="font-medium">Also revoke {{ user().displayName }}'s API tokens</span><br />
          <span class="text-xs text-muted">Tick this if you think the account may be compromised. Their AI assistant tokens stop working at once. Leave it unticked for a forgotten password.</span>
        </span>
      </label>
    </div>
    <div result class="mt-3 space-y-3 text-sm">
      @if (link(); as l) {
        <p>
          Send this link to {{ user().displayName }} yourself (chat, in person). It works once and expires on {{ l.expiresAt | date: 'medium' }} (in about
          {{ hoursLeft(l.expiresAt) }} hours).
        </p>
        <div class="flex flex-col gap-2 sm:flex-row">
          <input #linkInput class="cn-prop-input min-w-0 flex-1 font-mono text-xs" [value]="l.url" readonly aria-label="Reset link" (focus)="linkInput.select()" />
          <button type="button" class="rounded border border-line px-2 py-1" (click)="copy(l.url)">{{ copied() ? 'Copied' : 'Copy link' }}</button>
        </div>
      }
      <div role="status" class="min-h-5">{{ copyStatus() }}</div>
      <p><span class="font-medium">Anyone with the link</span> can set the password and sign in as {{ user().displayName }}.</p>
      @if (revoked()) {<p>{{ user().displayName }}'s API tokens were revoked.</p>}
    </div>
  </cn-step-up-dialog>`,
})
export class ResetLinkDialog {
  private readonly http = inject(HttpClient);
  private readonly injector = inject(Injector);
  readonly user = input.required<AdminUserDto>();
  /** The dialog closed; the outcome is null when no link was created. The link itself never leaves this component. */
  readonly closed = output<ResetLinkOutcome | null>();
  readonly rightsLost = output<void>();
  readonly stale = output<void>();
  protected readonly link = signal<ResetLinkDto | null>(null);
  protected readonly revoked = signal(false);
  protected readonly copied = signal(false);
  protected readonly copyStatus = signal('');
  private readonly revokeEl = viewChild<ElementRef<HTMLInputElement>>('revoke');
  private readonly linkEl = viewChild<ElementRef<HTMLInputElement>>('linkInput');

  protected readonly create = async (currentPassword: string) => {
    const body: ResetLinkInput = { currentPassword, ...(this.revokeEl()?.nativeElement.checked ? { revokeTokens: true } : {}) };
    this.link.set(await firstValueFrom(this.http.post<ResetLinkDto>(`/api/admin/users/${this.user().id}/reset-link`, body)));
    this.revoked.set(body.revokeTokens === true);
  };

  protected hoursLeft(expiresAt: number) {
    return Math.max(1, Math.round((expiresAt - Date.now()) / 3_600_000));
  }

  protected shown() {
    afterNextRender(() => this.linkEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected async copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      this.copied.set(true);
      this.copyStatus.set('Link copied.');
    } catch {
      this.copied.set(false);
      this.copyStatus.set('Could not copy. Select the link and copy it by hand.');
      this.linkEl()?.nativeElement.select();
    }
  }

  protected close() {
    const l = this.link();
    const outcome = l ? { expiresAt: l.expiresAt, revokedTokens: this.revoked() } : null;
    this.link.set(null);
    this.closed.emit(outcome);
  }
}
