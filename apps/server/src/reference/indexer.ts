/**
 * Builds/updates the reference index from a 5etools-src clone.
 *
 * Incremental strategy:
 *   1. Compare file size+mtime with `file_state`; if nothing changed (and the indexer version is the same),
 *      return immediately.
 *   2. For changed files, compare sha1; if content is identical (e.g. a re-checkout), only touch `file_state`.
 *   3. Otherwise rebuild in memory (≈1 s for the full dataset — `_copy` chains cross files, so a partial
 *      rebuild would be fragile) and diff-upsert rows by content hash. Homebrew rows are never touched.
 */
import { createHash } from 'node:crypto';
import {
  buildDataset,
  buildReprintGroups,
  buildSourceRegistry,
  buildSummary,
  entityEdition,
  entityText,
  firstImagePath,
  mergeSourceMeta,
  reprintEdges,
  reprintTargetUid,
  stableStringify,
  tokenPath,
  type EditionLists,
  type ResolvedEntity,
  type SourceInfo,
} from '@cn/fivetools';
import {
  extractParserSourceMeta,
  listDataFiles,
  readDataFiles,
  readGitHead,
  readPackageVersion,
  readParserJs,
  sha1File,
  sourceMetaFromIndexes,
  type DataFileInfo,
} from '@cn/fivetools/node';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getMeta, setMeta, type IndexDb } from './index-db';

/** Bump when indexing logic changes in a way that alters derived rows. */
export const INDEXER_VERSION = 6;

export interface IndexerOptions {
  srcPath: string;
  db: IndexDb;
  editionLists: EditionLists;
  force?: boolean;
  log?: (msg: string) => void;
}

export interface IndexerReport {
  status: 'up-to-date' | 'touched' | 'rebuilt';
  durationMs: number;
  files: number;
  changedFiles: string[];
  inserted: number;
  updated: number;
  deleted: number;
  entities: number;
  warnings: string[];
  dataVersion: string | null;
}

interface FileState {
  path: string;
  size: number;
  mtime: number;
  sha1: string;
}

const PARSER_PSEUDO_PATH = '../js/parser.js';

function listsKey(lists: EditionLists): string {
  const sorted = (s: ReadonlySet<string>) => [...s].sort().join(',');
  return createHash('sha1').update(`${sorted(lists.classic)}|${sorted(lists.modern)}|${sorted(lists.legacy)}`).digest('hex').slice(0, 12);
}

const asFlag = (v: unknown) => (v ? 1 : 0);

export interface EntityRow {
  uid: string;
  kind: string;
  prop: string;
  identity: string;
  name: string;
  name_lower: string;
  source: string;
  source_json: string;
  page: string | null;
  edition: string;
  srd: number;
  basic_rules: number;
  srd52: number;
  basic_rules_2024: number;
  reprint_group: string | null;
  reprint_generation: number;
  reprinted_as: string | null;
  generated_from: string | null;
  summary: string;
  data: string;
  raw: string | null;
  fluff: string | null;
  image_path: string | null;
  token_path: string | null;
  origin: 'official' | 'homebrew';
  homebrew_entity_id: string | null;
  file: string | null;
  hash: string;
}

export function entityToRow(
  e: ResolvedEntity,
  sourceEdition: SourceInfo['edition'],
  reprint: { group: string | null; generation: number },
  origin: 'official' | 'homebrew' = 'official',
  homebrewEntityId: string | null = null,
): { row: EntityRow; searchName: string; searchText: string } {
  const data = e.data;
  const reprintedAs = Array.isArray(data.reprintedAs)
    ? data.reprintedAs.map((r) => reprintTargetUid(e.kind, r)).filter((u): u is string => !!u)
    : [];
  const imagePath = firstImagePath(e.fluff) ?? firstImagePath(data);
  const partial: Omit<EntityRow, 'hash'> = {
    uid: e.uid,
    kind: e.kind,
    prop: e.prop,
    identity: e.identity,
    name: e.name,
    name_lower: e.name.toLowerCase(),
    source: e.source.toLowerCase(),
    source_json: e.source,
    page: data.page != null ? String(data.page) : null,
    edition: entityEdition(data, sourceEdition),
    srd: asFlag(data.srd ?? data._baseSrd),
    basic_rules: asFlag(data.basicRules ?? data._baseBasicRules),
    srd52: asFlag(data.srd52 ?? data._baseSrd52),
    basic_rules_2024: asFlag(data.basicRules2024 ?? data.freeRules2024 ?? data._baseBasicRules2024),
    reprint_group: reprint.group,
    reprint_generation: reprint.generation,
    reprinted_as: reprintedAs.length ? JSON.stringify(reprintedAs) : null,
    generated_from: e.generatedFrom,
    summary: JSON.stringify(buildSummary(e.kind, data)),
    data: JSON.stringify(data),
    raw: e.raw ? JSON.stringify(e.raw) : null,
    fluff: e.fluff ? JSON.stringify(e.fluff) : null,
    image_path: imagePath,
    token_path: tokenPath(e.kind, data),
    origin,
    homebrew_entity_id: homebrewEntityId,
    file: e.file,
  };
  const hash = createHash('sha256').update(stableStringify(partial)).digest('hex');
  const aliases = Array.isArray(data.alias) ? data.alias.filter((a): a is string => typeof a === 'string') : [];
  return {
    row: { ...partial, hash },
    searchName: [e.name, ...aliases].join(' '),
    searchText: entityText(data, 20_000),
  };
}

