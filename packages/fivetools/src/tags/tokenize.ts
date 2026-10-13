/**
 * Tokenizer for 5etools inline markup: `{@tag arg|arg|…}` (nestable) and property injectors `{=prop/mods}`.
 * Pure syntax — tag semantics live in `registry.ts`. Never throws: malformed input degrades to text.
 */

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'tag'; tag: string; text: string; args: string[]; raw: string }
  | { type: 'inject'; path: string; modifiers: string; raw: string };

/**
 * Splits a string into plain-text runs and complete top-level `{@…}` / `{=…}` segments.
 * Unbalanced braces are left as text.
 */
export function splitByTags(str: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let tagStart = -1;
  for (let i = 0; i < str.length; ++i) {
    const ch = str[i];
    if (ch === '{' && (str[i + 1] === '@' || str[i + 1] === '=')) {
      if (depth === 0) {
        if (i > start) out.push(str.slice(start, i));
        tagStart = i;
      }
      depth++;
      i++; // skip the @/=
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        out.push(str.slice(tagStart, i + 1));
        start = i + 1;
        tagStart = -1;
      }
    }
  }
  if (depth > 0 && tagStart >= 0) {
    // Unterminated tag: keep the rest as text (text before it was already pushed)
    out.push(str.slice(tagStart));
  } else if (start < str.length) out.push(str.slice(start));
  return out;
}

/** Splits on `|` at nesting depth 0 (pipes inside nested tags are kept). */
export function splitTagArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; ++i) {
    const ch = text[i]!;
    if (ch === '{' && (text[i + 1] === '@' || text[i + 1] === '=')) depth++;
    else if (ch === '}' && depth > 0) depth--;
    if (ch === '|' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseInline(str: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  for (const seg of splitByTags(str)) {
    if (seg.startsWith('{@') && seg.endsWith('}')) {
      const inner = seg.slice(2, -1);
      const spaceIx = inner.search(/\s/);
      const tag = spaceIx === -1 ? inner : inner.slice(0, spaceIx);
      const text = spaceIx === -1 ? '' : inner.slice(spaceIx + 1);
      if (!/^[A-Za-z0-9_]+$/.test(tag)) {
        pushText(nodes, seg);
        continue;
      }
      nodes.push({ type: 'tag', tag, text, args: splitTagArgs(text).map((a) => a.trim()), raw: seg });
    } else if (seg.startsWith('{=') && seg.endsWith('}')) {
      const [path = '', modifiers = ''] = seg.slice(2, -1).split('/');
      nodes.push({ type: 'inject', path, modifiers, raw: seg });
    } else {
      pushText(nodes, seg);
    }
  }
  return nodes;
}

function pushText(nodes: InlineNode[], text: string) {
  const last = nodes[nodes.length - 1];
  if (last?.type === 'text') last.text += text;
  else nodes.push({ type: 'text', text });
}

/** Removes all markup, keeping display text. Used for search indexing and plain-text previews. */
export function stripTags(str: string): string {
  return parseInline(str)
    .map((node) => {
      if (node.type === 'text') return node.text;
      if (node.type === 'inject') return '';
      return tagDisplayText(node.tag, node.args);
    })
    .join('');
}

/** Best-effort display text for a tag without semantic knowledge beyond common layouts. */
export function tagDisplayText(tag: string, args: string[]): string {
  const first = args[0] ?? '';
  switch (tag) {
    case 'h':
      return 'Hit: ';
    case 'm':
      return 'Miss: ';
    case 'hom':
      return 'Hit or Miss: ';
    case 'atk':
    case 'atkr':
      return '';
    case 'dc':
      return `DC ${args[1] || first}`;
    case 'hit':
      return Number(first) >= 0 && !first.startsWith('+') ? `+${first}` : first;
    case 'recharge':
      return first ? `(Recharge ${first}${first === '6' ? '' : '–6'})` : '(Recharge 6)';
    case 'chance':
      return args[1] || `${first} percent`;
    case 'filter':
    case 'link':
    case 'book':
    case 'adventure':
    case '5etools':
    case 'footnote':
    case 'color':
    case 'highlight':
    case 'style':
    case 'font':
      return stripTags(first);
    case 'dice':
    case 'damage':
    case 'd20':
    case 'scaledice':
    case 'scaledamage':
    case 'autodice':
      return stripTags(args[tag.startsWith('scale') ? 2 : 1] || first);
    default:
      // Entity links: name|source|display
      return stripTags(args[2] || first);
  }
}
