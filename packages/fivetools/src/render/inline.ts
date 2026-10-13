/**
 * Inline render model: turns 5etools markup into a small tree of typed nodes that UI components render
 * as plain text/elements. Never produces HTML. Unknown tags degrade to their display text.
 */
import { ABILITY_NAMES, abilityModifier, type Ability } from '../constants';
import { entityUid, type EntityKind } from '../kinds';
import { entityKindForTag, parseEntityTag } from '../tags/registry';
import { parseInline, splitTagArgs, stripTags, type InlineNode } from '../tags/tokenize';
import { isSafeImagePath } from '../dataset/images';

export type TextStyle =
  | 'bold' | 'italic' | 'underline' | 'strike' | 'sup' | 'sub' | 'code' | 'kbd' | 'note' | 'small-caps' | 'small' | 'large'
  | 'capitalize' | 'muted' | 'highlight' | 'dnd-font';

export type RollMode = 'dice' | 'damage' | 'hit' | 'd20' | 'chance' | 'recharge' | 'scale' | 'coinflip';

export type InlineRender =
  | { t: 'text'; text: string }
  | { t: 'style'; styles: TextStyle[]; color?: string; title?: string; children: InlineRender[] }
  | { t: 'entity'; kind: EntityKind; uid: string; name: string; source: string; children: InlineRender[] }
  | { t: 'external'; href: string; children: InlineRender[] }
  | { t: 'filter'; page: string; filters: Record<string, string>; children: InlineRender[] }
  | { t: 'roll'; mode: RollMode; expr: string; label?: string; children: InlineRender[] }
  | { t: 'image'; path: string; children: InlineRender[] }
  | { t: 'ref'; source: string; children: InlineRender[] };

const STYLE_TAGS: Record<string, TextStyle[]> = {
  b: ['bold'], bold: ['bold'], i: ['italic'], italic: ['italic'], u: ['underline'], underline: ['underline'],
  u2: ['underline'], underlineDouble: ['underline'], s: ['strike'], strike: ['strike'], s2: ['strike'], strikeDouble: ['strike'],
  sup: ['sup'], sub: ['sub'], code: ['code'], kbd: ['kbd'], note: ['note'], comic: ['dnd-font'], comicH1: ['dnd-font', 'bold'],
  comicH2: ['dnd-font', 'bold'], comicH3: ['dnd-font', 'bold'], comicH4: ['dnd-font', 'bold'], comicNote: ['dnd-font', 'muted'],
};

const STYLE_IDS: Record<string, TextStyle> = {
  'small-caps': 'small-caps', small: 'small', large: 'large', capitalize: 'capitalize', 'dnd-font': 'dnd-font', muted: 'muted',
};

/** 5etools `{@filter}` page names → our entity kinds. */
const FILTER_PAGES: Record<string, string> = {
  spells: 'spell', bestiary: 'monster', items: 'item', races: 'race', backgrounds: 'background', feats: 'feat', classes: 'class',
  optionalfeatures: 'optionalfeature', conditionsdiseases: 'condition', variantrules: 'variantrule', deities: 'deity',
  trapshazards: 'trap', objects: 'object', vehicles: 'vehicle', rewards: 'reward', actions: 'action', languages: 'language',
  recipes: 'recipe', psionics: 'psionic', bastions: 'facility', charcreationoptions: 'charoption', tables: 'table', cultsboons: 'cult',
  decks: 'deck',
};

const text = (s: string): InlineRender => ({ t: 'text', text: s });
const italic = (s: string): InlineRender => ({ t: 'style', styles: ['italic'], children: [text(s)] });

const ORDINALS = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];

function attackTagToFull(tagStr: string, isRoll: boolean): string {
  const groups = tagStr.toLowerCase().split(',').map((g) => g.trim()).filter(Boolean).map((g) => g.split(''));
  if (groups.length > 1) {
    const seen = new Set(groups[groups.length - 1]);
    for (let i = groups.length - 2; i >= 0; --i) {
      groups[i] = groups[i]!.filter((c) => {
        const out = !seen.has(c);
        seen.add(c);
        return out;
      });
    }
  }
  const part = (tags: string[]) => {
    const type = tags.includes('m') ? 'Melee ' : tags.includes('r') ? 'Ranged ' : tags.includes('g') ? 'Magical ' : tags.includes('a') ? 'Area ' : '';
    const method = tags.includes('w') ? 'Weapon ' : tags.includes('s') ? 'Spell ' : tags.includes('p') ? 'Power ' : '';
    return `${type}${method}`;
  };
  return `${groups.map(part).join('or ')}Attack${isRoll ? ' Roll' : ''}:`;
}

