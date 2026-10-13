import { getRuleset } from '@cn/fivetools';
import type { EncounterCreature, ResolvedEncounterCreature } from '@cn/shared';
import { creatureSummary, encounterDifficulty, parseHpInput } from './combat-math';
import { healthWordLabel } from './health';

const line = (id: string, count: number, extra: Partial<EncounterCreature> = {}): EncounterCreature => ({
  id,
  kind: 'monster',
  uid: null,
  pageId: null,
  name: '',
  count,
  lair: false,
  hidden: false,
  xp: null,
  hp: null,
  ac: null,
  ...extra,
});
const resolved = (id: string, name: string, xp: number): ResolvedEncounterCreature => ({ id, name, uid: null, cr: null, xp, hasLairXp: false, hp: null, ac: null, initBonus: 0, missing: false });

describe('combat helpers', () => {
  it('reads the hit point box', () => {
    expect(['-7', '7', '+5', '5h', '=20', 't5', ' - 3 ', 'abc', '', '-1.5'].map(parseHpInput)).toEqual([
      { kind: 'damage', amount: 7 },
      { kind: 'damage', amount: 7 },
      { kind: 'heal', amount: 5 },
      { kind: 'heal', amount: 5 },
      { kind: 'set', amount: 20 },
      { kind: 'temp', amount: 5 },
      { kind: 'damage', amount: 3 },
      null,
      null,
      null,
    ]);
  });

  it('rates encounters with each edition’s rules', () => {
    const creatures = [line('a', 4), line('b', 1)];
    const res = [resolved('a', 'Goblin', 50), resolved('b', 'Bugbear', 200)];
    // DMG 2014: 400 XP × 2 (5 creatures, 4 characters) = 800 vs. level 3 thresholds (300/600/900/1600)
    const classic = encounterDifficulty(getRuleset('2014'), [3, 3, 3, 3], creatures, res);
    expect(classic).toMatchObject({ totalXp: 400, multiplier: 2, adjustedXp: 800, difficulty: 'medium' });
    // XDMG 2024: no multiplier; 400 vs. level 3 budgets (600/900/1600)
    const modern = encounterDifficulty(getRuleset('2024'), [3, 3, 3, 3], creatures, res);
    expect(modern).toMatchObject({ totalXp: 400, multiplier: 1, difficulty: 'trivial' });
    expect(creatureSummary(creatures, res)).toBe('4 × Goblin, Bugbear');
  });

  it('labels health for players', () => {
    expect([healthWordLabel('healthy'), healthWordLabel('bloodied'), healthWordLabel(null)]).toEqual(['Unhurt', 'Bloodied', '']);
  });
});
