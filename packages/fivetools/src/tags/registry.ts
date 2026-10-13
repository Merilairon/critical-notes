/**
 * Semantic knowledge about inline tags: which tags link to entities, their argument layout and default
 * sources (from 5etools' `Renderer.tag.*` classes). Unknown tags are treated as plain text by renderers.
 */
import { KINDS, kindForTag, type EntityKind } from '../kinds';
import { normalizeKey } from '../util/string';

export type TagCategory = 'format' | 'entity' | 'roll' | 'statblock' | 'navigation' | 'misc';

export const FORMAT_TAGS = new Set([
  'b', 'bold', 'i', 'italic', 'u', 'underline', 'u2', 'underlineDouble', 's', 'strike', 's2', 'strikeDouble',
  'sup', 'sub', 'code', 'kbd', 'note', 'tip', 'color', 'highlight', 'style', 'font', 'unit', 'footnote',
  'comic', 'comicH1', 'comicH2', 'comicH3', 'comicH4', 'comicNote', 'help',
]);

export const ROLL_TAGS = new Set([
  'dice', 'damage', 'hit', 'd20', 'dc', 'chance', 'recharge', 'scaledice', 'scaledamage', 'autodice', 'coinflip',
  'skillCheck', 'savingThrow', 'ability', 'hitYourSpellAttack', 'dcYourSpellSave',
]);

export const STATBLOCK_TAGS = new Set([
  'atk', 'atkr', 'h', 'm', 'hom', 'actSave', 'actSaveFail', 'actSaveSuccess', 'actSaveSuccessOrFail', 'actSaveFailBy',
  'actTrigger', 'actResponse',
]);

export const NAVIGATION_TAGS = new Set(['book', 'adventure', 'quickref', '5etools', '5etoolsImg', '5etoolsAudio', 'link', 'filter', 'area', 'loader', 'homebrew']);

export function tagCategory(tag: string): TagCategory {
  if (FORMAT_TAGS.has(tag)) return 'format';
  if (ROLL_TAGS.has(tag)) return 'roll';
  if (STATBLOCK_TAGS.has(tag)) return 'statblock';
  if (NAVIGATION_TAGS.has(tag)) return 'navigation';
  if (entityKindForTag(tag)) return 'entity';
  return 'misc';
}

/** Fluff tags such as `{@creatureFluff …}` link to the base kind. */
export function entityKindForTag(tag: string): EntityKind | undefined {
  return kindForTag(tag) ?? (tag.endsWith('Fluff') ? kindForTag(tag.slice(0, -'Fluff'.length)) : undefined);
}

export function defaultSourceForTag(tag: string): string | undefined {
  const kind = entityKindForTag(tag);
  return kind ? KINDS[kind].defaultSource : undefined;
}

export interface EntityRef {
  kind: EntityKind;
  /** Display name from the tag (may differ in case from the entity). */
  name: string;
  source: string;
  /** Text shown in place of the name, when the tag provides one. */
  display: string | null;
  /** Identity key compatible with `identityKey()` for the kind's primary prop. */
  identity: string;
  /** Whether the source was implied by the tag default (5etools allows redirects in that case). */
  implicitSource: boolean;
}

/** Parses an entity-link tag's args into a reference. Returns null for non-entity tags or malformed args. */
export function parseEntityTag(tag: string, args: string[]): EntityRef | null {
  const kind = entityKindForTag(tag);
  if (!kind) return null;
  const a = (i: number) => (args[i] ?? '').trim();
  const def = KINDS[kind];
  const k = normalizeKey;

  switch (kind) {
    case 'classFeature': {
      // name|className|classSource|level|source|display
      const classSource = a(2) || 'PHB';
      const source = a(4) || classSource;
      if (!a(0) || !a(1) || Number.isNaN(Number(a(3)))) return null;
      return {
        kind, name: a(0), source, display: a(5) || null, implicitSource: !a(4) && !a(2),
        identity: [a(0), a(1), classSource, Number(a(3)), source].map((v) => k(String(v))).join('|'),
      };
    }
    case 'subclassFeature': {
      // name|className|classSource|subclassShortName|subclassSource|level|source|display
      const classSource = a(2) || 'PHB';
      const subclassSource = a(4) || 'PHB';
      const source = a(6) || subclassSource;
      if (!a(0) || !a(1) || !a(3) || Number.isNaN(Number(a(5)))) return null;
      return {
        kind, name: a(0), source, display: a(7) || null, implicitSource: !a(6) && !a(4),
        identity: [a(0), a(1), classSource, a(3), subclassSource, Number(a(5)), source].map((v) => k(String(v))).join('|'),
      };
    }
    case 'subclass': {
      // shortName|className|classSource|subclassSource|display
      const classSource = a(2) || 'PHB';
      const source = a(3) || 'PHB';
      if (!a(0) || !a(1)) return null;
      return {
        kind, name: a(0), source, display: a(4) || null, implicitSource: !a(3),
        identity: [a(1), classSource, a(0), source].map(k).join('|'),
      };
    }
    case 'deity': {
      // name|pantheon|source|display
      const source = a(2) || def.defaultSource;
      const pantheon = a(1) || 'Forgotten Realms';
      return {
        kind, name: a(0), source, display: a(3) || null, implicitSource: !a(2),
        identity: [a(0), pantheon, source].map(k).join('|'),
      };
    }
    case 'card': {
      // name|set|source|display
      const source = a(2) || def.defaultSource;
      return {
        kind, name: a(0), source, display: a(3) || null, implicitSource: !a(2),
        identity: [a(0), a(1), source].map(k).join('|'),
      };
    }
    default: {
      const name = a(0);
      if (!name) return null;
      const source = a(1) || def.defaultSource;
      return { kind, name, source, display: a(2) || null, implicitSource: !a(1), identity: [name, source].map(k).join('|') };
    }
  }
}
