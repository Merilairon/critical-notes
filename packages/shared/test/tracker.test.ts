import { describe, expect, it } from 'vitest';
import { applyTrackerAction, emptyTrackerState, healthWord, projectTrackerForPlayers, type TrackerAction, type TrackerState } from '../src';

function ctx(rolls: number[] = []) {
  let n = 0;
  return { d20: () => rolls.shift() ?? 10, newId: () => `c${++n}` };
}

function run(actions: TrackerAction[], rolls: number[] = [], start: TrackerState = emptyTrackerState()) {
  const c = ctx(rolls);
  return actions.reduce((s, a) => applyTrackerAction(s, a, c), start);
}

const party: TrackerAction = {
  type: 'add',
  combatants: [
    { kind: 'pc', name: 'Aria', initiative: 15, initBonus: 3, hpMax: 30, ac: 16 },
    { kind: 'monster', name: 'Goblin', initBonus: 2, hpMax: 7, ac: 15 },
    { kind: 'monster', name: 'Lurker', initBonus: 4, hpMax: 20, hidden: true },
  ],
};

describe('initiative tracker', () => {
  it('rolls initiative for those without one and keeps the order sorted', () => {
    const s = run([party, { type: 'rollInitiative', which: 'missing' }], [18, 12]);
    expect(s.combatants.map((c) => `${c.name}:${c.initiative}`)).toEqual(['Lurker:22', 'Aria:15', 'Goblin:14']);
    expect(s.combatants.every((c) => c.hp === c.hpMax)).toBe(true);
  });

  it('cycles turns and rounds, counting conditions down at the end of their turn', () => {
    let s = run([party, { type: 'rollInitiative', which: 'missing' }, { type: 'start' }], [18, 12]);
    expect([s.round, s.activeId]).toEqual([1, 'c3']);
    s = run([{ type: 'addCondition', id: 'c2', name: 'Prone', rounds: 1 }, { type: 'addCondition', id: 'c2', name: 'Poisoned', rounds: null }], [], s);
    s = run([{ type: 'next' }, { type: 'next' }, { type: 'next' }], [], s);
    expect(s.round).toBe(2);
    expect(s.activeId).toBe('c3');
    expect(s.combatants.find((c) => c.id === 'c2')!.conditions).toEqual([{ name: 'Poisoned', rounds: null }]);
    s = run([{ type: 'prev' }], [], s);
    expect([s.round, s.activeId]).toEqual([1, 'c2']);
  });

  it('applies damage to temporary hit points first and caps healing', () => {
    let s = run([party, { type: 'update', id: 'c1', patch: { tempHp: 5 } }, { type: 'hp', id: 'c1', change: -8 }]);
    expect(s.combatants.find((c) => c.id === 'c1')).toMatchObject({ hp: 27, tempHp: 0 });
    s = run([{ type: 'hp', id: 'c1', change: 50 }, { type: 'hp', id: 'c2', change: -100 }], [], s);
    expect(s.combatants.find((c) => c.id === 'c1')!.hp).toBe(30);
    expect(s.combatants.find((c) => c.id === 'c2')!.hp).toBe(0);
  });

  it('hands the turn on when the active combatant is removed', () => {
    let s = run([party, { type: 'rollInitiative', which: 'missing' }, { type: 'start' }], [18, 12]);
    s = run([{ type: 'remove', id: 'c3' }], [], s);
    expect(s.activeId).toBe('c1');
    expect(s.combatants).toHaveLength(2);
  });

  it('rejects invalid actions', () => {
    expect(() => run([{ type: 'hp', id: 'c1', change: 1.5 } as TrackerAction])).toThrow();
    expect(() => run([{ type: 'explode' } as unknown as TrackerAction])).toThrow();
  });
});

describe('player view', () => {
  it('leaves out hidden combatants, notes and AC, and shows exact HP only for player characters', () => {
    let s = run([party, { type: 'rollInitiative', which: 'missing' }, { type: 'start' }, { type: 'update', id: 'c2', patch: { notes: 'Has the key' } }, { type: 'hp', id: 'c2', change: -4 }], [18, 12]);
    let view = projectTrackerForPlayers(s);
    expect(view.combatants.map((c) => c.name)).toEqual(['Aria', 'Goblin']);
    expect(view.activeId).toBeNull(); // the hidden Lurker is acting
    expect(view.combatants[0]).toEqual({ id: 'c1', name: 'Aria', kind: 'pc', initiative: 15, hp: { current: 30, max: 30, temp: 0 }, health: null, conditions: [] });
    expect(view.combatants[1]!.health).toBe('bloodied');
    expect(JSON.stringify(view)).not.toMatch(/Lurker|Has the key|"ac"/);
    s = run([{ type: 'next' }], [], s);
    view = projectTrackerForPlayers(s);
    expect(view.activeId).toBe('c1');
  });

  it('describes health in words', () => {
    expect([healthWord(10, 10), healthWord(9, 10), healthWord(5, 10), healthWord(0, 10), healthWord(null, 10)]).toEqual(['healthy', 'wounded', 'bloodied', 'down', null]);
  });
});
