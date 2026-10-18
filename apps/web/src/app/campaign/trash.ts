import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { afterNextRender, ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, Injector, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PAGE_TYPE_ICONS, PAGE_TYPE_LABELS, TRASH_RETENTION_DAYS, type TrashEntryDto } from '@cn/shared';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../core/http.interceptor';
import { CampaignStore } from './campaign.store';

const RETENTION_DAYS = TRASH_RETENTION_DAYS;
const DAY_MS = 86_400_000;

type Action = 'restore' | 'purge';

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const subpages = (n: number) => (n === 0 ? 'no subpages' : `${n} ${plural(n, 'subpage', 'subpages')}`);

/** GM-only list of deleted page trees with Restore and Delete permanently. */
@Component({
  selector: 'cn-campaign-trash',
  imports: [RouterLink, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `<div class="mx-auto w-full max-w-3xl p-4 sm:p-6">
    <h1 #heading tabindex="-1" class="font-display text-3xl font-bold">Trash</h1>
    <p class="mt-1 text-sm text-muted">
      Deleted pages stay here for {{ retention }} days, then they are removed for good. Restoring a page brings back its subpages. If its parent page is also in the trash, the page returns to the top level.
    </p>

    <div role="status" class="mt-3 text-sm">
      @if (status(); as s) {
        {{ s.text }}
        @if (s.openId) {
          <a class="cn-link" [routerLink]="['/c', store.id(), 'p', s.openId]">Open page</a>
        }
      }
    </div>
    <div role="alert" class="text-sm text-accent">{{ actionError() }}</div>

    @if (loading()) {
      <p role="status" class="mt-4 text-muted">Loading trash…</p>
    } @else if (loadError(); as e) {
      <div role="alert" class="mt-4 rounded-xl border border-line bg-panel p-4">
        <p>{{ e }}</p>
        <div class="mt-3 flex flex-wrap gap-3">
          <button type="button" class="rounded-md border border-line px-3 py-1.5 hover:border-accent" (click)="retry()">Try again</button>
          @if (forbidden()) {
            <a class="cn-link self-center" [routerLink]="['/c', store.id()]">Back to the campaign</a>
          }
        </div>
      </div>
    } @else if (!items().length) {
      <div class="mt-4 rounded-xl border border-line bg-panel p-6 text-center">
        <p class="font-semibold">The trash is empty.</p>
        <p class="text-sm text-muted">Pages you delete show up here for {{ retention }} days.</p>
      </div>
    } @else {
      <ul class="mt-4 space-y-2" aria-label="Deleted pages">
        @for (it of items(); track it.id) {
          <li class="flex flex-col gap-3 rounded-xl border border-line bg-panel p-3 sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0">
              <p class="font-semibold break-words"><span aria-hidden="true">{{ it.icon || icons[it.type] }}</span> {{ it.title }}</p>
              <p class="text-sm text-muted">{{ labels[it.type] }} · {{ subpageText(it.subpageCount) }}</p>
              <p class="text-sm" [class]="daysLeft(it) <= 3 ? 'text-accent' : 'text-muted'">
                <time [attr.datetime]="iso(it)" [title]="it.deletedAt | date: 'medium'">
                  <span class="block sm:inline">{{ deletedText(it) }}</span><span class="sr-only">, </span><span class="hidden sm:inline" aria-hidden="true"> · </span><span class="block sm:inline">{{ purgeText(it) }}</span>
                </time>
              </p>
            </div>
            <div class="flex flex-col gap-2 sm:flex-row">
              <button type="button" data-action="restore" class="rounded-md border border-line px-3 py-2.5 hover:border-accent aria-disabled:opacity-60 sm:py-1.5" [attr.aria-label]="label('restore', it.title, it.id)" [attr.aria-disabled]="busy() === it.id || null" [attr.aria-busy]="busy() === it.id || null" (click)="restore(it)">
                {{ busy() === it.id && busyAction() === 'restore' ? 'Restoring…' : 'Restore' }}
              </button>
              <button type="button" data-action="purge" class="rounded-md border border-line px-3 py-2.5 text-accent hover:border-accent aria-disabled:opacity-60 sm:py-1.5" [attr.aria-label]="label('purge', it.title, it.id)" [attr.aria-disabled]="busy() === it.id || null" [attr.aria-busy]="busy() === it.id || null" (click)="purge(it)">
                {{ busy() === it.id && busyAction() === 'purge' ? 'Deleting…' : 'Delete permanently' }}
              </button>
            </div>
          </li>
        }
      </ul>
    }
  </div>`,
})
export class CampaignTrash {
  protected readonly store = inject(CampaignStore);
  private readonly http = inject(HttpClient);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');

  protected readonly retention = RETENTION_DAYS;
  protected readonly icons = PAGE_TYPE_ICONS;
  protected readonly labels = PAGE_TYPE_LABELS;
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly forbidden = signal(false);
  protected readonly actionError = signal('');
  protected readonly status = signal<{ text: string; openId?: string } | null>(null);
  protected readonly busy = signal<string | null>(null);
  protected readonly busyAction = signal<Action | null>(null);
  private readonly entries = signal<TrashEntryDto[]>([]);
  /** Newest deletion first. */
  protected readonly items = computed(() => [...this.entries()].sort((a, b) => b.deletedAt - a.deletedAt));

  constructor() {
    effect(() => {
      const id = this.store.id();
      if (id) untracked(() => void this.load());
    });
  }

  private url(path = '') {
    return `/api/campaigns/${this.store.id()}${path}`;
  }

  protected async retry() {
    await this.load();
    afterNextRender(() => this.heading().nativeElement.focus(), { injector: this.injector });
  }

  protected async load(silent = false) {
    if (!silent) this.loading.set(true);
    this.loadError.set(null);
    this.forbidden.set(false);
    try {
      this.entries.set((await firstValueFrom(this.http.get<{ items: TrashEntryDto[] }>(this.url('/trash')))).items);
    } catch (err) {
      this.loadError.set(errorMessage(err));
      this.forbidden.set(err instanceof HttpErrorResponse && err.status === 403);
    } finally {
      this.loading.set(false);
    }
  }

  /** Accessible name = visible text first, then the page (WCAG 2.5.3); follows the busy text. */
  protected label(action: Action, title: string, id: string) {
    const busy = this.busy() === id && this.busyAction() === action;
    return action === 'restore' ? `${busy ? 'Restoring…' : 'Restore'}: ${title}` : `${busy ? 'Deleting…' : 'Delete permanently'}: ${title}`;
  }

  protected subpageText = subpages;
  protected iso(it: TrashEntryDto) {
    return new Date(it.deletedAt).toISOString();
  }
  private ageDays(it: TrashEntryDto) {
    return Math.max(0, Math.floor((Date.now() - it.deletedAt) / DAY_MS));
  }
  protected daysLeft(it: TrashEntryDto) {
    return Math.max(0, RETENTION_DAYS - this.ageDays(it));
  }
  protected deletedText(it: TrashEntryDto) {
    const d = this.ageDays(it);
    return `Deleted ${d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`}`;
  }
  protected purgeText(it: TrashEntryDto) {
    const d = this.daysLeft(it);
    return d === 0 ? 'purged today' : d === 1 ? 'purged tomorrow' : `purged in ${d} days`;
  }

  protected async restore(it: TrashEntryDto) {
    if (this.busy()) return;
    await this.run(it, 'restore', async () => {
      const res = await firstValueFrom(this.http.post<{ restored: string[] }>(this.url(`/pages/${it.id}/restore`), {}));
      const n = Math.max(0, res.restored.length - 1);
      this.status.set({ text: `Restored "${it.title}"${n ? ` with ${n} ${plural(n, 'subpage', 'subpages')}` : ''}.`, openId: it.id });
      void this.store.reloadPages();
      this.store.clearUndoFor(it.id);
    });
  }

  protected async purge(it: TrashEntryDto) {
    if (this.busy()) return;
    const n = it.subpageCount;
    const what = n ? `"${it.title}" and its ${n} ${plural(n, 'subpage', 'subpages')}` : `"${it.title}"`;
    if (!confirm(`Permanently delete ${what}? This cannot be undone.`)) return;
    await this.run(it, 'purge', async () => {
      const res = await firstValueFrom(this.http.delete<{ purged: string[] }>(this.url(`/pages/${it.id}/purge`)));
      const k = Math.max(0, res.purged.length - 1);
      this.store.clearUndoFor(it.id);
      this.status.set({ text: `Permanently deleted "${it.title}"${k ? ` and ${k} ${plural(k, 'subpage', 'subpages')}` : ''}.` });
    });
  }

  private async run(it: TrashEntryDto, action: Action, call: () => Promise<void>) {
    this.busy.set(it.id);
    this.busyAction.set(action);
    this.actionError.set('');
    try {
      await call();
      this.removeRow(it, action);
    } catch (err) {
      if (err instanceof HttpErrorResponse && (err.status === 404 || err.status === 400)) {
        // Already purged or restored elsewhere: not an error for the person
        this.status.set({ text: `"${it.title}" is no longer in the trash.` });
        this.removeRow(it, action);
        void this.load(true);
      } else {
        this.actionError.set(errorMessage(err));
      }
    } finally {
      this.busy.set(null);
      this.busyAction.set(null);
    }
  }

  /** Drops the row and keeps focus: same action on the next row (previous when last), else the heading. */
  private removeRow(it: TrashEntryDto, action: Action) {
    const before = this.items();
    const i = before.findIndex((e) => e.id === it.id);
    this.entries.update((l) => l.filter((e) => e.id !== it.id));
    const rest = this.items();
    // After the render that drops the row (and any silent reload): same action on the next row, else the heading
    afterNextRender(
      () => {
        const rows = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>(`li [data-action="${action}"]`));
        (rest.length ? rows[Math.min(i, rest.length - 1)] : this.heading().nativeElement)?.focus();
      },
      { injector: this.injector },
    );
  }
}
