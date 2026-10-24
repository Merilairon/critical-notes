import { describe, expect, it } from 'vitest';
import {
  applyTrackerAction,
  emptyTrackerState,
  projectTrackerForPlayers,
  type Combatant,
  type RechargeRoll,
  type TrackerAction,
  type TrackerState,
} from '../src';

function harness(d20: number[] = [], d6: number[] = []) {
  let n = 0;
  const rolls: RechargeRoll[] = [];
  const ctx = { d20: () => d20.shift() ?? 10, d6: () => d6.shift() ?? 1, newId: () => `c${++n}`, onRecharge: (r: RechargeRoll) => rolls.push(r) };
  const run = (actions: TrackerAction[], start: TrackerState = emptyTrackerState()) => {
    if (!start.combatants.length) n = 0; // a new scenario numbers its combatants from c1
    return actions.reduce((s, a) => applyTrackerAction(s, a, ctx), start);
  };
  return { run, rolls };
}

const get = (s: TrackerState, id: string): Combatant => s.combatants.find((c) => c.id === id)!;

describe('death saves', () => {
  const pc = (extra: object = {}): TrackerAction => ({ type: 'add', combatants: [{ kind: 'pc', name: 'Aria', hpMax: 20, initiative: 10, ...extra }] });

  it('starts dying at 0 HP and counts rolls (10 and up succeed), three of either ends it', () => {
    const { run } = harness();
    let s = run([pc(), { type: 'hp', id: 'c1', change: -25 }]);
    expect(get(s, 'c1')).toMatchObject({ hp: 0, dying: { successes: 0, failures: 0, status: 'dying' } });
    s = run([{ type: 'deathSave', id: 'c1', roll: 10 }, { type: 'deathSave', id: 'c1', roll: 9 }], s);
    expect(get(s, 'c1').dying).toEqual({ successes: 1, failures: 1, status: 'dying' });
    s = run([{ type: 'deathSave', id: 'c1', roll: 15 }, { type: 'deathSave', id: 'c1', roll: 15 }], s);
    expect(get(s, 'c1').dying).toEqual({ successes: 3, failures: 1, status: 'stable' });
    const dead = run([{ type: 'deathSave', id: 'c1', roll: 2 }, { type: 'deathSave', id: 'c1', roll: 3 }, { type: 'deathSave', id: 'c1', roll: 4 }], run([pc(), { type: 'hp', id: 'c1', change: -20 }]));
    expect(get(dead, 'c1').dying).toEqual({ successes: 0, failures: 3, status: 'dead' });
  });

  it('natural 20 wakes with 1 HP and clears the counts; natural 1 is two failures', () => {
    const { run } = harness();
    const down = run([pc(), { type: 'hp', id: 'c1', change: -20 }]);
    const woke = run([{ type: 'deathSave', id: 'c1', roll: 20 }], down);
    expect(get(woke, 'c1')).toMatchObject({ hp: 1 });
    expect(get(woke, 'c1').dying).toBeUndefined();
    expect(get(run([{ type: 'deathSave', id: 'c1', roll: 1 }], down), 'c1').dying).toEqual({ successes: 0, failures: 2, status: 'dying' });
  });

  it('rolls on the server when no roll is typed, and ignores saves above 0 HP', () => {
    const { run } = harness([14]);
    const down = run([pc(), { type: 'hp', id: 'c1', change: -20 }, { type: 'deathSave', id: 'c1' }]);
    expect(get(down, 'c1').dying?.successes).toBe(1);
    const up = harness().run([pc(), { type: 'deathSave', id: 'c1', roll: 1 }]);
    expect(get(up, 'c1').dying).toBeUndefined();
  });

  it('adds a failure for damage at 0 HP, two for a critical hit; a dead character stays dead', () => {
    const { run } = harness();
    let s = run([pc(), { type: 'hp', id: 'c1', change: -20 }, { type: 'hp', id: 'c1', change: -3 }]);
    expect(get(s, 'c1').dying?.failures).toBe(1);
    s = run([{ type: 'hp', id: 'c1', change: -3, crit: true }], s);
    expect(get(s, 'c1').dying).toEqual({ successes: 0, failures: 3, status: 'dead' });
    s = run([{ type: 'hp', id: 'c1', change: -3 }], s);
    expect(get(s, 'c1').dying?.status).toBe('dead');
  });

  it('kills at once when the overflow reaches the maximum HP', () => {
    const { run } = harness();
    expect(get(run([pc(), { type: 'hp', id: 'c1', change: -40 }]), 'c1').dying?.status).toBe('dead');
    expect(get(run([pc(), { type: 'hp', id: 'c1', change: -39 }]), 'c1').dying?.status).toBe('dying');
    // No maximum: no massive-damage check
    expect(get(run([{ type: 'add', combatants: [{ kind: 'pc', name: 'X', hp: 5 }] }, { type: 'hp', id: 'c1', change: -500 }]), 'c1').dying?.status).toBe('dying');
  });

  it('temporary HP absorbing all the damage adds no failure; what gets past it does', () => {
    const { run } = harness();
    let s = run([pc(), { type: 'hp', id: 'c1', change: -20 }, { type: 'update', id: 'c1', patch: { tempHp: 5 } }]);
    expect(get(s, 'c1')).toMatchObject({ hp: 0, tempHp: 5 });
    s = run([{ type: 'hp', id: 'c1', change: -4 }], s);
    expect(get(s, 'c1')).toMatchObject({ tempHp: 1 });
    expect(get(s, 'c1').dying?.failures).toBe(0);
    s = run([{ type: 'hp', id: 'c1', change: -3 }], s);
    expect(get(s, 'c1')).toMatchObject({ tempHp: 0 });
    expect(get(s, 'c1').dying?.failures).toBe(1);
  });

  it('clears on healing or an hp edit above 0, and restarts at 0/0 after being stable', () => {
    const { run } = harness();
    const down = run([pc(), { type: 'hp', id: 'c1', change: -20 }, { type: 'deathSave', id: 'c1', roll: 12 }]);
    expect(get(run([{ type: 'hp', id: 'c1', change: 4 }], down), 'c1').dying).toBeUndefined();
    expect(get(run([{ type: 'update', id: 'c1', patch: { hp: 3 } }], down), 'c1').dying).toBeUndefined();
    const stable = run([{ type: 'deathSaveAdjust', id: 'c1', status: 'stable' }], down);
    expect(get(stable, 'c1').dying?.status).toBe('stable');
    expect(get(run([{ type: 'hp', id: 'c1', change: -1 }], stable), 'c1').dying).toEqual({ successes: 0, failures: 1, status: 'dying' });
    const healedThenDown = run([{ type: 'hp', id: 'c1', change: 5 }, { type: 'hp', id: 'c1', change: -5 }], stable);
    expect(get(healedThenDown, 'c1').dying).toEqual({ successes: 0, failures: 0, status: 'dying' });
  });

  it('keeps the counters in 0-3 with manual edits and resets', () => {
    const { run } = harness();
    const down = run([pc(), { type: 'hp', id: 'c1', change: -20 }]);
    const s = run([{ type: 'deathSaveAdjust', id: 'c1', failures: 2 }, { type: 'deathSaveAdjust', id: 'c1', successes: -3 }], down);
    expect(get(s, 'c1').dying).toEqual({ successes: 0, failures: 2, status: 'dying' });
    expect(get(run([{ type: 'deathSaveAdjust', id: 'c1', reset: true }], s), 'c1').dying).toEqual({ successes: 0, failures: 0, status: 'dying' });
    expect(get(run([{ type: 'deathSaveAdjust', id: 'c1', failures: 3 }], s), 'c1').dying?.failures).toBe(3);
  });

  it('monsters die at 0 HP without saves unless flagged', () => {
    const { run } = harness();
    const monster = (extra: object): TrackerAction => ({ type: 'add', combatants: [{ kind: 'monster', name: 'Orc', hpMax: 10, ...extra }] });
    expect(get(run([monster({}), { type: 'hp', id: 'c1', change: -10 }]), 'c1').dying).toBeUndefined();
    expect(get(run([monster({ deathSaves: true }), { type: 'hp', id: 'c1', change: -10 }]), 'c1').dying?.status).toBe('dying');
  });
});

