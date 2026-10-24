/**
 * Initiative tracker: state, actions and a pure reducer (the server applies actions in order, so two DM
 * tabs never overwrite each other), plus the player projection: hidden combatants are left out and only
 * player characters show exact hit points. Rules: docs/design/tracker-rules.md.
 */
import * as z from 'zod';

export const COMBATANT_KINDS = ['monster', 'npc', 'pc', 'custom'] as const;
export type CombatantKind = (typeof COMBATANT_KINDS)[number];

/** A combatant kind, or the lair-action pseudo-combatant (initiative 20; added with `lairAdd` only). */
export type TrackerKind = CombatantKind | 'lair';

/** Conditions offered by the tracker (any other name can be typed in). */
export const TRACKER_CONDITIONS = [
  'Blinded',
  'Charmed',
  'Concentrating',
  'Deafened',
  'Exhaustion',
  'Frightened',
  'Grappled',
  'Incapacitated',
  'Invisible',
  'Paralyzed',
  'Petrified',
  'Poisoned',
  'Prone',
  'Restrained',
  'Stunned',
  'Unconscious',
] as const;

export interface TrackerCondition {
  name: string;
  /** Rounds left (counted down at the end of the combatant's turn); null lasts until removed. */
  rounds: number | null;
}

export type DyingStatus = 'dying' | 'stable' | 'dead';

/** Death saving throws; absent while the combatant is above 0 HP. */
export interface DyingState {
  successes: number;
  failures: number;
  status: DyingStatus;
}

/** Legendary actions (exists only for creatures that have them). DM-only. */
export interface LegendaryState {
  perRound: number;
  perRoundLair: number;
  used: number;
}

/** Legendary Resistance (exists only for creatures that have it). DM-only. */
export interface ResistanceState {
  max: number;
  maxLair: number;
  used: number;
}

export interface RechargeState {
  name: string;
  /** 2-6: the lowest d6 roll that makes the ability ready. */
  min: number;
  ready: boolean;
}

export interface ReadiedState {
  trigger: string;
  spell: boolean;
}

/** Tie-break rank of the lair row: it loses every tie at its initiative. */
export const LAIR_TIE_RANK = 1000;

export interface Combatant {
  id: string;
  kind: TrackerKind;
  /** Monster uid, or the NPC / player character page id. */
  ref: string | null;
  name: string;
  initiative: number | null;
  initBonus: number;
  hp: number | null;
  hpMax: number | null;
  tempHp: number;
  ac: number | null;
  conditions: TrackerCondition[];
  /** Hidden from the player view (an ambusher, a creature not yet seen). */
  hidden: boolean;
  notes: string;
  /** DM flag: this combatant makes death saves (player characters always do). */
  deathSaves?: boolean;
  dying?: DyingState;
  legendary?: LegendaryState;
  resistance?: ResistanceState;
  /** Manual toggle: fighting in its lair (uses the lair numbers). */
  inLair?: boolean;
  recharge?: RechargeState[];
  readied?: ReadiedState;
  /** Tie-break for equal initiative (lower acts first). */
  tieRank?: number;
}

export interface TrackerState {
  round: number;
  activeId: string | null;
  combatants: Combatant[];
}

export const emptyTrackerState = (): TrackerState => ({ round: 0, activeId: null, combatants: [] });

const name = z.string().trim().min(1).max(120);
const small = z.number().int().min(-9999).max(99999);
const count = z.number().int().min(1).max(20);

export const legendaryInput = z.object({ perRound: count, perRoundLair: count.optional() });
export const resistanceInput = z.object({ max: count, maxLair: count.optional() });
export const rechargeInput = z.object({ name, min: z.number().int().min(2).max(6) });
export type LegendaryInput = z.input<typeof legendaryInput>;
export type ResistanceInput = z.input<typeof resistanceInput>;
export type RechargeInput = z.input<typeof rechargeInput>;

