import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { buildSummary, homebrewEditionToEdition, isObject, KINDS, tokenPath, type EntityKind, type JsonObject } from '@cn/fivetools';
import type {
  CreateHomebrewSourceInput,
  EntityDto,
  HomebrewEdition,
  HomebrewEntityDto,
  HomebrewEntitySummaryDto,
  HomebrewIssue,
  HomebrewRevisionDto,
  HomebrewScope,
  HomebrewSourceDto,
  HomebrewUsageDto,
  HomebrewValidationDto,
  SaveHomebrewEntityInput,
  UpdateHomebrewSourceInput,
} from '@cn/shared';
import { createHomebrewSourceInput, updateHomebrewSourceInput } from '@cn/shared';
import type { AppDb } from '../db';
import {
  campaignMembers,
  campaigns,
  entityReferences,
  homebrewEntities,
  homebrewRevisions,
  homebrewSources,
  homebrewSourceShares,
  pages,
  users,
} from '../db/schema';
import { appErrors, collisionWarnings, tagWarnings } from '../homebrew/checks';
import { validateHomebrewEntity, type MetaSource } from '../homebrew/schema';
import { badRequest, conflict, forbidden, notFound } from '../lib/http';
import { newId } from '../lib/ids';
import { jsonDiff } from '../lib/json-diff';
import type { HomebrewIndex, HomebrewSourceRecord } from '../reference/homebrew-index';
import type { IndexDb } from '../reference/index-db';

export const MAX_ENTITY_BYTES = 512 * 1024;

type SourceRow = typeof homebrewSources.$inferSelect;
type EntityRow = typeof homebrewEntities.$inferSelect;

/** Props a copied official entity must not carry into homebrew (they describe the official printing). */
const OFFICIAL_ONLY_PROPS = [
  'page',
  'srd',
  'srd52',
  'basicRules',
  'basicRules2024',
  'freeRules2024',
  'reprintedAs',
  'otherSources',
  'referenceSources',
  'additionalSources',
  'hasFluff',
  'hasFluffImages',
  'hasToken',
  'tokenCredit',
  'altArt',
  'soundClip',
  'legacy',
];

export function sourceRecord(s: SourceRow): HomebrewSourceRecord {
  return { id: s.id, jsonId: s.jsonId, abbreviation: s.abbreviation, fullName: s.fullName, edition: s.edition, color: s.color };
}

export function metaSource(s: SourceRow): MetaSource {
  return {
    json: s.jsonId,
    abbreviation: s.abbreviation,
    full: s.fullName,
    authors: (s.authors as string[]) ?? [],
    version: s.version,
    ...(s.url ? { url: s.url } : {}),
    ...(s.color ? { color: s.color } : {}),
  };
}

/** A source id derived from the source's names that satisfies the 5etools homebrew schema ("Gloom Grimoire" → "GloomGrimoire"). */
export function jsonIdFrom(fullName: string, abbreviation: string): string {
  const clean = (v: string) => v.replace(/[^A-Za-z0-9]/g, '');
  let id = clean(fullName).slice(0, 40);
  if (id.length < 6) id = `${clean(abbreviation)}Homebrew`.slice(0, 40);
  if (/^X?UA/i.test(id)) id = `HB${id}`.slice(0, 40);
  return id;
}

