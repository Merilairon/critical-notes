# Page history: design (Task N1.1)

**Status: approved 2026-10-23 (owner decisions Q1, Q2 and Q4 in section 12; coalescing window 2 minutes), revised after QA round 1 (Database Reliability Engineer).** Author: Software Architect. QA: Database Reliability Engineer. Design only; nothing here is implemented. Reference: PRD §9 N1, `docs/PROJECT.md` §6.2 (tasks N1.2 to N1.6) and §4 (rules). Every rule of §4 applies to N1.2 to N1.6, in particular rule 2 (players never receive DM content, sentinel crawl) and rule 4 (both schemas).

## 1. Problem and constraints

A GM (or an AI assistant acting as the GM) overwrites a page: a bad paste, a template re-sync that rewrites 200 pages, an assistant that "improved" a session note. Today the only protection is the 30-day trash, which covers deletion, not overwriting. N1 keeps earlier versions of a page so a GM can see who changed what, compare two versions and restore one. Assistants must be able to undo their own edit (N1.5).

What the code gives us (read for this design):

- **One choke point.** Every content write of a page goes through `PageService.update` (`apps/server/src/services/pages.ts`): the web PATCH (`routes/campaigns.ts`), `updateAsPlayer` (which calls `update`), the MCP tools (they call the same REST routes in-process through `mcp/api.ts`), template page creation and apply (`services/templates.ts` lines ~590, ~628), template propagation to linked blocks (`templates.ts` ~684), edition migration (`services/migration.ts` ~191), the copy-statblock route and campaign import (`campaign-transfer.ts` ~356). `create` is the other entry. Nothing writes `pages.body` any other way (`move`, `remove`, `restore`, the `fromTemplateId` stamps touch metadata only).
- **A page "version" is spread over four places:** `pages` (title, type, body, icon, cover, visibility), the facet table of its type ("details"), `page_property_values` ("properties"), and tags/viewers. `pages.revision` is an integer bumped on every `update` and used for optimistic concurrency (409).
- **Autosave is chatty.** The editor saves 700 ms after the last keystroke (`SAVE_DELAY` in `apps/web/src/app/campaign/page-editor.ts`). "One row per save" would mean hundreds of full-body rows per hour of typing. This drives the storage design (section 4).
- **The database is SQLite, single writer** (better-sqlite3, synchronous transactions); Postgres exists as a schema and migration set only, mirrored and checked by `test/pg-parity.test.ts`. The latest migrations are `drizzle/0006_accounts.sql` and `drizzle-pg/0002_accounts.sql`.
- **Existing precedent:** `homebrew_revisions` (full `data` plus an RFC 6902 `diff`, `rev_no` unique per entity) and `template_versions` (full definition per version). Both store full snapshots.

## 2. Options considered

| Option | Gives | Costs | Verdict |
|--------|-------|-------|---------|
| **A. Full snapshot per revision** in a new `page_revisions` table, with coalescing of rapid saves and time-based pruning | Restore and compare are a single-row read; pruning is a plain `DELETE` (no chain to repair); same shape as `template_versions`; trivial in both dialects | Bytes grow with page size times revision count (bounded by coalescing and pruning, section 4) | **Chosen** |
| B. Reverse diffs / keyframes (like git packs or `homebrew_revisions.diff`) | Smallest storage | Restore replays a chain; pruning must rewrite neighbours; a corrupt link breaks everything older; the diff library must understand block documents; big complexity for a table that is bounded anyway | Rejected: complexity not justified by the size estimate |
| C. Event log of editor operations | Fine-grained undo, would help N10 co-editing | The editor sends whole documents, not operations; large new surface | Rejected; revisit with N10 |
| D. Store only `body` | Smallest rows | Restoring a type change or an AI props edit would be wrong or impossible; spec lists title, details, properties | Rejected |

Trade-off named for A: we pay disk (full copies) to buy simple, safe restore and prune. If measured growth disappoints, the escape hatch is deduplicating `body` by content hash (section 4.4), which needs no change to the API.

## 3. The table

A revision is the state of the page **after** a write (so the newest row always equals the live page and the list reads as "versions"). Page `create` writes revision 1.

### 3.1 Columns

| Column | Type (SQLite / Postgres) | Notes |
|--------|--------------------------|-------|
| `page_id` | text, FK `pages.id` ON DELETE CASCADE | Purge of a page deletes its history (section 8). |
| `revision` | integer | Equals `pages.revision` after the write. Primary key with `page_id`. Not necessarily contiguous (coalescing). |
| `campaign_id` | text, FK `campaigns.id` ON DELETE CASCADE | Denormalised for the access check and for cheap campaign-scoped queries without a join. |
| `title` | text not null | |
| `type` | text not null | Needed: details only make sense with their page type. |
| `body` | json / jsonb, nullable | The stored document **including DM-only and secret blocks** (the full stored form, never a projection). Null only if the page body was null. |
| `details` | json / jsonb, nullable | The facet row without `page_id` (what `facetOf` returns). Null for types without a facet. |
| `properties` | json / jsonb not null default `{}` | `{ [propertyKey]: value }` (by key, as `valuesFor` returns), including DM-only properties. By key, not def id, so it is readable after a def is deleted. |
| `author_user_id` | text null, FK `users.id` ON DELETE SET NULL | The account the write ran as. For an MCP call this is the token's owner. |
| `source` | text not null | `web` \| `player` \| `mcp`, plus `system` for the lazy baseline row only (section 3.3). |
| `token_id` | text null | The `api_tokens.id` when `source = 'mcp'`. **No foreign key:** tokens are revoked, and cascade-deleted with their user; history must survive and still say "via AI assistant". The token's current name is looked up at read time (`left join`); a missing row shows as "deleted token". |
| `cause` | text not null | Why the row exists: `create` \| `edit` \| `restore` \| `template_sync` \| `template_apply` \| `edition_migration` \| `import` \| `tracker` \| `baseline` (section 3.4). `RevisionCause` is this exact union (N1.2 adds `tracker`); a `tracker` row is treated like any non-`edit` cause: never folded into or from (4.2), thinned like every other row, and protected only if it is the newest or oldest row of its page. The UI label and the pruning protections use it. |
| `restored_from` | integer null | For `cause = 'restore'`: the revision number whose content was restored. |
| `content_hash` | text not null | sha256 of `stableStringify({title,type,body,details,properties})` (exact input in section 4.5), computed in the application, **not** in SQL (Postgres `jsonb` reorders keys, SQLite does not). Used to skip no-op saves, to decide the baseline (3.4) and for the optional dedupe later. |
| `bytes` | integer not null | UTF-8 length of the serialised `body + details + properties + title`. For growth monitoring and the list. |
| `created_at` | integer (SQLite) / bigint (Postgres), epoch ms, default as the other tables | Time of the **first** save folded into this row (section 4.1). |

