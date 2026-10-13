/**
 * 5etools homebrew import and export.
 *
 * Import never fails as a whole: every file and every entity is handled on its own, and problems end up
 * in the report. Re-importing a file updates the entities it already created (matched by type and name).
 * Data arrays the app cannot use are kept on the source, so an export gives them back.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { isObject, kindForFluffProp, kindForProp, KINDS, metaEditionToHomebrew, stableStringify, type JsonObject } from '@cn/fivetools';
import type { HomebrewEdition, HomebrewImportReportDto } from '@cn/shared';
import type { AppDb } from '../db';
import { homebrewEntities, homebrewSources } from '../db/schema';
import { appErrors } from './checks';
import { editionToMeta } from './schema';
import { HttpError } from '../lib/http';
import { metaSource, type HomebrewService } from '../services/homebrew';

/** `_meta` keys the app stores in its own columns (everything else round-trips through `metaExtra`). */
const META_OWN_KEYS = new Set(['sources', 'dateAdded', 'dateLastModified', 'edition', 'status', 'unlisted']);
/** Where `metaExtra` keeps data arrays the app does not support. */
const EXTRA_ARRAYS = '__arrays';
const MAX_ENTITIES_PER_IMPORT = 20_000;

export interface BrewFile {
  name: string;
  text: string;
}

type Report = HomebrewImportReportDto;

function emptyReport(): Report {
  return { sources: [], created: 0, updated: 0, unchanged: 0, skipped: [], warnings: [], unsupported: {} };
}

const isEntityProp = (prop: string) => prop === 'subrace' || !!kindForProp(prop);

export class HomebrewTransfer {
  constructor(
    private readonly db: AppDb,
    private readonly homebrew: HomebrewService,
  ) {}

  /** Parses and imports files. Never throws for bad content; see the report. */
  importFiles(userId: string, files: BrewFile[], defaultEdition: HomebrewEdition): Report {
    const report = emptyReport();
    const docs: { name: string; json: JsonObject }[] = [];
    for (const f of files) {
      try {
        const json: unknown = JSON.parse(f.text.replace(/^\uFEFF/, ''));
        if (!isObject(json)) report.warnings.push(`${f.name}: not a JSON object`);
        else docs.push({ name: f.name, json });
      } catch (e) {
        report.warnings.push(`${f.name}: not valid JSON (${(e as Error).message.slice(0, 120)})`);
      }
    }
    this.homebrew.batch(() => {
      for (const doc of docs) {
        try {
          this.importDocument(userId, doc.name, doc.json, defaultEdition, report);
        } catch (e) {
          report.warnings.push(`${doc.name}: ${(e as Error).message}`);
        }
      }
      // Entities may `_copy` others from later in the same file(s): index again until stable
      if (report.created || report.updated) this.homebrew.syncIndex();
    });
    return report;
  }

