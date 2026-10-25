/**
 * Pure helpers of the DM tracker page (docs/design/tracker-ui.md): who gets which panel, counters and
 * pips, the d20 for "Roll for me", and the sentences for the screen-reader live region.
 */
import { legendaryMax, resistanceMax, type Combatant, type RechargeRoll, type TrackerAction, type TrackerState } from '@cn/shared';

export const makesDeathSaves = (c: Combatant) => c.kind === 'pc' || c.deathSaves === true;

/** At or below 0 hit points (an update may store a negative number). */
export const isDown = (c: Combatant) => c.hp !== null && c.hp <= 0;

/** The death-save panel: makes death saves, at 0 HP, with a dying state. */
export const showDeathPanel = (c: Combatant) => c.kind !== 'lair' && makesDeathSaves(c) && isDown(c) && !!c.dying;

/** The one button that starts the death saves of a combatant at 0 HP that has no dying state yet. */
export const showStartDeathSaves = (c: Combatant) => c.kind !== 'lair' && makesDeathSaves(c) && isDown(c) && !c.dying;

/** Monsters, NPCs and custom combatants without the flag are simply Down at 0 HP. */
export const showDownChip = (c: Combatant) => c.kind !== 'lair' && !makesDeathSaves(c) && isDown(c);

/** The Critical hit checkbox: death saves apply, at 0 HP, and not dead. */
export const showCrit = (c: Combatant) => c.kind !== 'lair' && makesDeathSaves(c) && isDown(c) && c.dying?.status !== 'dead';

/** Filled and empty pips of a counter. */
export const pips = (filled: number, total: number): boolean[] => Array.from({ length: total }, (_, i) => i < filled);

export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export interface CounterView {
  max: number;
  left: number;
  pips: boolean[];
  text: string;
  none: boolean;
}

function counter(used: number, max: number): CounterView {
  const left = Math.max(0, max - used);
  return { max, left, pips: pips(left, max), text: left === 0 ? 'None left' : `${left} of ${max} left`, none: left === 0 };
}

export function legendaryView(c: Combatant): CounterView | null {
  return c.legendary ? counter(c.legendary.used, legendaryMax(c.legendary, c.inLair)) : null;
}

export function resistanceView(c: Combatant): CounterView | null {
  return c.resistance ? counter(c.resistance.used, resistanceMax(c.resistance, c.inLair)) : null;
}

const NO_LEGENDARY = ['Incapacitated', 'Paralyzed', 'Stunned', 'Unconscious', 'Petrified'];

/** The condition (or "Down") that probably stops the creature from taking legendary actions. */
export function legendaryWarning(c: Combatant): string | null {
  const cond = c.conditions.find((x) => NO_LEGENDARY.some((n) => n.toLowerCase() === x.name.toLowerCase()));
  if (cond) return NO_LEGENDARY.find((n) => n.toLowerCase() === cond.name.toLowerCase())!;
  return isDown(c) ? 'Down' : null;
}

export interface RechargeChip {
  name: string;
  min: number;
  ready: boolean;
}

/** One chip per distinct name (the reducer acts on every entry with that name); ready only if all are. */
export function rechargeChips(c: Combatant): RechargeChip[] {
  const out: RechargeChip[] = [];
  for (const r of c.recharge ?? []) {
    const chip = out.find((x) => x.name.toLowerCase() === r.name.toLowerCase());
    if (chip) chip.ready &&= r.ready;
    else out.push({ name: r.name, min: r.min, ready: r.ready });
  }
  return out;
}

/** Who a combatant can move after: everyone else, or only those acting later when it is the active one. */
export function moveTargets(order: readonly Combatant[], mover: Combatant, activeId: string | null): Combatant[] {
  const ix = order.findIndex((c) => c.id === mover.id);
  return order.filter((c, i) => c.id !== mover.id && (activeId !== mover.id || i > ix));
}

/** No living combatant is marked as in its lair (the lair row has nothing to act for). */
export const lairNeedsCreature = (order: readonly Combatant[]) => !order.some((c) => c.kind !== 'lair' && c.inLair === true && (c.hp === null || c.hp > 0));

/** A d20 from the browser's random source, without modulo bias (private to the DM: never the shared dice log). */
export function rollD20(fill: (a: Uint8Array<ArrayBuffer>) => unknown = (a) => crypto.getRandomValues(a)): number {
  const bytes = new Uint8Array(1);
  for (;;) {
    fill(bytes);
    if (bytes[0]! < 240) return (bytes[0]! % 20) + 1; // 240 = 12 x 20: values above are rejected
  }
}

/** The d20 field: a whole number from 1 to 20, or null. */
export function parseRoll(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : null;
}

/** A recharge roll in words, result first. */
export function rechargeLine(creature: string, r: RechargeRoll): string {
  return `${creature}: ${r.name} rolled ${r.roll}, needs ${r.min} or more. ${r.ready ? 'Recharged.' : 'Still spent.'}`;
}

const counts = (d: { successes: number; failures: number }) => `${plural(d.successes, 'success', 'successes')}, ${plural(d.failures, 'failure')}`;

/**
 * The sentence that tells the DM what an action did, built from the touched combatant before and after.
 * Returns '' when there is nothing to say.
 */
