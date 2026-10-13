/**
 * Minimal RFC 6902 diff (add / remove / replace) between two JSON values. Arrays are compared by index.
 * Used for homebrew revision history; restoring uses full snapshots, so diffs are informational.
 */
export interface JsonPatchOp {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: unknown;
}

const escape = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function jsonDiff(before: unknown, after: unknown, path = ''): JsonPatchOp[] {
  if (equal(before, after)) return [];
  if (isPlainObject(before) && isPlainObject(after)) {
    const ops: JsonPatchOp[] = [];
    for (const key of Object.keys(before)) {
      if (!(key in after)) ops.push({ op: 'remove', path: `${path}/${escape(key)}` });
    }
    for (const [key, value] of Object.entries(after)) {
      if (!(key in before)) ops.push({ op: 'add', path: `${path}/${escape(key)}`, value });
      else ops.push(...jsonDiff(before[key], value, `${path}/${escape(key)}`));
    }
    return ops;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const ops: JsonPatchOp[] = [];
    const common = Math.min(before.length, after.length);
    for (let i = 0; i < common; i++) ops.push(...jsonDiff(before[i], after[i], `${path}/${i}`));
    for (let i = before.length - 1; i >= common; i--) ops.push({ op: 'remove', path: `${path}/${i}` });
    for (let i = common; i < after.length; i++) ops.push({ op: 'add', path: `${path}/${i}`, value: after[i] });
    return ops;
  }
  return [{ op: 'replace', path: path || '', value: after }];
}
