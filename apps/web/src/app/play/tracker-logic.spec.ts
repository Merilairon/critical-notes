import type { Combatant, TrackerState } from '@cn/shared';
import { announce, legendaryView, legendaryWarning, lairNeedsCreature, moveTargets, parseRoll, rechargeChips, resistanceView, rollD20, showCrit, showDeathPanel, showDownChip, showStartDeathSaves } from './tracker-logic';

const mk = (o: Partial<Combatant> & { id: string }): Combatant => ({ kind: 'monster', ref: null, name: o.id, initiative: 10, initBonus: 0, hp: 10, hpMax: 10, tempHp: 0, ac: 12, conditions: [], hidden: false, notes: '', ...o });
const st = (combatants: Combatant[], activeId: string | null = null): TrackerState => ({ round: 2, activeId, combatants });

describe('tracker panels', () => {
  const dyingPc = mk({ id: 'a', kind: 'pc', hp: 0, dying: { successes: 1, failures: 0, status: 'dying' } });
  it('shows the death panel for a dying PC and Down for a monster', () => {
    expect(showDeathPanel(dyingPc)).toBe(true);
    expect(showCrit(dyingPc)).toBe(true);
    expect(showCrit({ ...dyingPc, dying: { successes: 0, failures: 3, status: 'dead' } })).toBe(false);
    const orc = mk({ id: 'o', hp: -2, dying: { successes: 0, failures: 0, status: 'dying' } });
    expect(showDeathPanel(orc)).toBe(false);
    expect(showDownChip(orc)).toBe(true);
    expect(showDeathPanel({ ...orc, deathSaves: true })).toBe(true);
  });
  it('offers Start death saves when the state is missing', () => {
    expect(showStartDeathSaves(mk({ id: 'p', kind: 'pc', hp: 0 }))).toBe(true);
    expect(showStartDeathSaves(mk({ id: 'p', kind: 'lair', hp: null }))).toBe(false);
  });
  it('counts legendary actions with the lair numbers and warns', () => {
    const dragon = mk({ id: 'd', legendary: { perRound: 3, perRoundLair: 4, used: 1 }, resistance: { max: 3, maxLair: 4, used: 3 } });
    expect(legendaryView(dragon)).toMatchObject({ max: 3, left: 2, text: '2 of 3 left' });
    expect(legendaryView({ ...dragon, inLair: true })).toMatchObject({ max: 4, left: 3 });
    expect(resistanceView(dragon)).toMatchObject({ none: true, text: 'None left' });
    expect(legendaryWarning(dragon)).toBeNull();
    expect(legendaryWarning({ ...dragon, conditions: [{ name: 'stunned', rounds: null }] })).toBe('Stunned');
    expect(legendaryWarning({ ...dragon, hp: 0 })).toBe('Down');
  });
  it('makes one recharge chip per name', () => {
    const c = mk({ id: 'd', recharge: [{ name: 'Fire Breath', min: 5, ready: true }, { name: 'fire breath', min: 5, ready: false }, { name: 'Wing', min: 6, ready: true }] });
    expect(rechargeChips(c)).toEqual([{ name: 'Fire Breath', min: 5, ready: false }, { name: 'Wing', min: 6, ready: true }]);
  });
  it('limits Move after for the active combatant and warns about the lair', () => {
    const a = mk({ id: 'a', initiative: 20 });
    const b = mk({ id: 'b', initiative: 15 });
    const c = mk({ id: 'c', initiative: 5 });
    expect(moveTargets([a, b, c], a, 'a').map((x) => x.id)).toEqual(['b', 'c']);
    expect(moveTargets([a, b, c], c, 'c')).toEqual([]);
    expect(moveTargets([a, b, c], c, 'a').map((x) => x.id)).toEqual(['a', 'b']);
    expect(lairNeedsCreature([a])).toBe(true);
    expect(lairNeedsCreature([{ ...a, inLair: true }])).toBe(false);
    expect(lairNeedsCreature([{ ...a, inLair: true, hp: 0 }])).toBe(true);
  });
});

describe('d20', () => {
  it('rejects biased bytes and maps the rest to 1-20', () => {
    const seq = [255, 240, 0, 239];
    let i = 0;
    const fill = (a: Uint8Array) => (a[0] = seq[i++]!);
    expect(rollD20(fill)).toBe(1);
    expect(i).toBe(3);
    expect(rollD20(() => undefined as never)).toBeGreaterThanOrEqual(1);
  });
  it('uses the browser source by default', () => {
    for (let n = 0; n < 200; n++) expect([1, 20].includes(rollD20()) || (rollD20() >= 1 && rollD20() <= 20)).toBe(true);
  });
  it('parses the field', () => {
    expect(parseRoll('17')).toBe(17);
    expect([parseRoll(''), parseRoll('0'), parseRoll('21'), parseRoll('1.5')]).toEqual([null, null, null, null]);
  });
});

describe('announce', () => {
  const pc = mk({ id: 'p', kind: 'pc', name: 'Brenna', hp: 0, hpMax: 31, dying: { successes: 1, failures: 0, status: 'dying' } });
  it('describes a death save with the roll', () => {
    const after = { ...pc, dying: { successes: 1, failures: 1, status: 'dying' as const } };
    expect(announce({ type: 'deathSave', id: 'p', roll: 7 }, st([pc]), st([after]))).toBe('Brenna: death save, rolled 7, a failure. 1 success, 1 failure.');
    expect(announce({ type: 'deathSave', id: 'p', roll: 20 }, st([pc]), st([{ ...pc, hp: 1, dying: undefined }]))).toBe('Brenna is up at 1 HP.');
  });
  it('says when the temp HP absorbed the damage', () => {
    const before = { ...pc, tempHp: 5 };
    expect(announce({ type: 'hp', id: 'p', change: -3 }, st([before]), st([{ ...before, tempHp: 2 }]))).toBe('Brenna: 3 damage absorbed by temporary hit points, no failure.');
    expect(announce({ type: 'hp', id: 'p', change: -3 }, st([pc]), st([{ ...pc, dying: { successes: 1, failures: 1, status: 'dying' } }]))).toBe('Brenna took 3 damage and has 1 failure.');
  });
  it('announces a no-op stepper and the turn after Move after', () => {
    const three = { ...pc, dying: { successes: 0, failures: 3, status: 'dead' as const } };
    expect(announce({ type: 'deathSaveAdjust', id: 'p', failures: 1 }, st([three]), st([three]))).toContain('already has 3 failures');
    const a = mk({ id: 'a', name: 'Aldric', initiative: 17 });
    const b = mk({ id: 'b', name: 'Bea', initiative: 10 });
    const moved = { ...a, initiative: 10 };
    expect(announce({ type: 'moveAfter', id: 'a', afterId: 'b' }, st([a, b], 'a'), st([moved, b], 'b'))).toBe("Aldric now acts after Bea. Bea's turn.");
    expect(announce({ type: 'next' }, st([a, b], 'a'), st([a, b], 'b'))).toBe("Round 2. Bea's turn.");
  });
  it('counts legendary actions', () => {
    const d = mk({ id: 'd', name: 'Dragon', legendary: { perRound: 3, perRoundLair: 3, used: 2 } });
    const after = { ...d, legendary: { ...d.legendary!, used: 3 } };
    expect(announce({ type: 'legendarySpend', id: 'd', amount: 2 }, st([d]), st([after]))).toBe('Dragon had only 1 left. Dragon: no legendary actions left.');
  });
});
