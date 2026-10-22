import { Injectable, signal } from '@angular/core';

export interface ConfirmOptions {
  /** Short question, the dialog's heading and accessible name. */
  title: string;
  /** The longer sentence, the accessible description. */
  message: string;
  /** Text of the confirming button; name the action ("Delete", "Leave"), not "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface ConfirmRequest extends ConfirmOptions {
  /** Where focus goes back to when the dialog closes. */
  opener: HTMLElement | null;
  resolve: (confirmed: boolean) => void;
}

/**
 * The app's own replacement for `window.confirm()`: `await confirm.ask({...})` is true when the person
 * chose the confirming button, false for Cancel, Esc or when another question replaces this one. The
 * dialog itself is `cn-confirm-dialog`, rendered once by the shell.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly request = signal<ConfirmRequest | null>(null);

  ask(options: ConfirmOptions): Promise<boolean> {
    // A question that replaces a pending one inherits its opener: the focus is now on the old dialog's button
    const pending = this.request();
    pending?.resolve(false);
    const active = document.activeElement;
    return new Promise<boolean>((resolve) => {
      const opener = pending ? pending.opener : active instanceof HTMLElement && active !== document.body ? active : null;
      this.request.set({ ...options, opener, resolve });
    });
  }

  /** Called by the dialog. */
  settle(confirmed: boolean) {
    const r = this.request();
    if (!r) return;
    this.request.set(null);
    r.resolve(confirmed);
  }
}
