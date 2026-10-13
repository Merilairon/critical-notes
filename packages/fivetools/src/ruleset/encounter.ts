/**
 * Encounter difficulty for both editions. Tables match 5etools' encounter builder
 * (DMG 2014 p.82 and XDMG 2024 p.114); see DATA_NOTES.md §8.
 */

export interface EncounterCreature {
  xp: number;
  count: number;
}

export interface EncounterTierInfo {
  id: string;
  label: string;
  /** Party-wide XP threshold for this tier. */
  threshold: number;
}

export interface EncounterResult {
  /** Sum of creature XP (what the party is awarded). */
  totalXp: number;
  /** XP compared against thresholds (2014 applies a multiplier; 2024 does not). */
  adjustedXp: number;
  multiplier: number;
  /** Tiers in ascending order, including an extrapolated "absurd" tier. */
  tiers: EncounterTierInfo[];
  /** Highest tier reached, or "trivial" when under the lowest threshold. */
  difficulty: string;
  creatureCount: number;
  partySize: number;
}

export interface EncounterRules {
  readonly tierIds: readonly string[];
  compute(partyLevels: number[], creatures: EncounterCreature[]): EncounterResult;
}

function clampLevel(level: number): number {
  return Math.max(1, Math.min(20, Math.floor(level) || 1));
}

function sumThresholds(table: number[], partyLevels: number[]): number {
  return partyLevels.reduce((sum, lvl) => sum + (table[clampLevel(lvl)] ?? 0), 0);
}

function pickDifficulty(adjustedXp: number, tiers: EncounterTierInfo[]): string {
  let difficulty = 'trivial';
  for (const tier of tiers) if (adjustedXp >= tier.threshold && tier.threshold > 0) difficulty = tier.id;
  return difficulty;
}

// region 2014 (DMG)

const CLASSIC_TIERS: Record<string, number[]> = {
  easy: [0, 25, 50, 75, 125, 250, 300, 350, 450, 550, 600, 800, 1000, 1100, 1250, 1400, 1600, 2000, 2100, 2400, 2800],
  medium: [0, 50, 100, 150, 250, 500, 600, 750, 900, 1100, 1200, 1600, 2000, 2200, 2500, 2800, 3200, 3900, 4100, 4900, 5700],
  hard: [0, 75, 150, 225, 375, 750, 900, 1100, 1400, 1600, 1900, 2400, 3000, 3400, 3800, 4300, 4800, 5900, 6300, 7300, 8500],
  deadly: [0, 100, 200, 400, 500, 1100, 1400, 1700, 2100, 2400, 2800, 3600, 4500, 5100, 5700, 6400, 7200, 8800, 9500, 10900, 12700],
};

export const CLASSIC_DAILY_XP = [0, 300, 600, 1200, 1700, 3500, 4000, 5000, 6000, 7500, 9000, 10500, 11500, 13500, 15000, 18000, 20000, 25000, 27000, 30000, 40000];

/** DMG multiplier steps; party-size adjustments move one step up or down. */
const MULTIPLIER_STEPS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5];

function classicMultiplierStep(count: number): number {
  if (count <= 0) return 1;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count <= 6) return 3;
  if (count <= 10) return 4;
  if (count <= 14) return 5;
  return 6;
}

export function classicMultiplier(creatureCount: number, partySize: number): number {
  let step = classicMultiplierStep(creatureCount);
  if (partySize > 0 && partySize < 3) step += 1;
  else if (partySize >= 6) step -= 1;
  return MULTIPLIER_STEPS[Math.max(0, Math.min(MULTIPLIER_STEPS.length - 1, step))]!;
}

export const classicEncounterRules: EncounterRules = {
  tierIds: ['easy', 'medium', 'hard', 'deadly', 'absurd'],
  compute(partyLevels, creatures) {
    const creatureCount = creatures.reduce((n, c) => n + Math.max(0, c.count), 0);
    const totalXp = creatures.reduce((n, c) => n + c.xp * Math.max(0, c.count), 0);
    const multiplier = creatureCount ? classicMultiplier(creatureCount, partyLevels.length) : 1;
    const adjustedXp = Math.round(totalXp * multiplier);
    const t = (id: string) => sumThresholds(CLASSIC_TIERS[id]!, partyLevels);
    const deadly = t('deadly');
    const tiers: EncounterTierInfo[] = [
      { id: 'easy', label: 'Easy', threshold: t('easy') },
      { id: 'medium', label: 'Medium', threshold: t('medium') },
      { id: 'hard', label: 'Hard', threshold: t('hard') },
      { id: 'deadly', label: 'Deadly', threshold: deadly },
      { id: 'absurd', label: 'Absurd', threshold: deadly + (deadly - t('hard')) },
    ];
    return { totalXp, adjustedXp, multiplier, tiers, difficulty: pickDifficulty(adjustedXp, tiers), creatureCount, partySize: partyLevels.length };
  },
};

// endregion

// region 2024 (XDMG)

const MODERN_TIERS: Record<string, number[]> = {
  low: [0, 50, 100, 150, 250, 500, 600, 750, 1000, 1300, 1600, 1900, 2200, 2600, 2900, 3300, 3800, 4500, 5000, 5500, 6400],
  moderate: [0, 75, 150, 225, 375, 750, 1000, 1300, 1700, 2000, 2300, 2900, 3700, 4200, 4900, 5400, 6100, 7200, 8700, 10700, 13200],
  high: [0, 100, 200, 400, 500, 1100, 1400, 1700, 2100, 2600, 3100, 4100, 4700, 5400, 6200, 7800, 9800, 11700, 14200, 17200, 22000],
};

export const modernEncounterRules: EncounterRules = {
  tierIds: ['low', 'moderate', 'high', 'absurd'],
  compute(partyLevels, creatures) {
    const creatureCount = creatures.reduce((n, c) => n + Math.max(0, c.count), 0);
    const totalXp = creatures.reduce((n, c) => n + c.xp * Math.max(0, c.count), 0);
    const t = (id: string) => sumThresholds(MODERN_TIERS[id]!, partyLevels);
    const high = t('high');
    const tiers: EncounterTierInfo[] = [
      { id: 'low', label: 'Low', threshold: t('low') },
      { id: 'moderate', label: 'Moderate', threshold: t('moderate') },
      { id: 'high', label: 'High', threshold: high },
      { id: 'absurd', label: 'Absurd', threshold: high + (high - t('moderate')) },
    ];
    return { totalXp, adjustedXp: totalXp, multiplier: 1, tiers, difficulty: pickDifficulty(totalXp, tiers), creatureCount, partySize: partyLevels.length };
  },
};

// endregion
