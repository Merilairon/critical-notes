/**
 * Task N1.2, acceptance item of docs/design/page-history.md 5.1b: a history-heavy database (60 pages x 100 near-identical 10 KB
 * revisions, built through `PageService.update` with folding off, so it has the real row shape) must survive its own backup:
 * create succeeds, verify and `restore --check` pass, the full restore brings back `page_revisions` row for row. The measured
 * ratio is logged so a regression of `DB_RATIO_LIMIT` is visible.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { DB_RATIO_LIMIT, readBackup } from '../src/services/backup-zip';
import { PageService } from '../src/services/pages';
import { PropertyService } from '../src/services/properties';
import { makeEnv } from './backup-helpers';
import { runCli, stopServer } from './restore-helpers';

const WORDS = ['the', 'door', 'opens', 'onto', 'a', 'cellar', 'where', 'goblin', 'sleeps', 'under', 'torchlight', 'and', 'dust', 'of', 'old', 'bones', 'while', 'rain', 'falls', 'on', 'tavern', 'roof'];
// One 10 KB passage shared by every page: successive revisions (and sibling pages) are near-identical, the shape that deflates best
const FILLER = Array.from({ length: 1700 }, (_, i) => WORDS[(i * 7 + (i >> 3)) % WORDS.length]).join(' ');
const PAGES = 60;
const REVISIONS = 100;
const work = mkdtempSync(join(tmpdir(), 'cn-hist-bk-'));
const env = makeEnv();
afterAll(() => {
  env.cleanup();
  rmSync(work, { recursive: true, force: true });
});

describe('a history-heavy database and its backup', () => {
  it('backs up, verifies, checks and restores 60 pages x 100 near-identical 10 KB revisions row for row', async () => {
    // The indexer is not the subject here
    const indexer = { update() {}, remove() {}, backlinks: () => [] };
    const pages = new PageService(env.db, new PropertyService(env.db), indexer as never, { coalesceMinutes: 0 });
    const ctx = { userId: 'u1', source: 'web', cause: 'edit' } as const;
    const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    for (let p = 0; p < PAGES; p++) {
      // 10 KB of prose-like text per page (a small vocabulary compresses within the page too), the same in every revision of it
      const filler = FILLER;
      const id = pages.create('c1', 'u1', { type: 'generic', title: `Page ${p}`, parentId: null, visibility: 'dm', tags: [], body: { type: 'doc', content: [para(filler)] } }, { ...ctx, cause: 'create' }).id;
      for (let r = 1; r < REVISIONS; r++) {
        pages.update('c1', id, { revision: r, body: { type: 'doc', content: [para(filler), para(`edit ${r}`)] } }, ctx);
      }
    }
    const count = env.db.$client.prepare('select count(*) as n, sum(bytes) as b from page_revisions').get() as { n: number; b: number };
    expect(count.n).toBe(PAGES * REVISIONS);
    const before = env.db.$client.prepare('select * from page_revisions order by page_id, revision').all();

    const made = await env.service({ opsLog: false }).create({ actor: 'test', trigger: 'cli' }); // includes its own verify pass
    const zip = join(env.config.backupDir, made.name);
    const dbBytes = statSync(env.config.appDbPath).size;
    const ratio = dbBytes / statSync(zip).size;
    console.log(`history-heavy backup: ${(dbBytes / 1e6).toFixed(1)} MB database, ${(statSync(zip).size / 1e6).toFixed(1)} MB zip, ratio ${ratio.toFixed(1)}:1, ${count.n} revisions (${(count.b / 1e6).toFixed(1)} MB of snapshots), DB_RATIO_LIMIT ${DB_RATIO_LIMIT}`);
    // Above the old 50:1 limit (so reverting DB_RATIO_LIMIT to 50 fails this test) and under the current one
    expect(ratio).toBeGreaterThan(50);
    expect(ratio).toBeLessThan(DB_RATIO_LIMIT);

    await readBackup(zip); // the verify pass of restore
    stopServer(env);
    const check = await runCli(['restore', zip, '--check'], env.config);
    expect(check.code, check.out + check.err).toBe(0);

    const restored = await runCli(['restore', zip, '--yes'], env.config);
    expect(restored.code, restored.out + restored.err).toBe(0);
    const db = new Database(env.config.appDbPath, { readonly: true });
    try {
      expect(db.prepare('select * from page_revisions order by page_id, revision').all()).toEqual(before);
    } finally {
      db.close();
    }
  }, 300_000);
});