Drizzle shape (SQLite; the Postgres mirror uses `pgTable`, `jsonb` and `bigint` per the existing type mapping that `pg-parity.test.ts` enforces: `*_at` columns are `bigint`, JSON is `jsonb`):

```ts
export const pageRevisions = sqliteTable(
  'page_revisions',
  {
    pageId: text('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    campaignId: text('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    type: text('type').notNull(),
    body: text('body', { mode: 'json' }),
    details: text('details', { mode: 'json' }),
    properties: text('properties', { mode: 'json' }).notNull(),
    authorUserId: text('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** web | player | mcp | system (system: the baseline row only) */
    source: text('source').notNull(),
    tokenId: text('token_id'),
    /** create | edit | restore | template_sync | template_apply | edition_migration | import | tracker | baseline */
    cause: text('cause').notNull(),
    restoredFrom: integer('restored_from'),
    contentHash: text('content_hash').notNull(),
    bytes: integer('bytes').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.revision] }), index('page_revisions_created').on(t.createdAt)],
);
```

Indexes: the primary key serves "history of one page, newest first" (descending scan) and "latest revision of a page". `page_revisions_created` serves one query only: the pruner's clock guard `max(created_at)` (5.2); the pruning scan itself reads every row and partitions by page, so the index does not help it. There is **no `campaign_id` index**: no query filters by campaign (access is checked through the page), and the cascade from `campaigns` reaches the rows through `pages`. (The `campaign_id` column stays, for the cheap access check without a join and for a future per-campaign size figure; drop it if the Backend Architect prefers; nothing else depends on it.)

Deliberately **not** stored: visibility, viewers, parent, sort key, tags, icon, cover. See restore (section 7): a restore never changes who can see a page.

### 3.2 Who wrote it: the write context

`PageService.update`, `updateAsPlayer`, `create` and `restoreRevision` take a required `WriteContext` argument (required so the compiler finds every call site; no silent "unknown author" default):

```ts
interface WriteContext {
  userId: string;
  source: 'web' | 'player' | 'mcp';
  tokenId?: string;          // set iff source === 'mcp'
  cause: RevisionCause;
}
```

Built from the request by one helper `writeContext(c, cause)` in the routes layer: if `c.get('tokenScope')` is set the source is `mcp` and `tokenId` is read from a new context variable; otherwise `player` when the player branch of the PATCH route ran, else `web`. Nothing trusts a client-supplied source.

Plumbing change for N1.2: `InternalAuth` (`auth/session.ts`) gains `tokenId`; `mcp/route.ts` already has `verified.tokenId` and passes it as `clientId`, and `mcp/server.ts` builds the `InternalAuth` from `authInfo`, so it carries `extra.tokenId` through; the session middleware does `c.set('tokenId', ...)` next to `tokenScope`. The `AppEnv` type gets the variable.

### 3.3 The `source` values

- `web`: a person in the browser (GM edits any page).
- `player`: a player editing their own character through `updateAsPlayer`.
- `mcp`: an AI assistant through a token, whatever the token owner's role. **A player's token editing the player's own character is recorded as `mcp`**; the role of the author is not stored (it is re-derivable from membership if ever needed). This keeps the three values the task specifies and is what the "via AI assistant" label wants.
- `system`: used only by the lazy baseline row (3.4), `author_user_id` null, labelled "before history was recorded" in the UI. Never written by a request.
- Server-initiated writes (template sync, edition migration, tracker HP sync) are `cause` values with the source of the request that triggered them (almost always `web`; `mcp` if an assistant edited the template). They are attributed to the acting GM, never to `system`.

### 3.4 Baseline: the state before the first recorded write

Backfilling every live page in the migration would need a join over seven facet tables plus property values in SQL, in two dialects, over a database that may be large. Instead a **baseline** row is written lazily, by this rule, which does not depend on "the page has no rows":

1. **At the start of the `update` transaction, before any write**, read the pre-write state of the page (page row, facet row, property values) with the transaction handle and compute its `content_hash` (4.5). This is the *pre-state*.
2. After the writes, read the post-state the same way and compute its hash.
3. If the post-state hash equals the pre-state hash (a visibility-, tags-, viewers-only save, or a no-op): record nothing.
4. Otherwise, if the page's newest `page_revisions` row is **missing or its hash differs from the pre-state hash**, first insert a baseline row built from the pre-state (`cause = 'baseline'`, `source = 'system'`, `author_user_id = null`, `revision` = the pre-write `pages.revision`, `created_at = pages.updated_at`), then the row for the new state. **Collision rule:** the baseline's `revision` is the pre-write `pages.revision`, but a writer that changed content without bumping `revision` (or an older restored backup) can leave an existing row with that same `(page_id, revision)` and a different hash; the primary key would then make every update of the page fail. So the baseline is inserted with `on conflict do nothing`; if it did not insert, it is numbered below the page's lowest stored revision (`min(revision) - 1`, going negative if needed; `revision` is a plain integer and negatives sort before every real one). The new-state row is written with `on conflict do update` (the stale row with that number is replaced). An update must never fail because of history. Test (N1.2): plant a row with the pre-write revision and a different hash, update the page: the update succeeds and both states are in history.

