/**
 * Entity kinds known to the app. A kind is the 5etools top-level array prop (e.g. `monster`), except
 * where 5etools merges several props into one browsable list (all item props become `item`).
 */
import { normalizeKey } from './util/string';

export type EntityKind =
  | 'monster'
  | 'spell'
  | 'item'
  | 'race'
  | 'background'
  | 'feat'
  | 'class'
  | 'subclass'
  | 'classFeature'
  | 'subclassFeature'
  | 'optionalfeature'
  | 'condition'
  | 'disease'
  | 'status'
  | 'action'
  | 'variantrule'
  | 'sense'
  | 'skill'
  | 'language'
  | 'table'
  | 'trap'
  | 'hazard'
  | 'object'
  | 'vehicle'
  | 'vehicleUpgrade'
  | 'deity'
  | 'reward'
  | 'cult'
  | 'boon'
  | 'deck'
  | 'card'
  | 'facility'
  | 'recipe'
  | 'psionic'
  | 'charoption'
  | 'legendaryGroup'
  | 'itemProperty'
  | 'itemType'
  | 'itemMastery'
  | 'crochetPattern';

export interface KindDef {
  kind: EntityKind;
  /** Singular display label (edition-neutral; rulesets may relabel, e.g. race → Species). */
  label: string;
  /** 5etools array props that feed this kind. */
  props: string[];
  /** Fluff array prop, if any. */
  fluffProp?: string;
  /** Inline tag that links to this kind. */
  tag?: string;
  /** Source assumed by the tag when omitted. */
  defaultSource: string;
  /** Shown as its own list in the reference browser. */
  browsable: boolean;
  /** Extra props the child of a `_copy` only inherits when `_preserve`d (beyond the generic set). */
  mergeRequiresPreserve?: string[];
}

