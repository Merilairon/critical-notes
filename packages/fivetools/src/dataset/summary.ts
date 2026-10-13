/**
 * List-view summary columns per kind (CR, level, rarity, …). Kept small: lists and filters read these
 * without parsing the full entity JSON.
 */
import { crString, crToNumber, SIZE_NAMES } from '../constants';
import type { EntityKind } from '../kinds';
import { stripTags } from '../tags/tokenize';
import { asArray, isObject, type JsonObject } from '../util/object';

export type EntitySummary = Record<string, string | number | boolean | string[] | null>;

const SCHOOLS: Record<string, string> = {
  A: 'Abjuration', C: 'Conjuration', D: 'Divination', E: 'Enchantment', V: 'Evocation', I: 'Illusion', N: 'Necromancy', T: 'Transmutation', P: 'Psionic',
};

export function spellSchoolName(code: unknown): string | null {
  return typeof code === 'string' ? (SCHOOLS[code] ?? code) : null;
}

export function monsterTypeName(type: unknown): string | null {
  if (typeof type === 'string') return type;
  if (isObject(type)) {
    const t = type.type;
    if (typeof t === 'string') return t;
    if (isObject(t) && Array.isArray(t.choose)) return (t.choose as string[]).join('/');
  }
  return null;
}

function itemTypeCode(type: unknown): string | null {
  return typeof type === 'string' ? type.split('|')[0]! : null;
}

function rarity(ent: JsonObject): string | null {
  return typeof ent.rarity === 'string' ? ent.rarity : null;
}

export function buildSummary(kind: EntityKind, ent: JsonObject): EntitySummary {
  switch (kind) {
    case 'monster': {
      const cr = crString(ent.cr);
      return {
        cr,
        crNumber: crToNumber(ent.cr),
        type: monsterTypeName(ent.type),
        size: asArray(ent.size as string | string[]).map((s) => SIZE_NAMES[s] ?? s),
        environment: asArray(ent.environment as string[]),
        isNpc: !!ent.isNpc,
        legendary: Array.isArray(ent.legendary) || !!ent.legendaryGroup,
        group: asArray(ent.group as string[]).length ? asArray(ent.group as string[]) : null,
      };
    }
    case 'spell': {
      const components = isObject(ent.components) ? Object.keys(ent.components).map((c) => c.toUpperCase()) : [];
      const durations = asArray(ent.duration as JsonObject[]);
      const times = asArray(ent.time as JsonObject[]);
      return {
        level: typeof ent.level === 'number' ? ent.level : null,
        school: spellSchoolName(ent.school),
        ritual: isObject(ent.meta) ? !!ent.meta.ritual : false,
        concentration: durations.some((d) => isObject(d) && !!d.concentration),
        components,
        time: times.length && isObject(times[0]) ? `${String(times[0].number ?? '')} ${String(times[0].unit ?? '')}`.trim() : null,
        classes: asArray(ent._classes as JsonObject[]).map((c) => String(c.name)),
      };
    }
    case 'item':
      return {
        rarity: rarity(ent),
        type: itemTypeCode(ent.type),
        category: typeof ent._category === 'string' ? ent._category : ent._isItemGroup ? 'Item Group' : 'Other',
        attunement: ent.reqAttune ? (typeof ent.reqAttune === 'string' ? stripTags(ent.reqAttune) : true) : false,
        weapon: !!ent.weapon || !!ent.weaponCategory,
        armor: !!ent.armor,
        wondrous: !!ent.wondrous,
        value: typeof ent.value === 'number' ? ent.value : null,
        weight: typeof ent.weight === 'number' ? ent.weight : null,
      };
    case 'race':
      return {
        size: asArray(ent.size as string | string[]).map((s) => SIZE_NAMES[s] ?? s),
        isBaseRace: !!ent._isBaseRace,
        isSubrace: !!ent._subraceName,
        baseName: typeof ent._baseName === 'string' ? ent._baseName : null,
      };
    case 'feat':
      return { category: typeof ent.category === 'string' ? ent.category : null, repeatable: !!ent.repeatable };
    case 'class':
      return {
        hitDie: isObject(ent.hd) ? `d${String(ent.hd.faces)}` : null,
        primaryAbility: asArray(ent.primaryAbility as JsonObject[]).flatMap((p) => (isObject(p) ? Object.keys(p) : [])),
      };
    case 'subclass':
      return { className: String(ent.className ?? ''), classSource: String(ent.classSource ?? ''), shortName: String(ent.shortName ?? ent.name ?? '') };
    case 'classFeature':
    case 'subclassFeature':
      return { className: String(ent.className ?? ''), level: typeof ent.level === 'number' ? ent.level : Number(ent.level) || null };
    case 'optionalfeature':
      return { featureType: asArray(ent.featureType as string[]) };
    case 'deity':
      return { pantheon: typeof ent.pantheon === 'string' ? ent.pantheon : null, alignment: asArray(ent.alignment as string[]).join('') || null };
    case 'trap':
    case 'hazard':
      return { trapHazType: typeof ent.trapHazType === 'string' ? ent.trapHazType : null };
    case 'vehicle':
      return { vehicleType: typeof ent.vehicleType === 'string' ? ent.vehicleType : null };
    default:
      return {};
  }
}
