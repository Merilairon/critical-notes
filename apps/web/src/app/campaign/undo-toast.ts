import type { ElementRef} from '@angular/core';
import { afterNextRender, ChangeDetectionStrategy, Component, effect, inject, Injector, signal, untracked, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { CampaignStore } from './campaign.store';

export const UNDO_SECONDS = 10;
const NOTICE_MS = 4000;

/**
 * "Deleted · Undo" toast and short confirmations for the campaign. Lives in the shell so it outlives the
 * page editor, which navigates away right after a delete. The live region is always in the DOM.
 */
@Component({
  selector: 'cn-undo-toast',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-50 sm:right-auto sm:left-[max(1rem,env(safe-area-inset-left))] sm:max-w-md lg:max-w-[min(28rem,calc(100vw-14rem))]', '(keydown.escape)': 'onEscape()' },
  template: `<div role="status" aria-live="polite" aria-atomic="true">
      @if (store.undo(); as u) {
        @if (!store.undoFailed()) {
          <div class="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel px-4 py-3 text-sm shadow-xl" (mouseenter)="hovered.set(true)" (mouseleave)="hovered.set(false)" (focusin)="focused.set(true)" (focusout)="focused.set(false)">
            <span class="min-w-0 break-words">Deleted "{{ u.title }}"{{ u.subpages ? ' and ' + u.subpages + (u.subpages === 1 ? ' subpage' : ' subpages') : '' }}</span>
            <span class="sr-only">Undo is available for {{ seconds }} seconds.</span>
            <span class="ml-auto flex items-center gap-1 max-sm:w-full">
              <button type="button" class="min-h-[44px] rounded-md bg-accent px-3 py-1.5 font-semibold text-accent-ink max-sm:flex-1" [attr.aria-label]="'Undo delete of &quot;' + u.title + '&quot;'" [attr.aria-disabled]="busy() || null" [attr.aria-busy]="busy() || null" (click)="undo()">{{ busy() ? 'Undoing…' : 'Undo' }}</button>
              <button type="button" class="min-h-[44px] min-w-[44px] rounded px-2 py-1 text-muted hover:text-ink" aria-label="Dismiss" (click)="dismiss()">✕</button>
            </span>
          </div>
        }
      } @else if (store.toast(); as t) {
        <div class="rounded-lg border border-line bg-panel px-4 py-3 text-sm shadow-xl">{{ t }}</div>
      }
    </div>
    <div role="alert">
      @if (store.undo() && store.undoFailed()) {
        <div class="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel px-4 py-3 text-sm shadow-xl">
          <span>Could not undo. Open the trash to restore it.</span>
          <a #trashLink class="cn-link" routerLink="trash" (click)="dismiss()">Trash</a>
          <button type="button" class="ml-auto min-h-[44px] min-w-[44px] rounded px-2 py-1 text-muted hover:text-ink" aria-label="Dismiss" (click)="dismiss()">✕</button>
        </div>
      }
    </div>`,
})
export class UndoToast {
  protected readonly store = inject(CampaignStore);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly trashLink = viewChild<ElementRef<HTMLElement>>('trashLink');
  protected readonly seconds = UNDO_SECONDS;
  protected readonly hovered = signal(false);
  protected readonly focused = signal(false);
  protected readonly busy = signal(false);

  constructor() {
    // Countdown: runs while a fresh offer is shown and neither hovered nor focused; restarts at full length afterwards
    // A new or removed offer starts with a clean slate, so a replaced card cannot leave the next timer paused
    effect(() => {
      this.store.undo();
      untracked(() => {
        this.hovered.set(false);
        this.focused.set(false);
      });
    });
    effect((onCleanup) => {
      const u = this.store.undo();
      const paused = this.hovered() || this.focused();
      if (!u || this.store.undoFailed() || paused) return;
      const t = setTimeout(() => untracked(() => this.store.dismissUndo()), UNDO_SECONDS * 1000);
      onCleanup(() => clearTimeout(t));
    });
    effect((onCleanup) => {
      if (!this.store.toast()) return;
      const t = setTimeout(() => untracked(() => this.store.toast.set(null)), NOTICE_MS);
      onCleanup(() => clearTimeout(t));
    });
  }

  protected async undo() {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const id = await this.store.undoDelete();
      this.hovered.set(false);
      this.focused.set(false);
      if (id) {
        await this.router.navigate(['/c', this.store.id(), 'p', id]);
        this.focusMain(true);
      } else if (this.store.undoFailed()) {
        // The Undo button is about to be replaced by the alert card: keep focus inside the toast
        afterNextRender(() => this.trashLink()?.nativeElement.focus(), { injector: this.injector });
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected dismiss() {
    this.store.dismissUndo();
    this.hovered.set(false);
    this.focused.set(false);
    this.focusMain();
  }

  protected onEscape() {
    if (this.store.undo()) this.dismiss();
  }

  /**
   * Focus goes to something focusable in the campaign content, else to the content container itself (tabindex -1),
   * never to a removed button (which would drop it on BODY). After a restore the editor renders a moment later: wait for its title field.
   */
  private focusMain(waitForEditor = false, attempt = 0) {
    setTimeout(() => {
      const main = document.querySelector<HTMLElement>('[data-campaign-main]');
      const target = main?.querySelector<HTMLElement>('input[aria-label="Page title"], textarea[aria-label="Page title"], h1[tabindex]');
      if (!target && waitForEditor && attempt < 20) return this.focusMain(true, attempt + 1);
      (target ?? main?.querySelector<HTMLElement>('input, textarea, h1[tabindex]') ?? main)?.focus();
    }, waitForEditor ? 50 : 0);
  }
}
