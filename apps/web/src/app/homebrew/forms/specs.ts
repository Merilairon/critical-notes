/**
 * Form specs per homebrew type. A form edits only the fields listed here; everything else in the entity
 * stays untouched (and is editable in the JSON view). Values follow the 5etools data format.
 */
import type { JsonPath } from './path';

export interface Option {
  value: string | number;
  label: string;
}

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'checkbox'
  | 'stringList'
  | 'json'
  | 'entries'
  | 'namedEntries'
  | 'abilities'
  | 'attune'
  | 'tableRows';

export interface FieldSpec {
  path: JsonPath;
  label: string;
  kind: FieldKind;
  options?: Option[];
  /** Free-text suggestions (datalist) for text fields. */
  suggestions?: string[];
  placeholder?: string;
  hint?: string;
  /** Number of grid columns the field spans (1–2). */
  span?: 1 | 2;
}

export interface FormSection {
  title: string;
  fields: FieldSpec[];
}

const opts = (pairs: [string | number, string][]): Option[] => pairs.map(([value, label]) => ({ value, label }));

export const SIZES = opts([
  ['T', 'Tiny'],
  ['S', 'Small'],
  ['M', 'Medium'],
  ['L', 'Large'],
  ['H', 'Huge'],
  ['G', 'Gargantuan'],
]);

const ALIGNMENTS = opts([
  ['L', 'Lawful'],
  ['N', 'Neutral'],
  ['C', 'Chaotic'],
  ['G', 'Good'],
  ['E', 'Evil'],
  ['U', 'Unaligned'],
  ['A', 'Any'],
]);

export const CRS = ['0', '1/8', '1/4', '1/2', ...Array.from({ length: 30 }, (_, i) => String(i + 1))];

const DAMAGE_TYPES = ['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'];
const CONDITIONS = ['blinded', 'charmed', 'deafened', 'exhaustion', 'frightened', 'grappled', 'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious'];
const CREATURE_TYPES = ['aberration', 'beast', 'celestial', 'construct', 'dragon', 'elemental', 'fey', 'fiend', 'giant', 'humanoid', 'monstrosity', 'ooze', 'plant', 'undead'];
const ENVIRONMENTS = ['arctic', 'coastal', 'desert', 'forest', 'grassland', 'hill', 'mountain', 'swamp', 'underdark', 'underwater', 'urban'];

const SCHOOLS = opts([
  ['A', 'Abjuration'],
  ['C', 'Conjuration'],
  ['D', 'Divination'],
  ['E', 'Enchantment'],
  ['V', 'Evocation'],
  ['I', 'Illusion'],
  ['N', 'Necromancy'],
  ['T', 'Transmutation'],
]);

const RARITIES = ['none', 'common', 'uncommon', 'rare', 'very rare', 'legendary', 'artifact', 'varies', 'unknown', 'unknown (magic)'];
const DMG_CODES = opts([
  ['A', 'Acid'],
  ['B', 'Bludgeoning'],
  ['C', 'Cold'],
  ['F', 'Fire'],
  ['O', 'Force'],
  ['L', 'Lightning'],
  ['N', 'Necrotic'],
  ['P', 'Piercing'],
  ['I', 'Poison'],
  ['Y', 'Psychic'],
  ['R', 'Radiant'],
  ['S', 'Slashing'],
  ['T', 'Thunder'],
]);
const WEAPON_PROPERTIES = opts([
  ['A', 'Ammunition'],
  ['F', 'Finesse'],
  ['H', 'Heavy'],
  ['L', 'Light'],
  ['LD', 'Loading'],
  ['R', 'Reach'],
  ['T', 'Thrown'],
  ['2H', 'Two-handed'],
  ['V', 'Versatile'],
  ['S', 'Special'],
]);
const ITEM_TYPES = ['M', 'R', 'A', 'LA', 'MA', 'HA', 'S', 'G', 'AT', 'GS', 'INS', 'SCF', 'P', 'RG', 'RD', 'WD', 'SC', 'OTH', 'TAH', 'MNT', 'VEH', 'FD', 'TG', '$'];
const ABILITY_OPTIONS = opts([
  ['str', 'Strength'],
  ['dex', 'Dexterity'],
  ['con', 'Constitution'],
  ['int', 'Intelligence'],
  ['wis', 'Wisdom'],
  ['cha', 'Charisma'],
]);
const list = (values: string[]): Option[] => values.map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) }));

const name: FieldSpec = { path: ['name'], label: 'Name', kind: 'text', span: 2 };
const entries: FieldSpec = { path: ['entries'], label: 'Text', kind: 'entries', span: 2 };

