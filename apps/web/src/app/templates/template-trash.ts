import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { afterNextRender, ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, Injector, input, output, signal, untracked, viewChild } from '@angular/core';
import { TRASH_RETENTION_DAYS, type TemplateTrashItemDto } from '@cn/shared';
import { errorMessage } from '../core/http.interceptor';
import { TemplateApi } from './template-api';

const DAY_MS = 86_400_000;

type Action = 'restore' | 'purge' | 'parent';

/** A restore refused because the template's `extends` parent is still in the trash. */
interface ParentBlock {
  id: string;
  message: string;
  parentId: string;
  /** Further templates that must be restored after `parentId`, nearest first (a chain of trashed parents). */
  then: string[];
}

/**
 * "Deleted templates" in the template library: what the caller could edit (the API scopes it, so a player or a
 * person with nothing deleted sees nothing at all). Restore is instant; Delete permanently asks first.
 */
@Component({
  selector: 'cn-template-trash',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `<section #section tabindex="-1" class="outline-none" [class.mt-8]="visible() || loading() || !!loadError()" [attr.aria-label]="named() ? 'Deleted templates' : null">
    @if (visible()) {
      <h2 #heading id="tt-heading" tabindex="-1" class="font-display text-xl font-bold">Deleted templates</h2>
      <p class="mt-1 text-sm text-muted">
        Deleted templates stay here for {{ retention }} days, then they are removed for good. Restoring one brings back its versions and the pages linked to it.
      </p>
    }
    <div role="status" class="text-sm" [class.mt-2]="status()">{{ status() }}</div>
    <div role="alert" class="text-sm text-accent">{{ actionError() }}</div>

    @if (loading()) {
      <p class="mt-2 text-sm text-muted">Loading deleted templates…</p>
    }
    @if (loadError(); as e) {
      <div role="alert" class="mt-2 rounded-xl border border-line bg-panel p-4">
        <p>Could not load the deleted templates. {{ e }}</p>
        <button type="button" data-action="retry" class="mt-3 rounded-md border border-line px-3 py-2.5 hover:border-accent aria-disabled:opacity-60 sm:py-1.5" [attr.aria-disabled]="loading() || null" [attr.aria-busy]="loading() || null" (click)="retry()">Try again</button>
      </div>
    } @else if (visible()) {
      @if (!items().length) {
        <p class="mt-3 rounded-xl border border-line bg-panel p-4 text-center text-sm text-muted">No deleted templates.</p>
      } @else {
        <ul class="mt-3 space-y-2" aria-label="Deleted templates">
          @for (it of items(); track it.id) {
            <li [attr.data-id]="it.id" class="flex flex-col gap-3 rounded-xl border border-line bg-panel p-3 sm:flex-row sm:items-center sm:justify-between">
              <div class="min-w-0">
                <p class="font-semibold break-words"><span aria-hidden="true">{{ it.icon || (it.kind === 'page' ? '📄' : '🧩') }}</span> {{ it.name }}</p>
                <p class="text-sm text-muted">{{ it.kind === 'page' ? 'Page template' : 'Block template' }} · {{ scopeText(it) }}</p>
                <p class="text-sm" [class]="daysLeft(it) <= 3 ? 'text-accent' : 'text-muted'">
                  <time [attr.datetime]="iso(it)" [title]="it.deletedAt | date: 'medium'">
                    <span class="block sm:inline">{{ deletedText(it) }}</span><span class="sr-only">, </span><span class="hidden sm:inline" aria-hidden="true"> · </span><span class="block sm:inline">{{ purgeText(it) }}</span>
                  </time>
                </p>
                @if (block(); as b) {
                  @if (b.id === it.id) {
                    <p id="tt-block-msg" class="mt-1 text-sm text-accent">{{ b.message }}</p>
                  }
                }
              </div>
              <div class="flex flex-col gap-2 sm:flex-row">
                @if (block(); as b) {
                  @if (b.id === it.id) {
                    <button type="button" data-action="parent" aria-describedby="tt-block-msg" [attr.aria-label]="parentLabel(b)" class="rounded-md border border-line px-3 py-2.5 hover:border-accent aria-disabled:opacity-60 sm:py-1.5" [attr.aria-disabled]="busy() === it.id || null" [attr.aria-busy]="busy() === it.id || null" (click)="restoreParent(it, b)">
                      {{ busy() === it.id && busyAction() === 'parent' ? 'Restoring…' : 'Restore the parent first' }}
                    </button>
                  }
                }
                <button type="button" data-action="restore" class="rounded-md border border-line px-3 py-2.5 hover:border-accent aria-disabled:opacity-60 sm:py-1.5" [attr.aria-label]="label('restore', it.name, it.id)" [attr.aria-disabled]="busy() === it.id || null" [attr.aria-busy]="busy() === it.id || null" (click)="restore(it)">
                  {{ busy() === it.id && busyAction() === 'restore' ? 'Restoring…' : 'Restore' }}
                </button>
                <button type="button" data-action="purge" class="rounded-md border border-line px-3 py-2.5 text-accent hover:border-accent aria-disabled:opacity-60 sm:py-1.5" [attr.aria-label]="label('purge', it.name, it.id)" [attr.aria-disabled]="busy() === it.id || null" [attr.aria-busy]="busy() === it.id || null" (click)="purge(it)">
                  {{ busy() === it.id && busyAction() === 'purge' ? 'Deleting…' : 'Delete permanently' }}
                </button>
              </div>
            </li>
          }
        </ul>
      }
    }
  </section>`,
})
export class TemplateTrash {
  /** Set inside a campaign: only that campaign's deleted templates. Otherwise only the personal ones. */
  readonly campaignId = input<string | undefined>(undefined);
  /** A template was restored or purged (the library reloads its list). */
  readonly changed = output<void>();

