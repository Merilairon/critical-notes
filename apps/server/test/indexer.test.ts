import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeEditionLists } from '@cn/fivetools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { miniFiles } from '../../../packages/fivetools/test/fixtures/mini';
import { openIndexDb, type IndexDb } from '../src/reference/index-db';
import { runIndexer } from '../src/reference/indexer';

const lists = makeEditionLists({ classic: ['TST', 'OLD'], modern: [], legacy: ['OLD'] });

let root: string;
let src: string;
let db: IndexDb;

function writeData(path: string, json: unknown) {
  const abs = join(src, 'data', path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(json));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cn-indexer-'));
  src = join(root, '5etools-src');
  for (const f of miniFiles) writeData(f.path, f.json);
  mkdirSync(join(src, 'js'), { recursive: true });
  writeFileSync(join(src, 'js', 'parser.js'), 'Parser.SRC_TST = "TST";\nParser.SOURCE_JSON_TO_FULL[Parser.SRC_TST] = "Test Handbook";\n');
  writeFileSync(join(src, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  db = openIndexDb(join(root, 'index.sqlite'));
});

afterAll(() => {
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

const run = (force = false) => runIndexer({ srcPath: src, db, editionLists: lists, force });
const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;

describe('reference indexer', () => {
  it('builds the index from scratch', async () => {
    const report = await run();
    expect(report.status).toBe('rebuilt');
    expect(report.inserted).toBe(report.entities);
    expect(report.dataVersion).toBe('9.9.9');
    expect(count("SELECT count(*) n FROM entity WHERE kind = 'monster'")).toBeGreaterThan(3);
    const src = db.prepare("SELECT edition, edition_reason, name FROM source WHERE id = 'xtst'").get();
    expect(src).toMatchObject({ edition: 'one', edition_reason: 'date', name: 'Test Handbook (2024)' }); // from books.json date
    expect(db.prepare("SELECT edition FROM source WHERE id = 'tst'").get()).toMatchObject({ edition: 'classic' });
  });

  it('stores derived columns: edition, reprint groups, images, summary', () => {
    const phb = db.prepare("SELECT * FROM entity WHERE uid = 'spell:spark burst|tst'").get() as Record<string, unknown>;
    const x = db.prepare("SELECT * FROM entity WHERE uid = 'spell:spark burst|xtst'").get() as Record<string, unknown>;
    expect(phb.edition).toBe('classic');
    expect(x.edition).toBe('one');
    expect(phb.reprint_group).toBe(x.reprint_group);
    expect(x.reprint_generation).toBe(1);
    expect(JSON.parse(String(phb.reprinted_as))).toEqual(['spell:spark burst|xtst']);
    const g = db.prepare("SELECT image_path, token_path, summary FROM entity WHERE uid = 'monster:gloomling|tst'").get() as { image_path: string; token_path: string; summary: string };
    expect(g.image_path).toBe('bestiary/TST/Gloomling.webp');
    expect(g.token_path).toBe('bestiary/tokens/TST/Gloomling.webp');
    expect(JSON.parse(g.summary)).toMatchObject({ cr: '1/4' });
  });

  it('supports full-text search with prefixes', () => {
    const hits = db
      .prepare("SELECT e.uid FROM entity_fts f JOIN entity e ON e.id = f.rowid WHERE entity_fts MATCH ? ORDER BY bm25(entity_fts)")
      .all('gloom*') as { uid: string }[];
    expect(hits.map((h) => h.uid)).toContain('monster:gloomling|tst');
    const textHits = db.prepare("SELECT e.uid FROM entity_fts f JOIN entity e ON e.id = f.rowid WHERE entity_fts MATCH ?").all('text:burst') as { uid: string }[];
    expect(textHits.map((h) => h.uid)).toContain('spell:spark burst|tst');
  });

  it('is a no-op when nothing changed', async () => {
    const report = await run();
    expect(report.status).toBe('up-to-date');
    expect(report.durationMs).toBeLessThan(1000);
  });

  it('only touches file state when mtime changes but content does not', async () => {
    const abs = join(src, 'data', 'spells', 'spells-tst.json');
    const future = new Date(Date.now() + 60_000);
    utimesSync(abs, future, future);
    expect((await run()).status).toBe('touched');
    expect((await run()).status).toBe('up-to-date');
  });

  it('updates only changed entities when content changes, and keeps homebrew rows', async () => {
    db.prepare(
      `INSERT INTO entity (uid, kind, prop, identity, name, name_lower, source, source_json, edition, summary, data, origin, homebrew_entity_id, hash)
       VALUES ('monster:brewling|mybrew', 'monster', 'monster', 'brewling|mybrew', 'Brewling', 'brewling', 'mybrew', 'MyBrew', 'any', '{}', '{}', 'homebrew', 'hb1', 'x')`,
    ).run();
    const file = miniFiles.find((f) => f.path === 'spells/spells-tst.json')!;
    const json = structuredClone(file.json) as { spell: Record<string, unknown>[] };
    json.spell[0]!.level = 4;
    json.spell.pop(); // remove "Ancient Ward"
    writeData('spells/spells-tst.json', json);
    const report = await run();
    expect(report.status).toBe('rebuilt');
    expect(report.changedFiles).toEqual(['spells/spells-tst.json']);
    expect(report.updated).toBe(1);
    expect(report.inserted).toBe(0);
    expect(report.deleted).toBe(1);
    expect(JSON.parse((db.prepare("SELECT summary FROM entity WHERE uid = 'spell:spark burst|tst'").get() as { summary: string }).summary).level).toBe(4);
    expect(count("SELECT count(*) n FROM entity WHERE uid = 'spell:ancient ward|old'")).toBe(0);
    expect(count("SELECT count(*) n FROM entity WHERE origin = 'homebrew'")).toBe(1);
    expect(count("SELECT count(*) n FROM entity_fts WHERE entity_fts MATCH 'ancient'")).toBe(0);
  });

  it('survives unreadable files', async () => {
    writeFileSync(join(src, 'data', 'broken.json'), '{ not json');
    const report = await run();
    expect(report.status).toBe('rebuilt');
    expect(report.warnings.some((w) => w.includes('broken.json'))).toBe(true);
  });
});
