import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type AppDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** The nearest `drizzle/` folder above this module: `apps/server/drizzle` from source, `dist/drizzle` in the bundle. */
function findMigrations(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++, dir = dirname(dir)) if (existsSync(join(dir, 'drizzle', 'meta', '_journal.json'))) return join(dir, 'drizzle');
  throw new Error('Database migrations (drizzle/) not found');
}

export const MIGRATIONS_DIR = findMigrations();

/** Opens the app database (`:memory:` for tests) and applies pending migrations. */
export function openAppDb(path: string, migrationsDir = MIGRATIONS_DIR): AppDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsDir });
  return db as AppDb;
}

/**
 * Opens the live database for a read-only job such as a CLI backup: it must exist, nothing is migrated and the journal mode is
 * left alone (an older or newer database is backed up as it is).
 */
export function openAppDbNoMigrate(path: string): AppDb {
  const sqlite = new Database(path, { fileMustExist: true });
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  return drizzle(sqlite, { schema }) as AppDb;
}

/**
 * Opens a staged (restored) database read-write for the restore: unlike `openAppDb` the pragmas that stop a hostile
 * schema from doing harm (`trusted_schema = OFF`, `cell_size_check = ON`) are set BEFORE anything runs, and the journal
 * mode is left alone (no `-wal`/`-shm` appears beside the staged file). Migrates to the build level.
 */
export function openAppDbForRestore(path: string, migrationsDir = MIGRATIONS_DIR): AppDb {
  const sqlite = new Database(path, { fileMustExist: true });
  sqlite.pragma('trusted_schema = OFF');
  sqlite.pragma('cell_size_check = ON');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  // Planner statistics from an ANALYZE are tolerated by the schema allowlist (canonical SQL only) and are inert: drop them before migrating
  for (const t of ['sqlite_stat1', 'sqlite_stat4']) sqlite.exec(`drop table if exists ${t}`);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsDir });
  return db as AppDb;
}

export { schema };
