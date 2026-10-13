/**
 * `{@tag …}`, `[[page links]]` and `{{fields}}` are not Markdown: a `|` inside a tag would split a table cell,
 * `*` could start emphasis. Before parsing they are swapped for private-use placeholders, and restored
 * afterwards from the parsed text.
 */

export type TokenKind = 'tag' | 'page' | 'field';
export interface Token {
  kind: TokenKind;
  /** The original text, e.g. `{@spell fireball|phb}`. */
  source: string;
}

const OPEN = '';
const CLOSE = '';
const TOKEN_RE = /(\d+)/g;

/** Replaces the protected spans with placeholders. Private-use characters in the input are dropped first. */
export function protect(markdown: string): { text: string; tokens: Token[] } {
  const src = markdown.replace(/[]/g, '');
  const tokens: Token[] = [];
  let out = '';
  let i = 0;
  const push = (kind: TokenKind, end: number) => {
    out += `${OPEN}${tokens.length}${CLOSE}`;
    tokens.push({ kind, source: src.slice(i, end) });
    i = end;
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    // An escaped opener stays Markdown text
    if (src[i] === '\\' && i + 1 < src.length) {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (two === '{@') {
      const end = balancedTag(src, i);
      if (end > 0) {
        push('tag', end);
        continue;
      }
    } else if (two === '[[') {
      const end = src.indexOf(']]', i + 2);
      if (end > i + 2 && !/[\n[]/.test(src.slice(i + 2, end))) {
        push('page', end + 2);
        continue;
      }
    } else if (two === '{{') {
      const end = src.indexOf('}}', i + 2);
      if (end > i + 2 && !/[\n{]/.test(src.slice(i + 2, end))) {
        push('field', end + 2);
        continue;
      }
    }
    out += src[i];
    i++;
  }
  return { text: out, tokens };
}

/** End index (exclusive) of a balanced `{@…}` starting at `start` on one line, or -1. */
function balancedTag(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length && i < start + 600; i++) {
    const ch = src[i];
    if (ch === '\n') return -1;
    if (ch === '{' && (src[i + 1] === '@' || src[i + 1] === '=')) {
      depth++;
      i++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Splits text into plain runs and tokens. */
export function splitTokens(text: string, tokens: Token[]): (string | Token)[] {
  const out: (string | Token)[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = tokens[Number(m[1])];
    out.push(token ?? '');
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.filter((p) => p !== '');
}

/** Puts the original text back (for code, HTML comments and anything kept literally). */
export function restoreText(text: string, tokens: Token[]): string {
  return text.replace(TOKEN_RE, (_, n: string) => tokens[Number(n)]?.source ?? '');
}