describe('legendary actions and resistance', () => {
  const dragon: TrackerAction = {
    type: 'add',
    combatants: [
      { kind: 'monster', name: 'Dragon', hpMax: 200, initiative: 15, legendary: { perRound: 3, perRoundLair: 4 }, resistance: { max: 3, maxLair: 4 } },
      { kind: 'pc', name: 'Aria', hpMax: 20, initiative: 10 },
    ],
  };

  it('spends, undoes and caps uses; the lair raises the cap', () => {
    const { run } = harness();
    let s = run([dragon, { type: 'legendarySpend', id: 'c1', amount: 2 }]);
    expect(get(s, 'c1').legendary).toEqual({ perRound: 3, perRoundLair: 4, used: 2 });
    s = run([{ type: 'legendarySpend', id: 'c1', amount: 3 }], s);
    expect(get(s, 'c1').legendary?.used).toBe(3);
    s = run([{ type: 'setInLair', id: 'c1', inLair: true }, { type: 'legendarySpend', id: 'c1' }], s);
    expect(get(s, 'c1').legendary?.used).toBe(4);
    s = run([{ type: 'legendaryUndo', id: 'c1', amount: 3 }, { type: 'legendaryUndo', id: 'c1', amount: 3 }], s);
    expect(get(s, 'c1').legendary?.used).toBe(0);
    // No legendary object: nothing happens
    expect(get(run([{ type: 'legendarySpend', id: 'c2' }], s), 'c2').legendary).toBeUndefined();
  });

  it('defaults the lair numbers to the normal ones, and only exists when given', () => {
    const { run } = harness();
    const s = run([{ type: 'add', combatants: [{ name: 'Wyrm', legendary: { perRound: 2 }, resistance: { max: 1 } }, { name: 'Rat' }] }]);
    expect(get(s, 'c1').legendary).toEqual({ perRound: 2, perRoundLair: 2, used: 0 });
    expect(get(s, 'c1').resistance).toEqual({ max: 1, maxLair: 1, used: 0 });
    expect(get(s, 'c2')).not.toHaveProperty('legendary');
    expect(get(s, 'c2')).not.toHaveProperty('resistance');
  });

  it('resets legendary uses when the creature becomes active, not on prev or end, and never resistance', () => {
    const { run } = harness();
    let s = run([dragon, { type: 'start' }]);
    expect(s.activeId).toBe('c1');
    s = run([{ type: 'legendarySpend', id: 'c1', amount: 3 }, { type: 'legendaryResist', id: 'c1' }, { type: 'next' }], s);
    expect(get(s, 'c1').legendary?.used).toBe(3); // spent out of turn stays until its own turn
    s = run([{ type: 'prev' }], s);
    expect(get(s, 'c1').legendary?.used).toBe(3);
    s = run([{ type: 'end' }], s);
    expect(get(s, 'c1').legendary?.used).toBe(3);
    s = run([{ type: 'next' }, { type: 'next' }], run([{ type: 'start' }], s));
    expect(get(s, 'c1')).toMatchObject({ legendary: { used: 0 }, resistance: { used: 1 } });
    expect(s.round).toBe(2);
  });

  it('uses and gives back resistance within 0..max', () => {
    const { run } = harness();
    let s = run([dragon, ...Array.from({ length: 5 }, () => ({ type: 'legendaryResist', id: 'c1' }) as TrackerAction)]);
    expect(get(s, 'c1').resistance?.used).toBe(3);
    s = run([{ type: 'legendaryResist', id: 'c1', undo: true }], s);
    expect(get(s, 'c1').resistance?.used).toBe(2);
    s = run([{ type: 'legendaryResist', id: 'c1', undo: true }, { type: 'legendaryResist', id: 'c1', undo: true }, { type: 'legendaryResist', id: 'c1', undo: true }], s);
    expect(get(s, 'c1').resistance?.used).toBe(0);
  });

  it('edits the counts by hand and removes them', () => {
    const { run } = harness();
    let s = run([dragon, { type: 'legendarySpend', id: 'c1', amount: 2 }, { type: 'update', id: 'c1', patch: { legendary: { perRound: 5 }, resistance: { max: 2, used: 1 } } }]);
    expect(get(s, 'c1').legendary).toEqual({ perRound: 5, perRoundLair: 5, used: 2 });
    expect(get(s, 'c1').resistance).toEqual({ max: 2, maxLair: 2, used: 1 });
    s = run([{ type: 'update', id: 'c1', patch: { legendary: null, resistance: null } }], s);
    expect(get(s, 'c1')).not.toHaveProperty('legendary');
    expect(get(s, 'c1')).not.toHaveProperty('resistance');
  });
});