const ENTITY_COLUMNS = [
  'uid', 'kind', 'prop', 'identity', 'name', 'name_lower', 'source', 'source_json', 'page', 'edition', 'srd', 'basic_rules',
  'srd52', 'basic_rules_2024', 'reprint_group', 'reprint_generation', 'reprinted_as', 'generated_from', 'summary', 'data',
  'raw', 'fluff', 'image_path', 'token_path', 'origin', 'homebrew_entity_id', 'file', 'hash',
] as const;

export function prepareEntityWriter(db: IndexDb) {
  const upsert = db.prepare(
    `INSERT INTO entity (${ENTITY_COLUMNS.join(', ')}) VALUES (${ENTITY_COLUMNS.map((c) => `@${c}`).join(', ')})
     ON CONFLICT(uid) DO UPDATE SET ${ENTITY_COLUMNS.filter((c) => c !== 'uid').map((c) => `${c} = excluded.${c}`).join(', ')}
     RETURNING id`,
  );
  const ftsDelete = db.prepare('DELETE FROM entity_fts WHERE rowid = ?');
  const ftsInsert = db.prepare('INSERT INTO entity_fts(rowid, name, text) VALUES (?, ?, ?)');
  const deleteByUid = db.prepare('DELETE FROM entity WHERE uid = ? RETURNING id');
  return {
    write(row: EntityRow, searchName: string, searchText: string) {
      const { id } = upsert.get(row) as { id: number };
      ftsDelete.run(id);
      ftsInsert.run(id, searchName, searchText);
    },
    remove(uid: string) {
      const hit = deleteByUid.get(uid) as { id: number } | undefined;
      if (hit) ftsDelete.run(hit.id);
    },
  };
}

