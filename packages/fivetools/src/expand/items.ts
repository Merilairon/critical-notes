/**
 * Magic item variant generation (5etools `Renderer.item` generic → specific variants, MIT).
 * Generic variants (e.g. "+1 Weapon") are applied to every matching base item (e.g. "Longsword").
 */
import { isClassicEditionValue, isModernEditionValue } from '../edition/sources';
import { clone, getPath, isObject, unique, type JsonObject } from '../util/object';
import { cleanMathExpression, evaluateArithmetic } from '../util/safe-math';
import { escapeRegExp } from '../util/string';
import { applyProperties } from './properties';

const DMG_TYPES: Record<string, string> = {
  A: 'acid', B: 'bludgeoning', C: 'cold', F: 'fire', O: 'force', L: 'lightning', N: 'necrotic',
  P: 'piercing', I: 'poison', Y: 'psychic', R: 'radiant', S: 'slashing', T: 'thunder',
};

const INHERITED_PROPS_BLOCKLIST = new Set(['entries', 'propertyAdd', 'namePrefix', 'nameSuffix', 'propertyRemove']);
const VULN_RES_IMMUNE = ['vulnerable', 'resist', 'immune'] as const;
const CORE_ITEM_SOURCES = new Set(['PHB', 'XPHB', 'DMG', 'XDMG']);

/** Copies `inherits` props onto the generic variant itself so it can be filtered/rendered (mutates). */
export function addInheritedPropertiesToSelf(gv: JsonObject): JsonObject {
  const inherits = isObject(gv.inherits) ? gv.inherits : {};
  for (const [prop, val] of Object.entries(inherits)) {
    if (INHERITED_PROPS_BLOCKLIST.has(prop)) continue;
    if (val == null) delete gv[prop];
    else if (gv[prop] != null) gv[prop] = Array.isArray(gv[prop]) && Array.isArray(val) ? [...clone(gv[prop] as unknown[]), ...val] : val;
    else gv[prop] = val;
  }
  if (!gv.entries && Array.isArray(inherits.entries)) gv.entries = clone(applyProperties(inherits.entries, inherits));
  if (Array.isArray(inherits.propertyAdd)) gv.property = [...(Array.isArray(gv.property) ? gv.property : []), ...inherits.propertyAdd];
  if (isObject(gv.requires) && (gv.requires as JsonObject).armor) gv.armor = (gv.requires as JsonObject).armor;
  return gv;
}

/** Edition matching table from 5etools (non-VTT branch). */
export function isEditionMatch(baseEdition: unknown, variantEdition: unknown): boolean {
  if ((baseEdition ?? null) === (variantEdition ?? null)) return true;
  if (isClassicEditionValue(baseEdition)) return false;
  if (baseEdition == null) return true;
  if (isModernEditionValue(baseEdition)) return !isClassicEditionValue(variantEdition);
  return false;
}

function isMatching(candidateVal: unknown, requirement: unknown, isEvery: boolean): boolean {
  if (Array.isArray(requirement)) {
    return Array.isArray(candidateVal) ? candidateVal.some((it) => requirement.includes(it)) : requirement.includes(candidateVal);
  }
  if (requirement != null && typeof requirement === 'object') {
    return isRequiresExcludesMatch(candidateVal, requirement as JsonObject, isEvery);
  }
  return Array.isArray(candidateVal) ? candidateVal.some((v) => v === requirement) : requirement === candidateVal;
}

function isRequiresExcludesMatch(candidate: unknown, requirements: JsonObject | undefined | null, isEvery = false): boolean {
  if (candidate == null || requirements == null || !isObject(candidate)) return false;
  for (const reqKey of Object.keys(requirements)) {
    const match = isMatching(candidate[reqKey], requirements[reqKey], isEvery);
    if (isEvery && !match) return false;
    if (!isEvery && match) return true;
  }
  return isEvery;
}

export function hasRequiredProperty(base: JsonObject, gv: JsonObject): boolean {
  const requires = Array.isArray(gv.requires) ? (gv.requires as JsonObject[]) : [];
  return requires.some((req) => isRequiresExcludesMatch(base, req, true));
}

export function hasExcludedProperty(base: JsonObject, gv: JsonObject): boolean {
  return isRequiresExcludesMatch(base, isObject(gv.excludes) ? gv.excludes : null);
}

function injectableProps(base: JsonObject, inherits: JsonObject): JsonObject {
  return {
    baseName: base.name,
    dmgType: typeof base.dmgType === 'string' ? (DMG_TYPES[base.dmgType] ?? null) : null,
    bonusAc: inherits.bonusAc,
    bonusWeapon: inherits.bonusWeapon,
    bonusWeaponAttack: inherits.bonusWeaponAttack,
    bonusWeaponDamage: inherits.bonusWeaponDamage,
    bonusWeaponCritDamage: inherits.bonusWeaponCritDamage,
    bonusSpellAttack: inherits.bonusSpellAttack,
    bonusSpellSaveDc: inherits.bonusSpellSaveDc,
    bonusSavingThrow: inherits.bonusSavingThrow,
  };
}

