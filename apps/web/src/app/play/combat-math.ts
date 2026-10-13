import type { EncounterResult, Ruleset } from '@cn/fivetools';
import type { EncounterCreature, ResolvedEncounterCreature } from '@cn/shared';

/** What the HP box understands: "-7" damage, "+5" or "5h" healing, "=20" set, "t5" temporary hit points. */
export type HpChange = { kind: 'damage' | 'heal' | 'set' | 'temp'; amount: number };

export function parseHpInput(raw: string): HpChange | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, '');
  const m = /^([-+=t]?)(\d{1,5})(h?)$/.exec(s);
  if (!m) return null;
  const amount = Number(m[2]);
  if (m[1] === '=') return { kind: 'set', amount };
  if (m[1] === 't') return { kind: 'temp', amount };
  if (m[1] === '+' || m[3] === 'h') return { kind: 'heal', amount };
  return { kind: 'damage', amount };
}

/** The ruleset's difficulty for an encounter: XP per line times its count, against the party's levels. */
export function encounterDifficulty(ruleset: Ruleset, partyLevels: number[], creatures: EncounterCreature[], resolved: ResolvedEncounterCreature[]): EncounterResult {
  const byId = new Map(resolved.map((r) => [r.id, r]));
  return ruleset.encounter.compute(
    partyLevels,
    creatures.map((c) => ({ xp: byId.get(c.id)?.xp ?? c.xp ?? 0, count: c.count })),
  );
}

/** "3 × Goblin, Owlbear" */
export function creatureSummary(creatures: EncounterCreature[], resolved: ResolvedEncounterCreature[]): string {
  const byId = new Map(resolved.map((r) => [r.id, r]));
  return creatures.map((c) => `${c.count > 1 ? `${c.count} × ` : ''}${byId.get(c.id)?.name ?? c.name ?? 'Creature'}`).join(', ');
}