  private importDocument(userId: string, fileName: string, doc: JsonObject, defaultEdition: HomebrewEdition, report: Report) {
    const meta = isObject(doc._meta) ? doc._meta : null;
    const metaSources = meta && Array.isArray(meta.sources) ? meta.sources.filter(isObject) : [];
    if (!metaSources.length) {
      report.warnings.push(`${fileName}: no _meta.sources, so this is not a 5etools homebrew file`);
      return;
    }
    const edition: HomebrewEdition = metaEditionToHomebrew(meta?.edition, defaultEdition);
    const metaExtra: JsonObject = {};
    for (const [k, v] of Object.entries(meta ?? {})) if (!META_OWN_KEYS.has(k)) metaExtra[k] = v;

    // Data arrays the app cannot use: keep them with the first source
    const extraArrays: JsonObject = {};
    for (const [prop, value] of Object.entries(doc)) {
      if (prop === '_meta' || prop === '$schema' || !Array.isArray(value)) continue;
      if (isEntityProp(prop) || kindForFluffProp(prop)) continue;
      extraArrays[prop] = value;
      report.unsupported[prop] = (report.unsupported[prop] ?? 0) + value.length;
    }

    // Sources: reuse the ones this user can edit, create the others
    const sourceIds = new Map<string, string>(); // lower json id → homebrew source id
    for (const [i, ms] of metaSources.entries()) {
      const jsonId = typeof ms.json === 'string' ? ms.json.trim() : '';
      if (!jsonId) {
        report.warnings.push(`${fileName}: a source has no "json" id`);
        continue;
      }
      try {
        const existing = this.db
          .select()
          .from(homebrewSources)
          .where(and(eq(homebrewSources.jsonIdLower, jsonId.toLowerCase()), isNull(homebrewSources.deletedAt)))
          .get();
        const extra = { metaExtra: i === 0 ? { ...metaExtra, ...(Object.keys(extraArrays).length ? { [EXTRA_ARRAYS]: extraArrays } : {}) } : null };
        if (existing) {
          if (!this.homebrew.canEdit(existing, userId)) {
            report.warnings.push(`${fileName}: the source "${jsonId}" belongs to someone else; its entities were skipped`);
            continue;
          }
          if (i === 0) this.homebrew.updateSource(userId, existing.id, {}, extra);
          sourceIds.set(jsonId.toLowerCase(), existing.id);
          report.sources.push({ id: existing.id, jsonId: existing.jsonId, fullName: existing.fullName, created: false });
          continue;
        }
        const created = this.homebrew.createSource(
          userId,
          {
            abbreviation: str(ms.abbreviation, 20) || jsonId.slice(0, 20),
            fullName: str(ms.full, 120) || jsonId,
            authors: Array.isArray(ms.authors) ? ms.authors.filter((a): a is string => typeof a === 'string' && !!a.trim()).map((a) => a.trim().slice(0, 80)).slice(0, 20) : [],
            version: str(ms.version, 20) || '1.0.0',
            edition,
            color: typeof ms.color === 'string' && /^[a-fA-F0-9]{6}$/.test(ms.color) ? ms.color : null,
            url: typeof ms.url === 'string' && /^https?:\/\//i.test(ms.url) ? ms.url.slice(0, 500) : null,
          },
          { ...extra, importedJsonId: jsonId },
        );
        sourceIds.set(jsonId.toLowerCase(), created.id);
        report.sources.push({ id: created.id, jsonId: created.jsonId, fullName: created.fullName, created: true });
      } catch (e) {
        report.warnings.push(`${fileName}: source "${jsonId}": ${e instanceof HttpError ? e.message : (e as Error).message}`);
      }
    }
    if (!sourceIds.size) return;
    this.importEntities(userId, fileName, doc, sourceIds, report);
  }

  /** Imports a document's entities into an existing source (campaign import), whatever `_meta` says. */
  importInto(userId: string, sourceId: string, doc: JsonObject): Report {
    const report = emptyReport();
    const source = this.homebrew.source(sourceId);
    this.homebrew.batch(() => {
      this.importEntities(userId, 'campaign', doc, new Map([[source.jsonIdLower, source.id]]), report);
      if (report.created || report.updated) this.homebrew.syncIndex();
    });
    return report;
  }

