/**
 * A tiny arithmetic evaluator used where 5etools calls `eval()` (e.g. `calculateProp`, `<$damage_avg__...$>`).
 * Supports numbers, + - * /, unary minus and parentheses. Anything else is rejected — no code execution.
 */
export class SafeMathError extends Error {}

type Token = { type: 'num'; value: number } | { type: 'op'; value: string };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[0-9.]/.test(expr[j]!)) j++;
      const value = Number(expr.slice(i, j));
      if (Number.isNaN(value)) throw new SafeMathError(`Invalid number "${expr.slice(i, j)}"`);
      tokens.push({ type: 'num', value });
      i = j;
      continue;
    }
    if ('+-*/()'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }
    throw new SafeMathError(`Unexpected character "${ch}" in expression "${expr}"`);
  }
  return tokens;
}

export function evaluateArithmetic(expr: string): number {
  const tokens = tokenize(expr);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const parsePrimary = (): number => {
    const tok = next();
    if (!tok) throw new SafeMathError(`Unexpected end of expression "${expr}"`);
    if (tok.type === 'num') return tok.value;
    if (tok.value === '-') return -parsePrimary();
    if (tok.value === '+') return parsePrimary();
    if (tok.value === '(') {
      const value = parseExpr();
      const close = next();
      if (!close || close.value !== ')') throw new SafeMathError(`Missing ")" in "${expr}"`);
      return value;
    }
    throw new SafeMathError(`Unexpected "${tok.value}" in "${expr}"`);
  };

  const parseTerm = (): number => {
    let value = parsePrimary();
    for (let tok = peek(); tok && tok.type === 'op' && (tok.value === '*' || tok.value === '/'); tok = peek()) {
      next();
      const rhs = parsePrimary();
      value = tok.value === '*' ? value * rhs : value / rhs;
    }
    return value;
  };

  const parseExpr = (): number => {
    let value = parseTerm();
    for (let tok = peek(); tok && tok.type === 'op' && (tok.value === '+' || tok.value === '-'); tok = peek()) {
      next();
      const rhs = parseTerm();
      value = tok.value === '+' ? value + rhs : value - rhs;
    }
    return value;
  };

  const result = parseExpr();
  if (pos !== tokens.length) throw new SafeMathError(`Trailing input in "${expr}"`);
  if (!Number.isFinite(result)) throw new SafeMathError(`Non-finite result for "${expr}"`);
  return result;
}

/** Mirrors 5etools' `getCleanMathExpression`: strips everything except digits, operators, dots and commas. */
export function cleanMathExpression(str: string): string {
  return str.replace(/[^-+/*0-9.,()]+/g, '').replace(/,/g, '');
}
