/**
 * `_copy` / `_mod` application, re-implementing 5etools' `DataUtil.generic.copyApplier` (MIT).
 * Differences: no `eval` (safe arithmetic instead), and a failing mod is recorded as a warning instead of
 * aborting the whole entity.
 */
import { ABILITIES, abilityModifier, crToProficiencyBonus, crToXp, SIZES, SKILL_TO_ABILITY } from '../constants';
import { splitByTags } from '../tags/tokenize';
import {
  asArray,
  clone,
  deepEquals,
  deletePath,
  getOrSetPath,
  getPath,
  isObject,
  mapStrings,
  setPath,
  type JsonObject,
} from '../util/object';
import { cleanMathExpression, evaluateArithmetic } from '../util/safe-math';
import { resolveVariables } from './variables';

/** Props a `_copy` child only inherits when explicitly `_preserve`d. */
export const MERGE_REQUIRES_PRESERVE_BASE = new Set([
  'page',
  'otherSources',
  'referenceSources',
  'srd',
  'srd52',
  'basicRules',
  'basicRules2024',
  'freeRules2024',
  'reprintedAs',
  'hasFluff',
  'hasFluffImages',
  'hasToken',
  'tokenCredit',
  'tokenCustom',
  'foundryTokenScale',
  'altArt',
  '_versions',
]);

/** Props targeted by a `"*"` mod key. */
export const COPY_ENTRY_PROPS = [
  'action', 'bonus', 'reaction', 'trait', 'legendary', 'mythic', 'variant', 'spellcasting',
  'actionHeader', 'bonusHeader', 'reactionHeader', 'legendaryHeader', 'mythicHeader',
];

const SPELL_USES_KEYS = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
const SPELL_USES_KEYS_EACH = new Set(['1e', '2e', '3e', '4e', '5e', '6e', '7e', '8e', '9e']);
const isSpellUsesKey = (k: string) => SPELL_USES_KEYS.has(k) || SPELL_USES_KEYS_EACH.has(k);

export interface CopyTemplate {
  name: string;
  source: string;
  apply?: { _mod?: JsonObject; _root?: JsonObject };
}

export interface ApplyCopyOptions {
  /** Kind-specific props that require `_preserve` (on top of the base set). */
  mergeRequiresPreserve?: Iterable<string>;
  /** Templates available to `_copy._templates` (e.g. `monsterTemplate`). */
  templates?: CopyTemplate[];
}

export interface ApplyCopyResult {
  entity: JsonObject;
  warnings: string[];
}

type ModInfo = JsonObject & { mode?: string };

class ModError extends Error {}

/**
 * Merges a resolved parent into a child carrying `_copy`. Neither input is mutated.
 */