  private readonly api = inject(TemplateApi);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly section = viewChild.required<ElementRef<HTMLElement>>('section');
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  protected readonly retention = TRASH_RETENTION_DAYS;
  protected readonly loading = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly actionError = signal('');
  protected readonly status = signal('');
  protected readonly busy = signal<string | null>(null);
  protected readonly busyAction = signal<Action | null>(null);
  protected readonly block = signal<ParentBlock | null>(null);
  private readonly entries = signal<TemplateTrashItemDto[]>([]);
  /** Newest deletion first. */
  protected readonly items = computed(() => [...this.entries()].sort((a, b) => b.deletedAt - a.deletedAt));
  private readonly retried = signal(false);
  /** The section is a named region only while it shows something (an empty region would be noise for a player). */
  protected readonly named = computed(() => this.visible() || this.loading() || !!this.loadError() || this.retried());
  /** The section shows only when there is something to restore or something to report. */
  protected readonly visible = computed(() => this.entries().length > 0 || !!this.status() || !!this.actionError());

  /** Bumped when the campaign input changes: work started before that must not touch the new state. */
  private epoch = 0;
  /** Bumped by every load, so only the newest response is applied. */
  private loadSeq = 0;
  /** Bumped when an action starts, so a silent reload that began earlier cannot bring a row back. */
  private actionSeq = 0;

  constructor() {
    effect(() => {
      this.campaignId();
      untracked(() => {
        this.epoch++;
        this.actionSeq++;
        this.status.set('');
        this.actionError.set('');
        this.block.set(null);
        this.busy.set(null);
        this.busyAction.set(null);
        this.entries.set([]);
        void this.load('initial');
      });
    });
  }

  protected parentLabel(b: ParentBlock) {
    const parent = this.entries().find((e) => e.id === b.parentId);
    const text = this.busy() === b.id && this.busyAction() === 'parent' ? 'Restoring…' : 'Restore the parent first';
    return parent ? `${text}: ${parent.name}` : text;
  }

  protected async retry() {
    if (this.loading()) return;
    this.retried.set(true);
    await this.load('retry');
    afterNextRender(
      () => {
        const retryBtn = this.host.nativeElement.querySelector<HTMLElement>('[data-action="retry"]');
        (retryBtn ?? this.heading()?.nativeElement ?? this.section().nativeElement).focus();
      },
      { injector: this.injector },
    );
  }

