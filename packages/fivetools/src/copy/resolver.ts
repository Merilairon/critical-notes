/**
 * Resolves `_copy` chains lazily with memoization and cycle detection. Parents are found through a lookup
 * callback, so the same resolver works for official data (in-memory maps) and homebrew (which may copy
 * official entities stored in the index).
 */
import { identityKey, KINDS, kindForProp, kindForFluffProp } from '../kinds';
import { isObject, type JsonObject } from '../util/object';
import { applyCopy, type CopyTemplate } from './apply';

export type CopyLookup = (prop: string, key: string) => JsonObject | undefined;

export interface CopyResolverOptions {
  /** Templates for `_copy._templates`, by prop (e.g. monster → monsterTemplate entries). */
  templatesFor?: (prop: string) => CopyTemplate[] | undefined;
}

/** Props searched for a `_copy` parent, in order: the same prop, then the other props of the same kind. */
export function parentPropsFor(prop: string): string[] {
  const kind = kindForProp(prop);
  if (kind && prop !== 'subrace') return [prop, ...KINDS[kind].props.filter((p) => p !== prop)];
  return [prop];
}

function mergePreserveFor(prop: string): string[] {
  const kind = kindForProp(prop) ?? kindForFluffProp(prop);
  return kind && !prop.endsWith('Fluff') ? (KINDS[kind].mergeRequiresPreserve ?? []) : [];
}

export class CopyResolver {
  private readonly cache = new WeakMap<JsonObject, JsonObject>();
  private readonly inProgress = new WeakSet<JsonObject>();
  readonly warnings: string[] = [];

  constructor(
    private readonly lookup: CopyLookup,
    private readonly opts: CopyResolverOptions = {},
  ) {}

  /** Returns the resolved entity (a new object if `_copy` was applied; the input otherwise). */
  resolve(prop: string, ent: JsonObject): JsonObject {
    if (!isObject(ent._copy)) return ent;
    const cached = this.cache.get(ent);
    if (cached) return cached;

    const label = `${prop} "${String(ent.name)}" (${String(ent.source)})`;
    if (this.inProgress.has(ent)) {
      this.warnings.push(`${label}: _copy cycle detected`);
      return this.unresolved(ent, 'cycle');
    }

    const copyMeta = ent._copy;
    let parent: JsonObject | undefined;
    let parentProp = prop;
    for (const p of parentPropsFor(prop)) {
      parent = this.lookup(p, identityKey(p, copyMeta));
      if (parent) {
        parentProp = p;
        break;
      }
    }
    if (!parent) {
      this.warnings.push(`${label}: _copy parent "${String(copyMeta.name)}" (${String(copyMeta.source)}) not found`);
      return this.unresolved(ent, 'missing');
    }
    if (parent === ent) {
      this.warnings.push(`${label}: _copy references itself`);
      return this.unresolved(ent, 'cycle');
    }

    this.inProgress.add(ent);
    try {
      const resolvedParent = this.resolve(parentProp, parent);
      const { entity, warnings } = applyCopy(resolvedParent, ent, {
        templates: this.opts.templatesFor?.(prop),
        mergeRequiresPreserve: mergePreserveFor(prop),
      });
      this.warnings.push(...warnings);
      this.cache.set(ent, entity);
      return entity;
    } catch (err) {
      this.warnings.push(`${label}: ${(err as Error).message}`);
      return this.unresolved(ent, 'error');
    } finally {
      this.inProgress.delete(ent);
    }
  }

  private unresolved(ent: JsonObject, reason: string): JsonObject {
    const out: JsonObject = { ...ent, _copyUnresolved: reason };
    delete out._copy;
    this.cache.set(ent, out);
    return out;
  }
}
