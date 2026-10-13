/**
 * Turns raw 5etools JSON files into resolved, typed entities: `_copy` resolution, race/subrace merging,
 * magic item variants, `_versions`, fluff attachment and spell class lists. Pure (no IO); never throws on
 * bad data — problems are reported as warnings.
 */
import { CopyResolver } from '../copy/resolver';
import type { CopyTemplate } from '../copy/apply';
import { expandItems } from '../expand/items';
import { mergeRacesAndSubraces } from '../expand/races';
import { expandVersions, hasVersions } from '../expand/versions';
import { entityUid, identityKey, KINDS, kindForFluffProp, kindForProp, type EntityKind } from '../kinds';
import { isObject, type JsonObject } from '../util/object';
import { normalizeKey } from '../util/string';

export interface RawDataFile {
  /** Path relative to the data root, e.g. `bestiary/bestiary-mm.json`. */
  path: string;
  json: unknown;
}

export interface ResolvedEntity {
  kind: EntityKind;
  /** Original 5etools prop (`baseitem`, `subrace`, …) or a synthetic one for generated entities. */
  prop: string;
  identity: string;
  uid: string;
  name: string;
  source: string;
  data: JsonObject;
  /** The entity as it appears in the data file; null for generated entities (variants, versions, merged subraces). */
  raw: JsonObject | null;
  file: string | null;
  /** uid this entity was generated from (version parent, generic variant, base race). */
  generatedFrom: string | null;
  fluff: JsonObject | null;
}

export interface BuildStats {
  files: number;
  rawEntities: number;
  entities: number;
  byKind: Record<string, number>;
  copyResolved: number;
  versions: number;
  specificVariants: number;
  ignoredProps: Record<string, number>;
}

export interface BuildResult {
  entities: ResolvedEntity[];
  warnings: string[];
  stats: BuildStats;
}

/** Top-level props that are not entities but are consumed by the builder. */
const AUX_PROPS = new Set(['monsterTemplate', 'legendaryGroupTemplate', '_meta']);
const FILE_SKIP = /(^|\/)(foundry[^/]*|makebrew[^/]*|makecards|renderdemo|converter|changelog|life|names|msbcr|monsterfeatures|encounterbuilder)\.json$/;

export interface RawCollection {
  byProp: Map<string, { ent: JsonObject; file: string }[]>;
  spellSources: unknown | null;
  ignoredProps: Record<string, number>;
  files: number;
}

/** Item properties/types may only carry an abbreviation; their display name lives in `entries[0].name`. */
function displayNameFallback(data: JsonObject): string | undefined {
  const first = Array.isArray(data.entries) ? data.entries[0] : undefined;
  if (isObject(first) && typeof first.name === 'string') return first.name;
  return typeof data.abbreviation === 'string' ? data.abbreviation : undefined;
}

