import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, openAppDb, openAppDbForRestore } from '../src/db';
import {
  carryOverRestrictions,
  compareMigrationRows,
  loadJournal,
  prepareRestoredDatabase,
  readMigrationRows,
  probeStopped,
  readBackup,
  RestoreRefusal,
  ServerRunningError,
  type PrepareReport,
} from '../src/services/backups';
import { makeEnv, noise, upId, type BackupEnv } from './backup-helpers';

let env: BackupEnv;
let work: string;
beforeEach(() => {
  env = makeEnv();
  work = mkdtempSync(join(tmpdir(), 'cn-rs-'));
});
afterEach(() => {
  env.cleanup();
  rmSync(work, { recursive: true, force: true });
});

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

/** A migrations folder holding only the first `n` entries of the build's journal. */
function prefixMigrations(n: number): string {
  const dir = join(work, `migrations-${n}`);
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, n) }));
  for (const e of journal.entries.slice(0, n)) cpSync(join(MIGRATIONS_DIR, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

/** A database at migration level `n`, built through the real upgrade path, as a staged (journal_mode = DELETE) file. */
function dbAtLevel(n: number, name: string): string {
  const path = join(work, name);
  const db = n >= loadJournal().length ? openAppDb(path) : openAppDb(path, prefixMigrations(n));
  db.$client.exec(`insert into users (id, username, display_name, password_hash) values ('u1', 'gm', 'GM', 'h')`);
  db.$client.pragma('journal_mode = DELETE');
  db.$client.close();
  return path;
}

const LEVELS = loadJournal().length;

describe('restore building blocks: a real backup round trip', () => {
  function seed() {
    const q = env.db.$client;
    q.exec(`
      insert into users (id, username, display_name, password_hash, is_admin, disabled_at) values ('u2', 'player', 'Player', 'h2', 0, null), ('u3', 'locked', 'Locked', 'h3', 0, 1700000000000);
      insert into campaign_members (campaign_id, user_id, role) values ('c1', 'u1', 'dm');
      insert into pages (id, campaign_id, sort_key, title, body, visibility) values ('p1', 'c1', 'a', 'Secret', '{"x":1}', 'dm'), ('p2', 'c1', 'b', 'Open', '{"x":2}', 'all');
      insert into sessions (id, user_id, expires_at) values ('s1', 'u1', 4102444800000), ('s2', 'u2', 4102444800000);
      insert into password_resets (id, user_id, token_hash, expires_at) values ('r1', 'u2', 'rh1', 4102444800000);
      insert into api_tokens (id, user_id, name, token_hash, scope, revoked_at) values ('t1', 'u1', 'live', 'th1', 'read', null), ('t2', 'u1', 'old', 'th2', 'read', 1690000000000);
      insert into campaign_invites (id, campaign_id, token_hash, role, revoked_at) values ('i1', 'c1', 'ih1', 'player', null), ('i2', 'c1', 'ih2', 'player', 1690000000000);
    `);
  }

  async function backupAndStage() {
    seed();
    const uploads = new Map<string, Buffer>();
    for (let i = 1; i <= 4; i++) {
      const data = noise(5000 * i);
      env.addUpload(upId(i), data, { thumb: noise(700) });
      uploads.set(upId(i), data);
    }
    const r = await env.service({ opsLog: false }).create({ actor: 'a', trigger: 'cli' });
    const staging = join(work, 'staging');
    mkdirSync(staging);
    await readBackup(join(env.config.backupDir, r.name), { extractTo: staging });
    return { staging, uploads };
  }

  const tables = (db: Database.Database) => (db.prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`).all() as { name: string }[]).map((t) => t.name);
  const dump = (db: Database.Database, table: string, omit: string[] = []) =>
    (db.prepare(`select * from ${table} order by rowid`).all() as Record<string, unknown>[]).map((r) => {
      for (const k of omit) delete r[k];
      return r;
    });

  it('backup, extract and prepare gives identical data except the purged and revoked state; uploads are byte-identical', async () => {
    const { staging, uploads } = await backupAndStage();
    const report = await prepareRestoredDatabase(join(staging, 'app.sqlite'), { stagedUploadsDir: join(staging, 'uploads'), now: NOW });
    const restored = new Database(join(staging, 'app.sqlite'), { readonly: true });
    expect(restored.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    const purged: Record<string, string[]> = { sessions: [], password_resets: [], api_tokens: ['revoked_at'], campaign_invites: ['revoked_at'] };
    for (const t of tables(env.db.$client)) {
      if (t === 'sessions' || t === 'password_resets') {
        expect(dump(restored, t), t).toEqual([]);
        continue;
      }
      expect(dump(restored, t, purged[t] ?? []), t).toEqual(dump(env.db.$client, t, purged[t] ?? []));
    }
    expect(restored.prepare('select id, revoked_at from api_tokens order by id').all()).toEqual([
      { id: 't1', revoked_at: NOW },
      { id: 't2', revoked_at: 1690000000000 }, // already revoked: stays as it was
    ]);
    expect(restored.prepare('select revoked_at from campaign_invites where id = ?').get('i1')).toEqual({ revoked_at: NOW });
    expect(restored.prepare('select disabled_at from users where id = ?').get('u3')).toEqual({ disabled_at: 1700000000000 });
    for (const [id, data] of uploads) {
      expect(readFileSync(join(staging, 'uploads', id)).equals(data)).toBe(true);
      expect(sha(join(staging, 'uploads', id))).toBe((restored.prepare('select sha256 from uploads where id = ?').get(id) as { sha256: string }).sha256);
    }
    expect(report).toMatchObject({
      migratedSteps: 0,
      purged: { sessions: 2, passwordResets: 1, apiTokensRevoked: 1, invitesRevoked: 1 },
      missingUploads: 0,
      admins: ['gm'],
    });
    expect(report.carry.liveCompared).toBe(false);
    expect(report.sha256).toBe(sha(join(staging, 'app.sqlite')));
    expect(report.size).toBe(readFileSync(join(staging, 'app.sqlite')).length);
    restored.close();
    expect(readdirSync(staging).sort()).toEqual(['app.sqlite', 'uploads']); // no -wal, no -shm
    // and the application can open it as a normal database
    const app = openAppDb(join(staging, 'app.sqlite'));
    expect(app.$client.prepare('select count(*) as n from users').get()).toEqual({ n: 3 });
    app.$client.close();
  });

  it('--keep-tokens leaves tokens and invites as they were in the backup; sessions and resets are cleared regardless', async () => {
    const { staging } = await backupAndStage();
    const report = await prepareRestoredDatabase(join(staging, 'app.sqlite'), { keepTokens: true, now: NOW });
    const restored = new Database(join(staging, 'app.sqlite'), { readonly: true });
    expect(restored.prepare('select id, revoked_at from api_tokens order by id').all()).toEqual([
      { id: 't1', revoked_at: null },
      { id: 't2', revoked_at: 1690000000000 },
    ]);
    expect(restored.prepare('select revoked_at from campaign_invites where id = ?').get('i1')).toEqual({ revoked_at: null });
    expect(restored.prepare('select count(*) as n from sessions').get()).toEqual({ n: 0 });
    expect(report.purged).toMatchObject({ sessions: 2, passwordResets: 1, apiTokensRevoked: 0, invitesRevoked: 0 });
    restored.close();
  });

  it('counts uploads rows without a file and lists the enabled admins', async () => {
    const { staging } = await backupAndStage();
    rmSync(join(staging, 'uploads', upId(2)));
    env.db.$client.exec(`insert into users (id, username, display_name, password_hash, is_admin) values ('u9', 'sneaky', 'S', 'h', 1)`);
    // (the new admin is not in the staged copy: only the backup's admins are listed)
    const report = await prepareRestoredDatabase(join(staging, 'app.sqlite'), { stagedUploadsDir: join(staging, 'uploads'), now: NOW });
    expect(report.missingUploads).toBe(1);
    expect(report.admins).toEqual(['gm']);
    const disabled = new Database(join(staging, 'app.sqlite'));
    disabled.prepare(`update users set is_admin = 1`).run();
    disabled.close();
  });

  it('opens the staged database with the hardening pragmas set and without WAL', () => {
    const path = dbAtLevel(LEVELS, 'p.sqlite');
    const db = openAppDbForRestore(path);
    expect(db.$client.pragma('trusted_schema', { simple: true })).toBe(0);
    expect(db.$client.pragma('cell_size_check', { simple: true })).toBe(1);
    expect(db.$client.pragma('journal_mode', { simple: true })).toBe('delete');
    db.$client.close();
    expect(existsSync(`${path}-wal`)).toBe(false);
  });
});

describe('restore building blocks: schema allowlist and migration rows', () => {
  async function expectRefusal(path: string, code: RestoreRefusal['code'] | RestoreRefusal['code'][], opts = {}) {
    const err = await prepareRestoredDatabase(path, { now: NOW, ...opts }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, 'should have been refused').toBeInstanceOf(RestoreRefusal);
    expect([code].flat()).toContain((err as RestoreRefusal).code);
    return err as RestoreRefusal;
  }

  it('every historical migration level upgrades to a schema equal to a fresh one (the allowlist is stable)', async () => {
    for (let n = 1; n <= LEVELS; n++) {
      const path = dbAtLevel(n, `lvl${n}.sqlite`);
      const report = await prepareRestoredDatabase(path, { now: NOW });
      expect(report.migratedSteps, `level ${n}`).toBe(LEVELS - n);
      const db = new Database(path, { readonly: true });
      expect(db.prepare('select username from users').all()).toEqual([{ username: 'gm' }]);
      expect(db.prepare('select count(*) as n from __drizzle_migrations').get()).toEqual({ n: LEVELS });
      db.close();
    }
  });

  for (const [what, sql] of [
    ['a planted trigger', `create table evil_marker (x); create trigger evil after insert on __drizzle_migrations begin insert into evil_marker values (1); end;`],
    ['a trigger on a real table only', `create trigger evil after update on api_tokens begin update users set is_admin = 1; end`],
    ['a planted view', `create view evil as select password_hash from users`],
    ['an extra index', `create index evil_idx on users (password_hash)`],
    ['an extra table', `create table evil_table (x)`],
    ['a virtual table', `create virtual table evil_fts using fts5(x)`],
    ['an altered column', `alter table users add column evil text`],
  ] as const) {
    it(`refuses ${what} before anything is written or executed`, async () => {
      const path = dbAtLevel(LEVELS, 'evil.sqlite');
      const db = new Database(path);
      db.exec(sql);
      db.close();
      const before = sha(path);
      const err = await expectRefusal(path, 'schema');
      expect(err.message).not.toContain('\n');
      expect(sha(path), 'the staged file must be untouched').toBe(before);
      expect(readdirSync(work).filter((n) => n.startsWith('evil.sqlite-'))).toEqual([]);
    });
  }

  it('a trigger that would write a marker row proves it never fired during migration or the purges', async () => {
    const path = dbAtLevel(LEVELS - 1, 'old-evil.sqlite'); // older: migration would run, and with it the trigger target
    const db = new Database(path);
    db.exec(`create table evil_marker (x); create trigger evil after insert on __drizzle_migrations begin insert into evil_marker values (1); end;
             create trigger evil2 after update on api_tokens begin insert into evil_marker values (2); end;`);
    db.close();
    await expectRefusal(path, 'schema');
    const check = new Database(path, { readonly: true });
    expect(check.prepare('select count(*) as n from evil_marker').get()).toEqual({ n: 0 });
    check.close();
  });

  it('refuses forged migration rows: a huge created_at (that would make migrate() skip everything), another hash, a gap, no rows', async () => {
    const forge = (name: string, sql: string) => {
      const path = dbAtLevel(LEVELS - 2, name);
      const db = new Database(path);
      db.exec(sql);
      db.close();
      return path;
    };
    const huge = forge('f1.sqlite', `update __drizzle_migrations set created_at = 9000000000000000 where rowid = (select max(rowid) from __drizzle_migrations)`);
    expect((await expectRefusal(huge, 'different')).message).toMatch(/differs/);
    await expectRefusal(forge('f2.sqlite', `update __drizzle_migrations set hash = 'ffff' where rowid = 2`), 'different');
    await expectRefusal(forge('f3.sqlite', `delete from __drizzle_migrations where rowid = 2`), 'different');
    await expectRefusal(forge('f4.sqlite', `delete from __drizzle_migrations`), 'different');
    await expectRefusal(forge('f5.sqlite', `drop table __drizzle_migrations`), 'invalid');
  });

  it('reads at most journal-length + 1 migration rows from a hostile database, with bounded memory, and still gives the right verdict', async () => {
    const path = dbAtLevel(LEVELS, 'many.sqlite');
    const db = new Database(path);
    db.exec(`with recursive n(i) as (select 1 union all select i + 1 from n where i < 1500000)
             insert into __drizzle_migrations (hash, created_at) select 'forged' || i, 9000000000000 + i from n`);
    db.close();
    const ro = new Database(path, { readonly: true });
    expect(readMigrationRows(ro, LEVELS + 1)).toHaveLength(LEVELS + 1);
    ro.close();
    const before = process.memoryUsage().rss;
    let peak = before;
    const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
    const err = await expectRefusal(path, 'newer');
    clearInterval(timer);
    expect(err.message).toMatch(/newer Critical Notes/);
    expect(peak - before, 'RSS growth while judging 1.5 million forged rows').toBeLessThan(120 * 1024 * 1024);
    // all rows forged from the first one: a different history
    const other = dbAtLevel(LEVELS, 'many2.sqlite');
    const d2 = new Database(other);
    d2.exec(`update __drizzle_migrations set hash = 'x'`);
    d2.close();
    await expectRefusal(other, 'different');
  });

  it('refuses a database whose __drizzle_migrations is not the table drizzle creates', async () => {
    const path = dbAtLevel(LEVELS, 'view.sqlite');
    const db = new Database(path);
    db.exec(`alter table __drizzle_migrations rename to real_rows; create view __drizzle_migrations as select hash, created_at from real_rows`);
    db.close();
    await expectRefusal(path, ['invalid', 'schema']);
    const t = dbAtLevel(LEVELS, 'tbl.sqlite');
    const d = new Database(t);
    d.exec(`drop table __drizzle_migrations; create table __drizzle_migrations (hash text, created_at numeric, extra text)`);
    d.close();
    await expectRefusal(t, 'invalid');
  });

  it('refuses a backup from a newer level with its own code, and accepts an older one', async () => {
    const path = dbAtLevel(LEVELS, 'newer.sqlite');
    const db = new Database(path);
    db.exec(`insert into __drizzle_migrations (hash, created_at) values ('beef', 9999999999999)`);
    db.close();
    const err = await expectRefusal(path, 'newer');
    expect(err.message).toMatch(/newer Critical Notes/);
    expect((await prepareRestoredDatabase(dbAtLevel(2, 'older.sqlite'), { now: NOW })).migratedSteps).toBe(LEVELS - 2);
  });

  it('compareMigrationRows covers same, older, newer and different', () => {
    const j = loadJournal();
    const rows = j.map((e) => ({ hash: e.hash, created_at: e.when }));
    expect(compareMigrationRows(rows)).toEqual({ kind: 'same', steps: 0 });
    expect(compareMigrationRows(rows.slice(0, 3))).toEqual({ kind: 'older', steps: LEVELS - 3 });
    expect(compareMigrationRows([...rows, { hash: 'x', created_at: 1 }]).kind).toBe('newer');
    expect(compareMigrationRows([{ ...(rows[0] as object), hash: 'y' } as never, ...rows.slice(1)]).kind).toBe('different');
    expect(compareMigrationRows([rows[0] as never, rows[2] as never]).kind).toBe('different');
    expect(compareMigrationRows([]).kind).toBe('different');
  });

  it('tells an inconsistent index and broken foreign keys apart from a database that cannot be read at all', async () => {
    const idx = dbAtLevel(LEVELS, 'idx.sqlite');
    const a = new Database(idx);
    a.exec(`insert into users (id, username, display_name, password_hash) values ('u7', 'zzqq-integrity-1', 'Z', 'h')`);
    a.close();
    const file = readFileSync(idx);
    const at = file.indexOf('zzqq-integrity-1');
    file.write('zzqq-integrity-2', at); // the table's copy; the unique index still holds -1
    writeFileSync(idx, file);
    expect((await expectRefusal(idx, 'integrity')).message).toMatch(/damaged/);

    const fk = dbAtLevel(LEVELS, 'fk.sqlite');
    const b = new Database(fk);
    b.pragma('foreign_keys = OFF');
    b.exec(`insert into pages (id, campaign_id, sort_key, title) values ('orphan', 'no-such-campaign', 'a', 'T')`);
    b.close();
    expect((await expectRefusal(fk, 'integrity')).message).toMatch(/foreign key/);
  });

  it('leaves the staged file in rollback-journal mode (no -wal/-shm now or on the first start), whatever mode the backup header said', async () => {
    const path = dbAtLevel(LEVELS, 'wal.sqlite');
    const w = new Database(path);
    w.pragma('journal_mode = WAL');
    w.close();
    const header = (p: string) => readFileSync(p).subarray(18, 20);
    expect([...header(path)]).toEqual([2, 2]); // the header says WAL
    await prepareRestoredDatabase(path, { now: NOW });
    expect([...header(path)]).toEqual([1, 1]);
    expect(readdirSync(work).filter((n) => n.startsWith('wal.sqlite-'))).toEqual([]);
  });

  it('refuses a damaged database and a file that is not a database', async () => {
    const good = dbAtLevel(LEVELS, 'dmg.sqlite');
    const db = new Database(good);
    const ins = db.prepare('insert into pages (id, campaign_id, sort_key, title, body) values (?, ?, ?, ?, ?)');
    db.exec(`insert into campaigns (id, name, ruleset) values ('c1', 'C', '2014')`);
    db.transaction(() => {
      for (let i = 0; i < 400; i++) ins.run(`p${i}`, 'c1', `a${i}`, `T${i}`, JSON.stringify({ t: noise(400).toString('hex') }));
    })();
    db.close();
    const bytes = readFileSync(good);
    for (let i = 4096 * 3; i < bytes.length - 4096; i += 997) bytes[i] = (bytes[i] as number) ^ 0xff;
    writeFileSync(good, bytes);
    await expectRefusal(good, ['integrity', 'invalid']);
    writeFileSync(join(work, 'junk.sqlite'), 'this is not a database file at all');
    await expectRefusal(join(work, 'junk.sqlite'), 'invalid');
  });
});

describe('restore building blocks: carry-over of live restrictions (design 8.1)', () => {
  /** Staged = the backup; live = what the instance looks like now, with changes made after the backup. */
  let pairs = 0;
  function pair(liveChanges: string) {
    const n = ++pairs;
    const staged = join(work, `staged${n}.sqlite`);
    const live = join(work, `live${n}.sqlite`);
    const seed = openAppDb(staged);
    seed.$client.exec(`
      insert into users (id, username, display_name, password_hash, is_admin) values ('u1', 'gm', 'GM', 'h', 1), ('u2', 'alice', 'A', 'h', 0), ('u3', 'bob', 'B', 'h', 0), ('u4', 'carol', 'C', 'h', 1);
      insert into campaigns (id, name, ruleset) values ('c1', 'C', '2014');
      insert into api_tokens (id, user_id, name, token_hash, scope) values ('t1', 'u2', 'a', 'h1', 'read'), ('t2', 'u2', 'b', 'h2', 'read');
      insert into campaign_invites (id, campaign_id, token_hash, role) values ('i1', 'c1', 'ih1', 'player');
    `);
    seed.$client.pragma('journal_mode = DELETE');
    seed.$client.close();
    cpSync(staged, live);
    const l = new Database(live);
    l.exec(liveChanges);
    l.close();
    return { staged, live };
  }

  const LIVE_EDITS = `
    update users set disabled_at = 1750000000000 where id = 'u2';
    update users set is_admin = 0 where id = 'u4';
    delete from users where id = 'u3';
    insert into users (id, username, display_name, password_hash) values ('u5', 'dave', 'D', 'h');
    update api_tokens set revoked_at = 1750000000000 where id = 't1';
    update campaign_invites set revoked_at = 1750000000000 where id = 'i1';
    insert into api_tokens (id, user_id, name, token_hash, scope) values ('t9', 'u1', 'new', 'h9', 'read');
  `;

  it('applies live restrictions to the staged copy and reports what it only noticed', async () => {
    const { staged, live } = pair(LIVE_EDITS);
    const liveDb = new Database(live, { readonly: true });
    const report = await prepareRestoredDatabase(staged, { live: liveDb, keepTokens: true, now: NOW });
    liveDb.close();
    const db = new Database(staged, { readonly: true });
    expect(db.prepare('select disabled_at from users where id = ?').get('u2')).toEqual({ disabled_at: 1750000000000 });
    expect(db.prepare('select revoked_at from api_tokens where id = ?').get('t1')).toEqual({ revoked_at: 1750000000000 }); // revoked live stays revoked under --keep-tokens
    expect(db.prepare('select revoked_at from api_tokens where id = ?').get('t2')).toEqual({ revoked_at: null });
    expect(db.prepare('select revoked_at from campaign_invites where id = ?').get('i1')).toEqual({ revoked_at: 1750000000000 });
    expect(db.prepare('select is_admin from users where id = ?').get('u4')).toEqual({ is_admin: 1 }); // reported, never applied
    expect(db.prepare('select count(*) as n from users where id in (?, ?)').get('u3', 'u5')).toEqual({ n: 1 }); // u3 is back, u5 is not there
    db.close();
    expect(report.carry).toMatchObject({
      liveCompared: true,
      disabledCarried: ['alice'],
      tokensRevokedCarried: 1,
      invitesRevokedCarried: 1,
      adminsDemotedOrDeletedLive: ['carol'],
      usersDeletedLive: ['bob'],
      usersLostFromBackup: ['dave'],
      tokensCreatedLiveLost: 1,
    });
  });

  it('--no-carry-restrictions skips the carry-over', async () => {
    const { staged, live } = pair(LIVE_EDITS);
    const liveDb = new Database(live, { readonly: true });
    const report = await prepareRestoredDatabase(staged, { live: liveDb, keepTokens: true, carryRestrictions: false, now: NOW });
    liveDb.close();
    const db = new Database(staged, { readonly: true });
    expect(db.prepare('select disabled_at from users where id = ?').get('u2')).toEqual({ disabled_at: null });
    expect(report.carry.liveCompared).toBe(false);
    db.close();
  });

  it('an unreadable, absent or too-old live database yields liveCompared false and applies nothing', async () => {
    const a = pair('');
    expect((await prepareRestoredDatabase(a.staged, { live: null, now: NOW })).carry.liveCompared).toBe(false);
    const old = dbAtLevel(LEVELS - 2, 'oldlive.sqlite'); // lacks users.disabled_at (added by 0006)
    const oldDb = new Database(old, { readonly: true });
    const b = pair('');
    const report = await prepareRestoredDatabase(b.staged, { live: oldDb, now: NOW });
    oldDb.close();
    expect(report.carry).toMatchObject({ liveCompared: false, disabledCarried: [] });
    const junk = join(work, 'junk-live.sqlite');
    writeFileSync(junk, 'x'.repeat(5000));
    const c = pair('');
    const staged = new Database(c.staged);
    const junkDb = new Database(junk);
    expect(carryOverRestrictions(staged, junkDb).liveCompared).toBe(false);
    staged.close();
    junkDb.close();
  });

  it('carryOverRestrictions on its own never touches rows that need no change', () => {
    const { staged, live } = pair('');
    const s = new Database(staged);
    const l = new Database(live, { readonly: true });
    const before = JSON.stringify(s.prepare('select * from users order by id').all());
    expect(carryOverRestrictions(s, l)).toMatchObject({ liveCompared: true, disabledCarried: [], tokensRevokedCarried: 0, usersDeletedLive: [] });
    expect(JSON.stringify(s.prepare('select * from users order by id').all())).toBe(before);
    s.close();
    l.close();
  });
});

describe('probeStopped (design 7.1)', () => {
  it('refuses while another process holds the database, succeeds after kill -9, and is exclusive while held', async () => {
    const path = env.config.appDbPath;
    env.db.$client.close();
    const sqlitePath = createRequire(import.meta.url).resolve('better-sqlite3');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const D = require(process.argv[1]); const db = new D(process.argv[2]); db.pragma('journal_mode = WAL');
         db.exec("insert into users (id, username, display_name, password_hash) values ('held', 'held', 'H', 'h')");
         console.log('ready'); setInterval(() => {}, 1000);`,
        sqlitePath,
        path,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
      expect(() => probeStopped(path)).toThrow(ServerRunningError);
      expect(() => probeStopped(path)).toThrow(/stop it first/);
    } finally {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
    const probe = probeStopped(path);
    expect(probe).not.toBeNull();
    expect(probe?.ino).toBeGreaterThan(0);
    // the stale WAL of the killed process was recovered, and the probe reads the live data
    expect(probe?.db.prepare('select count(*) as n from users where id = ?').get('held')).toEqual({ n: 1 });
    // while the probe is held nobody else gets in
    const other = new Database(path, { timeout: 100 });
    expect(() => other.prepare('select count(*) from users').get()).toThrow(/locked|busy/i);
    other.close();
    probe?.db.close();
  }, 30_000);

  it('returns null when there is no database (a wiped instance)', () => {
    expect(probeStopped(join(work, 'nothing.sqlite'))).toBeNull();
  });
});

describe('restore building blocks: report fields are plain data', () => {
  it('PrepareReport has no secrets (no hashes of passwords, no tokens)', async () => {
    const path = dbAtLevel(LEVELS, 'plain.sqlite');
    const report: PrepareReport = await prepareRestoredDatabase(path, { now: NOW });
    expect(JSON.stringify(report)).not.toMatch(/password_hash|passwordHash|token_hash|tokenHash/);
  });
});