export const KINDS: Record<EntityKind, KindDef> = {
  monster: {
    kind: 'monster',
    label: 'Monster',
    props: ['monster'],
    fluffProp: 'monsterFluff',
    tag: 'creature',
    defaultSource: 'MM',
    browsable: true,
    mergeRequiresPreserve: ['legendaryGroup', 'environment', 'soundClip', 'altArt', 'variant', 'dragonCastingColor', 'familiar'],
  },
  spell: { kind: 'spell', label: 'Spell', props: ['spell'], fluffProp: 'spellFluff', tag: 'spell', defaultSource: 'PHB', browsable: true },
  item: {
    kind: 'item',
    label: 'Item',
    props: ['item', 'itemGroup', 'baseitem', 'magicvariant'],
    fluffProp: 'itemFluff',
    tag: 'item',
    defaultSource: 'DMG',
    browsable: true,
    mergeRequiresPreserve: ['lootTables', 'tier'],
  },
  race: { kind: 'race', label: 'Race', props: ['race'], fluffProp: 'raceFluff', tag: 'race', defaultSource: 'PHB', browsable: true },
  background: {
    kind: 'background',
    label: 'Background',
    props: ['background'],
    fluffProp: 'backgroundFluff',
    tag: 'background',
    defaultSource: 'PHB',
    browsable: true,
  },
  feat: { kind: 'feat', label: 'Feat', props: ['feat'], fluffProp: 'featFluff', tag: 'feat', defaultSource: 'PHB', browsable: true },
  class: { kind: 'class', label: 'Class', props: ['class'], fluffProp: 'classFluff', tag: 'class', defaultSource: 'PHB', browsable: true },
  subclass: {
    kind: 'subclass',
    label: 'Subclass',
    props: ['subclass'],
    fluffProp: 'subclassFluff',
    tag: 'subclass',
    defaultSource: 'PHB',
    browsable: false,
  },
  classFeature: { kind: 'classFeature', label: 'Class Feature', props: ['classFeature'], tag: 'classFeature', defaultSource: 'PHB', browsable: false },
  subclassFeature: {
    kind: 'subclassFeature',
    label: 'Subclass Feature',
    props: ['subclassFeature'],
    tag: 'subclassFeature',
    defaultSource: 'PHB',
    browsable: false,
  },
  optionalfeature: {
    kind: 'optionalfeature',
    label: 'Optional Feature',
    props: ['optionalfeature'],
    fluffProp: 'optionalfeatureFluff',
    tag: 'optfeature',
    defaultSource: 'PHB',
    browsable: true,
  },
  condition: {
    kind: 'condition',
    label: 'Condition',
    props: ['condition'],
    fluffProp: 'conditionFluff',
    tag: 'condition',
    defaultSource: 'PHB',
    browsable: true,
  },
  disease: { kind: 'disease', label: 'Disease', props: ['disease'], fluffProp: 'diseaseFluff', tag: 'disease', defaultSource: 'DMG', browsable: true },
  status: { kind: 'status', label: 'Status', props: ['status'], fluffProp: 'statusFluff', tag: 'status', defaultSource: 'PHB', browsable: true },
  action: { kind: 'action', label: 'Action', props: ['action'], tag: 'action', defaultSource: 'PHB', browsable: true },
  variantrule: { kind: 'variantrule', label: 'Rule', props: ['variantrule'], tag: 'variantrule', defaultSource: 'DMG', browsable: true },
  sense: { kind: 'sense', label: 'Sense', props: ['sense'], tag: 'sense', defaultSource: 'PHB', browsable: false },
  skill: { kind: 'skill', label: 'Skill', props: ['skill'], tag: 'skill', defaultSource: 'PHB', browsable: false },
  language: {
    kind: 'language',
    label: 'Language',
    props: ['language'],
    fluffProp: 'languageFluff',
    tag: 'language',
    defaultSource: 'PHB',
    browsable: true,
  },
  table: { kind: 'table', label: 'Table', props: ['table', 'tableGroup'], tag: 'table', defaultSource: 'DMG', browsable: true },
  trap: { kind: 'trap', label: 'Trap', props: ['trap'], fluffProp: 'trapFluff', tag: 'trap', defaultSource: 'DMG', browsable: true },
  hazard: { kind: 'hazard', label: 'Hazard', props: ['hazard'], fluffProp: 'hazardFluff', tag: 'hazard', defaultSource: 'DMG', browsable: true },
  object: { kind: 'object', label: 'Object', props: ['object'], fluffProp: 'objectFluff', tag: 'object', defaultSource: 'DMG', browsable: true },
  vehicle: { kind: 'vehicle', label: 'Vehicle', props: ['vehicle'], fluffProp: 'vehicleFluff', tag: 'vehicle', defaultSource: 'GoS', browsable: true },
  vehicleUpgrade: {
    kind: 'vehicleUpgrade',
    label: 'Vehicle Upgrade',
    props: ['vehicleUpgrade'],
    tag: 'vehupgrade',
    defaultSource: 'GoS',
    browsable: false,
  },
  deity: { kind: 'deity', label: 'Deity', props: ['deity'], tag: 'deity', defaultSource: 'PHB', browsable: true },
  reward: { kind: 'reward', label: 'Reward', props: ['reward'], fluffProp: 'rewardFluff', tag: 'reward', defaultSource: 'DMG', browsable: true },
  cult: { kind: 'cult', label: 'Cult', props: ['cult'], tag: 'cult', defaultSource: 'MTF', browsable: true },
  boon: { kind: 'boon', label: 'Boon', props: ['boon'], tag: 'boon', defaultSource: 'MTF', browsable: true },
  deck: { kind: 'deck', label: 'Deck', props: ['deck'], tag: 'deck', defaultSource: 'DMG', browsable: true },
  card: { kind: 'card', label: 'Card', props: ['card'], tag: 'card', defaultSource: 'DMG', browsable: false },
  facility: {
    kind: 'facility',
    label: 'Bastion Facility',
    props: ['facility'],
    fluffProp: 'facilityFluff',
    tag: 'facility',
    defaultSource: 'XDMG',
    browsable: true,
  },
  recipe: { kind: 'recipe', label: 'Recipe', props: ['recipe'], fluffProp: 'recipeFluff', tag: 'recipe', defaultSource: 'HF', browsable: true },
  psionic: { kind: 'psionic', label: 'Psionic', props: ['psionic'], tag: 'psionic', defaultSource: 'UATheMysticClass', browsable: true },
  charoption: {
    kind: 'charoption',
    label: 'Character Creation Option',
    props: ['charoption'],
    fluffProp: 'charoptionFluff',
    tag: 'charoption',
    defaultSource: 'MOT',
    browsable: true,
  },
  legendaryGroup: { kind: 'legendaryGroup', label: 'Legendary Group', props: ['legendaryGroup'], tag: 'legroup', defaultSource: 'MM', browsable: false },
  itemProperty: { kind: 'itemProperty', label: 'Item Property', props: ['itemProperty'], tag: 'itemProperty', defaultSource: 'PHB', browsable: false },
  itemType: { kind: 'itemType', label: 'Item Type', props: ['itemType'], defaultSource: 'PHB', browsable: false },
  itemMastery: { kind: 'itemMastery', label: 'Weapon Mastery', props: ['itemMastery'], tag: 'itemMastery', defaultSource: 'XPHB', browsable: false },
  crochetPattern: {
    kind: 'crochetPattern',
    label: 'Crochet Pattern',
    props: ['crochetPattern'],
    fluffProp: 'crochetPatternFluff',
    tag: 'crochet',
    defaultSource: 'CaBoMP',
    browsable: false,
  },
};