describe('recharge', () => {
  const breather: TrackerAction = {
    type: 'add',
    combatants: [
      { kind: 'monster', name: 'Dragon', initiative: 15, recharge: [{ name: 'Fire Breath', min: 5 }, { name: 'Tail', min: 6 }] },
      { kind: 'pc', name: 'Aria', initiative: 10 },
    ],
  };

  it('starts ready; "used" spends it (case-insensitive name)', () => {
    const { run } = harness();
    let s = run([breather]);
    expect(get(s, 'c1').recharge).toEqual([{ name: 'Fire Breath', min: 5, ready: true }, { name: 'Tail', min: 6, ready: true }]);
    s = run([{ type: 'rechargeUsed', id: 'c1', name: 'fire breath' }, { type: 'rechargeUsed', id: 'c1', name: 'Fire Breath' }], s);
    expect(get(s, 'c1').recharge?.map((r) => r.ready)).toEqual([false, true]);
    s = run([{ type: 'rechargeSet', id: 'c1', name: 'Fire Breath', ready: true }], s);
    expect(get(s, 'c1').recharge?.[0]?.ready).toBe(true);
  });

  it('rolls a d6 for spent abilities at the start of the turn, ready on min or more, and reports each roll', () => {
    const { run, rolls } = harness([], [4, 5]);
    const s = run([breather, { type: 'rechargeUsed', id: 'c1', name: 'Fire Breath' }, { type: 'rechargeUsed', id: 'c1', name: 'Tail' }, { type: 'start' }]);
    // Starting the fight activates the dragon (highest initiative): 4 misses 5, 5 misses 6
    expect(get(s, 'c1').recharge?.map((r) => r.ready)).toEqual([false, false]);
    expect(rolls).toEqual([
      { combatantId: 'c1', name: 'Fire Breath', roll: 4, min: 5, ready: false },
      { combatantId: 'c1', name: 'Tail', roll: 5, min: 6, ready: false },
    ]);
    // A full round later: the next rolls (1 default) still fail; ready ones are not rolled
    run([{ type: 'rechargeSet', id: 'c1', name: 'Tail', ready: true }, { type: 'next' }, { type: 'next' }], s);
    expect(rolls).toHaveLength(3);
    expect(rolls[2]).toMatchObject({ name: 'Fire Breath', roll: 1, ready: false });
  });

  it('becomes ready on a roll equal to the minimum, and prev does not roll', () => {
    const { run, rolls } = harness([], [5]);
    let s = run([breather, { type: 'start' }, { type: 'rechargeUsed', id: 'c1', name: 'Fire Breath' }, { type: 'next' }, { type: 'prev' }]);
    expect(rolls).toHaveLength(0);
    s = run([{ type: 'next' }, { type: 'next' }], s);
    expect(get(s, 'c1').recharge?.[0]?.ready).toBe(true);
    expect(rolls).toEqual([{ combatantId: 'c1', name: 'Fire Breath', roll: 5, min: 5, ready: true }]);
  });
});