export function collectRaw(files: RawDataFile[]): RawCollection {
  const byProp = new Map<string, { ent: JsonObject; file: string }[]>();
  const ignoredProps: Record<string, number> = {};
  let spellSources: unknown = null;
  let count = 0;
  for (const file of files) {
    if (FILE_SKIP.test(file.path)) continue;
    if (/^(adventure|book|generated)\//.test(file.path)) continue;
    count++;
    if (file.path === 'spells/sources.json') {
      spellSources = file.json;
      continue;
    }
    if (!isObject(file.json)) continue;
    for (const [prop, arr] of Object.entries(file.json)) {
      if (!Array.isArray(arr)) continue;
      if (!kindForProp(prop) && !kindForFluffProp(prop) && !AUX_PROPS.has(prop) && prop !== 'subrace') {
        ignoredProps[prop] = (ignoredProps[prop] ?? 0) + arr.length;
        continue;
      }
      const list = byProp.get(prop) ?? [];
      for (const ent of arr) {
        if (!isObject(ent)) continue;
        if (typeof ent.name === 'string' || typeof ent.abbreviation === 'string') list.push({ ent, file: file.path });
      }
      byProp.set(prop, list);
    }
  }
  return { byProp, spellSources, ignoredProps, files: count };
}

export interface BuildOptions {
  /** Additional raw entities (e.g. homebrew) resolved together with the official data. */
  extra?: { prop: string; ent: JsonObject; file: string | null }[];
  /** Restrict output to these kinds (for tests). */
  kinds?: EntityKind[];
}

export function buildDataset(files: RawDataFile[], opts: BuildOptions = {}): BuildResult {
  const raw = collectRaw(files);
  for (const extra of opts.extra ?? []) {
    const list = raw.byProp.get(extra.prop) ?? [];
    list.push({ ent: extra.ent, file: extra.file ?? '' });
    raw.byProp.set(extra.prop, list);
  }
  return buildFromCollection(raw, opts);
}

export function buildFromCollection(raw: RawCollection, opts: BuildOptions = {}): BuildResult {
  const warnings: string[] = [];
  const stats: BuildStats = {
    files: raw.files,
    rawEntities: 0,
    entities: 0,
    byKind: {},
    copyResolved: 0,
    versions: 0,
    specificVariants: 0,
    ignoredProps: raw.ignoredProps,
  };

  // Identity lookup (first entity wins, matching 5etools' "earlier = better")
  const lookup = new Map<string, Map<string, JsonObject>>();
  const fileOf = new WeakMap<JsonObject, string>();
  for (const [prop, list] of raw.byProp) {
    const map = new Map<string, JsonObject>();
    for (const { ent, file } of list) {
      stats.rawEntities++;
      fileOf.set(ent, file);
      const key = identityKey(prop, ent);
      if (!map.has(key)) map.set(key, ent);
    }
    lookup.set(prop, map);
  }

  const templates: Record<string, CopyTemplate[]> = {
    monster: (raw.byProp.get('monsterTemplate') ?? []).map(({ ent }) => ent as unknown as CopyTemplate),
    legendaryGroup: (raw.byProp.get('legendaryGroupTemplate') ?? []).map(({ ent }) => ent as unknown as CopyTemplate),
  };
  const resolver = new CopyResolver((prop, key) => lookup.get(prop)?.get(key), { templatesFor: (prop) => templates[prop] });

  const resolveAll = (prop: string): { data: JsonObject; raw: JsonObject }[] =>
    (raw.byProp.get(prop) ?? []).map(({ ent }) => {
      const data = resolver.resolve(prop, ent);
      if (data !== ent) stats.copyResolved++;
      return { data, raw: ent };
    });

  // Fluff, keyed by kind + name|source
  const fluffByKey = new Map<string, JsonObject>();
  for (const prop of raw.byProp.keys()) {
    const kind = kindForFluffProp(prop);
    if (!kind) continue;
    for (const { data } of resolveAll(prop)) {
      const key = `${kind}::${normalizeKey(String(data.name))}|${normalizeKey(String(data.source))}`;
      if (!fluffByKey.has(key)) fluffByKey.set(key, data);
    }
  }
  const findFluff = (kind: EntityKind, data: JsonObject): JsonObject | null => {
    const candidates: [unknown, unknown][] = [
      [data.name, data.source],
      [data._versionBase_name, data._versionBase_source],
      [data._baseName, data._baseSource],
    ];
    for (const [name, source] of candidates) {
      if (name == null || source == null) continue;
      const hit = fluffByKey.get(`${kind}::${normalizeKey(String(name))}|${normalizeKey(String(source))}`);
      if (hit) return hit;
    }
    return null;
  };

  // Spell class lists
  const spellClasses = new Map<string, unknown>();
  if (isObject(raw.spellSources)) {
    for (const [src, spells] of Object.entries(raw.spellSources)) {
      if (!isObject(spells)) continue;
      for (const [name, meta] of Object.entries(spells)) {
        if (isObject(meta) && Array.isArray(meta.class)) spellClasses.set(`${normalizeKey(name)}|${normalizeKey(src)}`, meta.class);
      }
    }
  }

  const out: ResolvedEntity[] = [];
  const seen = new Set<string>();
  const wantKind = (k: EntityKind) => !opts.kinds || opts.kinds.includes(k);

  const emit = (kind: EntityKind, prop: string, data: JsonObject, rawEnt: JsonObject | null, generatedFrom: string | null) => {
    const name = typeof data.name === 'string' ? data.name : displayNameFallback(data);
    const source = data.source;
    if (typeof name !== 'string' || typeof source !== 'string') {
      warnings.push(`${prop}: entity without name/source skipped`);
      return;
    }
    const identity = identityKey(prop === 'subrace' || prop === 'baseitem' || prop === 'magicvariant' || prop === 'itemGroup' ? 'item' : prop, data);
    const uid = entityUid(kind, identity);
    if (seen.has(uid)) {
      warnings.push(`Duplicate ${kind} "${name}" (${source}) — keeping the first`);
      return;
    }
    seen.add(uid);
    if (kind === 'spell') {
      const classes = spellClasses.get(`${normalizeKey(name)}|${normalizeKey(source)}`);
      if (classes) data = { ...data, _classes: classes };
    }
    out.push({
      kind,
      prop,
      identity,
      uid,
      name,
      source,
      data,
      raw: rawEnt,
      file: rawEnt ? (fileOf.get(rawEnt) ?? null) : null,
      generatedFrom,
      fluff: findFluff(kind, data),
    });
    stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
  };

  const emitWithVersions = (kind: EntityKind, prop: string, data: JsonObject, rawEnt: JsonObject | null, generatedFrom: string | null) => {
    emit(kind, prop, data, rawEnt, generatedFrom);
    if (!hasVersions(prop, data)) return;
    const parentUid = entityUid(kind, identityKey(prop, data));
    const { versions, warnings: w } = expandVersions(prop, data, { templates: templates[prop], mergeRequiresPreserve: KINDS[kind].mergeRequiresPreserve });
    warnings.push(...w);
    for (const v of versions) {
      stats.versions++;
      emit(kind, prop, v, null, parentUid);
    }
  };

  for (const def of Object.values(KINDS)) {
    if (!wantKind(def.kind)) continue;
    switch (def.kind) {
      case 'race': {
        const races = resolveAll('race');
        const subraces = resolveAll('subrace');
        const rawByName = new Map(races.map((r) => [`${normalizeKey(String(r.data.name))}|${normalizeKey(String(r.data.source))}`, r.raw]));
        const { races: merged, warnings: w } = mergeRacesAndSubraces(
          races.map((r) => r.data),
          subraces.map((s) => s.data),
        );
        warnings.push(...w);
        for (const race of merged) {
          const isSub = !!race._subraceName || (race._baseName != null && !race._isBaseRace);
          const rawEnt = isSub ? null : (rawByName.get(`${normalizeKey(String(race._rawName ?? race.name))}|${normalizeKey(String(race.source))}`) ?? null);
          const parentUid = isSub ? entityUid('race', `${normalizeKey(String(race._baseName))}|${normalizeKey(String(race._baseSource))}`) : null;
          emitWithVersions('race', 'race', race, rawEnt, parentUid);
        }
        break;
      }
      case 'item': {
        const items = [...resolveAll('item'), ...resolveAll('itemGroup').map((it) => ({ ...it, data: { ...it.data, _isItemGroup: true } }))];
        for (const { data, raw: r } of items) emitWithVersions('item', 'item', data, r, null);
        const bases = resolveAll('baseitem');
        const variants = resolveAll('magicvariant');
        const { items: expanded, specificCount } = expandItems(
          bases.map((b) => b.data),
          variants.map((v) => v.data),
        );
        stats.specificVariants += specificCount;
        const rawOf = new Map<string, JsonObject>();
        for (const { data, raw: r } of [...bases, ...variants]) rawOf.set(`${normalizeKey(String(data.name))}|${normalizeKey(String(data.source))}`, r);
        for (const it of expanded) {
          const isSpecific = it._category === 'Specific Variant';
          const prop = it._category === 'Generic Variant' ? 'magicvariant' : isSpecific ? 'item' : 'baseitem';
          const rawEnt = isSpecific ? null : (rawOf.get(`${normalizeKey(String(it.name))}|${normalizeKey(String(it.source))}`) ?? null);
          const generatedFrom = isSpecific && isObject(it.genericVariant)
            ? entityUid('item', `${normalizeKey(String(it.genericVariant.name))}|${normalizeKey(String(it.genericVariant.source))}`)
            : null;
          emit('item', prop, it, rawEnt, generatedFrom);
        }
        break;
      }
      default:
        for (const prop of def.props) for (const { data, raw: r } of resolveAll(prop)) emitWithVersions(def.kind, prop, data, r, null);
    }
  }

  warnings.push(...resolver.warnings);
  stats.entities = out.length;
  return { entities: out, warnings, stats };
}