export const combatantInput = z.object({
  kind: z.enum(COMBATANT_KINDS).default('custom'),
  ref: z.string().max(300).nullable().default(null),
  name,
  initiative: z.number().int().min(-50).max(100).nullable().default(null),
  initBonus: z.number().int().min(-20).max(40).default(0),
  hp: small.nullable().default(null),
  hpMax: small.nullable().default(null),
  tempHp: z.number().int().min(0).max(9999).default(0),
  ac: z.number().int().min(0).max(99).nullable().default(null),
  hidden: z.boolean().default(false),
  notes: z.string().max(2000).default(''),
  deathSaves: z.boolean().default(false),
  inLair: z.boolean().default(false),
  legendary: legendaryInput.optional(),
  resistance: resistanceInput.optional(),
  recharge: z.array(rechargeInput).max(20).optional(),
});
export type CombatantInput = z.input<typeof combatantInput>;

const id = z.string().min(1).max(40);

export const trackerAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add'), combatants: z.array(combatantInput).min(1).max(50) }),
  z.object({ type: z.literal('remove'), id }),
  z.object({
    type: z.literal('update'),
    id,
    patch: z
      .object({
        name,
        initiative: z.number().int().min(-50).max(100).nullable(),
        initBonus: z.number().int().min(-20).max(40),
        hp: small.nullable(),
        hpMax: small.nullable(),
        tempHp: z.number().int().min(0).max(9999),
        ac: z.number().int().min(0).max(99).nullable(),
        hidden: z.boolean(),
        notes: z.string().max(2000),
        deathSaves: z.boolean(),
        /** Edit the legendary action count (null removes it); spent uses are kept. */
        legendary: legendaryInput.nullable(),
        /** Edit Legendary Resistance (null removes it); `used` sets the spent count. */
        resistance: resistanceInput.extend({ used: z.number().int().min(0).max(20).optional() }).nullable(),
      })
      .partial(),
  }),
  /**
   * Negative: damage (temporary hit points first). Positive: healing, up to the maximum.
   * `crit`: the damage is a critical hit (two death-save failures on a combatant at 0 HP).
   */
  z.object({ type: z.literal('hp'), id, change: z.number().int().min(-99999).max(99999), crit: z.boolean().default(false) }),
  /** A death save; `roll` is the d20 the player rolled (typed by the DM), otherwise the server rolls. */
  z.object({ type: z.literal('deathSave'), id, roll: z.number().int().min(1).max(20).optional() }),
  /** Manual death-save edits: counter deltas (clamped 0-3), reset, or set the status (for example stable). */
  z.object({
    type: z.literal('deathSaveAdjust'),
    id,
    successes: z.number().int().min(-3).max(3).default(0),
    failures: z.number().int().min(-3).max(3).default(0),
    reset: z.boolean().default(false),
    status: z.enum(['dying', 'stable', 'dead']).optional(),
  }),
  z.object({ type: z.literal('legendarySpend'), id, amount: z.number().int().min(1).max(3).default(1) }),
  z.object({ type: z.literal('legendaryUndo'), id, amount: z.number().int().min(1).max(3).default(1) }),
  /** Uses one Legendary Resistance (or gives one back). */
  z.object({ type: z.literal('legendaryResist'), id, undo: z.boolean().default(false) }),
  /** Marks a recharge ability as spent. */
  z.object({ type: z.literal('rechargeUsed'), id, name: z.string().max(120) }),
  /** Manual override: ready or spent. */
  z.object({ type: z.literal('rechargeSet'), id, name: z.string().max(120), ready: z.boolean() }),
  z.object({ type: z.literal('setInLair'), id, inLair: z.boolean() }),
  /** Adds the lair-action row (hidden, initiative 20, loses ties). `markInLair`: creatures to flag as in their lair. */
  z.object({
    type: z.literal('lairAdd'),
    name: z.string().trim().min(1).max(120).default('Lair actions'),
    ref: z.string().max(300).nullable().default(null),
    markInLair: z.array(id).max(50).default([]),
  }),
  /** Delay: the combatant takes the initiative of `afterId` and acts right after it. */
  z.object({ type: z.literal('moveAfter'), id, afterId: id }),
  z.object({ type: z.literal('ready'), id, trigger: z.string().trim().min(1).max(200), spell: z.boolean().default(false) }),
  z.object({ type: z.literal('readyClear'), id }),
  z.object({ type: z.literal('addCondition'), id, name: z.string().trim().min(1).max(60), rounds: z.number().int().min(1).max(1000).nullable().default(null) }),
  z.object({ type: z.literal('removeCondition'), id, name: z.string().max(60) }),
  /** Rolls d20 + initiative bonus for these combatants (or every one without an initiative / every one). */
  z.object({ type: z.literal('rollInitiative'), which: z.enum(['missing', 'npcs', 'all']).default('missing') }),
  z.object({ type: z.literal('start') }),
  z.object({ type: z.literal('next') }),
  z.object({ type: z.literal('prev') }),
  z.object({ type: z.literal('end') }),
]);
export type TrackerAction = z.input<typeof trackerAction>;