const monster: FormSection[] = [
  {
    title: 'Basics',
    fields: [
      name,
      { path: ['size'], label: 'Size', kind: 'multiselect', options: SIZES },
      { path: ['type'], label: 'Type', kind: 'text', suggestions: CREATURE_TYPES, hint: 'Complex types (with tags) are edited in JSON' },
      { path: ['alignment'], label: 'Alignment', kind: 'multiselect', options: ALIGNMENTS, hint: 'In order: lawful–chaotic, then good–evil' },
      { path: ['cr'], label: 'Challenge rating', kind: 'select', options: CRS.map((c) => ({ value: c, label: c })) },
    ],
  },
  {
    title: 'Defenses and movement',
    fields: [
      { path: ['ac'], label: 'Armor class', kind: 'json', placeholder: '[15] or [{"ac": 15, "from": ["natural armor"]}]' },
      { path: ['hp', 'average'], label: 'Hit points', kind: 'number' },
      { path: ['hp', 'formula'], label: 'Hit dice', kind: 'text', placeholder: '4d8 + 4' },
      { path: ['speed', 'walk'], label: 'Speed (walk)', kind: 'number' },
      { path: ['speed', 'fly'], label: 'Fly', kind: 'number' },
      { path: ['speed', 'swim'], label: 'Swim', kind: 'number' },
      { path: ['speed', 'climb'], label: 'Climb', kind: 'number' },
      { path: ['speed', 'burrow'], label: 'Burrow', kind: 'number' },
    ],
  },
  {
    title: 'Abilities',
    fields: [
      { path: [], label: 'Ability scores', kind: 'abilities', span: 2 },
      { path: ['save'], label: 'Saving throws', kind: 'json', placeholder: '{"dex": "+5", "wis": "+3"}' },
      { path: ['skill'], label: 'Skills', kind: 'json', placeholder: '{"perception": "+5", "stealth": "+7"}' },
      { path: ['senses'], label: 'Senses', kind: 'stringList', placeholder: 'darkvision 60 ft.' },
      { path: ['passive'], label: 'Passive Perception', kind: 'number' },
      { path: ['languages'], label: 'Languages', kind: 'stringList', placeholder: 'Common' },
    ],
  },
  {
    title: 'Resistances',
    fields: [
      { path: ['resist'], label: 'Resistances', kind: 'multiselect', options: list(DAMAGE_TYPES) },
      { path: ['immune'], label: 'Damage immunities', kind: 'multiselect', options: list(DAMAGE_TYPES) },
      { path: ['vulnerable'], label: 'Vulnerabilities', kind: 'multiselect', options: list(DAMAGE_TYPES) },
      { path: ['conditionImmune'], label: 'Condition immunities', kind: 'multiselect', options: list(CONDITIONS) },
    ],
  },
  {
    title: 'Traits and actions',
    fields: [
      { path: ['trait'], label: 'Traits', kind: 'namedEntries', span: 2 },
      { path: ['action'], label: 'Actions', kind: 'namedEntries', span: 2 },
      { path: ['bonus'], label: 'Bonus actions', kind: 'namedEntries', span: 2 },
      { path: ['reaction'], label: 'Reactions', kind: 'namedEntries', span: 2 },
      { path: ['legendaryActions'], label: 'Legendary actions per round', kind: 'number' },
      { path: ['legendary'], label: 'Legendary actions', kind: 'namedEntries', span: 2 },
      { path: ['spellcasting'], label: 'Spellcasting', kind: 'json', span: 2, hint: '5etools spellcasting blocks; easiest to start from a copied monster' },
      { path: ['environment'], label: 'Environments', kind: 'multiselect', options: list(ENVIRONMENTS), span: 2 },
    ],
  },
];

const spell: FormSection[] = [
  {
    title: 'Basics',
    fields: [
      name,
      { path: ['level'], label: 'Level', kind: 'select', options: [{ value: 0, label: 'Cantrip' }, ...Array.from({ length: 9 }, (_, i) => ({ value: i + 1, label: String(i + 1) }))] },
      { path: ['school'], label: 'School', kind: 'select', options: SCHOOLS },
      { path: ['meta', 'ritual'], label: 'Ritual', kind: 'checkbox' },
      { path: ['time'], label: 'Casting time', kind: 'json', placeholder: '[{"number": 1, "unit": "action"}]' },
      { path: ['range'], label: 'Range', kind: 'json', placeholder: '{"type": "point", "distance": {"type": "feet", "amount": 60}}' },
      { path: ['components', 'v'], label: 'Verbal', kind: 'checkbox' },
      { path: ['components', 's'], label: 'Somatic', kind: 'checkbox' },
      { path: ['components', 'm'], label: 'Material', kind: 'text', placeholder: 'a pinch of sulfur' },
      { path: ['duration'], label: 'Duration', kind: 'json', placeholder: '[{"type": "instant"}]' },
    ],
  },
  {
    title: 'Description',
    fields: [
      entries,
      { path: ['entriesHigherLevel'], label: 'At higher levels', kind: 'entries', span: 2 },
      { path: ['damageInflict'], label: 'Damage types', kind: 'multiselect', options: list(DAMAGE_TYPES) },
      { path: ['savingThrow'], label: 'Saving throws', kind: 'multiselect', options: ABILITY_OPTIONS.map((o) => ({ value: String(o.label).toLowerCase(), label: o.label })) },
      { path: ['classes'], label: 'Class lists', kind: 'json', span: 2, placeholder: '{"fromClassList": [{"name": "Wizard", "source": "PHB"}]}' },
    ],
  },
];

