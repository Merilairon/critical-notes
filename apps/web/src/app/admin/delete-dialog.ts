import { HttpClient } from '@angular/common/http';
import { afterNextRender, ChangeDetectionStrategy, Component, ElementRef, inject, Injector, type OnInit, input, output, signal, viewChild } from '@angular/core';
import type { AdminUserDto, DeleteUserInput, OwnedCampaignDto } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../core/http.interceptor';
import { buildPlan, campaignOptions, planDefaults, type Choice } from './user-rules';
import { StepUpDialog } from './step-up-dialog';

export interface DeleteOutcome {
  transfers: number;
  archives: number;
}

const roleLabel = (role: string) => (role === 'codm' ? 'co-DM' : role === 'dm' ? 'owner' : role);

/** Delete an account: what happens to each campaign they own, then the admin's password. */
@Component({
  selector: 'cn-delete-dialog',
  imports: [StepUpDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<cn-step-up-dialog
    [heading]="'Delete ' + user().displayName"
    [confirmLabel]="'Delete ' + user().displayName"
    [submit]="remove"
    [askPassword]="!loading() && !loadError()"
    [disabledReason]="loadError() ? 'The list of campaigns could not be loaded.' : blockedReason()"
    [precheck]="precheck"
    networkHint="Check the user list before trying again: the account may already be deleted."
    (succeeded)="succeeded()"
    (dismissed)="closed.emit(null)"
    (rightsLost)="rightsLost.emit()"
    (stale)="stale.emit()"
    (rejected)="reload()"
  >
    @if (user().isAdmin) {<p class="font-medium">{{ user().displayName }} is an admin.</p>}
    <p>
      This permanently deletes the account {{ user().username }}. It cannot be undone. Their notes and characters stay in the campaigns, shown as written by an
      unknown user. Their sessions and API tokens end. Their open invites are revoked. Homebrew sources they shared stay available and become yours; their
      private homebrew and templates become inaccessible.
    </p>
    <p>
      Prefer to keep the account? Disabling it blocks sign-in and changes nothing else.
      <button type="button" class="rounded border border-line px-2 py-0.5" (click)="disableInstead.emit()" [attr.aria-label]="'Disable ' + user().displayName + ' instead'">Disable instead</button>
    </p>

    <div extras class="space-y-3">
      <div role="status">@if (loading()) {Checking which campaigns they own…}</div>
      @if (loadError()) {
        <div role="alert" class="text-accent">{{ loadError() }}</div>
        <button type="button" class="rounded border border-line px-2 py-0.5" (click)="reload()">Try again</button>
      }
      @if (!loading() && !loadError()) {
        @if (campaigns().length) {
          <p class="font-medium">{{ user().displayName }} owns {{ campaigns().length }} {{ campaigns().length === 1 ? 'campaign' : 'campaigns' }}. Choose what happens to each.</p>
        }
        @for (o of options(); track o.campaign.campaignId) {
          <fieldset class="rounded-md border border-line p-3">
            <legend class="px-1 font-medium">{{ o.campaign.name }}</legend>
            @if (o.blocked) {
              <p [id]="'blocked-' + o.campaign.campaignId">
                Blocked.
                @if (o.blocked === 'solo') {
                  {{ user().displayName }} is the only member, so the campaign cannot be handed over or archived.
                } @else {
                  Every other member is disabled and there is no co-DM, so the campaign cannot be handed over or archived.
                }
                Disable the account instead, or invite someone to the campaign first.
              </p>
            } @else {
              <div class="flex flex-wrap items-center gap-2">
                <label class="flex items-center gap-2">
                  <input type="radio" [name]="'choice-' + o.campaign.campaignId" [checked]="choice(o.campaign.campaignId).action === 'transfer'" [disabled]="!o.canTransfer"
                    (change)="pick(o.campaign.campaignId, 'transfer')" />
                  <span>Transfer to</span>
                </label>
                <select class="cn-prop-input min-w-0 flex-1" [attr.aria-label]="'New owner of ' + o.campaign.name" [id]="'to-' + o.campaign.campaignId"
                  [attr.aria-invalid]="missing(o.campaign.campaignId) ? 'true' : null" [attr.aria-describedby]="missing(o.campaign.campaignId) ? 'missing-' + o.campaign.campaignId : null"
                  (change)="pickTarget(o.campaign.campaignId, $any($event.target).value)">
                  <option value="" [selected]="!choice(o.campaign.campaignId).toUserId">Select a new owner</option>
                  @for (m of o.candidates; track m.userId) {
                    <option [value]="m.userId" [disabled]="m.disabled" [selected]="choice(o.campaign.campaignId).toUserId === m.userId">{{ m.displayName }} ({{ roleLabel(m.role) }}){{ m.disabled ? ', account disabled' : '' }}</option>
                  }
                </select>
              </div>
              <div class="mt-2">
                <label class="flex items-start gap-2">
                  <input type="radio" class="mt-1" [name]="'choice-' + o.campaign.campaignId" [checked]="choice(o.campaign.campaignId).action === 'archive'" [disabled]="!o.canArchive"
                    [attr.aria-describedby]="'archive-note-' + o.campaign.campaignId" (change)="pick(o.campaign.campaignId, 'archive')" />
                  <span>Archive</span>
                </label>
                <p [id]="'archive-note-' + o.campaign.campaignId" class="ml-6 text-xs text-muted">
                  @if (o.canArchive) {
                    Archiving keeps the campaign and its content for its co-DMs, but it will have no owner. Nobody will be able to change its members, roles or rules
                    edition, and its owner-only actions stay unavailable. There is currently no way to give an archived campaign an owner again. Choose Transfer if the
                    campaign should stay fully manageable.
                  } @else {
                    {{ o.archiveReason }}
                  }
                </p>
              </div>
              @if (missing(o.campaign.campaignId)) {
                <p [id]="'missing-' + o.campaign.campaignId" class="mt-2 text-accent">Choose who becomes the owner of {{ o.campaign.name }}.</p>
              }
            }
          </fieldset>
        }
        <div role="alert" class="text-accent">{{ summary() }}</div>
        @if (planSummary(); as s) {<p class="text-xs text-muted">{{ s }}</p>}
      }
    </div>
    <button reason-action type="button" class="mt-2 rounded border border-line px-2 py-0.5" (click)="disableInstead.emit()">Disable instead</button>
  </cn-step-up-dialog>`,
})
export class DeleteDialog implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly user = input.required<AdminUserDto>();
  readonly closed = output<DeleteOutcome | null>();
  readonly disableInstead = output<void>();
  readonly rightsLost = output<void>();
  readonly stale = output<void>();
  private readonly dialog = viewChild.required(StepUpDialog);

  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly campaigns = signal<OwnedCampaignDto[]>([]);
  protected readonly choices = signal<Record<string, Choice>>({});
  /** Set after a failed Confirm so incomplete campaigns show their message. */
  protected readonly showMissing = signal(false);
  protected readonly summary = signal('');
  protected readonly roleLabel = roleLabel;
  private sent: DeleteOutcome = { transfers: 0, archives: 0 };

  protected readonly options = () => this.campaigns().map((c) => campaignOptions(c, this.user().id));
  protected readonly plan = () => buildPlan(this.campaigns(), this.user().id, this.choices());
  protected readonly choice = (id: string): Choice => this.choices()[id] ?? { action: 'transfer', toUserId: null };
  protected readonly missing = (id: string) => this.showMissing() && this.plan().incomplete.some((c) => c.campaignId === id);

  protected readonly blockedReason = () => {
    const blocked = this.plan().blocked;
    if (!blocked.length) return '';
    const n = blocked.length;
    return `Delete is blocked by ${n} ${n === 1 ? 'campaign' : 'campaigns'} that cannot be handed over or archived: ${blocked.map((c) => c.name).join(', ')}. Disable the account instead.`;
  };

  protected readonly planSummary = () => {
    const p = this.plan();
    if (p.blocked.length || p.incomplete.length || !this.campaigns().length) return '';
    const n = this.campaigns().length;
    return `${n} ${n === 1 ? 'campaign' : 'campaigns'}: ${p.transfers} transferred, ${p.archives} archived.`;
  };

  ngOnInit() {
    void this.reload();
  }

  /** Loads (or reloads) the campaigns the person owns and rebuilds the plan, keeping choices already made. */
  protected async reload() {
    this.loading.set(true);
    this.loadError.set('');
    try {
      const res = await firstValueFrom(this.http.get<{ campaigns: OwnedCampaignDto[] }>(`/api/admin/users/${this.user().id}/owned-campaigns`));
      this.campaigns.set(res.campaigns);
      this.choices.set(planDefaults(res.campaigns, this.user().id, this.choices()));
      // The server's sentence is already in the dialog's alert; a second alert would announce it twice
      this.summary.set('');
    } catch (err) {
      this.loadError.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
    this.focusInitial();
  }

  private focusInitial() {
    afterNextRender(
      () => {
        if (this.loadError()) return;
        const first = this.firstIncomplete();
        if (this.plan().blocked.length) this.host.nativeElement.querySelector<HTMLElement>('[reason-action]')?.focus();
        else if (first) this.host.nativeElement.querySelector<HTMLElement>(`#to-${CSS.escape(first)}`)?.focus();
        else this.dialog().focusPassword();
      },
      { injector: this.injector },
    );
  }

  private firstIncomplete() {
    return this.plan().incomplete[0]?.campaignId;
  }

  protected pick(id: string, action: 'transfer' | 'archive') {
    this.choices.update((c) => ({ ...c, [id]: { action, toUserId: action === 'transfer' ? (c[id]?.toUserId ?? null) : null } }));
  }

  protected pickTarget(id: string, toUserId: string) {
    this.choices.update((c) => ({ ...c, [id]: { action: 'transfer', toUserId: toUserId || null } }));
  }

  /** Validate every campaign at once before any request. */
  protected readonly precheck = () => {
    const p = this.plan();
    if (p.blocked.length) return false;
    if (!p.incomplete.length) {
      this.showMissing.set(false);
      this.summary.set('');
      return true;
    }
    this.showMissing.set(true);
    this.summary.set(`${p.incomplete.length} ${p.incomplete.length === 1 ? 'campaign still needs' : 'campaigns still need'} a choice: ${p.incomplete.map((c) => c.name).join(', ')}.`);
    this.focusInitial();
    return false;
  };

  protected readonly remove = async (currentPassword: string) => {
    const p = this.plan();
    if (!p.campaigns) throw new Error('The plan is incomplete');
    const body: DeleteUserInput = { currentPassword, campaigns: p.campaigns };
    await firstValueFrom(this.http.post(`/api/admin/users/${this.user().id}/delete`, body));
    this.sent = { transfers: p.transfers, archives: p.archives };
  };

  protected succeeded() {
    this.closed.emit(this.sent);
  }
}