export function announce(action: TrackerAction, prev: TrackerState, next: TrackerState): string {
  const before = 'id' in action ? prev.combatants.find((c) => c.id === action.id) : undefined;
  const after = 'id' in action ? next.combatants.find((c) => c.id === action.id) : undefined;
  const name = after?.name ?? before?.name ?? '';
  const turn = () => {
    const active = next.combatants.find((c) => c.id === next.activeId);
    return active ? `${active.name}'s turn.` : '';
  };
  switch (action.type) {
    case 'start':
    case 'next':
    case 'prev':
      return `Round ${next.round}. ${turn()}`.trim();
    case 'moveAfter': {
      const target = next.combatants.find((c) => c.id === action.afterId);
      const base = `${name} now acts after ${target?.name ?? 'the other'}.`;
      return next.activeId !== prev.activeId ? `${base} ${turn()}` : base;
    }
    case 'deathSave': {
      if (!before || !after) return '';
      if (before.hp !== null && before.hp <= 0 && (after.hp ?? 0) > 0) return `${name} is up at ${after.hp} HP.`;
      if (!after.dying) return '';
      const roll = action.roll;
      const word = roll === undefined ? '' : `, rolled ${roll}, ${roll === 1 ? 'two failures' : roll >= 10 ? 'a success' : 'a failure'}`;
      const status = after.dying.status === 'stable' ? ` ${name} is stable.` : after.dying.status === 'dead' ? ` ${name} is dead.` : '';
      return `${name}: death save${word}. ${counts(after.dying)}.${status}`;
    }
    case 'deathSaveAdjust': {
      if (!before || !after?.dying) return '';
      const d = after.dying;
      if (d.status !== before.dying?.status) return d.status === 'dying' ? `${name} is dying. ${counts(d)}.` : `${name} is ${d.status}.`;
      if (before.dying && before.dying.successes === d.successes && before.dying.failures === d.failures) {
        return action.successes ? `${name} already has ${plural(d.successes, 'success', 'successes')}` : action.failures ? `${name} already has ${plural(d.failures, 'failure')}` : '';
      }
      return `${name}: ${counts(d)}.`;
    }
    case 'hp': {
      if (!before || !after || before.hp === null) return '';
      if (action.change >= 0) {
        if (before.hp <= 0 && (after.hp ?? 0) > 0) return `${name} is up at ${after.hp} HP.`;
        return `${name} healed ${after.hp! - before.hp}, now at ${after.hp}.`;
      }
      const damage = -action.change;
      const failures = (after.dying?.failures ?? 0) - (before.dying?.failures ?? 0);
      if (after.dying?.status === 'dead' && before.dying?.status !== 'dead') return `${name} took ${damage} damage and is dead.`;
      if (after.dying && before.hp <= 0 && failures > 0) return `${name} took ${damage} damage and has ${plural(after.dying.failures, 'failure')}.`;
      if (before.hp <= 0 && makesDeathSaves(before) && failures === 0 && before.dying?.status !== 'dead' && after.tempHp < before.tempHp) return `${name}: ${damage} damage absorbed by temporary hit points, no failure.`;
      if (after.dying && before.hp > 0) return `${name} took ${damage} damage and is at 0 HP, dying.`;
      return `${name} took ${damage} damage.`;
    }
    case 'legendarySpend': {
      if (!before?.legendary || !after) return '';
      const was = legendaryView(before)!;
      const now = legendaryView(after)!;
      const asked = action.amount ?? 1;
      const lead = asked > was.left ? `${name} had only ${was.left} left. ` : '';
      return `${lead}${name}: ${now.none ? 'no legendary actions left' : plural(now.left, 'legendary action') + ' left'}.`;
    }
    case 'legendaryUndo': {
      if (!before?.legendary || !after) return '';
      const was = legendaryView(before)!;
      const now = legendaryView(after)!;
      return was.left === now.left ? `${name} already has all legendary actions.` : `${name}: ${plural(now.left, 'legendary action')} left.`;
    }
    case 'legendaryResist': {
      if (!before?.resistance || !after) return '';
      const was = resistanceView(before)!;
      const now = resistanceView(after)!;
      if (was.left === now.left) return action.undo ? `${name} already has all Legendary Resistance.` : `${name} has no Legendary Resistance left.`;
      return `${name}: ${now.none ? 'no Legendary Resistance left' : plural(now.left, 'Legendary Resistance', 'Legendary Resistances') + ' left'}.`;
    }
    case 'rechargeUsed':
      return `${action.name} marked used.`;
    case 'rechargeSet':
      return `${action.name} marked ${action.ready ? 'recharged' : 'used'}.`;
    case 'ready':
      return `${name} readied an action.`;
    case 'readyClear':
      return `The readied action of ${name} is cleared.`;
    case 'setInLair':
      return `${name} is ${action.inLair ? 'now' : 'no longer'} in its lair.`;
    case 'lairAdd':
      return 'Lair row added, hidden from players.';
    case 'update':
      if (after?.kind === 'lair' && action.patch.hidden !== undefined) return `${name} are now ${action.patch.hidden ? 'hidden from' : 'shown to'} players.`;
      if (action.patch.deathSaves !== undefined) return `${name}: death saves ${action.patch.deathSaves ? 'on' : 'off'}.`;
      return '';
    default:
      return '';
  }
}
