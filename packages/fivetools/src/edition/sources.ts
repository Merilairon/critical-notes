/**
 * Source → edition classification. See DATA_NOTES.md §2: books carry no edition field, so we use (in order)
 * a homebrew source's declared edition, the 5etools-utils classic/modern lists, the publish date against the
 * 2024 PHB, and finally "classic" with a warning.
 */
import { normalizeKey } from '../util/string';

/** 5etools terms: "classic" = 2014-era rules, "one" = 2024 rules. "any" = edition-neutral homebrew. */
export type Edition = 'classic' | 'one';
export type EditionOrAny = Edition | 'any';

export const MODERN_THRESHOLD_DATE = '2024-09-17'; // XPHB publication date

export interface EditionLists {
  classic: ReadonlySet<string>;
  modern: ReadonlySet<string>;
  legacy: ReadonlySet<string>;
}

export function makeEditionLists(input: { classic: Iterable<string>; modern: Iterable<string>; legacy: Iterable<string> }): EditionLists {
  const lower = (it: Iterable<string>) => new Set([...it].map(normalizeKey));
  return { classic: lower(input.classic), modern: lower(input.modern), legacy: lower(input.legacy) };
}

export const EMPTY_EDITION_LISTS: EditionLists = makeEditionLists({ classic: [], modern: [], legacy: [] });

export type EditionReason = 'homebrew' | 'override' | 'list' | 'date' | 'default';

export interface SourceClassification {
  edition: EditionOrAny;
  reason: EditionReason;
  legacy: boolean;
  warning?: string;
}

export interface ClassifySourceInput {
  id: string;
  published?: string | null;
  /** Declared edition of a homebrew source. */
  homebrewEdition?: EditionOrAny | null;
  lists: EditionLists;
  overrides?: ReadonlyMap<string, Edition>;
}

export function classifySource({ id, published, homebrewEdition, lists, overrides }: ClassifySourceInput): SourceClassification {
  const key = normalizeKey(id);
  const legacy = lists.legacy.has(key);
  if (homebrewEdition) return { edition: homebrewEdition, reason: 'homebrew', legacy: false };
  const override = overrides?.get(key);
  if (override) return { edition: override, reason: 'override', legacy };
  if (lists.modern.has(key)) return { edition: 'one', reason: 'list', legacy };
  if (lists.classic.has(key)) return { edition: 'classic', reason: 'list', legacy };
  if (published && /^\d{4}-\d{2}-\d{2}/.test(published)) {
    return { edition: published.slice(0, 10) < MODERN_THRESHOLD_DATE ? 'classic' : 'one', reason: 'date', legacy };
  }
  return { edition: 'classic', reason: 'default', legacy, warning: `Unknown edition for source "${id}"; assuming classic` };
}

/** Raw `edition` field checks for data-layer code (5etools semantics: absent = unknown/classic-compatible). */
export const isClassicEditionValue = (value: unknown): boolean => value === 'classic';
export const isModernEditionValue = (value: unknown): boolean => value === 'one';

/** An entity's own `edition` field wins over its source's edition. */
export function entityEdition(entity: { edition?: unknown }, sourceEdition: EditionOrAny): EditionOrAny {
  return entity.edition === 'classic' || entity.edition === 'one' ? entity.edition : sourceEdition;
}

export interface SourceInfo {
  id: string;
  name: string;
  abbreviation: string;
  group: string | null;
  published: string | null;
  kind: 'book' | 'adventure' | 'other' | 'homebrew';
  edition: EditionOrAny;
  editionReason: EditionReason;
  legacy: boolean;
  /** Homebrew source row id, when `kind === 'homebrew'`. */
  homebrewSourceId?: string | null;
  color?: string | null;
}
