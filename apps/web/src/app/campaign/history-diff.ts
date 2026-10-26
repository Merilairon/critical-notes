/**
 * Pure diff code for the History panel (task N1.4; docs/design/history-ui.md section 3). No Angular. Line diff on the text of two
 * versions, a word diff inside paired changed lines, collapsing of long unchanged runs, and a short list of the other fields
 * that changed (title, type, details, properties).
 */

export type LineKind = 'equal' | 'removed' | 'added';

/** A piece of a line; `changed` pieces are the ones to mark (a whole added or removed line is one changed piece). */
export interface DiffPart {
  text: string;
  changed: boolean;
}

export interface DiffLine {
  kind: LineKind;
  parts: DiffPart[];
}

/** Above this many cells (lines a x lines b) the middle of the text is shown as one removed and one added block. */
export const MAX_DIFF_CELLS = 4_000_000;
/** A run of more than this many unchanged lines collapses. */
export const COLLAPSE_OVER = 6;
export const CONTEXT_LINES = 3;

/** The common prefix and suffix of two lists: the differing middle is `a[start..endA)` and `b[start..endB)`. */
export function trimCommon(a: readonly string[], b: readonly string[]): { start: number; endA: number; endB: number } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { start, endA, endB };
}

type Op = 'equal' | 'removed' | 'added';

/** LCS over two token lists. Returns the edit script. Trims common ends first; falls back to one block above the size guard. */
function lcsOps(a: readonly string[], b: readonly string[]): { op: Op; a?: string; b?: string }[] {
  const { start, endA, endB } = trimCommon(a, b);
  const out: { op: Op; a?: string; b?: string }[] = [];
  for (let i = 0; i < start; i++) out.push({ op: 'equal', a: a[i], b: b[i] });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_DIFF_CELLS) {
    for (const x of midA) out.push({ op: 'removed', a: x });
    for (const y of midB) out.push({ op: 'added', b: y });
  } else if (!midA.length || !midB.length) {
    for (const x of midA) out.push({ op: 'removed', a: x });
    for (const y of midB) out.push({ op: 'added', b: y });
  } else {
    const n = midA.length;
    const m = midB.length;
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] = midA[i] === midB[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ op: 'equal', a: midA[i], b: midB[j] });
        i++;
        j++;
      } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) out.push({ op: 'removed', a: midA[i++] });
      else out.push({ op: 'added', b: midB[j++] });
    }
    while (i < n) out.push({ op: 'removed', a: midA[i++] });
    while (j < m) out.push({ op: 'added', b: midB[j++] });
  }
  for (let i = endA; i < a.length; i++) out.push({ op: 'equal', a: a[i], b: b[endB + (i - endA)] });
  return out;
}

/** True when the two texts are too large to diff line by line: the changed middle is then shown as one removed and one added block. */
export function diffDegrades(from: string, to: string): boolean {
  const split = (s: string) => (s === '' ? [] : s.replace(/\r\n?/g, '\n').split('\n'));
  const a = split(from);
  const b = split(to);
  const { start, endA, endB } = trimCommon(a, b);
  return (endA - start) * (endB - start) > MAX_DIFF_CELLS;
}

/** Tokens split on whitespace, whitespace kept as its own token. */
const tokens = (s: string) => s.split(/(\s+)/).filter((t) => t !== '');

const merge = (parts: DiffPart[]): DiffPart[] => {
  const out: DiffPart[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.changed === p.changed) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
};

/** Word diff of one old and one new line: the parts of the old line (removed words changed) and of the new line (added words changed). */
export function diffWords(oldLine: string, newLine: string): { removed: DiffPart[]; added: DiffPart[] } {
  const removed: DiffPart[] = [];
  const added: DiffPart[] = [];
  for (const o of lcsOps(tokens(oldLine), tokens(newLine))) {
    if (o.op === 'equal') {
      removed.push({ text: o.a!, changed: false });
      added.push({ text: o.b!, changed: false });
    } else if (o.op === 'removed') removed.push({ text: o.a!, changed: !/^\s+$/.test(o.a!) });
    else added.push({ text: o.b!, changed: !/^\s+$/.test(o.b!) });
  }
  return { removed: merge(removed), added: merge(added) };
}

/** Line diff of two texts (CRLF counts as LF), with a word diff inside runs of adjacent removed and added lines (paired in order). */
export function diffLines(from: string, to: string): DiffLine[] {
  const split = (s: string) => (s === '' ? [] : s.replace(/\r\n?/g, '\n').split('\n'));
  const ops = lcsOps(split(from), split(to));
  const out: DiffLine[] = [];
  for (let i = 0; i < ops.length; ) {
    if (ops[i].op === 'equal') {
      out.push({ kind: 'equal', parts: [{ text: ops[i].a!, changed: false }] });
      i++;
      continue;
    }
    const rem: string[] = [];
    const add: string[] = [];
    while (i < ops.length && ops[i].op !== 'equal') {
      if (ops[i].op === 'removed') rem.push(ops[i].a!);
      else add.push(ops[i].b!);
      i++;
    }
    const paired = Math.min(rem.length, add.length);
    const remLines: DiffLine[] = rem.map((t) => ({ kind: 'removed', parts: [{ text: t, changed: true }] }));
    const addLines: DiffLine[] = add.map((t) => ({ kind: 'added', parts: [{ text: t, changed: true }] }));
    for (let k = 0; k < paired; k++) {
      // Two lines with nothing in common are shown whole; the word diff only helps when part of the line survived
      const w = diffWords(rem[k], add[k]);
      if (w.removed.some((p) => !p.changed && p.text.trim())) {
        remLines[k].parts = w.removed;
        addLines[k].parts = w.added;
      }
    }
    // A blank line that was added or removed is only a paragraph separator in the text: not worth a row of its own
    out.push(...remLines.filter((l) => l.parts.some((p) => p.text !== '')), ...addLines.filter((l) => l.parts.some((p) => p.text !== '')));
  }
  return out;
}