export function applyCopy(parent: JsonObject, child: JsonObject, opts: ApplyCopyOptions = {}): ApplyCopyResult {
  const warnings: string[] = [];
  const copyFrom = clone(parent);
  const copyTo = clone(child);
  const copyMeta: JsonObject = isObject(copyTo._copy) ? copyTo._copy : {};
  const label = `"${String(copyTo.name)}" (${String(copyTo.source)})`;

  const mods: Record<string, unknown[]> = {};
  if (isObject(copyMeta._mod)) for (const [k, v] of Object.entries(copyMeta._mod)) mods[k] = asArray(v);

  // External templates: append their mods, remember their root props
  const templatesToApply: CopyTemplate[] = [];
  if (Array.isArray(copyMeta._templates) && copyMeta._templates.length) {
    for (const ref of copyMeta._templates as JsonObject[]) {
      const name = String(ref.name ?? '').toLowerCase().trim();
      const source = String(ref.source ?? '').toLowerCase().trim();
      const template = opts.templates?.find(
        (t) => t.name.toLowerCase().trim() === name && t.source.toLowerCase().trim() === source,
      );
      if (!template) {
        warnings.push(`${label}: could not find template "${String(ref.name)}" (${String(ref.source)})`);
        continue;
      }
      const tpl = clone(template);
      templatesToApply.push(tpl);
      if (isObject(tpl.apply?._mod)) {
        for (const [k, v] of Object.entries(tpl.apply._mod)) mods[k] = [...(mods[k] ?? []), ...asArray(v)];
      }
    }
    copyTo._copy_templates = (copyMeta._templates as JsonObject[]).map((t) => ({ name: t.name, source: t.source }));
  }

  // Base copy
  const preserve = isObject(copyMeta._preserve) ? copyMeta._preserve : {};
  const requiresPreserve = new Set([...MERGE_REQUIRES_PRESERVE_BASE, ...(opts.mergeRequiresPreserve ?? [])]);
  const childRootProps = new Set(Object.keys(copyTo));
  for (const k of Object.keys(copyFrom)) {
    if (copyTo[k] === null) {
      delete copyTo[k];
      continue;
    }
    if (copyTo[k] === undefined) {
      if (requiresPreserve.has(k)) {
        if (preserve['*'] || preserve[k]) copyTo[k] = copyFrom[k];
      } else copyTo[k] = copyFrom[k];
    }
  }

  for (const tpl of templatesToApply) {
    if (!isObject(tpl.apply?._root)) continue;
    for (const [k, v] of Object.entries(tpl.apply._root)) if (!childRootProps.has(k)) copyTo[k] = v;
  }

  // Mods: plain props first, then "_" (root-level), then "*" (all entry props)
  const order = (p: string) => ['_', '*'].indexOf(p);
  const entries = Object.entries(mods).sort(([a], [b]) => order(a) - order(b));
  for (const [prop, rawModInfos] of entries) {
    let modInfos: unknown[];
    try {
      modInfos = resolveVariables(rawModInfos, copyTo);
    } catch (err) {
      warnings.push(`${label}: ${(err as Error).message}`);
      continue;
    }
    const propPaths: (string[] | null)[] =
      prop === '*' ? COPY_ENTRY_PROPS.map((p) => [p]) : prop === '_' ? [null] : [prop.split('.')];
    for (const propPath of propPaths) {
      for (const modInfo of modInfos) {
        try {
          applyMod(copyTo, copyFrom, modInfo, propPath);
        } catch (err) {
          if (prop === '*' && err instanceof ModError) continue; // "*" mods are best-effort per prop
          warnings.push(`${label}: ${(err as Error).message}`);
        }
      }
    }
  }

  copyTo._isCopy = true;
  delete copyTo._copy;
  return { entity: copyTo, warnings };
}

function applyMod(copyTo: JsonObject, copyFrom: JsonObject, modInfo: unknown, propPath: string[] | null): void {
  if (typeof modInfo === 'string') {
    if (modInfo === 'remove') {
      if (propPath) deletePath(copyTo, propPath);
      return;
    }
    throw new Error(`Unhandled mode "${modInfo}"`);
  }
  if (!isObject(modInfo)) throw new Error('Invalid mod');
  const m = modInfo as ModInfo;
  const path = propPath ?? [];

  switch (m.mode) {
    case 'appendStr':
      return modAppendStr(copyTo, m, path);
    case 'replaceName':
      return modReplaceName(copyTo, m, path);
    case 'replaceTxt':
      return modReplaceTxt(copyTo, m, path);
    case 'prependArr':
      return modPrependArr(copyTo, m, path);
    case 'appendArr':
      return modAppendArr(copyTo, m, path);
    case 'replaceArr':
      modReplaceArr(copyTo, m, path, true);
      return;
    case 'replaceOrAppendArr':
      if (!modReplaceArr(copyTo, m, path, false)) modAppendArr(copyTo, m, path);
      return;
    case 'appendIfNotExistsArr':
      return modAppendIfNotExistsArr(copyTo, m, path);
    case 'insertArr':
      return modInsertArr(copyTo, m, path);
    case 'removeArr':
      return modRemoveArr(copyTo, m, path);
    case 'renameArr':
      return modRenameArr(copyTo, m, path);
    case 'calculateProp':
      return modCalculateProp(copyTo, m, path);
    case 'scalarAddProp':
      return modScalarProp(copyTo, m, path, 'add');
    case 'scalarMultProp':
      return modScalarProp(copyTo, m, path, 'mult');
    case 'setProp':
      return modSetProp(copyTo, m, propPath);
    case 'prefixSuffixStringProp':
      return modPrefixSuffix(copyTo, m, propPath);
    case 'addSenses':
      return modAddSenses(copyTo, m);
    case 'addSaves':
      return modAddSaves(copyTo, m.saves as Record<string, number>);
    case 'addSkills':
      return modAddSkills(copyTo, m.skills as Record<string, number>);
    case 'addAllSaves':
      return modAddSaves(copyTo, Object.fromEntries(ABILITIES.map((a) => [a, Number(m.saves)])));
    case 'addAllSkills':
      return modAddSkills(copyTo, Object.fromEntries(Object.keys(SKILL_TO_ABILITY).map((s) => [s, Number(m.skills)])));
    case 'addSpells':
      return modAddSpells(copyTo, m);
    case 'replaceSpells':
      return modReplaceSpells(copyTo, m);
    case 'removeSpells':
      return modRemoveSpells(copyTo, m);
    case 'maxSize':
      return modMaxSize(copyTo, m);
    case 'scalarMultXp':
      return modScalarMultXp(copyTo, m);
    case 'scalarAddHit':
      return modScalarAddInTags(copyTo, m, path, /{@hit ([-+]?\d+)}/g, (n) => `{@hit ${n}}`);
    case 'scalarAddDc':
      return modScalarAddInTags(copyTo, m, path, /{@dc (\d+)(?:\|[^}]+)?}/g, (n) => `{@dc ${n}}`);
    default:
      throw new Error(`Unhandled mode "${String(m.mode)}"`);
  }
}