function signed(n: string | number): string {
  const s = String(n).trim();
  if (/^[+-]/.test(s)) return s;
  const num = Number(s);
  return Number.isFinite(num) && num >= 0 ? `+${s}` : s;
}

function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href) || /^mailto:/i.test(href);
}

const isHexColor = (c: string) => /^#?[0-9a-f]{3,8}$/i.test(c);

/** Renders a markup string into inline nodes. */
export function renderInline(str: string): InlineRender[] {
  if (typeof str !== 'string') return [];
  return parseInline(str).map(renderNode);
}

function renderNode(node: InlineNode): InlineRender {
  if (node.type === 'text') return text(node.text);
  if (node.type === 'inject') return text(node.raw);
  try {
    return renderTag(node.tag, node.text, node.args);
  } catch {
    return text(stripTags(node.raw));
  }
}

function inner(s: string): InlineRender[] {
  return renderInline(s);
}

function renderTag(tag: string, raw: string, args: string[]): InlineRender {
  const a = (i: number) => args[i] ?? '';

  const styles = STYLE_TAGS[tag];
  if (styles) return { t: 'style', styles, children: inner(raw) };

  switch (tag) {
    case 'tip':
    case 'help':
      return { t: 'style', styles: ['underline'], title: stripTags(a(1)), children: inner(a(0)) };
    case 'footnote':
      return { t: 'style', styles: ['italic'], title: stripTags([a(1), a(2)].filter(Boolean).join(' — ')), children: inner(a(0)) };
    case 'color':
      return { t: 'style', styles: [], ...(isHexColor(a(1)) ? { color: a(1).startsWith('#') ? a(1) : `#${a(1)}` } : {}), children: inner(a(0)) };
    case 'highlight':
      return { t: 'style', styles: ['highlight'], ...(isHexColor(a(1)) ? { color: a(1).startsWith('#') ? a(1) : `#${a(1)}` } : {}), children: inner(a(0)) };
    case 'style': {
      const ids = a(1).split(';').map((s) => STYLE_IDS[s.trim()]).filter((s): s is TextStyle => !!s);
      return { t: 'style', styles: ids, children: inner(a(0)) };
    }
    case 'font':
    case 'unit':
    case 'area':
    case 'loader':
    case 'homebrew':
      return { t: 'style', styles: [], children: inner(a(0)) };

    // Statblock prose
    case 'atk':
      return italic(attackTagToFull(raw, false));
    case 'atkr':
      return italic(attackTagToFull(raw, true));
    case 'h':
      return italic('Hit: ');
    case 'm':
      return italic('Miss: ');
    case 'hom':
      return italic('Hit or Miss: ');
    case 'actSave': {
      const abil = raw.trim().toLowerCase() as Ability;
      return italic(`${ABILITY_NAMES[abil] ?? raw} Saving Throw:`);
    }
    case 'actSaveSuccess':
      return italic('Success:');
    case 'actSaveFail': {
      const ord = Number(a(0));
      return italic(ord && ORDINALS[ord] ? `${ORDINALS[ord]} Failure:` : 'Failure:');
    }
    case 'actSaveFailBy':
      return italic(`Failure by ${a(0)} or More:`);
    case 'actSaveSuccessOrFail':
      return italic('Failure or Success:');
    case 'actTrigger':
      return italic('Trigger:');
    case 'actResponse':
      return italic(raw.includes('d') ? 'Response—' : 'Response:');

    // Rolls
    case 'dice':
    case 'autodice':
      return { t: 'roll', mode: 'dice', expr: a(0), label: stripTags(a(2)) || undefined, children: inner(a(1) || a(0)) };
    case 'damage':
      return { t: 'roll', mode: 'damage', expr: a(0), children: inner(a(1) || a(0)) };
    case 'hit':
      return { t: 'roll', mode: 'hit', expr: `1d20${signed(a(0))}`, children: [text(a(1) || signed(a(0)))] };
    case 'd20':
      return { t: 'roll', mode: 'd20', expr: `1d20${signed(a(0))}`, children: [text(a(1) || signed(a(0)))] };
    case 'chance':
      return { t: 'roll', mode: 'chance', expr: '1d100', label: `${a(0)}%`, children: inner(a(1) || `${a(0)} percent`) };
    case 'recharge': {
      const n = a(0) || '6';
      return { t: 'roll', mode: 'recharge', expr: '1d6', label: `Recharge ${n}`, children: [text(n === '6' ? '(Recharge 6)' : `(Recharge ${n}–6)`)] };
    }
    case 'scaledice':
    case 'scaledamage':
      return { t: 'roll', mode: 'scale', expr: a(2), children: inner(a(4) || a(2)) };
    case 'coinflip':
      return { t: 'roll', mode: 'coinflip', expr: '1d2', children: inner(a(0) || 'flip a coin') };
    case 'dc':
      return text(`DC ${stripTags(a(1) || a(0))}`);
    case 'skillCheck':
    case 'savingThrow': {
      const [, bonus = ''] = raw.split(' ');
      return { t: 'roll', mode: 'd20', expr: `1d20${signed(bonus.split('|')[0] ?? '')}`, children: [text(a(1) || signed(bonus.split('|')[0] ?? ''))] };
    }
    case 'ability': {
      const [abil = '', score = '10'] = raw.split('|')[0]!.split(' ');
      const mod = abilityModifier(Number(score));
      return { t: 'roll', mode: 'd20', expr: `1d20${signed(mod)}`, label: abil.toUpperCase(), children: [text(a(1) ? `${score} (${a(1)})` : `${score} (${signed(mod)})`)] };
    }
    case 'hitYourSpellAttack':
      return text(a(0) || 'your spell attack modifier');
    case 'dcYourSpellSave':
      return text(a(0) || 'your spell save DC');

    // Navigation
    case 'link':
      return isSafeHref(a(1) || a(0)) ? { t: 'external', href: a(1) || a(0), children: inner(a(0)) } : { t: 'style', styles: [], children: inner(a(0)) };
    case 'filter': {
      const page = (a(1).split('.')[0] ?? '').toLowerCase();
      const filters: Record<string, string> = {};
      for (const part of args.slice(2)) {
        const [k, v] = part.split('=');
        if (k && v != null) filters[k.trim().toLowerCase()] = v.trim();
      }
      const kind = FILTER_PAGES[page];
      return kind ? { t: 'filter', page: kind, filters, children: inner(a(0)) } : { t: 'style', styles: [], children: inner(a(0)) };
    }
    case 'book':
    case 'adventure':
      return { t: 'ref', source: a(1).toUpperCase(), children: inner(a(0)) };
    case 'quickref':
      return { t: 'ref', source: a(1).toUpperCase() || 'PHB', children: inner(a(4) || a(0)) };
    case '5etools':
      return { t: 'style', styles: [], children: inner(a(0)) };
    case '5etoolsImg':
      return isSafeImagePath(a(1)) ? { t: 'image', path: a(1), children: inner(a(0)) } : { t: 'style', styles: [], children: inner(a(0)) };
    case '5etoolsAudio':
      return { t: 'style', styles: [], children: inner(a(0)) };
    default:
      break;
  }

  const kind = entityKindForTag(tag);
  if (kind) {
    const ref = parseEntityTag(tag, args);
    if (!ref) return text(stripTags(a(0)));
    return { t: 'entity', kind: ref.kind, uid: entityUid(ref.kind, ref.identity), name: ref.name, source: ref.source, children: inner(ref.display ?? ref.name) };
  }

  return { t: 'style', styles: [], children: inner(a(0)) };
}

/** Entity link targets in a string, for backlinks and broken-reference checks. */
export function findEntityRefs(str: string): { kind: EntityKind; uid: string; name: string; source: string }[] {
  const out: { kind: EntityKind; uid: string; name: string; source: string }[] = [];
  const visit = (nodes: InlineRender[]) => {
    for (const n of nodes) {
      if (n.t === 'entity') out.push({ kind: n.kind, uid: n.uid, name: n.name, source: n.source });
      if ('children' in n) visit(n.children);
    }
  };
  visit(renderInline(str));
  return out;
}

/** Plain text of rendered nodes. */
export function inlineToText(nodes: InlineRender[]): string {
  return nodes.map((n) => (n.t === 'text' ? n.text : inlineToText(n.children))).join('');
}

export { splitTagArgs };