describe('lair actions and delay', () => {
  const fight: TrackerAction = {
    type: 'add',
    combatants: [
      { kind: 'monster', name: 'Dragon', initiative: 20, initBonus: 0 },
      { kind: 'pc', name: 'Aria', initiative: 20, initBonus: 5 },
      { kind: 'pc', name: 'Bo', initiative: 12 },
      { kind: 'monster', name: 'Orc', initiative: 8 },
    ],
  };

  it('adds a hidden lair row at initiative 20 that loses ties, and flags creatures in their lair', () => {
    const { run } = harness();
    const s = run([fight, { type: 'lairAdd', ref: 'group', markInLair: ['c1'] }]);
    expect(s.combatants.map((c) => c.name)).toEqual(['Aria', 'Dragon', 'Lair actions', 'Bo', 'Orc']);
    expect(s.combatants.find((c) => c.kind === 'lair')).toMatchObject({ hidden: true, initiative: 20, hp: null, ref: 'group' });
    expect(get(s, 'c1').inLair).toBe(true);
    expect(get(s, 'c2').inLair).toBeUndefined();
  });

  it('keeps legendary uses within the creature numbers when flagged as in lair', () => {
    const { run } = harness();
    const s = run([{ type: 'add', combatants: [{ name: 'W', legendary: { perRound: 3, perRoundLair: 2 } }] }, { type: 'legendarySpend', id: 'c1', amount: 3 }, { type: 'lairAdd', markInLair: ['c1'] }]);
    expect(get(s, 'c1').legendary?.used).toBe(2);
  });

  it('does not roll initiative for the lair row, and turns pass through it', () => {
    const { run } = harness([5, 5, 5]);
    let s = run([fight, { type: 'lairAdd' }, { type: 'rollInitiative', which: 'all' }]);
    expect(s.combatants.find((c) => c.kind === 'lair')!.initiative).toBe(20);
    s = run([{ type: 'start' }], s);
    expect(s.combatants.find((c) => c.id === s.activeId)!.kind).toBe('lair');
    s = run([{ type: 'next' }], s);
    expect(s.combatants.find((c) => c.id === s.activeId)!.name).toBe('Aria');
  });

  it('moves a combatant right after another and takes its initiative', () => {
    const { run } = harness();
    const s = run([fight, { type: 'moveAfter', id: 'c4', afterId: 'c3' }]);
    expect(s.combatants.map((c) => `${c.name}:${c.initiative}`)).toEqual(['Aria:20', 'Dragon:20', 'Bo:12', 'Orc:12']);
    const t = run([{ type: 'moveAfter', id: 'c1', afterId: 'c2' }], run([fight]));
    expect(t.combatants.map((c) => c.name).slice(0, 2)).toEqual(['Aria', 'Dragon']);
    // Lands before a combatant that already tied and sorted after the target
    const tie = run([{ type: 'add', combatants: [{ name: 'Twin', initiative: 12, initBonus: -1 }] }, { type: 'moveAfter', id: 'c4', afterId: 'c3' }], run([fight]));
    expect(tie.combatants.map((c) => c.name)).toEqual(['Aria', 'Dragon', 'Bo', 'Orc', 'Twin']);
  });

  it('keeps the lair row last at initiative 20 when someone is moved there, even after it', () => {
    const { run } = harness();
    const s = run([fight, { type: 'lairAdd' }, { type: 'moveAfter', id: 'c4', afterId: 'c1' }]);
    expect(s.combatants.map((c) => c.name)).toEqual(['Aria', 'Dragon', 'Orc', 'Lair actions', 'Bo']);
    const after = run([{ type: 'moveAfter', id: 'c3', afterId: 'c5' }], s);
    expect(after.combatants.map((c) => c.name)).toEqual(['Aria', 'Dragon', 'Orc', 'Lair actions', 'Bo']);
    const past = run([{ type: 'moveAfter', id: 'c3', afterId: 'c5' }], run([fight, { type: 'lairAdd' }]));
    expect(past.combatants.map((c) => c.name)).toEqual(['Aria', 'Dragon', 'Lair actions', 'Bo', 'Orc']);
  });

  it('hands the turn to the next combatant when the active one delays, without ticking its conditions', () => {
    const { run } = harness();
    let s = run([fight, { type: 'addCondition', id: 'c2', name: 'Prone', rounds: 2 }, { type: 'start' }]);
    expect(s.activeId).toBe('c2');
    s = run([{ type: 'moveAfter', id: 'c2', afterId: 'c3' }], s);
    expect(s.activeId).toBe('c1');
    expect(s.round).toBe(1);
    expect(get(s, 'c2').conditions).toEqual([{ name: 'Prone', rounds: 2 }]);
    expect(s.combatants.map((c) => c.name)).toEqual(['Dragon', 'Bo', 'Aria', 'Orc']);
    expect(get(s, 'c2').initiative).toBe(12);
  });

  it('activates (legendary reset) whoever receives the turn after a delay', () => {
    const { run } = harness();
    let s = run([
      { type: 'add', combatants: [{ name: 'A', initiative: 20 }, { name: 'B', initiative: 10, legendary: { perRound: 3 } }, { name: 'C', initiative: 5 }] },
      { type: 'legendarySpend', id: 'c2', amount: 2 },
      { type: 'start' },
      { type: 'moveAfter', id: 'c1', afterId: 'c3' },
    ]);
    expect(s.activeId).toBe('c2');
    expect(get(s, 'c2').legendary?.used).toBe(0);
    s = run([{ type: 'next' }, { type: 'next' }, { type: 'next' }], s);
    expect(s.round).toBe(2);
  });

  it('rejects an impossible move', () => {
    const { run } = harness();
    const s = run([fight, { type: 'start' }]); // c2 (Aria) is active
    expect(() => run([{ type: 'moveAfter', id: 'c2', afterId: 'c2' }], s)).toThrow();
    expect(() => run([{ type: 'moveAfter', id: 'c3', afterId: 'c3' }], s)).toThrow();
    expect(() => run([{ type: 'moveAfter', id: 'c1', afterId: 'c2' }], run([{ type: 'next' }], s))).toThrow(); // c1 is active, c2 acts before it
    const last = run([{ type: 'next' }, { type: 'next' }, { type: 'next' }], s);
    expect(last.activeId).toBe('c4');
    expect(() => run([{ type: 'moveAfter', id: 'c4', afterId: 'c2' }], last)).toThrow();
    expect(() => run([{ type: 'moveAfter', id: 'c3', afterId: 'nope' }], s)).toThrow();
    expect(() => run([{ type: 'moveAfter', id: 'nope', afterId: 'c3' }], s)).toThrow();
    // A non-active combatant may move anywhere, even ahead of the active turn
    expect(run([{ type: 'moveAfter', id: 'c4', afterId: 'c2' }], s).activeId).toBe('c2');
  });
});

