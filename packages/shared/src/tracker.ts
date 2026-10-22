/**
 * Initiative tracker: state, actions and a pure reducer (the server applies actions in order, so two DM
 * tabs never overwrite each other), plus the player projection: hidden combatants are left out and only
 * player characters show exact hit points.
 */
import * as z from 'zod';

export const COMBATANT_KINDS = ['monster', 'npc', 'pc', 'custom'] as const;
export type CombatantKind = (typeof COMBATANT_KINDS)[number];

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

export interface Combatant {
  id: string;
  kind: CombatantKind;
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
}

export interface TrackerState {
  round: number;
  activeId: string | null;
  combatants: Combatant[];
}

export const emptyTrackerState = (): TrackerState => ({ round: 0, activeId: null, combatants: [] });

const name = z.string().trim().min(1).max(120);
const small = z.number().int().min(-9999).max(99999);

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
      })
      .partial(),
  }),
  /** Negative: damage (temporary hit points first). Positive: healing, up to the maximum. */
  z.object({ type: z.literal('hp'), id, change: z.number().int().min(-99999).max(99999) }),
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

export interface ReducerContext {
  /** A d20 roll (1–20). */
  d20: () => number;
  newId: () => string;
}

/** Initiative order: highest first; ties by bonus, then name, then id (stable). */
export function sortCombatants(list: readonly Combatant[]): Combatant[] {
  return [...list].sort(
    (a, b) =>
      (b.initiative ?? -Infinity) - (a.initiative ?? -Infinity) || b.initBonus - a.initBonus || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

function tickConditions(c: Combatant): Combatant {
  const conditions = c.conditions
    .map((cond) => (cond.rounds === null ? cond : { ...cond, rounds: cond.rounds - 1 }))
    .filter((cond) => cond.rounds === null || cond.rounds > 0);
  return { ...c, conditions };
}

function mapOne(state: TrackerState, id: string, fn: (c: Combatant) => Combatant): TrackerState {
  return { ...state, combatants: state.combatants.map((c) => (c.id === id ? fn(c) : c)) };
}

export function applyTrackerAction(state: TrackerState, action: TrackerAction, ctx: ReducerContext): TrackerState {
  const a = trackerAction.parse(action);
  switch (a.type) {
    case 'add': {
      const added: Combatant[] = a.combatants.map((c) => {
        const input = combatantInput.parse(c);
        return { ...input, id: ctx.newId(), hp: input.hp ?? input.hpMax, conditions: [] };
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
      const next = mapOne(state, a.id, (c) => ({ ...c, ...a.patch }));
      return { ...next, combatants: sortCombatants(next.combatants) };
    }
    case 'hp':
      return mapOne(state, a.id, (c) => {
        if (c.hp === null) return c;
        if (a.change < 0) {
          const absorbed = Math.min(c.tempHp, -a.change);
          return { ...c, tempHp: c.tempHp - absorbed, hp: Math.max(0, c.hp - (-a.change - absorbed)) };
        }
        return { ...c, hp: c.hpMax === null ? c.hp + a.change : Math.min(c.hpMax, c.hp + a.change) };
      });
    case 'addCondition':
      return mapOne(state, a.id, (c) => ({
        ...c,
        conditions: [...c.conditions.filter((x) => x.name.toLowerCase() !== a.name.toLowerCase()), { name: a.name, rounds: a.rounds }],
      }));
    case 'removeCondition':
      return mapOne(state, a.id, (c) => ({ ...c, conditions: c.conditions.filter((x) => x.name.toLowerCase() !== a.name.toLowerCase()) }));
    case 'rollInitiative': {
      const roll = (c: Combatant) => (a.which === 'all' || (a.which === 'missing' && c.initiative === null) || (a.which === 'npcs' && c.kind !== 'pc') ? { ...c, initiative: ctx.d20() + c.initBonus } : c);
      return { ...state, combatants: sortCombatants(state.combatants.map(roll)) };
    }
    case 'start': {
      const order = sortCombatants(state.combatants);
      return { ...state, combatants: order, round: 1, activeId: order[0]?.id ?? null };
    }
    case 'next': {
      const order = sortCombatants(state.combatants);
      if (!order.length) return state;
      const ix = order.findIndex((c) => c.id === state.activeId);
      if (ix < 0) return { ...state, combatants: order, round: Math.max(1, state.round), activeId: order[0]!.id };
      // The active combatant's turn ends: its timed conditions count down
      const ticked = order.map((c, i) => (i === ix ? tickConditions(c) : c));
      const wraps = ix + 1 >= ticked.length;
      return { ...state, combatants: ticked, activeId: ticked[wraps ? 0 : ix + 1]!.id, round: state.round + (wraps ? 1 : 0) };
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

// region Player view

export type HealthWord = 'healthy' | 'wounded' | 'bloodied' | 'down';

export interface PlayerCombatant {
  id: string;
  name: string;
  kind: CombatantKind;
  initiative: number | null;
  /** Player characters only. */
  hp: { current: number; max: number | null; temp: number } | null;
  /** Everyone else: how hurt they look. */
  health: HealthWord | null;
  conditions: TrackerCondition[];
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

/** What players may see: no hidden combatants, no notes, no armor class, exact HP for player characters only. */
export function projectTrackerForPlayers(state: TrackerState): PlayerTrackerView {
  const visible = sortCombatants(state.combatants).filter((c) => !c.hidden);
  return {
    round: state.round,
    activeId: visible.some((c) => c.id === state.activeId) ? state.activeId : null,
    combatants: visible.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      initiative: c.initiative,
      hp: c.kind === 'pc' && c.hp !== null ? { current: c.hp, max: c.hpMax, temp: c.tempHp } : null,
      health: c.kind === 'pc' ? null : healthWord(c.hp, c.hpMax),
      conditions: c.conditions,
    })),
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
}

export interface TrackerSummaryDto {
  id: string;
  name: string;
  status: 'active' | 'ended';
  round: number;
  combatants: number;
  updatedAt: number;
}
