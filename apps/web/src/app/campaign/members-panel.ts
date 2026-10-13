import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { CreatedInviteDto, InviteDto, MemberDto } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../core/http.interceptor';
import { CampaignStore } from './campaign.store';

const ROLE_LABELS = { dm: 'DM (owner)', codm: 'Co-DM', player: 'Player' } as const;

/** Who is in the campaign; invite links (game masters); roles and removal (owner); leaving (everyone else). */
@Component({
  selector: 'cn-members-panel',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ul class="flex flex-col gap-1 text-sm">
      @for (m of members(); track m.userId) {
        <li class="flex flex-wrap items-center gap-2 border-t border-line py-1.5 first:border-t-0">
          <span class="font-medium">{{ m.displayName }}</span>
          @if (m.characters.length) {<span class="text-xs text-muted">plays {{ characterNames(m) }}</span>}
          <span class="ml-auto flex items-center gap-2">
            @if (store.isOwner() && m.role !== 'dm') {
              <select class="cn-prop-input text-xs" [attr.aria-label]="'Role of ' + m.displayName" (change)="setRole(m, $any($event.target).value)">
                <option value="player" [selected]="m.role === 'player'">Player</option>
                <option value="codm" [selected]="m.role === 'codm'">Co-DM</option>
              </select>
              <button type="button" class="text-xs text-muted hover:text-accent" (click)="remove(m)">Remove</button>
            } @else {
              <span class="text-xs text-muted">{{ roleLabel(m) }}</span>
            }
          </span>
        </li>
      }
    </ul>

    @if (store.isGm()) {
      <h3 class="mt-4 mb-1 text-sm font-semibold">Invite links</h3>
      <form class="flex flex-wrap items-end gap-2 text-sm" (submit)="$event.preventDefault(); create(role.value, days.value, uses.value)">
        <label class="flex flex-col gap-1"><span class="text-xs text-muted">As</span>
          <select #role class="cn-prop-input"><option value="player">Player</option>@if (store.isOwner()) {<option value="codm">Co-DM</option>}</select>
        </label>
        <label class="flex flex-col gap-1"><span class="text-xs text-muted">Valid for</span>
          <select #days class="cn-prop-input"><option value="1">1 day</option><option value="7">7 days</option><option value="14" selected>14 days</option><option value="">No limit</option></select>
        </label>
        <label class="flex flex-col gap-1"><span class="text-xs text-muted">Uses</span>
          <select #uses class="cn-prop-input"><option value="1">1 person</option><option value="" selected>Any number</option></select>
        </label>
        <button type="submit" class="rounded-md bg-accent px-3 py-1.5 font-semibold text-white">Create link</button>
      </form>
      @if (link(); as l) {
        <div class="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-accent/50 bg-accent/5 px-3 py-2 text-sm">
          <input class="cn-prop-input min-w-0 flex-1 font-mono text-xs" [value]="l" readonly aria-label="Invite link" (focus)="$any($event.target).select()" />
          <button type="button" class="rounded border border-line px-2 py-0.5" (click)="copy(l)">{{ copied() ? 'Copied' : 'Copy' }}</button>
          <span class="w-full text-xs text-muted">Shown only now. Send it to your player; anyone with the link can join.</span>
        </div>
      }
      <ul class="mt-2 flex flex-col gap-1 text-xs text-muted">
        @for (i of invites(); track i.id) {
          <li class="flex items-center gap-2" [class.line-through]="i.revoked">
            {{ i.role === 'codm' ? 'Co-DM' : 'Player' }} link · created {{ i.createdAt | date: 'short' }} · used {{ i.uses }}{{ i.maxUses ? '/' + i.maxUses : '' }}
            @if (i.expiresAt) { · until {{ i.expiresAt | date: 'shortDate' }} }
            @if (!i.revoked) {<button type="button" class="ml-auto hover:text-accent" (click)="revoke(i)">Withdraw</button>}
          </li>
        }
      </ul>
    }
    @if (!store.isOwner()) {
      <button type="button" class="mt-4 rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:border-accent hover:text-accent" (click)="leave()">Leave this campaign</button>
    }
    @if (error()) {<p class="mt-2 text-sm text-accent" role="alert">{{ error() }}</p>}`,
})
export class MembersPanel {
  protected readonly store = inject(CampaignStore);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  protected readonly members = this.store.members;
  protected readonly invites = signal<InviteDto[]>([]);
  protected readonly link = signal<string | null>(null);
  protected readonly copied = signal(false);
  protected readonly error = signal('');

  constructor() {
    void this.reload();
  }

  private base() {
    return `/api/campaigns/${this.store.id()}`;
  }

  private async reload() {
    try {
      await this.store.loadMembers();
      if (this.store.isGm()) this.invites.set((await firstValueFrom(this.http.get<{ invites: InviteDto[] }>(`${this.base()}/invites`))).invites);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  protected roleLabel(m: MemberDto) {
    return ROLE_LABELS[m.role];
  }
  protected characterNames(m: MemberDto) {
    return m.characters.map((c) => c.title).join(', ');
  }

  private async run(fn: () => Promise<unknown>) {
    this.error.set('');
    try {
      await fn();
    } catch (err) {
      this.error.set(errorMessage(err));
    }
    await this.reload();
  }

  protected create(role: string, days: string, uses: string) {
    void this.run(async () => {
      const res = await firstValueFrom(
        this.http.post<CreatedInviteDto>(`${this.base()}/invites`, { role, expiresInDays: days ? Number(days) : null, maxUses: uses ? Number(uses) : null }),
      );
      this.link.set(`${location.origin}/invite/${res.token}`);
      this.copied.set(false);
    });
  }

  protected async copy(link: string) {
    await navigator.clipboard?.writeText(link).catch(() => undefined);
    this.copied.set(true);
  }

  protected revoke(i: InviteDto) {
    void this.run(() => firstValueFrom(this.http.delete(`${this.base()}/invites/${i.id}`)));
  }

  protected setRole(m: MemberDto, role: string) {
    void this.run(() => firstValueFrom(this.http.patch(`${this.base()}/members/${m.userId}`, { role })));
  }

  protected remove(m: MemberDto) {
    if (confirm(`Remove ${m.displayName} from the campaign? Their characters stay, without a player.`)) {
      void this.run(() => firstValueFrom(this.http.delete(`${this.base()}/members/${m.userId}`)));
    }
  }

  protected async leave() {
    if (!confirm('Leave this campaign? You will need a new invite to come back.')) return;
    try {
      await firstValueFrom(this.http.delete(`${this.base()}/members/${this.store.myId()}`));
      await this.router.navigate(['/campaigns']);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }
}
