import { ChangeDetectionStrategy, Component, inject, input, output, signal, type OnInit } from '@angular/core';
import type { PageDto, TemplateDto, TemplateSummaryDto } from '@cn/shared';
import { TemplateApi } from './template-api';
import { issuesMessage } from './template-insert';
import { TemplatePicker } from './template-picker';
import { TemplateValuesForm } from './values-form';

/** Create a page from a page template, or apply one to an existing page. */
@Component({
  selector: 'cn-page-template-dialog',
  imports: [TemplatePicker, TemplateValuesForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'closed.emit()' },
  template: `<div class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-3 pt-[8vh]" (click)="closed.emit()">
    <div class="w-full max-w-2xl rounded-xl border border-line bg-panel p-4 shadow-2xl" role="dialog" aria-modal="true" [attr.aria-label]="pageId() ? 'Apply template' : 'New page from template'" (click)="$event.stopPropagation()">
      @if (template(); as t) {
        <div class="mb-3 flex items-center gap-2">
          <button type="button" class="text-sm text-muted hover:text-accent" (click)="template.set(null)">← Templates</button>
          <h2 class="flex-1 truncate font-semibold">{{ t.icon }} {{ t.name }}</h2>
        </div>
        @if (!pageId()) {
          <label class="mb-3 flex flex-col gap-1 text-sm">
            <span class="text-xs text-muted">Title</span>
            <input class="cn-prop-input" [value]="title()" placeholder="Leave empty to use the template's title" (input)="title.set($any($event.target).value)" aria-label="Page title" />
          </label>
        } @else {
          <p class="mb-3 text-sm text-muted">Adds the template's blocks at the end of the page and its missing properties. Nothing on the page is changed.</p>
        }
        <cn-template-values [variables]="t.resolvedVariables" [values]="values()" (changed)="values.set($event)" />
        <div class="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <label class="flex items-center gap-1"><input type="checkbox" [checked]="mode() === 'fields'" (change)="mode.set($any($event.target).checked ? 'fields' : 'fill')" /> Keep empty values as fields</label>
          @if (!pageId() && childCount(t)) {
            <label class="flex items-center gap-1"><input type="checkbox" [checked]="withChildren()" (change)="withChildren.set($any($event.target).checked)" /> Also create {{ childCount(t) }} subpage{{ childCount(t) === 1 ? '' : 's' }}</label>
          }
        </div>
        @if (error()) {<p class="mt-2 text-sm text-accent" role="alert">{{ error() }}</p>}
        <div class="mt-4 flex justify-end gap-2">
          <button type="button" class="rounded-md border border-line px-3 py-1.5 text-sm text-muted" (click)="closed.emit()">Cancel</button>
          <button type="button" class="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white" [disabled]="busy()" (click)="submit(t)">{{ pageId() ? 'Apply' : 'Create page' }}</button>
        </div>
      } @else {
        <h2 class="mb-2 font-semibold">{{ pageId() ? 'Apply a page template' : 'New page from a template' }}</h2>
        <cn-template-picker [templates]="templates()" (picked)="pick($event)" />
      }
    </div>
  </div>`,
})
export class PageTemplateDialog implements OnInit {
  readonly campaignId = input.required<string>();
  /** Set to apply to this page instead of creating one. */
  readonly pageId = input<string | null>(null);
  readonly parentId = input<string | null>(null);
  readonly done = output<PageDto>();
  readonly closed = output<void>();
  private readonly api = inject(TemplateApi);
  protected readonly templates = signal<TemplateSummaryDto[]>([]);
  protected readonly template = signal<TemplateDto | null>(null);
  protected readonly values = signal<Record<string, unknown>>({});
  protected readonly title = signal('');
  protected readonly mode = signal<'fill' | 'fields'>('fields');
  protected readonly withChildren = signal(true);
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  ngOnInit() {
    void this.api.list({ campaignId: this.campaignId(), kind: 'page' }).then((t) => this.templates.set(t));
  }

  protected childCount(t: TemplateDto) {
    return ((t.definition['children'] as unknown[] | undefined) ?? []).length;
  }

  protected async pick(t: TemplateSummaryDto) {
    this.values.set({});
    this.error.set('');
    this.template.set(await this.api.get(t.id));
  }

  protected async submit(t: TemplateDto) {
    this.busy.set(true);
    this.error.set('');
    try {
      const pageId = this.pageId();
      const page = pageId
        ? await this.api.apply(this.campaignId(), pageId, t.id, this.values(), this.mode())
        : await this.api.createPage(this.campaignId(), {
            templateId: t.id,
            title: this.title().trim() || undefined,
            parentId: this.parentId(),
            values: this.values(),
            mode: this.mode(),
            withChildren: this.withChildren(),
          });
      this.done.emit(page);
    } catch (err) {
      this.error.set(issuesMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
