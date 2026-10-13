import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { Router, RouterLink } from '@angular/router';
import type { BlockNode } from '@cn/blocks';
import type { BlockDoc, TemplateDto, TemplateKindDto, TemplateSummaryDto, TemplateUsageDto } from '@cn/shared';
import { coerceValue, pageMetaNodes, parseType, syncVariables, type PageTemplateDef, type TemplateVariable } from '@cn/templates';
import { errorMessage } from '../core/http.interceptor';
import { BlockEditor } from '../editor/block-editor';
import { PageTemplateFields, type PageFields } from './page-template-fields';
import { TemplateApi } from './template-api';
import { VariablesPanel } from './variables-panel';

const EMPTY_PAGE_FIELDS: PageFields = { pageType: 'generic', extendsRef: null, bodyMode: 'append', defaults: {}, facet: {}, properties: [], children: [] };

/** Edit a block or page template: content in the block editor, fields derived from it, page settings. */
@Component({
  selector: 'cn-template-editor',
  imports: [RouterLink, BlockEditor, VariablesPanel, PageTemplateFields],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './template-editor.html',
  host: { '(window:beforeunload)': 'onBeforeUnload($event)' },
})
export class TemplateEditor {
  readonly templateId = input<string | undefined>(undefined);
  /** New templates: the kind from the route. */
  readonly kind = input<string | undefined>(undefined);
  /** Inside a campaign (route param). */
  readonly campaignId = input<string | undefined>(undefined);

  private readonly api = inject(TemplateApi);
  private readonly router = inject(Router);
  private readonly title = inject(Title);
  private readonly editor = viewChild(BlockEditor);

  protected readonly template = signal<TemplateDto | null>(null);
  protected readonly templateKind = signal<TemplateKindDto>('block');
  protected readonly name = signal('New template');
  protected readonly description = signal('');
  protected readonly icon = signal<string | null>(null);
  protected readonly tags = signal<string[]>([]);
  /** Content as last loaded (editor input); edits go to `content`. */
  protected readonly loadedDoc = signal<BlockDoc | null>(null);
  protected readonly content = signal<BlockNode[]>([]);
  protected readonly storedVariables = signal<TemplateVariable[]>([]);
  protected readonly pageFields = signal<PageFields>(EMPTY_PAGE_FIELDS);
  protected readonly pageTemplates = signal<TemplateSummaryDto[]>([]);
  protected readonly usage = signal<TemplateUsageDto[] | null>(null);
  protected readonly dirty = signal(false);
  protected readonly status = signal('');
  protected readonly error = signal('');
  protected readonly loadError = signal('');

  protected readonly syntax = [
    { code: '{{name}}', text: 'text' },
    { code: '{{dc: number = 13}}', text: 'with a type and a default' },
    { code: '{{save: select(Str|Dex)}}', text: 'a choice' },
    { code: '{{dmg: dice}}', text: 'becomes a dice roll' },
    { code: '{{who: pageLink<npc>}}', text: 'a link to a page' },
    { code: '{{foe: reference<monster>}}', text: 'a 5etools reference' },
    { code: '{{rules.race}}', text: '"Race" or "Species" by edition' },
    { code: '\\{{', text: 'a literal {{' },
  ];
  protected readonly field = (text: string) => `{{${text}}}`;
  protected readonly editable = computed(() => this.template()?.canEdit ?? true);
  protected readonly isNew = computed(() => !this.template());
  protected readonly synced = computed(() => {
    const nodes = this.templateKind() === 'page' ? [...this.content(), ...pageMetaNodes(this.pageFields())] : this.content();
    return syncVariables(nodes, this.storedVariables());
  });
  protected readonly linkedCount = computed(() => (this.usage() ?? []).filter((u) => u.mode === 'linked').length);
  protected readonly backLink = computed(() => (this.campaignId() ? ['/c', this.campaignId()!, 'templates'] : ['/templates']));

  constructor() {
    effect(() => {
      const [id, kind] = [this.templateId(), this.kind()];
      untracked(() => void this.load(id, kind));
    });
    effect(() => this.title.setTitle(`${this.name()} — Templates — Critical Notes`));
  }