export const ALL_KINDS = Object.keys(KINDS) as EntityKind[];

const PROP_TO_KIND = new Map<string, EntityKind>();
const FLUFF_PROP_TO_KIND = new Map<string, EntityKind>();
const TAG_TO_KIND = new Map<string, EntityKind>();
for (const def of Object.values(KINDS)) {
  for (const prop of def.props) PROP_TO_KIND.set(prop, def.kind);
  if (def.fluffProp) FLUFF_PROP_TO_KIND.set(def.fluffProp, def.kind);
  if (def.tag) TAG_TO_KIND.set(def.tag, def.kind);
}
PROP_TO_KIND.set('subrace', 'race');

export function kindForProp(prop: string): EntityKind | undefined {
  return PROP_TO_KIND.get(prop);
}
export function kindForFluffProp(prop: string): EntityKind | undefined {
  return FLUFF_PROP_TO_KIND.get(prop);
}
export function kindForTag(tag: string): EntityKind | undefined {
  return TAG_TO_KIND.get(tag);
}
export function isKind(value: string): value is EntityKind {
  return value in KINDS;
}

/**
 * Identity key used to look up `_copy` parents and to dedupe, mirroring 5etools' URL hash builders.
 * Lower-cased; parts joined by `|`.
 */
export function identityKey(prop: string, ent: Record<string, unknown>): string {
  const s = (v: unknown) => normalizeKey(v == null ? '' : String(v));
  switch (prop) {
    case 'subclass':
      return [ent.className, ent.classSource, ent.shortName ?? ent.name, ent.source].map(s).join('|');
    case 'classFeature':
      return [ent.name, ent.className, ent.classSource, ent.level, ent.source].map(s).join('|');
    case 'subclassFeature':
      return [ent.name, ent.className, ent.classSource, ent.subclassShortName, ent.subclassSource, ent.level, ent.source]
        .map(s)
        .join('|');
    case 'deity':
      return [ent.name, ent.pantheon, ent.source].map(s).join('|');
    case 'card':
      return [ent.name, ent.set, ent.source].map(s).join('|');
    case 'itemProperty':
    case 'itemType':
      return [ent.abbreviation, ent.source].map(s).join('|');
    case 'raceFeature':
      return [ent.name, ent.raceName, ent.raceSource, ent.source].map(s).join('|');
    case 'magicvariant':
      // Generic variants usually carry their source in `inherits.source`
      return [ent.name, ent.source ?? (ent.inherits as Record<string, unknown> | undefined)?.source].map(s).join('|');
    case 'subrace':
      return [`${String(ent.name ?? '')} (${String(ent.raceName ?? '')})`, ent.source].map(s).join('|');
    default:
      return [ent.name, ent.source].map(s).join('|');
  }
}

/** Builds the identity key of a `_copy` target (the `_copy` object carries the same identity fields). */
export function copyTargetKey(prop: string, copyMeta: Record<string, unknown>): string {
  return identityKey(prop, copyMeta);
}

/** Stable app-wide id for a resolved entity: `kind:identity`. */
export function entityUid(kind: EntityKind, identity: string): string {
  return `${kind}:${identity}`;
}
