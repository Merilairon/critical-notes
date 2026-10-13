/** Pages: read as Markdown, create, edit, move, delete and restore; custom properties. */
import type { BlockDocument } from '@cn/blocks';
import { docToMarkdown, markdownToDoc } from '@cn/blocks/markdown';
import { PAGE_TYPES, PROPERTY_TYPES, type PageDto, type PageType, type PropertyDefDto } from '@cn/shared';
import { z } from 'zod';
import { ApiError, path } from '../api';
import { PageDirectory } from '../pages';
import { ToolError, type Tools } from '../tools';
import { campaignId } from './campaign';

const pageId = z.string().min(1).max(64).describe('Page id');
const visibility = z.enum(['dm', 'all', 'selected']).describe('dm: only game masters; all: everyone; selected: game masters and the viewers listed');
const details = z.record(z.string(), z.unknown()).describe("The page type's details (see get_campaign pageTypes); merged into the current ones. Page links take an id or exact title.");
const properties = z.record(z.string(), z.unknown()).describe('Custom property values by key (see get_campaign properties); null clears one');
const tags = z.array(z.string().min(1).max(48)).max(30);
const viewers = z.array(z.string().max(64)).max(100).describe('userIds of players who may see a "selected" page');

/** A page as the model sees it: its fields, and its text as Markdown (separately). */
function present(page: PageDto, dir: PageDirectory) {
  return {
    data: {
      id: page.id,
      title: page.title,
      type: page.type,
      parentId: page.parentId,
      parent: page.parentId ? dir.title(page.parentId) : null,
      visibility: page.visibility,
      ...(page.visibility === 'selected' ? { viewers: page.viewers } : {}),
      tags: page.tags,
      details: page.facet ?? {},
      properties: page.props,
      revision: page.revision,
      children: dir.pages.filter((p) => p.parentId === page.id).map((p) => ({ id: p.id, title: p.title, type: p.type })),
    },
    markdown: docToMarkdown(page.body as BlockDocument | null, { pageRef: dir.ref, pageTitle: dir.title }),
  };
}

/** Markdown → a document for this page, merged with the version it was made from. */
function toDoc(markdown: string, dir: PageDirectory, base: BlockDocument | null, warnings: string[]) {
  const out = markdownToDoc(markdown, { base, resolvePage: dir.resolve });
  warnings.push(...out.warnings);
  return out.doc;
}

/** Applies find/replace edits to the Markdown; each `find` must occur exactly once. */
function applyEdits(markdown: string, edits: { find: string; replace: string }[]): string {
  return edits.reduce((md, { find, replace }) => {
    const at = md.indexOf(find);
    if (at < 0) throw new ToolError(`"${find.slice(0, 60)}" is not in the page's text (get_page shows the current text)`);
    if (md.indexOf(find, at + 1) >= 0) throw new ToolError(`"${find.slice(0, 60)}" occurs more than once; include more of the surrounding text`);
    return md.slice(0, at) + replace + md.slice(at + find.length);
  }, markdown);
}