  private async load(id?: string, kind?: string) {
    this.loadError.set('');
    this.status.set('');
    this.error.set('');
    try {
      this.pageTemplates.set(await this.api.list({ campaignId: this.campaignId() ?? null, kind: 'page' }));
      if (id) {
        const t = await this.api.get(id);
        this.template.set(t);
        this.templateKind.set(t.kind);
        this.name.set(t.name);
        this.description.set(t.description);
        this.icon.set(t.icon);
        this.tags.set(t.tags);
        const def = t.definition as Record<string, unknown>;
        const content = ((t.kind === 'page' ? def['body'] : def['content']) as BlockNode[] | undefined) ?? [];
        this.content.set(content);
        this.loadedDoc.set({ type: 'doc', content } as BlockDoc);
        this.storedVariables.set((def['variables'] as TemplateVariable[] | undefined) ?? []);
        if (t.kind === 'page') {
          const { body: _body, variables: _vars, ...fields } = def as unknown as PageTemplateDef;
          this.pageFields.set({ ...EMPTY_PAGE_FIELDS, ...fields });
        }
        this.usage.set(await this.api.usage(t.id).catch(() => []));
      } else {
        this.template.set(null);
        this.templateKind.set(kind === 'page' ? 'page' : 'block');
        this.name.set(kind === 'page' ? 'New page template' : 'New block template');
        const content: BlockNode[] = [{ type: 'paragraph', content: [{ type: 'text', text: 'Write the template here. Use {{name}} for things to fill in.' }] }];
        this.content.set(content);
        this.loadedDoc.set({ type: 'doc', content } as BlockDoc);
        this.storedVariables.set([]);
        this.pageFields.set(EMPTY_PAGE_FIELDS);
        this.usage.set(null);
      }
      this.dirty.set(false);
    } catch (err) {
      this.loadError.set(errorMessage(err));
    }
  }

  protected onContent(doc: BlockDoc) {
    this.editor()?.markLoaded(doc);
    this.content.set((doc.content as BlockNode[] | undefined) ?? []);
    this.dirty.set(true);
  }

  protected onVariable(v: TemplateVariable) {
    // Defaults are stored typed (a number variable's default is a number)
    if (v.default !== undefined) {
      const typed = coerceValue(parseType(v.type) ?? { kind: 'text' }, v.default).value;
      if (typed !== undefined) v = { ...v, default: typed };
    }
    const others = this.synced().variables.filter((x) => x.name !== v.name);
    this.storedVariables.set([...others, v]);
    this.dirty.set(true);
  }

  protected onPageFields(change: Partial<PageFields>) {
    this.pageFields.set({ ...this.pageFields(), ...change });
    this.dirty.set(true);
  }

  protected touch() {
    this.dirty.set(true);
  }

  private definition(): Record<string, unknown> {
    const variables = this.synced().variables;
    return this.templateKind() === 'page' ? { ...this.pageFields(), body: this.content(), variables } : { content: this.content(), variables };
  }

  protected async save() {
    this.error.set('');
    this.status.set('Saving…');
    const meta = { name: this.name().trim() || 'Untitled template', description: this.description(), icon: this.icon(), tags: this.tags() };
    try {
      const current = this.template();
      if (!current) {
        const c = this.campaignId();
        const created = await this.api.create({ kind: this.templateKind(), scope: c ? 'campaign' : 'user', campaignId: c ?? null, ...meta, definition: this.definition() });
        this.dirty.set(false);
        await this.router.navigate(c ? ['/c', c, 'templates', created.id] : ['/templates', created.id], { replaceUrl: true });
        return;
      }
      if (this.linkedCount() && !confirm(`This template is linked on ${this.linkedCount()} page${this.linkedCount() === 1 ? '' : 's'}. Saving updates those copies. Continue?`)) {
        this.status.set('');
        return;
      }
      const res = await this.api.update(current.id, { version: current.version, ...meta, definition: this.definition() });
      this.template.set(res.template);
      this.storedVariables.set(((res.template.definition['variables'] as TemplateVariable[] | undefined) ?? []));
      this.dirty.set(false);
      this.status.set(res.propagated ? `Saved · ${res.propagated} linked page${res.propagated === 1 ? '' : 's'} updated` : 'Saved');
      this.usage.set(await this.api.usage(current.id).catch(() => []));
    } catch (err) {
      this.status.set('');
      if (err instanceof HttpErrorResponse && err.status === 409) this.error.set('This template was changed elsewhere. Reload it to see the latest version.');
      else {
        const details = err instanceof HttpErrorResponse ? (err.error?.details as string[] | undefined) : undefined;
        this.error.set(Array.isArray(details) ? `${errorMessage(err)}: ${details.join('; ')}` : errorMessage(err));
      }
    }
  }

  protected async duplicate() {
    const t = this.template();
    if (!t) return;
    const c = this.campaignId();
    const copy = await this.api.duplicate(t.id, c ? 'campaign' : 'user', c ?? null);
    await this.router.navigate(c ? ['/c', c, 'templates', copy.id] : ['/templates', copy.id]);
  }

  protected async remove() {
    const t = this.template();
    if (!t || !confirm(`Delete the template "${t.name}"? Pages made from it keep their content.`)) return;
    await this.api.remove(t.id);
    this.dirty.set(false);
    await this.router.navigate(this.backLink());
  }

  protected exportUrl() {
    const t = this.template();
    return t ? this.api.exportUrl([t.id]) : '';
  }

  protected setTags(raw: string) {
    this.tags.set(raw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean));
    this.dirty.set(true);
  }

  protected onBeforeUnload(event: BeforeUnloadEvent) {
    if (this.dirty()) event.preventDefault();
  }

  canLeave(): boolean {
    return !this.dirty() || confirm('You have unsaved changes. Leave anyway?');
  }
}
