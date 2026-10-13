/** Builds the source registry (one `SourceInfo` per source id seen in the data). */
import { classifySource, type Edition, type EditionLists, type SourceInfo } from '../edition/sources';

export interface SourceMetaLike {
  id: string;
  name: string | null;
  abbreviation: string | null;
  published: string | null;
  group: string | null;
  kind: 'book' | 'adventure' | 'other';
}

export interface BuildSourcesInput {
  usedSources: Iterable<string>;
  /** Merged metadata, lower-cased id → meta. Index files take precedence over parser.js. */
  meta: ReadonlyMap<string, SourceMetaLike>;
  lists: EditionLists;
  overrides?: ReadonlyMap<string, Edition>;
}

export function buildSourceRegistry({ usedSources, meta, lists, overrides }: BuildSourcesInput): { sources: SourceInfo[]; warnings: string[] } {
  const warnings: string[] = [];
  const seen = new Map<string, SourceInfo>();
  for (const id of usedSources) {
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    const m = meta.get(key);
    const cls = classifySource({ id, published: m?.published, lists, overrides });
    if (cls.warning) warnings.push(cls.warning);
    seen.set(key, {
      id,
      name: m?.name ?? id,
      abbreviation: m?.abbreviation ?? id,
      group: m?.group ?? null,
      published: m?.published ?? null,
      kind: m?.kind ?? 'other',
      edition: cls.edition,
      editionReason: cls.reason,
      legacy: cls.legacy,
    });
  }
  return { sources: [...seen.values()].sort((a, b) => a.id.localeCompare(b.id)), warnings };
}

export function mergeSourceMeta(...maps: ReadonlyMap<string, SourceMetaLike>[]): Map<string, SourceMetaLike> {
  const out = new Map<string, SourceMetaLike>();
  // Later maps have lower priority: only fill gaps
  for (const map of maps) {
    for (const [key, meta] of map) {
      const existing = out.get(key);
      if (!existing) out.set(key, { ...meta });
      else {
        existing.name ??= meta.name;
        existing.abbreviation ??= meta.abbreviation;
        existing.published ??= meta.published;
        existing.group ??= meta.group;
      }
    }
  }
  return out;
}