export function pageTools(t: Tools) {
  const getPage = (cid: string, id: string) => t.api.get<PageDto>(path`/api/campaigns/${cid}/pages/${id}`);

  t.read(
    'get_page',
    'Read a page',
    'A page: title, type, visibility, tags, details, properties, subpages and revision, followed by its text as Markdown.',
    z.object({ campaignId, pageId }),
    async ({ campaignId: cid, pageId: id }) => {
      const [page, dir] = await Promise.all([getPage(cid, id), PageDirectory.load(t.api, cid)]);
      return present(page, dir);
    },
  );

  t.write(
    'create_page',
    'Create a page',
    'Creates a page (NPC, location, session, quest, faction, player character, item, lore, handout or plain page). It is visible to game masters only unless you set visibility. With templateId, the page is made from that page template (list_templates) and its variables are filled from templateValues.',
    z.object({
      campaignId,
      title: z.string().min(1).max(200),
      type: z.enum(PAGE_TYPES).default('generic'),
      parent: z.string().max(200).optional().describe('Parent page: id or exact title (default: top level)'),
      visibility: visibility.optional(),
      viewers: viewers.optional(),
      tags: tags.optional(),
      details: details.optional(),
      properties: properties.optional(),
      markdown: z.string().max(200_000).optional().describe('The text (Markdown, see the server instructions)'),
      templateId: z.string().max(64).optional().describe('A page template to start from'),
      templateValues: z.record(z.string(), z.unknown()).optional().describe("Values for the template's variables"),
    }),
    async (a) => {
      const dir = await PageDirectory.load(t.api, a.campaignId);
      const warnings: string[] = [];
      const parentId = a.parent ? dir.idFor(a.parent, undefined, 'the parent') : null;
      const body = a.markdown !== undefined ? toDoc(a.markdown, dir, null, warnings) : undefined;
      const facet = a.details ? dir.resolveDetails(a.type, a.details) : undefined;
      let page: PageDto;
      if (a.templateId) {
        page = await t.api.post<PageDto>(path`/api/campaigns/${a.campaignId}/pages/from-template`, {
          templateId: a.templateId,
          title: a.title,
          parentId,
          values: a.templateValues ?? {},
          mode: 'fill',
        });
        // The template's text first, then the given text
        const extra = { ...(body ? { body: { ...page.body, content: [...((page.body as BlockDocument | null)?.content ?? []), ...(body.content ?? [])] } } : {}) };
        const patch = { ...extra, ...(facet ? { facet } : {}), ...(a.properties ? { props: a.properties } : {}), ...(a.tags ? { tags: a.tags } : {}), ...(a.visibility ? { visibility: a.visibility } : {}), ...(a.viewers ? { viewers: a.viewers } : {}) };
        if (Object.keys(patch).length) page = await t.api.patch<PageDto>(path`/api/campaigns/${a.campaignId}/pages/${page.id}`, { revision: page.revision, ...patch });
      } else {
        page = await t.api.post<PageDto>(
          path`/api/campaigns/${a.campaignId}/pages`,
          { type: a.type, title: a.title, parentId, visibility: a.visibility ?? 'dm', tags: a.tags ?? [], ...(facet ? { facet } : {}), ...(a.properties ? { props: a.properties } : {}), ...(body ? { body } : {}) },
          { template: 0 },
        );
        if (a.viewers) page = await t.api.patch<PageDto>(path`/api/campaigns/${a.campaignId}/pages/${page.id}`, { revision: page.revision, viewers: a.viewers });
      }
      return { data: { id: page.id, title: page.title, type: page.type, visibility: page.visibility, revision: page.revision, ...(warnings.length ? { warnings } : {}) } };
    },
  );

  t.write(
    'update_page',
    'Edit a page',
    'Changes a page. Text: "markdown" replaces all of it (needs the revision from get_page); "edits" replaces exact snippets; "appendMarkdown" adds to the end. Moving: "parent" (id, exact title, or "" for the top level) and "after" (a sibling to follow). Only the fields you give change.',
    z.object({
      campaignId,
      pageId,
      revision: z.number().int().min(1).optional().describe('The revision your text is based on (required with markdown)'),
      title: z.string().min(1).max(200).optional(),
      type: z.enum(PAGE_TYPES).optional().describe('Change the page type (its details start over)'),
      visibility: visibility.optional(),
      viewers: viewers.optional(),
      tags: tags.optional().describe('Replaces the tags'),
      details: details.optional(),
      properties: properties.optional(),
      markdown: z.string().max(200_000).optional(),
      edits: z.array(z.object({ find: z.string().min(1).max(20_000), replace: z.string().max(50_000) })).max(50).optional(),
      appendMarkdown: z.string().max(100_000).optional(),
      parent: z.string().max(200).optional().describe('Move under this page (id or exact title); "" moves it to the top level'),
      after: z.string().max(200).optional().describe('Place it after this sibling (id or exact title)'),
    }),
    async (a) => {
      if (a.markdown !== undefined && a.revision === undefined) throw new ToolError('Give the revision from get_page with "markdown", so changes made since are not overwritten');
      if ([a.markdown !== undefined, !!a.edits?.length, a.appendMarkdown !== undefined].filter(Boolean).length > 1) throw new ToolError('Use only one of markdown, edits and appendMarkdown');
      const dir = await PageDirectory.load(t.api, a.campaignId);
      const warnings: string[] = [];
      const save = async (current: PageDto) => {
        const base = current.body as BlockDocument | null;
        let body: BlockDocument | undefined;
        if (a.markdown !== undefined) body = toDoc(a.markdown, dir, base, warnings);
        else if (a.edits?.length) body = toDoc(applyEdits(docToMarkdown(base, { pageRef: dir.ref, pageTitle: dir.title }), a.edits), dir, base, warnings);
        else if (a.appendMarkdown !== undefined) body = { ...(base ?? { type: 'doc' }), content: [...(base?.content ?? []), ...(toDoc(a.appendMarkdown, dir, null, warnings).content ?? [])] };
        const type = (a.type ?? current.type) as PageType;
        const patch = {
          revision: a.revision ?? current.revision,
          ...(a.title !== undefined ? { title: a.title } : {}),
          ...(a.type !== undefined ? { type: a.type } : {}),
          ...(a.visibility !== undefined ? { visibility: a.visibility } : {}),
          ...(a.viewers !== undefined ? { viewers: a.viewers } : {}),
          ...(a.tags !== undefined ? { tags: a.tags } : {}),
          ...(a.details !== undefined ? { facet: dir.resolveDetails(type, a.details) } : {}),
          ...(a.properties !== undefined ? { props: a.properties } : {}),
          ...(body ? { body } : {}),
        };
        return Object.keys(patch).length > 1 ? t.api.patch<PageDto>(path`/api/campaigns/${a.campaignId}/pages/${a.pageId}`, patch) : current;
      };
      let current = await getPage(a.campaignId, a.pageId);
      if (a.revision !== undefined && a.revision !== current.revision) throw new ToolError(`The page changed since revision ${a.revision} (it is at ${current.revision}); read it again with get_page`);
      let page: PageDto;
      try {
        page = await save(current);
      } catch (err) {
        // Someone saved in between: edits and appends are re-applied once to the newer version
        if (!(err instanceof ApiError && err.status === 409) || a.revision !== undefined) throw err;
        warnings.length = 0;
        current = await getPage(a.campaignId, a.pageId);
        page = await save(current);
      }
      if (a.parent !== undefined || a.after !== undefined) {
        const parentId = a.parent === undefined ? page.parentId : a.parent === '' ? null : dir.idFor(a.parent, undefined, 'the parent');
        const afterId = a.after ? dir.idFor(a.after, undefined, '"after"') : null;
        await t.api.post(path`/api/campaigns/${a.campaignId}/pages/${a.pageId}/move`, { parentId, afterId });
      }
      return { data: { id: page.id, title: page.title, revision: page.revision, ...(warnings.length ? { warnings } : {}) } };
    },
  );

  t.write(
    'delete_page',
    'Delete a page',
    'Deletes a page and all its subpages. restore_page brings them back.',
    z.object({ campaignId, pageId }),
    async ({ campaignId: cid, pageId: id }) => {
      const { deleted } = await t.api.delete<{ deleted: string[] }>(path`/api/campaigns/${cid}/pages/${id}`);
      return { data: { deleted, restoreWith: `restore_page with pageId ${id}` } };
    },
    { destructive: true },
  );

  t.write(
    'restore_page',
    'Restore a deleted page',
    'Brings back a deleted page and the subpages deleted with it.',
    z.object({ campaignId, pageId }),
    async ({ campaignId: cid, pageId: id }) => ({ data: await t.api.post(path`/api/campaigns/${cid}/pages/${id}/restore`) }),
    { idempotent: true },
  );

  t.write(
    'save_property',
    'Create or change a custom property',
    'Defines a custom property for pages of a campaign (by label), or changes the one with this key.',
    z.object({
      campaignId,
      key: z.string().max(60).optional().describe('An existing property to change'),
      label: z.string().min(1).max(60),
      type: z.enum(PROPERTY_TYPES).optional().describe('For a new property (default text); cannot change later'),
      options: z.array(z.string().min(1).max(60)).max(50).optional().describe('Choices for select and multiselect'),
      appliesTo: z.array(z.enum(PAGE_TYPES)).max(10).nullable().optional().describe('Page types it shows on (null: all)'),
      dmOnly: z.boolean().optional().describe('Hidden from players'),
    }),
    async (a) => {
      if (a.key) {
        const { properties } = await t.api.get<{ properties: PropertyDefDto[] }>(path`/api/campaigns/${a.campaignId}/properties`);
        const def = properties.find((p) => p.key === a.key);
        if (!def) throw new ToolError(`No property "${a.key}"`);
        const updated = await t.api.patch<PropertyDefDto>(path`/api/campaigns/${a.campaignId}/properties/${def.id}`, {
          label: a.label,
          ...(a.options ? { options: a.options } : {}),
          ...(a.appliesTo !== undefined ? { appliesTo: a.appliesTo } : {}),
          ...(a.dmOnly !== undefined ? { dmOnly: a.dmOnly } : {}),
        });
        return { data: updated };
      }
      const created = await t.api.post<PropertyDefDto>(path`/api/campaigns/${a.campaignId}/properties`, {
        label: a.label,
        type: a.type ?? 'text',
        options: a.options ?? null,
        appliesTo: a.appliesTo ?? null,
        dmOnly: a.dmOnly ?? false,
      });
      return { data: created };
    },
  );

  t.write(
    'delete_property',
    'Delete a custom property',
    'Deletes a custom property and its value on every page.',
    z.object({ campaignId, key: z.string().min(1).max(60) }),
    async ({ campaignId: cid, key }) => {
      const { properties } = await t.api.get<{ properties: PropertyDefDto[] }>(path`/api/campaigns/${cid}/properties`);
      const def = properties.find((p) => p.key === key);
      if (!def) throw new ToolError(`No property "${key}"`);
      await t.api.delete(path`/api/campaigns/${cid}/properties/${def.id}`);
      return { data: { deleted: key } };
    },
    { destructive: true },
  );
}
