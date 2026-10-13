/** Image and token paths, relative to the 5etools-img root (see DATA_NOTES.md §6). */
import type { EntityKind } from '../kinds';
import { isObject, type JsonObject } from '../util/object';
import { toAscii } from '../util/string';

export function nameToTokenName(name: string): string {
  return toAscii(name).replace(/"/g, '');
}

const TOKEN_DIRS: Partial<Record<EntityKind, string>> = {
  monster: 'bestiary/tokens',
  object: 'objects/tokens',
  vehicle: 'vehicles/tokens',
};

export function tokenPath(kind: EntityKind, ent: JsonObject): string | null {
  const dir = TOKEN_DIRS[kind];
  if (!dir) return null;
  if (isObject(ent.token) && ent.token.name && ent.token.source) {
    return `${dir}/${String(ent.token.source)}/${nameToTokenName(String(ent.token.name))}.webp`;
  }
  if (ent.hasToken) return `${dir}/${String(ent.source)}/${nameToTokenName(String(ent.name))}.webp`;
  if (ent._versionBase_hasToken && ent._versionBase_name) {
    return `${dir}/${String(ent._versionBase_source ?? ent.source)}/${nameToTokenName(String(ent._versionBase_name))}.webp`;
  }
  return null;
}

/** First internal image path in a fluff entry (or any `images` array). */
export function firstImagePath(fluff: JsonObject | null | undefined): string | null {
  if (!fluff || !Array.isArray(fluff.images)) return null;
  for (const img of fluff.images) {
    if (isObject(img) && isObject(img.href) && img.href.type === 'internal' && typeof img.href.path === 'string') return img.href.path;
  }
  return null;
}

/** Validates an image path from data or user input: relative, no traversal, known image extension. */
export function isSafeImagePath(path: string): boolean {
  if (!path || path.length > 512) return false;
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  if (path.split('/').some((seg) => seg === '..' || seg === '.')) return false;
  return /\.(webp|png|jpe?g|gif)$/i.test(path);
}