Why compare hashes rather than "no rows": the same rule also covers a page whose recorded history is out of step with the live page for any reason: a database restored from an older backup into a newer build, a write that bypassed `PageService` (the review rule in section 11), a transaction that rolled back, or a page that was last edited by a build without this feature. History is then never silently missing the state that was overwritten. Cost: one extra insert when it applies, none in the normal case. A page never edited has no history and the panel says "No earlier versions".

`recordRevision(tx, ...)` therefore is **not** "the last statement" alone: the pre-state read is the first statement of the transaction, the post-state read and the inserts are the last ones. The `tx` handle is passed explicitly to every read and write of the helper (never `this.db`; with better-sqlite3 both are the same connection, but with Postgres at run time `this.db` would be outside the transaction).

## 4. Writes: same transaction, coalescing, no-ops

### 4.1 Where the write points are

All of them funnel through one private helper inside `PageService`, `recordRevision(tx, pageId, ctx, preState)`: the pre-state is read at the **start** of the existing `this.db.transaction(...)` and the helper runs at its **end** (3.4), in:

| Write point | Today | Change for N1.2 |
|-------------|-------|-----------------|
| `PageService.create` | transaction inserts page, facet, tags; props set inside the transaction | add `recordRevision` (`revision` 1, cause from ctx: `create` / `import`); no baseline (there is no pre-state) |
| `PageService.update` | transaction updates page, facet, tags, viewers. **`properties.setValues` runs before the transaction, outside it** | **move `setValues` inside the transaction** (as `create` already does) so props, page and revision commit or roll back together; then `recordRevision` reads the final state back with the transaction handle and stores it. Today a failure inside the transaction leaves props changed with no page change; that is an existing inconsistency N1.2 must fix, because a revision that does not match the page is worse than none |
| `updateAsPlayer` | merges, calls `update` | no own write; passes `ctx.source = 'player'`. The revision stores the **merged stored document** returned from the update path, never `input.body` (section 6) |
| Template propagation (`templates.ts` ~684), template apply and create-from-template (~590, ~628) | each calls `pages.update` per page | automatic through `update`; pass `cause = template_sync` / `template_apply` and the acting user's context (the `TemplateService` methods receive `userId` already; the request source is passed down) |
| Edition migration (`migration.ts` ~191) | one `pages.update` per page, **not** in a single transaction with the ruleset flip | each page's revision commits with that page (`cause = edition_migration`; the service has the acting `userId` but no request, so the route passes a `WriteContext` down, like the importer and the template service). Not made atomic with the campaign row: out of scope, stated so nobody assumes that restoring a page body undoes the edition change (it does not; `campaigns.ruleset` is not page content) |
| Campaign import (`campaign-transfer.ts` ~356) | `create` (bare page), then `ps.update(..., { revision: 1, body, facet, props, cover })` | **Two rows per page unless changed** (see 4.6): N1.2 makes `create` accept body, facet, props and cover so import writes one row, `cause = import`. The `userId` is the importer; there is no request context in the service, so the route passes it down |
| statblock copy route (`routes/campaigns.ts` ~381) | `pages.update` | automatic, `cause = edit` |
| **Tracker HP sync** (`services/trackers.ts` `syncPartyHp`, ~154, runs when combat ends) | `pages.update(campaignId, c.ref, { revision, facet: { hpCurrent } })` for every PC combatant, with no user or source | **Recorded, `cause = 'tracker'`**, author = the GM who ended the combat, source `web` (the route `POST .../trackers/:id/...` has `uid(c)`; `TrackerService.apply` gains a `WriteContext` parameter and passes it to `syncPartyHp`). One row per PC per combat. These rows are never folded into an edit and never folded into each other; they are the cheapest rows (a hit-point change), cost one full copy each (about 10 KB x party size per combat). Kept in the 30-day window and thinned like the rest; if the owner finds them noisy the UI can hide `cause = tracker` by default (open question 10). Not coalesced because folding HP into the body edit run would make "undo my edit" also undo hit points |

Not recorded, on purpose: `move` (tree position), `remove`/`restore` from trash (rows stay with the page), `fromTemplateId` stamps, `relinkStatblock` (updates the statblock pointer in `npc_facets` after a homebrew rename; a derived pointer, not a user edit), and property definition changes. Listed as "known gaps" in the user-facing text of N1.4 only if the owner wants it.

### 4.2 Coalescing (required because of autosave)

Before inserting, `recordRevision` looks at the page's newest row. If **all** hold, it folds the new state into that row instead of adding one: same `author_user_id`, same `source`, same `token_id`, same `cause` in (`edit`), newest row's `created_at` within `HISTORY_COALESCE_MINUTES` (default 2) of now, and the newest row is not a `baseline`/`restore`/`create`. "Fold" = replace that row (delete + insert with the new `revision`, keep the **original** `created_at`, so a typing session is one entry starting when it began). MCP writes are never folded (each tool call is a deliberate act, and "undo my last assistant edit" needs it separate). Restores, template, migration and tracker rows are never folded into and never fold. The only exception is the same-operation fold of `create`/`import` rows in 4.6.

Folding is decided by comparing against the **newest row** only and the fold itself replaces the row (the earlier state of that run is lost). Effect: an hour of typing is about 30 rows at worst, not about 300. **Honest consequence:** the finest undo step is one run. If a GM pastes the wrong text at minute 2 of a run that started at minute 0, the revision that held the state at minute 1 is gone; the best surviving version is the one before the run started (or the previous run). A paste is the case coalescing hurts most. Consequence for the PRD and the task text ("keep all for 30 days"): **PRD N1 says "every save kept" and N1.1 says "keep all for 30 days"; this keeps one version per run of up to 2 minutes.** Raised as open question 1 and logged as a deviation in `docs/PLAN.md` (2026-10-23).

