import { describe, expect, it } from 'vitest';
import { monsterCombatStats } from '../src';

describe('monster combat stats', () => {
  it('reads 2014 statblocks', () => {
    expect(monsterCombatStats({ ac: [{ ac: 15, from: ['shield'] }], hp: { average: 7, formula: '2d6' }, dex: 14, cr: '1/4' })).toEqual({
      hp: 7,
      hpFormula: '2d6',
      ac: 15,
      initBonus: 2,
      cr: '1/4',
      xp: 50,
      xpLair: null,
    });
    // Conditional AC entries come after the base one
    expect(monsterCombatStats({ ac: [12, { ac: 15, condition: 'with mage armor' }], dex: 14, cr: '6' }).ac).toBe(12);
  });

  it('reads 2024 initiative proficiency and lair XP', () => {
    const dragon = monsterCombatStats({ ac: [19], hp: { average: 256, formula: '19d12 + 133' }, dex: 10, cr: { cr: '17', xpLair: 20000 }, initiative: { proficiency: 2 } });
    expect(dragon).toMatchObject({ ac: 19, hp: 256, initBonus: 12, cr: '17', xp: 18000, xpLair: 20000 });
    expect(monsterCombatStats({ dex: 12, cr: '1', initiative: 7 }).initBonus).toBe(7);
  });

  it('copes with missing numbers', () => {
    expect(monsterCombatStats({ hp: { special: 'varies' } })).toEqual({ hp: null, hpFormula: null, ac: null, initBonus: 0, cr: null, xp: null, xpLair: null });
  });
});
