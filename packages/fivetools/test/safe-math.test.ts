import { describe, expect, it } from 'vitest';
import { cleanMathExpression, evaluateArithmetic } from '../src/util/safe-math';

describe('evaluateArithmetic', () => {
  it('evaluates arithmetic with precedence, parentheses and unary minus', () => {
    expect(evaluateArithmetic('2 + 3 * 4')).toBe(14);
    expect(evaluateArithmetic('(2 + 3) * 4')).toBe(20);
    expect(evaluateArithmetic('-3 + 10 / 4')).toBe(-0.5);
    expect(evaluateArithmetic('1.5*2')).toBe(3);
  });

  it('rejects anything that is not arithmetic', () => {
    for (const bad of ['alert(1)', 'process.exit()', '1;2', 'constructor', '2**8', '1/0', '', '(1']) {
      expect(() => evaluateArithmetic(bad)).toThrow();
    }
  });

  it('cleans expressions like 5etools does, minus thousand separators', () => {
    expect(cleanMathExpression('<$x$> 1,000 + 2 gp')).toBe('1000+2');
  });
});