/** A recharge roll made when a combatant's turn starts (DM-only: a toast, never projected). */
export interface RechargeRoll {
  combatantId: string;
  name: string;
  roll: number;
  min: number;
  ready: boolean;
}

export interface ReducerContext {
  /** A d20 roll (1–20). */
  d20: () => number;
  /** A d6 roll (1–6), for recharge abilities. */
  d6: () => number;
  newId: () => string;
  /** Called for each recharge roll the reducer makes. */
  onRecharge?: (roll: RechargeRoll) => void;
}

/** Initiative order: highest first; ties by `tieRank`, then bonus, then name, then id (stable). */
export function sortCombatants(list: readonly Combatant[]): Combatant[] {
  return [...list].sort(
    (a, b) =>
      (b.initiative ?? -Infinity) - (a.initiative ?? -Infinity) ||
      (a.tieRank ?? 0) - (b.tieRank ?? 0) ||
      b.initBonus - a.initBonus ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Whether this combatant makes death saves. */
const makesDeathSaves = (c: Combatant) => c.kind === 'pc' || c.deathSaves === true;

/** Legendary action uses per round and Legendary Resistance uses, for where the creature is. */
export const legendaryMax = (l: LegendaryState, inLair: boolean | undefined) => (inLair ? l.perRoundLair : l.perRound);
export const resistanceMax = (r: ResistanceState, inLair: boolean | undefined) => (inLair ? r.maxLair : r.max);

function legendaryFrom(i: z.output<typeof legendaryInput>, used = 0): LegendaryState {
  const perRoundLair = i.perRoundLair ?? i.perRound;
  return { perRound: i.perRound, perRoundLair, used: clamp(used, 0, Math.max(i.perRound, perRoundLair)) };
}

function resistanceFrom(i: z.output<typeof resistanceInput>, used = 0): ResistanceState {
  const maxLair = i.maxLair ?? i.max;
  return { max: i.max, maxLair, used: clamp(used, 0, Math.max(i.max, maxLair)) };
}

/** Settles a death-save state after its counters change: three of either ends it. */
function settle(d: DyingState): DyingState {
  const successes = clamp(d.successes, 0, 3);
  const failures = clamp(d.failures, 0, 3);
  if (d.status === 'dead' || failures >= 3) return { successes, failures, status: 'dead' };
  if (d.status === 'stable' || successes >= 3) return { successes, failures, status: 'stable' };
  return { successes, failures, status: 'dying' };
}

function withoutDying(c: Combatant): Combatant {
  const next = { ...c };
  delete next.dying;
  return next;
}

/** Death-save failures land on a combatant at 0 HP; a stable one becomes unstable again, a dead one stays dead. */
function addFailures(c: Combatant, n: number): Combatant {
  const d = c.dying;
  if (d?.status === 'dead') return c;
  const base: DyingState = !d || d.status === 'stable' ? { successes: 0, failures: 0, status: 'dying' } : d;
  return { ...c, dying: settle({ ...base, failures: base.failures + n }) };
}

/** Turn start: legendary actions come back, spent recharge abilities roll, a readied action lapses. */
function beginTurn(c: Combatant, ctx: ReducerContext): Combatant {
  const next = { ...c };
  if (next.legendary) next.legendary = { ...next.legendary, used: 0 };
  delete next.readied;
  if (next.recharge?.some((r) => !r.ready)) {
    next.recharge = next.recharge.map((r) => {
      if (r.ready) return r;
      const roll = ctx.d6();
      const ready = roll >= r.min;
      ctx.onRecharge?.({ combatantId: c.id, name: r.name, roll, min: r.min, ready });
      return ready ? { ...r, ready } : r;
    });
  }
  return next;
}

function activate(list: readonly Combatant[], id: string | null, ctx: ReducerContext): Combatant[] {
  return list.map((c) => (c.id === id ? beginTurn(c, ctx) : c));
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function tickConditions(c: Combatant): Combatant {
  const conditions = c.conditions
    .map((cond) => (cond.rounds === null ? cond : { ...cond, rounds: cond.rounds - 1 }))
    .filter((cond) => cond.rounds === null || cond.rounds > 0);
  return { ...c, conditions };
}

function mapOne(state: TrackerState, id: string, fn: (c: Combatant) => Combatant): TrackerState {
  return { ...state, combatants: state.combatants.map((c) => (c.id === id ? fn(c) : c)) };
}

function applyDamage(c: Combatant, damage: number, crit: boolean): Combatant {
  if (c.hp === null) return c;
  const absorbed = Math.min(c.tempHp, damage);
  const rest = damage - absorbed;
  const base = { ...c, tempHp: c.tempHp - absorbed };
  // Damage fully absorbed by temporary hit points adds no death-save failure (table convention)
  if (rest === 0) return base;
  if (c.hp <= 0) return makesDeathSaves(c) ? addFailures({ ...base, hp: 0 }, crit ? 2 : 1) : { ...base, hp: 0 };
  const overflow = rest - c.hp; // computed before the clamp to 0
  const hit = { ...base, hp: Math.max(0, c.hp - rest) };
  if (hit.hp > 0 || !makesDeathSaves(c)) return hit;
  // Massive damage: the overflow alone reaches the maximum
  if (c.hpMax !== null && overflow >= c.hpMax) return { ...hit, dying: { successes: 0, failures: 0, status: 'dead' } };
  return { ...hit, dying: { successes: 0, failures: 0, status: 'dying' } };
}

function moveAfter(state: TrackerState, moverId: string, afterId: string, ctx: ReducerContext): TrackerState {
  if (moverId === afterId) throw new Error('A combatant cannot move after itself');
  const order = sortCombatants(state.combatants);
  const ix = order.findIndex((c) => c.id === moverId);
  const tx = order.findIndex((c) => c.id === afterId);
  if (ix < 0 || tx < 0) throw new Error('Combatant not found');
  const mover = order[ix]!;
  const target = order[tx]!;
  const isActive = state.activeId === moverId;
  if (isActive && tx < ix) throw new Error('The active combatant can only move after a combatant that acts later');
  const nextActive = isActive ? order[ix + 1]!.id : state.activeId; // tx > ix, so there is a next one

  // Rebuild the tie ranks of everyone at the target's initiative so that the mover sits right after the target
  const group = order.filter((c) => c.initiative === target.initiative && c.id !== moverId);
  group.splice(group.findIndex((c) => c.id === afterId) + 1, 0, mover);
  const ranks = new Map<string, number>();
  let rank = 0;
  for (const c of group) {
    if (c.kind === 'lair') rank = Math.max(rank, c.tieRank ?? LAIR_TIE_RANK);
    ranks.set(c.id, rank++);
  }
  let combatants = order.map((c) => {
    const tieRank = ranks.get(c.id);
    if (tieRank === undefined) return c;
    return c.id === moverId ? { ...c, initiative: target.initiative, tieRank } : { ...c, tieRank };
  });
  // The mover's turn did not finish: no condition ticks. Whoever follows it starts a turn.
  if (isActive) combatants = activate(combatants, nextActive, ctx);
  return { ...state, activeId: nextActive, combatants: sortCombatants(combatants) };
}

export function applyTrackerAction(state: TrackerState, action: TrackerAction, ctx: ReducerContext): TrackerState {
  const a = trackerAction.parse(action);
  switch (a.type) {
    case 'add': {
      const added: Combatant[] = a.combatants.map((c) => {
        const { legendary, resistance, recharge, deathSaves, inLair, ...input } = combatantInput.parse(c);
        return {
          ...input,
          id: ctx.newId(),
          hp: input.hp ?? input.hpMax,
          conditions: [],
          ...(deathSaves ? { deathSaves } : {}),
          ...(inLair ? { inLair } : {}),
          ...(legendary ? { legendary: legendaryFrom(legendary) } : {}),
          ...(resistance ? { resistance: resistanceFrom(resistance) } : {}),
          ...(recharge?.length ? { recharge: recharge.map((r) => ({ name: r.name, min: r.min, ready: true })) } : {}),
        };
      });
      return { ...state, combatants: sortCombatants([...state.combatants, ...added]) };
    }
    case 'remove': {
      const order = sortCombatants(state.combatants);
      const ix = order.findIndex((c) => c.id === a.id);
      if (ix < 0) return state;
      let activeId = state.activeId;
      if (activeId === a.id) {
        const rest = order.filter((c) => c.id !== a.id);
        activeId = rest.length ? (rest[ix % rest.length]?.id ?? null) : null;
      }
      return { ...state, activeId, combatants: order.filter((c) => c.id !== a.id) };
    }
    case 'update': {
      const { legendary, resistance, ...patch } = a.patch;
      const next = mapOne(state, a.id, (c) => {
        let out: Combatant = { ...c, ...patch };
        if (legendary !== undefined) {
          delete out.legendary;
          if (legendary) out.legendary = legendaryFrom(legendary, c.legendary?.used);
        }
        if (resistance !== undefined) {
          delete out.resistance;
          if (resistance) out.resistance = resistanceFrom(resistance, resistance.used ?? c.resistance?.used);
        }
        // An hp edit above 0 clears the death saves; dropping a character to 0 starts them
        if (patch.hp !== undefined && patch.hp !== null) {
          if (patch.hp > 0) out = withoutDying(out);
          else if (makesDeathSaves(out) && (c.hp ?? 0) > 0 && !out.dying) out.dying = { successes: 0, failures: 0, status: 'dying' };
        }
        return out;
      });
      return { ...next, combatants: sortCombatants(next.combatants) };
    }
    case 'hp':
      return mapOne(state, a.id, (c) => {
        if (c.hp === null) return c;
        if (a.change < 0) return applyDamage(c, -a.change, a.crit);
        const hp = c.hpMax === null ? c.hp + a.change : Math.min(c.hpMax, c.hp + a.change);
        const healed = { ...c, hp };
        return hp > 0 ? withoutDying(healed) : healed;
      });
    case 'deathSave':
      return mapOne(state, a.id, (c) => {
        if (c.hp === null || c.hp > 0 || c.dying?.status === 'dead') return c;
        const roll = a.roll ?? ctx.d20();
        if (roll === 20) return withoutDying({ ...c, hp: 1 });
        const d: DyingState = !c.dying || c.dying.status === 'stable' ? { successes: 0, failures: 0, status: 'dying' } : c.dying;
        const delta = roll === 1 ? { failures: 2 } : roll >= 10 ? { successes: 1 } : { failures: 1 };
        return { ...c, dying: settle({ ...d, successes: d.successes + (delta.successes ?? 0), failures: d.failures + (delta.failures ?? 0) }) };
      });
    case 'deathSaveAdjust':
      return mapOne(state, a.id, (c) => {
        if (c.hp === null || c.hp > 0) return c;
        const d: DyingState = a.reset || !c.dying ? { successes: 0, failures: 0, status: 'dying' } : c.dying;
        return {
          ...c,
          dying: settle({ successes: d.successes + a.successes, failures: d.failures + a.failures, status: a.status ?? (a.reset ? 'dying' : d.status) }),
        };
      });
    case 'legendarySpend':
      return mapOne(state, a.id, (c) =>
        c.legendary ? { ...c, legendary: { ...c.legendary, used: Math.min(legendaryMax(c.legendary, c.inLair), c.legendary.used + a.amount) } } : c,
      );
    case 'legendaryUndo':
      return mapOne(state, a.id, (c) => (c.legendary ? { ...c, legendary: { ...c.legendary, used: Math.max(0, c.legendary.used - a.amount) } } : c));
    case 'legendaryResist':
      return mapOne(state, a.id, (c) => {
        if (!c.resistance) return c;
        const used = a.undo ? c.resistance.used - 1 : c.resistance.used + 1;
        return { ...c, resistance: { ...c.resistance, used: clamp(used, 0, resistanceMax(c.resistance, c.inLair)) } };
      });
    case 'rechargeUsed':
    case 'rechargeSet': {
      const ready = a.type === 'rechargeSet' ? a.ready : false;
      return mapOne(state, a.id, (c) => (c.recharge ? { ...c, recharge: c.recharge.map((r) => (sameName(r.name, a.name) ? { ...r, ready } : r)) } : c));
    }
    case 'setInLair':
      return mapOne(state, a.id, (c) => {
        const out: Combatant = { ...c };
        delete out.inLair;
        if (a.inLair) out.inLair = true;
        return withLairCaps(out);
      });
    case 'lairAdd': {
      const row: Combatant = {
        id: ctx.newId(),
        kind: 'lair',
        ref: a.ref,
        name: a.name,
        initiative: 20,
        initBonus: 0,
        hp: null,
        hpMax: null,
        tempHp: 0,
        ac: null,
        conditions: [],
        hidden: true,
        notes: '',
        tieRank: LAIR_TIE_RANK,
      };
      const marked = new Set(a.markInLair);
      const rest = state.combatants.map((c) => (marked.has(c.id) && c.kind !== 'lair' ? withLairCaps({ ...c, inLair: true }) : c));
      return { ...state, combatants: sortCombatants([...rest, row]) };
    }
    case 'moveAfter':
      return moveAfter(state, a.id, a.afterId, ctx);
    case 'ready':
      return mapOne(state, a.id, (c) => (c.kind === 'lair' ? c : { ...c, readied: { trigger: a.trigger, spell: a.spell } }));
    case 'readyClear':
      return mapOne(state, a.id, withoutReadied);
    case 'addCondition':
      return mapOne(state, a.id, (c) => ({
        ...c,
        conditions: [...c.conditions.filter((x) => x.name.toLowerCase() !== a.name.toLowerCase()), { name: a.name, rounds: a.rounds }],
      }));
    case 'removeCondition':
      return mapOne(state, a.id, (c) => ({ ...c, conditions: c.conditions.filter((x) => x.name.toLowerCase() !== a.name.toLowerCase()) }));
    case 'rollInitiative': {
      const roll = (c: Combatant) => (c.kind === 'lair' ? c : a.which === 'all' || (a.which === 'missing' && c.initiative === null) || (a.which === 'npcs' && c.kind !== 'pc') ? { ...c, initiative: ctx.d20() + c.initBonus } : c);
      return { ...state, combatants: sortCombatants(state.combatants.map(roll)) };
    }
    case 'start': {
      const order = sortCombatants(state.combatants);
      const activeId = order[0]?.id ?? null;
      return { ...state, combatants: activate(order, activeId, ctx), round: 1, activeId };
    }
    case 'next': {
      const order = sortCombatants(state.combatants);
      if (!order.length) return state;
      const ix = order.findIndex((c) => c.id === state.activeId);
      if (ix < 0) return { ...state, combatants: activate(order, order[0]!.id, ctx), round: Math.max(1, state.round), activeId: order[0]!.id };
      // The active combatant's turn ends: its timed conditions count down
      const ticked = order.map((c, i) => (i === ix ? tickConditions(c) : c));
      const wraps = ix + 1 >= ticked.length;
      const activeId = ticked[wraps ? 0 : ix + 1]!.id;
      return { ...state, combatants: activate(ticked, activeId, ctx), activeId, round: state.round + (wraps ? 1 : 0) };
    }
    case 'prev': {
      const order = sortCombatants(state.combatants);
      const ix = order.findIndex((c) => c.id === state.activeId);
      if (ix < 0 || !order.length) return state;
      if (ix === 0) return state.round <= 1 ? state : { ...state, activeId: order.at(-1)!.id, round: state.round - 1 };
      return { ...state, activeId: order[ix - 1]!.id };
    }
    case 'end':
      return { ...state, activeId: null };
  }
}

/** Counters never exceed the numbers of the place the creature is now in. */
function withLairCaps(c: Combatant): Combatant {
  const out = { ...c };
  if (out.legendary) out.legendary = { ...out.legendary, used: Math.min(out.legendary.used, legendaryMax(out.legendary, out.inLair)) };
  if (out.resistance) out.resistance = { ...out.resistance, used: Math.min(out.resistance.used, resistanceMax(out.resistance, out.inLair)) };
  return out;
}

function withoutReadied(c: Combatant): Combatant {
  const next = { ...c };
  delete next.readied;
  return next;
}

// region Player view

export type HealthWord = 'healthy' | 'wounded' | 'bloodied' | 'down';

export interface PlayerCombatant {
  id: string;
  name: string;
  kind: TrackerKind;
  initiative: number | null;
  /** Player characters only. */
  hp: { current: number; max: number | null; temp: number } | null;
  /** Everyone else: how hurt they look. */
  health: HealthWord | null;
  conditions: TrackerCondition[];
  /** Player characters only: death saves, rolled in the open. */
  dying: DyingState | null;
  /** Player characters only: the readied action's trigger. */
  readied: { trigger: string } | null;
}

export interface PlayerTrackerView {
  round: number;
  /** Null while a hidden combatant acts (its turn is not revealed). */
  activeId: string | null;
  combatants: PlayerCombatant[];
}

export function healthWord(hp: number | null, max: number | null): HealthWord | null {
  if (hp === null || max === null || max <= 0) return null;
  if (hp <= 0) return 'down';
  if (hp <= max / 2) return 'bloodied';
  return hp < max ? 'wounded' : 'healthy';
}

/**
 * What players may see: no hidden combatants, no notes, no armor class, exact HP for player characters only.
 * Death saves and a readied trigger show for player characters; legendary, recharge, lair and tie data never.
 * Fields are copied one by one, never spread.
 */
export function projectTrackerForPlayers(state: TrackerState): PlayerTrackerView {
  const visible = sortCombatants(state.combatants).filter((c) => !c.hidden);
  return {
    round: state.round,
    activeId: visible.some((c) => c.id === state.activeId) ? state.activeId : null,
    combatants: visible.map((c) => {
      if (c.kind === 'lair') {
        // An un-hidden lair row shows only its name and initiative
        return { id: c.id, name: c.name, kind: c.kind, initiative: c.initiative, hp: null, health: null, conditions: [], dying: null, readied: null };
      }
      const pc = c.kind === 'pc';
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        initiative: c.initiative,
        hp: pc && c.hp !== null ? { current: c.hp, max: c.hpMax, temp: c.tempHp } : null,
        health: pc ? null : healthWord(c.hp, c.hpMax),
        conditions: c.conditions.map((x) => ({ name: x.name, rounds: x.rounds })),
        dying: pc && c.dying ? { successes: c.dying.successes, failures: c.dying.failures, status: c.dying.status } : null,
        readied: pc && c.readied ? { trigger: c.readied.trigger } : null,
      };
    }),
  };
}

// endregion

export interface TrackerDto {
  id: string;
  campaignId: string;
  encounterId: string | null;
  name: string;
  status: 'active' | 'ended';
  state: TrackerState;
  revision: number;
  updatedAt: number;
  /** Recharge rolls made by this action (DM response and DM event only; not stored, never sent to players). */
  rolls?: RechargeRoll[];
}

export interface TrackerSummaryDto {
  id: string;
  name: string;
  status: 'active' | 'ended';
  round: number;
  combatants: number;
  updatedAt: number;
}
