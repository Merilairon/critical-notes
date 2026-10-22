/**
 * `_versions` expansion (5etools `DataUtil.generic.getVersions`): each version is a `_copy` of its parent.
 * Shapes: plain version, `_mod`/`_templates` version, and `_abstract` + `_implementations` with `{{var}}`s.
 */
import { applyCopy, type CopyTemplate } from '../copy/apply';
import { clone, isObject, mapStrings, type JsonObject } from '../util/object';

export interface VersionResult {
  versions: JsonObject[];
  warnings: string[];
}

function expandCopyMeta(ent: JsonObject): JsonObject {
  ent._copy = { _mod: ent._mod, _templates: ent._templates, _preserve: ent._preserve ?? { '*': true } };
  delete ent._mod;
  delete ent._templates;
  delete ent._preserve;
  return ent;
}

function versionsFromMeta(ver: JsonObject): JsonObject[] {
  if (isObject(ver._abstract) && Array.isArray(ver._implementations) && ver._implementations.length) {
    return (ver._implementations as JsonObject[]).map((impl) => {
      let tpl = expandCopyMeta(clone(ver._abstract as JsonObject));
      const cpyImpl = clone(impl);
      if (isObject(cpyImpl._variables)) {
        const vars = cpyImpl._variables;
        tpl = mapStrings(tpl, (s) => s.replace(/{{([^{}]+)}}/g, (m, k: string) => (vars[k] != null ? String(vars[k]) : m))) as JsonObject;
        delete cpyImpl._variables;
      }
      return Object.assign(tpl, cpyImpl);
    });
  }
  return [expandCopyMeta(clone(ver))];
}

/** Extra versions 5etools derives from monster `variant[]._version` (`addAs` / `addHeadersAs`). */
function monsterVariantVersions(mon: JsonObject): JsonObject[] {
  if (!Array.isArray(mon.variant)) return [];
  const out: JsonObject[] = [];
  for (const it of mon.variant as JsonObject[]) {
    if (!isObject(it) || !isObject(it._version)) continue;
    const v = it._version;
    const toAdd: JsonObject = { name: v.name ?? it.name, source: v.source ?? it.source ?? mon.source, variant: null };
    if (typeof v.addAs === 'string') {
      const cpy = clone(it);
      delete cpy._version;
      delete cpy.type;
      delete cpy.source;
      delete cpy.page;
      toAdd._mod = { [v.addAs]: { mode: 'appendArr', items: cpy } };
      out.push(toAdd);
    } else if (typeof v.addHeadersAs === 'string') {
      const entries = (Array.isArray(it.entries) ? clone(it.entries) : []).filter(
        (e): e is JsonObject => isObject(e) && !!e.name && !!e.entries,
      );
      for (const e of entries) {
        delete e.type;
        delete e.source;
      }
      toAdd._mod = { [v.addHeadersAs]: { mode: 'appendArr', items: entries } };
      out.push(toAdd);
    }
  }
  return out;
}

export function hasVersions(prop: string, ent: JsonObject): boolean {
  if (Array.isArray(ent._versions) && ent._versions.length) return true;
  return prop === 'monster' && Array.isArray(ent.variant) && (ent.variant as JsonObject[]).some((v) => isObject(v?._version));
}

export function expandVersions(
  prop: string,
  parent: JsonObject,
  opts: { templates?: CopyTemplate[]; mergeRequiresPreserve?: Iterable<string> } = {},
): VersionResult {
  const metas = [...(Array.isArray(parent._versions) ? (parent._versions as JsonObject[]) : [])];
  if (prop === 'monster') metas.push(...monsterVariantVersions(parent));
  const warnings: string[] = [];
  const versions: JsonObject[] = [];

  for (const meta of metas) {
    if (!isObject(meta)) continue;
    for (const version of versionsFromMeta(meta)) {
      const cpyParent = clone(parent);
      delete cpyParent._versions;
      delete cpyParent.hasToken;
      delete cpyParent.hasFluff;
      delete cpyParent.hasFluffImages;
      for (const p of ['additionalSources', 'otherSources', 'referenceSources']) {
        const arr = cpyParent[p];
        if (!Array.isArray(arr)) continue;
        const filtered = arr.filter((s) => (typeof s === 'string' ? s : isObject(s) ? s.source : null) !== version.source);
        if (filtered.length) cpyParent[p] = filtered;
        else delete cpyParent[p];
      }
      const { entity, warnings: w } = applyCopy(cpyParent, version, opts);
      warnings.push(...w);
      Object.assign(entity, {
        _versionBase_isVersion: true,
        _versionBase_name: parent.name,
        _versionBase_source: parent.source,
        _versionBase_hasToken: parent.hasToken,
        _versionBase_hasFluff: parent.hasFluff,
        _versionBase_hasFluffImages: parent.hasFluffImages,
      });
      versions.push(entity);
    }
  }
  return { versions, warnings };
}
