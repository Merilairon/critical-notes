/**
 * The Postgres schema must mirror the SQLite one: same tables, columns, nullability, keys, foreign keys and
 * indexes, with the agreed type mapping. Both migration sets are applied for real (SQLite in memory, Postgres
 * in PGlite) and their resulting columns compared, so a stale migration also fails here.
 */
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { eq, getTableName, is, type Column } from 'drizzle-orm';
import { getTableConfig as pgTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { getTableConfig as sqliteTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAppDb } from '../src/db';
import * as sqliteSchema from '../src/db/schema';
import * as pgSchema from '../src/db/schema.pg';

const PG_MIGRATIONS = join(import.meta.dirname, '..', 'drizzle-pg');

/** The Postgres type each SQLite column must have. Epoch-millisecond timestamps (`*_at`) need 64 bits. */
function expectedPgType(column: Column): string {
  if (column.columnType === 'SQLiteBoolean') return 'boolean';
  if (column.columnType === 'SQLiteTextJson') return 'jsonb';
  if (column.columnType === 'SQLiteInteger') return column.name.endsWith('_at') ? 'bigint' : 'integer';
  return 'text';
}

interface Shape {
  columns: Record<string, { type: string; notNull: boolean; primary: boolean; unique: boolean; hasDefault: boolean }>;
  primaryKeys: string[];
  foreignKeys: string[];
  indexes: string[];
}

type AnyConfig = ReturnType<typeof sqliteTableConfig> | ReturnType<typeof pgTableConfig>;

function shape(config: AnyConfig, typeOf: (c: Column) => string): Shape {
  const names = (cols: { name: string }[]) => cols.map((c) => c.name).join(',');
  return {
    columns: Object.fromEntries(
      (config.columns as Column[]).map((c) => [c.name, { type: typeOf(c), notNull: c.notNull, primary: c.primary, unique: c.isUnique, hasDefault: c.hasDefault }]),
    ),
    primaryKeys: config.primaryKeys.map((pk) => names(pk.columns)).sort(),
    foreignKeys: config.foreignKeys
      .map((fk) => {
        const ref = fk.reference();
        return `${names(ref.columns)} -> ${getTableName(ref.foreignTable)}(${names(ref.foreignColumns)}) on delete ${fk.onDelete ?? 'no action'}`;
      })
      .sort(),
    indexes: config.indexes
      .map((ix) => `${ix.config.name}${ix.config.unique ? ' unique' : ''} (${names(ix.config.columns as { name: string }[])})${ix.config.where ? ' partial' : ''}`)
      .sort(),
  };
}

const sqliteTables = (Object.values(sqliteSchema) as unknown[]).filter((v): v is SQLiteTable => is(v, SQLiteTable));
const pgTables = (Object.values(pgSchema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));

describe('Postgres schema parity', () => {
  it('has the same tables', () => {
    expect(pgTables.map(getTableName).sort()).toEqual(sqliteTables.map(getTableName).sort());
  });

  it.each(sqliteTables.map((t) => [getTableName(t), t] as const))('%s matches', (name, table) => {
    const pg = pgTables.find((t) => getTableName(t) === name)!;
    expect(shape(pgTableConfig(pg), (c) => c.getSQLType())).toEqual(shape(sqliteTableConfig(table), expectedPgType));
  });
});

describe('Postgres migrations', () => {
  let client: PGlite;
  beforeAll(async () => {
    client = new PGlite();
    await migrate(drizzle(client), { migrationsFolder: PG_MIGRATIONS });
  });
  afterAll(() => client.close());

  it('create the same columns as the SQLite migrations', async () => {
    const sqlite = openAppDb(':memory:').$client;
    const fromSqlite = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'").all() as { name: string }[])
      .flatMap(({ name }) => (sqlite.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; notnull: number; pk: number }[]).map((c) => `${name}.${c.name} ${c.notnull || c.pk ? 'not null' : 'null'}`))
      .sort();
    const { rows } = await client.query<{ table_name: string; column_name: string; is_nullable: string }>(
      "SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public'",
    );
    const fromPg = rows.map((r) => `${r.table_name}.${r.column_name} ${r.is_nullable === 'YES' ? 'null' : 'not null'}`).sort();
    expect(fromPg).toEqual(fromSqlite);
  });

  it('store and read back JSON, booleans and timestamps', async () => {
    const db = drizzle(client, { schema: pgSchema });
    await db.insert(pgSchema.users).values({ id: 'u1', username: 'jan', displayName: 'Jan', passwordHash: 'x', isAdmin: true });
    await db.insert(pgSchema.campaigns).values({ id: 'c1', name: 'Vell', ruleset: 'r', createdBy: 'u1' });
    await db.insert(pgSchema.pages).values({ id: 'p1', campaignId: 'c1', sortKey: 'a0', title: 'Town', body: { type: 'doc', content: [] } });
    const [page] = await db.select().from(pgSchema.pages).where(eq(pgSchema.pages.id, 'p1'));
    expect(page!.body).toEqual({ type: 'doc', content: [] });
    expect(page!.createdAt).toBeGreaterThan(Date.UTC(2020, 0, 1));
    const [user] = await db.select().from(pgSchema.users);
    expect(user!.isAdmin).toBe(true);
    // Deleting the campaign cascades to its pages, as in SQLite
    await db.delete(pgSchema.campaigns).where(eq(pgSchema.campaigns.id, 'c1'));
    expect(await db.select().from(pgSchema.pages)).toEqual([]);
  });
});