### 4.3 No-op saves

If `content_hash` equals the newest row's hash, nothing is written (the editor re-sends unchanged documents; `update` still bumps `pages.revision` as today, so the revision number may skip, and that is fine).

### 4.4 Optional later optimisation (not in 1.3)

A saved props-only change (very common for MCP and template apply) copies the whole body. If measurement shows this matters, move `body` to a `page_revision_bodies(hash, body)` table referenced by hash. It changes no API and no behaviour; the hash column is already there for it.

### 4.5 The hash: exact input

`content_hash = sha256(stableStringify(snapshot))` where `stableStringify` is the existing helper exported from `@cn/fivetools` (`packages/fivetools/src/util/object.ts`, sorted keys; the server already uses it in `reference/indexer.ts` and `homebrew/transfer.ts`; it is not re-implemented). `snapshot` is exactly:

```
{ title, type, body, details, properties }
```

- `body`: the **stored, sanitized** document read back from the row inside the transaction (after `sanitizeBody`), never `input.body`; `null` stays `null`.
- `details`: what `facetOf(type, id)` returns for the page, i.e. the facet row without `page_id`; **`null` when the type has no facet**. `facetOf` returns `FACET_SCHEMAS[...].parse({})` defaults when the facet row is missing; the same function and the same shape are used for the baseline (pre-state), the live comparison and a restored snapshot, so a defaulted facet and a stored default facet hash alike.
- `properties`: `valuesFor(...)` for the page, **always an object, `{}` when none, never absent or `null`**. `{}` and `null` are different inputs and `details: null` vs `details: {}` hash differently on purpose.
- `title`, `type`: the stored values.
- Not included: visibility, viewers, tags, parent, icon, cover, `updated_at`, `revision`.

Postgres and SQLite hash the same value because the input is built in the application from parsed rows, and `stableStringify` sorts keys; a test asserts the equal hash for the same page through both dialects (PGlite).

### 4.6 Two rows per operation (import, create from template)

Import and create-from-template both do `create` and then `update` in one operation (`templates.ts` ~590 sets props right after create). Without a rule that is two rows per page, the first an empty shell. Decision: **create-from-template is fixed at the source; import uses the operation fold, as an explicit exception.** Create-from-template: `PageService.create` accepts the final body, details, props and cover (`CreatePageInput` already carries body/facet/props; import adds `cover`), and template instantiation passes everything at once (`newId()` stays internal to `create`), so one row (`cause = create`) is written. **Import cannot do this:** `campaign-transfer.ts` (~345 to 365) creates every page first to obtain the new ids, then remaps links, uids and property keys in a second pass and updates each page. Pre-allocating ids and giving `create` an optional `id` would change the importer's two-pass structure for no gain, so import relies on the fold: **explicit exception to the 4.2 rule "never folded into `create`/`import` rows"**: a write whose `WriteContext` carries the same in-memory `operationId` (generated once per import / per template instantiation, never stored) as the newest row's creating call, with the same author and source, folds into that row regardless of the time window; the row keeps `cause = import` and the first `created_at`. Without an `operationId`, create/import rows are never folded into. The `fromTemplateId` stamp is metadata and writes no row. N1.2 tests: importing a campaign of N pages writes exactly N rows; creating from a template with props writes one row per created page.

## 5. Storage growth and pruning

### 5.1 Estimate

Stated assumptions (adjust with real data; the pruner is configurable): a page is stored as block JSON, typically 4 to 12 KB, session notes 20 to 50 KB; mean taken as **10 KB** per full revision (body + details + props + overhead).

| Scenario | Rows | Bytes |
|----------|------|-------|
| One typing session on one 20 KB page, **without** coalescing | ~300/h | ~6 MB/h (the case that rules out "row per save") |
| Same, with 2-minute coalescing | ~30/h | ~600 KB/h |
| A normal active campaign: ~15 pages touched per week, ~3 runs per page | ~45/week | ~450 KB/week; **~2 MB inside the 30-day window** |
| After thinning to one per page per day: 15 pages x 52 weeks | ~780 page-days/year | **~8 MB/year per active campaign** |
| **Daily MCP edit of 50 pages x 20 KB** (the dominant case) | 50/day | ~1 MB/day; ~30 MB in the 30-day window; **after thinning each page keeps one row per day it was edited, so ~365 MB per year** from this one habit |
| Template sync to 200 linked pages x 8 KB | 200 | ~1.6 MB per template edit (kept 30 days, then thinned) |
| Hobby instance: 10 active campaigns, 3 years, human edits only | | ~250 MB upper bound, typically 50 to 100 MB. **With the daily MCP habit above on one campaign: add ~1 GB over 3 years** |

Compared with today's data this is the same order as the pages themselves multiplied by roughly the number of kept versions.

**Size ceiling and tiers (feeds open question 2).** Daily thinning alone does not bound a heavy MCP user (above). Proposed bounds, all configurable: (a) after 365 days keep one row per page per **month** (default **on**, since the dominant case needs it); (b) a per-campaign **soft** ceiling `HISTORY_MAX_MB_PER_CAMPAIGN` (default 500). Size is computed once per daily pruner run as `select campaign_id, sum(bytes) from page_revisions group by campaign_id` (a full scan; acceptable once a day, and why no `campaign_id` index is needed). Over the ceiling, the pruner thins that campaign's oldest rows, oldest first, to the next tier (daily to monthly) until under it. It may thin rows only **older than the 30-day window**: the window is never touched by the ceiling, because "undo what I did this week" is the feature. If the protected rows (newest, oldest) plus the window alone exceed the ceiling, the pruner deletes nothing more and logs a warning with the campaign id and size; the ceiling is a goal, not a quota, and never blocks a save; (c) the row-level dedupe of 4.4 if props-only edits dominate. Pruning **frees pages inside the SQLite file but does not shrink it**: the file stays the size of its high-water mark until a `VACUUM` (not run automatically; it needs free disk of the same size and the exclusive lock). The admin guide says so; a size drop is not expected after pruning, only that growth stops.

