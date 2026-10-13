/**
 * Dice expressions as used by 5etools tags: `2d6+3`, `d20`, `1d20 + 5`, `4d6kh3`, `2d10 + 1d6 - 1`, `1d4×10`.
 * Pure parser + roller (random source injectable for tests). Unsupported syntax returns null — callers then
 * show the text without a roll button.
 */

export interface DiceTerm {
  sign: 1 | -1;
  count: number;
  faces: number;
  keep?: { type: 'kh' | 'kl' | 'dh' | 'dl'; n: number };
}
export interface DiceExpression {
  terms: DiceTerm[];
  constant: number;
  multiplier: number;
  source: string;
}

export interface DiceRoll {
  expression: string;
  total: number;
  rolls: { faces: number; values: number[]; kept: boolean[] }[];
  constant: number;
  multiplier: number;
}

const MAX_DICE = 200;
const MAX_FACES = 10_000;

export function parseDice(input: string): DiceExpression | null {
  if (typeof input !== 'string') return null;
  let src = input
    .toLowerCase()
    .replace(/[−–]/g, '-')
    .trim()
    .replace(/\s*([+\-×*])\s*/g, '$1');
  if (!src || /\s/.test(src)) return null;
  let multiplier = 1;
  const mult = /[×x*](\d+)$/.exec(src);
  if (mult && !/d\d*x$/.test(src)) {
    multiplier = Number(mult[1]);
    src = src.slice(0, mult.index);
  }
  const terms: DiceTerm[] = [];
  let constant = 0;
  const re = /([+-]?)(?:(\d*)d(\d+)(?:(kh|kl|dh|dl)(\d+))?|(\d+))/gy;
  let pos = 0;
  let total = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m || m.index !== pos) return null;
    if (pos > 0 && !m[1]) return null; // terms after the first need an operator
    const sign: 1 | -1 = m[1] === '-' ? -1 : 1;
    if (m[3]) {
      const count = m[2] ? Number(m[2]) : 1;
      const faces = Number(m[3]);
      if (!count || !faces || count > MAX_DICE || faces > MAX_FACES) return null;
      total += count;
      if (total > MAX_DICE) return null;
      const term: DiceTerm = { sign, count, faces };
      if (m[4]) term.keep = { type: m[4] as 'kh' | 'kl' | 'dh' | 'dl', n: Number(m[5]) };
      terms.push(term);
    } else {
      constant += sign * Number(m[6]);
    }
    pos = re.lastIndex;
  }
  if (!terms.length && constant === 0 && !/\d/.test(src)) return null;
  return { terms, constant, multiplier, source: input.trim() };
}

export type RandomInt = (maxInclusive: number) => number;

export const mathRandomInt: RandomInt = (max) => 1 + Math.floor(Math.random() * max);

export function rollDice(expr: DiceExpression, random: RandomInt = mathRandomInt): DiceRoll {
  let total = expr.constant;
  const rolls: DiceRoll['rolls'] = [];
  for (const term of expr.terms) {
    const values = Array.from({ length: term.count }, () => random(term.faces));
    let kept = values.map(() => true);
    if (term.keep) {
      const order = values.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
      const n = Math.min(term.keep.n, values.length);
      const keepIdx = new Set(
        (term.keep.type === 'kh' ? order.slice(-n) : term.keep.type === 'kl' ? order.slice(0, n) : term.keep.type === 'dh' ? order.slice(0, values.length - n) : order.slice(n)).map(
          ([, i]) => i,
        ),
      );
      kept = values.map((_, i) => keepIdx.has(i));
    }
    const sum = values.reduce((acc, v, i) => acc + (kept[i] ? v : 0), 0);
    total += term.sign * sum;
    rolls.push({ faces: term.faces, values, kept });
  }
  return { expression: expr.source, total: total * expr.multiplier, rolls, constant: expr.constant, multiplier: expr.multiplier };
}

export function averageDice(expr: DiceExpression): number {
  const avg = expr.terms.reduce((acc, t) => acc + t.sign * t.count * ((t.faces + 1) / 2), expr.constant);
  return avg * expr.multiplier;
}
