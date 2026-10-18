import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { BACKUP_NAME_PATTERN, type BackupDto, type BackupListDto, type BackupStartedDto, type BackupTicketDto, type BackupTrigger } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/http.interceptor';
import { AdminNav } from './admin-nav';
import { BACKUP_NAVIGATE } from './backup-download';
import { StepUpDialog } from './step-up-dialog';

const POLL_MS = 2000;
const POLL_MAX_MS = 30_000;
const STARTED_LOCK_MS = 5000;

export const BACKUP_WARNING =
  "This file contains every password hash, every API-token hash and every campaign's DM secrets. Treat it like the database; encrypt it before copying it off this machine. It is stored on the same disk as your data.";

const TRIGGERS: Record<BackupTrigger, string> = { api: 'Web page', cli: 'Command line', scheduler: 'Scheduled' };

/** Instance backups: start one, see the list, download with the password. Admins only (route guard and server). */
@Component({
  selector: 'cn-backups-page',
  imports: [DatePipe, RouterLink, AdminNav, StepUpDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:visibilitychange)': 'onVisibility()' },
  template: `<div class="mx-auto max-w-5xl p-4 sm:p-6">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h1 class="font-display text-3xl font-bold">Backups</h1>
      @if (loaded() && backups().length) {<span class="rounded border border-line px-2 py-0.5 text-sm text-muted">{{ backups().length }} {{ backups().length === 1 ? 'backup' : 'backups' }}</span>}
    </div>
    <cn-admin-nav current="backups" />
    <p class="mt-3 text-muted">A backup is one file with the whole database and every upload. Make one before an update or a restore.</p>

    @if (loaded()) {<p id="backup-schedule" class="mt-2 text-sm text-muted">{{ scheduleText() }}</p>}

    <div class="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" id="backup-now" class="rounded-md bg-accent px-3 py-1.5 font-semibold text-accent-ink aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        [attr.aria-disabled]="blocked() ? 'true' : null" [attr.aria-describedby]="blocked() ? 'backup-now-reason' : null" (click)="start()">Back up now</button>
      @if (blocked(); as why) {<span id="backup-now-reason" class="text-sm font-medium">{{ why }}</span>}
    </div>

    <div role="status" class="mt-3 text-sm">{{ status() }}</div>
    <div role="alert" class="text-sm text-accent"><p>{{ actionError() }}</p></div>

    @if (lastError(); as e) {
      <section class="mt-3 rounded-xl border border-accent bg-panel p-3 text-sm" aria-labelledby="last-error-h">
        <h2 id="last-error-h" class="font-semibold">The last backup failed</h2>
        <p class="mt-1">{{ e }}</p>
      </section>
    }
    @if (lastWarnings().length) {
      <section class="mt-3 rounded-xl border border-line bg-panel p-3 text-sm" aria-labelledby="last-warn-h">
        <h2 id="last-warn-h" class="font-semibold">Notes about the last backup</h2>
        <ul class="mt-1 list-disc pl-5">
          @for (w of lastWarnings(); track $index) {<li>{{ w }}</li>}
        </ul>
      </section>
    }

    @if (loadError(); as e) {
      <section class="mt-3 rounded-xl border border-line bg-panel p-4" aria-label="Backups could not be loaded">
        <p role="alert" class="text-sm text-accent">{{ e }}</p>
        <div class="mt-2 flex gap-2">
          @if (forbidden()) {
            <a routerLink="/campaigns" class="rounded border border-line px-2 py-0.5 text-sm">Back to campaigns</a>
          } @else {
            <button type="button" class="rounded border border-line px-2 py-0.5 text-sm" (click)="load()">Try again</button>
          }
        </div>
      </section>
    } @else if (!loaded()) {
      <section class="mt-3 rounded-xl border border-line bg-panel p-4"><p role="status" class="text-sm text-muted">Loading backups…</p></section>
    } @else if (!backups().length) {
      <section class="mt-3 rounded-xl border border-line bg-panel p-4">
        <p class="text-sm">There are no backups yet. Choose “Back up now” to make the first one.</p>
      </section>
    } @else {
      <p class="mt-3 rounded-md border border-line bg-panel-2 p-3 text-sm" id="backup-warning"><strong>Handle with care.</strong> {{ warning }}</p>
      <p class="mt-2 text-xs text-muted" id="backup-dl-hint">
        If a download stops with “too many downloads”, wait a few seconds and choose Download again to get a new link.
      </p>

      <table class="mt-3 hidden w-full text-left text-sm md:table">
        <caption class="sr-only">Backups, newest first</caption>
        <thead class="text-xs text-muted">
          <tr class="border-b border-line">
            <th scope="col" class="py-2 pr-2 font-medium">Backup</th>
            <th scope="col" class="pr-2 font-medium">Size</th>
            <th scope="col" class="pr-2 font-medium">Made by</th>
            <th scope="col" class="pr-2 font-medium">Contents</th>
            <th scope="col" class="font-medium">Action</th>
          </tr>
        </thead>
        <tbody>
          @for (b of backups(); track b.name) {
            <tr class="border-b border-line align-top">
              <th scope="row" class="py-2 pr-2 font-normal"><strong>{{ b.createdAt | date: 'medium' }}</strong><br /><span class="break-all text-muted">{{ b.name }}</span></th>
              <td class="py-2 pr-2">{{ size(b.size) }}</td>
              <td class="py-2 pr-2">{{ trigger(b) }}</td>
              <td class="py-2 pr-2">{{ details(b) }}@if (b.missingUploads) {<div class="font-medium">Warning: {{ missing(b) }}</div>}</td>
              <td class="py-2">
                <button type="button" class="rounded border border-line px-2 py-0.5 text-sm aria-disabled:cursor-not-allowed aria-disabled:opacity-60" [attr.data-name]="b.name"
                  [attr.aria-label]="'Download ' + b.name" aria-describedby="backup-warning backup-dl-hint" [attr.aria-disabled]="started() === b.name ? 'true' : null" (click)="ask(b)">{{ started() === b.name ? 'Starting…' : 'Download' }}</button>
              </td>
            </tr>
          }
        </tbody>
      </table>

      <h2 class="sr-only md:hidden">Backups, newest first</h2>
      <ul class="mt-3 space-y-3 md:hidden">
        @for (b of backups(); track b.name) {
          <li class="rounded-xl border border-line bg-panel p-3 text-sm">
            <strong>{{ b.createdAt | date: 'medium' }}</strong>
            <div class="break-all text-muted">{{ b.name }}</div>
            <div class="mt-1">{{ size(b.size) }} · {{ trigger(b) }}</div>
            <div>{{ details(b) }}</div>
            @if (b.missingUploads) {<div class="font-medium">Warning: {{ missing(b) }}</div>}
            <button type="button" class="mt-2 w-full rounded border border-line px-2 py-2 text-sm aria-disabled:cursor-not-allowed aria-disabled:opacity-60" [attr.data-name]="b.name"
              [attr.aria-label]="'Download ' + b.name" aria-describedby="backup-warning backup-dl-hint" [attr.aria-disabled]="started() === b.name ? 'true' : null" (click)="ask(b)">{{ started() === b.name ? 'Starting…' : 'Download' }}</button>
          </li>
        }
      </ul>
    }

    <section class="mt-6 rounded-xl border border-line bg-panel p-4 text-sm" aria-labelledby="restore-h">
      <h2 id="restore-h" class="font-display text-lg font-bold">Restoring and keeping backups</h2>
      <p class="mt-1">Restoring is done on the server, from the command line, never from this page. It replaces all data, so stop the app first.</p>
      <p class="mt-2 font-medium">With Docker</p>
      <pre class="mt-1 whitespace-pre-wrap rounded bg-panel-2 p-2 text-xs [overflow-wrap:anywhere]"><code>{{ dockerStop }}
{{ dockerRestore }}</code></pre>
      <p class="mt-2 font-medium">Without Docker</p>
      <pre class="mt-1 whitespace-pre-wrap rounded bg-panel-2 p-2 text-xs [overflow-wrap:anywhere]"><code>{{ nativeRestore }}</code></pre>
      <p class="mt-1 text-muted">Run it with the same data directory and settings as the server.</p>
      <p class="mt-2">Old backups are removed automatically: the newest few are kept. Backups made from this page are protected for 7 days.</p>
    </section>

    @if (dialog(); as d) {
      <cn-step-up-dialog [heading]="'Download ' + d.name" confirmLabel="Download" [submit]="submitDownload(d.name)" networkHint="Nothing was downloaded." (succeeded)="downloaded(d.name)"
        (dismissed)="dialog.set(null)" (rightsLost)="rightsLost()" (stale)="load(true)">
        <p class="font-medium">{{ warning }}</p>
        <p>Your password is checked once and exchanged for a single-use link that works for 60 seconds. Your browser then saves the file.</p>
      </cn-step-up-dialog>
    }
  </div>`,
})
export class BackupsPage {
  private readonly http = inject(HttpClient);
  private readonly navigate = inject(BACKUP_NAVIGATE);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly warning = BACKUP_WARNING;
  protected readonly dockerStop = 'docker compose stop app';
  protected readonly dockerRestore = 'docker compose run --rm app node admin.mjs restore /data/app/backups/<file> --yes';
  protected readonly nativeRestore = 'node dist/admin.mjs restore backups/<file> --yes';

