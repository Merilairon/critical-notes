# Status and next steps

Snapshot: **2026-10-13**. **Every milestone of the plan, (a) to (i), is done**, and since then an **MCP server for AI assistants** (see [What the MCP server added](#what-the-mcp-server-added)). What could come next is in [After the plan](#after-the-plan).
The plan, its milestone table and the list of deviations live in [PLAN.md](PLAN.md). This file is for picking the work back up: what state the code is in and what to do next, in order.

## Where things stand

| Milestone | State |
|---|---|
| Step 0: data survey (`DATA_NOTES.md`) | ✅ done |
| (a) Indexing and edition resolver | ✅ done |
| (b) Reference browser | ✅ done |
| (c) Auth, campaigns, page tree, typed facets | ✅ done |
| (d) Block editor, properties, backlinks | ✅ done (2026-10-12) |
| (e) Homebrew | ✅ done (2026-10-12) |
| (f) Templates | ✅ done (2026-10-12) |
| (g) Encounters, initiative, loot | ✅ done (2026-10-13) |
| (h) Roles, invites, visibility everywhere, export/import, edition migration | ✅ done (2026-10-13) |
| (i) Docker, docs, Postgres, Playwright | ✅ done (2026-10-13) |
| After the plan: MCP server for AI assistants (tokens, `/mcp`, Markdown) | ✅ done (2026-10-13) |

### Health checks (after the MCP server)

| Check | Result |
|---|---|
| `pnpm -s typecheck` | ✅ all 6 projects and `e2e/` |
| `pnpm -s lint` (ESLint and the raw-HTML guard) | ✅ |
| `pnpm -s test` | ✅ 322 tests (packages and server), 42 tests (web) |
| `pnpm build` | ✅ server bundle (with the MCP SDK and the Markdown libraries); web initial bundle unchanged |
| `pnpm e2e` (Playwright, fresh server from the bundle) | ✅ 55/55, no browser errors |
| Docker image (`docker compose up`, fresh volume) | ✅ rebuilt with the MCP server; Playwright 55/55 against it |

### Nothing is committed yet
- The repository is on `master` with **zero commits**: every file is untracked.
- `5etools-data/` (the 5etools clones) and `var/` (databases and uploads) are gitignored and must stay out of git.
- Commit messages must never carry `Co-Authored-By` lines.

## How to resume

```sh
pnpm install
pnpm data:clone          # only if 5etools-data/ is missing (shallow clones; the images are about 13 GB)
pnpm index               # builds var/index.sqlite (cold build about 6 s, a no-op re-run about 16 ms)
pnpm dev                 # server on :3000 (tsx watch); web on :4200 (proxies /api and /img to :3000)
```
1. Open http://localhost:4200/setup to create the first admin account.
2. Run the full gate after each milestone: `pnpm -s typecheck && pnpm -s lint && pnpm -s test`.
3. Browser tests: `pnpm e2e` builds, starts the bundled server on a fresh temporary data folder and runs `e2e/*.spec.ts` in the system Chrome (about 30 s). They need the real 5etools data. `E2E_BASE=<url> pnpm exec playwright test` runs them against a fresh running instance instead (for example the Docker container); `CHROME_PATH` picks another browser. Failures leave traces in `test-results/` and a report in `playwright-report/`.
4. The index schema went to version 5 in (e) (a `deleted` column). The first start or `pnpm index` after updating rebuilds the index once (about 6 s).
5. Docker: `docker compose up -d` (see the README). After a change to either database schema, run `pnpm --filter @cn/server db:generate` so both migration sets follow; `test/pg-parity.test.ts` fails otherwise.

## What the MCP server added

AI assistants (Claude Code, Claude Desktop through `mcp-remote`, any MCP client) can read and write campaigns.
- **API tokens** (`services/api-tokens.ts`, `routes/tokens.ts`, table `api_tokens` in both schemas):
  - made, listed and revoked on the new **Account** page (`apps/web/src/app/account/`, the username in the header links to it);
  - read only, or read and write; an expiry or none; at most 20 active per user;
  - only a SHA-256 is stored, and the token is shown once with ready-to-paste client setups.
- **`/mcp`** (`apps/server/src/mcp/`): Streamable HTTP through `createMcpHandler` (`@modelcontextprotocol/server` 2.3.1, JSON responses, 2025-era clients served statelessly).
  - Bearer tokens are accepted only here; cross-origin browser requests are refused.
  - The tools call the REST API in-process as the token's user (`mcp/api.ts`, an allowlist of method and path). `sessionMiddleware` recognizes the call by a module-private symbol in the request env, so role checks, validation and player projections are the web app's.
  - Read tokens get only the read tools.
- **31 tools (11 read, 20 write):** `list_campaigns`, `get_campaign` (pages, page-type details, properties, members), `search_pages`, `search_rules`, `get_page`, `create_page` (also from a page template), `update_page` (fields, full Markdown with revision, find/replace edits, append, move), `delete_page`, `restore_page`, `save_property`, `delete_property`, `list_encounters` (with difficulty), `create/update/delete_encounter`, `get_inventory`, `add/update/remove_inventory_item`, `change_coins`, `list_homebrew`, `get_homebrew_entry`, `save_homebrew_source` (also sharing), `create/update/delete/restore_homebrew_entry`, `list_templates`, `get_template`, `save_template`, `delete_template`. The server's `instructions` (`mcp/instructions.ts`) explain the Markdown dialect.
- **Markdown ↔ blocks** (`@cn/blocks/markdown`, kept out of the web bundle):
  - the dialect: `:::secret`, `:::dm`, `:::callout`, `:::read-aloud`, `:::details[…]`, `:::roll-table`, `:::columns`, `:::tabs`, `::embed{uid}`, `{@tags}`, `[[links]]`, `{{fields}}`;
  - blocks Markdown can't show become `<!-- cn:block <id> … -->` lines (templates: by position, `@2.1`);
  - `reconcile` (LCS per level, then moves, then pairing by type) keeps unchanged blocks exactly and edited blocks' ids and unexpressed attributes; every warning goes back to the model.
- **REST additions:** `props` on page creation; `POST /pages/:id/restore` (`PageService.restore`, back to the top level if the parent is still deleted).
- **Tests:** `packages/blocks/test/markdown.test.ts` (dialect, hazards, reconcile, a player edit through `mergePlayerEdit`), `packages/templates/test/markdown.test.ts` (the 13 built-ins read back unchanged), `apps/server/test/mcp.test.ts` (tokens, scopes, every tool group, players), the sentinel crawl over every read tool as a player (it fails if the MCP layer runs as the DM: checked), `e2e/account.spec.ts` (token in the UI, a page written over MCP shows in the app, revoke).

<details>
<summary>What milestone (i) delivered</summary>

## What milestone (i) delivered
- **Uploads re-encoded with sharp** (`services/uploads.ts`): the image must decode (the right magic bytes are no longer enough), the EXIF orientation is applied and all metadata dropped (tested with an EXIF sentinel), edges are capped at 8192 px, more than 100 megapixels is refused before decoding, and a 400 px WebP preview is stored (`GET /api/uploads/:id?size=thumb`).
- **Server bundle** (`apps/server/scripts/build.mjs`, `pnpm build`): esbuild to `dist/main.mjs` and `dist/index.mjs` (the indexer CLI). Native modules and `5etools-utils` stay external and are listed in `dist/package.json`; the migrations are copied to `dist/drizzle`. `start:dist` runs it.
- **Docker** (`Dockerfile`, `docker-compose.yml`): three stages (build, the external packages only, runtime); `--ignore-scripts` because every native package ships prebuilt binaries; runs as `node`; health check on `/api/health`; the 5etools clones mounted read-only; data in the `app-data` volume. `docker compose --profile tools run --rm data-update` pulls new 5etools data as your user (in `buildpack-deps:bookworm-scm`), and a restart re-indexes.
- **Postgres schema** (`src/db/schema.pg.ts`, migrations in `drizzle-pg/`, `pnpm db:generate` for both dialects). `test/pg-parity.test.ts` compares every table (columns, types by the agreed mapping, nullability, keys, foreign keys, indexes), applies both migration sets (Postgres in PGlite) and compares the columns that result, and round-trips JSON, booleans and timestamps.
- **Playwright** (`playwright.config.ts`, `e2e/`): a setup project creates the admin through the first-run page; six specs (campaign, editor, homebrew, templates, combat, players) carry over every step of the old smoke scripts, which are gone. Each spec fails on browser errors and attaches a screenshot and a trace on failure.
- **Docs:** `README.md` (features, data, Docker, configuration, using it, development, licensing) and `docs/ARCHITECTURE.md` (the pieces, the two databases, a request, visibility, editions, the editor, uploads, deployment, the data model as a mermaid ER diagram).
- **Found on the way:**
  - In production, session cookies were always `Secure`, so signing in over plain http on a LAN address could never work. They now follow `PUBLIC_URL` (https), with `SECURE_COOKIES` to override.
  - `APP_SECRET` was never used (session tokens are random and stored hashed); it is gone from `.env.example` and the config.
  - In tests, Playwright's `browser.newContext()` applies the project's saved session: a page meant to start signed out must pass an empty state.

</details>

<details>
<summary>What milestone (h) delivered</summary>

## What milestone (h) delivered

### Server
- **Roles:** `dm` (the owner), `codm` and `player`. `isGameMaster(role)` covers DM and co-DM. Only the owner manages members and roles, invites co-DMs, and changes the edition.
- **Who sees which page** (`services/visibility.ts`, `VisibilityService`):
  - Game masters see every page.
  - Players see pages with visibility `all`, `selected` pages that list them as viewers, and their own characters (`character_facets.player_user_id`).
- **Every content route is open to members and projected for players:**
  - page tree, list (`?type=`), page GET
  - backlinks (checked against the projected content), query rows, search (player text, no snippet)
  - property definitions (DM-only ones left out), house rules, uploads
  - The projection drops DM-only and unrevealed-secret blocks, DM-only facet fields (`FACET_DM_ONLY_FIELDS`), DM-only properties, links to pages the player can't see, and parents they can't see.
- **Players edit their own character page** (`PageService.updateAsPlayer`):
  - They can't change type, visibility, viewers, DM-only fields or `playerUserId`.
  - The body goes through `mergePlayerEdit` (`@cn/blocks`): hidden blocks are kept, anchored after the visible block before them.
- **Invites:**
  - Only a sha256 of the token is stored. Each invite has a role, an expiry and a maximum number of uses, and can be withdrawn.
  - `GET /api/invites/:token` describes the invite. `POST /api/invites/:token/accept` lets a signed-in user join. `POST /api/auth/register` creates an account through an invite; there is no open sign-up.
  - Members can be listed. The owner changes roles and removes members (their characters stay, unassigned). Anyone else can leave.
- **Inventory:**
  - Members read it. Players change only their own characters' items and coins, and may give an item away.
  - Players see an unidentified item as "Unidentified item", with no reference link and no notes. Only a game master can identify or rename it. Characters the player can't see, and their belongings, are left out (`projectInventoryForPlayers` in `@cn/shared`).
- **Members list leak (found and fixed):** `GET /members` named every member's characters, including PCs a player can't see. These are now filtered. The sentinel seed now includes a DM-only PC played by the DM, and the crawl fails if the filter is removed (checked).
- **Campaign export and import** (`services/campaign-transfer.ts`):
  - Export is a zip: `campaign.json` (format `critical-notes/campaign`, schemaVersion 1) plus `uploads/<id>`.
  - Import creates a new campaign owned by the importer. Every id is remapped, and the old campaign-only homebrew source moves to the new one.
  - Limits: a 150 MB zip (now also enforced by a `bodyLimit` on the route), 60 MB of JSON, 2000 uploads.
- **Edition migration** (`services/migration.ts`):
  - A dry run lists every reference to rules content: tags and embeds in bodies, refLink facet fields and PC classes, refLink properties, encounter creatures, inventory items. Each is mapped through its reprint group to the target edition's newest printing, or marked as having no match.
  - Applying it rewrites the references (except those marked keep), switches the ruleset, turns cross-edition off, clears source overrides and logs the change to `campaign_migrations`.
- **Tests:**
  - `test/visibility.test.ts`: the sentinel crawl over more than 40 player-reachable responses, including the SSE player stream, search, query and the reference with campaign homebrew. Also the positive checks, player edits, forbidden edits, inventory rules, invites and members.
  - `test/transfer.test.ts`: migration plan and apply, export/import round trip, malformed files.
  - `@cn/blocks`: `mergePlayerEdit`.

### Web
- **Store:** `role`, `isGm`, `isOwner`, `myId`, `canEdit(page)`, `members` / `loadMembers()`. The campaign's role is also on `ContextService.campaign`, for route guards.
- **Invite page** at `/invite/:token` (outside the auth guard): create an account, or join as the signed-in user.
- **What players don't get:**
  - Shell: Encounters and Templates are hidden, and "Settings" becomes "Members & rules". Running combats open the player view.
  - `gmGuard` (`campaign/gm.guard.ts`) on the encounters, encounter, tracker and campaign templates routes sends players to the overview before the page loads.
  - Every "+ New" / "+ NPC"-style button, tree dragging and subpage "+".
  - Page editor: the type, visibility, tags and template toolbar, the NPC statblock. Pages they can't edit are a read-only `cn-block-view` with the facet form and properties disabled.
  - Block editor on their own character: no "DM secret", "Encounter", "Loot" or "Template…" in the "/" menu, no "Create page" from `[[`, no 🔒 button, no "DM only" / "Revealed" / "Wrap in DM secret" in the block menu, and the visibility shortcuts do nothing. A linked template's "Edit values" is for game masters (the server re-renders it only for them); detaching still works.
- **Settings** (`campaign/settings.ts`):
  - Players see Members and a read-only House rules.
  - `campaign/members-panel.ts`: members, role select and remove for the owner, invite links (shown once, with copy), the invite list with withdraw, "Leave this campaign".
  - "Export campaign", and for the owner `campaign/edition-migration.ts` (dry-run table with keep checkboxes, then apply, then reload the campaign).
- **Campaign list:** "Import campaign" (zip upload, then the import report with a link). Co-DMs are labelled "Co-DM".
- **Inventory page:** edit controls only for the player's own characters. Identifying items is GM-only.
- **Tests:** `campaign/roles.spec.ts` (store roles and `canEdit`, `gmGuard`, members panel per role, the migration panel's dry run and apply, inventory permissions) and the "/" menu for players.
- **Browser run** `scripts/e2e/smoke-h.mjs`, 11/11:
  - The DM makes an invite in the members panel. A player registers through it in a second browser context.
  - The player sees no GM tools, is sent back from `/encounters`, and sees a shared page without its secret (also not found by search).
  - The player edits their own character; the DM-only block in it survives.
  - Inventory as a player, and the members panel.
  - Every API response the player's browser received is checked for the hidden strings.
  - Export, import through the campaign list, and moving the imported copy to 2024 rules (`fireball|phb` becomes `fireball|xphb`; the original is unchanged).

### Fixed on the way
- `GET /members` named characters a player can't see (see above).
- The encounters page left a failed load unhandled (it now shows the error), as did "New tracker".
- The editor's drag handle showed in the page's top-left corner until the mouse first moved over the editor (since (d)).
- Long source abbreviations overlapped the source name in the Sources settings.

</details>

<details>
<summary>What milestone (g) delivered</summary>

## What milestone (g) delivered
- **Combat numbers** (`@cn/fivetools` `monsterCombatStats`): HP, the unconditional AC, initiative (2024 initiative proficiency included), CR, XP and lair XP from 2014 and 2024 statblocks.
- **Encounters:** creatures from the bestiary, NPC pages (their statblock) and custom entries; count, lair XP and "starts hidden" per line; party from the campaign's characters (levels from their classes) or custom levels. The builder shows the difficulty by the campaign's rules: DMG 2014 thresholds with the creature-count multiplier and party-size steps, or XDMG 2024 budgets.
- **Initiative tracker** (`@cn/shared/tracker`, a pure reducer with tests, applied on the server in order):
  - Running an encounter adds the party (current HP from their pages) and the creatures (numbered, initiative rolled).
  - Turn order and rounds, previous/next, HP box (`-7` damage, `+5` heal, `=20` set, `t5` temporary; temporary HP absorbs damage first), conditions with durations counted down at the end of the creature's turn, hidden combatants, notes, adding monsters/characters/others mid-fight. Keys: `n`, `p`, `r`.
  - Live updates over server-sent events (gzip is bypassed for streams). The player view (a full-screen route, also for a second screen) only ever receives the projection: no hidden creatures, no notes or AC, exact HP for player characters only and "Unhurt / Wounded / Bloodied / Down" for everyone else; the active turn is not revealed while a hidden creature acts.
  - Ending combat writes the characters' HP back to their pages.
- **Blocks:** the encounter block (pick or create an encounter, see creatures and difficulty, run it) is never sent to players. The loot block (items from the reference or custom, coins) awards once to the party or a character; the session page is recorded on the items.
- **Inventory:** party stash and each character's items and coins; stacking, quantities, identified, moving items between owners (which ends attunement), the 3-item attunement limit, coins that never go negative.
- **Fixed on the way:** `updateEncounterInput` was a `.partial()` of a schema with defaults (the zod 4 trap from (e) again), so saving only the party emptied the creature list; the "/" menu picked "Roll table" for `/encounter` (titles now rank before keywords); the player view no longer shows the app header.

</details>

<details>
<summary>What milestone (f) delivered</summary>

## What milestone (f) delivered
- **`packages/templates`** (framework-free, used by server and web):
  - Placeholders: `{{name}}`, `{{dc: number = 13}}`, `{{save: select(Str|Dex)}}`, `{{dmg: dice}}`, `{{who: pageLink<npc>}}`, `{{foe: reference<monster>}}`; `\{{` is literal. A single left-to-right scan, no regex over user text.
  - Typed, validated values. Substitution turns dice into `{@dice}` tags, references into `{@creature Name|SRC}` tags and page links into `[[links]]`, keeping text marks.
  - Edition-aware: `{{rules.race}}` ("Race"/"Species"), `$rulesetRef` and `$rulesetTag` (e.g. `{@condition Prone|XPHB}` in 2024 campaigns).
  - Page templates `extends` other page templates: properties and fields merge by key, facet values and defaults merge, the body is appended or replaced; loops and missing parents are refused.
  - Export format `critical-notes/template(-library)` with `schemaVersion` and a migrations registry; files from a newer app version are refused with a clear message.
  - 13 built-ins (NPC, Location, Settlement, Dungeon room, Quest, Faction, Session prep, Session recap, Shop, Player handout, Magic item handout, Trap, Random encounter table), tested to produce valid blocks in both editions.
- **Server:** the library (built-in, personal, campaign), saving with version checks, linked instances re-rendered when a block template is saved, pages from page templates (custom properties added if missing, facet defaults, child pages with a depth and cycle guard), applying a template to an existing page without overwriting anything, per-type campaign defaults (used by the normal page-create endpoint), usage lists, duplicate, import and export. Built-ins are upserted at startup.
- **Web:**
  - Templates library (top level and inside a campaign) and a template editor: content in the block editor, a live fields panel (type, label, default, required), page settings (page type, extends, default title/icon/visibility/tags, facet values, properties, subpages), "used in".
  - In pages: "/ → Template…" inserts a block template filled in, with empty values left as fields, or linked. Linked blocks are read-only, with "Edit values" and "Detach".
  - "+ New → From template…", "Apply template" on a page, and default templates per page type in campaign settings.
- **Fixed on the way:** fields mode left raw `{{name}}` text inside attributes (now empty); syncing variables reset types set in the fields panel back to text; the fields table was too wide for its column (now stacked).

</details>

<details>
<summary>What milestone (e) delivered</summary>

## What milestone (e) delivered
- **Validation** ([apps/server/src/homebrew/](../apps/server/src/homebrew/)):
  - The `5etools-utils` brew-fast schemas, loaded from local files and compiled once (about 2.7 s on first use). The one remote `$ref` (Foundry scenes) is stubbed, so nothing goes online.
  - App checks on top: name, valid CR, spell level, subrace parent (errors); broken `{@tag}` targets, unrollable dice, name collisions with other sources (warnings).
  - Schema errors block a save unless the user chooses "Save anyway"; app errors always block.
- **Sources:**
  - Private (owner), instance-wide (admins), and the campaign-only source every campaign has.
  - Shared with specific campaigns the user runs; a shared source's content shows up in that campaign's reference, search and `{@}` autocomplete.
  - New source ids follow the 5etools homebrew schema (6+ characters of letters, digits, `-&+!`, not starting with UA). Imported files keep their own ids.
- **Entities:**
  - Validated create and update with optimistic concurrency (409), revisions with JSON-patch diffs, restoring an old revision (as a new one).
  - Soft delete: hidden from lists and search; pages that use it still resolve it, with a "Deleted" badge. Restorable.
  - Renaming adds an alias, so existing `{@creature Old Name|SRC}` tags keep working.
  - "Used in": campaign pages (in campaigns the user runs) that reference the entity.
  - Homebrew subraces are merged into their parent race (official or homebrew), like 5etools does.
  - "Copy to homebrew" from any reference page: a full copy (official-only fields stripped, token kept) or a `_copy` variant.
- **Import and export:**
  - Files, a whole folder, or a URL. URL downloads re-check every resolved address at connection time (no private, loopback or link-local targets, DNS rebinding included), follow at most 3 redirects, and stop at 10 MB / 15 s.
  - Import never fails as a whole: each file and entity is handled on its own and the report lists what was created, updated, unchanged, skipped and why. Re-importing updates in place.
  - Data arrays the app cannot use are kept on the source and come back on export. Exports validate against the 5etools homebrew schema (tested).
- **Web** ([apps/web/src/app/homebrew/](../apps/web/src/app/homebrew/)):
  - Homebrew area: sources, new source, import with a report, per-source page with entities by type, deleted items, export, campaign sharing, settings.
  - Entity editor with three views over one value:
    - a form per type (monster, spell, magic item, mundane item, feat, species, subrace, background, condition, rule, table)
    - CodeMirror JSON, with schema problems shown at their JSON path
    - "Lore" (fluff)
  - The structured entries editor (paragraphs, sections, lists, tables, insets, read-aloud, quotes, raw JSON) with a toolbar and `{@` autocomplete that always inserts `|SOURCE`.
  - Live preview through the server's real resolver, the checks list, history with restore, "used in".
  - Campaign settings: choose which of your sources a campaign uses.
- **Fixed on the way:**
  - Homebrew sources always showed as switched off in the source toggles (campaign settings and the sources panel), because the client-side policy never included homebrew. This was in the code since (c).
  - Form edits made in quick succession could overwrite each other: every field built the new entity from its own, possibly stale, input. Fields and nested editors now send path patches that the editor applies to its current value. The browser run caught it.
  - Updating a source with an empty patch reset its authors: `updateHomebrewSourceInput` was a `.partial()` of a schema with defaults, and zod 4 filled the defaults back in.

</details>

<details>
<summary>What milestone (d) delivered</summary>

- **`packages/blocks`:** the block registry (every block type in the plan, with zod attribute schemas and content rules), `sanitizeDoc`, the player projection `projectDoc`, text and link extraction, and the query DSL.
- **Server:** page bodies sanitized on save; derived `page_links` and `entity_references`; custom property definitions and validated values; `POST /query`; campaign page search with separate DM and player text; image uploads checked by magic bytes; `GET /pages/:id?as=player`, a DM preview through the real player projection.
- **Editor:** TipTap v3 with Angular node views for every custom block; slash menu, `[[` page links with "Create page", `{@` reference tags; drag handle with a block menu; `Mod-Shift-D` / `Mod-Shift-R` for DM-only and revealed.
- **Page editor:** properties panel (every property type, adding and deleting definitions), "Linked from" backlinks, "Preview as player" rendered by the read-only `cn-block-view`.
- **Ctrl+K:** inside a campaign, page hits (title and body text) appear above reference hits.
- **Fixed on the way:**
  - The page editor reloaded its page in an endless loop: its route effect also tracked the `page` signal through `flush()`. This was in the code since (c). The (d) browser run caught it.
  - zod had crept into the initial bundle through the command palette. The page-type constants now live in the zod-free `@cn/shared/page-types`.
  - The server's `build` script pointed at a file that never existed. It is gone; `start` runs `tsx src/main.ts`.

</details>

## After the plan

Everything in PLAN.md is built. Candidates for what comes next, roughly by value:
1. **Make the first commit** (nothing is committed yet; see above), and choose a license for the project (the README says it is not chosen).
2. **CI:** the gate (`pnpm -s typecheck && pnpm -s lint && pnpm -s test`) runs anywhere. The browser tests (and the optional real-data checks) need a 5etools clone, which a public CI must not download and keep: run them on a self-hosted runner, or keep them local.
3. **Postgres at run time:** the schema is ready, but the services use better-sqlite3's synchronous API. Moving them to an async data layer is the real work.
4. **OAuth for the MCP endpoint**, so it can be added as a custom connector on claude.ai (which signs in with OAuth instead of a pasted token).
5. The gaps below.

## Known gaps and technical debt
- MCP: editing a paragraph through Markdown drops its underline and highlight (Markdown has neither); unchanged paragraphs keep them. Tables with merged cells, hidden list items and blocks inside table cells are shown as placeholder lines.
- A player's save turns links to pages they can't see into plain text (their projection has the text only). This is the same in the web editor and through MCP.
- Upload thumbnails are made and served (`?size=thumb`), but the web app does not use them yet (galleries, the campaign cover).
- Homebrew classes, subclasses and their features have no form (JSON only, as planned). Homebrew magic variants are indexed as single items: they are not expanded across base items, and official generic variants are not expanded onto homebrew base items.
- A variant's form shows only the fields it overrides; inherited values appear in the preview, not as placeholders in the form.
- Template versions are stored, but there is no UI to view or restore an older template version yet.
- Live tracker updates use an in-process event hub: fine for one server process; running several would need a shared pub/sub.
- The tracker has no death saves, legendary action counters, or delay/ready actions yet.
- **Players and GM-only UI:** a new GM-only route needs `canActivate: [gmGuard]`; a new editor tool that players shouldn't have goes behind `gm()` in `BlockEditor` (or `GM_ONLY_ITEMS` for "/" items). The server checks regardless; the UI just shouldn't offer what will be refused.
- **Any new endpoint that returns campaign content must project for players** (pages through `PageService.projectPage` / `getFor`, inventory through `projectInventoryForPlayers`, member characters filtered by visible pages). It also needs a sentinel string in the seed of `test/visibility.test.ts`, so the crawl covers it.
- Trackers are not part of the campaign export. `selected` pages import as DM-only, because the viewers are users of the old instance.
- The edition migration rewrites only simple `name|source` tags; class-feature style references keep their old target.
- The query block has only a `list` view. The `table` and `cards` views and the column picker are not built yet.
- `apps/web` excludes `packages/fivetools/src/node` in `tsconfig.app.json`. Keep Node-only code there.
- UI code that sits in the initial bundle (app shell, command palette) must not import values from `@cn/shared`'s main entry, which pulls in zod. Use `@cn/shared/page-types` or type-only imports.
- An `effect` that calls an async method must wrap the call in `untracked`, or every signal the method reads before its first `await` becomes a dependency.
- TypeScript stays pinned to 6.0.x until Angular supports 7.