  /** `initial` shows no loading line (a person with nothing deleted sees nothing); `silent` keeps the list on failure. */
  protected async load(mode: 'initial' | 'retry' | 'silent' = 'retry') {
    const seq = ++this.loadSeq;
    const actions = this.actionSeq;
    const epoch = this.epoch;
    if (mode === 'retry') this.loading.set(true);
    if (mode === 'initial') this.loadError.set(null);
    const campaignId = this.campaignId() ?? null;
    try {
      const all = await this.api.trash(campaignId);
      if (seq !== this.loadSeq || epoch !== this.epoch || (mode === 'silent' && actions !== this.actionSeq)) return;
      // The library lists personal templates outside a campaign, so the trash does the same
      this.loadError.set(null);
      this.entries.set(campaignId ? all : all.filter((t) => t.scope === 'user'));
    } catch (err) {
      if (seq !== this.loadSeq || epoch !== this.epoch) return;
      if (mode !== 'silent') this.loadError.set(errorMessage(err));
    } finally {
      if (seq === this.loadSeq) this.loading.set(false);
    }
  }

  /** Accessible name = the visible text first, then the template (WCAG 2.5.3); follows the busy text. */
  protected label(action: 'restore' | 'purge', name: string, id: string) {
    const busy = this.busy() === id && this.busyAction() === action;
    return action === 'restore' ? `${busy ? 'Restoring…' : 'Restore'}: ${name}` : `${busy ? 'Deleting…' : 'Delete permanently'}: ${name}`;
  }

  /** Extra sentence for the status when the restored template reports problems (a missing parent, mostly). */
  private issueNote(t: { issues?: string[] }) {
    if (!t.issues?.length) return '';
    return t.issues.some((i) => /^The parent template ".*" was not found$/.test(i))
      ? ' Its parent no longer exists: choose a new parent when you edit it.'
      : ` It has ${t.issues.length === 1 ? 'a problem' : `${t.issues.length} problems`}: open it to review.`;
  }