  protected readonly backups = signal<BackupDto[]>([]);
  protected readonly running = signal(false);
  protected readonly lastError = signal<string | null>(null);
  protected readonly lastWarnings = signal<string[]>([]);
  protected readonly scheduleInfo = signal<BackupListDto['schedule']>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal('');
  protected readonly forbidden = signal(false);
  protected readonly status = signal('');
  protected readonly actionError = signal('');
  protected readonly creating = signal(false);
  protected readonly dialog = signal<{ name: string } | null>(null);
  /** The name whose download was just started; only blocks its button for a few seconds. */
  protected readonly started = signal<string | null>(null);
  protected readonly scheduleText = (): string => {
    const sch = this.scheduleInfo();
    if (!sch) return 'Scheduled backups: off';
    const every = sch.everyHours === 1 ? 'every hour' : `every ${sch.everyHours} hours`;
    const next = sch.nextRunAt ? new Date(sch.nextRunAt) : null;
    return next && !Number.isNaN(next.getTime()) ? `Scheduled backups: ${every}, next run ${next.toLocaleString()}` : `Scheduled backups: ${every}`;
  };
  protected readonly busy = () => this.creating() || this.running();
  /** Why "Back up now" is unavailable, or '' when it is available. */
  protected readonly blocked = () => {
    if (this.creating()) return 'Starting the backup…';
    if (this.running()) return 'A backup is running. This page updates when it is done.';
    if (this.forbidden()) return 'You cannot make backups from this page.';
    if (this.loadError()) return 'The backup list could not be loaded, so backups are paused. Use Try again below.';
    return '';
  };