function stripInternal(data: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(data)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

export class HomebrewService {
  constructor(
    private readonly db: AppDb,
    private readonly index: HomebrewIndex,
    private readonly indexDb: IndexDb,
    private readonly onIndexChanged: () => void,
  ) {}

  private batchDepth = 0;
  private batchDirty = false;

  /** Notifies the reference service once per batch instead of once per write (imports). */
  batch<T>(fn: () => T): T {
    this.batchDepth++;
    try {
      return fn();
    } finally {
      if (--this.batchDepth === 0 && this.batchDirty) {
        this.batchDirty = false;
        this.onIndexChanged();
      }
    }
  }

  private changed() {
    if (this.batchDepth) this.batchDirty = true;
    else this.onIndexChanged();
  }

  // region Lookups and permissions

  source(id: string): SourceRow {
    const s = this.db.select().from(homebrewSources).where(and(eq(homebrewSources.id, id), isNull(homebrewSources.deletedAt))).get();
    if (!s) throw notFound('Homebrew source not found');
    return s;
  }

  /** A live or soft-deleted entity of a live source. */
  entity(id: string, { includeDeleted = false } = {}): EntityRow {
    const e = this.db.select().from(homebrewEntities).where(eq(homebrewEntities.id, id)).get();
    if (!e || (e.deletedAt && !includeDeleted)) throw notFound('Homebrew entity not found');
    return e;
  }

  private isAdmin(userId: string): boolean {
    return !!this.db.select({ a: users.isAdmin }).from(users).where(eq(users.id, userId)).get()?.a;
  }

  private dmCampaignIds(userId: string): string[] {
    return this.db
      .select({ id: campaignMembers.campaignId })
      .from(campaignMembers)
      .where(and(eq(campaignMembers.userId, userId), eq(campaignMembers.role, 'dm')))
      .all()
      .map((r) => r.id);
  }

  canEdit(source: SourceRow, userId: string): boolean {
    if (source.scope === 'campaign') return !!source.campaignId && this.dmCampaignIds(userId).includes(source.campaignId);
    if (source.ownerUserId === userId) return true;
    return source.scope === 'instance' && this.isAdmin(userId);
  }

  /** Sources a user may browse in the homebrew area: their own, instance-wide ones, and their campaigns'. */
  canView(source: SourceRow, userId: string): boolean {
    return source.scope === 'instance' || this.canEdit(source, userId);
  }

  private requireEdit(source: SourceRow, userId: string) {
    if (!this.canEdit(source, userId)) throw forbidden('You cannot edit this homebrew source');
  }

  private requireView(source: SourceRow, userId: string) {
    if (!this.canView(source, userId)) throw notFound('Homebrew source not found');
  }

  /**
   * Homebrew a user may see in the reference browser outside a campaign (lower-cased json ids): their own
   * and instance-wide sources. Campaign-only sources stay inside their campaign.
   */
  viewableJsonIds(userId: string): string[] {
    return this.visibleSources(userId)
      .filter((s) => s.scope !== 'campaign')
      .map((s) => s.jsonIdLower);
  }

  private visibleSources(userId: string): SourceRow[] {
    const dmIds = this.dmCampaignIds(userId);
    return this.db
      .select()
      .from(homebrewSources)
      .where(
        and(
          isNull(homebrewSources.deletedAt),
          or(
            eq(homebrewSources.ownerUserId, userId),
            eq(homebrewSources.scope, 'instance'),
            dmIds.length ? and(eq(homebrewSources.scope, 'campaign'), inArray(homebrewSources.campaignId, dmIds)) : sql`0`,
          ),
        ),
      )
      .all()
      .filter((s) => this.canView(s, userId));
  }

  // endregion

  // region Sources

  private sourceDto(s: SourceRow, userId: string): HomebrewSourceDto {
    const owner = s.ownerUserId ? this.db.select({ n: users.displayName }).from(users).where(eq(users.id, s.ownerUserId)).get() : undefined;
    const campaign = s.campaignId ? this.db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(eq(campaigns.id, s.campaignId)).get() : undefined;
    const sharedWith = this.db
      .select({ id: campaigns.id, name: campaigns.name })
      .from(homebrewSourceShares)
      .innerJoin(campaigns, eq(campaigns.id, homebrewSourceShares.campaignId))
      .where(eq(homebrewSourceShares.sourceId, s.id))
      .all();
    const count = this.db
      .select({ n: sql<number>`count(*)` })
      .from(homebrewEntities)
      .where(and(eq(homebrewEntities.sourceId, s.id), isNull(homebrewEntities.deletedAt)))
      .get();
    return {
      id: s.id,
      jsonId: s.jsonId,
      abbreviation: s.abbreviation,
      fullName: s.fullName,
      authors: (s.authors as string[]) ?? [],
      version: s.version,
      edition: s.edition as HomebrewEdition,
      color: s.color,
      url: s.url,
      scope: (s.scope === 'campaign' || s.scope === 'instance' ? s.scope : 'private') as HomebrewScope,
      ownerUserId: s.ownerUserId,
      ownerName: owner?.n ?? null,
      campaign: campaign ?? null,
      sharedWith,
      entityCount: count?.n ?? 0,
      canEdit: this.canEdit(s, userId),
      updatedAt: s.updatedAt,
    };
  }

  listSources(userId: string): HomebrewSourceDto[] {
    return this.visibleSources(userId)
      .map((s) => this.sourceDto(s, userId))
      .sort((a, b) => Number(!!a.campaign) - Number(!!b.campaign) || a.fullName.localeCompare(b.fullName));
  }

  getSource(userId: string, id: string): HomebrewSourceDto {
    const s = this.source(id);
    this.requireView(s, userId);
    return this.sourceDto(s, userId);
  }

  /** A free source id: not used by official content or another homebrew source. */
  private ensureFreeJsonId(jsonId: string) {
    if (this.index.isOfficialSource(jsonId)) throw badRequest(`"${jsonId}" is an official source id`);
    const taken = this.db.select({ id: homebrewSources.id }).from(homebrewSources).where(eq(homebrewSources.jsonIdLower, jsonId.toLowerCase())).get();
    if (taken) throw conflict(`The source id "${jsonId}" is already in use`);
  }

  private uniqueJsonId(base: string): string {
    for (let i = 1; ; i++) {
      const candidate = i === 1 ? base : `${base}${i}`;
      if (this.index.isOfficialSource(candidate)) continue;
      if (!this.db.select({ id: homebrewSources.id }).from(homebrewSources).where(eq(homebrewSources.jsonIdLower, candidate.toLowerCase())).get()) return candidate;
    }
  }

  /**
   * @param extra.importedJsonId an id from an imported file: kept as written (5etools accepts legacy short ids
   *   in existing brew), only checked for being free and sane.
   */
  createSource(userId: string, input: CreateHomebrewSourceInput, extra: { metaExtra?: JsonObject | null; importedJsonId?: string } = {}): HomebrewSourceDto {
    const v = createHomebrewSourceInput.parse(input);
    if (v.scope === 'instance' && !this.isAdmin(userId)) throw forbidden('Only admins can create instance-wide homebrew');
    if (extra.importedJsonId !== undefined && !/^[^\s/\\<>"'`{}|][^/\\<>"'`{}|]{0,99}$/.test(extra.importedJsonId)) throw badRequest(`"${extra.importedJsonId}" is not a usable source id`);
    const jsonId = extra.importedJsonId ?? v.jsonId ?? this.uniqueJsonId(jsonIdFrom(v.fullName, v.abbreviation));
    if (extra.importedJsonId !== undefined || v.jsonId) this.ensureFreeJsonId(jsonId);
    const row = {
      id: newId(),
      jsonId,
      jsonIdLower: jsonId.toLowerCase(),
      abbreviation: v.abbreviation,
      fullName: v.fullName,
      authors: v.authors,
      version: v.version,
      edition: v.edition,
      color: v.color,
      url: v.url,
      metaExtra: extra.metaExtra ?? null,
      scope: v.scope,
      ownerUserId: userId,
    };
    this.db.insert(homebrewSources).values(row).run();
    const created = this.source(row.id);
    this.index.upsertSource(sourceRecord(created));
    this.changed();
    return this.sourceDto(created, userId);
  }

  updateSource(userId: string, id: string, patch: UpdateHomebrewSourceInput, extra: { metaExtra?: JsonObject | null } = {}): HomebrewSourceDto {
    const s = this.source(id);
    this.requireEdit(s, userId);
    const v = updateHomebrewSourceInput.parse(patch);
    if (s.scope === 'campaign' && v.scope) throw badRequest("A campaign's own source cannot change scope");
    if (v.scope === 'instance' && s.scope !== 'instance' && !this.isAdmin(userId)) throw forbidden('Only admins can make homebrew instance-wide');
    this.db
      .update(homebrewSources)
      .set({ ...v, ...(extra.metaExtra !== undefined ? { metaExtra: extra.metaExtra } : {}), updatedAt: Date.now() })
      .where(eq(homebrewSources.id, id))
      .run();
    const updated = this.source(id);
    this.index.upsertSource(sourceRecord(updated));
    // The source edition is part of every entity's index row
    if (v.edition && v.edition !== s.edition) this.reindexSource(updated);
    this.changed();
    return this.sourceDto(updated, userId);
  }

  deleteSource(userId: string, id: string) {
    const s = this.source(id);
    this.requireEdit(s, userId);
    if (s.scope === 'campaign') throw badRequest("A campaign's own source is deleted with the campaign");
    this.db.update(homebrewSources).set({ deletedAt: Date.now() }).where(eq(homebrewSources.id, id)).run();
    this.index.removeSource(s.jsonId);
    this.changed();
  }

  /** Shares a source with exactly these campaigns (among the ones the user runs). */
  shareSource(userId: string, id: string, campaignIds: string[]): HomebrewSourceDto {
    const s = this.source(id);
    this.requireEdit(s, userId);
    if (s.scope === 'campaign') throw badRequest("A campaign's own source cannot be shared");
    const mine = new Set(this.dmCampaignIds(userId));
    const wanted = new Set(campaignIds);
    for (const c of wanted) if (!mine.has(c)) throw forbidden('You can only share with campaigns you run');
    this.db.transaction((tx) => {
      const current = tx.select().from(homebrewSourceShares).where(eq(homebrewSourceShares.sourceId, id)).all();
      for (const sh of current) {
        if (mine.has(sh.campaignId) && !wanted.has(sh.campaignId)) {
          tx.delete(homebrewSourceShares).where(and(eq(homebrewSourceShares.sourceId, id), eq(homebrewSourceShares.campaignId, sh.campaignId))).run();
        }
      }
      const have = new Set(current.map((sh) => sh.campaignId));
      for (const c of wanted) if (!have.has(c)) tx.insert(homebrewSourceShares).values({ sourceId: id, campaignId: c }).run();
    });
    return this.sourceDto(this.source(id), userId);
  }

  private reindexSource(source: SourceRow) {
    const rows = this.db.select().from(homebrewEntities).where(eq(homebrewEntities.sourceId, source.id)).all();
    for (const e of rows) this.index.indexEntity(e, sourceRecord(source));
  }

  // endregion

  // region Entities

  private uidMap(sourceJsonId: string): Map<string, string> {
    const rows = this.indexDb
      .prepare("SELECT homebrew_entity_id AS id, uid FROM entity WHERE source = ? AND origin = 'homebrew'")
      .all(sourceJsonId.toLowerCase()) as { id: string; uid: string }[];
    return new Map(rows.map((r) => [r.id, r.uid]));
  }

  private summary(e: EntityRow, uid: string | null): HomebrewEntitySummaryDto {
    const data = e.data as JsonObject;
    const copy = isObject(data._copy) ? `${String(data._copy.name)}|${String(data._copy.source)}` : null;
    return {
      id: e.id,
      sourceId: e.sourceId,
      entityType: e.entityType,
      name: e.name,
      uid,
      currentRevision: e.currentRevision,
      updatedAt: e.updatedAt,
      deleted: !!e.deletedAt,
      copyOf: copy,
    };
  }

  listEntities(userId: string, sourceId: string, { includeDeleted = false } = {}): HomebrewEntitySummaryDto[] {
    const s = this.source(sourceId);
    this.requireView(s, userId);
    const uids = this.uidMap(s.jsonId);
    return this.db
      .select()
      .from(homebrewEntities)
      .where(and(eq(homebrewEntities.sourceId, sourceId), includeDeleted ? undefined : isNull(homebrewEntities.deletedAt)))
      .orderBy(homebrewEntities.entityType, homebrewEntities.nameLower)
      .all()
      .map((e) => this.summary(e, uids.get(e.id) ?? null));
  }

  getEntity(userId: string, entityId: string): HomebrewEntityDto {
    const e = this.entity(entityId, { includeDeleted: true });
    const s = this.source(e.sourceId);
    this.requireView(s, userId);
    return this.entityDto(e, s, userId);
  }

  private entityDto(e: EntityRow, s: SourceRow, userId: string): HomebrewEntityDto {
    return {
      ...this.summary(e, this.index.uidOf(e.id)),
      data: e.data as JsonObject,
      fluff: (e.fluff as JsonObject | null) ?? null,
      source: this.sourceDto(s, userId),
    };
  }

  /** Schema, app-level and reference checks. `force` turns schema errors into warnings. */
  validate(source: SourceRow, prop: string, data: unknown, opts: { force?: boolean; selfEntityId?: string | null } = {}): HomebrewValidationDto {
    const errors = appErrors(prop, data);
    const warnings: HomebrewIssue[] = [];
    if (!isObject(data)) return { errors, warnings };
    const size = JSON.stringify(data).length;
    if (size > MAX_ENTITY_BYTES) errors.push({ path: '', message: `Entity is too large (${Math.round(size / 1024)} KB, max ${MAX_ENTITY_BYTES / 1024} KB)` });
    const payload = { ...data, source: source.jsonId };
    const schemaIssues = validateHomebrewEntity(prop, payload, metaSource(source), source.edition as HomebrewEdition);
    (opts.force ? warnings : errors).push(...schemaIssues.map((i) => ({ ...i, message: `5etools schema: ${i.message}` })));
    const preview = this.index.preview(prop, payload, sourceRecord(source));
    if ('error' in preview) errors.push({ path: '', message: preview.error });
    else {
      for (const w of preview.warnings) (w.includes('not found') ? errors : warnings).push({ path: '/_copy', message: w });
      warnings.push(...tagWarnings(this.indexDb, payload, preview.uid));
      if (typeof data.name === 'string') warnings.push(...collisionWarnings(this.indexDb, prop, data.name, source.jsonId));
    }
    // Same type and name in this source is an error (the unique index would reject it anyway)
    if (typeof data.name === 'string' && this.nameTaken(source.id, prop, data.name, opts.selfEntityId ?? null)) {
      errors.push({ path: '/name', message: `This source already has a ${prop} called "${data.name.trim()}"` });
    }
    return { errors, warnings };
  }

  private nameTaken(sourceId: string, prop: string, name: string, exceptId: string | null): boolean {
    const row = this.db
      .select({ id: homebrewEntities.id })
      .from(homebrewEntities)
      .where(
        and(
          eq(homebrewEntities.sourceId, sourceId),
          eq(homebrewEntities.entityType, prop),
          eq(homebrewEntities.nameLower, name.trim().toLowerCase()),
          isNull(homebrewEntities.deletedAt),
        ),
      )
      .get();
    return !!row && row.id !== exceptId;
  }

  createEntity(userId: string, sourceId: string, input: SaveHomebrewEntityInput): { entity: HomebrewEntityDto; validation: HomebrewValidationDto } {
    const s = this.source(sourceId);
    this.requireEdit(s, userId);
    const validation = this.validate(s, input.entityType, input.data, { force: input.force });
    if (validation.errors.length) throw badRequest('The entity has errors', validation);
    const { entity } = this.create(s.id, userId, input.entityType, input.data as JsonObject, (input.fluff as JsonObject | null | undefined) ?? null, input.message);
    return { entity: this.entityDto(entity, s, userId), validation };
  }

  updateEntity(userId: string, entityId: string, input: SaveHomebrewEntityInput): { entity: HomebrewEntityDto; validation: HomebrewValidationDto } {
    const current = this.entity(entityId);
    const s = this.source(current.sourceId);
    this.requireEdit(s, userId);
    if (input.entityType !== current.entityType) throw badRequest('The entity type cannot change');
    if (input.revision !== undefined && input.revision !== current.currentRevision) {
      throw conflict('This entity was changed elsewhere. Reload it before saving.', { currentRevision: current.currentRevision });
    }
    const validation = this.validate(s, current.entityType, input.data, { force: input.force, selfEntityId: entityId });
    if (validation.errors.length) throw badRequest('The entity has errors', validation);
    const { entity } = this.update(entityId, userId, input.data as JsonObject, input.fluff as JsonObject | null | undefined, input.message);
    return { entity: this.entityDto(entity, s, userId), validation };
  }

  /** Low-level create (callers check permissions and validation). Records revision 1 and indexes. */
  create(
    sourceId: string,
    userId: string,
    entityType: string,
    data: JsonObject,
    fluff: JsonObject | null = null,
    message = 'Created',
  ): { entity: EntityRow; uid: string | null; warnings: string[] } {
    const source = this.source(sourceId);
    if (typeof data.name !== 'string' || !data.name.trim()) throw badRequest('Entity needs a name');
    const name = this.uniqueName(source.id, entityType, data.name.trim());
    const payload = { ...data, name, source: source.jsonId };
    if (JSON.stringify(payload).length > MAX_ENTITY_BYTES) throw badRequest('Entity is too large');
    const id = newId();
    this.db.transaction((tx) => {
      tx.insert(homebrewEntities).values({ id, sourceId: source.id, entityType, name, nameLower: name.toLowerCase(), data: payload, fluff, createdBy: userId }).run();
      tx.insert(homebrewRevisions).values({ id: newId(), entityId: id, revNo: 1, data: payload, fluff, authorUserId: userId, message }).run();
    });
    const entity = this.entity(id);
    const { uid, warnings } = this.index.indexEntity(entity, sourceRecord(source));
    this.changed();
    return { entity, uid, warnings };
  }

  /** Low-level update (callers check permissions and validation). Records a revision with a JSON-patch diff. */
  update(entityId: string, userId: string, data: JsonObject, fluff?: JsonObject | null, message?: string): { entity: EntityRow; uid: string | null; warnings: string[] } {
    const current = this.entity(entityId);
    const source = this.source(current.sourceId);
    if (typeof data.name !== 'string' || !data.name.trim()) throw badRequest('Entity needs a name');
    const name = data.name.trim();
    if (name.toLowerCase() !== current.nameLower && this.nameTaken(source.id, current.entityType, name, entityId)) {
      throw badRequest(`Another ${current.entityType} in this source is already called "${name}"`);
    }
    const payload = { ...data, name, source: source.jsonId };
    if (JSON.stringify(payload).length > MAX_ENTITY_BYTES) throw badRequest('Entity is too large');
    const nextFluff = fluff === undefined ? current.fluff : fluff;
    const revNo = current.currentRevision + 1;
    this.db.transaction((tx) => {
      tx.update(homebrewEntities)
        .set({ data: payload, fluff: nextFluff, name, nameLower: name.toLowerCase(), currentRevision: revNo, updatedAt: Date.now() })
        .where(eq(homebrewEntities.id, entityId))
        .run();
      tx.insert(homebrewRevisions)
        .values({ id: newId(), entityId, revNo, data: payload, fluff: nextFluff, diff: jsonDiff(current.data, payload), authorUserId: userId, message: message ?? null })
        .run();
    });
    const entity = this.entity(entityId);
    const { uid, warnings } = this.index.indexEntity(entity, sourceRecord(source));
    this.changed();
    return { entity, uid, warnings };
  }

  private uniqueName(sourceId: string, entityType: string, name: string): string {
    if (!this.nameTaken(sourceId, entityType, name, null)) return name;
    for (let i = 2; ; i++) if (!this.nameTaken(sourceId, entityType, `${name} (${i})`, null)) return `${name} (${i})`;
  }

  /** Soft delete: hidden from lists and search; pages that reference it still resolve it (with a badge). */
  deleteEntity(userId: string, entityId: string) {
    const e = this.entity(entityId);
    this.requireEdit(this.source(e.sourceId), userId);
    this.db.update(homebrewEntities).set({ deletedAt: Date.now() }).where(eq(homebrewEntities.id, entityId)).run();
    this.index.setDeleted(entityId, true);
  }

  restoreEntity(userId: string, entityId: string): HomebrewEntityDto {
    const e = this.entity(entityId, { includeDeleted: true });
    const s = this.source(e.sourceId);
    this.requireEdit(s, userId);
    if (!e.deletedAt) return this.entityDto(e, s, userId);
    if (this.nameTaken(s.id, e.entityType, e.name, e.id)) throw conflict(`Another ${e.entityType} called "${e.name}" exists now. Rename it first.`);
    this.db.update(homebrewEntities).set({ deletedAt: null }).where(eq(homebrewEntities.id, entityId)).run();
    const restored = this.entity(entityId);
    this.index.indexEntity(restored, sourceRecord(s));
    this.changed();
    return this.entityDto(restored, s, userId);
  }

  revisions(userId: string, entityId: string): HomebrewRevisionDto[] {
    const e = this.entity(entityId, { includeDeleted: true });
    this.requireView(this.source(e.sourceId), userId);
    return this.db
      .select({ r: homebrewRevisions, author: users.displayName })
      .from(homebrewRevisions)
      .leftJoin(users, eq(users.id, homebrewRevisions.authorUserId))
      .where(eq(homebrewRevisions.entityId, entityId))
      .orderBy(desc(homebrewRevisions.revNo))
      .all()
      .map(({ r, author }) => ({
        revNo: r.revNo,
        createdAt: r.createdAt,
        authorName: author ?? null,
        message: r.message,
        changes: Array.isArray(r.diff) ? r.diff.length : 0,
      }));
  }

  revision(userId: string, entityId: string, revNo: number): { data: JsonObject; fluff: JsonObject | null } {
    const e = this.entity(entityId, { includeDeleted: true });
    this.requireView(this.source(e.sourceId), userId);
    const r = this.db
      .select()
      .from(homebrewRevisions)
      .where(and(eq(homebrewRevisions.entityId, entityId), eq(homebrewRevisions.revNo, revNo)))
      .get();
    if (!r) throw notFound('Revision not found');
    return { data: r.data as JsonObject, fluff: (r.fluff as JsonObject | null) ?? null };
  }

  /** Restoring creates a new revision with the old content (history is never rewritten). */
  restoreRevision(userId: string, entityId: string, revNo: number): HomebrewEntityDto {
    const e = this.entity(entityId);
    const s = this.source(e.sourceId);
    this.requireEdit(s, userId);
    const old = this.revision(userId, entityId, revNo);
    const { entity } = this.update(entityId, userId, old.data, old.fluff, `Restored revision ${revNo}`);
    return this.entityDto(entity, s, userId);
  }

  /** Campaign pages (in campaigns the user runs) that reference this entity. */
  usage(userId: string, entityId: string): HomebrewUsageDto[] {
    const e = this.entity(entityId, { includeDeleted: true });
    this.requireView(this.source(e.sourceId), userId);
    const uid = this.index.uidOf(entityId);
    if (!uid) return [];
    const aliases = (this.indexDb.prepare('SELECT alias_uid FROM entity_alias WHERE target_uid = ?').all(uid) as { alias_uid: string }[]).map((a) => a.alias_uid);
    const dmIds = this.dmCampaignIds(userId);
    if (!dmIds.length) return [];
    return this.db
      .select({ pageId: pages.id, pageTitle: pages.title, campaignId: campaigns.id, campaignName: campaigns.name, via: entityReferences.via })
      .from(entityReferences)
      .innerJoin(pages, eq(pages.id, entityReferences.pageId))
      .innerJoin(campaigns, eq(campaigns.id, pages.campaignId))
      .where(and(inArray(entityReferences.uid, [uid, ...aliases]), isNull(pages.deletedAt), inArray(pages.campaignId, dmIds)))
      .orderBy(campaigns.name, pages.title)
      .all();
  }

  /** Data for a new homebrew entity based on a reference entity: a full clone or a `_copy` variant. */
  fromReference(base: EntityDto, mode: 'clone' | 'variant', name?: string): { entityType: string; data: JsonObject } {
    const generic = KINDS[base.kind as EntityKind]?.props[0] ?? base.kind;
    // Generated entities (merged subraces, expanded variants) are saved as their kind's main type
    const prop = base.prop && !['magicvariant', 'itemGroup', 'subrace'].includes(base.prop) ? base.prop : generic;
    const baseName = base.raw && typeof base.raw['name'] === 'string' ? String(base.raw['name']) : base.name;
    const newName = name?.trim() || (mode === 'clone' ? `${base.name} (copy)` : base.name);
    const token = base.kind === 'monster' && base.tokenPath ? { token: { name: baseName, source: base.source } } : {};
    if (mode === 'variant') {
      return { entityType: prop, data: { name: newName, source: '', _copy: { name: baseName, source: base.source }, ...token } };
    }
    const data = stripInternal(structuredClone(base.data) as JsonObject);
    for (const p of OFFICIAL_ONLY_PROPS) delete data[p];
    return { entityType: prop, data: { ...data, name: newName, source: '', ...token } };
  }

  /** Resolved entity (as the reference API would return it) plus validation, without saving. */
  preview(userId: string, sourceId: string, prop: string, data: JsonObject, entityId: string | null): { entity: EntityDto | null; validation: HomebrewValidationDto } {
    const s = this.source(sourceId);
    this.requireView(s, userId);
    const validation = this.validate(s, prop, data, { force: true, selfEntityId: entityId });
    const resolved = this.index.preview(prop, { ...data, source: s.jsonId }, sourceRecord(s));
    if ('error' in resolved) return { entity: null, validation };
    const kind = resolved.kind as EntityKind;
    const edition = homebrewEditionToEdition(s.edition);
    return {
      validation,
      entity: {
        uid: resolved.uid,
        kind,
        name: String(resolved.data.name ?? ''),
        source: s.jsonId,
        sourceInfo: null,
        page: null,
        edition,
        badge: null,
        visible: true,
        origin: 'homebrew',
        homebrewEntityId: entityId,
        data: resolved.data,
        raw: data,
        fluff: null,
        imagePath: null,
        tokenPath: tokenPath(kind, resolved.data),
        summary: buildSummary(kind, resolved.data) as unknown as Record<string, unknown>,
        generatedFrom: null,
        reprintedAs: [],
        reprintGroup: [],
        preferredUid: resolved.uid,
      },
    };
  }

  // endregion

  /** Re-indexes all homebrew (startup, or after an official rebuild). Soft-deleted entities stay resolvable. */
  syncIndex(): { indexed: number; warnings: string[] } {
    const sources = this.db.select().from(homebrewSources).where(isNull(homebrewSources.deletedAt)).all();
    const entities = this.db.select().from(homebrewEntities).all();
    const liveSourceIds = new Set(sources.map((s) => s.id));
    const result = this.index.syncAll(
      sources.map(sourceRecord),
      entities.filter((e) => liveSourceIds.has(e.sourceId)),
    );
    this.changed();
    return result;
  }

  /** Builds a `_copy` homebrew monster from a reference statblock (stores only the diff). */
  copyOf(base: { name: string; source: string }, name: string, extra: JsonObject = {}): JsonObject {
    const data: JsonObject = { name, source: '', _copy: { name: base.name, source: base.source }, ...extra };
    if (isObject(extra._copy)) data._copy = { name: base.name, source: base.source, ...extra._copy };
    return data;
  }
}