function evaluateExpression(base: JsonObject, sv: JsonObject, expr: string): number | null {
  const replaced = expr.replace(/\[\[([^[\]]+)]]/g, (_m, p: string) => {
    const path = p.split('.');
    const value = path[0] === 'item' ? getPath(sv, path.slice(1)) : path[0] === 'baseItem' ? getPath(base, path.slice(1)) : getPath(sv, path);
    return String(value ?? 0);
  });
  try {
    return evaluateArithmetic(cleanMathExpression(replaced));
  } catch {
    return null;
  }
}

function mergeVulnResImmune(sv: JsonObject, inherits: JsonObject) {
  const fromBase: Partial<Record<(typeof VULN_RES_IMMUNE)[number], unknown[]>> = {};
  for (const prop of VULN_RES_IMMUNE) if (Array.isArray(sv[prop])) fromBase[prop] = [...(sv[prop] as unknown[])];

  for (const prop of VULN_RES_IMMUNE) {
    const val = inherits[prop];
    if (val === undefined) continue;
    if (val === null) {
      delete fromBase[prop];
      continue;
    }
    const valSet = new Set<string>();
    for (const it of val as unknown[]) {
      if (typeof it === 'string') valSet.add(it);
      const nested = isObject(it) ? it[prop] : null;
      if (Array.isArray(nested)) for (const sub of nested) if (typeof sub === 'string') valSet.add(sub);
    }
    for (const other of VULN_RES_IMMUNE) {
      if (other === prop || !fromBase[other]) continue;
      fromBase[other] = fromBase[other]!.filter((it) => {
        if (typeof it === 'string') return !valSet.has(it);
        if (isObject(it) && Array.isArray(it[other])) it[other] = (it[other] as unknown[]).filter((s) => typeof s !== 'string' || !valSet.has(s));
        return true;
      });
      if (!fromBase[other]!.length) delete fromBase[other];
    }
  }
  for (const prop of VULN_RES_IMMUNE) {
    const merged = [...(fromBase[prop] ?? []), ...(Array.isArray(inherits[prop]) ? (inherits[prop] as unknown[]) : [])];
    if (merged.length) sv[prop] = uniqueJson(merged);
    else delete sv[prop];
  }
}