// region String mods

function makeReplacer(m: ModInfo): (str: string) => string {
  const re = new RegExp(String(m.replace), `g${typeof m.flags === 'string' ? m.flags : ''}`);
  const withStr = String(m.with ?? '');
  if (m.tagInsensitive) return (str) => str.replace(re, withStr);
  return (str) =>
    splitByTags(str)
      .map((seg) => (seg.startsWith('{@') ? seg : seg.replace(re, withStr)))
      .join('');
}

function modAppendStr(copyTo: JsonObject, m: ModInfo, path: string[]) {
  const existing = getPath(copyTo, path);
  setPath(copyTo, path, existing ? `${String(existing)}${String(m.joiner ?? '')}${String(m.str)}` : m.str);
}

function modReplaceName(copyTo: JsonObject, m: ModInfo, path: string[]) {
  const ents = getPath(copyTo, path);
  if (!Array.isArray(ents)) return;
  const replace = makeReplacer(m);
  for (const ent of ents) if (isObject(ent) && typeof ent.name === 'string') ent.name = replace(ent.name);
}

function modReplaceTxt(copyTo: JsonObject, m: ModInfo, path: string[]) {
  const ents = getPath(copyTo, path);
  if (!Array.isArray(ents)) return;
  const replace = makeReplacer(m);
  const props: (string | null)[] = Array.isArray(m.props) ? (m.props as (string | null)[]) : [null, 'entries', 'headerEntries', 'footerEntries'];
  if (!props.length) return;
  let next = ents;
  if (props.includes(null)) {
    next = ents.map((it) => (typeof it === 'string' ? replace(it) : it));
    setPath(copyTo, path, next);
  }
  for (const ent of next) {
    if (!isObject(ent)) continue;
    for (const prop of props) {
      if (prop == null || !ent[prop]) continue;
      ent[prop] = mapStrings(ent[prop], replace);
    }
  }
}

function modPrefixSuffix(copyTo: JsonObject, m: ModInfo, propPath: string[] | null) {
  const path = combinedPath(m, propPath);
  const str = getPath(copyTo, path);
  if (typeof str !== 'string') return;
  setPath(copyTo, path, `${String(m.prefix ?? '')}${str}${String(m.suffix ?? '')}`);
}

// endregion

// region Array mods

function items(m: ModInfo): unknown[] {
  return asArray(m.items as unknown);
}

function modPrependArr(copyTo: JsonObject, m: ModInfo, path: string[]) {
  const existing = getPath(copyTo, path);
  setPath(copyTo, path, Array.isArray(existing) ? [...clone(items(m)), ...existing] : clone(items(m)));
}

function modAppendArr(copyTo: JsonObject, m: ModInfo, path: string[]) {
  const existing = getPath(copyTo, path);
  setPath(copyTo, path, Array.isArray(existing) ? [...existing, ...clone(items(m))] : clone(items(m)));
}

function modAppendIfNotExistsArr(copyTo: JsonObject, m: ModInfo, path: string[]) {
  const existing = getPath(copyTo, path);
  if (!Array.isArray(existing)) return setPath(copyTo, path, clone(items(m)));
  setPath(copyTo, path, [...existing, ...clone(items(m)).filter((it) => !existing.some((x) => deepEquals(it, x)))]);
}

