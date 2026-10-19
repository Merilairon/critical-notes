import { afterNextRender, afterRenderEffect, DestroyRef, Directive, ElementRef, inject, input } from '@angular/core';

/** A page title is one line of text: line breaks (typed or pasted) become spaces. */
export function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

/**
 * Makes a `<textarea>` grow with its text so a long title wraps instead of being cut off, while staying
 * single-line in meaning (no line breaks). Re-measures when the text changes, when the box width changes
 * (rotation, window size) and once the web fonts are loaded.
 */
@Directive({
  selector: 'textarea[cnAutosizeTitle]',
  host: {
    '(input)': 'onInput()',
    '(keydown.enter)': '$event.preventDefault()',
  },
})
export class AutosizeTitle {
  /** The current text; a change re-measures the box (value replaced from the server). */
  readonly cnAutosizeTitle = input('');
  private readonly el = inject<ElementRef<HTMLTextAreaElement>>(ElementRef).nativeElement;
  private observer: ResizeObserver | undefined;

  constructor() {
    afterRenderEffect(() => {
      this.cnAutosizeTitle();
      this.resize();
    });
    afterNextRender(() => {
      if (typeof ResizeObserver !== 'undefined') {
        this.observer = new ResizeObserver(() => this.resize());
        this.observer.observe(this.el);
      }
      void document.fonts?.ready.then(() => this.resize());
    });
    inject(DestroyRef).onDestroy(() => this.observer?.disconnect());
  }

  protected onInput() {
    const clean = singleLine(this.el.value);
    if (clean !== this.el.value) this.el.value = clean;
    this.resize();
  }

  private resize() {
    this.el.style.height = 'auto';
    this.el.style.height = `${this.el.scrollHeight}px`;
  }
}