### 5.1b Backups: the compression guard (measured by QA)

**Finding (QA, verified in `services/backup-zip.ts`):** the restore/verify reader aborts a `app.sqlite` entry that exceeds `DB_RATIO_LIMIT = 50` (line 46) after `DB_RATIO_AFTER = 4 MiB` (own `ratioAfter`, line 686). QA measured 60 pages x 100 near-identical 10 KB revisions (77 MB) deflating at **49.9:1**, i.e. a history-heavy database fails its own backup verification. My earlier claim ("JSON snapshots compress 4x to 8x, limits far away") was wrong for exactly this data: successive revisions of one page are nearly identical, and deflate's 32 KB window plus SQLite's page layout make ~50:1 reachable in the worst case. Per-page near-duplicate runs are the shape this feature creates.

**Decision (to be made before N1.2 starts; recommended here): rescale the database entry's ratio limit, do not rely on dedupe.**
- Raise `DB_RATIO_LIMIT` to **200** (the same as `RATIO_LIMIT` for every other entry) and keep `DB_RATIO_AFTER`. The guard's job is a hostile sparse file; what really bounds it is the manifest-declared `database.bytes` (a lying manifest can only lower the cap), the 4 GiB cap, and the "free space minus 64 MiB" check (`backup.md` §9.2, lines 262 to 264). Those do not change. **This is a gate: N1.2 does not merge the constant change without the Security Architect's written sign-off** (it is a small security-relevant constant); `backup.md` §9 and the ratio table are edited in the same task.
- Dedupe of bodies by hash (4.4) is **not** a fix: near-identical revisions have different hashes; it only helps byte-identical bodies (props-only edits).
- Alternative considered: lower history volume only. Rejected as the sole answer: a heavy-but-legitimate instance (the daily MCP case, ~1 GB of near-duplicate JSON) would still cross 50:1 with a fresh `VACUUM`ed file, and a backup that cannot be restored is the worst failure this feature could cause.

**N1.2 acceptance item (explicit):** a backup/restore test with a history-heavy database (at least 60 pages x 100 near-identical 10 KB revisions, built through `PageService.update` with coalescing off, so it tests the real row shape): `BackupService.create` succeeds, `verify` passes, `restore --check` passes, the full restore reproduces `page_revisions` row for row, and the measured ratio is logged in the test output so a regression of the constant is visible. Also a negative test that a hostile sparse `app.sqlite` of 4 GiB declared is still refused by the cap/free-space checks after the ratio change.

### 5.2 Pruning policy

Default: **keep every row for 30 days; older than that, keep the newest row of each page per UTC day; older than 365 days, per page per month** (tier (a) of 5.1; both boundaries configurable). Always protected (never pruned): the newest row of a page (the live version) and its oldest row (the origin: first `create`/`import`/`baseline`). Day buckets use `created_at`, which under coalescing is the time of the **first save of the run** (4.2), so a run that started at 23:50 is bucketed in the earlier day; harmless, stated so the prune oracle test uses the same rule.

**Selection** (window functions exist in SQLite 3.25+ and in Postgres; integer division is the same in both; the subquery is aliased because Postgres before 16 requires it; `created_at` is selected inside the subquery):

```sql
select t.page_id, t.revision
from (
  select page_id, revision, created_at,
         row_number() over (partition by page_id, created_at / 86400000 order by revision desc) as rn,
         revision = max(revision) over (partition by page_id) as is_newest,
         revision = min(revision) over (partition by page_id) as is_oldest
  from page_revisions
  where page_id in (:batchOfPageIds)
) as t
where t.created_at < :cutoff and t.rn > 1 and not t.is_newest and not t.is_oldest
```

The monthly tier is the same query with the divisor replaced by the month bucket computed in the application (`:monthBucket(created_at)` is not portable in SQL, so the monthly pass selects candidates older than 365 days by id in the application and groups them there; rows are few by then).

**Per-page cap** (`HISTORY_MAX_PER_PAGE`, default 200): for a page with more than 200 rows inside the 30-day window, the oldest rows beyond the 200 newest are thinned by the daily rule early:

```sql
-- candidates: rows of pages over the cap, ranked newest first
select t.page_id, t.revision from (
  select page_id, revision, created_at,
         row_number() over (partition by page_id order by revision desc) as pos,
         row_number() over (partition by page_id, created_at / 86400000 order by revision desc) as day_rn,
         revision = min(revision) over (partition by page_id) as is_oldest
  from page_revisions where page_id in (:batchOfPageIds)
) as t where t.pos > :cap and t.day_rn > 1 and not t.is_oldest
```

**Per batch re-check.** The job works page by page in batches of 50 pages. For each batch it opens one short transaction that (1) re-runs the selection for that batch **inside** the transaction, (2) deletes in chunks of 500 ids, and (3) commits. Because a save can land between batches, the delete statement re-states the predicates in its `where` (`not newest`: `revision < (select max(revision) from page_revisions r where r.page_id = page_revisions.page_id)`), so a row that became the newest, or whose page was purged, is never deleted on stale information.