function modReplaceArr(copyTo: JsonObject, m: ModInfo, path: string[], isThrow: boolean): boolean {
  const existing = getPath(copyTo, path);
  if (!Array.isArray(existing)) {
    if (isThrow) throw new ModError(`Could not find "${path.join('.')}" array`);
    return false;
  }
  let ix: number;
  const replace = m.replace;
  if (isObject(replace) && typeof replace.regex === 'string') {
    const re = new RegExp(replace.regex, typeof replace.flags === 'string' ? replace.flags : '');
    ix = existing.findIndex((it) =>
      isObject(it) && it.name ? re.test(String(it.name)) : typeof it === 'string' ? re.test(it) : false,
    );
  } else if (isObject(replace) && typeof replace.index === 'number') {
    ix = replace.index;
  } else {
    ix = existing.findIndex((it) => (isObject(it) && it.name ? it.name === replace : it === replace));
  }
  if (ix >= 0 && ix < existing.length) {
    existing.splice(ix, 1, ...clone(items(m)));
    return true;
  }
  if (isThrow) throw new ModError(`Could not find "${path.join('.')}" item "${JSON.stringify(replace)}" to replace`);
  return false;
}

function modInsertArr(copyTo: JsonObject, m: ModInfo, path: string[]) {
  const existing = getPath(copyTo, path);
  if (!Array.isArray(existing)) throw new ModError(`Could not find "${path.join('.')}" array`);
  const index = typeof m.index === 'number' ? m.index : -1;
  existing.splice(index !== -1 ? index : existing.length, 0, ...clone(items(m)));
}

function modRemoveArr(copyTo: JsonObject, m: ModInfo, path: string[]) {
  const existing = getPath(copyTo, path);
  if (!Array.isArray(existing)) throw new ModError(`Could not find "${path.join('.')}" array`);
  if (m.names != null) {
    for (const name of asArray(m.names as unknown)) {
      const ix = existing.findIndex((it) => isObject(it) && it.name === name);
      if (ix >= 0) existing.splice(ix, 1);
      else if (!m.force) throw new ModError(`Could not find "${path.join('.')}" item named "${String(name)}" to remove`);
    }
  } else if (m.items != null) {
    for (const item of items(m)) {
      const ix = existing.findIndex((it) => it === item || deepEquals(it, item));
      if (ix >= 0) existing.splice(ix, 1);
      else throw new ModError(`Could not find "${path.join('.')}" item to remove`);
    }
  } else throw new Error('removeArr needs "names" or "items"');
}

function modRenameArr(copyTo: JsonObject, m: ModInfo, path: string[]) {
  const existing = getPath(copyTo, path);
  if (!Array.isArray(existing)) throw new ModError(`Could not find "${path.join('.')}" array`);
  for (const rename of asArray(m.renames as unknown)) {
    if (!isObject(rename)) continue;
    const ent = existing.find((it) => isObject(it) && it.name === rename.rename);
    if (!isObject(ent)) throw new ModError(`Could not find "${path.join('.')}" item named "${String(rename.rename)}" to rename`);
    ent.name = rename.with;
  }
}

// endregion

// region Numeric/prop mods

function combinedPath(m: ModInfo, propPath: string[] | null): string[] {
  const out = typeof m.prop === 'string' && m.prop ? m.prop.split('.') : [];
  if (propPath != null && !(propPath.length === 1 && propPath[0] === '*')) out.unshift(...propPath);
  return out;
}

function modSetProp(copyTo: JsonObject, m: ModInfo, propPath: string[] | null) {
  const path = combinedPath(m, propPath);
  if (!path.length) throw new Error('setProp needs a prop');
  setPath(copyTo, path, clone(m.value));
}

function modCalculateProp(copyTo: JsonObject, m: ModInfo, path: string[]) {
  const tgt = getOrSetPath<JsonObject>(copyTo, path, {});
  const formula = String(m.formula ?? '').replace(/<\$([^$]+)\$>/g, (_match, v: string) => {
    switch (v) {
      case 'prof_bonus':
        return String(crToProficiencyBonus(copyTo.cr));
      case 'dex_mod':
        return String(abilityModifier(Number(copyTo.dex ?? 10)));
      default:
        throw new Error(`Unknown variable "${v}"`);
    }
  });
  tgt[String(m.prop)] = evaluateArithmetic(cleanMathExpression(formula));
}

function modScalarProp(copyTo: JsonObject, m: ModInfo, path: string[], op: 'add' | 'mult') {
  const tgt = getPath(copyTo, path);
  if (!isObject(tgt)) return;
  const scalar = Number(m.scalar);
  const applyTo = (k: string) => {
    let out = op === 'add' ? Number(tgt[k]) + scalar : Number(tgt[k]) * scalar;
    if (op === 'mult' && m.floor) out = Math.floor(out);
    tgt[k] = typeof tgt[k] === 'string' ? `${out >= 0 ? '+' : ''}${out}` : out;
  };
  if (m.prop === '*') Object.keys(tgt).forEach(applyTo);
  else applyTo(String(m.prop));
}