describe('ready', () => {
  it('sets and clears a readied action, which lapses when the turn comes round again', () => {
    const { run } = harness();
    let s = run([{ type: 'add', combatants: [{ kind: 'pc', name: 'Aria', initiative: 15 }, { name: 'Orc', initiative: 5 }] }, { type: 'start' }, { type: 'ready', id: 'c1', trigger: 'when it attacks', spell: true }]);
    expect(get(s, 'c1').readied).toEqual({ trigger: 'when it attacks', spell: true });
    expect(get(run([{ type: 'readyClear', id: 'c1' }], s), 'c1').readied).toBeUndefined();
    s = run([{ type: 'next' }], s);
    expect(get(s, 'c1').readied).toBeDefined();
    s = run([{ type: 'next' }], s);
    expect(get(s, 'c1').readied).toBeUndefined();
  });

  it('cannot be set on the lair row', () => {
    const { run } = harness();
    expect(get(run([{ type: 'lairAdd' }, { type: 'ready', id: 'c1', trigger: 'x' }]), 'c1').readied).toBeUndefined();
  });
});

describe('old trackers', () => {
  it('still work without any of the new fields', () => {
    const old: TrackerState = {
      round: 1,
      activeId: 'a',
      combatants: [
        { id: 'a', kind: 'pc', ref: null, name: 'Old', initiative: 10, initBonus: 0, hp: 5, hpMax: 10, tempHp: 0, ac: 10, conditions: [], hidden: false, notes: '' },
        { id: 'b', kind: 'monster', ref: null, name: 'Older', initiative: 10, initBonus: 0, hp: 5, hpMax: 10, tempHp: 0, ac: 10, conditions: [], hidden: false, notes: '' },
      ],
    };
    const { run } = harness();
    const s = run([{ type: 'next' }, { type: 'hp', id: 'a', change: -5 }], old);
    expect(s.activeId).toBe('b');
    expect(projectTrackerForPlayers(s).combatants[0]).toMatchObject({ dying: { status: 'dying' }, readied: null });
  });
});