const wordCount = (s: string) => (s.match(/\S+/g) ?? []).length;

export interface DiffSummary {
  wordsAdded: number;
  wordsRemoved: number;
  places: number;
}

/** Counts for the line above the diff. `places` is the number of separate changed spots. */
export function summarize(lines: readonly DiffLine[]): DiffSummary {
  let wordsAdded = 0;
  let wordsRemoved = 0;
  let places = 0;
  let inPlace = false;
  for (const l of lines) {
    if (l.kind === 'equal') {
      inPlace = false;
      continue;
    }
    if (!inPlace) places++;
    inPlace = true;
    for (const p of l.parts) {
      if (!p.changed) continue;
      if (l.kind === 'added') wordsAdded += wordCount(p.text);
      else wordsRemoved += wordCount(p.text);
    }
  }
  return { wordsAdded, wordsRemoved, places };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function summaryText(s: DiffSummary): string {
  if (!s.places) return 'No text differences.';
  return `Text: ${plural(s.wordsAdded, 'word', 'words')} added, ${plural(s.wordsRemoved, 'word', 'words')} removed in ${plural(s.places, 'place', 'places')}.`;
}

export type DiffItem = { type: 'line'; line: DiffLine } | { type: 'gap'; id: number; hidden: DiffLine[] };

/** Runs of more than `over` unchanged lines become a gap with `context` lines kept on each side that touches a change. */
export function collapse(lines: readonly DiffLine[], expanded: ReadonlySet<number> = new Set(), over = COLLAPSE_OVER, context = CONTEXT_LINES): DiffItem[] {
  const out: DiffItem[] = [];
  let id = 0;
  for (let i = 0; i < lines.length; ) {
    if (lines[i].kind !== 'equal') {
      out.push({ type: 'line', line: lines[i++] });
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].kind === 'equal') j++;
    const run = lines.slice(i, j);
    if (run.length <= over || expanded.has(id)) {
      for (const line of run) out.push({ type: 'line', line });
    } else {
      const head = i === 0 ? 0 : context;
      const tail = j === lines.length ? 0 : context;
      for (const line of run.slice(0, head)) out.push({ type: 'line', line });
      out.push({ type: 'gap', id, hidden: run.slice(head, run.length - tail) });
      for (const line of run.slice(run.length - tail)) out.push({ type: 'line', line });
    }
    id++;
    i = j;
  }
  return out;
}

export interface FieldChange {
  /** `title`, `type`, `details`, or `properties` */
  group: 'Title' | 'Type' | 'Details' | 'Properties';
  label: string;
  from: string;
  to: string;
}

const MAX_VALUE = 80;

/** A scalar or short JSON as text for the change list; cut at 80 characters. */
export function showValue(v: unknown): string {
  let s: string;
  if (v === null || v === undefined || v === '') s = 'empty';
  else if (typeof v === 'string') s = `"${v}"`;
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in (b as object) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

interface Snapshot {
  title: string;
  type: string;
  details: Record<string, unknown> | null;
  properties: Record<string, unknown>;
}

/** The fields other than the text that differ. `labels` map a details or property key to its label; a missing key shows raw. */
export function diffFields(a: Snapshot, b: Snapshot, labels: { type?: (t: string) => string; details?: (key: string) => string | undefined; property?: (key: string) => string | undefined } = {}): FieldChange[] {
  const out: FieldChange[] = [];
  if (a.title !== b.title) out.push({ group: 'Title', label: 'Title', from: showValue(a.title), to: showValue(b.title) });
  if (a.type !== b.type) out.push({ group: 'Type', label: 'Type', from: labels.type?.(a.type) ?? a.type, to: labels.type?.(b.type) ?? b.type });
  const scalarish = (v: unknown) => (v === undefined ? null : v);
  const keys = (x: Record<string, unknown> | null, y: Record<string, unknown> | null) => [...new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})])].sort();
  for (const k of keys(a.details, b.details)) {
    const x = scalarish(a.details?.[k]);
    const y = scalarish(b.details?.[k]);
    if (!deepEqual(x, y)) out.push({ group: 'Details', label: labels.details?.(k) ?? k, from: showValue(x), to: showValue(y) });
  }
  for (const k of keys(a.properties, b.properties)) {
    const x = scalarish(a.properties[k]);
    const y = scalarish(b.properties[k]);
    if (!deepEqual(x, y)) out.push({ group: 'Properties', label: labels.property?.(k) ?? k, from: showValue(x), to: showValue(y) });
  }
  return out;
}
