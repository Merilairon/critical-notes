import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { HOMEBREW_EDITIONS, type HomebrewEdition, type HomebrewImportReportDto } from '@cn/shared';
import { errorMessage } from '../core/http.interceptor';
import { HomebrewApi } from './homebrew-api';

/** Import 5etools homebrew from files, a folder or a URL, and show what happened. */
@Component({
  selector: 'cn-import-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="grid gap-3 text-sm">
      <label class="flex items-center gap-2">
        <span class="text-muted">Files without an edition are</span>
        <select class="cn-prop-input" [value]="edition()" (change)="edition.set($any($event.target).value)">
          @for (e of editions; track e) {<option [value]="e">{{ e === 'any' ? 'for both editions' : e + ' rules' }}</option>}
        </select>
      </label>
      <div class="flex flex-wrap gap-2">
        <label class="cursor-pointer rounded-md border border-line px-3 py-1.5 hover:border-accent">
          Choose files…
          <input type="file" class="sr-only" accept=".json,application/json" multiple (change)="importFiles($any($event.target))" />
        </label>
        <label class="cursor-pointer rounded-md border border-line px-3 py-1.5 hover:border-accent">
          Choose a folder…
          <input type="file" class="sr-only" webkitdirectory multiple (change)="importFiles($any($event.target))" />
        </label>
      </div>
      <form class="flex gap-2" (submit)="$event.preventDefault(); importUrl(url.value)">
        <input #url type="url" class="cn-prop-input min-w-0 flex-1" placeholder="https://…/homebrew.json" aria-label="Homebrew URL" />
        <button type="submit" class="rounded-md border border-line px-3 py-1.5 hover:border-accent">Import from URL</button>
      </form>
      @if (busy()) {<p class="text-muted" aria-live="polite">Importing…</p>}
      @if (error()) {<p class="text-accent" role="alert">{{ error() }}</p>}
      @if (report(); as r) {
        <div class="rounded-lg border border-line p-3" aria-live="polite">
          <p>
            <strong>{{ r.created }}</strong> created, <strong>{{ r.updated }}</strong> updated, {{ r.unchanged }} unchanged{{ r.skipped.length ? ', ' + r.skipped.length + ' skipped' : '' }}.
          </p>
          @if (r.sources.length) {
            <p class="mt-1 text-muted">Sources: {{ sourceSummary(r) }}</p>
          }
          @if (unsupportedKeys(r).length) {
            <p class="mt-1 text-muted">Kept for export but not usable here: {{ unsupportedKeys(r).join(', ') }}</p>
          }
          @if (r.skipped.length) {
            <details class="mt-2"><summary class="cursor-pointer">Skipped</summary>
              <ul class="mt-1 list-disc pl-5">@for (s of r.skipped; track $index) {<li>{{ s.name }} ({{ s.type }}): {{ s.reason }}</li>}</ul>
            </details>
          }
          @if (r.warnings.length) {
            <details class="mt-2"><summary class="cursor-pointer">Warnings ({{ r.warnings.length }})</summary>
              <ul class="mt-1 list-disc pl-5">@for (w of r.warnings; track $index) {<li>{{ w }}</li>}</ul>
            </details>
          }
        </div>
      }
    </div>`,
})
export class ImportPanel {
  readonly imported = output<HomebrewImportReportDto>();
  private readonly api = inject(HomebrewApi);
  protected readonly editions = HOMEBREW_EDITIONS;
  protected readonly edition = signal<HomebrewEdition>('2014');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly report = signal<HomebrewImportReportDto | null>(null);

  protected async importFiles(input: HTMLInputElement) {
    const files = [...(input.files ?? [])].filter((f) => f.name.toLowerCase().endsWith('.json'));
    input.value = '';
    if (!files.length) {
      this.error.set('No .json files selected.');
      return;
    }
    await this.run(() => this.api.importFiles(files, this.edition()));
  }

  protected async importUrl(url: string) {
    if (url.trim()) await this.run(() => this.api.importUrl(url.trim(), this.edition()));
  }

  private async run(fn: () => Promise<HomebrewImportReportDto>) {
    this.busy.set(true);
    this.error.set('');
    this.report.set(null);
    try {
      const r = await fn();
      this.report.set(r);
      this.imported.emit(r);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected sourceSummary(r: HomebrewImportReportDto) {
    return r.sources.map((s) => `${s.fullName} (${s.created ? 'new' : 'updated'})`).join(', ');
  }
  protected unsupportedKeys(r: HomebrewImportReportDto) {
    return Object.entries(r.unsupported).map(([k, n]) => `${k} (${n})`);
  }
}
