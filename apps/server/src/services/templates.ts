/**
 * Block and page templates: the library (global built-ins, user and campaign templates), versioning with
 * propagation to linked instances, block instantiation, pages from page templates (with `extends`, properties,
 * facet defaults and child pages), applying a template to an existing page, and per-type campaign defaults.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { BlockNode } from '@cn/blocks';
import { getRuleset, isObject, type RulesetId } from '@cn/fivetools';
import {
  blockTemplateDefSchema,
  pageTemplateDefSchema,
  type CreatePageFromTemplateInput,
  type CreateTemplateInput,
  type InsertMode,
  type PageDto,
  type PageType,
  type PropertyType,
  type TemplateDto,
  type TemplateImportReportDto,
  type TemplateKindDto,
  type TemplateScope,
  type TemplateSummaryDto,
  type TemplateTrashItemDto,
  type TemplateUsageDto,
  type UpdateTemplateInput,
} from '@cn/shared';
import {
  BUILTIN_TEMPLATES,
  coerceValues,
  collectVariables,
  exportTemplates,
  instantiate,
  instantiateValue,
  pageMetaNodes,
  readTemplateExport,
  renderLinked,
  resolvePageTemplate,
  syncVariables,
  TemplateError,
  TEMPLATE_SCHEMA_VERSION,
  type BlockTemplateDef,
  type ExportedTemplate,
  type InstantiateOptions,
  type PageTemplateDef,
  type TemplateVariable,
} from '@cn/templates';
import type { AppDb } from '../db';
import { campaignMembers, campaigns, campaignTemplateDefaults, pages, templateUsage, templateVersions, templates, users } from '../db/schema';
import { badRequest, conflict, forbidden, notFound } from '../lib/http';
import { newId } from '../lib/ids';
import type { ReferenceService } from '../reference/service';
import type { CampaignService } from './campaigns';
import type { PageService } from './pages';
import type { PropertyService } from './properties';
import { contextFor, type WriteContext, type WriteOrigin } from './revisions';

type Row = typeof templates.$inferSelect;
type Def = BlockTemplateDef | PageTemplateDef;

const MAX_CHILD_DEPTH = 3;
const MAX_PAGES_PER_INSTANTIATION = 60;

export class TemplateService {
  constructor(
    private readonly db: AppDb,
    private readonly pages: PageService,
    private readonly properties: PropertyService,
    private readonly campaigns: CampaignService,
    private readonly reference: ReferenceService,
  ) {}

  // region Access

  private dmCampaignIds(userId: string): string[] {
    return this.db
      .select({ id: campaignMembers.campaignId })
      .from(campaignMembers)
      .where(and(eq(campaignMembers.userId, userId), inArray(campaignMembers.role, ['dm', 'codm'])))
      .all()
      .map((r) => r.id);
  }

  private canEdit(t: Row, userId: string): boolean {
    if (t.scope === 'global') return false;
    if (t.scope === 'user') return t.ownerUserId === userId;
    return !!t.campaignId && this.dmCampaignIds(userId).includes(t.campaignId);
  }

  private canView(t: Row, userId: string): boolean {
    return t.scope === 'global' || this.canEdit(t, userId);
  }

  private row(id: string): Row {
    const t = this.db.select().from(templates).where(and(eq(templates.id, id), isNull(templates.deletedAt))).get();
    if (!t) throw notFound('Template not found');
    return t;
  }

  private visibleRow(userId: string, id: string): Row {
    const t = this.row(id);
    if (!this.canView(t, userId)) throw notFound('Template not found');
    return t;
  }

  private editableRow(userId: string, id: string): Row {
    const t = this.visibleRow(userId, id);
    if (t.scope === 'global') throw forbidden('Built-in templates are read-only. Duplicate one to change it.');
    if (!this.canEdit(t, userId)) throw forbidden('You cannot edit this template');
    return t;
  }

  /** A template by id or `builtin:<key>`, if the user may use it (and, inside a campaign, it fits that campaign). */
  private lookup(userId: string, ref: string, campaignId?: string | null): Row | null {
    const t = ref.startsWith('builtin:')
      ? this.db.select().from(templates).where(and(eq(templates.builtinKey, ref.slice(8)), isNull(templates.deletedAt))).get()
      : this.db.select().from(templates).where(and(eq(templates.id, ref), isNull(templates.deletedAt))).get();
    if (!t || !this.canView(t, userId)) return null;
    if (t.scope === 'campaign' && campaignId && t.campaignId !== campaignId) return null;
    return t;
  }

  // endregion

  // region DTOs

  private summary(t: Row, userId: string): TemplateSummaryDto {
    const def = t.definition as Record<string, unknown>;
    const campaign = t.campaignId ? (this.db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(eq(campaigns.id, t.campaignId)).get() ?? null) : null;
    const owner = t.ownerUserId ? this.db.select({ n: users.displayName }).from(users).where(eq(users.id, t.ownerUserId)).get() : undefined;
    return {
      id: t.id,
      kind: t.kind as TemplateKindDto,
      scope: t.scope as TemplateScope,
      builtinKey: t.builtinKey,
      name: t.name,
      description: t.description,
      icon: t.icon,
      tags: (t.tags as string[]) ?? [],
      version: t.version,
      pageType: t.kind === 'page' ? ((def['pageType'] as PageType) ?? null) : null,
      campaign,
      ownerName: owner?.n ?? null,
      canEdit: this.canEdit(t, userId),
      updatedAt: t.updatedAt,
    };
  }

  private dto(t: Row, userId: string): TemplateDto {
    let resolvedVariables: TemplateVariable[] = [];
    const issues: string[] = [];
    if (t.kind === 'page') {
      try {
        resolvedVariables = this.resolvePage(userId, t.id, t.campaignId).def.variables;
      } catch (e) {
        issues.push((e as Error).message);
      }
      issues.push(...collectVariables([...(t.definition as PageTemplateDef).body, ...pageMetaNodes(t.definition as PageTemplateDef)]).issues);
    } else {
      resolvedVariables = (t.definition as BlockTemplateDef).variables;
      issues.push(...collectVariables((t.definition as BlockTemplateDef).content).issues);
    }
    return { ...this.summary(t, userId), definition: t.definition as Record<string, unknown>, resolvedVariables, issues };
  }

  // endregion

  // region Library

  /** Templates a user can use: built-ins, their own, and those of the campaigns they run (or of one campaign). */
  list(userId: string, opts: { campaignId?: string | null; kind?: TemplateKindDto } = {}): TemplateSummaryDto[] {
    const campaignIds = opts.campaignId ? [opts.campaignId].filter((c) => this.dmCampaignIds(userId).includes(c)) : this.dmCampaignIds(userId);
    const rows = this.db
      .select()
      .from(templates)
      .where(
        and(
          isNull(templates.deletedAt),
          opts.kind ? eq(templates.kind, opts.kind) : undefined,
          or(
            eq(templates.scope, 'global'),
            and(eq(templates.scope, 'user'), eq(templates.ownerUserId, userId)),
            campaignIds.length ? and(eq(templates.scope, 'campaign'), inArray(templates.campaignId, campaignIds)) : sql`0`,
          ),
        ),
      )
      .all();
    const order: Record<string, number> = { campaign: 0, user: 1, global: 2 };
    return rows.map((r) => this.summary(r, userId)).sort((a, b) => order[a.scope]! - order[b.scope]! || a.name.localeCompare(b.name));
  }

  get(userId: string, id: string): TemplateDto {
    return this.dto(this.visibleRow(userId, id), userId);
  }

  /** Validates a definition and syncs its variables with its content. */
  private normalize(userId: string, kind: TemplateKindDto, raw: Record<string, unknown>, opts: { selfId?: string; campaignId?: string | null }): Def {
    if (kind === 'block') {
      const parsed = blockTemplateDefSchema.safeParse(raw);
      if (!parsed.success) throw badRequest('Invalid block template', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
      const content = parsed.data.content as unknown as BlockNode[];
      return { content, variables: syncVariables(content, parsed.data.variables as TemplateVariable[]).variables };
    }
    const parsed = pageTemplateDefSchema.safeParse(raw);
    if (!parsed.success) throw badRequest('Invalid page template', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    const def = parsed.data as unknown as PageTemplateDef;
    if (def.extendsRef) {
      const parent = this.lookup(userId, def.extendsRef, opts.campaignId);
      if (!parent || parent.kind !== 'page') throw badRequest('The template to extend was not found');
      if (opts.selfId && (parent.id === opts.selfId || this.chainIds(userId, parent.id, opts.campaignId).includes(opts.selfId))) {
        throw badRequest('A template cannot extend itself, directly or through others');
      }
    }
    return { ...def, variables: syncVariables([...def.body, ...pageMetaNodes(def)], def.variables).variables };
  }

  private chainIds(userId: string, ref: string, campaignId?: string | null): string[] {
    try {
      return this.resolvePage(userId, ref, campaignId).chain;
    } catch {
      return [];
    }
  }

  create(userId: string, input: CreateTemplateInput & { scope: 'user' | 'campaign'; kind: TemplateKindDto }): TemplateDto {
    if (input.scope === 'campaign') {
      if (!input.campaignId) throw badRequest('Campaign templates need a campaign');
      this.campaigns.requireDm(input.campaignId, userId);
    }
    const definition = this.normalize(userId, input.kind, input.definition, { campaignId: input.campaignId });
    const id = newId();
    this.db.transaction((tx) => {
      tx.insert(templates)
        .values({
          id,
          kind: input.kind,
          scope: input.scope,
          ownerUserId: userId,
          campaignId: input.scope === 'campaign' ? input.campaignId : null,
          name: input.name ?? 'Untitled template',
          description: input.description ?? '',
          icon: input.icon ?? null,
          tags: input.tags ?? [],
          definition,
          schemaVersion: TEMPLATE_SCHEMA_VERSION,
        })
        .run();
      tx.insert(templateVersions).values({ templateId: id, version: 1, definition }).run();
    });
    return this.get(userId, id);
  }

  /** Saves a new version. Linked instances of block templates are re-rendered with it. */
  update(userId: string, id: string, input: UpdateTemplateInput, origin: WriteOrigin): { template: TemplateDto; propagated: number } {
    const t = this.editableRow(userId, id);
    if (input.version !== t.version) throw conflict('This template was changed elsewhere. Reload it before saving.', { version: t.version });
    const definition = input.definition ? this.normalize(userId, t.kind as TemplateKindDto, input.definition, { selfId: t.id, campaignId: t.campaignId }) : (t.definition as Def);
    const version = t.version + 1;
    this.db.transaction((tx) => {
      tx.update(templates)
        .set({
          version,
          definition,
          updatedAt: Date.now(),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
        })
        .where(eq(templates.id, id))
        .run();
      tx.insert(templateVersions).values({ templateId: id, version, definition }).run();
    });
    const propagated = t.kind === 'block' ? this.propagate(id, definition as BlockTemplateDef, version, contextFor(userId, origin, 'template_sync')) : 0;
    return { template: this.get(userId, id), propagated };
  }

  /** Soft delete. Linked instances keep their content and stop following the template. */
  remove(userId: string, id: string) {
    const t = this.editableRow(userId, id);
    this.db.transaction((tx) => {
      tx.update(templates).set({ deletedAt: Date.now() }).where(eq(templates.id, t.id)).run();
      tx.delete(campaignTemplateDefaults).where(eq(campaignTemplateDefaults.templateId, t.id)).run();
    });
  }

  /**
   * Deleted templates the user could edit (their own, and those of campaigns they run as DM or co-DM), newest first.
   * Built-ins and other people's templates never appear. Definitions are not returned.
   */
  listDeleted(userId: string, opts: { campaignId?: string | null } = {}): TemplateTrashItemDto[] {
    const campaignIds = opts.campaignId ? [opts.campaignId].filter((c) => this.dmCampaignIds(userId).includes(c)) : this.dmCampaignIds(userId);
    const rows = this.db
      .select()
      .from(templates)
      .where(
        and(
          isNotNull(templates.deletedAt),
          or(
            opts.campaignId ? sql`0` : and(eq(templates.scope, 'user'), eq(templates.ownerUserId, userId)),
            campaignIds.length ? and(eq(templates.scope, 'campaign'), inArray(templates.campaignId, campaignIds)) : sql`0`,
          ),
        ),
      )
      .orderBy(desc(templates.deletedAt))
      .all();
    return rows.map((r) => ({ ...this.summary(r, userId), deletedAt: r.deletedAt! }));
  }

  /**
   * Brings a deleted template back with its versions. Linked instances (their usage rows were kept) follow it again
   * from the next version. The campaign default it may have been is not restored.
   */
  restore(userId: string, id: string): TemplateDto {
    const t = this.db.select().from(templates).where(eq(templates.id, id)).get();
    // Same visibility as editing: anything else is a plain 404, so ids do not leak.
    if (!t || !t.deletedAt || !this.canEdit(t, userId)) throw notFound('Template not found');
    if (t.kind === 'page') {
      const ref = (t.definition as PageTemplateDef).extendsRef;
      if (ref) {
        const parent = ref.startsWith('builtin:')
          ? this.db.select().from(templates).where(eq(templates.builtinKey, ref.slice(8))).get()
          : this.db.select().from(templates).where(eq(templates.id, ref)).get();
        if (parent?.deletedAt) throw conflict(`This template extends "${parent.name}", which is in the trash. Restore that one first.`, { templateId: parent.id });
      }
    }
    this.db.update(templates).set({ deletedAt: null }).where(eq(templates.id, t.id)).run();
    return this.get(userId, t.id);
  }

  /** Scope and campaign of a deleted template the user could edit (for the audit line), or null. */
  trashed(userId: string, id: string): { scope: string; campaignId: string | null } | null {
    const t = this.db.select().from(templates).where(eq(templates.id, id)).get();
    return t && t.deletedAt !== null && this.canEdit(t, userId) ? { scope: t.scope, campaignId: t.campaignId } : null;
  }

  /**
   * Permanently deletes a template that is in the trash and that the user could edit (same visibility as restore: anything else,
   * built-ins included, is a plain 404). A live template is refused with 400. Returns the purged ids.
   */
  purge(userId: string, id: string): string[] {
    const t = this.db.select().from(templates).where(eq(templates.id, id)).get();
    if (!t || !this.canEdit(t, userId)) throw notFound('Template not found');
    if (t.deletedAt === null) throw badRequest('Only a deleted template can be purged');
    return this.purgeIds([t.id]);
  }

  /** The newest `updatedAt` or `deletedAt` of any template (ms; 0 when none): part of the purger's clock sanity check. */
  newestActivity(): number {
    const r = this.db.select({ u: sql<number>`max(${templates.updatedAt})`, d: sql<number>`max(${templates.deletedAt})` }).from(templates).get();
    return Math.max(r?.u ?? 0, r?.d ?? 0);
  }

  /** Permanently deletes every template deleted before `cutoff` (ms), in all scopes. Returns how many. */
  purgeExpired(cutoff: number): number {
    const ids = this.db.select({ id: templates.id }).from(templates).where(and(isNotNull(templates.deletedAt), lt(templates.deletedAt, cutoff), isNull(templates.builtinKey))).all().map((r) => r.id);
    return this.purgeIds(ids, cutoff).length;
  }

  /**
   * Hard delete, only ever of deleted, non built-in templates. Versions and campaign defaults cascade by foreign key, but
   * `template_usage.template_id` has none, so usage rows go explicitly (and the versions and defaults too, so this does not rely
   * on cascades being enabled). Pages created from the template keep their content and lose the link (`from_template_id`);
   * linked instances keep their content (the usage rows are gone, so they no longer follow anything). A child template that
   * extends a purged one is left alone: it resolves its parent like it does for a trashed one and reports an issue.
   */
  private purgeIds(candidates: string[], cutoff?: number): string[] {
    const purged: string[] = [];
    for (let i = 0; i < candidates.length; i += 500) {
      const chunk = candidates.slice(i, i + 500);
      this.db.transaction((tx) => {
        // The guard (deleted, not built-in, and past the cutoff when given) is applied first, and every delete below only
        // touches the ids that passed it.
        const ids = tx
          .select({ id: templates.id })
          .from(templates)
          .where(and(inArray(templates.id, chunk), isNotNull(templates.deletedAt), isNull(templates.builtinKey), cutoff === undefined ? undefined : lt(templates.deletedAt, cutoff)))
          .all()
          .map((r) => r.id);
        if (!ids.length) return;
        tx.delete(templateUsage).where(inArray(templateUsage.templateId, ids)).run();
        tx.update(pages).set({ fromTemplateId: null, fromTemplateVersion: null }).where(inArray(pages.fromTemplateId, ids)).run();
        tx.delete(campaignTemplateDefaults).where(inArray(campaignTemplateDefaults.templateId, ids)).run();
        tx.delete(templateVersions).where(inArray(templateVersions.templateId, ids)).run();
        tx.delete(templates).where(inArray(templates.id, ids)).run();
        purged.push(...ids);
      });
    }
    return purged;
  }

  duplicate(userId: string, id: string, input: { scope: 'user' | 'campaign'; campaignId: string | null; name?: string }): TemplateDto {
    const t = this.visibleRow(userId, id);
    const created = this.create(userId, {
      kind: t.kind as TemplateKindDto,
      scope: input.scope,
      campaignId: input.campaignId,
      name: input.name ?? `${t.name} (copy)`,
      description: t.description,
      icon: t.icon,
      tags: (t.tags as string[]) ?? [],
      definition: t.definition as Record<string, unknown>,
    });
    this.db.update(templates).set({ duplicatedFromId: t.id }).where(eq(templates.id, created.id)).run();
    return created;
  }

  /** Pages (in campaigns the user runs) using a template: linked instances and pages created from it. */
  usage(userId: string, id: string): TemplateUsageDto[] {
    this.visibleRow(userId, id);
    const dm = this.dmCampaignIds(userId);
    if (!dm.length) return [];
    return this.db
      .select({ pageId: pages.id, pageTitle: pages.title, campaignId: campaigns.id, campaignName: campaigns.name, mode: templateUsage.mode, version: templateUsage.version })
      .from(templateUsage)
      .innerJoin(pages, eq(pages.id, templateUsage.pageId))
      .innerJoin(campaigns, eq(campaigns.id, pages.campaignId))
      .where(and(eq(templateUsage.templateId, id), isNull(pages.deletedAt), inArray(pages.campaignId, dm)))
      .orderBy(campaigns.name, pages.title)
      .all() as TemplateUsageDto[];
  }

  /** Inserts or upgrades the built-in templates (by key and version). */
  upsertBuiltins(): { created: number; updated: number } {
    let created = 0;
    let updated = 0;
    for (const b of BUILTIN_TEMPLATES) {
      const existing = this.db.select().from(templates).where(eq(templates.builtinKey, b.key)).get();
      const values = { name: b.name, description: b.description, icon: b.icon, tags: b.tags, definition: b.definition, version: b.version, deletedAt: null };
      if (!existing) {
        const id = newId();
        this.db.transaction((tx) => {
          tx.insert(templates).values({ id, kind: b.kind, scope: 'global', builtinKey: b.key, ...values }).run();
          tx.insert(templateVersions).values({ templateId: id, version: b.version, definition: b.definition }).run();
        });
        created++;
      } else if (existing.version < b.version) {
        this.db.transaction((tx) => {
          tx.update(templates).set({ ...values, updatedAt: Date.now() }).where(eq(templates.id, existing.id)).run();
          tx.insert(templateVersions).values({ templateId: existing.id, version: b.version, definition: b.definition }).onConflictDoNothing().run();
        });
        if (b.kind === 'block') this.propagate(existing.id, b.definition as BlockTemplateDef, b.version, { userId: null, source: 'system', cause: 'template_sync' });
        updated++;
      }
    }
    return { created, updated };
  }

  // endregion

  // region Instantiation

  private instantiateOptions(campaignId: string): Omit<InstantiateOptions, 'mode' | 'values' | 'variables'> {
    const campaign = this.db.select({ ruleset: campaigns.ruleset }).from(campaigns).where(eq(campaigns.id, campaignId)).get();
    if (!campaign) throw notFound('Campaign not found');
    const ruleset = getRuleset(campaign.ruleset as RulesetId);
    const titles = new Map(
      this.db
        .select({ id: pages.id, title: pages.title })
        .from(pages)
        .where(and(eq(pages.campaignId, campaignId), isNull(pages.deletedAt)))
        .all()
        .map((p) => [p.id, p.title]),
    );
    return {
      terminology: ruleset.terminology as unknown as Record<string, string>,
      canonicalRef: (key) => ruleset.canonicalRef(key),
      describeRef: (uid) => this.reference.describe(uid),
      pageTitle: (id) => titles.get(id) ?? null,
    };
  }

  private typedValues(variables: readonly TemplateVariable[], raw: Record<string, unknown>, requireAll: boolean) {
    const { values, issues } = coerceValues(variables, raw, { requireAll });
    if (issues.length) throw badRequest('Some values are not valid', { issues });
    return values;
  }

  /** Block template content for inserting into a page: filled, as fields, or as a linked instance. */
  instantiateBlock(userId: string, campaignId: string, id: string, input: { values: Record<string, unknown>; mode: InsertMode }): { content: BlockNode[] } {
    this.campaigns.requireDm(campaignId, userId);
    const t = this.lookup(userId, id, campaignId);
    if (!t || t.kind !== 'block') throw notFound('Block template not found');
    const def = t.definition as BlockTemplateDef;
    const values = this.typedValues(def.variables, input.values, input.mode !== 'fields');
    const content = instantiate(def.content, { ...this.instantiateOptions(campaignId), mode: input.mode === 'fields' ? 'fields' : 'fill', values, variables: def.variables });
    if (input.mode !== 'linked') return { content };
    return {
      content: [{ type: 'templateInstance', attrs: { templateId: t.id, version: t.version, values, detached: false }, content: content.length ? content : [{ type: 'paragraph' }] }],
    };
  }

  private resolvePage(userId: string, ref: string, campaignId?: string | null) {
    return (() => {
      try {
        return resolvePageTemplate(ref, (r) => {
          const t = this.lookup(userId, r, campaignId);
          return t && t.kind === 'page' ? { id: t.id, def: t.definition as PageTemplateDef } : null;
        });
      } catch (e) {
        if (e instanceof TemplateError) throw badRequest(e.message);
        throw e;
      }
    })();
  }

  /** Makes sure the template's properties exist in the campaign; returns template key → campaign key. */
  private ensureProperties(campaignId: string, def: PageTemplateDef): Map<string, string> {
    const existing = this.properties.list(campaignId);
    const map = new Map<string, string>();
    for (const p of def.properties) {
      const match = existing.find((e) => e.key === p.key) ?? existing.find((e) => e.label.toLowerCase() === p.label.toLowerCase());
      if (match) {
        map.set(p.key, match.key);
        continue;
      }
      const created = this.properties.create(campaignId, {
        label: p.label,
        type: p.type as PropertyType,
        options: p.options ?? null,
        dmOnly: p.dmOnly ?? false,
        refKind: p.refKind ?? null,
        appliesTo: [def.pageType as PageType],
      });
      existing.push(created);
      map.set(p.key, created.key);
    }
    return map;
  }

  /** Creates a page (and its child pages) from a page template. */
  createPage(userId: string, campaignId: string, input: CreatePageFromTemplateInput, origin: WriteOrigin): PageDto {
    this.campaigns.requireDm(campaignId, userId);
    const counter = { pages: 0 };
    return this.createPageInner(userId, campaignId, {
      templateRef: input.templateId,
      title: input.title,
      parentId: input.parentId ?? null,
      values: input.values ?? {},
      mode: input.mode ?? 'fields',
      withChildren: input.withChildren ?? true,
      depth: 0,
      ancestors: new Set(),
      counter,
      ctx: contextFor(userId, origin, 'create'),
    });
  }

  private createPageInner(
    userId: string,
    campaignId: string,
    a: {
      templateRef: string;
      title?: string;
      parentId: string | null;
      values: Record<string, unknown>;
      mode: 'fill' | 'fields';
      withChildren: boolean;
      depth: number;
      ancestors: Set<string>;
      counter: { pages: number };
      ctx: WriteContext;
    },
  ): PageDto {
    const t = this.lookup(userId, a.templateRef, campaignId);
    if (!t || t.kind !== 'page') throw notFound('Page template not found');
    const { def } = this.resolvePage(userId, t.id, campaignId);
    // Child pages get the values that apply to them; only the top page insists on required ones
    const values = this.typedValues(def.variables, a.values, a.mode === 'fill' && a.depth === 0);
    const opts = { ...this.instantiateOptions(campaignId), mode: a.mode, values, variables: def.variables };
    const fill = { ...opts, mode: 'fill' as const };
    const title = a.title?.trim() || String(instantiateValue(def.defaults.title ?? '', fill)).trim() || t.name;
    const facet = instantiateValue(def.facet, fill) as Record<string, unknown>;
    const body = instantiate(def.body, opts);
    const keyMap = this.ensureProperties(campaignId, def);
    const props: Record<string, unknown> = {};
    for (const p of def.properties) {
      if (p.default === undefined || p.default === null || p.default === '') continue;
      props[keyMap.get(p.key)!] = instantiateValue(p.default, fill);
    }

    const page = this.pages.create(campaignId, userId, {
      type: def.pageType as PageType,
      title: title.slice(0, 200),
      parentId: a.parentId,
      icon: def.defaults.icon ?? null,
      visibility: def.defaults.visibility ?? 'dm',
      tags: def.defaults.tags ?? [],
      body: { type: 'doc', content: body.length ? body : [{ type: 'paragraph' }] },
      facet: Object.fromEntries(Object.entries(facet).filter(([, v]) => v !== null && v !== '')),
      props,
    }, a.ctx);
    a.counter.pages++;
    const result = page;
    this.db.update(pages).set({ fromTemplateId: t.id, fromTemplateVersion: t.version }).where(eq(pages.id, page.id)).run();
    this.db.insert(templateUsage).values({ templateId: t.id, pageId: page.id, blockId: '', version: t.version, mode: 'page' }).onConflictDoNothing().run();

    if (a.withChildren && a.depth < MAX_CHILD_DEPTH) {
      const ancestors = new Set([...a.ancestors, t.id]);
      for (const child of def.children) {
        if (a.counter.pages >= MAX_PAGES_PER_INSTANTIATION) break;
        const childTemplate = child.templateRef ? this.lookup(userId, child.templateRef, campaignId) : null;
        if (childTemplate && childTemplate.kind === 'page' && !ancestors.has(childTemplate.id)) {
          this.createPageInner(userId, campaignId, { ...a, templateRef: childTemplate.id, title: child.title, parentId: page.id, depth: a.depth + 1, ancestors });
        } else {
          this.pages.create(campaignId, userId, { type: 'generic', title: child.title, parentId: page.id, visibility: 'dm', tags: [] }, a.ctx);
          a.counter.pages++;
        }
      }
    }
    return this.pages.get(campaignId, result.id);
  }

  /** Adds a page template's missing properties and appends its blocks; never overwrites anything. */
  applyToPage(userId: string, campaignId: string, pageId: string, input: { templateId: string; values: Record<string, unknown>; mode: 'fill' | 'fields' }, origin: WriteOrigin): PageDto {
    this.campaigns.requireDm(campaignId, userId);
    const t = this.lookup(userId, input.templateId, campaignId);
    if (!t || t.kind !== 'page') throw notFound('Page template not found');
    const { def } = this.resolvePage(userId, t.id, campaignId);
    const values = this.typedValues(def.variables, input.values, input.mode === 'fill');
    const opts = { ...this.instantiateOptions(campaignId), mode: input.mode, values, variables: def.variables };
    const page = this.pages.get(campaignId, pageId);
    const keyMap = this.ensureProperties(campaignId, def);
    const props: Record<string, unknown> = {};
    for (const p of def.properties) {
      const key = keyMap.get(p.key)!;
      if (page.props[key] !== undefined || p.default === undefined || p.default === null || p.default === '') continue;
      props[key] = instantiateValue(p.default, { ...opts, mode: 'fill' });
    }
    const added = instantiate(def.body, opts);
    const body = { type: 'doc' as const, content: [...((page.body?.content as BlockNode[] | undefined) ?? []), ...added] };
    return this.pages.update(campaignId, pageId, { revision: page.revision, body, ...(Object.keys(props).length ? { props } : {}) }, contextFor(userId, origin, 'template_apply'));
  }

  defaults(campaignId: string): Record<string, string> {
    const rows = this.db.select().from(campaignTemplateDefaults).where(eq(campaignTemplateDefaults.campaignId, campaignId)).all();
    return Object.fromEntries(rows.map((r) => [r.pageType, r.templateId]));
  }

  setDefault(userId: string, campaignId: string, pageType: PageType, templateId: string | null): Record<string, string> {
    this.campaigns.requireDm(campaignId, userId);
    this.db.delete(campaignTemplateDefaults).where(and(eq(campaignTemplateDefaults.campaignId, campaignId), eq(campaignTemplateDefaults.pageType, pageType))).run();
    if (templateId) {
      const t = this.lookup(userId, templateId, campaignId);
      if (!t || t.kind !== 'page') throw badRequest('Choose a page template');
      this.db.insert(campaignTemplateDefaults).values({ campaignId, pageType, templateId: t.id }).run();
    }
    return this.defaults(campaignId);
  }

  /** The default template for new pages of a type, if the campaign set one. */
  defaultFor(campaignId: string, pageType: PageType): string | null {
    return this.defaults(campaignId)[pageType] ?? null;
  }

  // endregion

  // region Linked instances

  /** Re-renders every linked instance of a block template with a new version. Returns how many changed. */
  private propagate(templateId: string, def: BlockTemplateDef, version: number, ctx: WriteContext): number {
    const pageIds = [
      ...new Set(
        this.db
          .select({ pageId: templateUsage.pageId })
          .from(templateUsage)
          .where(and(eq(templateUsage.templateId, templateId), eq(templateUsage.mode, 'linked')))
          .all()
          .map((r) => r.pageId),
      ),
    ];
    let changed = 0;
    for (const pageId of pageIds) {
      const row = this.db.select({ campaignId: pages.campaignId, revision: pages.revision, body: pages.body, deletedAt: pages.deletedAt }).from(pages).where(eq(pages.id, pageId)).get();
      if (!row || row.deletedAt || !isObject(row.body)) continue;
      const opts = this.instantiateOptions(row.campaignId);
      let touched = false;
      const replace = (nodes: BlockNode[]): BlockNode[] =>
        nodes.map((n) => {
          if (n.type === 'templateInstance' && n.attrs?.['templateId'] === templateId && !n.attrs?.['detached']) {
            touched = true;
            return renderLinked(n, { content: def.content, variables: def.variables, version }, opts);
          }
          return n.content ? { ...n, content: replace(n.content) } : n;
        });
      const content = replace(((row.body as { content?: BlockNode[] }).content ?? []) as BlockNode[]);
      if (!touched) continue;
      this.pages.update(row.campaignId, pageId, { revision: row.revision, body: { type: 'doc', content } }, ctx);
      changed++;
    }
    return changed;
  }

  // endregion

  // region Import/export

  exportTemplates(userId: string, ids: string[]): Record<string, unknown> {
    const list: ExportedTemplate[] = ids.map((id) => {
      const t = this.visibleRow(userId, id);
      return {
        kind: t.kind as TemplateKindDto,
        name: t.name,
        description: t.description,
        icon: t.icon,
        tags: (t.tags as string[]) ?? [],
        version: t.version,
        builtinKey: t.builtinKey,
        definition: t.definition as Def,
      };
    });
    return exportTemplates(list);
  }

  importTemplates(userId: string, raw: unknown, target: { scope: 'user' | 'campaign'; campaignId: string | null }): TemplateImportReportDto {
    let read: ReturnType<typeof readTemplateExport>;
    try {
      read = readTemplateExport(raw);
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : 'Not a template file');
    }
    const report: TemplateImportReportDto = { created: [], skipped: [...read.skipped] };
    for (const t of read.templates) {
      try {
        const created = this.create(userId, {
          kind: t.kind,
          scope: target.scope,
          campaignId: target.campaignId,
          name: t.name.slice(0, 120),
          description: (t.description ?? '').slice(0, 500),
          icon: t.icon ?? null,
          tags: (t.tags ?? []).slice(0, 20),
          definition: t.definition as unknown as Record<string, unknown>,
        });
        report.created.push({ id: created.id, name: created.name });
      } catch (e) {
        report.skipped.push(`${t.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return report;
  }

  // endregion
}
