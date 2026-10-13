/**
 * `{=prop/modifiers}` property injection used by magic item variants (5etools `Renderer.applyProperties`).
 */
import { mapStrings, type JsonObject } from '../util/object';
import { splitByTags } from '../tags/tokenize';
import { toTitleCase } from '../util/string';

const LEADING_AN = new Set(['a', 'e', 'i', 'o', 'u']);
const OP_ORDER = 'v x l t u a r f c'.split(' ');
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

export function numberToText(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1000) return String(n);
  if (n < 20) return ONES[n]!;
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`;
  return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberToText(n % 100)}` : ''}`;
}

const VULGAR: Record<string, string> = { '0.125': '⅛', '0.25': '¼', '0.375': '⅜', '0.5': '½', '0.625': '⅝', '0.75': '¾', '0.875': '⅞' };
export function numberToVulgar(n: number): string {
  const whole = Math.trunc(n);
  const frac = Math.abs(n - whole);
  const sym = VULGAR[String(frac)];
  if (!frac) return String(whole);
  if (!sym) return String(n);
  return whole ? `${whole}${sym}` : `${n < 0 ? '-' : ''}${sym}`;
}

export function applyPropertiesToString(str: string, obj: JsonObject): string {
  if (!str.includes('{=')) return str;
  return splitByTags(str)
    .map((seg) => {
      if (seg.startsWith('{@')) {
        const inner = seg.slice(1, -1);
        const ix = inner.indexOf(' ');
        if (ix < 0) return seg;
        return `{${inner.slice(0, ix)} ${applyPropertiesToString(inner.slice(ix + 1), obj)}}`;
      }
      if (!seg.startsWith('{=')) return seg;
      const [path = '', modifiers = ''] = seg.slice(2, -1).split('/');
      let value: unknown = obj[path];
      if (!modifiers) return String(value ?? '');
      if (value == null) return '';
      const mods = modifiers.split('').sort((a, b) => OP_ORDER.indexOf(a) - OP_ORDER.indexOf(b));
      for (const mod of mods) {
        const s = String(value);
        switch (mod) {
          case 'a':
            value = LEADING_AN.has(s[0]?.toLowerCase() ?? '') ? 'an' : 'a';
            break;
          case 'l':
            value = s.toLowerCase();
            break;
          case 't':
            value = toTitleCase(s);
            break;
          case 'u':
            value = s.toUpperCase();
            break;
          case 'v':
            value = numberToVulgar(Number(value));
            break;
          case 'x':
            value = numberToText(Number(value));
            break;
          case 'r':
            value = Math.round(Number(value));
            break;
          case 'f':
            value = Math.floor(Number(value));
            break;
          case 'c':
            value = Math.ceil(Number(value));
            break;
          default:
            break; // unknown modifier: ignore
        }
      }
      return String(value);
    })
    .join('');
}

export function applyProperties<T>(value: T, obj: JsonObject): T {
  return mapStrings(value, (s) => applyPropertiesToString(s, obj)) as T;
}