function uniqueJson(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = JSON.stringify(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function createSpecificVariant(base: JsonObject, gv: JsonObject): JsonObject {
  const inherits = isObject(gv.inherits) ? gv.inherits : {};
  const sv = clone(base);
  delete sv._isBaseItem;
  sv._baseName = base.name;
  sv._baseSource = base.source;
  sv._baseSrd = base.srd;
  sv._baseSrd52 = base.srd52;
  sv._baseBasicRules = base.basicRules;
  sv._baseBasicRules2024 = base.basicRules2024;
  sv._variantName = gv.name;
  sv._baseValue = base.value;
  for (const k of ['value', 'srd', 'srd52', 'basicRules', 'basicRules2024', 'page', 'reprintedAs', 'referenceSources', 'hasFluff', 'hasFluffImages']) delete sv[k];
  sv._category = 'Specific Variant';
  sv.baseItem = `${String(base.name)}|${String(base.source)}`.toLowerCase();

  let variantEntries: unknown[] = [];
  const keys = Object.keys(inherits).sort((a, b) => Number(b.includes('Remove')) - Number(a.includes('Remove')));
  for (const prop of keys) {
    const val = inherits[prop];
    switch (prop) {
      case 'namePrefix':
        sv.name = `${String(val)}${String(sv.name)}`;
        break;
      case 'nameSuffix':
        sv.name = `${String(sv.name)}${String(val)}`;
        break;
      case 'nameRemove':
        sv.name = String(sv.name).replace(new RegExp(escapeRegExp(String(val)), 'g'), '');
        break;
      case 'entries':
        variantEntries = applyProperties(clone(val as unknown[]), injectableProps(base, inherits));
        break;
      case 'vulnerable':
      case 'resist':
      case 'immune':
      case 'reprintedAs': // points at the generic variant's reprint; specific reprints are derived in expandItems
        break;
      case 'conditionImmune':
        sv.conditionImmune = unique([...(Array.isArray(sv.conditionImmune) ? (sv.conditionImmune as string[]) : []), ...(val as string[])]);
        break;
      case 'weightExpression':
      case 'valueExpression': {
        const result = evaluateExpression(base, sv, String(val));
        if (result != null) sv[prop === 'weightExpression' ? 'weight' : 'value'] = result;
        break;
      }
      case 'barding':
        sv.bardingType = base.type;
        break;
      case 'propertyAdd': {
        const existing = Array.isArray(sv.property) ? (sv.property as unknown[]) : [];
        const uidOf = (p: unknown) => (isObject(p) ? p.uid : p);
        sv.property = [...existing, ...(val as unknown[]).filter((it) => !existing.some((p) => uidOf(p) === uidOf(it)))];
        break;
      }
      case 'propertyRemove':
        if (Array.isArray(sv.property)) {
          sv.property = (sv.property as unknown[]).filter((it) => !(val as unknown[]).includes(isObject(it) ? it.uid : it));
          if (!(sv.property as unknown[]).length) delete sv.property;
        }
        break;
      default:
        sv[prop] = clone(val);
    }
  }
  mergeVulnResImmune(sv, inherits);
  if (gv.hasFluff) sv.hasFluff = gv.hasFluff;
  if (gv.hasFluffImages) sv.hasFluffImages = gv.hasFluffImages;
  sv.genericVariant = { name: gv.name, source: gv.source };

  const baseEntries = Array.isArray(base.entries) ? clone(base.entries) : [];
  const note = CORE_ITEM_SOURCES.has(String(base.source))
    ? []
    : [`{@note The {@item ${String(base.name)}|${String(base.source)}|base item} can be found in ${String(base.source)}${base.page ? `, page ${String(base.page)}` : ''}.}`];
  sv.entries = [...note, ...variantEntries, ...baseEntries];
  return sv;
}

export interface ItemExpansionResult {
  /** Base items (flagged `_isBaseItem`), generic variants, and generated specific variants. */
  items: JsonObject[];
  specificCount: number;
}

export function expandItems(baseItems: JsonObject[], genericVariants: JsonObject[]): ItemExpansionResult {
  const gvs = genericVariants.map((gv) => {
    const cpy = addInheritedPropertiesToSelf(clone(gv));
    cpy._category = 'Generic Variant';
    return cpy;
  });
  const bases: JsonObject[] = baseItems.map((b) => ({ ...clone(b), _isBaseItem: true, _category: 'Basic', entries: Array.isArray(b.entries) ? b.entries : [] }));
  const specifics: JsonObject[] = [];
  for (const base of bases) {
    if (base.packContents) continue;
    for (const gv of gvs) {
      if (!isEditionMatch(base.edition, gv.edition)) continue;
      if (!hasRequiredProperty(base, gv)) continue;
      if (hasExcludedProperty(base, gv)) continue;
      specifics.push(createSpecificVariant(base, gv));
    }
  }
  linkSpecificReprints(bases, gvs, specifics);
  return { items: [...bases, ...gvs, ...specifics], specificCount: specifics.length };
}

const lowerKey = (name: unknown, source: unknown) => `${String(name)}|${String(source)}`.toLowerCase();

function stringReprintKeys(ent: JsonObject | undefined): string[] {
  if (!ent || !Array.isArray(ent.reprintedAs)) return [];
  return (ent.reprintedAs as unknown[]).filter((r): r is string => typeof r === 'string').map((r) => r.toLowerCase());
}

/**
 * A specific variant is reprinted as the specific variant built from the reprints of its base item and/or
 * generic variant, e.g. "+1 Longsword|DMG" (Longsword|PHB × +1 Weapon|DMG) → "+1 Longsword|XDMG".
 */
function linkSpecificReprints(bases: JsonObject[], gvs: JsonObject[], specifics: JsonObject[]) {
  const baseByKey = new Map(bases.map((b) => [lowerKey(b.name, b.source), b]));
  const gvByKey = new Map(gvs.map((g) => [lowerKey(g.name, g.source), g]));
  const gvKeyOf = (sv: JsonObject) => (isObject(sv.genericVariant) ? lowerKey(sv.genericVariant.name, sv.genericVariant.source) : '');
  const byPair = new Map(specifics.map((sv) => [`${String(sv.baseItem)}::${gvKeyOf(sv)}`, sv]));
  for (const sv of specifics) {
    const baseKey = String(sv.baseItem);
    const gvKey = gvKeyOf(sv);
    const baseTargets = [baseKey, ...stringReprintKeys(baseByKey.get(baseKey))];
    const gvTargets = [gvKey, ...stringReprintKeys(gvByKey.get(gvKey))];
    const targets: string[] = [];
    for (const bt of baseTargets) {
      for (const gt of gvTargets) {
        if (bt === baseKey && gt === gvKey) continue;
        const target = byPair.get(`${bt}::${gt}`);
        if (target && target !== sv) targets.push(`${String(target.name)}|${String(target.source)}`);
      }
    }
    if (targets.length) sv.reprintedAs = [...new Set(targets)];
  }
}
