/** Rules constants shared by both editions (values match 5etools' Parser). */

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type Ability = (typeof ABILITIES)[number];

export const ABILITY_NAMES: Record<Ability, string> = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};

export const SIZES = ['F', 'D', 'T', 'S', 'M', 'L', 'H', 'G', 'C', 'V'] as const;
export const SIZE_NAMES: Record<string, string> = {
  F: 'Fine',
  D: 'Diminutive',
  T: 'Tiny',
  S: 'Small',
  M: 'Medium',
  L: 'Large',
  H: 'Huge',
  G: 'Gargantuan',
  C: 'Colossal',
  V: 'Varies',
};

export const SKILL_TO_ABILITY: Record<string, Ability> = {
  athletics: 'str',
  acrobatics: 'dex',
  'sleight of hand': 'dex',
  stealth: 'dex',
  arcana: 'int',
  history: 'int',
  investigation: 'int',
  nature: 'int',
  religion: 'int',
  'animal handling': 'wis',
  insight: 'wis',
  medicine: 'wis',
  perception: 'wis',
  survival: 'wis',
  deception: 'cha',
  intimidation: 'cha',
  performance: 'cha',
  persuasion: 'cha',
};

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** Challenge rating (as written in data, e.g. "1/4") → XP. Identical in the 2014 and 2024 rules. */
export const CR_TO_XP: Record<string, number> = {
  '0': 10,
  '1/8': 25,
  '1/4': 50,
  '1/2': 100,
  '1': 200,
  '2': 450,
  '3': 700,
  '4': 1100,
  '5': 1800,
  '6': 2300,
  '7': 2900,
  '8': 3900,
  '9': 5000,
  '10': 5900,
  '11': 7200,
  '12': 8400,
  '13': 10000,
  '14': 11500,
  '15': 13000,
  '16': 15000,
  '17': 18000,
  '18': 20000,
  '19': 22000,
  '20': 25000,
  '21': 33000,
  '22': 41000,
  '23': 50000,
  '24': 62000,
  '25': 75000,
  '26': 90000,
  '27': 105000,
  '28': 120000,
  '29': 135000,
  '30': 155000,
};

/** A monster's `cr` field: either "1/4" or an object with lair/coven variants and explicit XP overrides. */
export type CrValue = string | { cr: string; lair?: string; coven?: string; xp?: number; xpLair?: number };

export function crString(cr: unknown): string | null {
  if (typeof cr === 'string') return cr;
  if (cr && typeof cr === 'object' && typeof (cr as { cr?: unknown }).cr === 'string') return (cr as { cr: string }).cr;
  return null;
}

export function crToNumber(cr: unknown): number | null {
  const str = crString(cr);
  if (str == null || str === 'Unknown' || str === '—') return null;
  if (str.includes('/')) {
    const [a, b] = str.split('/').map(Number);
    return a != null && b ? a / b : null;
  }
  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

export function crToXp(cr: unknown, { lair = false }: { lair?: boolean } = {}): number | null {
  if (cr && typeof cr === 'object') {
    const obj = cr as { xp?: number; xpLair?: number; cr?: string; lair?: string };
    if (lair && obj.xpLair != null) return obj.xpLair;
    if (lair && obj.lair) return CR_TO_XP[obj.lair] ?? null;
    if (obj.xp != null) return obj.xp;
  }
  const str = crString(cr);
  return str != null ? (CR_TO_XP[str] ?? null) : null;
}

/** Proficiency bonus for a creature of the given CR (5etools' `crToPb`). */
export function crToProficiencyBonus(cr: unknown): number {
  const num = crToNumber(cr);
  if (num == null) return 0;
  if (num < 5) return 2;
  return Math.ceil(num / 4) + 1;
}

/** Proficiency bonus for a character level. */
export function levelToProficiencyBonus(level: number): number {
  return Math.ceil(Math.max(1, Math.min(20, level)) / 4) + 1;
}
