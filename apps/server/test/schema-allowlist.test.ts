/**
 * BLOCKER for Task M3.3 (docs/design/backup.md 8 step 3.3 and 19): the restore's schema allowlist.
 *
 * `prepareRestoredDatabase` refuses a staged database whose `sqlite_master` differs from a `:memory:` database migrated to
 * the same journal prefix. That is only safe if a GENUINE database, created at every historical migration level and
 * upgraded through the real migrate path, always equals a fresh one. If this file fails after a new migration, the
 * allowlist can no longer vouch for real backups: STOP, do not weaken the check, raise a design change with the Security
 * Architect. The levels are read from the journal, so a new migration is covered the moment it is added.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, openAppDb } from '../src/db';
import { compareSchema, loadJournal, prepareRestoredDatabase, referenceSchema, RestoreRefusal } from '../src/services/backups';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const journal = loadJournal();
const LEVELS = journal.length;

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'cn-allow-'));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A migrations folder holding only the first `n` entries of the build's journal (the "old build" of level n). */
function prefixMigrations(n: number): string {
  const dir = join(work, `migrations-${n}`);
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const j = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...j, entries: j.entries.slice(0, n) }));
  for (const e of j.entries.slice(0, n)) cpSync(join(MIGRATIONS_DIR, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

/** What an old server of level n would have left on disk: opened through the real migrate path, then as a backup copy (rollback journal). */
function genuineAtLevel(n: number, name: string): string {
  const path = join(work, name);
  const db = openAppDb(path, prefixMigrations(n));
  db.$client.exec(`insert into users (id, username, display_name, password_hash) values ('u1', 'gm', 'GM', 'h')`);
  db.$client.pragma('journal_mode = DELETE');
  db.$client.close();
  return path;
}

type Row = { type: string; name: string; tbl_name: string; sql: string | null };
const master = (db: Database.Database): Row[] =>
  db.prepare('select type, name, tbl_name, sql from sqlite_master order by type, name, tbl_name, sql').all() as Row[];

/** The oracle: a database created by the server's own `openAppDb` (not by the allowlist's reference builder). */
function oracleAtLevel(n: number): Row[] {
  const db = openAppDb(':memory:', n >= LEVELS ? MIGRATIONS_DIR : prefixMigrations(n));
  try {
    return master(db.$client);
  } finally {
    db.$client.close();
  }
}

describe('schema allowlist stability (M3.3 blocker)', () => {
  it('knows every migration the repository ships: journal, files and hashes agree, and there are at least the 7 historical levels', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    expect(LEVELS, 'journal entries').toBe(files.length);
    expect(LEVELS, 'the historical levels 0000..0006 must all still be in the journal').toBeGreaterThanOrEqual(7);
    expect(journal.slice(0, 7).map((e) => e.tag)).toEqual([
      '0000_init',
      '0001_links_properties_uploads',
      '0002_templates',
      '0003_encounters_inventory',
      '0004_members_invites',
      '0005_api_tokens',
      '0006_accounts',
    ]);
    for (const e of journal) expect(files, e.tag).toContain(`${e.tag}.sql`);
  });

  for (let n = 1; n <= LEVELS; n++) {
    const tag = journal[n - 1]!.tag;
    it(`level ${n - 1} (${tag}): the allowlist accepts the genuine database, and the upgrade equals a fresh latest database`, async () => {
      const path = genuineAtLevel(n, `lvl${n}.sqlite`);

      // (a) the allowlist at the backup's own level accepts a genuine database of that level, and agrees with an independent oracle
      const ro = new Database(path, { readonly: true });
      try {
        const diff = compareSchema(ro, referenceSchema(n));
        expect(diff, `a genuine level-${n - 1} database was judged foreign at ${diff}. STOP: raise a design change (backup.md 8.3.3)`).toBeNull();
        expect(master(ro), 'genuine level equals the independent oracle').toEqual(oracleAtLevel(n));
      } finally {
        ro.close();
      }

      // (b) the restore's own path (staged copy upgraded by prepareRestoredDatabase) ends equal to a fresh latest database
      const report = await prepareRestoredDatabase(path, { now: NOW });
      expect(report.migratedSteps).toBe(LEVELS - n);
      const staged = new Database(path, { readonly: true });
      try {
        expect(master(staged), 'upgraded staged copy equals a fresh latest database').toEqual(oracleAtLevel(LEVELS));
      } finally {
        staged.close();
      }
    });

    it(`level ${n - 1} (${tag}): the server's real upgrade path (openAppDb on an old database) also ends equal to a fresh latest database`, () => {
      const path = genuineAtLevel(n, `real${n}.sqlite`);
      const db = openAppDb(path); // what starting the new server on that database does
      try {
        expect(master(db.$client)).toEqual(oracleAtLevel(LEVELS));
      } finally {
        db.$client.close();
      }
    });
  }

  // The allowlist must also stay SHARP at every level, not only at the latest one
  const PLANTS: [string, string][] = [
    ['a planted trigger', `create trigger planted after update on users begin update users set is_admin = 1; end`],
    ['a planted view', `create view planted as select password_hash from users`],
    ['an extra table', `create table planted (x)`],
    ['an extra index', `create index planted_idx on users (password_hash)`],
    ['a non-canonical sqlite_stat1', `create table zz (tbl, idx, stat, extra); pragma writable_schema = 1; update sqlite_master set name = 'sqlite_stat1', tbl_name = 'sqlite_stat1', sql = 'CREATE TABLE sqlite_stat1(tbl,idx,stat,extra)' where name = 'zz'; pragma writable_schema = 0;`],
    ['a sqlite_stat1 view-like trap', `create table zz (x); pragma writable_schema = 1; update sqlite_master set name = 'sqlite_stat4', tbl_name = 'sqlite_stat4', sql = 'CREATE TABLE sqlite_stat4(x)' where name = 'zz'; pragma writable_schema = 0;`],
  ];
  for (const [what, sql] of PLANTS) {
    it(`refuses ${what} at every historical level, before anything is written`, async () => {
      for (let n = 1; n <= LEVELS; n++) {
        const path = genuineAtLevel(n, `plant-${n}-${what.replace(/\W+/g, '_')}.sqlite`);
        const db = new Database(path);
        db.unsafeMode(true); // lets a test write sqlite_master (the reserved sqlite_stat names)
        db.exec(sql);
        db.close();
        const before = readFileSync(path);
        const err = await prepareRestoredDatabase(path, { now: NOW }).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err, `level ${n - 1} must refuse ${what}`).toBeInstanceOf(RestoreRefusal);
        expect((err as RestoreRefusal).code).toBe('schema');
        expect(readFileSync(path).equals(before), 'the staged file is untouched by a refusal').toBe(true);
      }
    });
  }

  it('tolerates the planner statistics an ANALYZE leaves (canonical sqlite_stat1) and drops them: the result still equals a fresh database', async () => {
    for (let n = 1; n <= LEVELS; n++) {
      const path = genuineAtLevel(n, `stat-${n}.sqlite`);
      const db = new Database(path);
      db.exec('analyze');
      expect(db.prepare(`select count(*) as n from sqlite_master where name = 'sqlite_stat1'`).get()).toEqual({ n: 1 });
      db.close();
      await prepareRestoredDatabase(path, { now: NOW });
      const staged = new Database(path, { readonly: true });
      try {
        expect(master(staged), `level ${n - 1}`).toEqual(oracleAtLevel(LEVELS));
      } finally {
        staged.close();
      }
    }
  });

  it('flags DDL that can make the allowlist unstable until a human has reviewed it', () => {
    // These constructs rewrite stored schema text (RENAME, DROP COLUMN), depend on data or version (AUTOINCREMENT adds sqlite_sequence,
    // ANALYZE adds sqlite_stat1) or create objects the allowlist must treat with care (triggers, views, virtual tables).
    // Adding a migration with one of them fails here. Review it against the allowlist (the two tests above must still pass for it),
    // get the Security Architect's agreement, then add the tag and the construct to REVIEWED.
    const RISKY: [string, RegExp][] = [
      ['ALTER TABLE ... RENAME', /alter\s+table\s+\S+\s+rename/i],
      ['DROP COLUMN', /drop\s+column/i],
      ['DROP TABLE', /drop\s+table/i],
      ['AUTOINCREMENT', /autoincrement/i],
      ['TRIGGER', /create\s+(temp\w*\s+)?trigger/i],
      ['VIEW', /create\s+(temp\w*\s+)?view/i],
      ['VIRTUAL TABLE', /create\s+virtual\s+table/i],
      ['writable_schema', /writable_schema/i],
      ['ANALYZE', /\banalyze\b/i],
      ['PRAGMA', /\bpragma\b/i],
      ['sqlite_ tables', /\bsqlite_(master|schema|stat|sequence)/i],
    ];
    const REVIEWED: Record<string, string[]> = {};
    const found: string[] = [];
    for (const e of journal) {
      const sql = readFileSync(join(MIGRATIONS_DIR, `${e.tag}.sql`), 'utf8');
      for (const [label, re] of RISKY) if (re.test(sql) && !REVIEWED[e.tag]?.includes(label)) found.push(`${e.tag}: ${label}`);
    }
    expect(found, 'unreviewed risky DDL in migrations: see the comment in this test before touching REVIEWED').toEqual([]);
  });

  it('is not defeated by a reference built from the wrong journal: a database one level off is refused by the other level\'s reference', () => {
    const a = genuineAtLevel(LEVELS - 1, 'off-by-one.sqlite');
    const db = new Database(a, { readonly: true });
    try {
      expect(compareSchema(db, referenceSchema(LEVELS))).not.toBeNull();
      expect(compareSchema(db, referenceSchema(LEVELS - 1))).toBeNull();
    } finally {
      db.close();
    }
  });
});
