/**
 * Placeholder tokenizer for template text: `{{name}}`, `{{dc: number = 13}}`, `{{creature: reference<monster>}}`.
 * `\{{` is a literal `{{`. Anything that does not parse as a placeholder stays text. A single left-to-right
 * scan, no regular expressions over the whole string, so arbitrary user text cannot cause backtracking.
 */

export type Segment = { t: 'text'; text: string } | { t: 'var'; name: string; type?: string; default?: string; raw: string };

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[\w.-]/;

function parseInner(inner: string): { name: string; type?: string; default?: string } | null {
  let i = 0;
  while (i < inner.length && inner[i] === ' ') i++;
  if (i >= inner.length || !NAME_START.test(inner[i]!)) return null;
  let name = '';
  while (i < inner.length && NAME_CHAR.test(inner[i]!)) name += inner[i++];
  while (i < inner.length && inner[i] === ' ') i++;
  let type: string | undefined;
  let dflt: string | undefined;
  if (inner[i] === ':') {
    i++;
    let depth = 0;
    let t = '';
    // The type ends at "=" outside brackets: select(a|b) and reference<monster> may not contain "="
    while (i < inner.length && !(inner[i] === '=' && depth === 0)) {
      const c = inner[i]!;
      if (c === '(' || c === '<') depth++;
      if (c === ')' || c === '>') depth = Math.max(0, depth - 1);
      t += c;
      i++;
    }
    type = t.trim() || undefined;
  }
  if (inner[i] === '=') {
    dflt = inner.slice(i + 1).trim();
    if (dflt.length >= 2 && dflt.startsWith('"') && dflt.endsWith('"')) dflt = dflt.slice(1, -1);
    i = inner.length;
  }
  if (i < inner.length && inner.slice(i).trim()) return null;
  return { name, ...(type ? { type } : {}), ...(dflt !== undefined ? { default: dflt } : {}) };
}

export function tokenize(str: string): Segment[] {
  const out: Segment[] = [];
  let text = '';
  let i = 0;
  const flush = () => {
    if (text) out.push({ t: 'text', text });
    text = '';
  };
  while (i < str.length) {
    if (str[i] === '\\' && str[i + 1] === '{' && str[i + 2] === '{') {
      text += '{{';
      i += 3;
      continue;
    }
    if (str[i] === '{' && str[i + 1] === '{') {
      const close = str.indexOf('}}', i + 2);
      const parsed = close >= 0 ? parseInner(str.slice(i + 2, close)) : null;
      if (parsed) {
        flush();
        out.push({ t: 'var', ...parsed, raw: str.slice(i, close + 2) });
        i = close + 2;
        continue;
      }
    }
    text += str[i++];
  }
  flush();
  return out;
}

/** True if the string contains at least one placeholder. */
export function hasPlaceholders(str: string): boolean {
  return str.includes('{{') && tokenize(str).some((s) => s.t === 'var');
}
