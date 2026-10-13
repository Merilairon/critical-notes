import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { PAGE_TYPE_LABELS, type TemplateImportReportDto, type TemplateKindDto, type TemplateSummaryDto } from '@cn/shared';
import { errorMessage } from '../core/http.interceptor';
import { TemplateApi } from './template-api';

const SCOPE_LABELS = { campaign: 'This campaign', user: 'My templates', global: 'Built-in' } as const;

/** The template library: built-in, personal and (inside a campaign) campaign templates. */
@Component({
  selector: 'cn-template-library',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="mx-auto w-full max-w-5xl p-4 sm:p-6">
    <div class="flex flex-wrap items-center gap-2">
      <h1 class="flex-1 font-display text-3xl font-bold">Templates</h1>
      <label class="cursor-pointer rounded-md border border-line px-3 py-1.5 text-sm hover:border-accent">
        Import…
        <input type="file" class="sr-only" accept=".json,application/json" (change)="import($any($event.target))" />
      </label>
      @if (exportIds().length) {
        <a class="rounded-md border border-line px-3 py-1.5 text-sm hover:border-accent" [href]="exportUrl()" download="templates.json">Export {{ campaignId() ? 'campaign + mine' : 'mine' }}</a>
      }
      <button type="button" class="rounded-md border border-line px-3 py-1.5 text-sm hover:border-accent" (click)="create('block')">New block template</button>
      <button type="button" class="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white" (click)="create('page')">New page template</button>
    </div>
    <p class="mt-1 text-sm text-muted">
      Write <code>{{ examples[0] }}</code>, <code>{{ examples[1] }}</code> or <code>{{ examples[2] }}</code> in a template; you fill them in when you use it.
      @if (campaignId()) { New templates are saved for this campaign. }
    </p>
    @if (message()) {<p class="mt-2 text-sm" [class.text-accent]="isError()" role="status">{{ message() }}</p>}

    <div class="mt-4 flex gap-1 border-b border-line text-sm" role="tablist">
      @for (k of kinds; track k.value) {
        <button type="button" role="tab" class="px-3 py-1.5" [class.border-b-2]="kind() === k.value" [class.border-accent]="kind() === k.value" [class.font-semibold]="kind() === k.value" [attr.aria-selected]="kind() === k.value" (click)="kind.set(k.value)">
          {{ k.label }}
        </button>
      }
    </div>

    @for (g of groups(); track g.scope) {
      <h2 class="mt-5 mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{{ g.label }}</h2>
      <ul class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        @for (t of g.items; track t.id) {
          <li>
            <a class="flex h-full gap-2 rounded-xl border border-line bg-panel p-3 hover:border-accent" [routerLink]="link(t.id)">
              <span class="text-2xl">{{ t.icon || (t.kind === 'page' ? '📄' : '🧩') }}</span>
              <span class="min-w-0 flex-1">
                <span class="block truncate font-semibold">{{ t.name }}</span>
                <span class="text-xs text-muted">{{ t.kind === 'page' ? 'Page · ' + pageLabel(t) : 'Blocks' }}{{ t.campaign && !campaignId() ? ' · ' + t.campaign.name : '' }}</span>
                <span class="mt-1 line-clamp-2 block text-xs text-muted">{{ t.description }}</span>
              </span>
            </a>
          </li>
        }
      </ul>
    } @empty {
      <p class="mt-6 text-center text-muted">{{ loaded() ? 'No templates.' : 'Loading…' }}</p>
    }
  </div>`,
})
export class TemplateLibrary {
  /** Set inside a campaign (route param). */
  readonly campaignId = input<string | undefined>(undefined);
  private readonly api = inject(TemplateApi);
  private readonly router = inject(Router);
  protected readonly templates = signal<TemplateSummaryDto[]>([]);
  protected readonly loaded = signal(false);
  protected readonly kind = signal<TemplateKindDto | 'all'>('all');
  protected readonly message = signal('');
  protected readonly isError = signal(false);
  protected readonly examples = ['{{name}}', '{{dc: number = 13}}', '{{foe: reference<monster>}}'];
  protected readonly kinds = [
    { value: 'all' as const, label: 'All' },
    { value: 'page' as const, label: 'Page templates' },
    { value: 'block' as const, label: 'Block templates' },
  ];

  protected readonly groups = computed(() => {
    const k = this.kind();
    const items = this.templates().filter((t) => k === 'all' || t.kind === k);
    return (['campaign', 'user', 'global'] as const)
      .map((scope) => ({ scope, label: SCOPE_LABELS[scope], items: items.filter((t) => t.scope === scope) }))
      .filter((g) => g.items.length);
  });
  protected readonly exportIds = computed(() => this.templates().filter((t) => t.scope !== 'global').map((t) => t.id));
  protected readonly exportUrl = computed(() => this.api.exportUrl(this.exportIds()));

  constructor() {
    effect(() => {
      const campaignId = this.campaignId();
      untracked(() => void this.reload(campaignId));
    });
  }

  private async reload(campaignId = this.campaignId()) {
    this.templates.set(await this.api.list({ campaignId: campaignId ?? null }));
    this.loaded.set(true);
  }

  protected link(id: string) {
    const c = this.campaignId();
    return c ? ['/c', c, 'templates', id] : ['/templates', id];
  }

  protected pageLabel(t: TemplateSummaryDto) {
    return t.pageType ? PAGE_TYPE_LABELS[t.pageType] : '';
  }

  protected create(kind: TemplateKindDto) {
    const c = this.campaignId();
    void this.router.navigate(c ? ['/c', c, 'templates', 'new', kind] : ['/templates', 'new', kind]);
  }

  protected async import(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const doc: unknown = JSON.parse(await file.text());
      const c = this.campaignId();
      const report: TemplateImportReportDto = await this.api.import(doc, c ? 'campaign' : 'user', c ?? null);
      this.isError.set(!report.created.length);
      this.message.set(
        `Imported ${report.created.length} template${report.created.length === 1 ? '' : 's'}${report.skipped.length ? `; skipped: ${report.skipped.join('; ')}` : '.'}`,
      );
      await this.reload();
    } catch (err) {
      this.isError.set(true);
      this.message.set(err instanceof SyntaxError ? 'That file is not JSON.' : errorMessage(err));
    }
  }
}
