/**
 * Resolves `<$mode__detail$>` variables used in `_mod` text (5etools `DataUtil.generic.variableResolver`).
 * Arithmetic goes through the safe evaluator; unknown variables are left untouched.
 */
import { ABILITIES, abilityModifier, crToProficiencyBonus, type Ability } from '../constants';
import { mapStrings, type JsonObject } from '../util/object';
import { cleanMathExpression, evaluateArithmetic } from '../util/safe-math';
import { toTitleCase } from '../util/string';

const SIZE_MULT: Record<string, number> = { L: 2, H: 3, G: 4 };

export function monsterShortName(mon: JsonObject, { titleCase = false }: { titleCase?: boolean } = {}): string {
  const name = String(mon.name ?? '');
  const isNamed = !!mon.isNamedCreature;
  const prefix = isNamed ? '' : titleCase ? 'The ' : 'the ';
  const shortName = mon.shortName;
  if (shortName === true) return `${prefix}${name}`;
  if (typeof shortName === 'string' && shortName) {
    return `${prefix}${!prefix && titleCase ? toTitleCase(shortName) : shortName.toLowerCase()}`;
  }
  let out = name.split(',')[0]!.replace(/(?:adult|ancient|young) \w+ (dragon|dracolich)/gi, '$1');
  out = isNamed ? out.split(' ')[0]! : out.toLowerCase();
  return `${prefix}${out}`;
}

function abilityScore(ent: JsonObject, ability: string): number {
  const v = Number(ent[ability]);
  return Number.isFinite(v) ? v : 10;
}

function isAbility(detail: string | undefined): detail is Ability {
  return !!detail && (ABILITIES as readonly string[]).includes(detail);
}

function sizeMult(ent: JsonObject): number {
  const size = Array.isArray(ent.size) ? String(ent.size[0]) : 'M';
  return SIZE_MULT[size] ?? 1;
}

export function resolveVariable(mode: string, detail: string | undefined, ent: JsonObject): string | number | null {
  switch (mode) {
    case 'name':
      return String(ent.name ?? '');
    case 'short_name':
      return monsterShortName(ent);
    case 'title_short_name':
      return monsterShortName(ent, { titleCase: true });
    case 'dc':
    case 'spell_dc':
      if (!isAbility(detail)) throw new Error(`Unknown ability score "${detail}"`);
      return 8 + abilityModifier(abilityScore(ent, detail)) + crToProficiencyBonus(ent.cr);
    case 'to_hit': {
      if (!isAbility(detail)) throw new Error(`Unknown ability score "${detail}"`);
      const total = crToProficiencyBonus(ent.cr) + abilityModifier(abilityScore(ent, detail));
      return total >= 0 ? `+${total}` : String(total);
    }
    case 'damage_mod': {
      if (!isAbility(detail)) throw new Error(`Unknown ability score "${detail}"`);
      const total = abilityModifier(abilityScore(ent, detail));
      return total === 0 ? '' : total > 0 ? ` + ${total}` : ` - ${Math.abs(total)}`;
    }
    case 'damage_avg': {
      const replaced = (detail ?? '')
        .replace(/\b(str|dex|con|int|wis|cha)\b/gi, (m) => String(abilityModifier(abilityScore(ent, m.toLowerCase()))))
        .replace(/\bsize_mult\b/g, () => String(sizeMult(ent)));
      return Math.floor(evaluateArithmetic(cleanMathExpression(replaced)));
    }
    case 'size_mult': {
      const mult = sizeMult(ent);
      if (!detail) return mult;
      return Math.floor(mult * evaluateArithmetic(cleanMathExpression(detail)));
    }
    default:
      return null;
  }
}

const VARIABLE_RE = /<\$([^$]+)\$>/g;

export function resolveVariablesInString(str: string, ent: JsonObject): string {
  return str.replace(VARIABLE_RE, (match, variable: string) => {
    const [mode = '', detail] = variable.split('__');
    const value = resolveVariable(mode, detail, ent);
    return value == null ? match : String(value);
  });
}

export function resolveVariables<T>(obj: T, ent: JsonObject): T {
  return mapStrings(obj, (s) => (s.includes('<$') ? resolveVariablesInString(s, ent) : s)) as T;
}

/** Human-readable form for editors/previews, e.g. `<$to_hit__str$>` → `(STR to-hit)`. */
export function describeVariables(str: string): string {
  return str.replace(VARIABLE_RE, (match, variable: string) => {
    const [mode, detail] = variable.split('__');
    const up = detail?.toUpperCase();
    switch (mode) {
      case 'name':
        return '(name)';
      case 'short_name':
        return '(short name)';
      case 'title_short_name':
        return '(short title name)';
      case 'dc':
        return `(${up} DC)`;
      case 'spell_dc':
        return `(${up} spellcasting DC)`;
      case 'to_hit':
        return `(${up} to-hit)`;
      case 'damage_mod':
        return `(${up} damage modifier)`;
      case 'damage_avg':
        return '(damage average)';
      case 'size_mult':
        return '(size multiplier)';
      default:
        return match;
    }
  });
}
