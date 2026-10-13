/**
 * Race/subrace merging (5etools `DataUtil.race.getPostProcessedSiteJson` + `Renderer.race.mergeSubraces`).
 * Produces base races (flagged `_isBaseRace`, with `_subraces`) plus one merged entity per subrace,
 * e.g. "Elf (High)".
 */
import { ABILITIES } from '../constants';
import { isClassicEditionValue } from '../edition/sources';
import { clone, isObject, type JsonObject } from '../util/object';

export interface RaceMergeResult {
  races: JsonObject[];
  warnings: string[];
}

export function subraceName(raceName: string, subName: string | undefined | null): string {
  if (!subName) return raceName;
  const m = /^(.*?)(\(.*?\))$/i.exec(raceName || '');
  if (!m) return `${raceName} (${subName})`;
  const bracket = m[2]!.slice(1, -1);
  return `${m[1]}(${[bracket, subName].join('; ')})`;
}

function applyLineage(race: JsonObject): JsonObject {
  if (!race.lineage || race.lineage === true || !(isClassicEditionValue(race.edition) || race.edition == null)) return race;
  const r = clone(race);
  const weighted = (weights: number[]) => ({ choose: { weighted: { from: [...ABILITIES], weights } } });
  if (r.lineage === 'VRGR') r.ability ??= [weighted([2, 1]), weighted([1, 1, 1])];
  else if (r.lineage === 'UA1') r.ability ??= [weighted([2, 1])];
  if (!r.languageProficiencies) {
    r.entries = [
      ...(Array.isArray(r.entries) ? r.entries : []),
      {
        type: 'entries',
        name: 'Languages',
        entries: ['You can speak, read, and write Common and one other language that you and your DM agree is appropriate for your character.'],
      },
    ];
    r.languageProficiencies = [{ common: true, anyStandard: 1 }];
  }
  return r;
}

function mergeSubrace(race: JsonObject, sr: JsonObject): JsonObject {
  const cpy = clone(race);
  const cpySr = clone(sr);
  cpy._baseName = cpy.name;
  cpy._baseSource = cpy.source;
  cpy._baseSrd = cpy.srd;
  cpy._baseSrd52 = cpy.srd52;
  cpy._baseBasicRules = cpy.basicRules;
  cpy._baseBasicRules2024 = cpy.basicRules2024;
  for (const k of ['subraces', 'srd', 'srd52', 'basicRules', 'basicRules2024', '_versions', 'hasFluff', 'hasFluffImages', 'reprintedAs']) delete cpy[k];
  delete cpySr.raceName;
  delete cpySr.raceSource;

  if (cpySr.name) {
    cpy._subraceName = cpySr.name;
    cpy.name = subraceName(String(cpy.name), String(cpySr.name));
    delete cpySr.name;
  }
  const overwrite = isObject(cpySr.overwrite) ? cpySr.overwrite : {};
  if (Array.isArray(cpySr.ability)) {
    if (overwrite.ability || !Array.isArray(cpy.ability)) cpy.ability = (cpySr.ability as unknown[]).map(() => ({}));
    const base = cpy.ability as JsonObject[];
    if (base.length !== cpySr.ability.length) throw new Error('"race" and "subrace" ability array lengths did not match');
    (cpySr.ability as JsonObject[]).forEach((obj, i) => Object.assign(base[i]!, obj));
    delete cpySr.ability;
  }
  if (Array.isArray(cpySr.entries)) {
    const entries = (cpy.entries = Array.isArray(cpy.entries) ? cpy.entries : []) as unknown[];
    for (const ent of cpySr.entries as JsonObject[]) {
      const ow = isObject(ent) && isObject(ent.data) ? ent.data.overwrite : undefined;
      if (typeof ow !== 'string') {
        entries.push(ent);
        continue;
      }
      const ix = entries.findIndex((it) => isObject(it) && String(it.name ?? '').toLowerCase().trim() === ow.toLowerCase().trim());
      if (ix >= 0) entries[ix] = ent;
      else entries.push(ent);
    }
    delete cpySr.entries;
  }
  for (const prop of ['traitTags', 'languageProficiencies']) {
    if (!Array.isArray(cpySr[prop])) continue;
    cpy[prop] = overwrite[prop] ? cpySr[prop] : [...(Array.isArray(cpy[prop]) ? (cpy[prop] as unknown[]) : []), ...(cpySr[prop] as unknown[])];
    delete cpySr[prop];
  }
  if (Array.isArray(cpySr.skillProficiencies)) {
    if (!Array.isArray(cpy.skillProficiencies) || overwrite.skillProficiencies) cpy.skillProficiencies = cpySr.skillProficiencies;
    else if (cpySr.skillProficiencies.length === 1 && cpy.skillProficiencies.length === 1) {
      Object.assign(cpy.skillProficiencies[0] as JsonObject, cpySr.skillProficiencies[0]);
    } else cpy.skillProficiencies = cpySr.skillProficiencies;
    delete cpySr.skillProficiencies;
  }
  Object.assign(cpy, cpySr);
  for (const [k, v] of Object.entries(cpy)) if (v == null) delete cpy[k];
  return cpy;
}

/**
 * @param races resolved `race` entities (after `_copy`)
 * @param subraces resolved `subrace` entities (after `_copy`); each names its parent via raceName/raceSource
 */
export function mergeRacesAndSubraces(races: JsonObject[], subraces: JsonObject[]): RaceMergeResult {
  const warnings: string[] = [];
  const work = races.map((r) => clone(r));
  const key = (name: unknown, source: unknown) => `${String(name).toLowerCase()}|${String(source).toLowerCase()}`;
  const byKey = new Map<string, JsonObject>();
  for (const r of work) if (!byKey.has(key(r.name, r.source))) byKey.set(key(r.name, r.source), r);

  for (const sr of subraces) {
    const parent = byKey.get(key(sr.raceName, sr.raceSource));
    if (!parent) {
      warnings.push(`Subrace "${String(sr.name)}" (${String(sr.source)}): parent race "${String(sr.raceName)}" (${String(sr.raceSource)}) not found`);
      continue;
    }
    (parent.subraces = Array.isArray(parent.subraces) ? parent.subraces : []).push(sr);
  }

  const out: JsonObject[] = [];
  for (const raw of work) {
    const race = applyLineage(raw);
    if (Array.isArray(race.size) === false && typeof race.size === 'string') race.size = [race.size];
    const subs = Array.isArray(race.subraces) ? (race.subraces as JsonObject[]) : [];
    if (!subs.length) {
      delete race.subraces;
      out.push(race);
      continue;
    }
    for (const sr of subs) sr.source ??= race.source;
    subs.sort((a, b) => String(a.name ?? '_').toLowerCase().localeCompare(String(b.name ?? '_').toLowerCase()));

    const base = clone(race);
    delete base.subraces;
    base._isBaseRace = true;
    if (subs.some((s) => !s.name)) {
      base._rawName = base.name;
      base.name = `${String(base.name)} (Base)`;
    }
    base._subraces = subs.map((s) => ({ name: subraceName(String(race.name), s.name as string | undefined), source: s.source }));
    out.push(base);

    for (const sr of subs) {
      try {
        out.push(mergeSubrace(race, sr));
      } catch (err) {
        warnings.push(`Subrace "${String(sr.name)}" of "${String(race.name)}": ${(err as Error).message}`);
      }
    }
  }
  return { races: out, warnings };
}
