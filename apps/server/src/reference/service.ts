/**
 * Read API over the reference index: lists (with reprint de-duplication), entity details, search and
 * autocomplete — all filtered through a campaign policy.
 */
import {
  crossEditionBadge,
  isEditionCompatible,
  isEntityVisible,
  isKind,
  isSourceEnabled,
  KINDS,
  pickRepresentative,
  rulesetEdition,
  type CampaignPolicy,
  type EditionOrAny,
  type EntityKind,
  type SourceInfo,
} from '@cn/fivetools';
import type { EntityDto, ListItemDto, SearchHitDto, SourceDto } from '@cn/shared';
import type { IndexDb } from './index-db';

export type { EntityDto, ListItemDto, SearchHitDto, SourceDto };

interface EntityListRow {
  uid: string;
  name: string;
  source: string;
  source_json: string;
  page: string | null;
  edition: EditionOrAny;
  summary: string;
  image_path: string | null;
  token_path: string | null;
  origin: 'official' | 'homebrew';
  reprint_group: string | null;
  reprint_generation: number;
}

interface EntityFullRow extends EntityListRow {
  kind: EntityKind;
  data: string;
  raw: string | null;
  fluff: string | null;
  homebrew_entity_id: string | null;
  deleted: number;
  prop: string;
  generated_from: string | null;
  reprinted_as: string | null;
}

interface SourceRow {
  id: string;
  json_id: string;
  name: string;
  abbreviation: string;
  grp: string | null;
  published: string | null;
  kind: SourceInfo['kind'];
  edition: EditionOrAny;
  edition_reason: SourceInfo['editionReason'];
  legacy: number;
  origin: 'official' | 'homebrew';
  homebrew_source_id: string | null;
  color: string | null;
  n: number;
}

const LIST_COLUMNS = 'uid, name, source, source_json, page, edition, summary, image_path, token_path, origin, reprint_group, reprint_generation';

export class ReferenceService {
  private sources = new Map<string, SourceDto>();

  constructor(private readonly db: IndexDb) {
    this.reloadSources();
  }

