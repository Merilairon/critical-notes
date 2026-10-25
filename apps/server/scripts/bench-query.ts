/**
 * Query performance benchmark (task I2.3): POST /api/campaigns/:id/query on a throwaway campaign of 2,000 pages.
 *
 *   pnpm --filter @cn/server bench:query [--pages 2000] [--runs 200] [--cold-runs 7] [--profile-only] [--keep]
 *
 * `--profile-only` seeds and prints only the stage profile (no latency tables, no history phase, no cold runs). The doc's numbers
 * come from `--runs 60 --cold-runs 5`.
 *
 * Not part of the gate (`pnpm test` only runs `test/**\/*.test.ts`). Everything lives in a temp directory made by the test
 * fixture (a synthetic mini 5etools dataset and a fresh app database); `var/` and `5etools-data/` are never read or written.
 *
 * What it does:
 *  1. Seeds a campaign through the normal HTTP path (POST /pages, PATCH /pages): typed facets, tags, custom properties, a body of
 *     about 8.7 KB per page, a player who owns one character. Then measures (phase "created").
 *  2. Adds three more edits per page with `HISTORY_COALESCE_MINUTES=0` (so every edit is a revision row, N1.2) and measures again
 *     (phase "history"), to see whether page history changes query time.
 *  3. Cold numbers: one fresh process per sample (internal `--cold <root> ...` child mode; `--cold-runs` sets the samples), first query after opening the database.
 *  4. A stage profile that times the pieces of the in-memory query on the same data.
 *
 * Requests go through `app.request` (the whole Hono stack, session lookup and validation, no TCP), so the numbers are server
 * time without network.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { runQuery, queryFilterSchema } from '@cn/blocks';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openAppDb } from '../src/db';
import { campaignMembers, users } from '../src/db/schema';
import { hashPassword } from '../src/lib/password';
import { openIndexDb } from '../src/reference/index-db';
import { createFixture, TestClient } from '../test/helpers';

const argv = process.argv.slice(2);
const arg = (name: string, dflt: number) => (argv.includes(name) ? Number(argv[argv.indexOf(name) + 1]) : dflt);
const PAGES = arg('--pages', 2000);
const RUNS = arg('--runs', 200);
const COLD_RUNS = arg('--cold-runs', 7);
const WARMUP = 20;
const DM_PW = 'correct horse battery';
const PLAYER_PW = 'another horse battery';

// region scenarios

interface Scenario {
  name: string;
  /** Takes the ids the seeding produced (`ctx` is a location with many children). */
  body: (ids: { ctx: string; tag: string }) => { filter: Record<string, unknown>; contextPageId?: string };
}

const SCENARIOS: Scenario[] = [
  { name: 'list: all pages, title sort, limit 100 (block default)', body: () => ({ filter: {} }) },
  { name: 'list: all pages, title sort, limit 500', body: () => ({ filter: { limit: 500 } }) },
  {
    name: 'table: npcs, 6 columns worth of data, sort prop.cr desc, limit 500',
    body: () => ({ filter: { types: ['npc'], sort: { field: 'prop.cr', dir: 'desc' }, limit: 500 } }),
  },
  { name: 'sort on a select prop (prop.threat_level), npcs, limit 100', body: () => ({ filter: { types: ['npc'], sort: { field: 'prop.threat_level', dir: 'asc' } } }) },
  { name: 'sort on a page-link facet (facet.factionPageId), npcs, limit 100', body: () => ({ filter: { types: ['npc'], sort: { field: 'facet.factionPageId', dir: 'asc' } } }) },
  { name: 'sort on tags, all pages, limit 100', body: () => ({ filter: { sort: { field: 'tags', dir: 'asc' } } }) },
  {
    name: 'filter: npc + tag + 4 where-conditions, sort updatedAt desc',
    body: ({ tag }) => ({
      filter: {
        types: ['npc'],
        tags: [tag],
        where: [
          { field: 'facet.status', op: 'eq', value: 'alive' },
          { field: 'prop.cr', op: 'gt', value: 2 },
          { field: 'title', op: 'contains', value: 'a' },
          { field: 'prop.traits', op: 'notEmpty' },
        ],
        sort: { field: 'updatedAt', dir: 'desc' },
      },
    }),
  },
  {
    name: 'contextual: npcs located at the current page (facet.locationPageId = $ctx)',
    body: ({ ctx }) => ({
      filter: { types: ['npc'], where: [{ field: 'facet.locationPageId', op: 'eq', value: { $ctx: 'currentPage' } }] },
      contextPageId: ctx,
    }),
  },
];

// endregion

