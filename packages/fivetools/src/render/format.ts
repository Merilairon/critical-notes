/**
 * Formatters for statblock lines. They return 5etools-markup strings (rendered through `renderInline`), so
 * links and dice stay interactive. `style` selects 2014 ("classic") or 2024 ("one") phrasing.
 */
import { ABILITIES, ABILITY_NAMES, abilityModifier, crString, crToProficiencyBonus, crToXp, SIZE_NAMES, type Ability } from '../constants';
import { isModernEditionValue, type Edition } from '../edition/sources';
import { asArray, isObject, type JsonObject } from '../util/object';
import { toTitleCase } from '../util/string';
import { spellSchoolName } from '../dataset/summary';

export type Style = Edition;

export const isModern = (style: Style): boolean => isModernEditionValue(style);

const tc = (s: string, style: Style) => (isModern(style) ? toTitleCase(s) : s);
/** 2024 statblocks capitalize list items ("Darkvision 60 ft.", "Fire") rather than title-casing every word. */
const cf = (s: string, style: Style) => (isModern(style) && s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function signedNumber(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export function joinConjunct(items: string[], conj = 'and'): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, ${conj} ${items[items.length - 1]}`;
}

// region Alignment, size, type

const ALIGNMENT: Record<string, string> = {
  L: 'lawful', N: 'neutral', NX: 'neutral', NY: 'neutral', C: 'chaotic', G: 'good', E: 'evil', U: 'unaligned', A: 'any alignment',
};

function alignmentAbv(a: unknown): string {
  if (isObject(a)) {
    if (a.special != null) return String(a.special);
    return `${alignmentList(asArray(a.alignment as string[]))}${a.chance ? ` (${String(a.chance)}%)` : ''}${a.note ? ` (${String(a.note)})` : ''}`;
  }
  const key = String(a).toUpperCase();
  return ALIGNMENT[key] ?? String(a);
}

export function alignmentList(list: unknown[]): string {
  if (!list.length) return '';
  if (list.some((it) => typeof it !== 'string')) {
    return list
      .filter((it) => !isObject(it) || it.alignment !== null)
      .map((it) => (isObject(it) && (it.special != null || it.chance != null || it.note != null) ? alignmentAbv(it) : isObject(it) ? alignmentList(asArray(it.alignment as string[])) : alignmentAbv(it)))
      .join(' or ');
  }
  const l = list as string[];
  if (l.length === 1) return alignmentAbv(l[0]);
  if (l.length === 2) return l.map(alignmentAbv).join(' ');
  if (l.length === 3 && l.includes('NX') && l.includes('NY') && l.includes('N')) return 'any neutral alignment';
  if (l.length === 5) {
    if (!l.includes('G')) return 'any non-good alignment';
    if (!l.includes('E')) return 'any non-evil alignment';
    if (!l.includes('L')) return 'any non-lawful alignment';
    if (!l.includes('C')) return 'any non-chaotic alignment';
  }
  if (l.length === 4) {
    if (!l.includes('L') && !l.includes('NX')) return 'any chaotic alignment';
    if (!l.includes('G') && !l.includes('NY')) return 'any evil alignment';
    if (!l.includes('C') && !l.includes('NX')) return 'any lawful alignment';
    if (!l.includes('E') && !l.includes('NY')) return 'any good alignment';
  }
  return l.map(alignmentAbv).join(' ');
}

export function sizeText(size: unknown): string {
  const sizes = asArray(size as string | string[]).map((s) => SIZE_NAMES[s] ?? s);
  return joinConjunct(sizes, 'or');
}

export function creatureType(type: unknown, style: Style): string {
  if (typeof type === 'string') return tc(type, style);
  if (!isObject(type)) return '';
  let base = '';
  if (typeof type.type === 'string') base = type.type;
  else if (isObject(type.type) && Array.isArray(type.type.choose)) base = joinConjunct(type.type.choose as string[], 'or');
  if (type.swarmSize) base = `swarm of ${(SIZE_NAMES[String(type.swarmSize)] ?? String(type.swarmSize)).toLowerCase()} ${base}s`;
  const tags = asArray(type.tags as unknown[]).map((t) => (isObject(t) ? `${String(t.prefix ?? '')} ${String(t.tag ?? '')}`.trim() : String(t)));
  const out = `${base}${tags.length ? ` (${tags.join(', ')})` : ''}`;
  return tc(out, style);
}

export function monsterTypeLine(mon: JsonObject, style: Style): string {
  const align = mon.alignment ? `${mon.alignmentPrefix ? String(mon.alignmentPrefix) : ''}${alignmentList(asArray(mon.alignment as unknown[]))}` : '';
  const head = `${sizeText(mon.size)} ${creatureType(mon.type, style)}`.trim();
  return align ? `${head}, ${tc(align, style)}` : head;
}

// endregion

// region Monster stats

export function acText(ac: unknown): string {
  let out = '';
  asArray(ac as unknown[]).forEach((it, i) => {
    let part = '';
    let braces = false;
    if (typeof it === 'number' || typeof it === 'string') part = String(it);
    else if (isObject(it)) {
      if (it.special != null) part = String(it.special);
      else {
        part = `${String(it.ac ?? '')}${Array.isArray(it.from) ? ` (${(it.from as string[]).join(', ')})` : ''}${it.condition ? ` ${String(it.condition)}` : ''}`;
        braces = i > 0 && !!it.braces;
      }
    }
    if (!part) return;
    out += i === 0 ? part : braces ? ` (${part})` : `, ${part}`;
  });
  return out;
}

export function hpText(hp: unknown): string {
  if (!isObject(hp)) return hp == null ? '' : String(hp);
  if (hp.special != null) return String(hp.special);
  const avg = hp.average != null ? String(hp.average) : '';
  return hp.formula ? `${avg} ({@dice ${String(hp.formula)}|${String(hp.formula)}})` : avg;
}

const SPEED_MODES = ['walk', 'burrow', 'climb', 'fly', 'swim'] as const;

function speedValue(v: unknown): string {
  if (typeof v === 'number') return `${v} ft.`;
  if (v === true) return 'equal to your walking speed';
  if (isObject(v)) return `${String(v.number ?? '')} ft.${v.condition ? ` ${String(v.condition)}` : ''}`;
  return String(v ?? '');
}

export function speedText(speed: unknown, style: Style = 'classic'): string {
  if (typeof speed === 'number') return `${speed} ft.`;
  if (!isObject(speed)) return speed == null ? '' : String(speed);
  const parts: string[] = [];
  for (const mode of SPEED_MODES) {
    if (speed[mode] == null) continue;
    const value = speedValue(speed[mode]);
    const hover = mode === 'fly' && speed.canHover ? ' (hover)' : '';
    parts.push(mode === 'walk' ? value : `${tc(mode, style)} ${value}${hover}`);
    const alt = isObject(speed.alternate) ? asArray(speed.alternate[mode] as unknown[]) : [];
    for (const a of alt) parts.push(mode === 'walk' ? speedValue(a) : `${tc(mode, style)} ${speedValue(a)}`);
  }
  if (isObject(speed.choose)) {
    const c = speed.choose;
    parts.push(`${joinConjunct(asArray(c.from as string[]), 'or')} ${String(c.amount)} ft.${c.note ? ` ${String(c.note)}` : ''}`);
  }
  return parts.join(', ');
}

export interface AbilityCell {
  ability: Ability;
  label: string;
  score: number;
  mod: string;
  save: string;
}

/** Ability scores with modifiers and saves (2024 statblocks show saves inline). */
export function abilityTable(mon: JsonObject): AbilityCell[] {
  const saves = isObject(mon.save) ? mon.save : {};
  return ABILITIES.filter((a) => mon[a] != null).map((a) => {
    const score = Number(mon[a]);
    const mod = abilityModifier(score);
    return { ability: a, label: a.toUpperCase(), score, mod: signedNumber(mod), save: saves[a] != null ? String(saves[a]) : signedNumber(mod) };
  });
}

export function savesText(save: unknown): string {
  if (!isObject(save)) return '';
  return ABILITIES.filter((a) => save[a] != null)
    .map((a) => `${ABILITY_NAMES[a].slice(0, 3)} ${String(save[a])}`)
    .join(', ');
}

export function skillsText(skill: unknown): string {
  if (!isObject(skill)) return '';
  return Object.entries(skill)
    .filter(([k]) => k !== 'other')
    .map(([k, v]) => `{@skill ${toTitleCase(k)}} ${String(v)}`)
    .sort()
    .join(', ');
}

export function immResText(list: unknown, prop: string, style: Style = 'classic'): string {
  const items = asArray(list as unknown[]);
  const parts = items.map((it): { text: string; group: boolean } => {
    if (typeof it === 'string') return { text: cf(it, style), group: false };
    if (!isObject(it)) return { text: '', group: false };
    if (it.special != null) return { text: String(it.special), group: true };
    const nested = asArray(it[prop] as unknown[]);
    const inner = immResText(nested, prop, style);
    return { text: `${it.preNote ? `${String(it.preNote)} ` : ''}${inner}${it.note ? ` ${String(it.note)}` : ''}`, group: true };
  });
  const hasGroups = parts.some((p) => p.group);
  return parts
    .map((p) => p.text)
    .filter(Boolean)
    .join(hasGroups ? '; ' : ', ');
}

export function conditionImmuneText(list: unknown, style: Style = 'classic'): string {
  return asArray(list as unknown[])
    .map((it) => {
      if (typeof it === 'string') return `{@condition ${cf(it, style)}${isModern(style) ? '|XPHB' : ''}}`;
      if (isObject(it)) {
        if (it.special != null) return String(it.special);
        return `${conditionImmuneText(it.conditionImmune, style)}${it.note ? ` ${String(it.note)}` : ''}`;
      }
      return '';
    })
    .filter(Boolean)
    .join(', ');
}

export function sensesText(mon: JsonObject, style: Style = 'classic'): string {
  const senses = asArray(mon.senses as string[]).map((s) => cf(String(s), style));
  if (mon.passive != null) senses.push(`${isModern(style) ? 'Passive Perception' : 'passive Perception'} ${String(mon.passive)}`);
  return senses.join(isModern(style) ? '; ' : ', ');
}

export function languagesText(mon: JsonObject): string {
  const langs = asArray(mon.languages as string[]);
  return langs.length ? langs.join(', ') : '—';
}

export function crText(mon: JsonObject, style: Style): string {
  const cr = crString(mon.cr);
  if (cr == null) return '—';
  const xp = crToXp(mon.cr);
  const lairXp = isObject(mon.cr) && (mon.cr.lair || mon.cr.xpLair) ? crToXp(mon.cr, { lair: true }) : null;
  const pb = crToProficiencyBonus(mon.cr);
  const xpText = xp != null ? xp.toLocaleString('en-US') : '?';
  if (isModern(style)) {
    const lair = lairXp != null ? `, or ${lairXp.toLocaleString('en-US')} in lair` : '';
    return `${cr} (XP ${xpText}${lair}; PB ${signedNumber(pb)})`;
  }
  const lair = lairXp != null ? ` or ${lairXp.toLocaleString('en-US')} XP when encountered in lair` : '';
  return `${cr} (${xpText} XP${lair})`;
}

/** 2024 initiative: dex mod + proficiency multiples (or an explicit number). */
export function initiativeText(mon: JsonObject): string | null {
  if (mon.initiative == null && mon.dex == null) return null;
  const dexMod = abilityModifier(Number(mon.dex ?? 10));
  let bonus = dexMod;
  if (typeof mon.initiative === 'number') bonus = mon.initiative;
  else if (isObject(mon.initiative)) {
    if (typeof mon.initiative.initiative === 'number') bonus = mon.initiative.initiative;
    else bonus = dexMod + Number(mon.initiative.proficiency ?? 0) * crToProficiencyBonus(mon.cr);
  }
  return `${signedNumber(bonus)} (${10 + bonus})`;
}

export function gearText(gear: unknown): string {
  return asArray(gear as unknown[])
    .map((g) => {
      if (typeof g === 'string') return `{@item ${g}}`;
      if (isObject(g) && typeof g.item === 'string') return `{@item ${g.item}}${g.quantity ? ` (${String(g.quantity)})` : ''}`;
      return '';
    })
    .filter(Boolean)
    .join(', ');
}

// endregion

// region Spells

export function spellLevelSchool(spell: JsonObject, style: Style): string {
  const level = Number(spell.level ?? 0);
  const school = spellSchoolName(spell.school) ?? '';
  const ritual = isObject(spell.meta) && spell.meta.ritual;
  if (isModern(style)) {
    const classes = uniqueClassNames(spell);
    const head = level === 0 ? `${school} Cantrip` : `Level ${level} ${school}`;
    return `${head}${classes.length ? ` (${classes.join(', ')})` : ''}`;
  }
  const head = level === 0 ? `${school} cantrip` : `${ordinal(level)}-level ${school.toLowerCase()}`;
  return `${head}${ritual ? ' (ritual)' : ''}`;
}

function uniqueClassNames(spell: JsonObject): string[] {
  return [...new Set(asArray(spell._classes as JsonObject[]).map((c) => String(c.name)))].sort();
}

export function spellClassesText(spell: JsonObject): string {
  return asArray(spell._classes as JsonObject[])
    .map((c) => `{@class ${String(c.name)}|${String(c.source)}}`)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join(', ');
}

export function spellTimeText(spell: JsonObject, style: Style): string {
  const ritual = isObject(spell.meta) && spell.meta.ritual;
  const parts = asArray(spell.time as JsonObject[]).map((t) => {
    const n = Number(t.number ?? 1);
    const unit = String(t.unit ?? '');
    const unitText = unit === 'bonus' ? 'bonus action' : unit;
    const base = isModern(style) && n === 1 && ['action', 'bonus', 'reaction'].includes(unit) ? toTitleCase(unitText) : `${n} ${unitText}${n !== 1 ? 's' : ''}`;
    return `${base}${t.condition ? `, ${String(t.condition)}` : ''}`;
  });
  return `${parts.join(' or ')}${isModern(style) && ritual ? ' or Ritual' : ''}`;
}

export function spellRangeText(spell: JsonObject): string {
  const range = isObject(spell.range) ? spell.range : null;
  if (!range) return '';
  const dist = isObject(range.distance) ? range.distance : {};
  const dType = String(dist.type ?? '');
  const amount = dist.amount;
  const unitText = (t: string, n: unknown) => {
    if (t === 'feet') return `${String(n)} ${Number(n) === 1 ? 'foot' : 'feet'}`;
    if (t === 'miles') return `${String(n)} ${Number(n) === 1 ? 'mile' : 'miles'}`;
    return `${String(n ?? '')} ${t}`.trim();
  };
  switch (range.type) {
    case 'special':
      return 'Special';
    case 'point':
      switch (dType) {
        case 'self':
          return 'Self';
        case 'touch':
          return 'Touch';
        case 'sight':
          return 'Sight';
        case 'unlimited':
          return 'Unlimited';
        case 'plane':
          return 'Unlimited on the same plane';
        default:
          return unitText(dType, amount);
      }
    case 'radius':
    case 'sphere':
    case 'cone':
    case 'line':
    case 'cube':
    case 'cylinder':
    case 'hemisphere':
    case 'emanation':
      return `Self (${String(amount)}-${dType === 'miles' ? 'mile' : 'foot'} ${String(range.type)})`;
    default:
      return unitText(dType, amount) || String(range.type ?? '');
  }
}

export function spellComponentsText(spell: JsonObject): string {
  const c = isObject(spell.components) ? spell.components : {};
  const parts: string[] = [];
  if (c.v) parts.push('V');
  if (c.s) parts.push('S');
  if (c.m != null) {
    const m = c.m;
    const text = typeof m === 'string' ? m : isObject(m) ? String(m.text ?? '') : '';
    parts.push(text ? `M (${text})` : 'M');
  }
  if (c.r) parts.push('R');
  return parts.join(', ');
}

export function spellDurationText(spell: JsonObject): string {
  return asArray(spell.duration as JsonObject[])
    .map((d) => {
      switch (d.type) {
        case 'instant':
          return 'Instantaneous';
        case 'permanent': {
          const ends = asArray(d.ends as string[]).map((e) => (e === 'dispel' ? 'dispelled' : e === 'trigger' ? 'triggered' : e === 'discharge' ? 'discharged' : e));
          return ends.length ? `Until ${joinConjunct(ends, 'or')}` : 'Permanent';
        }
        case 'special':
          return 'Special';
        case 'timed': {
          const dur = isObject(d.duration) ? d.duration : {};
          const n = Number(dur.amount ?? 1);
          const unit = `${String(dur.type ?? '')}${n !== 1 ? 's' : ''}`;
          const base = `${dur.upTo || d.concentration ? 'up to ' : ''}${n} ${unit}`;
          return d.concentration ? `Concentration, ${base}` : base.charAt(0).toUpperCase() + base.slice(1);
        }
        default:
          return String(d.type ?? '');
      }
    })
    .join(' or ');
}

// endregion

// region Items

const ITEM_TYPES: Record<string, string> = {
  M: 'melee weapon', R: 'ranged weapon', A: 'ammunition', AF: 'ammunition', LA: 'light armor', MA: 'medium armor', HA: 'heavy armor',
  S: 'shield', G: 'adventuring gear', AT: "artisan's tools", T: 'tools', INS: 'musical instrument', GS: 'gaming set', P: 'potion',
  RG: 'ring', RD: 'rod', WD: 'wand', SC: 'scroll', $C: 'treasure', $A: 'art object', $G: 'gemstone', TAH: 'tack and harness',
  TG: 'trade good', VEH: 'vehicle (land)', SHP: 'vehicle (water)', AIR: 'vehicle (air)', SPC: 'vehicle (space)', MNT: 'mount',
  FD: 'food and drink', SCF: 'spellcasting focus', EXP: 'explosive', OTH: 'other', GV: 'generic variant', IDG: 'illegal drug',
};

const ITEM_PROPERTIES: Record<string, string> = {
  '2H': 'two-handed', A: 'ammunition', AF: 'ammunition', BF: 'burst fire', F: 'finesse', H: 'heavy', L: 'light', LD: 'loading',
  R: 'reach', RLD: 'reload', S: 'special', T: 'thrown', V: 'versatile', ER: 'extended reach', Vst: 'vestige',
};

const DMG_TYPES: Record<string, string> = {
  A: 'acid', B: 'bludgeoning', C: 'cold', F: 'fire', O: 'force', L: 'lightning', N: 'necrotic', P: 'piercing', I: 'poison',
  Y: 'psychic', R: 'radiant', S: 'slashing', T: 'thunder',
};

const code = (s: unknown) => (typeof s === 'string' ? s.split('|')[0]! : '');

export function itemTypeLine(item: JsonObject, style: Style): string {
  const parts: string[] = [];
  const typeCode = code(item.type);
  let typeName = item.wondrous ? 'wondrous item' : (ITEM_TYPES[typeCode] ?? (item.weapon ? 'weapon' : item.armor ? 'armor' : ''));
  if (item.weaponCategory && (typeCode === 'M' || typeCode === 'R')) typeName = `${String(item.weaponCategory)} ${typeName}`;
  if (item.tattoo) typeName = 'wondrous item (tattoo)';
  if (item._baseName && item._category === 'Specific Variant') typeName = `${typeName} (${String(item._baseName).toLowerCase()})`;
  if (typeName) parts.push(typeName);
  const rarity = typeof item.rarity === 'string' && item.rarity !== 'none' && item.rarity !== 'unknown' ? item.rarity : null;
  if (rarity) parts.push(rarity === 'varies' ? 'rarity varies' : rarity);
  let line = tc(parts.join(', '), style);
  if (item.reqAttune) {
    line += item.reqAttune === true ? ' (requires attunement)' : ` (requires attunement ${String(item.reqAttune)})`;
  }
  if (line) line = line.charAt(0).toUpperCase() + line.slice(1);
  return line;
}

export function coinText(cp: number): string {
  if (cp >= 100 && cp % 100 === 0) return `${(cp / 100).toLocaleString('en-US')} gp`;
  if (cp >= 10 && cp % 10 === 0) return `${cp / 10} sp`;
  return `${cp} cp`;
}

export function itemPropertiesLine(item: JsonObject): string {
  const parts: string[] = [];
  if (item.dmg1) {
    const dmgType = DMG_TYPES[String(item.dmgType)] ?? '';
    parts.push(`{@damage ${String(item.dmg1)}} ${dmgType}`.trim());
  }
  if (item.ac != null) parts.push(code(item.type) === 'S' ? `AC +${String(item.ac)}` : `AC ${String(item.ac)}`);
  const props = asArray(item.property as unknown[])
    .map((p) => {
      const c = isObject(p) ? code(p.uid) : code(p);
      let name = ITEM_PROPERTIES[c] ?? c;
      if (c === 'V' && item.dmg2) name += ` ({@damage ${String(item.dmg2)}})`;
      if ((c === 'T' || c === 'A' || c === 'AF') && item.range) name += ` (range ${String(item.range)})`;
      if (isObject(p) && p.note) name += ` (${String(p.note)})`;
      return name;
    })
    .filter(Boolean);
  if (props.length) parts.push(props.join(', '));
  if (Array.isArray(item.mastery) && item.mastery.length) {
    parts.push(`Mastery: ${(item.mastery as unknown[]).map((m) => `{@itemMastery ${isObject(m) ? String(m.uid) : String(m)}}`).join(', ')}`);
  }
  if (item.strength) parts.push(`Strength ${String(item.strength)}`);
  if (item.stealth) parts.push('Stealth disadvantage');
  return parts.join(' — ');
}

export function itemValueWeight(item: JsonObject): string {
  const parts: string[] = [];
  if (typeof item.value === 'number') parts.push(coinText(item.value));
  if (typeof item.weight === 'number') parts.push(`${item.weight} lb.`);
  return parts.join(', ');
}

// endregion

// region Character options

const SHORT_ABIL = (a: string) => (ABILITY_NAMES[a as Ability] ?? a).slice(0, 3);

export function abilityBonusText(ability: unknown): string {
  return asArray(ability as unknown[])
    .map((ab) => {
      if (!isObject(ab)) return '';
      const fixed = Object.entries(ab)
        .filter(([k]) => (ABILITIES as readonly string[]).includes(k))
        .map(([k, v]) => `${SHORT_ABIL(k)} ${signedNumber(Number(v))}`);
      const choose = isObject(ab.choose) ? ab.choose : null;
      let chooseText = '';
      if (choose) {
        if (isObject(choose.weighted)) {
          const from = asArray(choose.weighted.from as string[]);
          const weights = asArray(choose.weighted.weights as number[]);
          chooseText = `Choose ${from.length === 6 ? 'any' : from.map(SHORT_ABIL).join(', ')}: ${weights.map((w) => signedNumber(w)).join('/')}`;
        } else {
          const from = asArray(choose.from as string[]);
          const count = Number(choose.count ?? 1);
          chooseText = `Choose ${count > 1 ? `${count} ` : ''}${from.length === 6 ? 'any' : `from ${from.map(SHORT_ABIL).join(', ')}`} ${signedNumber(Number(choose.amount ?? 1))}`;
        }
      }
      return [...fixed, chooseText].filter(Boolean).join(', ');
    })
    .filter(Boolean)
    .join('; or ');
}

/** Proficiency blocks: `[{insight: true, religion: true}]`, `[{any: 2}]`, `[{choose: {from: [...], count: 2}}]`. */
export function proficiencyText(list: unknown, tag?: string): string {
  const fmt = (k: string) => (tag ? `{@${tag} ${toTitleCase(k)}}` : toTitleCase(k));
  return asArray(list as unknown[])
    .map((block) => {
      if (!isObject(block)) return '';
      const parts: string[] = [];
      for (const [k, v] of Object.entries(block)) {
        if (k === 'choose' && isObject(v)) {
          const from = asArray(v.from as string[]);
          parts.push(`choose ${Number(v.count ?? 1)} from ${from.map(fmt).join(', ')}`);
        } else if (k === 'any' || k === 'anyStandard' || k === 'anyExotic') {
          parts.push(`any ${String(v)}${k === 'anyStandard' ? ' standard' : k === 'anyExotic' ? ' exotic' : ''}`);
        } else if (v === true) parts.push(fmt(k.split('|')[0]!));
      }
      return parts.join(', ');
    })
    .filter(Boolean)
    .join('; or ');
}

export function featsGrantedText(feats: unknown): string {
  return asArray(feats as unknown[])
    .flatMap((block) => (isObject(block) ? Object.keys(block).filter((k) => block[k] === true) : []))
    .map((uid) => `{@feat ${uid}}`)
    .join(', ');
}

const FEAT_CATEGORIES: Record<string, string> = { O: 'Origin Feat', G: 'General Feat', FS: 'Fighting Style Feat', 'FS:P': 'Fighting Style Feat (Paladin)', 'FS:R': 'Fighting Style Feat (Ranger)', EB: 'Epic Boon Feat', D: 'Dragonmark Feat' };

export function featCategoryText(category: unknown): string | null {
  return typeof category === 'string' ? (FEAT_CATEGORIES[category] ?? category) : null;
}

export function prerequisiteText(prereqs: unknown): string {
  return asArray(prereqs as unknown[])
    .map((p) => {
      if (!isObject(p)) return '';
      const parts: string[] = [];
      for (const [k, v] of Object.entries(p)) {
        switch (k) {
          case 'level': {
            const lvl = isObject(v) ? v : { level: v };
            const cls = isObject(lvl.class) ? ` ${String(lvl.class.name)}` : '';
            parts.push(`${ordinal(Number(lvl.level))}-level${cls}`);
            break;
          }
          case 'ability':
            parts.push(
              asArray(v as JsonObject[])
                .map((a) => Object.entries(a).map(([ab, n]) => `${ABILITY_NAMES[ab as Ability] ?? ab} ${String(n)} or higher`).join(' and '))
                .join(' or '),
            );
            break;
          case 'race':
            parts.push(asArray(v as JsonObject[]).map((r) => `${toTitleCase(String(r.displayEntry ?? r.name))}${r.subrace ? ` (${toTitleCase(String(r.subrace))})` : ''}`).join(' or '));
            break;
          case 'feat':
            parts.push(asArray(v as string[]).map((f) => `{@feat ${f}}`).join(' or '));
            break;
          case 'spellcasting':
          case 'spellcasting2020':
            if (v) parts.push('The ability to cast at least one spell');
            break;
          case 'spellcastingFeature':
            if (v) parts.push('Spellcasting or Pact Magic feature');
            break;
          case 'proficiency':
            parts.push(asArray(v as JsonObject[]).map((pr) => Object.entries(pr).map(([t, n]) => `Proficiency with ${String(n)} ${t}`).join(' and ')).join(' or '));
            break;
          case 'background':
            parts.push(asArray(v as JsonObject[]).map((b) => `${String(b.name)} background`).join(' or '));
            break;
          case 'other':
          case 'otherSummary':
            parts.push(isObject(v) ? String(v.entrySummary ?? v.entry ?? '') : String(v));
            break;
          case 'campaign':
            parts.push(`${asArray(v as string[]).join(' or ')} Campaign`);
            break;
          case 'note':
            break;
          default:
            break;
        }
      }
      return parts.filter(Boolean).join(', ');
    })
    .filter(Boolean)
    .join('; or ');
}

// endregion

export { DMG_TYPES, ITEM_TYPES, ITEM_PROPERTIES };

// region Monster spellcasting

export interface SpellcastingBlock {
  name: string;
  header: unknown[];
  lines: { label: string; spells: string }[];
  footer: unknown[];
  displayAs: string;
}

const FREQ_LABELS: Record<string, [string, string]> = {
  daily: ['day', 'Day'],
  rest: ['rest', 'Rest'],
  restLong: ['long rest', 'Long Rest'],
  weekly: ['week', 'Week'],
  monthly: ['month', 'Month'],
  yearly: ['year', 'Year'],
  charges: ['charge', 'Charge'],
  recharge: ['recharge', 'Recharge'],
  legendary: ['legendary action', 'Legendary Action'],
};

function spellList(list: unknown): string {
  return asArray(list as unknown[])
    .filter((s) => !(isObject(s) && s.hidden))
    .map((s) => (isObject(s) ? String(s.entry ?? '') : String(s)))
    .filter(Boolean)
    .join(', ');
}

export function spellcastingBlock(sc: JsonObject, style: Style): SpellcastingBlock {
  const modern = isModern(style);
  const lines: SpellcastingBlock['lines'] = [];
  if (sc.constant) lines.push({ label: modern ? 'Constant' : 'Constant', spells: spellList(sc.constant) });
  if (sc.will) lines.push({ label: modern ? 'At Will' : 'At will', spells: spellList(sc.will) });
  for (const [prop, [lower, upper]] of Object.entries(FREQ_LABELS)) {
    const freq = sc[prop];
    if (!isObject(freq)) continue;
    for (const key of Object.keys(freq).sort((a, b) => Number.parseInt(b) - Number.parseInt(a))) {
      const n = Number.parseInt(key);
      const each = key.endsWith('e');
      const unit = modern ? upper : lower;
      const label = prop === 'recharge' ? `Recharge ${n}` : `${n}/${unit}${each ? (modern ? ' Each' : ' each') : ''}`;
      lines.push({ label, spells: spellList(freq[key]) });
    }
  }
  if (isObject(sc.spells)) {
    for (const [lvl, meta] of Object.entries(sc.spells).sort(([a], [b]) => Number(a) - Number(b))) {
      if (!isObject(meta)) continue;
      const level = Number(lvl);
      const slots = meta.slots != null ? `${String(meta.slots)} slot${Number(meta.slots) === 1 ? '' : 's'}` : meta.atWill ? 'at will' : '';
      const levelLabel = level === 0 ? 'Cantrips' : `${meta.lower && meta.lower !== level ? `${ordinal(Number(meta.lower))}–` : ''}${ordinal(level)} level`;
      lines.push({ label: `${levelLabel}${slots ? ` (${slots})` : level === 0 ? ' (at will)' : ''}`, spells: spellList(meta.spells) });
    }
  }
  if (sc.ritual) lines.push({ label: 'Rituals', spells: spellList(sc.ritual) });
  return {
    name: String(sc.name ?? 'Spellcasting'),
    header: asArray(sc.headerEntries as unknown[]),
    lines,
    footer: asArray(sc.footerEntries as unknown[]),
    displayAs: typeof sc.displayAs === 'string' ? sc.displayAs : 'trait',
  };
}

// endregion

/** Layout style for an entity's statblock: entities render in their own edition's style. */
export function styleForEdition(edition: unknown): Style {
  return isModernEditionValue(edition) ? 'one' : 'classic';
}