const item: FormSection[] = [
  {
    title: 'Basics',
    fields: [
      name,
      { path: ['type'], label: 'Item type', kind: 'text', suggestions: ITEM_TYPES, hint: 'Code, e.g. W (wondrous), RG (ring), M (melee weapon)' },
      { path: ['rarity'], label: 'Rarity', kind: 'select', options: list(RARITIES) },
      { path: ['reqAttune'], label: 'Requires attunement', kind: 'attune' },
      { path: ['wondrous'], label: 'Wondrous item', kind: 'checkbox' },
      { path: ['weight'], label: 'Weight (lb.)', kind: 'number' },
      { path: ['value'], label: 'Value (cp)', kind: 'number' },
      { path: ['bonusWeapon'], label: 'Weapon bonus', kind: 'text', placeholder: '+1' },
      { path: ['bonusAc'], label: 'AC bonus', kind: 'text', placeholder: '+1' },
      { path: ['charges'], label: 'Charges', kind: 'number' },
      { path: ['recharge'], label: 'Recharge', kind: 'text', placeholder: 'dawn' },
    ],
  },
  { title: 'Description', fields: [entries] },
];

const baseitem: FormSection[] = [
  {
    title: 'Basics',
    fields: [
      name,
      { path: ['type'], label: 'Item type', kind: 'text', suggestions: ITEM_TYPES, hint: 'M melee, R ranged, LA/MA/HA armor, S shield, G gear' },
      { path: ['weight'], label: 'Weight (lb.)', kind: 'number' },
      { path: ['value'], label: 'Value (cp)', kind: 'number' },
      { path: ['weapon'], label: 'Weapon', kind: 'checkbox' },
      { path: ['weaponCategory'], label: 'Weapon category', kind: 'select', options: list(['simple', 'martial']) },
      { path: ['dmg1'], label: 'Damage', kind: 'text', placeholder: '1d8' },
      { path: ['dmg2'], label: 'Versatile damage', kind: 'text', placeholder: '1d10' },
      { path: ['dmgType'], label: 'Damage type', kind: 'select', options: DMG_CODES },
      { path: ['property'], label: 'Properties', kind: 'multiselect', options: WEAPON_PROPERTIES, span: 2 },
      { path: ['range'], label: 'Range', kind: 'text', placeholder: '80/320' },
      { path: ['ac'], label: 'Armor class', kind: 'number' },
      { path: ['strength'], label: 'Strength requirement', kind: 'text' },
      { path: ['stealth'], label: 'Stealth disadvantage', kind: 'checkbox' },
    ],
  },
  { title: 'Description', fields: [entries] },
];

const feat: FormSection[] = [
  {
    title: 'Feat',
    fields: [
      name,
      { path: ['category'], label: 'Category', kind: 'select', options: opts([['G', 'General'], ['O', 'Origin'], ['FS', 'Fighting Style'], ['EB', 'Epic Boon']]) },
      { path: ['prerequisite'], label: 'Prerequisites', kind: 'json', span: 2, placeholder: '[{"level": 4}]' },
      { path: ['ability'], label: 'Ability score increase', kind: 'json', span: 2, placeholder: '[{"choose": {"from": ["str", "dex"], "amount": 1}}]' },
      entries,
    ],
  },
];

const race: FormSection[] = [
  {
    title: 'Species',
    fields: [
      name,
      { path: ['size'], label: 'Size', kind: 'multiselect', options: SIZES },
      { path: ['speed'], label: 'Speed', kind: 'number', hint: 'Other movement modes are edited in JSON' },
      { path: ['darkvision'], label: 'Darkvision (ft.)', kind: 'number' },
      { path: ['ability'], label: 'Ability scores', kind: 'json', span: 2, placeholder: '[{"dex": 2, "wis": 1}]' },
      entries,
    ],
  },
];

