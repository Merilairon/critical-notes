import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CampaignStore } from '../campaign.store';
import { LiveService, TOAST_MS, toastAction, toastText } from './live.service';

const ACTION_LABEL = { open: 'Open', show: 'Show', reload: 'Reload', view: 'View' } as const;

/**
 * The player's "something arrived" toast and the "Live updates paused" notice. Lives in the bottom notice lane
 * (inside the Undo toast's host, so the two never overlap). The live region is always in the DOM; a toast never steals
 * focus, shows the title as plain text only, pauses on hover and focus, and Esc dismisses it.
 */
@Component({
  selector: 'cn-live-toast',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `<div role="status" aria-live="polite" aria-atomic="true">
      @if (live.toast(); as t) {
        <div class="mb-2 rounded-lg border border-line bg-panel px-4 py-3 text-sm shadow-xl" (mouseenter)="hovered.set(true)" (mouseleave)="hovered.set(false)" (focusin)="focused.set(true)" (focusout)="focused.set(false)" (keydown.escape)="$event.stopPropagation(); live.dismissToast()">
          <div class="flex flex-wrap items-center gap-3">
            <span class="min-w-0 break-words font-semibold">{{ text() }}</span>
            <span class="ml-auto flex items-center gap-1 max-sm:w-full">
              <button type="button" class="min-h-[44px] rounded-md bg-accent px-3 py-1.5 font-semibold text-accent-ink max-sm:flex-1" [attr.aria-expanded]="action() === 'view' ? live.viewOpen() : null" (click)="live.act()">{{ label() }}</button>
              <button type="button" class="min-h-[44px] min-w-[44px] rounded px-2 py-1 text-muted hover:text-ink" aria-label="Dismiss" (click)="live.dismissToast()">✕</button>
            </span>
          </div>
          @if (t.reload) {
            <p class="mt-2 text-muted">The DM changed this page. If your unsaved text can't be saved it stays here until you copy it.</p>
            @if (action() === 'view') {
              <button type="button" class="mt-1 min-h-[44px] rounded-md border border-line px-3 py-1.5 font-semibold" (click)="live.reloadOpen()">Reload</button>
            }
          }
          @if (live.viewOpen()) {
            <ul class="mt-2 flex flex-col border-t border-line pt-2">
              @for (item of t.items; track item.pageId) {
                <li><a class="cn-link flex min-h-[44px] items-center [overflow-wrap:anywhere]" [routerLink]="['/c', store.id(), 'p', item.pageId]" (click)="live.dismissToast()">{{ item.title || 'Untitled' }}</a></li>
              }
            </ul>
          }
        </div>
      }
    </div>
    <div role="status" aria-live="polite">
      @if (live.paused()) {
        <div class="mb-2 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel px-4 py-3 text-sm shadow-xl">
          <span class="min-w-0">Live updates paused in this tab</span>
          <button type="button" class="ml-auto min-h-[44px] rounded-md bg-accent px-3 py-1.5 font-semibold text-accent-ink max-sm:w-full" (click)="live.resume()">Resume</button>
        </div>
      }
    </div>`,
})
export class LiveToast {
  protected readonly live = inject(LiveService);
  protected readonly store = inject(CampaignStore);
  protected readonly hovered = signal(false);
  protected readonly focused = signal(false);
  /** Only changes when a different card replaces the shown one (equal ids do not notify). */
  private readonly cardId = computed(() => this.live.toast()?.id ?? null);
  protected readonly text = computed(() => {
    const t = this.live.toast();
    return t ? toastText(t) : '';
  });
  protected readonly action = computed(() => {
    const t = this.live.toast();
    return t ? toastAction(t) : 'open';
  });
  protected readonly label = computed(() => ACTION_LABEL[this.action()]);

  constructor() {
    // A new card starts with a clean slate (a replaced card must not leave the next timer paused); a merge keeps the card, so a hovered toast stays paused
    effect(() => {
      void this.cardId();
      untracked(() => {
        this.hovered.set(false);
        this.focused.set(false);
      });
    });
    // Visible for TOAST_MS from its last change; hover or focus pauses it. An open list stays until dismissed.
    effect((onCleanup) => {
      const t = this.live.toast();
      if (!t || this.hovered() || this.focused() || this.live.viewOpen()) return;
      const timer = setTimeout(() => untracked(() => this.live.dismissToast()), TOAST_MS);
      onCleanup(() => clearTimeout(timer));
    });
  }
}