const SEED = 20260101;
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = 'the old tower stands above a quiet harbor where merchants whisper of a hidden vault beneath cracked flagstones and the guard captain never sleeps while smugglers bargain with robed strangers about silver lanterns forgotten oaths and the long road north'.split(' ');

function makeBody(rand: () => number, edit: number) {
  const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)]!;
  const sentence = () => Array.from({ length: 12 + Math.floor(rand() * 14) }, () => pick(WORDS)).join(' ') + '.';
  const para = (n = 3) => ({ type: 'paragraph', content: [{ type: 'text', text: Array.from({ length: n }, sentence).join(' ') + ` (v${edit})` }] });
  const blocks: unknown[] = [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Overview' }] }];
  for (let i = 0; i < 8; i++) blocks.push(para(2 + Math.floor(rand() * 3)));
  blocks.push({ type: 'bulletList', content: Array.from({ length: 5 }, () => ({ type: 'listItem', content: [para(1)] })) });
  blocks.push({ type: 'secret', content: [para(2)] });
  blocks.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Notes' }] });
  for (let i = 0; i < 4; i++) blocks.push(para(3));
  return { type: 'doc', content: blocks };
}

function pct(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}
const fmt = (n: number) => n.toFixed(1);

/** Sets up the app on an existing fixture root (used by the cold child too). */
async function openApp(root: string) {
  const dataDir = join(root, 'var');
  const config = loadConfig({
    fivetoolsSrcPath: join(root, '5etools-src'),
    fivetoolsImgPath: join(root, '5etools-img'),
    dataDir,
    appDbPath: join(dataDir, 'app.sqlite'),
    indexDbPath: join(dataDir, 'index.sqlite'),
    uploadsDir: join(dataDir, 'uploads'),
  });
  const indexDb = openIndexDb(config.indexDbPath);
  const db = openAppDb(config.appDbPath);
  const created = createApp({ config, indexDb, db });
  return { ...created, config, db, indexDb };
}

async function login(app: ReturnType<typeof createApp>['app'], username: string, password: string) {
  const c = new TestClient(app);
  const r = await c.post('/api/auth/login', { username, password });
  if (r.status !== 200) throw new Error(`login ${username} failed`);
  return c;
}

// region cold child: `--cold <root> <campaignId> <scenario> <role> <ctx> <tag>` prints the first query time

async function coldChild() {
  const i = argv.indexOf('--cold');
  const [root, campaignId, scenarioIdx, role, ctx, tag] = argv.slice(i + 1) as [string, string, string, string, string, string];
  const { app } = await openApp(root);
  const client = role === 'dm' ? await login(app, 'dm', DM_PW) : await login(app, 'eve', PLAYER_PW);
  const payload = JSON.stringify(SCENARIOS[Number(scenarioIdx)]!.body({ ctx, tag }));
  const t0 = performance.now();
  const res = await app.request(`http://localhost/api/campaigns/${campaignId}/query`, {
    method: 'POST',
    headers: { origin: 'http://localhost', host: 'localhost', cookie: client.cookie, 'content-type': 'application/json' },
    body: payload,
  });
  const text = await res.text();
  console.log(JSON.stringify({ ms: performance.now() - t0, status: res.status, bytes: text.length }));
  process.exit(0);
}

// endregion

