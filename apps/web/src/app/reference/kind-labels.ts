import { isKind, KINDS, type Ruleset } from '@cn/fivetools';

const PLURALS: Record<string, string> = {
  monster: 'Bestiary', spell: 'Spells', item: 'Items', background: 'Backgrounds', feat: 'Feats', class: 'Classes',
  optionalfeature: 'Optional Features', condition: 'Conditions', disease: 'Diseases', status: 'Statuses', action: 'Actions',
  variantrule: 'Rules', language: 'Languages', table: 'Tables', trap: 'Traps', hazard: 'Hazards', object: 'Objects',
  vehicle: 'Vehicles', deity: 'Deities', reward: 'Rewards', cult: 'Cults', boon: 'Boons', deck: 'Decks', facility: 'Bastion Facilities',
  recipe: 'Recipes', psionic: 'Psionics', charoption: 'Character Options',
};

/** Display label for a kind, using ruleset terminology (e.g. Species in 2024). */
export function kindLabel(kind: string, ruleset: Ruleset, plural = false): string {
  if (kind === 'race') return plural ? ruleset.terminology.races : ruleset.terminology.race;
  if (plural) return PLURALS[kind] ?? (isKind(kind) ? KINDS[kind].label : kind);
  return isKind(kind) ? KINDS[kind].label : kind;
}