**Cascade size.** A page purge removes `pages` rows in chunks of 500 (`purgeIds`), and with `ON DELETE CASCADE` each page also removes all its revisions: 500 pages x (say) 200 rows x 10 KB is a ~1 GB delete inside one writer transaction, which blocks every save. N1.2 changes `purgeIds` to **delete `page_revisions` for the chunk first, in sub-chunks of at most 1000 rows (a loop of short transactions, `delete ... where rowid in (select ... limit 1000)` in SQLite, `ctid`/primary-key batches in Postgres)**, then deletes the pages; the cascade then has nothing left to do. The purge chunk of pages is lowered from 500 to 100. If campaign deletion is ever added (today only archive exists), it must delete revisions in batches before the campaign row. **The two-step purge (revisions first, then pages) is not atomic and does not need to be:** the page is already in the trash (purge only accepts a deleted page), so a crash between the steps leaves a trashed page with fewer or no revisions, which the next purge or the 30-day purger finishes; nobody sees a half-purged page.

**Runner:** `HistoryPruner`, a copy of the `TrashPurger` pattern (`services/trash-purger.ts`): unref'd `setTimeout` chain, first run about a minute after start, then daily, **defers while a backup runs or a restore marker exists**, `stop()` on shutdown. It logs one line with counts (no content).

**Clock guard (corrected).** `TrashPurger`'s `CLOCK_MARGIN_MS` check only catches a clock that is *behind* recent activity. A clock set *forward* (a VM resumed with a wrong date, a bad NTP step) would make `cutoff = now - 30 days` land after everything and thin 30 days of intra-day versions at once, irreversibly. Therefore the cutoff is **bounded by recorded activity**: `reference = min(now, max(created_at over page_revisions) + CLOCK_MARGIN_MS)` and `cutoff = reference - keepAllDays`. A forward jump of weeks then moves the reference by at most the margin beyond the newest recorded save. (This is what `page_revisions_created` is for.) The monthly tier uses the same `reference`. A prune pass whose `now` is behind `max(created_at)` by more than the margin is skipped like in `TrashPurger`. Tests: clock +60 days deletes nothing beyond the normal result; clock -1 day skips.

Settings, validated like `BACKUP_KEEP` (invalid value: warn and use default): `HISTORY_KEEP_ALL_DAYS` (default 30), `HISTORY_COALESCE_MINUTES` (default 2; 0 turns coalescing off), `HISTORY_MAX_PER_PAGE` (default 200), `HISTORY_MAX_MB_PER_CAMPAIGN` (default 500), `HISTORY_MONTHLY_AFTER_DAYS` (default 365). A setting to turn history off entirely is **not** provided: a user who disables it and later needs it loses the safety net silently. Open question 3.

## 6. Who sees history, and the secret-leak risk

**GMs only: the DM and co-DMs (`viewer.gm`, `isGameMaster(role)`), checked on the server.** Players never see history, not even of their own character page; instance admins see it only if they are a GM of the campaign.

Why this is the highest-risk part of N1: a revision is a **full copy of the stored document including everything players must never receive**: DM-only blocks, secret blocks, DM-only facet fields (`FACET_DM_ONLY_FIELDS`), DM-only properties, and the title and text a page had before the DM toned it down or hid it. History also holds content **no longer present in the live page** (a spoiler that was deleted), so a projection bug here leaks things that today's sentinel crawl cannot see.

Controls (each becomes a test in N1.3 / N1.6, rule 2 of §4):

1. **Separate service, no shared projection path.** History lives in `PageHistoryService`. No history field is ever added to `PageDto`, `PageSummaryDto`, `toSummary`, `projectPage`, search results or backlinks. No "last edited by", "edit count" or "last revision at" for players (the existing `revision` integer in `PageDto` stays as is).
2. **Route guard first.** All three history routes call the GM check before touching the table; a non-GM gets the same status the other GM-only routes give (`requireDm`), and a player for a page they cannot see gets 404 as today. The Angular panel is hidden for players and `gmGuard` is not needed (no new route, a panel on the page), but the server does not depend on it.
3. **Snapshots come from the stored row, never the request.** `updateAsPlayer` receives the player's projected document and merges it with the hidden blocks (`mergePlayerEdit`). The revision is taken from the page row **after** the merge (read inside the transaction), so it contains the full merged document. It must never be built from `input.body`: that would store a revision without the DM's blocks, and a restore of it would delete them (the I1 data-loss class of bug). A test: player edit, then the GM's history shows the DM-only block in that revision.
4. **No other consumer reads the table.** Not the page indexer (`page_search`/FTS indexes the live page only), not backlinks, not the campaign export (section 9), not the player "preview as" mode, not the MCP read crawl for player tokens.
5. **Sentinel crawl extension** (`apps/server/test/visibility.test.ts`): seed `SENTINEL` into a DM-only block and a DM-only property of a visible page, save, then **edit again so the live page no longer contains the sentinel** (this proves history, not the live page, would be the leak). Crawl every player GET route and every MCP read tool with a player token, as today, and assert no response contains the sentinel. Add explicit assertions: a player gets 403/404 on `GET .../history`, `GET .../history/:rev` and `POST .../history/:rev/restore` for a visible page, a hidden page and their own PC page; a player's MCP token cannot reach them (the MCP allowlist in `mcp/api.ts` is extended in N1.5 for GM tokens only, and the REST check refuses a player). A co-DM can; a player demoted from co-DM cannot (checked per request, no caching).
6. **Logs and audit.** An audit line for each restore (`lib/audit.ts`): actor, page, from-revision, to-revision; never title or body.
7. **Restore must not widen exposure** (section 7): visibility and viewers are not restored.

## 7. Endpoints and restore (what N1.3 builds)

All under `/api/campaigns/:cid/pages/:pid`, GM only (section 6):

- `GET /history?before=<revision>&limit=50` returns rows newest first, **without** `body`/`details`/`properties`: `revision, createdAt, author { id, displayName } | null, source, tokenName | null, cause, restoredFrom, title, bytes`. UI label "via AI assistant" when `source = 'mcp'`.
- `GET /history/:rev` returns the full snapshot (`title, type, body, details, properties` plus the list fields). The client diffs two snapshots with `docText` (N1.4); the server computes no diff.
- `POST /history/:rev/restore` with body `{ revision: <current page revision> }`. The check is the existing optimistic one (409 with the current page when someone saved in between).

