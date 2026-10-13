import { describe, expect, it } from 'vitest';
import { crToProficiencyBonus, crToXp } from '../src/constants';
import { classicMultiplier, getRuleset, RULESET_2014, RULESET_2024 } from '../src/ruleset/index';

describe('encounter difficulty', () => {
  it('2014: thresholds with the monster-count multiplier (DMG worked example)', () => {
    // Party of four level-3 PCs vs one CR 3 (700 XP) + two CR 1/2 (100 XP each): 900 XP × 2 (3 monsters) = 1800
    const r = RULESET_2014.encounter.compute([3, 3, 3, 3], [{ xp: 700, count: 1 }, { xp: 100, count: 2 }]);
    expect(r.totalXp).toBe(900);
    expect(r.multiplier).toBe(2);
    expect(r.adjustedXp).toBe(1800);
    expect(r.tiers.map((t) => [t.id, t.threshold])).toEqual([
      ['easy', 300],
      ['medium', 600],
      ['hard', 900],
      ['deadly', 1600],
      ['absurd', 2300],
    ]);
    expect(r.difficulty).toBe('deadly');
  });

  it('2014: party size shifts the multiplier', () => {
    expect(classicMultiplier(1, 4)).toBe(1);
    expect(classicMultiplier(1, 2)).toBe(1.5);
    expect(classicMultiplier(1, 6)).toBe(0.5);
    expect(classicMultiplier(2, 4)).toBe(1.5);
    expect(classicMultiplier(6, 4)).toBe(2);
    expect(classicMultiplier(7, 4)).toBe(2.5);
    expect(classicMultiplier(11, 4)).toBe(3);
    expect(classicMultiplier(15, 4)).toBe(4);
    expect(classicMultiplier(15, 2)).toBe(5);
  });

  it('2024: per-character budgets, no multiplier', () => {
    const r = RULESET_2024.encounter.compute([3, 3, 3, 3], [{ xp: 700, count: 1 }, { xp: 100, count: 2 }]);
    expect(r.multiplier).toBe(1);
    expect(r.adjustedXp).toBe(900);
    expect(r.tiers.map((t) => [t.id, t.threshold])).toEqual([
      ['low', 600],
      ['moderate', 900],
      ['high', 1600],
      ['absurd', 2300],
    ]);
    expect(r.difficulty).toBe('moderate');
    expect(RULESET_2024.encounter.compute([1], [{ xp: 10, count: 1 }]).difficulty).toBe('trivial');
    expect(RULESET_2024.encounter.compute([20], [{ xp: 22000, count: 1 }]).difficulty).toBe('high');
  });

  it('clamps out-of-range levels and ignores negative counts', () => {
    const r = RULESET_2024.encounter.compute([0, 25], [{ xp: 100, count: -3 }]);
    expect(r.totalXp).toBe(0);
    expect(r.tiers[0]!.threshold).toBe(50 + 6400);
  });
});

describe('ruleset abstraction', () => {
  it('exposes terminology and feature flags instead of edition checks', () => {
    expect(getRuleset('2014').terminology.race).toBe('Race');
    expect(getRuleset('2024').terminology.race).toBe('Species');
    expect(RULESET_2024.features.weaponMastery).toBe(true);
    expect(RULESET_2014.features.backgroundAbilityScores).toBe(false);
  });

  it('maps edition-neutral refs to per-edition uids', () => {
    expect(RULESET_2014.canonicalRef('condition:Poisoned')).toBe('condition:poisoned|phb');
    expect(RULESET_2024.canonicalRef('condition:Poisoned')).toBe('condition:poisoned|xphb');
    expect(RULESET_2024.canonicalRef('creature:goblin warrior')).toBe('monster:goblin warrior|xmm');
    expect(RULESET_2024.canonicalRef('nonsense')).toBeNull();
  });

  it('CR helpers', () => {
    expect(crToXp('1/4')).toBe(50);
    expect(crToXp({ cr: '5', xp: 2000 })).toBe(2000);
    expect(crToXp({ cr: '10', lair: '11' }, { lair: true })).toBe(7200);
    expect(crToProficiencyBonus('1/2')).toBe(2);
    expect(crToProficiencyBonus('5')).toBe(3);
    expect(crToProficiencyBonus('17')).toBe(6);
  });
});