function modScalarAddInTags(copyTo: JsonObject, m: ModInfo, path: string[], re: RegExp, fmt: (n: number) => string) {
  const existing = getPath(copyTo, path);
  if (existing == null) return;
  const scalar = Number(m.scalar);
  setPath(copyTo, path, mapStrings(existing, (str) => str.replace(re, (_m, n: string) => fmt(Number(n) + scalar))));
}

function modMaxSize(copyTo: JsonObject, m: ModInfo) {
  const sizes = asArray(copyTo.size as string | string[]).map(String);
  const ixs = sizes.map((s) => SIZES.indexOf(s as (typeof SIZES)[number]));
  const ixMax = SIZES.indexOf(String(m.max) as (typeof SIZES)[number]);
  if (ixMax < 0 || ixs.some((ix) => ix < 0)) throw new Error('Unhandled size');
  const next = ixs.filter((ix) => ix <= ixMax).sort((a, b) => a - b);
  if (!next.length) next.push(ixMax);
  copyTo.size = next.map((ix) => SIZES[ix]);
}

function modScalarMultXp(copyTo: JsonObject, m: ModInfo) {
  const scalar = Number(m.scalar);
  const out = (input: number) => (m.floor ? Math.floor(input * scalar) : input * scalar);
  if (isObject(copyTo.cr) && copyTo.cr.xp != null) {
    copyTo.cr.xp = out(Number(copyTo.cr.xp));
    return;
  }
  const cur = crToXp(copyTo.cr) ?? 0;
  if (!isObject(copyTo.cr)) copyTo.cr = { cr: copyTo.cr };
  (copyTo.cr as JsonObject).xp = out(cur);
}

// endregion

// region Bestiary mods

function modAddSenses(copyTo: JsonObject, m: ModInfo) {
  const senses: string[] = Array.isArray(copyTo.senses) ? (copyTo.senses as string[]) : [];
  copyTo.senses = senses;
  for (const sense of asArray(m.senses as unknown)) {
    if (!isObject(sense)) continue;
    const type = String(sense.type);
    const range = Number(sense.range);
    let found = false;
    for (let i = 0; i < senses.length; ++i) {
      const match = new RegExp(`${type} (\\d+)`, 'i').exec(String(senses[i]));
      if (match) {
        found = true;
        if (Number(match[1]) < range) senses[i] = `${type} ${range} ft.`;
        break;
      }
    }
    if (!found) senses.push(`${type} ${range} ft.`);
  }
}

function formatBonus(total: number): string {
  return total >= 0 ? `+${total}` : String(total);
}

function modAddSaves(copyTo: JsonObject, saves: Record<string, number>) {
  const save = (isObject(copyTo.save) ? copyTo.save : (copyTo.save = {})) as JsonObject;
  for (const [ability, mode] of Object.entries(saves ?? {})) {
    const total = mode * crToProficiencyBonus(copyTo.cr) + abilityModifier(Number(copyTo[ability] ?? 10));
    if (save[ability] != null) {
      if (Number(save[ability]) < total) save[ability] = formatBonus(total);
    } else save[ability] = formatBonus(total);
  }
}

function modAddSkills(copyTo: JsonObject, skills: Record<string, number>) {
  const skill = (isObject(copyTo.skill) ? copyTo.skill : (copyTo.skill = {})) as JsonObject;
  for (const [name, mode] of Object.entries(skills ?? {})) {
    const ability = SKILL_TO_ABILITY[name] ?? 'str';
    const total = mode * crToProficiencyBonus(copyTo.cr) + abilityModifier(Number(copyTo[ability] ?? 10));
    if (skill[name] != null) {
      if (Number(skill[name]) < total) skill[name] = formatBonus(total);
    } else skill[name] = formatBonus(total);
  }
}

const SPELL_FREQ_PROPS = ['recharge', 'legendary', 'charges', 'rest', 'restLong', 'daily', 'weekly', 'monthly', 'yearly'];