const subrace: FormSection[] = [
  {
    title: 'Subrace',
    fields: [
      name,
      { path: ['raceName'], label: 'Parent race', kind: 'text', placeholder: 'Elf' },
      { path: ['raceSource'], label: 'Parent source', kind: 'text', placeholder: 'PHB' },
      { path: ['ability'], label: 'Ability scores', kind: 'json', span: 2, placeholder: '[{"int": 1}]' },
      entries,
    ],
  },
];

const background: FormSection[] = [
  {
    title: 'Background',
    fields: [
      name,
      { path: ['skillProficiencies'], label: 'Skill proficiencies', kind: 'json', span: 2, placeholder: '[{"insight": true, "religion": true}]' },
      { path: ['toolProficiencies'], label: 'Tool proficiencies', kind: 'json', span: 2 },
      { path: ['languageProficiencies'], label: 'Languages', kind: 'json', span: 2, placeholder: '[{"anyStandard": 2}]' },
      { path: ['startingEquipment'], label: 'Starting equipment', kind: 'json', span: 2 },
      entries,
    ],
  },
];

const simple = (title: string, extra: FieldSpec[] = []): FormSection[] => [{ title, fields: [name, ...extra, entries] }];

const table: FormSection[] = [
  {
    title: 'Table',
    fields: [
      name,
      { path: ['caption'], label: 'Caption', kind: 'text', span: 2 },
      { path: ['colLabels'], label: 'Column labels', kind: 'stringList', span: 2, placeholder: 'd6' },
      { path: ['colStyles'], label: 'Column styles', kind: 'stringList', span: 2, placeholder: 'col-2 text-center', hint: 'One per column (CSS-like 5etools classes)' },
      { path: ['rows'], label: 'Rows', kind: 'tableRows', span: 2 },
    ],
  },
];

export const FORM_SPECS: Record<string, FormSection[]> = {
  monster,
  spell,
  item,
  baseitem,
  feat,
  race,
  subrace,
  background,
  condition: simple('Condition'),
  variantrule: simple('Rule', [
    { path: ['ruleType'], label: 'Rule type', kind: 'select', options: opts([['C', 'Core'], ['O', 'Optional'], ['V', 'Variant'], ['VO', 'Variant optional'], ['VV', 'Variant variant'], ['U', 'Unknown']]) },
  ]),
  table,
};

/** A new entity of a type: the minimum the 5etools schema expects, ready to fill in. */
export function blankEntity(type: string): Record<string, unknown> {
  switch (type) {
    case 'monster':
      return { name: 'New Monster', size: ['M'], type: 'humanoid', alignment: ['N'], ac: [10], hp: { average: 11, formula: '2d8 + 2' }, speed: { walk: 30 }, str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, passive: 10, cr: '1/2' };
    case 'spell':
      return { name: 'New Spell', level: 1, school: 'V', time: [{ number: 1, unit: 'action' }], range: { type: 'point', distance: { type: 'feet', amount: 60 } }, components: { v: true, s: true }, duration: [{ type: 'instant' }], entries: [''] };
    case 'item':
      return { name: 'New Item', type: 'W', rarity: 'uncommon', wondrous: true, entries: [''] };
    case 'baseitem':
      return { name: 'New Gear', type: 'G', rarity: 'none', weight: 1, value: 100, entries: [''] };
    case 'race':
      return { name: 'New Species', size: ['M'], speed: 30, entries: [{ type: 'entries', name: 'Trait', entries: [''] }] };
    case 'subrace':
      return { name: 'New Subrace', raceName: '', raceSource: '', entries: [{ type: 'entries', name: 'Trait', entries: [''] }] };
    case 'table':
      return { name: 'New Table', colLabels: ['d6', 'Result'], colStyles: ['col-2 text-center', 'col-10'], rows: [['1', ''], ['2', '']] };
    default:
      return { name: `New ${type}`, entries: [''] };
  }
}

/** Top-level fields the form for a type does not show (edited in JSON). */
export function unlistedFields(type: string, data: Record<string, unknown>): string[] {
  const listed = new Set<string>(['source', 'page']);
  for (const s of FORM_SPECS[type] ?? []) for (const f of s.fields) if (f.kind === 'abilities') ['str', 'dex', 'con', 'int', 'wis', 'cha'].forEach((a) => listed.add(a));
  for (const s of FORM_SPECS[type] ?? []) for (const f of s.fields) if (typeof f.path[0] === 'string') listed.add(f.path[0]);
  return Object.keys(data).filter((k) => !listed.has(k));
}