async function main() {
  const fx = await createFixture();
  const root = fx.root;
  try {
    // The fixture's db handle is replaced by the app below; seeding uses the same file the cold children open.
    fx.config.history.coalesceMinutes = 0; // every edit is a revision row (N1.2), no folding
    const { app, services } = createApp({ config: fx.config, indexDb: fx.indexDb, db: fx.db });
    const dm = new TestClient(app);
    const setup = await dm.post('/api/auth/setup', { username: 'dm', displayName: 'The DM', password: DM_PW });
    if (setup.status !== 201) throw new Error('setup failed');
    fx.db.insert(users).values({ id: 'u-eve', username: 'eve', displayName: 'Eve', passwordHash: await hashPassword(PLAYER_PW), isAdmin: false }).run();
    const eve = await login(app, 'eve', PLAYER_PW);

    const campaignId: string = (await dm.post('/api/campaigns', { name: 'Bench', ruleset: '2014' })).body.id;
    fx.db.insert(campaignMembers).values({ campaignId, userId: 'u-eve', role: 'player' }).run();
    const base = `/api/campaigns/${campaignId}`;
    const must = async (p: Promise<{ status: number; body: unknown }>) => {
      const r = await p;
      if (r.status >= 300) throw new Error(`seed request failed ${r.status}: ${JSON.stringify(r.body)}`);
      return r.body as { id: string; revision: number; key?: string };
    };

    // Custom properties of a typical campaign
    const prop = (label: string, type: string, extra: Record<string, unknown> = {}) => must(dm.post(`${base}/properties`, { label, type, ...extra }));
    await prop('Threat Level', 'select', { options: ['low', 'medium', 'high', 'deadly'] });
    await prop('CR', 'number');
    await prop('Last seen', 'date');
    await prop('Ally', 'pageLink');
    await prop('Traits', 'multiselect', { options: ['brave', 'cunning', 'greedy', 'loyal', 'pious', 'secretive'] });
    await prop('Secret agenda', 'text', { dmOnly: true });

    const rand = rng(SEED);
    const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)]!;
    const TAGS = Array.from({ length: 40 }, (_, i) => `tag${i}`);
    const someTags = () => Array.from(new Set(Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(TAGS))));
    const visibility = () => (rand() < 0.6 ? 'all' : 'dm');
    const seeded: { id: string; revision: number; type: string }[] = [];
    const t0 = performance.now();
    const create = async (type: string, title: string, extra: Record<string, unknown> = {}) => {
      const page = await must(dm.post(`${base}/pages`, { type, title, visibility: visibility(), tags: someTags(), body: makeBody(rand, 1), ...extra }));
      seeded.push({ id: page.id, revision: page.revision, type });
      return page.id;
    };

    // Mix: 2% factions, 6% locations (a tree), 40% npcs, 15% quests, 3% sessions, 1% pcs, 33% lore/items/generic
    const nFaction = Math.round(PAGES * 0.02);
    const nLoc = Math.round(PAGES * 0.06);
    const nNpc = Math.round(PAGES * 0.4);
    const nQuest = Math.round(PAGES * 0.15);
    const nSession = Math.round(PAGES * 0.03);
    const nPc = Math.max(4, Math.round(PAGES * 0.01));
    const factions: string[] = [];
    const locations: string[] = [];
    const npcs: string[] = [];
    for (let i = 0; i < nFaction; i++) factions.push(await create('faction', `Faction ${i} ${pick(WORDS)}`, { facet: { status: 'active', attitude: pick(['ally', 'neutral', 'hostile']) } }));
    for (let i = 0; i < nLoc; i++) {
      const parent = i > 5 ? pick(locations) : null;
      locations.push(await create('location', `Location ${i} ${pick(WORDS)}`, { parentId: parent, facet: { kind: pick(['region', 'settlement', 'site']), parentLocationPageId: parent } }));
    }
    for (let i = 0; i < nNpc; i++) {
      // The first hub location has most of the npcs, as in a campaign with one home town
      const loc = rand() < 0.2 ? locations[0]! : pick(locations);
      npcs.push(
        await create('npc', `Npc ${i} ${pick(WORDS)}`, {
          facet: { role: pick(['smith', 'guard', 'priest', 'spy']), status: pick(['alive', 'alive', 'dead', 'missing']), attitude: pick(['friendly', 'neutral', 'hostile']), factionPageId: pick(factions), locationPageId: loc },
          props: {
            threat_level: pick(['low', 'medium', 'high', 'deadly']),
            cr: Math.floor(rand() * 20),
            last_seen: `2026-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}`,
            ally: pick(npcs.length ? npcs : factions),
            traits: Array.from(new Set([pick(['brave', 'cunning', 'greedy']), pick(['loyal', 'pious', 'secretive'])])),
            secret_agenda: 'plots',
          },
        }),
      );
    }
    for (let i = 0; i < nQuest; i++) await create('quest', `Quest ${i} ${pick(WORDS)}`, { facet: { status: pick(['rumor', 'active', 'completed']), priority: pick(['low', 'normal', 'high']), giverPageId: pick(npcs) }, props: { threat_level: pick(['low', 'high']), cr: Math.floor(rand() * 10) } });
    for (let i = 0; i < nSession; i++) await create('session', `Session ${i}`, { facet: { number: i + 1, status: 'played' } });
    const pcs: string[] = [];
    for (let i = 0; i < nPc; i++) pcs.push(await create('pc', `Hero ${i}`, { visibility: 'all', facet: { playerName: `P${i}`, ac: 14, hpMax: 30 } }));
    await must(dm.patch(`${base}/pages/${pcs[0]}`, { revision: seeded.find((s) => s.id === pcs[0])!.revision, facet: { playerUserId: 'u-eve' } }));
    seeded.find((s) => s.id === pcs[0])!.revision++;
    const rest = PAGES - seeded.length;
    for (let i = 0; i < rest; i++) await create(pick(['lore', 'generic', 'item', 'handout']), `Note ${i} ${pick(WORDS)}`, { props: { threat_level: pick(['low', 'medium']) } });
    const seedCreateMs = performance.now() - t0;
    const ids = { ctx: locations[0]!, tag: TAGS[0]! };

    const sqlite = new Database(fx.config.appDbPath, { readonly: true });
    const stat = (phase: string) => {
      const q = (s: string) => (sqlite.prepare(s).get() as Record<string, number>);
      const revs = q('select count(*) n from page_revisions').n;
      const bodyBytes = q(`select sum(length(body)) n from pages where campaign_id = '${campaignId}'`).n;
      const revBytes = q('select sum(length(body)) n from page_revisions').n;
      const live = q(`select count(*) n from pages where campaign_id = '${campaignId}' and deleted_at is null`).n;
      return { phase, pages: live, revisionRows: revs, pageBodyBytes: bodyBytes, revisionBodyBytes: revBytes };
    };

    const results: Record<string, unknown>[] = [];
    const sizes: Record<string, unknown>[] = [];

    async function measure(phase: string) {
      const dbStat = stat(phase);
      fx.db.$client.pragma('wal_checkpoint(TRUNCATE)');
      const dbFile = statSync(fx.config.appDbPath).size;
      sizes.push({ ...dbStat, dbFileBytes: dbFile });
      for (const role of ['dm', 'player'] as const) {
        const client = role === 'dm' ? dm : eve;
        for (const sc of SCENARIOS) {
          const payload = JSON.stringify(sc.body(ids));
          const once = async () => {
            const c0 = process.cpuUsage();
            const t = performance.now();
            const res = await app.request(`http://localhost${base}/query`, { method: 'POST', headers: { origin: 'http://localhost', host: 'localhost', cookie: client.cookie, 'content-type': 'application/json' }, body: payload });
            const text = await res.text();
            const cu = process.cpuUsage(c0);
            return { ms: performance.now() - t, cpu: (cu.user + cu.system) / 1000, bytes: text.length, rows: (JSON.parse(text) as { rows: unknown[] }).rows.length };
          };
          let last = await once();
          for (let i = 1; i < WARMUP; i++) last = await once();
          const times: number[] = [];
          const cpus_: number[] = [];
          for (let i = 0; i < RUNS; i++) {
            last = await once();
            times.push(last.ms);
            cpus_.push(last.cpu);
          }
          times.sort((a, b) => a - b);
          cpus_.sort((a, b) => a - b);
          results.push({ phase, role, scenario: sc.name, p50: pct(times, 50), p95: pct(times, 95), max: times[times.length - 1], cpuP50: pct(cpus_, 50), cpuP95: pct(cpus_, 95), rows: last.rows, jsonBytes: last.bytes });
          console.log(`${phase.padEnd(8)} ${role.padEnd(6)} p50 ${fmt(pct(times, 50)).padStart(6)}  p95 ${fmt(pct(times, 95)).padStart(6)}  cpu50 ${fmt(pct(cpus_, 50)).padStart(6)}  rows ${String(last.rows).padStart(3)}  ${(last.bytes / 1024).toFixed(0).padStart(4)} KB  ${sc.name}`);
        }
      }
    }

    console.log(`Seeded ${seeded.length} pages in ${(seedCreateMs / 1000).toFixed(1)} s (${fmt(seedCreateMs / seeded.length)} ms/page through the HTTP path)`);
    const PROFILE_ONLY = argv.includes('--profile-only');
    if (!PROFILE_ONLY) await measure('created');

    // Phase 2: three more edits per page, each a revision row
    const t1 = performance.now();
    for (let round = 2; round <= 4 && !PROFILE_ONLY; round++) {
      for (const s of seeded) {
        const r = await must(dm.patch(`${base}/pages/${s.id}`, { revision: s.revision, body: makeBody(rand, round), tags: someTags() }));
        s.revision = (r as unknown as { revision: number }).revision;
      }
    }
    const seedEditMs = performance.now() - t1;
    console.log(`Edited every page 3 more times in ${(seedEditMs / 1000).toFixed(1)} s (${fmt(seedEditMs / (seeded.length * 3))} ms/edit)`);
    if (!PROFILE_ONLY) await measure('history');

    // Stage profile (DM path, whole campaign), warm
    const pg = services.pages as unknown as { livePages(c: string): unknown[]; queryable(c: string): { id: string }[] };
    const stages: Record<string, number[]> = {};
    const time = <T,>(name: string, fn: () => T): T => {
      const t = performance.now();
      const v = fn();
      (stages[name] ??= []).push(performance.now() - t);
      return v;
    };
    const dmViewer = { userId: 'x', gm: true } as never;
    const playerViewer = services.campaigns.viewer(campaignId, 'u-eve');
    const rawNoBody = sqlite.prepare(`select id, parent_id, sort_key, type, title, icon, visibility, updated_at from pages where campaign_id = ? and deleted_at is null order by sort_key`);
    const rawWithBody = sqlite.prepare(`select * from pages where campaign_id = ? and deleted_at is null order by sort_key`);
    const filter = queryFilterSchema.parse(SCENARIOS[2]!.body(ids).filter);
    for (let i = 0; i < 60; i++) {
      time('1 pages SQL via drizzle (select *, body JSON.parse)', () => pg.livePages(campaignId));
      time('1a raw SQL, with body column (no parse)', () => rawWithBody.all(campaignId));
      time('1b raw SQL, without body column', () => rawNoBody.all(campaignId));
      const rows = time('2 queryable() = pages + tags + facets + props joins', () => pg.queryable(campaignId));
      time(`2a   of which properties.valuesFor (${PAGES} ids)`,() => services.properties.valuesFor(campaignId, (rows as { id: string }[]).map((r) => r.id)));
      time('3 visiblePageIds (player)', () => services.visibility.visiblePageIds(campaignId, playerViewer));
      time(`4 runQuery filter+sort (table scenario, ${PAGES} rows in memory)`,() => runQuery(rows as never, filter, null));
      for (const [si, sc] of SCENARIOS.entries()) {
        const f = queryFilterSchema.parse(sc.body(ids).filter);
        time(`4.${si} runQuery only: ${sc.name}`, () => runQuery(rows as never, f, ids.ctx));
      }
      time('5 pages.queryFor DM total (scenario 3)', () => services.pages.queryFor(campaignId, dmViewer, SCENARIOS[2]!.body(ids).filter, null, new Set()));
      const vis = services.visibility.visiblePageIds(campaignId, playerViewer);
      time('6 pages.queryFor player total (scenario 3)', () => services.pages.queryFor(campaignId, playerViewer, SCENARIOS[2]!.body(ids).filter, null, vis));
      const out = services.pages.queryFor(campaignId, dmViewer, SCENARIOS[2]!.body(ids).filter, null, new Set());
      time('7 JSON.stringify of the response (500 rows)', () => JSON.stringify({ rows: out }));
    }
    const stageOut = Object.entries(stages).map(([k, v]) => {
      v.sort((a, b) => a - b);
      return { stage: k, p50: pct(v, 50), p95: pct(v, 95) };
    });
    for (const s of stageOut) console.log(`stage ${fmt(s.p50).padStart(6)} / ${fmt(s.p95).padStart(6)}  ${s.stage}`);

    // Cold: fresh process, first query after opening the database. The file stays in the OS page cache (we cannot drop it).
    sqlite.close();
    fx.db.$client.pragma('wal_checkpoint(TRUNCATE)');
    const cold: Record<string, unknown>[] = [];
    const here = fileURLToPath(import.meta.url);
    for (const role of PROFILE_ONLY ? [] : ['dm', 'player']) {
      for (let si = 0; si < SCENARIOS.length; si++) {
        const ms: number[] = [];
        for (let r = 0; r < COLD_RUNS; r++) {
          const out = spawnSync(process.execPath, ['--import', 'tsx', here, '--cold', root, campaignId, String(si), role, ids.ctx, ids.tag], { encoding: 'utf8', cwd: join(here, '..', '..') });
          const line = out.stdout.trim().split('\n').pop() ?? '';
          try {
            ms.push((JSON.parse(line) as { ms: number }).ms);
          } catch {
            throw new Error(`cold child failed: ${out.stderr || out.stdout}`);
          }
        }
        ms.sort((a, b) => a - b);
        cold.push({ role, scenario: SCENARIOS[si]!.name, p50: pct(ms, 50), max: ms[ms.length - 1] });
        console.log(`cold     ${role.padEnd(6)} p50 ${fmt(pct(ms, 50)).padStart(6)}  max ${fmt(ms[ms.length - 1]!).padStart(6)}  ${SCENARIOS[si]!.name}`);
      }
    }

    const summary = {
      node: process.version,
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      pages: PAGES,
      runs: RUNS,
      coldRuns: COLD_RUNS,
      seed: { createMs: seedCreateMs, editMs: seedEditMs },
      sizes,
      results,
      stages: stageOut,
      cold,
    };
    console.log('\nJSON_SUMMARY ' + JSON.stringify(summary));
  } finally {
    if (argv.includes('--keep')) console.log(`kept ${root}`);
    else {
      fx.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  }
}

if (argv.includes('--cold')) await coldChild();
else await main();