  protected scopeText(it: TemplateTrashItemDto) {
    return it.scope === 'campaign' ? `Campaign${it.campaign ? ': ' + it.campaign.name : ''}` : 'Personal';
  }
  protected iso(it: TemplateTrashItemDto) {
    return new Date(it.deletedAt).toISOString();
  }
  private ageDays(it: TemplateTrashItemDto) {
    return Math.max(0, Math.floor((Date.now() - it.deletedAt) / DAY_MS));
  }
  protected daysLeft(it: TemplateTrashItemDto) {
    return Math.max(0, TRASH_RETENTION_DAYS - this.ageDays(it));
  }
  protected deletedText(it: TemplateTrashItemDto) {
    const d = this.ageDays(it);
    return `Deleted ${d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`}`;
  }
  protected purgeText(it: TemplateTrashItemDto) {
    const d = this.daysLeft(it);
    return d === 0 ? 'purged today' : d === 1 ? 'purged tomorrow' : `purged in ${d} days`;
  }

  protected async restore(it: TemplateTrashItemDto) {
    if (this.busy()) return;
    const epoch = this.epoch;
    await this.run(it, 'restore', async () => {
      const restored = await this.api.restore(it.id);
      this.changed.emit();
      if (epoch !== this.epoch) return;
      if (this.block()?.id === it.id) this.block.set(null);
      this.status.set(`Restored "${it.name}".${this.issueNote(restored)}`);
    });
  }

  protected async purge(it: TemplateTrashItemDto) {
    if (this.busy()) return;
    if (!confirm(`Permanently delete "${it.name}"? This cannot be undone.`)) return;
    const epoch = this.epoch;
    await this.run(it, 'purge', async () => {
      await this.api.purge(it.id);
      if (epoch !== this.epoch) return;
      if (this.block()?.id === it.id) this.block.set(null);
      this.status.set(`Permanently deleted "${it.name}".`);
    });
  }

  /** Restores the parent that blocked a restore, then offers the child again. */
  protected async restoreParent(it: TemplateTrashItemDto, b: ParentBlock) {
    if (this.busy()) return;
    const epoch = this.epoch;
    this.actionSeq++;
    this.busy.set(it.id);
    this.busyAction.set('parent');
    this.actionError.set('');
    try {
      const parent = await this.api.restore(b.parentId);
      if (epoch !== this.epoch) return;
      this.entries.update((l) => l.filter((e) => e.id !== b.parentId));
      this.changed.emit();
      const note = this.issueNote(parent);
      if (b.then.length) {
        // A chain: the child still waits on the next trashed template
        const [nextId, ...rest] = b.then;
        const next = this.quoted(nextId, 'the next template');
        this.block.set({ id: it.id, parentId: nextId, then: rest, message: `${next[0].toUpperCase()}${next.slice(1)} is needed before "${it.name}" can come back.` });
        this.status.set(`Restored "${parent.name}".${note} Now restore ${next}.`);
        this.focusAfterRender(it.id, 'parent');
      } else {
        this.block.set(null);
        this.status.set(`Restored the parent "${parent.name}".${note} You can restore "${it.name}" now.`);
        this.focusAfterRender(it.id, 'restore');
      }
    } catch (err) {
      if (epoch !== this.epoch) return;
      const next = this.conflict(it, err);
      if (next) {
        // The parent itself waits on its own parent: name who blocks whom, keep the chain
        const blocker = { ...next, then: [b.parentId, ...b.then], message: `${this.quoted(b.parentId, 'The parent').replace(/^t/, 'T')} is blocked too. ${next.message}` };
        this.block.set(blocker);
        this.status.set(blocker.message);
      } else if (err instanceof HttpErrorResponse && (err.status === 404 || err.status === 400)) {
        this.block.set(null);
        this.status.set(`The parent is no longer in the trash. Try restoring "${it.name}" again.`);
        this.focusAfterRender(it.id, 'restore');
        void this.load('silent');
      } else {
        this.actionError.set(errorMessage(err));
      }
    } finally {
      if (epoch === this.epoch) {
        this.busy.set(null);
        this.busyAction.set(null);
      }
    }
  }

  /** `"Name"` for a template in the list, else a plain phrase (never a quoted placeholder). */
  private quoted(id: string, fallback: string) {
    const name = this.entries().find((e) => e.id === id)?.name;
    return name ? `"${name}"` : fallback;
  }

  private conflict(it: TemplateTrashItemDto, err: unknown): ParentBlock | null {
    if (!(err instanceof HttpErrorResponse) || err.status !== 409) return null;
    const parentId = (err.error as { details?: { templateId?: unknown } } | null)?.details?.templateId;
    return typeof parentId === 'string' ? { id: it.id, message: errorMessage(err), parentId, then: [] } : null;
  }

  private async run(it: TemplateTrashItemDto, action: 'restore' | 'purge', call: () => Promise<void>) {
    const epoch = this.epoch;
    this.actionSeq++;
    this.busy.set(it.id);
    this.busyAction.set(action);
    this.actionError.set('');
    try {
      await call();
      if (epoch !== this.epoch) return;
      this.removeRow(it, action);
    } catch (err) {
      if (epoch !== this.epoch) return;
      const blocked = action === 'restore' ? this.conflict(it, err) : null;
      if (blocked) {
        this.block.set(blocked);
        this.status.set(blocked.message);
        this.focusAfterRender(it.id, 'parent');
      } else if (err instanceof HttpErrorResponse && (err.status === 404 || err.status === 400)) {
        // Already purged or restored elsewhere: not an error for the person
        this.status.set(`"${it.name}" is no longer in the trash.`);
        if (this.block()?.id === it.id) this.block.set(null);
        this.removeRow(it, action);
        void this.load('silent');
        if (action === 'restore') this.changed.emit();
      } else {
        this.actionError.set(errorMessage(err));
      }
    } finally {
      if (epoch === this.epoch) {
        this.busy.set(null);
        this.busyAction.set(null);
      }
    }
  }

  private focusAfterRender(id: string, action: string) {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(`li[data-id="${id}"] [data-action="${action}"]`)?.focus(), { injector: this.injector });
  }

  /** Drops the row and keeps focus: same action on the next row (previous when last), else the heading. */
  private removeRow(it: TemplateTrashItemDto, action: 'restore' | 'purge') {
    const i = this.items().findIndex((e) => e.id === it.id);
    this.entries.update((l) => l.filter((e) => e.id !== it.id));
    const rest = this.items();
    afterNextRender(
      () => {
        const rows = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>(`li [data-action="${action}"]`));
        (rest.length ? rows[Math.min(i, rest.length - 1)] : this.heading()?.nativeElement)?.focus();
      },
      { injector: this.injector },
    );
  }
}
