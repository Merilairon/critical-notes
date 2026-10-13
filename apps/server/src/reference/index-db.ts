/**
 * The reference index: a derived, rebuildable SQLite database holding resolved official + homebrew
 * entities and FTS5 search tables. Never the source of truth for user data.
 */
import Database from 'better-sqlite3';

export type IndexDb = Database.Database;

/** Bump when the index schema or derived columns change; forces a full rebuild. */
export const INDEX_SCHEMA_VERSION = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS file_state (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  sha1 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source (
  id TEXT PRIMARY KEY,               -- lower-cased source id
  json_id TEXT NOT NULL,             -- source id as written in data
  name TEXT NOT NULL,
  abbreviation TEXT NOT NULL,
  grp TEXT,
  published TEXT,
  kind TEXT NOT NULL,                -- book | adventure | other | homebrew
  edition TEXT NOT NULL,             -- classic | one | any
  edition_reason TEXT NOT NULL,
  legacy INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL,              -- official | homebrew
  homebrew_source_id TEXT,
  color TEXT
);

CREATE TABLE IF NOT EXISTS entity (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  prop TEXT NOT NULL,
  identity TEXT NOT NULL,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  source TEXT NOT NULL,              -- lower-cased source id (FK source.id)
  source_json TEXT NOT NULL,
  page TEXT,
  edition TEXT NOT NULL,
  srd INTEGER NOT NULL DEFAULT 0,
  basic_rules INTEGER NOT NULL DEFAULT 0,
  srd52 INTEGER NOT NULL DEFAULT 0,
  basic_rules_2024 INTEGER NOT NULL DEFAULT 0,
  reprint_group TEXT,
  reprint_generation INTEGER NOT NULL DEFAULT 0,
  reprinted_as TEXT,                 -- JSON array of target uids
  generated_from TEXT,
  summary TEXT NOT NULL,             -- JSON
  data TEXT NOT NULL,                -- JSON, resolved entity
  raw TEXT,                          -- JSON, as written in the data file (null for generated entities)
  fluff TEXT,                        -- JSON, resolved fluff
  image_path TEXT,
  token_path TEXT,
  origin TEXT NOT NULL,              -- official | homebrew
  homebrew_entity_id TEXT,
  file TEXT,
  hash TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0  -- soft-deleted homebrew: still resolvable by uid, hidden from lists and search
);
CREATE INDEX IF NOT EXISTS entity_kind_name ON entity(kind, name_lower);
CREATE INDEX IF NOT EXISTS entity_source ON entity(source);
CREATE INDEX IF NOT EXISTS entity_group ON entity(reprint_group);
CREATE INDEX IF NOT EXISTS entity_origin ON entity(origin);
CREATE INDEX IF NOT EXISTS entity_homebrew ON entity(homebrew_entity_id);

CREATE VIRTUAL TABLE IF NOT EXISTS entity_fts USING fts5(
  name, text,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);

CREATE TABLE IF NOT EXISTS entity_alias (
  alias_uid TEXT PRIMARY KEY,
  target_uid TEXT NOT NULL
);

-- Campaign page search (derived from the app DB on save; DM and player text indexed separately)
CREATE TABLE IF NOT EXISTS page_search (
  id INTEGER PRIMARY KEY,
  page_id TEXT NOT NULL UNIQUE,
  campaign_id TEXT NOT NULL,
  type TEXT NOT NULL,
  icon TEXT,
  visibility TEXT NOT NULL,
  title TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS page_search_campaign ON page_search(campaign_id);
CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(
  title, text_dm, text_player,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);
`;

export function openIndexDb(path: string, { readonly = false }: { readonly?: boolean } = {}): IndexDb {
  const db = new Database(path, { readonly, fileMustExist: readonly });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  if (!readonly) migrateIndexDb(db);
  return db;
}

function migrateIndexDb(db: IndexDb) {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
  const version = hasMeta ? (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined)?.value : undefined;
  if (version && Number(version) !== INDEX_SCHEMA_VERSION) {
    // Derived data: drop and rebuild rather than migrate
    db.exec(`
      DROP TABLE IF EXISTS page_fts;
      DROP TABLE IF EXISTS page_search;
      DROP TABLE IF EXISTS entity_fts;
      DROP TABLE IF EXISTS entity;
      DROP TABLE IF EXISTS source;
      DROP TABLE IF EXISTS file_state;
      DROP TABLE IF EXISTS entity_alias;
      DROP TABLE IF EXISTS meta;
    `);
  }
  db.exec(SCHEMA);
  db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(INDEX_SCHEMA_VERSION));
}

export function getMeta(db: IndexDb, key: string): string | null {
  return (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}

export function setMeta(db: IndexDb, key: string, value: string) {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
