import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { afterNextRender, ChangeDetectionStrategy, Component, computed, ElementRef, inject, Injector, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { AdminUpdateUserInput, AdminUserDto } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { AdminNav } from './admin-nav';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/http.interceptor';
import { DeleteDialog, type DeleteOutcome } from './delete-dialog';
import { ResetLinkDialog, type ResetLinkOutcome } from './reset-link-dialog';
import { StepUpDialog } from './step-up-dialog';
import { enabledAdminCount, rowRules, sortUsers, type RowRules } from './user-rules';

type SimpleKind = 'admin-on' | 'admin-off' | 'disable' | 'enable-admin';
type DialogState =
  | { kind: 'reset' | 'delete'; user: AdminUserDto }
  | { kind: SimpleKind; user: AdminUserDto; submit: (password: string) => Promise<unknown> };

/** Manage accounts: reset links, disable and enable, admin rights, delete. Admins only (route guard and server). */
@Component({
  selector: 'cn-users-page',
  imports: [DatePipe, NgTemplateOutlet, RouterLink, AdminNav, StepUpDialog, ResetLinkDialog, DeleteDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="mx-auto max-w-5xl p-4 sm:p-6">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h1 #heading tabindex="-1" class="font-display text-3xl font-bold outline-none">Users</h1>
      @if (users().length) {<span class="rounded border border-line px-2 py-0.5 text-sm text-muted">{{ users().length }} {{ users().length === 1 ? 'user' : 'users' }}</span>}
    </div>
    <cn-admin-nav current="users" />
    <p class="mt-2 text-muted">Manage accounts on this server. Actions that change access ask for your password.</p>

    <div role="status" class="mt-3 text-sm">{{ status() }}</div>
    <div role="alert" class="text-sm text-accent"><p>{{ actionError() }}</p></div>

    @if (loadError(); as e) {
      <section class="mt-3 rounded-xl border border-line bg-panel p-4" aria-label="Users could not be loaded">
        <p class="text-sm text-accent">{{ e }}</p>
        <div class="mt-2 flex gap-2">
          @if (forbidden()) {
            <a routerLink="/campaigns" class="rounded border border-line px-2 py-0.5 text-sm">Back to campaigns</a>
          } @else {
            <button type="button" class="rounded border border-line px-2 py-0.5 text-sm" (click)="load()">Try again</button>
          }
        </div>
      </section>
    } @else if (loading() && !users().length) {
      <section class="mt-3 rounded-xl border border-line bg-panel p-4"><p role="status" class="text-sm text-muted">Loading users…</p></section>
    } @else if (!users().length) {
      <section class="mt-3 rounded-xl border border-line bg-panel p-4">
        <p class="text-sm">No users found.</p>
        <button type="button" class="mt-2 rounded border border-line px-2 py-0.5 text-sm" (click)="load()">Try again</button>
      </section>
    } @else {
      <table class="mt-3 hidden w-full text-left text-sm md:table">
        <caption class="sr-only">Users and their access</caption>
        <thead class="text-xs text-muted">
          <tr class="border-b border-line">
            <th scope="col" class="py-2 pr-2 font-medium">Name</th>
            <th scope="col" class="pr-2 font-medium">Campaigns</th>
            <th scope="col" class="pr-2 font-medium">Created</th>
            <th scope="col" class="pr-2 font-medium">Status</th>
            <th scope="col" class="font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          @for (u of users(); track u.id) {
            <tr class="border-b border-line align-top">
              <th scope="row" class="py-2 pr-2 font-normal"><strong>{{ u.displayName }}</strong><br /><span class="text-muted">{{ u.username }}</span></th>
              <td class="pr-2 py-2">{{ u.ownedCampaignCount ? u.ownedCampaignCount + ' owned' : 'None' }}</td>
              <td class="pr-2 py-2">{{ u.createdAt | date: 'mediumDate' }}</td>
              <td class="pr-2 py-2"><ng-container *ngTemplateOutlet="badges; context: { $implicit: u }" /></td>
              <td class="py-2"><ng-container *ngTemplateOutlet="actions; context: { $implicit: u, layout: 'table' }" /></td>
            </tr>
          }
        </tbody>
      </table>

      <h2 class="sr-only md:hidden">Users</h2>
      <ul class="mt-3 space-y-3 md:hidden">
        @for (u of users(); track u.id) {
          <li class="rounded-xl border border-line bg-panel p-3 text-sm">
            <strong>{{ u.displayName }}</strong>
            <div class="text-muted">{{ u.username }} · joined {{ u.createdAt | date: 'mediumDate' }}</div>
            <div class="mt-1"><ng-container *ngTemplateOutlet="badges; context: { $implicit: u }" /></div>
            <div class="mt-1">{{ u.ownedCampaignCount ? 'Owns ' + u.ownedCampaignCount + (u.ownedCampaignCount === 1 ? ' campaign' : ' campaigns') : 'Owns no campaigns' }}</div>
            <div class="mt-2"><ng-container *ngTemplateOutlet="actions; context: { $implicit: u, layout: 'card' }" /></div>
          </li>
        }
      </ul>
    }

    <ng-template #badges let-u>
      <span class="flex flex-wrap items-center gap-1">
        @if (u.isAdmin) {<span class="rounded border border-accent px-1.5 py-0.5 text-xs font-medium text-accent">Admin</span>}
        @if (u.disabledAt !== null) {<span class="rounded border border-line bg-panel-2 px-1.5 py-0.5 text-xs font-medium text-muted">Disabled</span>}
        @if (u.id === auth.user()?.id) {<span class="rounded border border-line px-1.5 py-0.5 text-xs font-medium">You</span>}
      </span>
      @if (u.disabledAt !== null) {<div class="text-xs text-muted">disabled {{ u.disabledAt | date: 'mediumDate' }}</div>}
    </ng-template>

    <ng-template #actions let-u let-layout="layout">
      @let r = rules().get(u.id)!;
      @let pad = layout === 'card' ? 'py-2' : 'py-0.5';
      <div class="flex flex-wrap gap-2" [class.grid]="layout === 'card'" [class.grid-cols-2]="layout === 'card'">
        <button type="button" [attr.data-key]="u.id + ':reset'" class="rounded border border-line px-2 text-sm aria-disabled:cursor-not-allowed aria-disabled:opacity-60" [class]="pad"
          [attr.aria-disabled]="r.canReset ? null : 'true'" [attr.aria-describedby]="r.canReset ? null : layout + '-' + u.id + '-reset'" [attr.aria-label]="'Reset link for ' + u.displayName"
          (click)="r.canReset && open('reset', u)">Reset link</button>
        <button type="button" [attr.data-key]="u.id + ':admin'" class="rounded border border-line px-2 text-sm aria-disabled:cursor-not-allowed aria-disabled:opacity-60" [class]="pad"
          [attr.aria-disabled]="r.canToggleAdmin ? null : 'true'" [attr.aria-describedby]="r.canToggleAdmin ? null : layout + '-' + u.id + '-admin'"
          [attr.aria-label]="(u.isAdmin ? 'Remove admin from ' : 'Make admin for ') + u.displayName" (click)="r.canToggleAdmin && open(u.isAdmin ? 'admin-off' : 'admin-on', u)">{{ u.isAdmin ? 'Remove admin' : 'Make admin' }}</button>
        @if (u.disabledAt === null) {
          <button type="button" [attr.data-key]="u.id + ':disable'" class="rounded border border-line px-2 text-sm aria-disabled:cursor-not-allowed aria-disabled:opacity-60" [class]="pad"
            [attr.aria-disabled]="r.canDisable ? null : 'true'" [attr.aria-describedby]="r.canDisable ? null : layout + '-' + u.id + '-disable'" [attr.aria-label]="'Disable ' + u.displayName"
            (click)="r.canDisable && open('disable', u)">Disable</button>
        } @else {
          <button type="button" [attr.data-key]="u.id + ':disable'" class="rounded border border-line px-2 text-sm aria-disabled:opacity-60" [class]="pad"
            [attr.aria-disabled]="enabling() ? 'true' : null" [attr.aria-label]="'Enable ' + u.displayName" (click)="enable(u)">Enable</button>
        }
        <button type="button" [attr.data-key]="u.id + ':delete'" class="rounded border border-line px-2 text-sm text-accent aria-disabled:cursor-not-allowed aria-disabled:opacity-60" [class]="pad"
          [attr.aria-disabled]="r.canDelete ? null : 'true'" [attr.aria-describedby]="r.canDelete ? (r.deleteHint ? layout + '-' + u.id + '-hint' : null) : layout + '-' + u.id + '-delete'" [attr.aria-label]="'Delete ' + u.displayName"
          (click)="r.canDelete && open('delete', u)">Delete</button>
      </div>
      <div class="mt-1 space-y-0.5 text-xs text-muted">
        @if (r.reasons.reset) {<p [id]="layout + '-' + u.id + '-reset'">{{ r.reasons.reset }}</p>}
        @if (r.reasons.admin) {<p [id]="layout + '-' + u.id + '-admin'">{{ r.reasons.admin }}</p>}
        @if (r.reasons.disable) {<p [id]="layout + '-' + u.id + '-disable'">{{ r.reasons.disable }}</p>}
        @if (r.reasons.delete) {<p [id]="layout + '-' + u.id + '-delete'">{{ r.reasons.delete }}</p>}
        @if (r.deleteHint) {<p [id]="layout + '-' + u.id + '-hint'">{{ r.deleteHint }}</p>}
      </div>
    </ng-template>

    @if (dialog(); as d) {
      @switch (d.kind) {
        @case ('reset') {
          <cn-reset-link-dialog [user]="d.user" (closed)="resetClosed(d.user, $event)" (rightsLost)="rightsLost()" (stale)="load(true)" />
        }
        @case ('delete') {
          <cn-delete-dialog [user]="d.user" (closed)="deleteClosed(d.user, $event)" (disableInstead)="open('disable', d.user, 'delete')" (rightsLost)="rightsLost()" (stale)="load(true)" />
        }
        @default {
          <cn-step-up-dialog [heading]="dialogTitle(d)" [confirmLabel]="dialogTitle(d)" [submit]="$any(d).submit" (succeeded)="simpleDone($any(d))" (dismissed)="close()"
            (rightsLost)="rightsLost()" (stale)="load(true)">
            @if (d.user.isAdmin && d.kind !== 'enable-admin') {<p class="font-medium">{{ d.user.displayName }} is an admin.</p>}
            @switch (d.kind) {
              @case ('admin-on') {<p>{{ d.user.displayName }} will be able to manage every account on this server, including yours.</p>}
              @case ('admin-off') {
                <p>{{ d.user.displayName }} will no longer be able to manage accounts.</p>
                @if (d.user.id === auth.user()?.id) {<p class="font-medium">You will lose access to this page as soon as this is saved.</p>}
              }
              @case ('disable') {
                <p>
                  {{ d.user.displayName }} is signed out everywhere and can no longer sign in. Their API tokens (AI assistants) are revoked and do not come back if you
                  enable the account again. Their campaigns, notes and characters are kept.
                </p>
                @if (d.user.ownedCampaignCount > 0) {
                  <p>
                    They own {{ d.user.ownedCampaignCount }} {{ d.user.ownedCampaignCount === 1 ? 'campaign' : 'campaigns' }}. {{ d.user.ownedCampaignCount === 1 ? 'It stays' : 'They stay' }} as
                    {{ d.user.ownedCampaignCount === 1 ? 'it is' : 'they are' }} and nobody else can manage {{ d.user.ownedCampaignCount === 1 ? 'its' : 'their' }} members until they return or you delete
                    the account and hand {{ d.user.ownedCampaignCount === 1 ? 'it' : 'them' }} over.
                  </p>
                }
              }
              @case ('enable-admin') {
                <p>
                  {{ d.user.displayName }} is an admin. Enabling the account restores admin rights, but not their sessions or API tokens: they need a new reset link to
                  sign in.
                </p>
              }
            }
          </cn-step-up-dialog>
        }
      }
    }
  </div>`,
})
export class UsersPage {
  protected readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly headingEl = viewChild.required<ElementRef<HTMLElement>>('heading');

  protected readonly users = signal<AdminUserDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly forbidden = signal(false);
  protected readonly status = signal('');
  protected readonly actionError = signal('');
  protected readonly enabling = signal(false);
  protected readonly dialog = signal<DialogState | null>(null);

  protected readonly rules = computed(() => {
    const list = this.users();
    const admins = enabledAdminCount(list);
    const me = this.auth.user()?.id;
    return new Map<string, RowRules>(list.map((u) => [u.id, rowRules(u, me, admins)]));
  });

  constructor() {
    void this.load();
  }

  /** `quiet` refreshes behind a dialog without touching the status or error text. */
  protected async load(quiet = false) {
    if (!quiet) {
      this.loading.set(true);
      this.loadError.set('');
    }
    try {
      this.users.set(sortUsers((await firstValueFrom(this.http.get<{ users: AdminUserDto[] }>('/api/admin/users'))).users));
    } catch (err) {
      if (!quiet) {
        this.loadError.set(errorMessage(err));
        this.forbidden.set((err as { status?: number }).status === 403);
      }
    } finally {
      this.loading.set(false);
    }
  }

  private patch(user: AdminUserDto, body: AdminUpdateUserInput) {
    return firstValueFrom(this.http.patch(`/api/admin/users/${user.id}`, body));
  }

  protected dialogTitle(d: DialogState): string {
    const n = d.user.displayName;
    switch (d.kind) {
      case 'admin-on': return `Make ${n} an admin`;
      case 'admin-off': return `Remove admin from ${n}`;
      case 'disable': return `Disable ${n}`;
      case 'enable-admin': return `Enable ${n}`;
      case 'reset': return `Reset link for ${n}`;
      case 'delete': return `Delete ${n}`;
    }
  }

  /** The row button focus goes back to when a dialog opened from another dialog is dismissed. */
  private openedFrom: string | null = null;

  protected open(kind: DialogState['kind'], user: AdminUserDto, from: string | null = null) {
    this.openedFrom = from;
    this.status.set('');
    this.actionError.set('');
    if (kind === 'reset' || kind === 'delete') return this.dialog.set({ kind, user });
    const body: Record<SimpleKind, AdminUpdateUserInput> = {
      'admin-on': { isAdmin: true },
      'admin-off': { isAdmin: false },
      disable: { disabled: true },
      'enable-admin': { disabled: false },
    };
    this.dialog.set({ kind, user, submit: (currentPassword) => this.patch(user, { ...body[kind], currentPassword }) });
  }

  protected close() {
    const d = this.dialog();
    this.dialog.set(null);
    if (d) this.focusKey(`${d.user.id}:${this.openedFrom ?? ({ reset: 'reset', delete: 'delete', disable: 'disable', 'enable-admin': 'disable', 'admin-on': 'admin', 'admin-off': 'admin' } as const)[d.kind]}`);
  }

  protected async enable(user: AdminUserDto) {
    if (this.enabling()) return;
    this.status.set('');
    this.actionError.set('');
    // An admin account needs the password: the server refuses without it
    if (user.isAdmin) return this.open('enable-admin', user);
    this.enabling.set(true);
    try {
      await this.patch(user, { disabled: false });
      this.status.set(`${user.displayName} is enabled. They need a new password link to sign in.`);
      await this.load(true);
      this.focusKey(`${user.id}:disable`);
    } catch (err) {
      this.actionError.set(errorMessage(err));
      void this.load(true);
    } finally {
      this.enabling.set(false);
    }
  }

  protected async simpleDone(d: Extract<DialogState, { submit: unknown }>) {
    const n = d.user.displayName;
    const selfDemoted = d.kind === 'admin-off' && d.user.id === this.auth.user()?.id;
    this.dialog.set(null);
    this.status.set(
      {
        'admin-on': `${n} is now an admin.`,
        'admin-off': `${n} is no longer an admin.`,
        disable: `${n} is disabled. Their sessions and API tokens were ended.`,
        'enable-admin': `${n} is enabled. They need a new password link to sign in.`,
      }[d.kind],
    );
    if (selfDemoted) return this.rightsLost();
    await this.load(true);
    this.focusKey(`${d.user.id}:${d.kind === 'disable' || d.kind === 'enable-admin' ? 'disable' : 'admin'}`);
  }

  protected async resetClosed(user: AdminUserDto, outcome: ResetLinkOutcome | null) {
    this.dialog.set(null);
    if (outcome) {
      const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(outcome.expiresAt);
      this.status.set(`Reset link created for ${user.displayName}. It expires on ${when}.${outcome.revokedTokens ? ' Their API tokens were revoked.' : ''}`);
      await this.load(true);
    }
    this.focusKey(`${user.id}:reset`);
  }

  protected async deleteClosed(user: AdminUserDto, outcome: DeleteOutcome | null) {
    this.dialog.set(null);
    if (!outcome) return this.focusKey(`${user.id}:delete`);
    const parts = [
      outcome.transfers ? `${outcome.transfers} ${outcome.transfers === 1 ? 'campaign was' : 'campaigns were'} transferred` : '',
      outcome.archives ? `${outcome.archives} archived` : '',
    ].filter(Boolean);
    this.status.set(`${user.displayName} was deleted.${parts.length ? ` ${parts.join(' and ')}.` : ''}`);
    await this.load(true);
    afterNextRender(() => this.headingEl().nativeElement.focus(), { injector: this.injector });
  }

  /** The admin lost their rights (or removed their own): leave the page. */
  protected async rightsLost() {
    this.dialog.set(null);
    await this.auth.refresh().catch(() => undefined);
    await this.router.navigateByUrl('/campaigns');
  }

  private focusKey(key: string) {
    afterNextRender(
      () => {
        const all = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>(`[data-key="${CSS.escape(key)}"]`));
        (all.find((e) => e.getClientRects().length > 0) ?? all[0])?.focus();
      },
      { injector: this.injector },
    );
  }
}
