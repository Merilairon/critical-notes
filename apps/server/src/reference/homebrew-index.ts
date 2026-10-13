/**
 * Keeps homebrew in the reference index: homebrew sources become `source` rows (origin homebrew) and
 * homebrew entities are resolved (`_copy` against official + homebrew data) and written as `entity` rows,
 * so search, lists, rendering and tags treat them exactly like official content.
 */
import {
  CopyResolver,
  entityUid,
  homebrewEditionToEdition,
  identityKey,
  isKind,
  isObject,
  KINDS,
  kindForProp,
  mergeRacesAndSubraces,
  type CopyTemplate,
  type EditionOrAny,
  type JsonObject,
  type ResolvedEntity,
} from '@cn/fivetools';
import { getMeta, type IndexDb } from './index-db';
import { entityToRow, prepareEntityWriter } from './indexer';

export interface HomebrewSourceRecord {
  id: string;
  jsonId: string;
  abbreviation: string;
  fullName: string;
  edition: string; // '2014' | '2024' | 'any'
  color: string | null;
}

export interface HomebrewEntityRecord {
  id: string;
  entityType: string;
  data: unknown;
  fluff: unknown;
  /** Soft-deleted entities stay indexed (references keep resolving) but are hidden from lists and search. */
  deletedAt?: number | null;
}

export const homebrewEditionToIndex = (edition: string): EditionOrAny => homebrewEditionToEdition(edition);

/** Index identity prop used when emitting rows (item-family props share the item identity). */
function emitProp(prop: string): string {
  return ['baseitem', 'magicvariant', 'itemGroup'].includes(prop) ? 'item' : prop;
}

export class HomebrewIndex {
  constructor(private readonly db: IndexDb) {}

  upsertSource(src: HomebrewSourceRecord) {
    this.db
      .prepare(
        `INSERT INTO source (id, json_id, name, abbreviation, grp, published, kind, edition, edition_reason, legacy, origin, homebrew_source_id, color)
         VALUES (@id, @json_id, @name, @abbreviation, 'homebrew', NULL, 'homebrew', @edition, 'homebrew', 0, 'homebrew', @homebrew_source_id, @color)
         ON CONFLICT(id) DO UPDATE SET json_id=excluded.json_id, name=excluded.name, abbreviation=excluded.abbreviation,
           edition=excluded.edition, homebrew_source_id=excluded.homebrew_source_id, color=excluded.color
         WHERE source.origin = 'homebrew'`,
      )
      .run({
        id: src.jsonId.toLowerCase(),
        json_id: src.jsonId,
        name: src.fullName,
        abbreviation: src.abbreviation,
        edition: homebrewEditionToIndex(src.edition),
        homebrew_source_id: src.id,
        color: src.color,
      });
  }

  removeSource(jsonId: string) {
    const tx = this.db.transaction(() => {
      const writer = prepareEntityWriter(this.db);
      const uids = this.db.prepare("SELECT uid FROM entity WHERE source = ? AND origin = 'homebrew'").all(jsonId.toLowerCase()) as { uid: string }[];
      for (const { uid } of uids) writer.remove(uid);
      this.db.prepare("DELETE FROM source WHERE id = ? AND origin = 'homebrew'").run(jsonId.toLowerCase());
    });
    tx();
  }

  private templatesCache: CopyTemplate[] | null = null;
  private monsterTemplates(): CopyTemplate[] {
    if (!this.templatesCache) {
      const raw = getMeta(this.db, 'monster_templates');
      try {
        this.templatesCache = raw ? (JSON.parse(raw) as CopyTemplate[]) : [];
      } catch {
        this.templatesCache = [];
      }
    }
    return this.templatesCache;
  }

  /** True if a source id is already used by official content (homebrew must not shadow it). */
  isOfficialSource(jsonId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM source WHERE id = ? AND origin = 'official'").get(jsonId.toLowerCase());
  }