describe('player projection of the new data', () => {
  const SECRET = 'SENTINEL';
  function state() {
    const { run } = harness();
    return run([
      {
        type: 'add',
        combatants: [
          { kind: 'pc', name: 'Aria', initiative: 15, hpMax: 20, notes: `${SECRET} note` },
          {
            kind: 'monster',
            name: 'Dragon',
            initiative: 12,
            hpMax: 100,
            inLair: true,
            deathSaves: true,
            legendary: { perRound: 3 },
            resistance: { max: 3 },
            recharge: [{ name: `${SECRET} breath`, min: 5 }],
          },
          { kind: 'monster', name: 'Lurker', initiative: 9, hpMax: 10, hidden: true, deathSaves: true },
        ],
      },
      { type: 'hp', id: 'c1', change: -20 },
      { type: 'hp', id: 'c1', change: -1 },
      { type: 'hp', id: 'c2', change: -100 },
      { type: 'hp', id: 'c3', change: -10 },
      { type: 'ready', id: 'c1', trigger: 'when the door opens' },
      { type: 'ready', id: 'c2', trigger: `${SECRET} ambush` },
      { type: 'ready', id: 'c3', trigger: `${SECRET} hidden ambush` },
      { type: 'rechargeUsed', id: 'c2', name: `${SECRET} breath` },
      { type: 'lairAdd', name: 'Lair actions', ref: `${SECRET} group` },
      { type: 'update', id: 'c4', patch: { notes: `${SECRET} lair note` } },
    ]);
  }

  it('shows death saves and the trigger for player characters only', () => {
    const view = projectTrackerForPlayers(state());
    const [aria, dragon] = view.combatants;
    expect(aria).toMatchObject({ name: 'Aria', dying: { successes: 0, failures: 1, status: 'dying' }, readied: { trigger: 'when the door opens' } });
    expect(dragon).toMatchObject({ name: 'Dragon', dying: null, readied: null, health: 'down' });
  });

  it('never leaks legendary, resistance, recharge, lair, tie, notes or refs', () => {
    const s = state();
    const text = JSON.stringify(projectTrackerForPlayers(s));
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/legendary|resistance|recharge|inLair|tieRank|notes|"ref"|deathSaves|spell/);
    // An un-hidden lair row shows only its name and initiative
    const shown = { ...s, combatants: s.combatants.map((c) => (c.kind === 'lair' ? { ...c, hidden: false } : c)) };
    const lair = projectTrackerForPlayers(shown).combatants.find((c) => c.kind === 'lair');
    expect(lair).toEqual({ id: 'c4', name: 'Lair actions', kind: 'lair', initiative: 20, hp: null, health: null, conditions: [], dying: null, readied: null });
    expect(JSON.stringify(projectTrackerForPlayers(shown))).not.toContain(SECRET);
  });

  it('hides the active turn of a hidden combatant or the hidden lair row, and leaves no gap', () => {
    const { run } = harness();
    let s = run([{ type: 'start' }], state());
    expect(s.activeId).toBe('c4'); // the lair row (initiative 20)
    expect(projectTrackerForPlayers(s).activeId).toBeNull();
    s = run([{ type: 'next' }, { type: 'next' }, { type: 'next' }], s);
    expect(s.activeId).toBe('c3');
    expect(projectTrackerForPlayers(s).activeId).toBeNull();
    const view = projectTrackerForPlayers(s);
    expect(view.combatants.map((c) => c.name)).toEqual(['Aria', 'Dragon']);
    expect(view.round).toBe(s.round);
  });

  it('copies fields explicitly: a combatant with unknown extra data projects none of it', () => {
    const s = state();
    const poisoned: TrackerState = { ...s, combatants: s.combatants.map((c) => ({ ...c, extra: SECRET }) as Combatant) };
    expect(JSON.stringify(projectTrackerForPlayers(poisoned))).not.toContain(SECRET);
  });
});