  reloadSources() {
    const rows = this.db
      .prepare('SELECT s.*, (SELECT count(*) FROM entity e WHERE e.source = s.id) AS n FROM source s ORDER BY s.published, s.id')
      .all() as SourceRow[];
    this.sources = new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.json_id,
          name: r.name,
          abbreviation: r.abbreviation,
          group: r.grp,
          published: r.published,
          kind: r.kind,
          edition: r.edition,
          editionReason: r.edition_reason,
          legacy: !!r.legacy,
          origin: r.origin,
          homebrewSourceId: r.homebrew_source_id,
          color: r.color,
          entityCount: r.n,
        },
      ]),
    );
  }

  /** Official sources plus the homebrew sources the policy allows (private homebrew never leaks). */
  listSources(policy?: CampaignPolicy): SourceDto[] {
    return [...this.sources.values()].filter((s) => s.origin !== 'homebrew' || (policy?.homebrewSources.has(s.id.toLowerCase()) ?? false));
  }

  /** Sources enabled for the policy (lower-cased ids). */
  visibleSourceIds(policy: CampaignPolicy): string[] {
    return [...this.sources.entries()].filter(([, s]) => isSourceEnabled(s, policy)).map(([id]) => id);
  }

  private visibilitySql(policy: CampaignPolicy, alias = 'e'): { sql: string; params: unknown[] } {
    const ids = this.visibleSourceIds(policy);
    if (!ids.length) return { sql: '0', params: [] };
    const parts = [`${alias}.source IN (${ids.map(() => '?').join(',')})`, `${alias}.deleted = 0`];
    const params: unknown[] = [...ids];
    if (!policy.crossEdition) {
      parts.push(`${alias}.edition IN (?, 'any')`);
      params.push(rulesetEdition(policy.ruleset));
    }
    return { sql: parts.join(' AND '), params };
  }

  private dedupeReprints<T extends { uid: string; edition: EditionOrAny; reprint_group: string | null; reprint_generation: number }>(
    rows: T[],
    policy: CampaignPolicy,
  ): { kept: T[]; hiddenByGroup: Map<string, string[]> } {
    const byGroup = new Map<string, T[]>();
    for (const r of rows) if (r.reprint_group) byGroup.set(r.reprint_group, [...(byGroup.get(r.reprint_group) ?? []), r]);
    const keep = new Set<string>();
    const hiddenByGroup = new Map<string, string[]>();
    for (const [group, members] of byGroup) {
      const rep = pickRepresentative(
        members.map((m) => ({ uid: m.uid, edition: m.edition, generation: m.reprint_generation })),
        policy,
      );
      if (rep) keep.add(rep);
      hiddenByGroup.set(group, members.filter((m) => m.uid !== rep).map((m) => m.uid));
    }
    return { kept: rows.filter((r) => !r.reprint_group || keep.has(r.uid)), hiddenByGroup };
  }

  list(kind: EntityKind, policy: CampaignPolicy): ListItemDto[] {
    const vis = this.visibilitySql(policy);
    const rows = this.db
      .prepare(`SELECT ${LIST_COLUMNS} FROM entity e WHERE e.kind = ? AND ${vis.sql} ORDER BY e.name_lower, e.source`)
      .all(kind, ...vis.params) as EntityListRow[];
    const { kept, hiddenByGroup } = this.dedupeReprints(rows, policy);
    return kept.map((r) => this.toListItem(r, policy, r.reprint_group ? (hiddenByGroup.get(r.reprint_group) ?? []) : []));
  }

  private toListItem(r: EntityListRow, policy: CampaignPolicy, alsoPrintedAs: string[]): ListItemDto {
    return {
      uid: r.uid,
      name: r.name,
      source: r.source_json,
      page: r.page,
      edition: r.edition,
      badge: crossEditionBadge(r.edition, policy),
      summary: JSON.parse(r.summary) as Record<string, unknown>,
      hasImage: !!r.image_path,
      hasToken: !!r.token_path,
      origin: r.origin,
      alsoPrintedAs,
    };
  }

  resolveUid(uid: string): string {
    const alias = this.db.prepare('SELECT target_uid FROM entity_alias WHERE alias_uid = ?').get(uid) as { target_uid: string } | undefined;
    return alias?.target_uid ?? uid;
  }

  /** Display name and source (as written in the data) of an entity, following aliases. */
  describe(uidInput: string): { name: string; source: string } | null {
    const row = this.db.prepare('SELECT name, source_json FROM entity WHERE uid = ?').get(this.resolveUid(uidInput.toLowerCase())) as
      | { name: string; source_json: string }
      | undefined;
    return row ? { name: row.name, source: row.source_json } : null;
  }

  get(uidInput: string, policy: CampaignPolicy): EntityDto | null {
    const uid = this.resolveUid(uidInput.toLowerCase());
    const row = this.db.prepare('SELECT * FROM entity WHERE uid = ?').get(uid) as EntityFullRow | undefined;
    if (!row) return null;
    if (row.origin === 'homebrew' && !policy.homebrewSources.has(row.source)) return null;
    const sourceInfo = this.sources.get(row.source) ?? null;
    const sourceMap = new Map([...this.sources].map(([k, v]) => [k, v]));
    const visible = isEntityVisible({ source: row.source, edition: row.edition }, policy, sourceMap);

    const groupRows = row.reprint_group
      ? (this.db
          .prepare('SELECT uid, name, source, source_json, edition, reprint_generation FROM entity WHERE reprint_group = ? ORDER BY reprint_generation, uid')
          .all(row.reprint_group) as { uid: string; name: string; source: string; source_json: string; edition: EditionOrAny; reprint_generation: number }[])
      : [];
    const reprintGroup = groupRows.map((g) => ({
      uid: g.uid,
      name: g.name,
      source: g.source_json,
      edition: g.edition,
      visible: isEntityVisible({ source: g.source, edition: g.edition }, policy, sourceMap),
    }));
    const preferredUid =
      pickRepresentative(
        groupRows
          .filter((g, i) => reprintGroup[i]!.visible)
          .map((g) => ({ uid: g.uid, edition: g.edition, generation: g.reprint_generation })),
        policy,
      ) ?? row.uid;

    const reprintTargets = row.reprinted_as ? (JSON.parse(row.reprinted_as) as string[]) : [];
    const exists = this.db.prepare('SELECT 1 FROM entity WHERE uid = ?');
    const dto: EntityDto = {
      uid: row.uid,
      kind: row.kind,
      name: row.name,
      source: row.source_json,
      sourceInfo,
      page: row.page,
      edition: row.edition,
      badge: crossEditionBadge(row.edition, policy),
      visible,
      origin: row.origin,
      homebrewEntityId: row.homebrew_entity_id,
      deleted: !!row.deleted,
      prop: row.prop,
      data: JSON.parse(row.data) as Record<string, unknown>,
      raw: row.raw ? (JSON.parse(row.raw) as Record<string, unknown>) : null,
      fluff: row.fluff ? (JSON.parse(row.fluff) as Record<string, unknown>) : null,
      imagePath: row.image_path,
      tokenPath: row.token_path,
      summary: JSON.parse(row.summary) as Record<string, unknown>,
      generatedFrom: row.generated_from,
      reprintedAs: reprintTargets.map((t) => ({ uid: t, exists: !!exists.get(t) })),
      reprintGroup,
      preferredUid,
    };
    if (row.kind === 'class' || row.kind === 'subclass') dto.related = this.classRelated(row.kind, dto.data);
    return dto;
  }

  /** Features (and subclasses, for classes) needed to render a class page. */
  private classRelated(kind: 'class' | 'subclass', data: Record<string, unknown>) {
    const out: NonNullable<EntityDto['related']> = {};
    const add = (rows: { uid: string; kind: string; name: string; source_json: string; data: string }[]) => {
      for (const r of rows) out[r.uid] = { uid: r.uid, kind: r.kind, name: r.name, source: r.source_json, data: JSON.parse(r.data) as Record<string, unknown> };
    };
    const className = String(kind === 'class' ? data.name : data.className).toLowerCase();
    const classSource = String(kind === 'class' ? data.source : data.classSource).toLowerCase();
    // identity: name|className|classSource|level|source  (class features)
    if (kind === 'class') {
      add(
        this.db
          .prepare(`SELECT uid, kind, name, source_json, data FROM entity WHERE kind = 'classFeature' AND identity LIKE ? ESCAPE '\\'`)
          .all(`%|${escapeLike(className)}|${escapeLike(classSource)}|%`) as never[],
      );
      add(
        this.db
          .prepare(`SELECT uid, kind, name, source_json, data FROM entity WHERE kind = 'subclass' AND identity LIKE ? ESCAPE '\\'`)
          .all(`${escapeLike(className)}|${escapeLike(classSource)}|%`) as never[],
      );
    }
    if (kind === 'class') return out; // subclass features are fetched with the subclass
    const shortName = String(data.shortName ?? data.name).toLowerCase();
    add(
      this.db
        .prepare(`SELECT uid, kind, name, source_json, data FROM entity WHERE kind = 'subclassFeature' AND identity LIKE ? ESCAPE '\\'`)
        .all(`%|${escapeLike(className)}|${escapeLike(classSource)}|${escapeLike(shortName)}|${escapeLike(String(data.source).toLowerCase())}|%`) as never[],
    );
    return out;
  }

  search(query: string, policy: CampaignPolicy, opts: { kinds?: EntityKind[]; limit?: number } = {}): SearchHitDto[] {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const vis = this.visibilitySql(policy);
    const kinds = (opts.kinds ?? []).filter((k) => isKind(k));
    const kindSql = kinds.length ? `AND e.kind IN (${kinds.map(() => '?').join(',')})` : '';
    const q = query.trim().toLowerCase();
    const rows = this.db
      .prepare(
        `SELECT e.uid, e.kind, e.name, e.source, e.source_json, e.page, e.edition, e.summary, e.image_path, e.token_path, e.origin,
                e.reprint_group, e.reprint_generation,
                snippet(entity_fts, 1, '', '', '…', 12) AS snippet
         FROM entity_fts f JOIN entity e ON e.id = f.rowid
         WHERE entity_fts MATCH ? AND ${vis.sql} ${kindSql}
         ORDER BY (e.name_lower = ?) DESC, (e.name_lower LIKE ? ESCAPE '\\') DESC,
                  (e.kind IN ('spell','monster','item','condition','feat','race','background','class','variantrule','action')) DESC,
                  bm25(entity_fts, 10.0, 1.0), length(e.name)
         LIMIT ?`,
      )
      .all(fts, ...vis.params, ...kinds, q, `${escapeLike(q)}%`, limit * 3) as (EntityListRow & { kind: EntityKind; snippet: string | null })[];
    const { kept } = this.dedupeReprints(rows, policy);
    return kept.slice(0, limit).map((r) => ({
      uid: r.uid,
      kind: r.kind,
      name: r.name,
      source: r.source_json,
      edition: r.edition,
      badge: crossEditionBadge(r.edition, policy),
      summary: JSON.parse(r.summary) as Record<string, unknown>,
      snippet: r.snippet,
    }));
  }

  /** Name-prefix lookup for `{@tag}` autocomplete; prefers in-edition entities. */
  autocomplete(kind: EntityKind, prefix: string, policy: CampaignPolicy, limit = 15): SearchHitDto[] {
    const p = prefix.trim().toLowerCase();
    if (!p) return [];
    const vis = this.visibilitySql(policy);
    const rows = this.db
      .prepare(
        `SELECT uid, kind, name, source, source_json, page, edition, summary, image_path, token_path, origin, reprint_group, reprint_generation
         FROM entity e WHERE e.kind = ? AND e.name_lower LIKE ? ESCAPE '\\' AND ${vis.sql}
         ORDER BY (e.name_lower = ?) DESC, length(e.name), e.name_lower LIMIT ?`,
      )
      .all(kind, `%${escapeLike(p)}%`, ...vis.params, p, limit * 3) as (EntityListRow & { kind: EntityKind })[];
    const { kept } = this.dedupeReprints(rows, policy);
    return kept.slice(0, limit).map((r) => ({
      uid: r.uid,
      kind: r.kind,
      name: r.name,
      source: r.source_json,
      edition: r.edition,
      badge: crossEditionBadge(r.edition, policy),
      summary: JSON.parse(r.summary) as Record<string, unknown>,
      snippet: null,
    }));
  }

  /** Kinds with at least one visible entity, with counts (after reprint de-duplication is not applied). */
  kindCounts(policy: CampaignPolicy): { kind: EntityKind; label: string; count: number }[] {
    const vis = this.visibilitySql(policy);
    const rows = this.db.prepare(`SELECT kind, count(*) AS n FROM entity e WHERE ${vis.sql} GROUP BY kind`).all(...vis.params) as {
      kind: EntityKind;
      n: number;
    }[];
    const counts = new Map(rows.map((r) => [r.kind, r.n]));
    return Object.values(KINDS)
      .filter((k) => k.browsable)
      .map((k) => ({ kind: k.kind, label: k.label, count: counts.get(k.kind) ?? 0 }));
  }

  isCompatible(edition: EditionOrAny, policy: CampaignPolicy) {
    return isEditionCompatible(edition, policy);
  }
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Converts free text into a safe FTS5 query: every word becomes a quoted prefix term. */
export function toFtsQuery(input: string): string | null {
  const words = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/'/g, ''))
    .filter(Boolean)
    .slice(0, 8);
  if (!words.length) return null;
  return words.map((w) => `"${w}"*`).join(' ');
}
