import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { HOMEBREW_EDITIONS, type CreateHomebrewSourceInput, type HomebrewEdition, type HomebrewSourceDto } from '@cn/shared';

const EDITION_LABELS: Record<HomebrewEdition, string> = { '2014': '2014 rules', '2024': '2024 rules', any: 'Both editions' };

/** Create or edit a homebrew source's metadata. */
@Component({
  selector: 'cn-source-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<form class="grid gap-3 text-sm sm:grid-cols-2" (submit)="$event.preventDefault(); submit(form)" #form>
    <label class="flex flex-col gap-1 sm:col-span-2">
      <span class="text-xs text-muted">Full name</span>
      <input name="fullName" class="cn-prop-input" required maxlength="120" [value]="source()?.fullName ?? ''" placeholder="Tales from the Misty Vale" />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted">Abbreviation</span>
      <input name="abbreviation" class="cn-prop-input" required maxlength="20" [value]="source()?.abbreviation ?? ''" placeholder="TMV" />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted">Rules edition</span>
      <select name="edition" class="cn-prop-input">
        @for (e of editions; track e) {<option [value]="e" [selected]="e === (source()?.edition ?? '2024')">{{ editionLabels[e] }}</option>}
      </select>
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted">Authors (comma separated)</span>
      <input name="authors" class="cn-prop-input" [value]="source()?.authors?.join(', ') ?? ''" />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted">Version</span>
      <input name="version" class="cn-prop-input" [value]="source()?.version ?? '1.0.0'" maxlength="20" />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted">Link (optional)</span>
      <input name="url" type="url" class="cn-prop-input" [value]="source()?.url ?? ''" placeholder="https://…" />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted">Color (optional, hex)</span>
      <input name="color" class="cn-prop-input" [value]="source()?.color ?? ''" placeholder="7a3cbf" maxlength="6" />
    </label>
    @if (!source()) {
      <label class="flex flex-col gap-1 sm:col-span-2">
        <span class="text-xs text-muted">Source id (optional)</span>
        <input name="jsonId" class="cn-prop-input font-mono" maxlength="50" placeholder="Derived from the name, e.g. TalesfromtheMistyVale" />
        <span class="text-xs text-muted">Used in tags like {{ '{@creature Name|SourceId}' }}. At least 6 letters or digits; cannot be changed later.</span>
      </label>
    }
    @if (allowInstance()) {
      <label class="flex items-center gap-2 sm:col-span-2">
        <input name="instance" type="checkbox" [checked]="source()?.scope === 'instance'" />
        Instance-wide: every campaign on this server can use it
      </label>
    }
    <div class="flex items-center gap-2 sm:col-span-2">
      <button type="submit" class="rounded-md bg-accent px-4 py-1.5 font-semibold text-accent-ink">{{ source() ? 'Save' : 'Create source' }}</button>
      @if (cancellable()) {<button type="button" class="rounded-md border border-line px-3 py-1.5 text-muted" (click)="cancelled.emit()">Cancel</button>}
      @if (error()) {<span class="text-accent" role="alert">{{ error() }}</span>}
    </div>
  </form>`,
})
export class SourceForm {
  readonly source = input<HomebrewSourceDto | null>(null);
  readonly allowInstance = input(false);
  readonly cancellable = input(true);
  readonly error = input('');
  readonly saved = output<CreateHomebrewSourceInput>();
  readonly cancelled = output<void>();
  protected readonly editions = HOMEBREW_EDITIONS;
  protected readonly editionLabels = EDITION_LABELS;
  protected readonly busy = signal(false);

  protected submit(form: HTMLFormElement) {
    const f = new FormData(form);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    this.saved.emit({
      fullName: text('fullName'),
      abbreviation: text('abbreviation'),
      edition: text('edition') as HomebrewEdition,
      authors: text('authors').split(',').map((a) => a.trim()).filter(Boolean),
      version: text('version') || '1.0.0',
      url: text('url') || null,
      color: text('color').replace(/^#/, '') || null,
      ...(text('jsonId') ? { jsonId: text('jsonId') } : {}),
      ...(this.allowInstance() ? { scope: f.get('instance') ? 'instance' : 'private' } : {}),
    });
  }
}
