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

const MIGRATIONS_DIR = findMigrations();

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

export { schema };
