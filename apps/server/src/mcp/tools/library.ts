/** Homebrew (5etools JSON, validated like in the editor) and templates (content as Markdown). */
import type { BlockDocument, BlockNode } from '@cn/blocks';
import { docToMarkdown, markdownToDoc } from '@cn/blocks/markdown';
import {
  HOMEBREW_EDITIONS,
  PAGE_TYPES,
  TEMPLATE_KINDS,
  type HomebrewEntityDto,
  type HomebrewEntitySummaryDto,
  type HomebrewSourceDto,
  type HomebrewValidationDto,
  type TemplateDto,
  type TemplateSummaryDto,
} from '@cn/shared';
import { z } from 'zod';
import { path } from '../api';
import { ToolError, type Tools } from '../tools';

const sourceId = z.string().min(1).max(64).describe('Homebrew source id (from list_homebrew)');
const entryId = z.string().min(1).max(64).describe('Homebrew entry id');
const data = z.record(z.string(), z.unknown()).describe('The entry in 5etools JSON (as in 5etools homebrew files); "source" is filled in. A variant of an existing entry can use _copy.');
const templateId = z.string().min(1).max(64).describe('Template id (from list_templates)');
const variable = z.object({
  name: z.string().min(1).max(60),
  type: z.string().max(80).describe('text, number, boolean, date, dice, pageLink, select(a|b), reference<monster>'),
  label: z.string().max(120).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  required: z.boolean().optional(),
});

const entrySummary = (e: HomebrewEntitySummaryDto) => ({ id: e.id, type: e.entityType, name: e.name, uid: e.uid, revision: e.currentRevision, ...(e.copyOf ? { variantOf: e.copyOf } : {}), ...(e.deleted ? { deleted: true } : {}) });
const sourceSummary = (s: HomebrewSourceDto) => ({
  id: s.id,
  name: s.fullName,
  abbreviation: s.abbreviation,
  jsonId: s.jsonId,
  edition: s.edition,
  scope: s.scope,
  ...(s.campaign ? { campaign: s.campaign.name } : {}),
  sharedWith: s.sharedWith.map((c) => c.name),
  entries: s.entityCount,
  canEdit: s.canEdit,
});
const saved = (r: { entity: HomebrewEntityDto; validation: HomebrewValidationDto }) => ({
  data: { ...entrySummary(r.entity), ...(r.validation.warnings.length ? { warnings: r.validation.warnings.map((w) => `${w.path || 'entry'}: ${w.message}`) } : {}) },
});

/** A template's blocks: a block template's content, a page template's body. */
const blocksOf = (t: TemplateDto): BlockNode[] => ((t.kind === 'block' ? t.definition['content'] : t.definition['body']) as BlockNode[] | undefined) ?? [];

