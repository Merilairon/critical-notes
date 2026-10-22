import { afterNextRender, ChangeDetectionStrategy, Component, DestroyRef, effect, ElementRef, inject, Injector, input, untracked, viewChild } from '@angular/core';
import { A11yModule } from '@angular/cdk/a11y';
import { ConfirmService, type ConfirmRequest } from '../core/confirm.service';
import { inertOutside } from '../core/inert';

let nextId = 0;

/**
 * The one confirmation dialog (`role="alertdialog"`): modal, labelled and described, focus trapped with
 * Cancel focused first, Esc cancels, the page behind is inert and focus returns to the opener.
 * Rendered by the shell while `ConfirmService.request()` is set.
 */
@Component({
  selector: 'cn-confirm-dialog',
  imports: [A11yModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="fixed inset-0 z-60 flex items-start justify-center overflow-y-auto bg-black/40 p-3 sm:pt-[8vh]">
    <div
      cdkTrapFocus
      role="alertdialog"
      aria-modal="true"
      [attr.aria-labelledby]="uid + '-title'"
      [attr.aria-describedby]="uid + '-desc'"
      class="w-full max-w-md rounded-xl border border-line bg-panel p-4 shadow-2xl"
    >
      <h2 [id]="uid + '-title'" class="font-display text-xl font-bold">{{ request().title }}</h2>
      <p [id]="uid + '-desc'" class="mt-2 text-sm whitespace-pre-line">{{ request().message }}</p>
      <div class="mt-4 flex flex-wrap justify-end gap-2 text-sm">
        <button #cancel type="button" class="rounded-md border border-line px-3 py-1.5 touch:min-h-[44px]" (click)="close(false)">{{ request().cancelLabel ?? 'Cancel' }}</button>
        <button type="button" class="rounded-md bg-accent px-3 py-1.5 font-semibold text-accent-ink touch:min-h-[44px]" (click)="close(true)">{{ request().confirmLabel ?? 'Confirm' }}</button>
      </div>
    </div>
  </div>`,
})
export class ConfirmDialog {
  readonly request = input.required<ConfirmRequest>();
  private readonly service = inject(ConfirmService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly cancel = viewChild.required<ElementRef<HTMLButtonElement>>('cancel');
  protected readonly uid = `confirm-${nextId++}`;
  private restore: (() => void) | undefined;

  constructor() {
    const injector = inject(Injector);
    afterNextRender(() => (this.restore = inertOutside(this.host.nativeElement)));
    // Cancel first, also when another question replaces this one in the same dialog
    effect(() => {
      this.request();
      untracked(() => afterNextRender(() => this.cancel().nativeElement.focus(), { injector }));
    });
    // Esc in the capture phase: it closes this dialog only, never the drawer, preview or dialog underneath
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.close(false);
    };
    document.addEventListener('keydown', onKey, true);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('keydown', onKey, true);
      this.release();
    });
  }

  protected close(confirmed: boolean) {
    // Un-inert first (focus() does nothing inside an inert page), then return focus; the caller may move it on afterwards.
    this.release();
    const opener = this.request().opener;
    if (opener?.isConnected) opener.focus();
    this.service.settle(confirmed);
  }

  private release() {
    this.restore?.();
    this.restore = undefined;
  }
}
