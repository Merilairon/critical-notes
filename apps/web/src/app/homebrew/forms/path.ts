/** Immutable get/set by path on plain JSON values. Setting `undefined` removes the key (5etools omits empty fields). */
export type JsonPath = (string | number)[];
type Json = Record<string, unknown>;

export function getAt(value: unknown, path: JsonPath): unknown {
  let cur = value;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

export function setAt<T>(root: T, path: JsonPath, value: unknown): T {
  if (!path.length) return value as T;
  const [key, ...rest] = path as [string | number, ...JsonPath];
  const container: unknown = root ?? (typeof key === 'number' ? [] : {});
  const child = setAt((container as Record<string | number, unknown>)[key], rest, value);
  if (Array.isArray(container)) {
    const copy = [...container];
    if (child === undefined) copy.splice(key as number, 1);
    else copy[key as number] = child;
    return copy as T;
  }
  const copy: Json = { ...(container as Json) };
  if (child === undefined || (isEmptyObject(child) && rest.length)) delete copy[key as string];
  else copy[key as string] = child;
  return copy as T;
}

function isEmptyObject(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0;
}

/** Empty strings, NaN and empty arrays mean "not set". */
export function normalizeValue(v: unknown): unknown {
  if (v === '' || v === null || (typeof v === 'number' && Number.isNaN(v))) return undefined;
  if (Array.isArray(v) && !v.length) return undefined;
  return v;
}