Restore semantics:

- **A restore is a normal update.** It goes through `PageService.update` with `cause = 'restore'`, `restored_from = :rev`, so validation, the transaction, reindexing, the new `pages.revision` and the new history row all behave as any edit. History is append-only: **restoring never deletes or rewrites later revisions**, so a restore can itself be undone.
- **What it restores:** title, type, body, details, properties. **What it does not:** visibility, viewers, parent, position, tags, icon, cover, **and any access-bearing field of `details`**. (Restoring a `visibility: all` from last month must never publish a page the GM has since hidden.) Open question 4.
- **Access-bearing facet fields stay at their live value.** The `pc` facet's `playerUserId` decides which player may see and edit the page (`VisibilityService.ownCharacterIds`, `services/visibility.ts`), and `removeMember` (`campaigns.ts` ~267) nulls it when a player leaves or is removed. A restore of an old `details` would give that player their character back after the GM removed them. The restore therefore overlays the snapshot's `details` with the **live** values of `playerUserId` (and any future field marked access-bearing; N1.2 adds `FACET_ACCESS_FIELDS` next to `FACET_DM_ONLY_FIELDS` in `packages/shared/src/facets.ts`, with a test that every facet field named like a user reference is listed). Test (N1.3): remove a member, restore a revision that predates the removal, the player still has no access and `ownCharacterIds` is unchanged. Likewise a restore that changes `type` away from `pc` and back never re-creates an assignment.
- **Dangling references.** The old state may point at things that no longer exist. Facet `pageLink` fields whose target is gone or not in the campaign are set to null (the current validator `assertPageInCampaign` would otherwise reject the whole restore); properties whose definition was deleted are skipped; links inside the body to missing pages stay as they are today (rendered as unresolved). The response lists these as `warnings`. Uploads are never deleted, so images still resolve.
- **Restoring the current state** (same `content_hash` as the live page) is a no-op returning the page with no new revision. The comparison is made **after** the live `playerUserId` (and other access-bearing fields) has been overlaid onto the snapshot's `details`, so restoring a revision that differs only in the removed player's assignment is also a no-op, not a write.
- **A trashed page** has no history endpoints (the existing `row()` check returns 404); restore it from the trash first.
- **Player-visible effect:** the restored page is projected for players like any saved page; restore returns the GM's `PageDto`.
- **MCP (N1.5):** `get_page_history` (read) and `restore_page_version` (write token only). The allowlist regexes in `mcp/api.ts` gain `GET .../pages/:id/history(/:rev)?` and `POST .../pages/:id/history/:rev/restore`; `tokenScope === 'read'` is already refused for POST by the session middleware. The restore row is attributed `source = 'mcp'` with the token, so "undo the assistant" appears in history as the assistant's own action.

## 8. Trash, purge, backup, export

