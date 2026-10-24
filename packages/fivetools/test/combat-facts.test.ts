import { describe, expect, it } from 'vitest';
import { parseStatblockCombatFacts } from '../src';

describe('statblock combat facts', () => {
  it('reads legendary action counts, defaulting to 3', () => {
    expect(parseStatblockCombatFacts({ legendary: [{ name: 'Tail Attack' }] }).legendary).toEqual({ perRound: 3 });
    expect(parseStatblockCombatFacts({ legendary: [{ name: 'x' }], legendaryActions: 2 }).legendary).toEqual({ perRound: 2 });
    expect(parseStatblockCombatFacts({ legendary: [{ name: 'x' }], legendaryActions: 3, legendaryActionsLair: 4 }).legendary).toEqual({ perRound: 3, perRoundLair: 4 });
    expect(parseStatblockCombatFacts({ legendary: [] }).legendary).toBeNull();
    expect(parseStatblockCombatFacts({ legendaryActions: 3 }).legendary).toBeNull();
  });

  it('parses Legendary Resistance from the trait name only', () => {
    const facts = (name: string) => parseStatblockCombatFacts({ trait: [{ name }] }).resistance;
    expect(facts('Legendary Resistance (3/Day)')).toEqual({ max: 3 });
    expect(facts('Legendary Resistance (3/Day, or 4/Day in Lair)')).toEqual({ max: 3, maxLair: 4 });
    expect(facts('Legendary Resistance (2/Day, or 3/Day in Domain)')).toEqual({ max: 2, maxLair: 3 });
    expect(facts('Legendary Resistance (3/Day in This Form)')).toEqual({ max: 3 });
    expect(facts('Legendary Resistance (3/Day or 4/Day in lair)')).toEqual({ max: 3, maxLair: 4 });
    expect(facts('Legendary Resistance')).toBeNull();
    expect(facts('Magic Resistance')).toBeNull();
    expect(parseStatblockCombatFacts({}).resistance).toBeNull();
  });

  it('collects recharge tags from actions, bonus actions, reactions and traits (not legendary options)', () => {
    const facts = parseStatblockCombatFacts({
      action: [{ name: 'Fire Breath {@recharge 5}' }, { name: 'Bite' }, { name: 'Frost Breath {@recharge}' }],
      bonus: [{ name: 'Spit {@recharge 4}' }],
      reaction: [{ name: 'Lash (Recharge {@recharge 6})' }],
      trait: [{ name: 'Surge {@recharge 3}' }],
      legendary: [{ name: 'Breath {@recharge 5}' }],
    });
    expect(facts.recharge).toEqual([
      { name: 'Fire Breath', min: 5 },
      { name: 'Frost Breath', min: 6 },
      { name: 'Spit', min: 4 },
      { name: 'Lash', min: 6 },
      { name: 'Surge', min: 3 },
    ]);
  });

  it('drops out-of-range numbers so odd data cannot break a tracker', () => {
    expect(parseStatblockCombatFacts({ legendary: [{ name: 'x' }], legendaryActions: 0, legendaryActionsLair: 99 }).legendary).toEqual({ perRound: 3 });
    expect(parseStatblockCombatFacts({ trait: [{ name: 'Legendary Resistance (0/Day)' }] }).resistance).toBeNull();
    expect(parseStatblockCombatFacts({ trait: [{ name: 'Legendary Resistance (3/Day, or 50/Day in Lair)' }] }).resistance).toEqual({ max: 3 });
    expect(parseStatblockCombatFacts({ action: [{ name: `${'x'.repeat(300)} {@recharge 5}` }] }).recharge[0]!.name).toHaveLength(120);
  });

  it('copes with empty and odd data', () => {
    expect(parseStatblockCombatFacts({ action: 'x', trait: [1, null, { name: 5 }] })).toEqual({ legendary: null, resistance: null, recharge: [] });
  });
});
