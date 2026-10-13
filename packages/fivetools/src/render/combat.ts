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
