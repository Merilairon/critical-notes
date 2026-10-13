/**
 * Ruleset abstraction. Everything that differs between the 2014 and 2024 rules is expressed here, so the
 * rest of the app (and the UI) asks the ruleset instead of comparing edition strings.
 */
import { crToXp } from '../constants';
import { rulesetEdition, type RulesetId } from '../edition/policy';
import type { Edition } from '../edition/sources';
import { classicEncounterRules, modernEncounterRules, type EncounterRules } from './encounter';

export interface Terminology {
  race: string;
  races: string;
  subrace: string;
  encounterDifficulty: string;
  /** Label of the cross-edition switch in this ruleset. */
  crossEditionToggle: string;
  /** Badge text shown on content from the other edition. */
  otherEditionBadge: string;
}

export interface RulesetFeatures {
  /** Weapons have mastery properties (2024). */
  weaponMastery: boolean;
  /** Backgrounds grant ability score increases (2024). */
  backgroundAbilityScores: boolean;
  /** Backgrounds grant an origin feat (2024). */
  backgroundFeat: boolean;
  /** Species/races grant ability score increases (2014). */
  speciesAbilityScores: boolean;
  /** Exhaustion: six cumulative effect levels (2014) or −2 per level to d20 tests (2024). */
  exhaustionModel: 'levels6' | 'd20Penalty';
  /** Monster statblocks list initiative and gear (2024 layout). */
  modernStatblock: boolean;
}

export interface Ruleset {
  id: RulesetId;
  edition: Edition;
  label: string;
  shortLabel: string;
  terminology: Terminology;
  features: RulesetFeatures;
  encounter: EncounterRules;
  /** Core sources for this ruleset, in display order. */
  coreSources: readonly string[];
  /** Maps an edition-neutral rules reference (e.g. `condition:poisoned`) to this ruleset's entity uid. */
  canonicalRef(key: string): string | null;
  xpForCr(cr: unknown, opts?: { lair?: boolean }): number | null;
}

/** Edition-neutral reference keys used by templates (`{"$rulesetRef": "condition:poisoned"}`). */
const CANONICAL_KINDS: Record<string, { kind: string; classic: string; one: string }> = {
  condition: { kind: 'condition', classic: 'PHB', one: 'XPHB' },
  status: { kind: 'status', classic: 'PHB', one: 'XPHB' },
  action: { kind: 'action', classic: 'PHB', one: 'XPHB' },
  skill: { kind: 'skill', classic: 'PHB', one: 'XPHB' },
  sense: { kind: 'sense', classic: 'PHB', one: 'XPHB' },
  spell: { kind: 'spell', classic: 'PHB', one: 'XPHB' },
  item: { kind: 'item', classic: 'PHB', one: 'XPHB' },
  magicitem: { kind: 'item', classic: 'DMG', one: 'XDMG' },
  creature: { kind: 'monster', classic: 'MM', one: 'XMM' },
  disease: { kind: 'disease', classic: 'DMG', one: 'XDMG' },
  hazard: { kind: 'hazard', classic: 'DMG', one: 'XDMG' },
  rule: { kind: 'variantrule', classic: 'DMG', one: 'XPHB' },
};

function makeCanonicalRef(edition: Edition) {
  return (key: string): string | null => {
    const ix = key.indexOf(':');
    if (ix <= 0) return null;
    const def = CANONICAL_KINDS[key.slice(0, ix).toLowerCase()];
    const name = key.slice(ix + 1).trim().toLowerCase();
    if (!def || !name) return null;
    return `${def.kind}:${name}|${def[edition].toLowerCase()}`;
  };
}

const xpForCr = (cr: unknown, opts?: { lair?: boolean }) => crToXp(cr, opts);

export const RULESET_2014: Ruleset = {
  id: '2014',
  edition: rulesetEdition('2014'),
  label: 'D&D 5e (2014 rules)',
  shortLabel: '2014',
  terminology: {
    race: 'Race',
    races: 'Races',
    subrace: 'Subrace',
    encounterDifficulty: 'Encounter Difficulty (DMG 2014)',
    crossEditionToggle: 'Allow 2024 content',
    otherEditionBadge: '2024',
  },
  features: {
    weaponMastery: false,
    backgroundAbilityScores: false,
    backgroundFeat: false,
    speciesAbilityScores: true,
    exhaustionModel: 'levels6',
    modernStatblock: false,
  },
  encounter: classicEncounterRules,
  coreSources: ['PHB', 'DMG', 'MM'],
  canonicalRef: makeCanonicalRef('classic'),
  xpForCr,
};

export const RULESET_2024: Ruleset = {
  id: '2024',
  edition: rulesetEdition('2024'),
  label: 'D&D 5e (2024 rules)',
  shortLabel: '2024',
  terminology: {
    race: 'Species',
    races: 'Species',
    subrace: 'Lineage',
    encounterDifficulty: 'Encounter Difficulty (DMG 2024)',
    crossEditionToggle: 'Allow legacy (2014) content',
    otherEditionBadge: 'Legacy',
  },
  features: {
    weaponMastery: true,
    backgroundAbilityScores: true,
    backgroundFeat: true,
    speciesAbilityScores: false,
    exhaustionModel: 'd20Penalty',
    modernStatblock: true,
  },
  encounter: modernEncounterRules,
  coreSources: ['XPHB', 'XDMG', 'XMM'],
  canonicalRef: makeCanonicalRef('one'),
  xpForCr,
};

export const RULESETS: Record<RulesetId, Ruleset> = { '2014': RULESET_2014, '2024': RULESET_2024 };

export function getRuleset(id: RulesetId): Ruleset {
  return RULESETS[id];
}

/** Ruleset whose layout matches an entity's own edition (statblocks render in their native style). */
export function rulesetForEdition(edition: Edition): Ruleset {
  return edition === 'one' ? RULESET_2024 : RULESET_2014;
}

export { classicEncounterRules, modernEncounterRules, classicMultiplier, CLASSIC_DAILY_XP } from './encounter';
export type { EncounterRules, EncounterResult, EncounterCreature, EncounterTierInfo } from './encounter';
