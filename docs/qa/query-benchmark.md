# Query performance benchmark (task I2.3)

Budget: a query block on a 2,000-page campaign answers in **under 300 ms on the server** (PLAN deviation (d): the DSL runs in memory over the campaign's live pages).

**Verdict: PASS.** Every scenario is between 105 and 205 ms at p50 and under 220 ms at p95 (cold first request: at most 250 ms), as DM and as player. The margin is thin for what the code does, though: about 100 ms of every request is fixed cost that does not depend on the query, mostly parsing page bodies the query never uses. Follow-ups I2.4 to I2.7 below remove it; they are cheap and should be scheduled before campaigns grow past roughly 4,000 pages or bodies past 25 KB.

## Method

Script: `apps/server/scripts/bench-query.ts`, usage `pnpm --filter @cn/server bench:query [--pages 2000] [--runs 200] [--cold-runs 7] [--profile-only] [--keep]` (those are the defaults). The numbers below were produced with `pnpm --filter @cn/server bench:query --runs 60 --cold-runs 5`; `--profile-only` seeds and prints only the stage profile. It is not part of the gate (`pnpm test` only includes `test/**/*.test.ts`; typecheck covers the script). It uses the test fixture's throwaway temp directory (synthetic mini 5etools data, fresh app database) and deletes it at the end; `var/` and `5etools-data/` are never touched.

1. **Seeding through the normal path**: `POST /properties`, `POST /pages`, `PATCH /pages` over the Hono app (so sanitising, indexing, tags, facets, property values and N1.2 revision rows all run). Fixed random seed. Campaign: 2,000 pages = 40 factions, 120 locations (tree, one hub town with about 20% of the NPCs), 800 NPCs, 300 quests, 60 sessions, 20 PCs, the rest lore/generic/item/handout. 60% shared with players, 40% DM-only. 40 tags, 1 to 4 per page. Facets per type (status, attitude, faction and location page links ...). Six custom properties: `threat_level` (select), `cr` (number), `last_seen` (date), `ally` (pageLink), `traits` (multiselect), `secret_agenda` (text, DM-only). Each body is about 8.7 KB of TipTap JSON (headings, 12 paragraphs, a list, a secret block), 17.5 MB of bodies in total. One player owns one PC.
2. **Phase "created"**: measure. **Phase "history"**: every page edited 3 more times with `HISTORY_COALESCE_MINUTES=0` (every edit is a revision row), then measure again.
3. **Warm**: 20 warm-up requests, then 60 timed per scenario and role. Each request is `app.request` (the full Hono stack: session, validation, visibility, query, JSON), without TCP. Wall time and process CPU time are recorded.
4. **Cold**: a fresh Node process per sample (5 per scenario and role): open the databases, create the app, log in, then time the first query. The OS file cache stays warm (cannot be dropped without root), so this is "cold process and JIT", not "cold disk".
5. **Stage profile** (60 iterations): the pieces of the query timed on the same data.

The query block's columns (a "table" with 6 columns) are a client-side view setting: the server returns the same row shape (summary, facet, props, tags) whatever the columns. The "table" scenario therefore uses the server work a table needs: NPCs, sorted on a prop, `limit` 500.

## Hardware and run conditions

Intel Core i7-11700KF @ 3.60 GHz (16 threads), Linux 7.3 (CachyOS), Node v24.15.0, better-sqlite3 13, SQLite app database on local disk. The machine was shared with other agents: load average was 27 at the start of the run reported here and 12 at its end. An earlier run at load 25 to 29 gave p50 120 to 550 ms and p95 up to 1.6 s for the same code, so treat tails on a busy host as noise; the numbers below are the quieter run. CPU time per request is within 5% of wall time at p50.

## Results (2,000 pages, ms, warm; p50 / p95)

| Scenario | rows, JSON (DM) | DM created | DM history | Player created | Player history |
|---|---|---|---|---|---|
| list: all pages, title sort, limit 100 (block default) | 100, 36 KB | 122 / 144 | 117 / 125 | 116 / 127 | 116 / 127 |
| list: all pages, limit 500 | 500, 154 KB | 118 / 126 | 117 / 129 | 117 / 132 | 117 / 129 |
| table: NPCs, sort prop.cr desc, limit 500 | 500, 301 KB | 110 / 130 | 108 / 115 | 111 / 117 | 117 / 129 |
| sort on select prop (prop.threat_level), NPCs | 100, 60 KB | 136 / 168 | 127 / 137 | 122 / 130 | 130 / 141 |
| sort on page-link facet (factionPageId), NPCs | 100, 60 KB | 136 / 151 | 136 / 149 | 120 / 132 | 125 / 141 |
| sort on tags, all pages | 100, 40 KB | **201 / 217** | **202 / 214** | 164 / 177 | 172 / 184 |
| filter: NPC + tag + 4 where-conditions | 8, 5 KB | 106 / 115 | 106 / 118 | 110 / 116 | 113 / 119 |
| contextual: NPCs at the current page (`$ctx`) | 100, 60 KB | 107 / 117 | 109 / 117 | 111 / 129 | 113 / 127 |

Players receive fewer rows (only pages shared with them: 478 of 800 NPCs), so their payloads are smaller.

**Cold first request (p50 / max of 5 processes, ms):** DM 152 to 193 (tags sort 248 / 252); player 156 to 221 (tags sort 221 / 233). Cold costs about 50 ms more than warm.

**Sizes.** Database file 41 MB after seeding, 98 MB after the extra history (8,001 revision rows, 70 MB of revision bodies vs 17.5 MB of page bodies). Per request the DB read is every live page row including its body: 17.5 MB (about 8.7 KB x 2,000) plus the tag, facet and property rows. The response JSON is 1 to 301 KB.

**Does seeding or history affect query time? No.** The query never reads `page_revisions`. Created vs history phases differ by at most 10 ms, inside run-to-run noise. The file grows 2.4x, which only matters for backup size and page-cache pressure. Seeding cost, for the record: 6.6 ms per page create and 7.7 ms per edit through HTTP, including the revision row.

## Where the time goes (warm p50, DM or player alike)

| Stage | ms |
|---|---|
| `livePages()`: `select *` from `pages` through drizzle (reads and `JSON.parse`s every body) | 80 |
| same query as raw SQL, with the body column but no parse | 23 |
| same query as raw SQL, without the body column | 5 |
| `queryable()` in total (pages + tags + facets + property values + summaries) | 106 |
| of which `properties.valuesFor` | 10 |
| `visiblePageIds` (player only) | 4 |
| `runQuery`: numeric/date sort, filters | 0.2 to 1.5 |
| `runQuery`: title sort (default) | 9 to 10 |
| `runQuery`: sort on a select prop / on a page-link facet | 20 / 27 |
| `runQuery`: sort on `tags` | 85 |
| player projection (hidden props, facet projection, DTO) | about 3 |
| `JSON.stringify` of 500 rows | 1 |

Findings:

1. **Body JSON parsing is the main cost.** The query result never contains a body, yet `livePages()` selects whole rows, so each request reads about 17.5 MB and parses it into objects that are thrown away: 80 of the roughly 110 ms. Cost grows with total body bytes, not with the query. At about 4.6 ms per MB, the 300 ms budget is reached near 60 MB of bodies for the cheap scenarios: about 7,000 pages of this size, or 2,000 pages of 30 KB. That extrapolation holds only for the linear body-parse cost; a sort on tags (85 ms of sorting that grows faster than linearly) hits the budget earlier, at about 3,500 pages, until the sort follow-up (I2.5) lands. Hence "schedule before about 4,000 pages". `livePages()` is also used by `tree()` and at `pages.ts` around lines 454, 602 and 657, so the body parse is paid there too.
2. **String sorts are slow because `localeCompare` is called with an options object**, which builds a collator per call: title sort 10 ms, `tags` sort 85 ms (the array is turned into a string on every comparison, with `fieldValue` called twice per comparison). Sorting on a page-link facet orders by the target's id, which is also not what a reader expects (a title would be).
3. The player projection is cheap: the same work on fewer rows plus a few ms.
4. Filtering is not a cost at this size.

## Follow-up tasks (not done here: the verdict is PASS and the fixes touch query behaviour)

- **Task I2.4: Page reads do not load bodies.** Owner: Backend Architect, QA: Performance Benchmarker. Fix at `livePages()` itself (select the summary columns, not `body`), since `tree()` and `pages.ts` around lines 454, 602 and 657 use it too; check each of those callers does not need the body (give any that does its own body read). Expected: about 75 ms less per query request (110 to 35 ms). Acceptance: `bench:query` shows every scenario under 80 ms p50; existing query, tree and visibility tests pass.
- **Task I2.5: Cheaper sorting.** Owner: Backend Architect. One shared `Intl.Collator` with `{ numeric: true, sensitivity: 'base' }` in `packages/blocks/src/query.ts` and decorate-sort-undecorate (compute each page's sort key once before sorting). Do not lowercase tags for the key (the collator already ignores case; lowercasing would change the order of accented tags). Expected: tags sort from 85 ms to under 10 ms, title sort from 10 ms to about 2 ms. No change in order.
- **Task I2.6: Sort page-link columns by the target's title.** Owner: Backend Architect, decision: Product Manager (behaviour change: today a page-link facet or prop sorts by the target's id, which looks random). Needs a title map in `runQuery`. Do after I2.5.
- **Task I2.7 (only if campaigns exceed about 5,000 pages): cache `queryable()` per campaign**, invalidated by page writes (the event bus already announces them), or compile the filter to SQL (the original deviation (d) idea, with the Postgres work). Note SQLite's bound-variable limit of 32,766 per statement: `queryable()` runs `inArray(..., ids)` for tags, facets and property values, so a campaign above that many pages fails outright, before any speed problem; chunk the id lists (or join on `campaign_id`) as part of this task. Do not build before I2.4 and I2.5 are measured.
- Client side: rendering 500 rows (301 KB) in the table view and the browser's own sort are not measured here. If the table feels slow, check it in the browser with a seeded campaign (`bench:query --keep` leaves the data folder).

## Limits of this measurement

In-process requests (no network, TLS or reverse proxy); one client at a time. Queries are synchronous and block the Node event loop for their whole duration, so concurrent users add up: ten simultaneous table blocks cost about a second of loop time today, which I2.4 would cut to a few hundred ms. A blocked event loop also delays every other request on that process (saves, live updates, health checks), not only queries. A page with N query blocks multiplies it: each block adds about 110 ms of loop time today. Synthetic text bodies of one size; one machine; OS file cache warm in the cold samples; no `selected`-visibility viewer rows for the player.