- **Soft delete (trash):** history stays untouched; the rows are inert while `deletedAt` is set and return with the page on restore from trash.
- **Purge** (`PageService.purgeIds`, the 30-day purger, "Delete permanently"): `page_revisions` rows go with the page (explicitly first, in small batches, see 5.2; `ON DELETE CASCADE` remains as the safety net) (foreign keys are on in `openAppDb`). History must not outlive a purge: a purge is the user's "make this gone" and a surviving copy of a DM secret would be a surprise. If a campaign delete is ever added (only archive exists today) it cascades the same way. Postgres cascades identically. A test: purge removes the rows (`select count(*)` is 0), including for a subtree.
- **Template or user deletion:** `author_user_id` is set null (label "deleted user"); `token_id` is plain text and dangling safely.
- **Backups:** history lives in `app.sqlite`, so every backup includes it with no change to `BackupService`; restore brings back history as of the backup. The `backup.md` §8.1 purges (sessions, tokens) do not touch it. The schema-allowlist check compares against a database migrated to the same journal prefix, so the new migration is handled. **Consequences to document in the backup guide (M3.6 wording update):** (a) backups grow with history; (b) pruned or purged content may still exist in older backup files, the same property as for purged pages today.
- **Restore of an older backup into a newer build:** the migration creates the table; pages have no rows; the baseline rule (3.4: newest row's hash differs from the live state) applies. A backup taken after this feature restored into a build that has it: rows come along.
- **Campaign export/import zip** (`campaign-transfer.ts`): **history is not exported.** The export is the current state of the campaign (it can be handed to another group; it already includes DM content, but "full edit history" is a much larger and different promise). Import writes revision 1 with `cause = import` per page. Open question 5.
- **Search index (`index.sqlite`):** unchanged and rebuildable; never indexes revisions.

## 9. Both schemas and migrations

1. Add `pageRevisions` to `apps/server/src/db/schema.ts` and `schema.pg.ts` together (rule 4 of §4). Postgres: `jsonb` for `body`, `details`, `properties`; `bigint` for `created_at`; `integer` for `revision`, `restored_from`, `bytes`; same composite primary key and the two indexes. Index names must match (the parity test compares index names and columns).
2. `pnpm --filter @cn/server db:generate` creates the SQLite migration (`0007_...`) and the Postgres migration (`drizzle-pg/0003_...`); commit both with the journal files. The parity test applies both sets (PGlite) and compares columns, nullability, keys, foreign keys and indexes; the backup schema-allowlist test applies the journal prefix.
3. **No data migration.** Pure `CREATE TABLE`; no backfill (3.4). Safe to roll forward; for rollback the table can be left in place (older builds ignore unknown tables, though the restore schema allowlist of an older build would refuse a newer backup by design; that is the existing "backup from a newer version is refused").
4. **Hashing and JSON.** Compute `content_hash` in application code over a canonical form. Never compare JSON columns in SQL (key order differs between SQLite text and Postgres `jsonb`).
5. **Postgres at run time (N14, later):** `update` currently reads the revision, then writes, relying on a synchronous single writer. With several processes, the page update needs `where revision = :expected` and the revision insert must be in the same transaction (it is, by design here); coalescing's "delete + insert of the newest row" must `select ... for update` that row. Noted so N14 does not rediscover it.
6. **Database size growth** is the only operational change: add history size (`sum(bytes)`) to the numbers an admin can see only if the owner asks (not in scope).

## 10. Handoff to the tasks

- **N1.2 (Backend Architect):** first, the `DB_RATIO_LIMIT` change and its backup/restore test with a history-heavy database (5.1b); schema in both dialects + migrations; `WriteContext` and `tokenId` plumbing; move `setValues` inside the `update` transaction; `recordRevision(tx, ...)` with the pre-state/hash-compare baseline (3.4), coalescing, no-op skip, `create` accepting final body/details/props/cover (4.6), tracker HP sync context (4.1), `FACET_ACCESS_FIELDS`, `purgeIds` revision-first deletes; every call site passes a context; `PageHistoryService` (read + restore); `HistoryPruner` and settings. Tests: one per write point in section 4.1 (revision exists, same transaction: force a failure after the page write and assert neither page nor revision changed), coalescing rules, baseline, hash skip, prune oracle (30-day boundary, one per day, protections, cap), purge cascade, parity.
- **N1.3 (endpoints):** section 7, GM check first, audit line for restore, sentinel crawl extension per section 6, `409` on stale revision, `limit` capped at 100.
- **N1.4 (UX Architect to Frontend):** list from the history endpoint; "via AI assistant" label for `source = 'mcp'` with the token name as secondary text; diff in the client with `docText` between any two snapshots; Restore with a confirmation that names what is **not** restored (who can see the page); show `warnings`. Coalesced rows show their start time.
- **N1.5 (MCP Builder):** two tools, allowlist entries, GM-only enforced by the REST layer.
- **N1.6 (tests):** `e2e/history.spec.ts` as in the task, plus a player browser context that cannot see the panel and gets refused on the URL.
- **Docs:** `docs/STATUS.md` and `docs/ARCHITECTURE.md` (ER diagram, "Backups" paragraph about history size) updated in N1.2/N1.3; the coalescing deviation from PRD N1 logged in `docs/PLAN.md` if the owner approves.

## 11. Risks

| Risk | Mitigation |
|------|-----------|
| Secret leak through history (section 6) | GM-only guard first, separate service, stored-row snapshots, extended sentinel crawl, no second consumer |
| Revision not matching the page (props written outside the transaction today) | Move `setValues` into the transaction; test with a forced failure |
| Disk growth from autosave or a looping assistant | Coalescing, no-op skip, per-page cap, daily thinning, MCP rows protected only inside the 30-day window |
| Destructive pruner with a wrong clock | Cutoff bounded by recorded activity (a forward clock cannot delete more than the margin allows), defer during backup/restore, protections for newest and oldest rows, per-batch re-check |
| A history-heavy database fails its own backup verify | Ratio limit for `app.sqlite` rescaled (5.1b); explicit N1.2 acceptance test |
| Restore re-publishes or resurrects state | Visibility, viewers, tags and access-bearing facet fields (`playerUserId`) are not restored; dangling links nulled with warnings |
| Restore of a player-merged document deletes DM blocks | Snapshots always hold the full stored document (control 3) |
| Writers that bypass `PageService.update` later | The write context is a required argument, so the compiler finds every `PageService` caller; a direct `db.update(pages).set({ body ... })` outside `PageService` is a review rule (a lint or grep test in N1.2 is cheap and recommended) |
| Old backups keep pruned content | Documented in the backup guide; same as purged pages |

## 12. Open questions for the owner

**Owner decisions (with my recommendation):**

1. **Coalescing (deviates from PRD N1 "every save kept" and from the task text "keep all for 30 days").** Consecutive saves by the same person within 2 minutes become one entry. Without it an hour of typing makes ~300 full copies. The cost, stated plainly: if a bad paste happens within the 2-minute window of a run, the state a minute earlier is overwritten and cannot be restored; you get the version from before the run. **Decided (owner, 2026-10-23): 2 minutes** (`HISTORY_COALESCE_MINUTES`; 0 gives literal every-save-kept, at the storage cost above and with a lower per-page cap). (A 10-minute window, ~6 rows/hour, was the original proposal; the owner chose the shorter one: ~30 rows/hour and a 2-minute worst-case loss.)
2. **How long and how much.** Daily rows after 30 days, monthly rows after a year, and a 500 MB per-campaign ceiling (5.1). The daily-MCP-edit habit alone adds ~365 MB/year. **Decided (owner, 2026-10-23): tiered retention as stated, taken as defaults**; they are settings, not code.
3. **Off switch / tuning.** **Recommendation:** retention, window and ceiling are environment settings; no switch to turn history off.
4. **What Restore covers.** Title, type, body, details, properties. Not: visibility, who may see it, position, tags, icon, cover, **nor access-bearing details such as which player owns a character** (that stays as it is now, so restoring cannot give a removed player access back). **Decided (owner, 2026-10-23): content-only restore as stated.** (Alternative: also restore tags, icon, cover.)
8. **Older pages.** No backfill: a page's first recorded edit also stores the state it overwrote (the baseline). **Recommendation: accept**; the alternative is a slow upgrade and a database that grows by one copy of every page immediately.

**Defaults assumed (shout if you disagree):**

5. Campaign export does not include history; import starts fresh.
6. Players never see history, not even for their own character.
7. A player's AI token edit is labelled "via AI assistant"; the role is not recorded.
9. "Keep forever" named versions are a later task.
10. Tracker hit-point syncs at the end of combat are recorded as their own rows (`cause = tracker`); the UI may hide them by default. Say if you want them not recorded at all.
