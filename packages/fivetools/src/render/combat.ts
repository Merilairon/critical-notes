/** Numbers a combat tracker needs from a monster statblock (2014 and 2024 data). */
import { abilityModifier, crString, crToProficiencyBonus, crToXp } from '../constants';
import { isObject, type JsonObject } from '../util/object';

export interface CombatStats {
  hp: number | null;
  hpFormula: string | null;
  ac: number | null;
  /** Initiative modifier: Dexterity, plus proficiency for 2024 monsters with initiative proficiency. */
  initBonus: number;
  cr: string | null;
  xp: number | null;
  /** XP in its lair, when the statblock has one. */
  xpLair: number | null;
}

/** The first (unconditional) armor class. */
function firstAc(ac: unknown): number | null {
  if (!Array.isArray(ac)) return typeof ac === 'number' ? ac : null;
  for (const entry of ac) {
    if (typeof entry === 'number') return entry;
    if (isObject(entry) && typeof entry.ac === 'number') return entry.ac;
  }
  return null;
}

export function monsterCombatStats(data: JsonObject): CombatStats {
  const hp = isObject(data.hp) && typeof data.hp.average === 'number' ? data.hp.average : null;
  const hpFormula = isObject(data.hp) && typeof data.hp.formula === 'string' ? data.hp.formula : null;
  const dex = typeof data.dex === 'number' ? abilityModifier(data.dex) : 0;
  let initBonus = dex;
  if (typeof data.initiative === 'number') initBonus = data.initiative;
  else if (isObject(data.initiative) && typeof data.initiative.initiative === 'number') initBonus = data.initiative.initiative;
  else if (isObject(data.initiative) && typeof data.initiative.proficiency === 'number') initBonus = dex + data.initiative.proficiency * crToProficiencyBonus(data.cr);
  const xp = crToXp(data.cr);
  const xpLair = crToXp(data.cr, { lair: true });
  return { hp, hpFormula, ac: firstAc(data.ac), initBonus, cr: crString(data.cr), xp, xpLair: xpLair !== xp ? xpLair : null };
}

/** Legendary, Legendary Resistance and recharge facts a tracker snapshots when a monster is added. */
export interface CombatFacts {
  /** Present only when the monster has legendary actions. */
  legendary: { perRound: number; perRoundLair?: number } | null;
  /** Present only when the monster has the Legendary Resistance trait. */
  resistance: { max: number; maxLair?: number } | null;
  recharge: { name: string; min: number }[];
}

const RECHARGE_TAG = /\{@recharge(?:\s+(\d))?\}/;
const PER_DAY = /(\d+)\s*\/\s*day/i;

/** A usable count (whole number 1-20), else undefined: odd data must not make a tracker refuse to start. */
function count(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 20 ? n : undefined;
}

function entryNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((e) => (isObject(e) && typeof e.name === 'string' ? [e.name] : []));
}

function parseResistance(traits: string[]): CombatFacts['resistance'] {
  const trait = traits.find((n) => /^legendary resistance/i.test(n.trim()));
  const first = trait ? PER_DAY.exec(trait) : null;
  if (!trait || !first) return null;
  const lair = /(\d+)\s*\/\s*day\s+in\s+(?:lair|domain)/i.exec(trait.slice(first.index + first[0].length));
  const max = count(Number(first[1]));
  const maxLair = lair ? count(Number(lair[1])) : undefined;
  return max === undefined ? null : { max, ...(maxLair !== undefined ? { maxLair } : {}) };
}

/**
 * Reads legendary actions (`legendary`, `legendaryActions`, `legendaryActionsLair`), Legendary Resistance (only
 * in the trait name) and recharge abilities (the recharge tag in the name of an action, bonus action, reaction
 * or trait; legendary options never recharge).
 */
export function parseStatblockCombatFacts(data: JsonObject): CombatFacts {
  const legendary =
    Array.isArray(data.legendary) && data.legendary.length > 0
      ? {
          perRound: count(data.legendaryActions) ?? 3,
          ...(count(data.legendaryActionsLair) !== undefined ? { perRoundLair: count(data.legendaryActionsLair)! } : {}),
        }
      : null;
  const recharge: CombatFacts['recharge'] = [];
  for (const raw of [...entryNames(data.action), ...entryNames(data.bonus), ...entryNames(data.reaction), ...entryNames(data.trait)]) {
    const m = RECHARGE_TAG.exec(raw);
    if (!m) continue;
    const name = raw
      .replace(RECHARGE_TAG, '')
      .replace(/\(\s*(?:recharge)?\s*\)/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    if (name && recharge.length < 20) recharge.push({ name, min: Math.min(6, Math.max(2, m[1] ? Number(m[1]) : 6)) });
  }
  return { legendary, resistance: parseResistance(entryNames(data.trait)), recharge };
}
