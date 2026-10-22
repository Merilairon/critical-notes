import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

/** A small JSON value editor: parsed on blur, errors shown inline, the last valid value kept. */
@Component({
  selector: 'cn-json-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<textarea
      class="block w-full rounded-md border bg-bg px-2 py-1 font-mono text-xs"
      [class.border-control]="!error()"
      [class.border-accent]="!!error()"
      [rows]="rows()"
      [value]="text()"
      [placeholder]="placeholder()"
      [attr.aria-label]="label()"
      [attr.aria-invalid]="!!error()"
      spellcheck="false"
      (blur)="commit($any($event.target).value)"
    ></textarea>
    @if (error()) {<p class="mt-0.5 text-xs text-accent" role="alert">{{ error() }}</p>}`,
})
export class JsonField {
  readonly value = input<unknown>(undefined);
  readonly label = input('JSON');
  readonly placeholder = input('');
  readonly changed = output<unknown>();
  protected readonly error = signal('');
  protected readonly text = computed(() => (this.value() === undefined ? '' : JSON.stringify(this.value(), null, 1).replace(/\n\s*/g, ' ')));
  protected readonly rows = computed(() => Math.min(8, Math.max(1, Math.ceil(this.text().length / 70))));

  protected commit(raw: string) {
    if (!raw.trim()) {
      this.error.set('');
      if (this.value() !== undefined) this.changed.emit(undefined);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      this.error.set('');
      if (JSON.stringify(parsed) !== JSON.stringify(this.value())) this.changed.emit(parsed);
    } catch (e) {
      this.error.set(`Not valid JSON: ${(e as Error).message}`);
    }
  }
}