function getSpellcasting(copyTo: JsonObject, name?: unknown): JsonObject {
  if (!Array.isArray(copyTo.spellcasting)) throw new Error('Creature did not have a spellcasting property');
  const sc = name
    ? (copyTo.spellcasting as JsonObject[]).find((it) => it.name === name)
    : (copyTo.spellcasting[0] as JsonObject | undefined);
  if (!sc) throw new Error(`Creature did not have spellcasting trait named "${String(name)}"`);
  return sc;
}

function modAddSpells(copyTo: JsonObject, m: ModInfo) {
  const sc = getSpellcasting(copyTo, m.name);
  if (isObject(m.spells)) {
    const spells = (isObject(sc.spells) ? sc.spells : (sc.spells = {})) as JsonObject;
    for (const [k, nu] of Object.entries(m.spells)) {
      if (!spells[k]) {
        spells[k] = clone(nu);
        continue;
      }
      const old = spells[k] as JsonObject;
      for (const [kk, v] of Object.entries(nu as JsonObject)) {
        if (old[kk] == null) old[kk] = clone(v);
        else if (Array.isArray(old[kk])) old[kk] = [...(old[kk] as string[]), ...asArray(v as string)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        else if (typeof old[kk] === 'object') throw new Error(`Object at key ${kk} not an array`);
        else old[kk] = v;
      }
    }
  }
  for (const prop of ['constant', 'will', 'ritual']) {
    if (!Array.isArray(m[prop])) continue;
    sc[prop] = [...asArray(sc[prop] as unknown[]), ...(m[prop] as unknown[])];
  }
  for (const prop of SPELL_FREQ_PROPS) {
    if (!isObject(m[prop])) continue;
    for (const [k, spells] of Object.entries(m[prop] as JsonObject)) {
      if (!isSpellUsesKey(k)) continue;
      const tgt = (isObject(sc[prop]) ? sc[prop] : (sc[prop] = {})) as JsonObject;
      tgt[k] = [...asArray(tgt[k] as unknown[]), ...asArray(spells as unknown[])];
    }
  }
}

function modReplaceSpells(copyTo: JsonObject, m: ModInfo) {
  const sc = getSpellcasting(copyTo);
  const handleReplace = (container: JsonObject, key: string, meta: JsonObject) => {
    const list = container[key];
    if (!Array.isArray(list)) throw new Error(`Could not find spell list "${key}"`);
    const ix = list.indexOf(meta.replace);
    if (ix < 0) throw new Error(`Could not find spell "${String(meta.replace)}" to replace`);
    list.splice(ix, 1, ...asArray(meta.with as unknown));
    list.sort((a: unknown, b: unknown) => String(a).toLowerCase().localeCompare(String(b).toLowerCase()));
  };
  if (isObject(m.spells) && isObject(sc.spells)) {
    for (const [k, metas] of Object.entries(m.spells)) {
      const level = (sc.spells as JsonObject)[k];
      if (!isObject(level)) continue;
      for (const meta of asArray(metas as JsonObject[])) handleReplace(level, 'spells', meta);
    }
  }
  if (isObject(m.daily) && isObject(sc.daily)) {
    for (const [k, metas] of Object.entries(m.daily)) {
      if (!isSpellUsesKey(k)) continue;
      for (const meta of asArray(metas as JsonObject[])) handleReplace(sc.daily as JsonObject, k, meta);
    }
  }
}

function modRemoveSpells(copyTo: JsonObject, m: ModInfo) {
  const sc = getSpellcasting(copyTo);
  if (isObject(m.spells) && isObject(sc.spells)) {
    for (const [k, toRemove] of Object.entries(m.spells)) {
      const level = (sc.spells as JsonObject)[k];
      if (!isObject(level) || !Array.isArray(level.spells)) continue;
      level.spells = (level.spells as unknown[]).filter((it) => !asArray(toRemove as unknown[]).includes(it));
    }
  }
  for (const prop of ['constant', 'will', 'ritual']) {
    if (!Array.isArray(m[prop]) || !Array.isArray(sc[prop])) continue;
    sc[prop] = (sc[prop] as unknown[]).filter((it) => !(m[prop] as unknown[]).includes(it));
  }
  for (const prop of SPELL_FREQ_PROPS) {
    if (!isObject(m[prop]) || !isObject(sc[prop])) continue;
    for (const [k, spells] of Object.entries(m[prop] as JsonObject)) {
      if (!isSpellUsesKey(k)) continue;
      const tgt = sc[prop] as JsonObject;
      if (Array.isArray(tgt[k])) tgt[k] = (tgt[k] as unknown[]).filter((it) => !asArray(spells as unknown[]).includes(it));
    }
  }
}

// endregion