export async function runIndexer({ srcPath, db, editionLists, force = false, log = () => {} }: IndexerOptions): Promise<IndexerReport> {
  const t0 = performance.now();
  const report: IndexerReport = {
    status: 'up-to-date',
    durationMs: 0,
    files: 0,
    changedFiles: [],
    inserted: 0,
    updated: 0,
    deleted: 0,
    entities: 0,
    warnings: [],
    dataVersion: null,
  };
  const done = () => ({ ...report, durationMs: Math.round(performance.now() - t0) });

  const files = await listDataFiles(srcPath);
  const parserAbs = join(srcPath, 'js', 'parser.js');
  const parserStat = await stat(parserAbs).catch(() => null);
  const tracked: DataFileInfo[] = parserStat
    ? [...files, { rel: PARSER_PSEUDO_PATH, abs: parserAbs, size: parserStat.size, mtimeMs: Math.floor(parserStat.mtimeMs) }]
    : files;
  report.files = files.length;

  const indexerKey = `${INDEXER_VERSION}:${listsKey(editionLists)}`;
  const keyMatches = getMeta(db, 'indexer_key') === indexerKey;
  const states = new Map((db.prepare('SELECT path, size, mtime, sha1 FROM file_state').all() as FileState[]).map((s) => [s.path, s]));
  const changed = tracked.filter((f) => {
    const s = states.get(f.rel);
    return !s || s.size !== f.size || s.mtime !== f.mtimeMs;
  });
  const trackedPaths = new Set(tracked.map((f) => f.rel));
  const removed = [...states.keys()].filter((p) => !trackedPaths.has(p));

  if (!force && keyMatches && !changed.length && !removed.length) return done();

  const newStates = new Map<string, FileState>();
  const contentChanged: string[] = [];
  for (const f of changed) {
    const sha1 = await sha1File(f.abs);
    if (states.get(f.rel)?.sha1 !== sha1) contentChanged.push(f.rel);
    newStates.set(f.rel, { path: f.rel, size: f.size, mtime: f.mtimeMs, sha1 });
  }
  report.changedFiles = [...contentChanged, ...removed];

  const writeFileStates = () => {
    const del = db.prepare('DELETE FROM file_state WHERE path = ?');
    const ins = db.prepare('INSERT INTO file_state(path, size, mtime, sha1) VALUES (@path, @size, @mtime, @sha1) ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, sha1=excluded.sha1');
    for (const p of removed) del.run(p);
    for (const s of newStates.values()) ins.run(s);
  };

  if (!force && keyMatches && !contentChanged.length && !removed.length) {
    db.transaction(writeFileStates)();
    report.status = 'touched';
    return done();
  }

  // Full in-memory rebuild
  log(`Reading ${files.length} data files…`);
  const { files: raw, errors } = await readDataFiles(files);
  report.warnings.push(...errors.map((e) => `Unreadable data file: ${e}`));
  log('Resolving entities…');
  const result = buildDataset(raw);
  report.warnings.push(...result.warnings);

  const books = raw.find((f) => f.path === 'books.json')?.json;
  const adventures = raw.find((f) => f.path === 'adventures.json')?.json;
  const parserJs = await readParserJs(srcPath);
  const meta = mergeSourceMeta(sourceMetaFromIndexes(books, adventures), parserJs ? extractParserSourceMeta(parserJs) : new Map());
  const { sources, warnings: sourceWarnings } = buildSourceRegistry({
    usedSources: new Set(result.entities.map((e) => e.source)),
    meta,
    lists: editionLists,
  });
  report.warnings.push(...sourceWarnings);
  const sourceEdition = new Map(sources.map((s) => [s.id.toLowerCase(), s.edition]));

  const uids = new Set(result.entities.map((e) => e.uid));
  const reprints = buildReprintGroups(reprintEdges(result.entities), uids);

  log('Writing index…');
  const existing = new Map(
    (db.prepare("SELECT uid, hash FROM entity WHERE origin = 'official'").all() as { uid: string; hash: string }[]).map((r) => [r.uid, r.hash]),
  );
  const writer = prepareEntityWriter(db);

  db.transaction(() => {
    db.prepare("DELETE FROM source WHERE origin = 'official'").run();
    const insertSource = db.prepare(
      `INSERT INTO source (id, json_id, name, abbreviation, grp, published, kind, edition, edition_reason, legacy, origin)
       VALUES (@id, @json_id, @name, @abbreviation, @grp, @published, @kind, @edition, @edition_reason, @legacy, 'official')
       ON CONFLICT(id) DO NOTHING`,
    );
    for (const s of sources) {
      insertSource.run({
        id: s.id.toLowerCase(),
        json_id: s.id,
        name: s.name,
        abbreviation: s.abbreviation,
        grp: s.group,
        published: s.published,
        kind: s.kind,
        edition: s.edition,
        edition_reason: s.editionReason,
        legacy: s.legacy ? 1 : 0,
      });
    }

    const seen = new Set<string>();
    for (const e of result.entities) {
      seen.add(e.uid);
      const { row, searchName, searchText } = entityToRow(e, sourceEdition.get(e.source.toLowerCase()) ?? 'classic', {
        group: reprints.groupOf.get(e.uid) ?? null,
        generation: reprints.generation.get(e.uid) ?? 0,
      });
      const prevHash = existing.get(e.uid);
      if (prevHash === row.hash) continue;
      writer.write(row, searchName, searchText);
      if (prevHash) report.updated++;
      else report.inserted++;
    }
    for (const uid of existing.keys()) {
      if (seen.has(uid)) continue;
      writer.remove(uid);
      report.deleted++;
    }
    writeFileStates();
    const templates = raw.find((f) => f.path === 'bestiary/template.json')?.json as { monsterTemplate?: unknown[] } | undefined;
    setMeta(db, 'monster_templates', JSON.stringify(templates?.monsterTemplate ?? []));
    setMeta(db, 'indexer_key', indexerKey);
    setMeta(db, 'indexed_at', new Date().toISOString());
  })();

  const [head, version] = await Promise.all([readGitHead(srcPath), readPackageVersion(srcPath)]);
  report.dataVersion = version ? `${version}${head ? ` (${head.slice(0, 7)})` : ''}` : head;
  if (report.dataVersion) setMeta(db, 'data_version', report.dataVersion);
  report.entities = result.entities.length;
  report.status = 'rebuilt';
  return done();
}