  private watching = false;
  private streak = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private lockTimer: ReturnType<typeof setTimeout> | undefined;
  private waitingVisible = false;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      clearTimeout(this.pollTimer);
      clearTimeout(this.lockTimer);
    });
    void this.load();
  }

  protected trigger(b: BackupDto) {
    return TRIGGERS[b.trigger] ?? 'Unknown';
  }

  protected size(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${i === 0 ? n : n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`;
  }

  protected details(b: BackupDto): string {
    const parts: string[] = [];
    if (b.appVersion) parts.push(`App ${b.appVersion}`);
    if (b.migrationLevel) parts.push(`database ${b.migrationLevel}`);
    if (b.counts) {
      const { users, campaigns, uploads } = b.counts;
      parts.push(`${users} ${users === 1 ? 'user' : 'users'}`, `${campaigns} ${campaigns === 1 ? 'campaign' : 'campaigns'}`, `${uploads} ${uploads === 1 ? 'upload' : 'uploads'}`);
    }
    return parts.length ? parts.join(' · ') : 'Details unknown';
  }

  protected missing(b: BackupDto): string {
    const n = b.missingUploads ?? 0;
    return `${n} ${n === 1 ? 'upload' : 'uploads'} had no file when this backup was made.`;
  }

  /** `quiet` is a refresh behind the page: it keeps what is shown when it fails. */
  protected async load(quiet = false) {
    if (!quiet) this.loadError.set('');
    try {
      const list = await firstValueFrom(this.http.get<BackupListDto>('/api/admin/backups'));
      this.streak = 0;
      this.backups.set(list.backups);
      this.running.set(list.running !== null);
      this.lastError.set(list.lastError);
      this.lastWarnings.set(list.lastWarnings);
      this.scheduleInfo.set(list.schedule ?? null);
      this.loaded.set(true);
      this.loadError.set('');
      if (list.running) this.watching = true;
      else if (this.watching) {
        this.watching = false;
        this.status.set(list.lastError ? (/failed/i.test(list.lastError) ? list.lastError : `The backup failed. ${list.lastError}`) : 'The backup finished.');
      }
    } catch (err) {
      this.streak++;
      if (!quiet || !this.loaded()) {
        this.loadError.set(errorMessage(err));
        this.forbidden.set(err instanceof HttpErrorResponse && err.status === 403);
      } else if (this.watching) this.status.set('Could not refresh the list. Trying again.');
    }
    this.schedule();
  }

  private schedule() {
    clearTimeout(this.pollTimer);
    if (this.destroyed || !(this.running() || this.watching) || this.forbidden()) return;
    const delay = Math.min(POLL_MS * 2 ** Math.max(0, this.streak), POLL_MAX_MS);
    this.pollTimer = setTimeout(() => {
      if (document.hidden) this.waitingVisible = true;
      else void this.load(true);
    }, delay);
  }

  protected onVisibility() {
    if (!document.hidden && this.waitingVisible) {
      this.waitingVisible = false;
      void this.load(true);
    }
  }

  protected async start() {
    if (this.blocked()) return;
    this.status.set('');
    this.actionError.set('');
    this.creating.set(true);
    try {
      const res = await firstValueFrom(this.http.post<BackupStartedDto>('/api/admin/backups', {}));
      // `name` can be null while the backup waits for its lock: the list is the truth
      this.watching = true;
      this.status.set(res.status === 'running' ? 'Backup started.' : 'Backup started, checking the result.');
      this.creating.set(false);
      await this.load(true);
    } catch (err) {
      this.creating.set(false);
      this.actionError.set(this.startError(err));
      if (err instanceof HttpErrorResponse && err.status === 409) void this.load(true);
    } finally {
      this.creating.set(false);
    }
  }

  private startError(err: unknown): string {
    if (!(err instanceof HttpErrorResponse)) return errorMessage(err);
    const message = errorMessage(err);
    switch (err.status) {
      case 409:
        if (/already running/i.test(message)) return 'A backup is already running. This page updates when it is done.';
        if (/restore/i.test(message)) return 'A restore is running or was interrupted, so backups are refused until it is finished.';
        // The API cap: the server sentence carries the count and the command line hint
        if (message.includes('node dist/admin.mjs backup')) return message;
        return 'The backup was refused.';
      case 429: {
        const secs = Number(err.headers.get('Retry-After'));
        const wait = secs > 0 ? ` Try again in ${secs >= 60 ? `${Math.ceil(secs / 60)} min` : `${secs} s`}.` : ' Try again in a few minutes.';
        return `You can make 3 backups from this page every 10 minutes.${wait}`;
      }
      case 507:
        return 'Not enough free disk space for a backup. Lower BACKUP_KEEP, free space or point BACKUP_DIR at a larger disk.';
      default:
        return message;
    }
  }

  protected ask(b: BackupDto) {
    if (this.started() === b.name || !BACKUP_NAME_PATTERN.test(b.name)) return;
    this.status.set('');
    this.actionError.set('');
    this.dialog.set({ name: b.name });
  }

  /** The ticket lives in this closure only: it goes straight into the navigation and is never stored. */
  protected submitDownload(name: string) {
    return async (currentPassword: string) => {
      const { ticket } = await firstValueFrom(this.http.post<BackupTicketDto>(`/api/admin/backups/${name}/ticket`, { currentPassword }));
      this.navigate(`/api/admin/backups/${name}?ticket=${encodeURIComponent(ticket)}`);
    };
  }

  protected downloaded(name: string) {
    this.dialog.set(null);
    this.started.set(name);
    this.status.set(`Download of ${name} started. Your browser saves it to disk.`);
    clearTimeout(this.lockTimer);
    this.lockTimer = setTimeout(() => this.started.set(null), STARTED_LOCK_MS);
  }

  protected async rightsLost() {
    this.dialog.set(null);
    await this.auth.refresh().catch(() => undefined);
    await this.router.navigateByUrl('/campaigns');
  }
}
