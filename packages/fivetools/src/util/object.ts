/** Small, dependency-free helpers for working with untyped 5etools JSON. */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: unknown };

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function getPath(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function setPath(obj: JsonObject, path: readonly string[], value: unknown): void {
  if (!path.length) throw new Error('setPath requires a non-empty path');
  if (path.some((key) => key === '__proto__' || key === 'constructor' || key === 'prototype')) throw new Error('setPath refuses a prototype key');
  let cur: JsonObject = obj;
  for (let i = 0; i < path.length - 1; ++i) {
    const key = path[i]!;
    const next = cur[key];
    if (next == null || typeof next !== 'object') cur[key] = {};
    cur = cur[key] as JsonObject;
  }
  cur[path[path.length - 1]!] = value;
}

export function getOrSetPath<T>(obj: JsonObject, path: readonly string[], fallback: T): T {
  const existing = getPath(obj, path);
  if (existing !== undefined) return existing as T;
  setPath(obj, path, fallback);
  return fallback;
}

export function deletePath(obj: JsonObject, path: readonly string[]): void {
  if (!path.length) return;
  const parent = getPath(obj, path.slice(0, -1));
  if (parent && typeof parent === 'object') delete (parent as JsonObject)[path[path.length - 1]!];
}

export function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bArr = b as unknown[];
    return a.length === bArr.length && a.every((v, i) => deepEquals(v, bArr[i]));
  }
  const aKeys = Object.keys(a as object);
  const bObj = b as JsonObject;
  return aKeys.length === Object.keys(bObj).length && aKeys.every((k) => deepEquals((a as JsonObject)[k], bObj[k]));
}

/** Recursively maps every string in a JSON value, returning a new value (input is not mutated). */
export function mapStrings(value: unknown, fn: (str: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn);
    return out;
  }
  return value;
}

/** Visits every string in a JSON value. */
export function forEachString(value: unknown, fn: (str: string) => void): void {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.forEach((v) => forEachString(v, fn));
  if (isObject(value)) for (const v of Object.values(value)) forEachString(v, fn);
}

export function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Stable, order-independent JSON stringify used for content hashing. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys
    .filter((k) => (value as JsonObject)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as JsonObject)[k])}`)
    .join(',')}}`;
}