  private importEntities(userId: string, fileName: string, doc: JsonObject, sourceIds: Map<string, string>, report: Report) {
    const firstSourceId = sourceIds.values().next().value as string;

    // Fluff by kind|name|source
    const fluff = new Map<string, JsonObject>();
    for (const [prop, value] of Object.entries(doc)) {
      const kind = kindForFluffProp(prop);
      if (!kind || !Array.isArray(value)) continue;
      for (const f of value) if (isObject(f) && typeof f.name === 'string') fluff.set(`${kind}|${f.name.toLowerCase()}|${String(f.source ?? '').toLowerCase()}`, f);
    }

    // Entities: plain ones first, then `_copy` variants (their parents may be in this file)
    const entities: { prop: string; ent: unknown }[] = [];
    for (const [prop, value] of Object.entries(doc)) {
      if (!isEntityProp(prop) || !Array.isArray(value)) continue;
      for (const ent of value) entities.push({ prop, ent });
    }
    entities.sort((a, b) => Number(isObject(a.ent) && !!a.ent._copy) - Number(isObject(b.ent) && !!b.ent._copy));
    if (entities.length > MAX_ENTITIES_PER_IMPORT) {
      report.warnings.push(`${fileName}: only the first ${MAX_ENTITIES_PER_IMPORT} entities were imported`);
      entities.length = MAX_ENTITIES_PER_IMPORT;
    }
    let schemaWarnings = 0;
    for (const { prop, ent } of entities) {
      const label = isObject(ent) && typeof ent.name === 'string' ? ent.name : '(unnamed)';
      try {
        const errors = appErrors(prop, ent);
        if (errors.length || !isObject(ent)) {
          report.skipped.push({ type: prop, name: label, reason: errors.map((e) => e.message).join('; ') || 'Not an object' });
          continue;
        }
        let sourceId = sourceIds.get(String(ent.source ?? '').toLowerCase());
        if (!sourceId) {
          sourceId = firstSourceId;
          if (ent.source) report.warnings.push(`${label} (${prop}): source "${String(ent.source)}" is not in _meta.sources; imported into ${[...sourceIds.keys()][0]}`);
        }
        const source = this.homebrew.source(sourceId);
        const kind = prop === 'subrace' ? null : kindForProp(prop);
        const fluffProp = kind ? KINDS[kind].fluffProp : undefined;
        const entFluff = fluffProp ? (fluff.get(`${kind}|${label.toLowerCase()}|${String(ent.source ?? source.jsonId).toLowerCase()}`) ?? null) : null;
        const validation = this.homebrew.validate(source, prop, ent, { force: true });
        const schemaIssues = validation.warnings.filter((w) => w.message.startsWith('5etools schema'));
        if (schemaIssues.length && schemaWarnings++ < 50) {
          report.warnings.push(`${label} (${prop}): ${schemaIssues[0]!.message}${schemaIssues[0]!.path ? ` at ${schemaIssues[0]!.path}` : ''}${schemaIssues.length > 1 ? ` (+${schemaIssues.length - 1} more)` : ''}`);
        }
        const existing = this.db
          .select()
          .from(homebrewEntities)
          .where(
            and(
              eq(homebrewEntities.sourceId, sourceId),
              eq(homebrewEntities.entityType, prop),
              eq(homebrewEntities.nameLower, label.trim().toLowerCase()),
              isNull(homebrewEntities.deletedAt),
            ),
          )
          .get();
        const data = { ...ent, source: source.jsonId };
        if (existing) {
          if (stableStringify(existing.data) === stableStringify(data) && stableStringify(existing.fluff ?? null) === stableStringify(entFluff)) {
            report.unchanged++;
            continue;
          }
          this.homebrew.update(existing.id, userId, data, entFluff, `Imported from ${fileName}`);
          report.updated++;
        } else {
          this.homebrew.create(sourceId, userId, prop, data, entFluff, `Imported from ${fileName}`);
          report.created++;
        }
      } catch (e) {
        report.skipped.push({ type: prop, name: label, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    if (schemaWarnings > 50) report.warnings.push(`${schemaWarnings - 50} more entities have 5etools schema warnings`);
  }

  /** A 5etools homebrew document for one source (valid against the 5etools homebrew schema). */
  exportSource(userId: string, sourceId: string): JsonObject {
    const dto = this.homebrew.getSource(userId, sourceId);
    const source = this.homebrew.source(sourceId);
    const rows = this.db
      .select()
      .from(homebrewEntities)
      .where(and(eq(homebrewEntities.sourceId, sourceId), isNull(homebrewEntities.deletedAt)))
      .orderBy(homebrewEntities.entityType, homebrewEntities.nameLower)
      .all();
    const extra = isObject(source.metaExtra) ? { ...source.metaExtra } : {};
    const arrays = isObject(extra[EXTRA_ARRAYS]) ? (extra[EXTRA_ARRAYS] as JsonObject) : {};
    delete extra[EXTRA_ARRAYS];
    const lastModified = Math.max(source.updatedAt, ...rows.map((r) => r.updatedAt));
    const ms = metaSource(source);
    const doc: JsonObject = {
      _meta: {
        sources: [{ ...ms, authors: ms.authors.length ? ms.authors : [dto.ownerName ?? 'Unknown'], convertedBy: ms.authors.length ? ms.authors : [dto.ownerName ?? 'Unknown'] }],
        dateAdded: Math.floor(source.createdAt / 1000),
        dateLastModified: Math.floor(lastModified / 1000),
        edition: editionToMeta(dto.edition),
        ...extra,
      },
    };
    const push = (prop: string, value: unknown) => ((doc[prop] ??= []) as unknown[]).push(value);
    for (const r of rows) {
      const data: JsonObject = { ...(r.data as JsonObject), source: source.jsonId };
      push(r.entityType, data);
      const kind = r.entityType === 'subrace' ? null : kindForProp(r.entityType);
      const fluffProp = kind ? KINDS[kind].fluffProp : undefined;
      if (fluffProp && isObject(r.fluff)) push(fluffProp, { ...r.fluff, name: r.name, source: source.jsonId });
    }
    for (const [prop, value] of Object.entries(arrays)) if (Array.isArray(value) && !doc[prop]) doc[prop] = value;
    return doc;
  }
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