export function libraryTools(t: Tools) {
  // region Homebrew

  t.read(
    'list_homebrew',
    'List homebrew',
    'Your homebrew sources (and those shared with your campaigns). With sourceId: that source and its entries.',
    z.object({ sourceId: sourceId.optional(), includeDeleted: z.boolean().optional() }),
    async ({ sourceId: id, includeDeleted }) => {
      if (!id) {
        const { sources } = await t.api.get<{ sources: HomebrewSourceDto[] }>('/api/homebrew/sources');
        return { data: sources.map(sourceSummary) };
      }
      const [source, { entities }] = await Promise.all([
        t.api.get<HomebrewSourceDto>(path`/api/homebrew/sources/${id}`),
        t.api.get<{ entities: HomebrewEntitySummaryDto[] }>(path`/api/homebrew/sources/${id}/entities`, { deleted: includeDeleted ? 1 : undefined }),
      ]);
      return { data: { ...sourceSummary(source), entries: entities.map(entrySummary) } };
    },
  );

  t.read('get_homebrew_entry', 'Read a homebrew entry', 'A homebrew entry as 5etools JSON, with its revision.', z.object({ entryId }), async ({ entryId: id }) => {
    const e = await t.api.get<HomebrewEntityDto>(path`/api/homebrew/entities/${id}`);
    return { data: { ...entrySummary(e), source: e.source.fullName, sourceId: e.sourceId, data: e.data, ...(e.fluff ? { fluff: e.fluff } : {}) } };
  });

  t.write(
    'save_homebrew_source',
    'Create or change a homebrew source',
    'A homebrew source is a book of your own (name, abbreviation, edition). Without sourceId a new one is made. shareWith makes it available in those campaigns (replacing the current list).',
    z.object({
      sourceId: sourceId.optional(),
      fullName: z.string().min(1).max(120).optional(),
      abbreviation: z.string().min(1).max(20).optional(),
      edition: z.enum(HOMEBREW_EDITIONS).optional().describe('Which rules it is for ("any": both)'),
      authors: z.array(z.string().min(1).max(80)).max(20).optional(),
      version: z.string().min(1).max(20).optional(),
      url: z.string().max(500).nullable().optional(),
      shareWith: z.array(z.string().max(64)).max(50).optional().describe('Campaign ids'),
    }),
    async (a) => {
      const fields = Object.fromEntries(Object.entries({ fullName: a.fullName, abbreviation: a.abbreviation, edition: a.edition, authors: a.authors, version: a.version, url: a.url }).filter(([, v]) => v !== undefined));
      let source: HomebrewSourceDto;
      if (a.sourceId) source = await t.api.patch<HomebrewSourceDto>(path`/api/homebrew/sources/${a.sourceId}`, fields);
      else {
        if (!a.fullName || !a.abbreviation || !a.edition) throw new ToolError('A new source needs fullName, abbreviation and edition');
        source = await t.api.post<HomebrewSourceDto>('/api/homebrew/sources', fields);
      }
      if (a.shareWith) source = await t.api.put<HomebrewSourceDto>(path`/api/homebrew/sources/${source.id}/shares`, { campaignIds: a.shareWith });
      return { data: sourceSummary(source) };
    },
  );

  t.write(
    'create_homebrew_entry',
    'Create a homebrew entry',
    'Adds an entry to a homebrew source: a monster, spell, item, baseitem, feat, race, subrace, background, condition, variantrule, table… in 5etools JSON. It is checked like in the editor: errors are refused, warnings are returned.',
    z.object({
      sourceId,
      type: z.string().min(2).max(40).describe('The 5etools type, e.g. monster, spell, item'),
      data,
      fluff: z.record(z.string(), z.unknown()).nullable().optional().describe('Lore and images (5etools fluff)'),
      force: z.boolean().optional().describe('Save despite 5etools schema errors (app errors still block)'),
    }),
    async (a) => saved(await t.api.post(path`/api/homebrew/sources/${a.sourceId}/entities`, { entityType: a.type, data: a.data, fluff: a.fluff ?? null, force: !!a.force })),
  );

  t.write(
    'update_homebrew_entry',
    'Change a homebrew entry',
    'Replaces a homebrew entry with new 5etools JSON. Needs the revision from get_homebrew_entry; each save is kept as a revision.',
    z.object({
      entryId,
      revision: z.number().int().min(1),
      data,
      fluff: z.record(z.string(), z.unknown()).nullable().optional(),
      force: z.boolean().optional(),
      message: z.string().max(200).optional().describe('What changed'),
    }),
    async (a) => {
      const current = await t.api.get<HomebrewEntityDto>(path`/api/homebrew/entities/${a.entryId}`);
      return saved(
        await t.api.put(path`/api/homebrew/entities/${a.entryId}`, {
          entityType: current.entityType,
          data: a.data,
          fluff: a.fluff === undefined ? current.fluff : a.fluff,
          revision: a.revision,
          force: !!a.force,
          ...(a.message ? { message: a.message } : {}),
        }),
      );
    },
  );

  t.write(
    'delete_homebrew_entry',
    'Delete a homebrew entry',
    'Deletes a homebrew entry (references to it keep working, marked deleted). restore_homebrew_entry brings it back.',
    z.object({ entryId }),
    async ({ entryId: id }) => {
      await t.api.delete(path`/api/homebrew/entities/${id}`);
      return { data: { deleted: id } };
    },
    { destructive: true },
  );

  t.write('restore_homebrew_entry', 'Restore a homebrew entry', 'Brings back a deleted homebrew entry.', z.object({ entryId }), async ({ entryId: id }) => ({
    data: entrySummary(await t.api.post<HomebrewEntityDto>(path`/api/homebrew/entities/${id}/restore`)),
  }));

  // endregion

  // region Templates

  t.read(
    'list_templates',
    'List templates',
    'Block and page templates you can use: built-in, your own, and a campaign\'s. Page templates make new pages (create_page with templateId).',
    z.object({ campaignId: z.string().max(64).optional(), kind: z.enum(TEMPLATE_KINDS).optional() }),
    async ({ campaignId, kind }) => {
      const { templates } = await t.api.get<{ templates: TemplateSummaryDto[] }>('/api/templates', { campaignId, kind });
      return {
        data: templates.map((x) => ({ id: x.id, kind: x.kind, scope: x.scope, name: x.name, description: x.description, ...(x.pageType ? { pageType: x.pageType } : {}), ...(x.campaign ? { campaign: x.campaign.name } : {}), version: x.version, canEdit: x.canEdit })),
      };
    },
  );

  t.read(
    'get_template',
    'Read a template',
    'A template: its variables, version and (for page templates) page type and defaults, followed by its content as Markdown. {{name: type}} placeholders become the variables.',
    z.object({ templateId }),
    async ({ templateId: id }) => {
      const tpl = await t.api.get<TemplateDto>(path`/api/templates/${id}`);
      const def = tpl.definition;
      return {
        data: {
          id: tpl.id,
          kind: tpl.kind,
          scope: tpl.scope,
          name: tpl.name,
          description: tpl.description,
          tags: tpl.tags,
          version: tpl.version,
          canEdit: tpl.canEdit,
          variables: tpl.resolvedVariables,
          ...(tpl.kind === 'page' ? { pageType: def['pageType'], defaults: def['defaults'], properties: def['properties'], subpages: ((def['children'] as unknown[]) ?? []).length, extends: def['extendsRef'] ?? null } : {}),
          ...(tpl.issues.length ? { issues: tpl.issues } : {}),
        },
        markdown: docToMarkdown({ type: 'doc', content: blocksOf(tpl) }, { mode: 'template' }),
      };
    },
  );

  t.write(
    'save_template',
    'Create or change a template',
    'Without templateId a new template is made (kind and scope needed); with it, that template changes (needs its version; linked copies on pages follow). The content is Markdown with {{name}} or {{name: type = default}} placeholders. Built-in templates are read-only.',
    z.object({
      templateId: templateId.optional(),
      version: z.number().int().min(1).optional().describe('The version you read (to change a template)'),
      kind: z.enum(TEMPLATE_KINDS).optional().describe('block: a snippet to insert; page: a whole page'),
      scope: z.enum(['user', 'campaign']).optional().describe('user: yours everywhere; campaign: one campaign (its owner)'),
      campaignId: z.string().max(64).optional(),
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(500).optional(),
      icon: z.string().max(16).nullable().optional(),
      tags: z.array(z.string().min(1).max(40)).max(20).optional(),
      markdown: z.string().max(200_000).optional(),
      variables: z.array(variable).max(60).optional().describe('Labels, defaults and required flags for the placeholders'),
      pageType: z.enum(PAGE_TYPES).optional().describe('Page templates: the type of page made'),
      defaults: z
        .object({ title: z.string().max(200).optional(), visibility: z.enum(['dm', 'all', 'selected']).optional(), tags: z.array(z.string()).max(30).optional() })
        .optional()
        .describe('Page templates: defaults for the new page'),
    }),
    async (a) => {
      const warnings: string[] = [];
      const content = (base: BlockNode[]): BlockNode[] | undefined => {
        if (a.markdown === undefined) return undefined;
        const out = markdownToDoc(a.markdown, { mode: 'template', base: { type: 'doc', content: base } as BlockDocument });
        warnings.push(...out.warnings);
        return out.doc.content ?? [];
      };
      const meta = Object.fromEntries(Object.entries({ name: a.name, description: a.description, icon: a.icon, tags: a.tags }).filter(([, v]) => v !== undefined));
      let result: TemplateDto;
      if (!a.templateId) {
        if (!a.kind || !a.scope || !a.name) throw new ToolError('A new template needs kind, scope and name');
        const blocks = content([]) ?? [];
        const definition =
          a.kind === 'block'
            ? { content: blocks, variables: a.variables ?? [] }
            : { pageType: a.pageType ?? 'generic', bodyMode: 'append', defaults: a.defaults ?? {}, facet: {}, properties: [], variables: a.variables ?? [], body: blocks, children: [] };
        result = await t.api.post<TemplateDto>('/api/templates', { kind: a.kind, scope: a.scope, campaignId: a.campaignId ?? null, ...meta, definition });
      } else {
        if (!a.version) throw new ToolError('Give the version from get_template, so changes made since are not overwritten');
        const current = await t.api.get<TemplateDto>(path`/api/templates/${a.templateId}`);
        const blocks = content(blocksOf(current));
        const definition = {
          ...current.definition,
          ...(blocks ? { [current.kind === 'block' ? 'content' : 'body']: blocks } : {}),
          ...(a.variables ? { variables: a.variables } : {}),
          ...(current.kind === 'page' && a.pageType ? { pageType: a.pageType } : {}),
          ...(current.kind === 'page' && a.defaults ? { defaults: a.defaults } : {}),
        };
        const res = await t.api.put<{ template: TemplateDto; propagated: number }>(path`/api/templates/${a.templateId}`, { version: a.version, ...meta, definition });
        result = res.template;
        if (res.propagated) warnings.push(`${res.propagated} linked cop${res.propagated === 1 ? 'y' : 'ies'} on pages updated`);
      }
      return { data: { id: result.id, kind: result.kind, name: result.name, version: result.version, variables: result.resolvedVariables, ...(result.issues.length ? { issues: result.issues } : {}), ...(warnings.length ? { warnings } : {}) } };
    },
  );

  t.write(
    'delete_template',
    'Delete a template',
    'Deletes one of your templates (pages made from it keep their content).',
    z.object({ templateId }),
    async ({ templateId: id }) => {
      await t.api.delete(path`/api/templates/${id}`);
      return { data: { deleted: id } };
    },
    { destructive: true },
  );

  // endregion
}
