import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, input, output, signal, type OnInit } from '@angular/core';
import type { BlockNode } from '@cn/blocks';
import type { InsertMode, TemplateDto, TemplateSummaryDto } from '@cn/shared';
import { errorMessage } from '../core/http.interceptor';
import { TemplateApi } from './template-api';
import { TemplatePicker } from './template-picker';
import { TemplateValuesForm } from './values-form';

const MODES: { mode: InsertMode; label: string; hint: string }[] = [
  { mode: 'fill', label: 'Fill in now', hint: 'Insert the blocks with your values.' },
  { mode: 'fields', label: 'Leave as fields', hint: 'Empty values stay as fields to fill in later.' },
  { mode: 'linked', label: 'Keep linked', hint: 'Updates when the template changes; detach to edit.' },
];

/** Insert a block template into a page: pick, fill in, choose how. */
@Component({
  selector: 'cn-template-insert',
  imports: [TemplatePicker, TemplateValuesForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'closed.emit()' },
  template: `<div class="fixed inset-0 z-60 flex items-start justify-center bg-black/40 p-3 pt-[8vh]" (click)="closed.emit()">
    <div class="w-full max-w-2xl rounded-xl border border-line bg-panel p-4 shadow-2xl" role="dialog" aria-modal="true" aria-label="Insert template" (click)="$event.stopPropagation()">
      @if (template(); as t) {
        <div class="mb-3 flex items-center gap-2">
          <button type="button" class="text-sm text-muted hover:text-accent" (click)="template.set(null)">← Templates</button>
          <h2 class="flex-1 truncate font-semibold">{{ t.icon }} {{ t.name }}</h2>
        </div>
        <cn-template-values [variables]="t.resolvedVariables" [values]="values()" (changed)="values.set($event)" />
        <fieldset class="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <legend class="mb-1 text-xs text-muted">How</legend>
          @for (m of modes; track m.mode) {
            <label class="flex items-center gap-1" [title]="m.hint"><input type="radio" name="mode" [checked]="mode() === m.mode" (change)="mode.set(m.mode)" /> {{ m.label }}</label>
          }
        </fieldset>
        @if (error()) {<p class="mt-2 text-sm text-accent" role="alert">{{ error() }}</p>}
        <div class="mt-4 flex justify-end gap-2">
          <button type="button" class="rounded-md border border-line px-3 py-1.5 text-sm text-muted" (click)="closed.emit()">Cancel</button>
          <button type="button" class="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white" [disabled]="busy()" (click)="insert(t)">Insert</button>
        </div>
      } @else {
        <h2 class="mb-2 font-semibold">Insert a template</h2>
        <cn-template-picker [templates]="templates()" (picked)="pick($event)" />
      }
    </div>
  </div>`,
})
export class TemplateInsert implements OnInit {
  readonly campaignId = input.required<string>();
  readonly inserted = output<BlockNode[]>();
  readonly closed = output<void>();
  private readonly api = inject(TemplateApi);
  protected readonly modes = MODES;
  protected readonly templates = signal<TemplateSummaryDto[]>([]);
  protected readonly template = signal<TemplateDto | null>(null);
  protected readonly values = signal<Record<string, unknown>>({});
  protected readonly mode = signal<InsertMode>('fill');
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  ngOnInit() {
    void this.api.list({ campaignId: this.campaignId(), kind: 'block' }).then((t) => this.templates.set(t));
  }

  protected async pick(t: TemplateSummaryDto) {
    this.values.set({});
    this.error.set('');
    this.template.set(await this.api.get(t.id));
  }

  protected async insert(t: TemplateDto) {
    this.busy.set(true);
    this.error.set('');
    try {
      this.inserted.emit(await this.api.instantiate(this.campaignId(), t.id, this.values(), this.mode()));
    } catch (err) {
      this.error.set(issuesMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}

/** Value problems from the server, as one readable line. */
export function issuesMessage(err: unknown): string {
  const issues = err instanceof HttpErrorResponse ? (err.error?.details?.issues as { variable: string; message: string }[] | undefined) : undefined;
  return issues?.length ? issues.map((i) => `${i.variable}: ${i.message}`).join(' · ') : errorMessage(err);
}