  private parentLookup = (prop: string, key: string): JsonObject | undefined => {
    const kind = kindForProp(prop);
    if (!kind) return undefined;
    const row = this.db.prepare('SELECT data FROM entity WHERE kind = ? AND identity = ?').get(kind, key) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as JsonObject) : undefined;
  };

  /** The parent race of a homebrew subrace, as plain race data (without base-race bookkeeping). */
  private parentRace(raceName: unknown, raceSource: unknown): JsonObject | undefined {
    if (typeof raceName !== 'string' || typeof raceSource !== 'string') return undefined;
    const row = this.db.prepare("SELECT data FROM entity WHERE kind = 'race' AND identity = ?").get(`${raceName}|${raceSource}`.toLowerCase()) as
      | { data: string }
      | undefined;
    if (!row) return undefined;
    const race = JSON.parse(row.data) as JsonObject;
    if (typeof race._rawName === 'string') race.name = race._rawName;
    for (const k of ['_isBaseRace', '_subraces', '_rawName']) delete race[k];
    return race;
  }

  /** Resolves and writes one homebrew entity. Returns its uid (or null if it cannot be indexed). */
  indexEntity(entity: HomebrewEntityRecord, source: HomebrewSourceRecord): { uid: string | null; warnings: string[] } {
    const prop = entity.entityType;
    const isSubrace = prop === 'subrace';
    const kind = isSubrace ? 'race' : kindForProp(prop);
    if (!kind || !isKind(kind) || !isObject(entity.data)) return { uid: null, warnings: [`Unsupported homebrew type "${prop}"`] };
    const raw = { ...(entity.data as JsonObject), source: source.jsonId };
    const resolver = new CopyResolver(this.parentLookup, { templatesFor: (p) => (p === 'monster' ? this.monsterTemplates() : undefined) });
    let data = resolver.resolve(prop, raw);
    if (isSubrace) {
      const parent = this.parentRace(data.raceName, data.raceSource);
      if (!parent) return { uid: null, warnings: [`Parent race "${String(data.raceName)}" (${String(data.raceSource)}) not found`] };
      const merged = mergeRacesAndSubraces([parent], [data]).races.find((r) => !r._isBaseRace);
      if (!merged) return { uid: null, warnings: ['Subrace could not be merged into its race'] };
      data = { ...merged, source: source.jsonId };
    }
    const identity = identityKey(isSubrace ? 'race' : emitProp(prop), data);
    const uid = entityUid(kind, identity);
    const resolved: ResolvedEntity = {
      kind,
      prop,
      identity,
      uid,
      name: String(data.name ?? ''),
      source: source.jsonId,
      data,
      raw,
      file: null,
      generatedFrom: null,
      fluff: isObject(entity.fluff) ? (entity.fluff as JsonObject) : null,
    };
    const existing = this.db.prepare('SELECT origin, homebrew_entity_id FROM entity WHERE uid = ?').get(uid) as
      | { origin: string; homebrew_entity_id: string | null }
      | undefined;
    if (existing && (existing.origin !== 'homebrew' || existing.homebrew_entity_id !== entity.id)) {
      return { uid: null, warnings: [`"${resolved.name}" (${source.jsonId}) collides with an existing ${KINDS[kind].label.toLowerCase()}`] };
    }
    const { row, searchName, searchText } = entityToRow(resolved, homebrewEditionToIndex(source.edition), { group: null, generation: 0 }, 'homebrew', entity.id);
    const writer = prepareEntityWriter(this.db);
    this.db.transaction(() => {
      // Renames change the uid: drop the old row, and alias the old uid so existing {@tags} keep resolving
      const old = this.db.prepare("SELECT uid FROM entity WHERE homebrew_entity_id = ? AND origin = 'homebrew'").all(entity.id) as { uid: string }[];
      for (const o of old) {
        if (o.uid === uid) continue;
        writer.remove(o.uid);
        this.db.prepare('INSERT INTO entity_alias (alias_uid, target_uid) VALUES (?, ?) ON CONFLICT(alias_uid) DO UPDATE SET target_uid = excluded.target_uid').run(o.uid, uid);
        this.db.prepare('UPDATE entity_alias SET target_uid = ? WHERE target_uid = ?').run(uid, o.uid);
      }
      // A real entity owns its uid: an older alias with the same uid must not shadow it
      this.db.prepare('DELETE FROM entity_alias WHERE alias_uid = ?').run(uid);
      writer.write(row, searchName, searchText);
      this.db.prepare('UPDATE entity SET deleted = ? WHERE uid = ?').run(entity.deletedAt ? 1 : 0, uid);
    })();
    return { uid, warnings: resolver.warnings };
  }

  /** Hides or shows an indexed homebrew entity in lists and search (soft delete / restore). */
  setDeleted(entityId: string, deleted: boolean) {
    this.db.prepare("UPDATE entity SET deleted = ? WHERE homebrew_entity_id = ? AND origin = 'homebrew'").run(deleted ? 1 : 0, entityId);
  }

  /** The uid an indexed homebrew entity currently has. */
  uidOf(entityId: string): string | null {
    const row = this.db.prepare("SELECT uid FROM entity WHERE homebrew_entity_id = ? AND origin = 'homebrew'").get(entityId) as { uid: string } | undefined;
    return row?.uid ?? null;
  }

  /** Resolves a homebrew entity without writing it (live editor preview). */
  preview(prop: string, data: JsonObject, source: HomebrewSourceRecord): { kind: string; uid: string; data: JsonObject; warnings: string[] } | { error: string } {
    const isSubrace = prop === 'subrace';
    const kind = isSubrace ? 'race' : kindForProp(prop);
    if (!kind || !isKind(kind)) return { error: `Unsupported homebrew type "${prop}"` };
    const resolver = new CopyResolver(this.parentLookup, { templatesFor: (p) => (p === 'monster' ? this.monsterTemplates() : undefined) });
    let resolved = resolver.resolve(prop, { ...data, source: source.jsonId });
    if (isSubrace) {
      const parent = this.parentRace(resolved.raceName, resolved.raceSource);
      if (!parent) return { error: `Parent race "${String(resolved.raceName)}" (${String(resolved.raceSource)}) not found` };
      resolved = { ...(mergeRacesAndSubraces([parent], [resolved]).races.find((r) => !r._isBaseRace) ?? resolved), source: source.jsonId };
    }
    return { kind, uid: entityUid(kind, identityKey(isSubrace ? 'race' : emitProp(prop), resolved)), data: resolved, warnings: resolver.warnings };
  }

  removeEntity(entityId: string) {
    const writer = prepareEntityWriter(this.db);
    this.db.transaction(() => {
      const rows = this.db.prepare("SELECT uid FROM entity WHERE homebrew_entity_id = ? AND origin = 'homebrew'").all(entityId) as { uid: string }[];
      for (const r of rows) writer.remove(r.uid);
    })();
  }

  /** Re-indexes every homebrew source and entity (after an official rebuild or a fresh index). */
  syncAll(sources: HomebrewSourceRecord[], entities: (HomebrewEntityRecord & { sourceId: string })[]): { indexed: number; warnings: string[] } {
    const warnings: string[] = [];
    let indexed = 0;
    const byId = new Map(sources.map((s) => [s.id, s]));
    const liveJsonIds = new Set(sources.map((s) => s.jsonId.toLowerCase()));
    // Remove homebrew sources that no longer exist
    const indexedSources = this.db.prepare("SELECT id FROM source WHERE origin = 'homebrew'").all() as { id: string }[];
    for (const s of indexedSources) if (!liveJsonIds.has(s.id)) this.removeSource(s.id);
    for (const s of sources) this.upsertSource(s);
    // Entities whose parents are other homebrew entities must be indexed after them: retry until stable
    let pending = entities;
    for (let pass = 0; pass < 4 && pending.length; pass++) {
      const next: typeof pending = [];
      for (const e of pending) {
        const src = byId.get(e.sourceId);
        if (!src) continue;
        const { uid, warnings: w } = this.indexEntity(e, src);
        if (uid && !w.some((x) => x.includes('not found'))) indexed++;
        else if (!uid && w.some((x) => x.startsWith('Unsupported'))) warnings.push(...w);
        else if (pass < 3) next.push(e);
        else warnings.push(...w);
      }
      pending = next;
    }
    const liveIds = new Set(entities.map((e) => e.id));
    const rows = this.db.prepare("SELECT homebrew_entity_id AS id FROM entity WHERE origin = 'homebrew'").all() as { id: string }[];
    for (const r of rows) if (r.id && !liveIds.has(r.id)) this.removeEntity(r.id);
    return { indexed, warnings };
  }
}
