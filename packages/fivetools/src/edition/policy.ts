/**
 * Campaign visibility policy: which sources and entities a campaign sees, given its ruleset, source toggles
 * and the cross-edition switch. This is the only place that decides visibility — UI and API call into it.
 */
import { normalizeKey } from '../util/string';
import type { Edition, EditionOrAny, SourceInfo } from './sources';

export type RulesetId = '2014' | '2024';

export const RULESET_IDS: readonly RulesetId[] = ['2014', '2024'];

export function rulesetEdition(ruleset: RulesetId): Edition {
  return ruleset === '2024' ? 'one' : 'classic';
}

/** Homebrew sources declare '2014' | '2024' | 'any'; the index stores 5etools editions. */
export function homebrewEditionToEdition(edition: string): EditionOrAny {
  if (edition === 'any') return 'any';
  return edition === '2024' ? 'one' : 'classic';
}

/** `_meta.edition` for a homebrew export. 5etools: "if ambiguous, classic" (so 'any' exports as classic). */
export function homebrewEditionToMeta(edition: string): Edition {
  return edition === '2024' ? 'one' : 'classic';
}

/** A homebrew edition from an imported file's `_meta.edition`, or the fallback when it is missing or unknown. */
export function metaEditionToHomebrew<T extends string>(metaEdition: unknown, fallback: T): T | RulesetId {
  if (metaEdition === 'one') return '2024';
  if (metaEdition === 'classic') return '2014';
  return fallback;
}

export function editionRuleset(edition: Edition): RulesetId {
  return edition === 'one' ? '2024' : '2014';
}

export interface CampaignPolicy {
  ruleset: RulesetId;
  /** Allow the other edition's content (shown with a badge). */
  crossEdition: boolean;
  /** Explicit per-source toggles (lower-cased source id → enabled). Absent = default. */
  sourceOverrides: ReadonlyMap<string, boolean>;
  /** Homebrew sources (lower-cased json ids) this campaign may use. Other homebrew is never visible. */
  homebrewSources: ReadonlySet<string>;
}

export function makePolicy(
  ruleset: RulesetId,
  opts: { crossEdition?: boolean; sourceOverrides?: Iterable<[string, boolean]>; homebrewSources?: Iterable<string> } = {},
): CampaignPolicy {
  return {
    ruleset,
    crossEdition: !!opts.crossEdition,
    sourceOverrides: new Map([...(opts.sourceOverrides ?? [])].map(([k, v]) => [normalizeKey(k), v])),
    homebrewSources: new Set([...(opts.homebrewSources ?? [])].map(normalizeKey)),
  };
}

export function isEditionCompatible(edition: EditionOrAny, policy: CampaignPolicy): boolean {
  return edition === 'any' || edition === rulesetEdition(policy.ruleset);
}

/** Default enablement of a source before overrides. */
export function isSourceEnabledByDefault(source: Pick<SourceInfo, 'edition'>, policy: CampaignPolicy): boolean {
  if (isEditionCompatible(source.edition, policy)) return true;
  return policy.crossEdition;
}

export function isSourceEnabled(source: Pick<SourceInfo, 'id' | 'edition'> & { kind?: SourceInfo['kind'] }, policy: CampaignPolicy): boolean {
  if (source.kind === 'homebrew' && !policy.homebrewSources.has(normalizeKey(source.id))) return false;
  if (!isEditionCompatible(source.edition, policy) && !policy.crossEdition) return false;
  return policy.sourceOverrides.get(normalizeKey(source.id)) ?? isSourceEnabledByDefault(source, policy);
}

export interface VisibilityCandidate {
  source: string;
  edition: EditionOrAny;
}

/**
 * Whether an entity is available to the campaign at all (ignoring reprint de-duplication, which only
 * affects lists and search — see `reprints.ts`).
 */
export function isEntityVisible(
  entity: VisibilityCandidate,
  policy: CampaignPolicy,
  sources: ReadonlyMap<string, Pick<SourceInfo, 'id' | 'edition'> & { kind?: SourceInfo['kind'] }>,
): boolean {
  const source = sources.get(normalizeKey(entity.source));
  if (!source) return false;
  if (!isSourceEnabled(source, policy)) return false;
  return isEditionCompatible(entity.edition, policy) || policy.crossEdition;
}

export type EditionBadge = 'legacy' | 'modern' | null;

/** Badge shown on cross-edition content: "Legacy" in 2024 campaigns, "2024" in 2014 campaigns. */
export function crossEditionBadge(edition: EditionOrAny, policy: CampaignPolicy): EditionBadge {
  if (isEditionCompatible(edition, policy)) return null;
  return edition === 'classic' ? 'legacy' : 'modern';
}
