# Critical Notes: D&D 5e campaign manager. Plan

## Context
`/home/baetensjan/Projects/critical-notes` is empty: no git repo, no code. The goal is a self-hostable, TypeScript campaign manager for DMs and players, with these parts:
- Official rules content read at runtime from local 5etools clones, never bundled.
- Campaigns locked to the 2014 or 2024 rules.
- Homebrew in the 5etools format.
- A Notion-style page/block system with block and page templates.
- Encounters and initiative.
- Server-enforced DM/player visibility.

**Decisions you made (Oct 8, 2026):**
1. **Typed pages = page + 1:1 typed facet.** One record per NPC/location/session/etc.
2. **Fresh shallow clones** of both repos in a folder inside the project, `critical-notes/5etools-data/{5etools-src,5etools-img}`. The old v2.7.0 copies in the Obsidian folder stay untouched.
   - The folder is never committed, never sent to Docker builds, and never scanned by the dev tools: it's in `.gitignore` and `.dockerignore`, and excluded from tsconfig, ESLint, Vitest, Vite `server.watch.ignored`, and `.vscode/settings.json` (`files.watcherExclude` and `search.exclude`). The 11 GB of images would otherwise overload file watchers.
   - pnpm workspace globs cover only `apps/*` and `packages/*`, so the `package.json` inside 5etools-src is never picked up.
   - The app reads the paths from `FIVETOOLS_SRC_PATH` / `FIVETOOLS_IMG_PATH`, which default to `./5etools-data/...`, so the data can also live anywhere else.
   - App runtime data (DB, index, uploads) goes in a separate gitignored `DATA_DIR`, which defaults to `./var/`.
3. **SQLite first.** The Postgres schema and migrations come in the final milestone.
4. **Continuous milestones.** I run the tests and post a summary after each one, and stop only on a real blocker or design ambiguity.
5. **Angular for the web frontend.** All rendering and editing logic that doesn't depend on a framework lives in shared TS packages. The Angular app only adds components.

Git: I'll `git init` locally. I won't commit unless you ask, and commits never carry Co-Authored-By lines.

---

## Step 0: Data findings (the draft for DATA_NOTES.md)
I read the existing v2.7.0 clone in full. Upstream is now **v2.37.0** (an earlier tag listing sorted versions as text and showed v2.9.1), and I spot-checked it over HTTP. After approval, I clone fresh, re-run the survey scripts, and write `DATA_NOTES.md` with any differences. If something contradicts the design, I stop and flag it.

**Layout (`data/`)**
- Multi-file categories with `index.json` (source → file):
  - `bestiary/` (`bestiary-<src>.json`, `fluff-index.json`, `legendarygroups.json`, `template.json` = `monsterTemplate`)
  - `spells/` (plus `sources.json`: spell → class lists)
  - `class/` (`class-<name>.json` holds `class`, `subclass`, `classFeature`, `subclassFeature`)
- Single files:
  - Character options: `races.json` (`race` + `subrace`), `backgrounds.json`, `feats.json`, `optionalfeatures.json`
  - Items: `items.json` (`item`, `itemGroup`), `items-base.json` (`baseitem`, `itemProperty`, `itemType`, `itemMastery`, …), `magicvariants.json`, `loot.json`
  - Rules and reference: `conditionsdiseases.json` (`condition`, `disease`, `status`), `actions.json`, `variantrules.json`, `tables.json`, `skills.json`, `senses.json`, `languages.json`
  - Other entity files: `deities.json`, `trapshazards.json`, `objects.json`, `vehicles.json`, `rewards.json`, `cultsboons.json`, `decks.json`, `bastions.json`, `recipes.json`, `encounters.json`, `names.json`
  - New upstream: `homecrafts.json`, `encounterbuilder.json`, `converter.json`
- Books and adventures:
  - `books.json` / `adventures.json` hold the metadata (66 books and 101 adventures upstream).
  - `book/book-<id>.json` and `adventure/adventure-<id>.json` hold the content.
- `generated/` holds derived lookups (`gendata-tag-redirects.json`, `gendata-spell-source-lookup.json`, …).
- `foundry-*.json` files are VTT-specific; we ignore them.

**Sources and editions (verified, not assumed)**
- Book and adventure metadata has `id`, `source`, `group`, `published`, `author`, `cover`, `parentSource`. **There is no `edition` field on books, even upstream.**
- 5etools decides the edition at source level: `SourceUtil.isClassicSource` = `published` date earlier than XPHB's (2024-09-17).
- `Parser.SOURCES_LEGACY_WOTC` = PHB, DMG, MM, SCREEN, EEPC, VGM, MTF.
- The **authoritative list** is in npm `5etools-utils` (MIT), file `schema/site/sources-5etools.json`. Its `$defs.sourcesClassic`, `sourcesModern` (XPHB, XDMG, XMM, XSAC, FRHoF, EFA, …) and `sourcesLegacy` enums are what 5etools' own edition tests use.
- Entity-level `edition: "classic" | "one"` exists on `background`, `baseitem`, `class`, `subclass`, `race`, `magicvariant`, and it overrides the source's edition. For example, `items-base.json` mixes classic and one base items.
- Rules-availability flags:
  - Older: `srd`, `basicRules`.
  - Newer: `srd52` and `basicRules2024`. These were named `freeRules2024` in v2.7.0, so we read both names.
  - Upstream uses `referenceSources` (an array of source ids) where v2.7.0 had `otherSources`.
- `reprintedAs` is an array of `"Name|SOURCE"` or `{uid, tag}`.
  - The object form is a cross-type reprint, e.g. optionalfeature → feat, variantrule → hazard.
  - A chain can stay inside one edition (VGM→MPMM) or cross editions (PHB→XPHB).
  - One entity can have several targets (Aasimar → MPMM, XPHB).
- Default tag sources stay classic: spell/feat/race/class → PHB, creature → MM, item/table/hazard → DMG. 2024 data therefore always writes `|XPHB`, `|XMM` and so on explicitly. Our autocomplete must always insert explicit sources.

**Inheritance**
- `_copy: {name, source, _mod?, _templates?, _preserve?}` on monsters (1,103 in v2.7.0), races, subclasses, items, fluff, and more.
- Mod modes (utils.js): `replaceTxt`, `prependArr`, `appendArr`, `replaceArr`, `replaceOrAppendArr`, `appendIfNotExistsArr`, `insertArr`, `removeArr`, `remove`, `replaceName`, `calculateProp`, `scalarAddProp`, `scalarMultProp`, `setProp`, `prefixSuffixStringProp`, `addSenses`, `addSaves`, `addSkills`, `addAllSaves`, `addAllSkills`, `addSpells`, `removeSpells`, `replaceSpells`, `maxSize`, `scalarMultXp`, `scalarAddHit`, `scalarAddDc`.
- A `"*"` key applies a mod to all props.
- Dynamic text uses `<$name$>`, `<$short_name$>`, `<$title_short_name$>` and ability variants.
- Props that are **not inherited** unless `_preserve`d: `page`, `otherSources`/`referenceSources`, `srd`, `srd52`, `basicRules`, `basicRules2024`, `reprintedAs`, `hasFluff`, `hasFluffImages`, `hasToken`, `tokenCredit`, `tokenCustom`, `foundryTokenScale`, `altArt`, `_versions`.
- `_templates` applies `monsterTemplate.apply._mod/_root`.
- ⚠ 5etools uses `eval` for `calculateProp`. We use a safe arithmetic evaluator instead.
- Other runtime expansions to port:
  - `_versions` (e.g. "Aasimar; Necrotic Shroud", XMM "Animal Lord; Forager")
  - subrace merging into races
  - generic magic variants × base items (`magicvariants.json`, with edition matching)
  - `classFeatures` refs `Name|Class|ClassSrc|Level|Src` resolved to `classFeature` entries
- Official files also carry `_meta.internalCopies` / `dependencies`.

**Fluff**
- `fluff-*.json` (`monsterFluff`, `itemFluff`, `raceFluff`, …) is keyed by name+source. Fluff can also `_copy`.
- Each fluff entry has `entries` and `images: [{type:"image", href:{type:"internal", path}}]`. Paths are relative to the img root, and `external` hrefs carry a `url`.
- Entities flag `hasFluff` / `hasFluffImages`.

**Entries and tags**
- The entries tree has these object types:
  - Structure: `entries`, `section`, `chapter`, `list` (with styles), `table`/`tableGroup`, `row`/`cell` (with roll ranges)
  - Callouts and quoted text: `inset`, `insetReadaloud`, `quote`, `variant`/`variantInner`/`variantSub`
  - Media and embeds: `image`, `gallery`, `statblock`, `statblockInline`, `spellcasting`
  - Item lists: `item`/`itemSub`
  - References: `refClassFeature`, `refSubclassFeature`, `refOptionalfeature`, `refFeat`
  - Flow and layout: `options`, `hr`, `flowchart`/`flowBlock`, `inline`/`inlineBlock`, `link`
  - Dice and ability blocks: `dice`, `abilityDc`, `abilityAttackMod`, `abilityGeneric`
  - Misc: `actions`, `attack`, `homebrew`, `code`, …
- Inline tags use the form `{@tag arg|arg|…}` and can nest. There are 121 tag types in the renderer.
- Frequency in the data:
  - Most common: creature, spell, item, dc, dice, damage, condition, book, area, skill, b/i, hit, h, adventure, atk, variantrule, filter
  - Also present: `atkr`, `actSave*`, `scaledamage`, `itemMastery`, `5etoolsImg`, and others
- Each tag has a `defaultSource` and a target page.

**Images (5etools-img, 11 GB)**
- Art: `bestiary/<SRC>/<Name>.webp`. Tokens: `bestiary/tokens/<SRC>/<nameToTokenName(name)>.webp`, where `nameToTokenName` = toAscii, strip `"`.
- `token: {name, source}` reuses another creature's token (e.g. XMM Goblin Warrior uses the MM Goblin token).
- Other folders: `items/<SRC>/`, `spells/<SRC>/`, `races/`, `backgrounds/`, `classes/`, `feats/`, `conditionsdiseases/`, `covers/<SRC>.webp`, `book/<SRC>/…`, `adventure/<SRC>/…`, `objects/tokens/`, `vehicles/tokens/`.
- Fluff and book image paths are relative to this root.

**Schemas and homebrew**
- 5etools-src ships **no** schemas. Its `test/test-json.js` imports them from npm `5etools-utils`, which has `schema/{site,brew,ua}` plus `-fast` variants (MIT).
- `brew/homebrew.json` requires `_meta` with `sources[]`, `dateAdded`, `dateLastModified`, `edition`.
  - Each source entry has `json`, `abbreviation`, `full`, `authors`, `convertedBy`, `version`, `url`, `color`/`colorNight`.
  - Optional `_meta` fields: `spellSchools`, `optionalFeatureTypes`, `featCategories`, `dependencies`, `includes`, `internalCopies`, …
  - After `_meta` come per-type arrays (`monster`, `spell`, `item`, `baseitem`, `race`, `subrace`, `background`, `feat`, `class`, `subclass`, `classFeature`, `subclassFeature`, `condition`, `variantrule`, `table`, …).
- `_meta.edition` is `"classic"` or `"one"`. The schema says "if ambiguous, classic", and BrewUtil defaults to classic.
- Homebrew entities reference their source by its `json` key, exactly like official sources.

**Encounter rules (verified in 5etools' encounter builder)**
- **2014 (DMG p.82):** per-character Easy/Medium/Hard/Deadly XP thresholds, plus a monster-count multiplier [1, 1.5, 2×4, 2.5×4, 3×4, 4]. Fewer than 3 PCs → next multiplier up; 6 or more PCs → next one down (0.5 for a single monster). A daily XP budget also applies.
- **2024 (XDMG p.114):** per-character Low/Moderate/High XP budgets with **no multiplier**. Level 1: 50/75/100 … level 20: 6400/13200/22000.
- CR→XP is shared. Monster `cr` can be `{cr, lair, coven, xp, xpLair}`.

---

## Stack (recommended)
| Layer | Choice | Why |
|---|---|---|
| Repo | pnpm workspaces, TS strict, Node 24, Vitest, ESLint + Prettier | One language, shared packages for client and server |
| Server | **Hono** on Node (`@hono/node-server`), zod validators using the shared DTO schemas | Small, explicit API boundary. Visibility enforcement is easy to audit, and image/upload/SSE routes are easy to write. One long-lived process keeps the index warm. |
| Web | **Angular** (latest stable, checked at install): standalone components, signals + `resource`/`httpResource`, zoneless change detection, new control flow, Angular Router (lazy routes), Angular CLI application builder (esbuild/Vite dev server with a proxy to Hono). UI: Tailwind v4 + Angular CDK (overlay, drag-drop, virtual scroll, a11y, listbox), plus `@angular/aria` headless widgets if stable at install, otherwise Angular Material. Forms: typed Reactive Forms, or Signal Forms if stable. Tests: Vitest (Angular's default runner). | You chose Angular. It's a client-rendered SPA behind a login, so SSR isn't needed. The server serves the production build as static files. CDK covers hover previews, drag-reorder, virtual lists and the Cmd-K palette without extra libraries. |
| API client | A typed Angular `ApiService` over HttpClient. Request/response types come from shared zod DTOs in `packages/shared`, the same ones the Hono validators use. An interceptor handles auth/401. | A single source of types for client and server, and it fits Angular's idioms (interceptors, `httpResource`). |
| App DB | **Drizzle ORM + better-sqlite3**, drizzle-kit migrations; Postgres schema in the final milestone | Typed, lightweight, SQLite by default. App tables use only portable types. |
| Search/reference index | Separate rebuildable `DATA_DIR/index.sqlite` with **FTS5** | A derived cache: official + homebrew entities, plus page text (DM and player variants). It stays SQLite even when the app DB is on Postgres. |
| Schemas | `5etools-utils` (MIT) brew-fast schemas + Ajv 2020 | Exact 5etools validation, plus the edition source lists |
| Misc | CodeMirror 6 (JSON + entries strings), fast-json-patch (revision diffs), fractional-indexing, file-type + sharp (uploads), @node-rs/argon2 | |

**Block editor evaluation → TipTap v3 (ProseMirror) with `ngx-tiptap`**

Angular rules out two candidates: BlockNote and Plate are React-only.
- **TipTap/ProseMirror (chosen).**
  - The core has no framework dependency. `ngx-tiptap` (MIT) provides the Angular editor directive and `AngularNodeViewRenderer`, so custom blocks are Angular components.
  - If `ngx-tiptap` lags behind the current Angular version, the fallback is plain ProseMirror NodeViews that mount Angular components via `createComponent`.
  - MIT core. TipTap open-sourced DragHandle, UniqueID and Details in 2025; I'll confirm at install, and if any is still paid I'll write a small ProseMirror plugin instead.
  - Its strict schema content expressions (`columns: column{2,4}`, `tabs: tab+`, a `secret` container with `block+`) handle our nested layout blocks robustly.
  - The same schema runs headless on the server, so we can validate stored docs.
  - The most mature collaboration path: Yjs via y-prosemirror/Hocuspocus, both MIT.
  - Cost: we build the slash menu (Suggestion util + CDK overlay) and the block side menu ourselves.
- **BlockNote, Plate:** React-only, so they're ruled out for Angular. BlockNote's multi-column is also GPL-3.0/commercial.
- **Lexical:** the core has no framework dependency, but there are no maintained Angular bindings. Columns and collapsibles exist only as React playground code.
- **Editor.js:** framework-agnostic and stores block JSON, but nesting is weak and it has no collaboration story.
- **Plain JSON + our own editor:** contenteditable, selection, IME and undo would take months.

---

## Architecture
```
apps/server   Hono API, auth, Drizzle (app DB), indexer runner, /img + /uploads routes, SSE (tracker)
apps/web      Angular SPA (Angular CLI project inside the pnpm workspace; packages consumed via TS path mappings):
                core/ (auth, ApiService, RulesetService, CampaignContext), reference/ (browser + renderer
                components: entries AST, tags, statblocks classic + 2024, hover previews via CDK overlay),
                pages/ (TipTap editor, block NodeView components, properties, backlinks), homebrew/,
                templates/, encounters/, tracker/
packages/fivetools  framework-agnostic TS: loader, copy resolver (_copy/_mod/_templates/_versions, safe calc),
                    subrace merge, magic-variant expansion, class-feature refs, tag tokenizer → AST,
                    entry normalization (render model), dice parser, edition resolver, rulesets (2014/2024),
                    CR/XP + encounter math. The server and the Angular renderer use the same code.
packages/blocks     block-doc zod schema, block registry core (framework-agnostic half), visibility projection,
                    text/link/entity-ref extraction, unknown-block preservation
packages/templates  template schema + migrations, {{var}} parser, typed substitution, inheritance, linked render
packages/shared     DTOs, ids (uuidv7), errors
scripts/            data-clone.sh, data-update.sh (git pull --depth 1 --ff-only, then `pnpm index`)
```

**Edition resolver** (`packages/fivetools/src/edition/`)
- `classifySource(src)` checks, in order:
  1. A homebrew source's declared edition.
  2. The `5etools-utils` sourcesClassic/sourcesModern lists.
  3. The `published` date against XPHB's.
  4. Otherwise classic, with a warning.
- An optional `edition-overrides.json` corrects individual sources.
- `entityEdition(e)` = `e.edition ?? classifySource(e.source)`.
- The campaign policy is `{ruleset, sourceOverrides, crossEdition}`.
  - Sources in the campaign's edition are enabled by default. Overrides are stored, so sources added in a data update get defaults automatically.
  - `crossEdition` is labelled "Allow legacy (2014) content" in 2024 campaigns and "Allow 2024 content" in 2014 campaigns. When it's on, the other edition's sources become toggleable, and their items show a "Legacy" or "2024" badge.
  - Homebrew marked `any` is always edition-compatible.
- **Reprint groups** are the connected components over `reprintedAs`, both string and `{uid, tag}` forms.
  - List and search show one member per group: in-edition first, then the newest.
  - The others stay reachable by link or tag and show "Also printed as X (XPHB) →".
  - Example: a 2014 campaign shows PHB Fireball and hides XPHB Fireball even when cross-edition is on.

**Ruleset abstraction** (`packages/fivetools/src/ruleset/`)
- A `Ruleset` interface:
  - terminology (Race vs Species, …)
  - `characterOptions` (background ability scores and feat, species ASI)
  - `features.weaponMastery`, exhaustion model
  - `encounter.computeDifficulty(party, creatures)`
  - `xpForCr`, `canonicalRef(key)` (e.g. `condition:poisoned` → PHB or XPHB uid)
  - `statblockStyle`
- The UI injects `RulesetService` (a signal of the current campaign's `Ruleset`). An ESLint `no-restricted-syntax` rule bans `'2014'`/`'2024'` literals outside `ruleset/` and `edition/`, and angular-eslint template rules apply too.
- The "Migrate edition" action does a dry run first:
  - It lists every reference: refEmbeds, tags in pages, NPC statblocks, encounters, inventory, character refs.
  - It proposes a mapping through the reprint groups and flags anything unmapped.
  - On confirmation it rewrites the references, resets source defaults, and logs the migration.

**Indexing pipeline** (`pnpm index`, also run at startup and from the admin "Re-index" button)
1. Fingerprint every data file (size+mtime, then sha1 if changed) and compare with `file_state` plus the indexer version. If nothing changed, skip (target < 1 s).
2. If something changed, load all raw JSON into memory.
3. Expand `_versions`, subraces and magic variants, then resolve `_copy` lazily with memoization and cycle detection. A missing parent keeps the raw entity and logs a warning.
4. Resolve fluff the same way.
5. Compute the summary columns (CR, type, level, school, rarity, …), the image and token path, and the edition.
6. Diff-upsert `entity` rows by resolved-hash, then update `entity_fts`.
7. Homebrew entities go through the same resolver against official + homebrew data. They're re-indexed on save, together with their dependents (entities whose `_copy` targets them).

`index.sqlite` tables:
- `meta`, `file_state`
- `source(id, name, abbr, group, published, edition, legacy, kind, origin, homebrew_source_id)`
- `entity(uid, kind, name, source, page, edition, flags, reprint_group, summary_json, data_json, raw_json, fluff_json, image_path, token_path, origin, homebrew_entity_id)`
- `entity_fts`, `entity_alias`
- `page_search(campaign_id, page_id, title, text_dm, text_player, visibility…)` + FTS

**Reference rendering**
- The tag tokenizer turns strings into an AST. Recursive Angular components (`cn-entry`, `cn-inline`) render that AST through template interpolation only. A lint rule bans `[innerHTML]` and `bypassSecurityTrust*` everywhere in the app.
- Entity-link tags become router links with hover popovers (`/api/ref/:kind/:source/:name`).
- `{@filter}` opens the browser with those filters applied.
- `{@book}`/`{@adventure}` render as a source/section badge. A book reader is out of scope for v1.
- Unknown tags render their display text. Unknown entry types render a labelled placeholder plus their best-effort child text. Neither ever crashes.

**Images:** `GET /img/*` serves only from `FIVETOOLS_IMG_PATH`.
- Path safety: resolve the path and check the prefix, `realpath` it and re-check the prefix (blocks symlink escape), and allow only image extensions.
- SVG is served with `CSP: sandbox` and `nosniff`.
- Caching: ETag plus `Cache-Control: public, max-age=86400`.
- If an image is missing, the client shows a placeholder.

**Uploads:** stored at `DATA_DIR/uploads/<id>`.
- Checked by magic bytes (png/jpeg/webp/gif, no SVG), with a configurable size limit.
- sharp strips metadata and makes thumbnails.
- Served via `/api/uploads/:id` to campaign members only. IDs are unguessable and appear only in content the viewer is already allowed to see.

---

## Data model (app DB)
```
user(id, username, display_name, password_hash, is_admin, created_at)
session(id, user_id, expires_at)
campaign(id, name, description, cover, ruleset, cross_edition, house_rules_doc, status, created_by, …)
campaign_member(campaign_id, user_id, role dm|player)          campaign_invite(token_hash, campaign_id, role, expires_at, max_uses, uses)
campaign_source_override(campaign_id, source_kind official|homebrew, source_ref, enabled)
campaign_template_default(campaign_id, page_type, page_template_id)    edition_migration(campaign_id, from, to, report_json, by, at)

page(id, campaign_id, parent_id, sort_key, type, title, icon, cover, visibility dm|all|selected,
     body_doc json, revision, from_page_template_id, from_page_template_version, created_by, updated_at, deleted_at)
page_viewer(page_id, user_id)           page_tag(page_id, tag)
property_def(id, campaign_id, key, label, type text|number|select|multiselect|date|checkbox|pageLink|refLink|url,
             options_json, applies_to_types, dm_only, sort)
page_property_value(page_id, property_def_id, idx, value_text, value_num, value_bool, value_date, value_page_id, value_ref_json)
page_link(from_page_id, to_page_id, block_id, kind mention|embed|property)          -- derived on save → backlinks
entity_reference(target_uid, target_homebrew_entity_id, referrer_kind, referrer_id, block_id)  -- derived → "used in"

-- typed facets (1:1, PK = page_id); their fields are exposed as built-in properties to the property panel + query engine
npc_facet(page_id, statblock_uid, statblock_homebrew_entity_id, faction_page_id, location_page_id, status, attitude)
location_facet(page_id, parent_location_page_id, kind world|region|settlement|site|room|other, map_upload_id)
session_facet(page_id, number, date, status planned|played, summary)
quest_facet(page_id, status rumor|active|completed|failed|abandoned, giver_page_id, priority)
faction_facet(page_id, status, attitude, headquarters_page_id)
character_facet(page_id, player_user_id, player_name, classes_json[{class_uid, subclass_uid, level}], species_uid,
                background_uid, hp_max, hp_current, hp_temp, ac, speed, abilities_json, passive_perception, inspiration)
item_facet(page_id, item_uid, item_homebrew_entity_id)

inventory_item(id, campaign_id, owner_kind party|character, owner_page_id, item_uid, homebrew_entity_id, custom_name,
               quantity, attuned_to_page_id, identified, awarded_session_page_id, notes)
currency(campaign_id, owner_kind, owner_page_id, cp, sp, ep, gp, pp)
encounter(id, campaign_id, name, notes_doc, location_page_id, creatures_json[{uid|homebrew_entity_id|npc_page_id, count, overrides}],
          party_json{mode campaign|custom, character_page_ids, levels})
initiative_tracker(id, campaign_id, encounter_id, status, state_json{round, turn, combatants[{id, kind, ref, name, init,
                   hp, hp_max, temp, ac, conditions[{uid, rounds}], hidden_from_players, notes}]}, updated_at)

homebrew_source(id, json_id, abbreviation, full_name, authors_json, version, edition 2014|2024|any, color, url,
                meta_extra_json /* spellSchools, featCategories… for round-trip */, scope private|campaigns|instance,
                owner_user_id, campaign_id /* auto "campaign-only" source */, deleted_at)
homebrew_source_share(source_id, campaign_id)
homebrew_entity(id, source_id, entity_type, name, data_json /* raw 5etools shape, may contain _copy */, fluff_json,
                current_revision, created_by, updated_at, deleted_at)        UNIQUE(source_id, entity_type, lower(name)) live rows
homebrew_revision(id, entity_id, rev_no, data_json, fluff_json, diff_json /* RFC6902 */, author_user_id, created_at, message)

block_template(id, scope global|user|campaign, owner_user_id, campaign_id, builtin_key, name, description, icon, tags_json,
               version, schema_version, variables_json, content_json, duplicated_from_id, deleted_at)
block_template_version(template_id, version, variables_json, content_json, created_at)
page_template(id, scope, owner_user_id, campaign_id, builtin_key, name, description, icon, page_type, extends_template_id,
              version, schema_version, defaults_json{icon, cover, visibility, tags}, properties_json[{key, label, type, options,
              required, default, dm_only}], variables_json, body_json, children_json[{title, page_template_id | inline}])
page_template_version(...)
template_usage(template_kind, template_id, page_id, block_id, version, mode linked|copy)
upload(id, campaign_id, owner_user_id, filename, mime, size, sha256, width, height, created_at)
```
- Campaign-only homebrew goes into an auto-created hidden source per campaign, so a one-off monster takes a single "Quick create" click.
- An NPC built by "clone & customize" a bestiary statblock becomes a `_copy` homebrew entity in that source, and `npc_facet.statblock_homebrew_entity_id` points at it.
- References from app data store both the uid (kind|name|source) and the `homebrew_entity_id`.
  - Renaming a homebrew entity adds an `entity_alias` and offers "update references".
  - Deleting is soft: references keep resolving, with a "deleted" badge.

---

## Block document schema (v1, ProseMirror JSON of our own schema)
```jsonc
{ "schemaVersion": 1, "type": "doc", "content": [ Block… ] }
Block  = { "type": "<registered>", "attrs": { "id": "blk_…", "visibility": "inherit"|"dm", "revealed": false, …typeAttrs },
           "content"?: [Block | Inline] }
Inline = {"type":"text","text":"…","marks":[{"type":"bold"|"italic"|"underline"|"strike"|"code"|"highlight"}|
                                            {"type":"link","attrs":{"href":"https://…"}}]}   // http/https/mailto only
       | {"type":"pageLink","attrs":{"pageId":"…","label":"…"}}                             // [[page]]
       | {"type":"refTag","attrs":{"tag":"spell","uid":"fireball|xphb","display":null}}     // {@spell …}
       | {"type":"dice","attrs":{"kind":"dice|damage|hit|dc|d20","expr":"2d6+3","display":null}}
       | {"type":"placeholder","attrs":{"var":"dc","valueType":"number"}}                  // unfilled template field
       | {"type":"hardBreak"}
```
**Block types**
- Text: `paragraph`, `heading{level}`, `bulletList`/`orderedList`/`listItem`, `taskList`/`taskItem{checked}`, `blockquote`, `divider`, `callout{tone, icon}`
- Callouts and secrets: `readAloud`, `secret` (container, always DM)
- Tables: `table{roll?:{dice, column}}` with rows/cells (a roll button picks a row by range), `statGrid{items[{label, value: Inline[]}]}`
- Media: `image{src:{upload id | 5etools path | url}, caption}`, `gallery`
- Embeds: `refEmbed{ref:{kind, uid, homebrewEntityId?}, display full|compact}`, `pageEmbed{pageId, mode card|inline}`, `query{filter{types, tags, props[{key, op, value | {$ctx:"currentPage"}}], parent}, sort, view list|table|cards, columns}`
- Layout: `columns > column` (2–4), `details{open}` (summary + body), `tabs > tab{title}`
- Game: `encounter{encounterId}`, `loot{items[{uid|homebrewId|custom, qty, note}], currency}`
- Templates: `templateInstance{templateId, version, values, detached}` (a linked block template, read-only in the editor; edit the values or detach)
- `unknownBlock{raw}` keeps any unrecognized JSON losslessly.

**Registry contract** (`packages/blocks` plus the web half):
- Each `BlockType` has two halves.
  - The framework-agnostic half (`packages/blocks`): `{name, attrsSchema (zod), pmSpec (TipTap node config), project(viewer) → keep | strip | transform, extractText, extractLinks, substitute(values)}`.
  - The Angular half (`apps/web`): `{editorComponent (NodeView via ngx-tiptap), rendererComponent (read-only), slashItem}`.
- New block types register with the registry; the core never changes.

**Visibility projection** (`projectPageForViewer`, server only)
- This one function backs every endpoint that returns page content: page GET, embeds, query results, search snippets, backlinks, exports.
- What players never receive:
  - pages they can't see
  - blocks with `visibility:"dm"` and `revealed:false`, and their whole subtree
  - DM-only properties and facet fields
  - links to invisible pages (sent as plain label text instead)
  - hidden tracker combatants (monster HP shown as status words)

---

## Template engine (`packages/templates`)
**Placeholders**
- Syntax: `{{name}}`, `{{dc: number = 13}}`, `{{creature: reference<monster>}}`.
- Types: text, number, boolean, select(…), date, dice, pageLink, `reference<kind>`.
- The first declaration of a variable normalizes into `variables_json`. `\{{` escapes.
- There are no expressions and no code: a single regex-free tokenizer does the substitution.
- Attribute bindings use `{"$var":"creature"}` inside block attrs (e.g. a `refEmbed.ref`).
- `{"$rulesetRef":"condition:poisoned"}` resolves per campaign ruleset, which is what makes the starter templates edition-aware.

**Insert modes**
- Fill now: values are validated and typed, then substituted.
- Leave as fields: values become `placeholder` inline nodes.
- Insert as copy: plain blocks.
- Insert as linked: a `templateInstance` block, recorded in `template_usage`.

**Template updates**
- Editing a template bumps its `version` and stores a `*_version` row.
- Linked instances re-render from the new version plus their stored values.
- The editor shows the "used in" pages before you save.

**Page templates**
- Resolution walks the `extends` chain: properties merge by key, and the body is appended or replaced.
- Then: prompt for variables and required properties, create the page with its facet defaults, and create child pages recursively (depth limit and cycle guard).
- "Apply template" to an existing page adds missing properties and appends blocks without overwriting anything.

**Library and migrations**
- Scopes: global (built-in, read-only), user, campaign. "Duplicate to user/campaign" copies down.
- Export format: `{"format":"critical-notes/template"|"…/template-library", "schemaVersion":1, …}`, with a `migrations[n→n+1]` registry. Imports from a future version are rejected with a clear message.

**Built-ins** (JSON in the repo, upserted at startup by `builtin_key` and version): NPC, Location, Settlement, Dungeon room, Quest, Faction, Session prep, Session recap, Shop, Trap, Random encounter table, Magic item handout, Player handout.

---

## Homebrew
**Types:**
- First: monster, spell, item, baseitem, feat, race/subrace (shown as "Species" in 2024 campaigns), background.
- Then: condition, variantrule, table.
- Later: class/subclass/classFeature/subclassFeature.

**Save pipeline**
1. Light zod check.
2. Ajv validation against `homebrew.json` (from 5etools-utils brew-fast), using a synthetic `{_meta, <type>:[entity]}`. Errors are mapped to JSON paths.
3. App-level checks: required fields, valid CR, a valid dice grammar, source exists.
4. Broken `{@tag}` targets come back as **warnings**.
5. A name collision with official or other homebrew content in a different source is a warning. The same source+type+name is an error.
6. Resolve `_copy`, write a revision with a JSON-patch diff, re-index the entity and its dependents.

**Editors**
- A form editor per type, driven by a field spec, with a live preview through the real renderer. The client resolves `_copy` against the fetched base entity.
- A CodeMirror JSON editor with schema errors. Toggling form↔JSON keeps unknown fields.
- The **entries editor** is a structured card list (string paragraph / entries / list / table / inset / readaloud / quote / raw-JSON card).
  - Strings are edited in CodeMirror with a toolbar (b/i, dice, damage, dc, hit, reference).
  - Typing `{@` triggers autocomplete: tag type first, then an entity search that always inserts an explicit `|SOURCE`.
  - Round-trips are lossless.
- "Start from existing" either clones in full, or creates a `_copy` variant that stores only the diff.

**Import/export**
- Import accepts a file, multiple files or folder (directory picker), or a URL.
  - URL fetching is server-side, http/https only, blocks private IPs, and has size and time limits.
  - Edition: `_meta.edition` classic → 2014, one → 2024; if it's missing, the user picks (default classic).
  - Unknown types and fields are reported and kept where possible. Each entity is wrapped in its own try/catch, so one bad entity never crashes the import.
- Export is valid 5etools homebrew: `_meta.sources/dateAdded/dateLastModified/edition` (`any` → `classic`), merged with `meta_extra_json`. Tests validate it against the schema.

**Sharing:** private (owner), shared with specific campaigns, instance-wide (admin only), or campaign-only.

---

## Milestones
Each milestone ends with `pnpm -r typecheck && pnpm lint && pnpm test`, then a summary of what works and what's left. Tests use a **synthetic mini 5etools fixture** (invented entities, no copied content). The optional real-data smoke tests run when `FIVETOOLS_SRC_PATH` is set: index everything, resolve every `_copy`, render every entity without throwing.

- **Step 0.**
  - **First action after approval:** save this plan to `docs/PLAN.md` in the project, unchanged. After each milestone, update its status there (done / what's left), so the repo always carries the current plan.
  - Create `5etools-data/` in the project.
  - Write the ignore files first (`.gitignore`, `.dockerignore`, `.vscode/settings.json` watcher and search excludes), then `git init`.
  - Clone `5etools-src` and `5etools-img` (`--depth 1`) into `5etools-data/`.
  - Re-run the survey scripts against the fresh clones and write `DATA_NOTES.md`.
  - Show it to you.
  - Add `.env.example` (FIVETOOLS_SRC_PATH=./5etools-data/5etools-src, FIVETOOLS_IMG_PATH=./5etools-data/5etools-img, DATA_DIR=./var, APP_SECRET, PUBLIC_URL).
  - `scripts/data-clone.sh` and `scripts/data-update.sh` target the same folder by default.
- **(a) Scaffold + indexing + edition resolver.**
  - Workspace, lint rules (including the edition-literal ban), `packages/fivetools`: loader, copy resolver (all mod modes, safe `calculateProp`, `_templates`, `_preserve`, variables), `_versions`, subraces, magic variants, class-feature refs, fluff, edition resolver, reprint groups, rulesets (skeleton), `index.sqlite` builder with incremental diffing.
  - Scripts: `pnpm data:clone|data:update|index`.
  - Tests: resolver matrix (2014/2024 × cross-edition × source toggles × homebrew `any`), reprint grouping, every mod mode, homebrew `_copy` of an official entity, cycles and missing parents, no-op re-index speed.
- **(b) Reference browser.**
  - Tag tokenizer and renderer (all entry types and tags, with graceful unknowns).
  - Statblocks: classic and 2024 monster, spell, item, species, background, feat, condition, class/subclass with features by level, plus a generic fallback.
  - Hover previews, virtualized filtered lists per kind, detail pages, images with fallback, `/img` route.
  - Cmd-K search (reference-only for now). A temporary "campaign context" picker drives edition filtering.
  - Tests: tag parsing and rendering snapshots, path-traversal tests.
- **(c) Core app: auth basics + campaigns + page core + facets.**
  - Login/session, first-run admin, campaign CRUD/archive, ruleset choice, source toggles, house rules.
  - Page tree (nested, drag-reorder, fractional keys), page types, facets, and the dedicated views (NPC list, location tree, session log, quests, factions, party/character summary sheet). These are views over the same records.
  - NPC "clone statblock from bestiary → customize" (campaign `_copy`).
  - The page body uses a basic TipTap editor (text blocks) at this stage.
- **(d) Block editor + properties + backlinks.**
  - Full registry and every block type above.
  - Slash menu, drag handle, nesting, keyboard shortcuts.
  - `[[` autocomplete with page creation, `{@` reference inline nodes, inline dice.
  - Property defs and values UI, query block engine (SQL compiled from the filter DSL), backlinks panel, page search indexing (DM and player text), optimistic concurrency (revision → 409 + reload/merge prompt).
- **(e) Homebrew.**
  - Sources, scopes and sharing, campaign-only quick create.
  - Form, JSON and entries editors with live preview, start-from-existing, validation, revisions and restore, used-in + soft delete, import (file/folder/URL) and export.
  - Tests: import/export round-trip, schema-validity of the export, never-crash import on malformed files, collision warnings.
- **(f) Templates.**
  - Block and page templates, variables, both insert modes, linked propagation with used-in, detach, inheritance, child pages, apply-to-existing, per-type campaign defaults, library UI, import/export with migrations, the 13 built-ins working in both editions.
  - Tests: substitution, typed validation, propagation, inheritance merge, migration.
- **(g) Encounters + initiative.**
  - Builder: add monsters, NPCs and PCs, with difficulty from the ruleset (both methods, including multipliers and party-size adjustments, 2024 lair XP).
  - Encounter block "send to tracker".
  - Tracker: turn order, HP/temp HP, conditions with durations, hidden combatants, keyboard controls, SSE player view.
  - Loot block → award to inventory with a session link; party inventory and attunement (3 slots).
- **(h) Roles, visibility, invites, export/import.**
  - Campaign roles (DM, co-DM, player), invite links, players can edit their own PC.
  - `projectPageForViewer` applied everywhere, plus a **sentinel crawl test**: seed DM-only strings across pages, blocks, properties, facets, tracker and homebrew, then GET every player-reachable endpoint and assert none of the strings appear.
  - Campaign export/import as a zip: `campaign.json` (pages, characters, encounters, templates, homebrew sources as 5etools docs) + uploads, with ID remapping.
  - The "migrate edition" flow.
- **(i) Docker + docs + Postgres.**
  - Multi-stage Dockerfile (non-root).
  - docker-compose: the app, plus read-only mounts `./5etools-data/5etools-src:/data/5etools-src:ro` and `./5etools-data/5etools-img:/data/5etools-img:ro`, plus a data volume. A `tools` profile adds a `data-update` service that mounts the same folders read-write.
  - Postgres Drizzle schema + migrations, with a table/column parity test.
  - Playwright smoke flows.
  - README: setup, cloning data, config, updating data, writing homebrew, using templates, an architecture overview, and **licensing**. 5etools code is MIT. Content and art belong to WotC and the artists and are not redistributed; SRD 5.1/5.2 portions are CC-BY-4.0; users must own their books.
  - `docs/ARCHITECTURE.md` with the ER diagram (mermaid).

---

## Verification
- `pnpm -r typecheck && pnpm lint && pnpm test` passes after every milestone.
- `pnpm index` on the real v2.37.x data completes, and a second run is a no-op in under 1 s. Every entity resolves and renders in the smoke test, and warnings are counted, not thrown.
- Manual checks with `pnpm dev`:
  - In a 2014 campaign, `PHB Fireball` is shown, not XPHB.
  - A 2024 campaign shows "Species".
  - Turning cross-edition on adds badges.
  - The encounter difficulty matches hand-computed DMG and XDMG examples.
- As a player account:
  - A secret block is absent from the network response (check DevTools), from search and from the export.
  - A revealed block appears.
- `docker compose up` serves the app, art loads through `/img`, and `data-update` followed by a re-index works.

---

## Status

| Milestone | State | Notes |
|---|---|---|
| Step 0 | ✅ done (2026-10-08) | Fresh clones (src + img v2.37.0) in `5etools-data/`; `DATA_NOTES.md` written. Upstream was v2.37.0, not v2.9.1. |
| (a) Indexing + edition resolver | ✅ done (2026-10-08) | `packages/fivetools` (copy resolver, versions, subraces, magic variants, edition policy, reprint groups, rulesets, tags) + `apps/server` indexer (`pnpm index`). Real data: 19,402 entities, cold build ≈6 s, no-op re-run ≈16 ms. 85 tests. |
| (b) Reference browser | ✅ done (2026-10-08) | Reference API: lists with reprint de-duplication, entity detail with reprint group and preferred printing, FTS search, autocomplete, `/img` with traversal and symlink protection. Angular UI: renderer for every entry type and tag, 2014 and 2024 monster statblocks, spells, items, species, backgrounds, feats, class pages (feature table plus subclass picker). Also: hover previews, filterable virtual lists, Cmd-K search, preview rules context with source toggles, dice roller with log, dark mode, tablet layout. 120 + 7 tests. |
| (c) Core app: auth, campaigns, pages, facets | ✅ done (2026-10-08) | Local accounts: first-run admin setup, argon2id, httpOnly session cookies, login rate limit, origin/JSON CSRF guard. Campaigns: ruleset chosen at creation, source overrides, cross-edition, archive, house rules, auto-created campaign-only homebrew source. Pages: tree with fractional sort keys, drag-and-drop, cycle-safe moves, soft-deleted subtrees, typed facets with validated page links, optimistic concurrency (409). Views over the same records: NPCs, locations tree, session log, quest board, factions, party. NPC statblocks: link a bestiary entry, or clone it as campaign homebrew (`_copy`) and edit it, with revision history and relinking on rename. Reference lookups follow the campaign's rules and its allowed homebrew. Basic TipTap body editor. 141 + 7 tests and an end-to-end browser run. |
| (d) Block editor, properties, backlinks | ✅ done (2026-10-12) | `packages/blocks` (registry, sanitizer, player projection, link and text extraction, query DSL). TipTap v3 editor with Angular node views for every block, slash menu, `[[` links with page creation, `{@` reference tags, drag-handle block menu, DM-only and revealed shortcuts. Properties panel, backlinks, page search (DM and player text), image uploads, "Preview as player" through the server projection, campaign pages in Ctrl+K. 162 + 15 tests; browser runs for (c) and (d) pass. |
| (e) Homebrew | ✅ done (2026-10-12) | Sources (private, instance, campaign-only) shared per campaign; validation with the 5etools brew-fast schemas plus app checks (broken `{@tag}` targets, dice, collisions); revisions with restore; soft delete that keeps references resolving; rename aliases; subraces; copy to homebrew (clone or `_copy` variant); import from files, folders or URLs (SSRF-safe) with a per-entity report; schema-valid export. Web: homebrew area, editor with per-type forms, CodeMirror JSON with schema problems at their paths, structured entries editor with `{@` autocomplete, live preview, history, used in. 180 + 22 tests; browser runs for (c), (d) and (e) pass. |
| (f) Templates | ✅ done (2026-10-12) | `packages/templates`: `{{name: type = default}}` tokenizer, typed values, substitution (dice → `{@dice}`, references → tags, page links), `$var` / `$rulesetRef` / `$rulesetTag` bindings and `{{rules.*}}` terms per edition, page-template inheritance with cycle guard, export format with a migrations registry, 13 built-ins tested in both editions. Server: library (built-in, personal, campaign), versions with optimistic concurrency, linked instances re-rendered on template save, pages from page templates (properties, facet defaults, child pages), apply to an existing page, per-type campaign defaults, usage, import/export. Web: library, template editor (content in the block editor, live fields panel, page settings), "/ → Template…" insert (fill, fields or linked), "Edit values" and "Detach" on linked blocks, new page from template, apply template, defaults in campaign settings. 207 + 26 tests; browser runs for (c)–(f) pass. |
| (g) Encounters, initiative, loot | ✅ done (2026-10-13) | Encounter builder (bestiary monsters, NPC statblocks, custom creatures, lair XP, the campaign's characters or custom levels) with difficulty from the ruleset (2014 multipliers and party-size steps, 2024 budgets). Initiative tracker: a pure, tested reducer (`@cn/shared`) applied in order on the server, turn order and rounds, HP and temporary HP, conditions with durations, hidden combatants, keyboard controls, live updates over SSE, and a full-screen player view that only ever receives the projection (no hidden creatures, notes or monster HP; health words instead). Ending combat writes PC hit points back. Encounter blocks (never sent to players) and loot blocks that award once to the party or a character; party and character inventories with coins, stacking, identification and the 3-item attunement limit. 224 + 29 tests; browser runs for (c)–(g) pass. |
| (h) Roles, visibility, export | ✅ done (2026-10-13) | Roles (DM, co-DM, player), `VisibilityService`, the player projection on every content route, players editing their own PC (merged around hidden blocks), invites (hashed tokens, expiry, uses) and invite-only registration, members and roles, player inventory rules (unidentified items hidden), campaign export/import zip with id remapping, edition migration dry run and apply. Web: role-aware shell, routes (`gmGuard`), editor and settings; invite page; campaign import. Sentinel crawl test over 40+ player responses; `smoke-h.mjs` 11/11 checks every response the player's browser receives. Gate: 240 + 40 tests. Details in [STATUS.md](STATUS.md). |
| (i) Delivery | ✅ done (2026-10-13) | Uploads re-encoded with sharp (metadata stripped, thumbnails). Bundled server build (esbuild). Multi-stage Dockerfile (non-root) and docker-compose with read-only 5etools mounts and a `tools` profile for data updates. Postgres schema and migrations with a parity test that applies both migration sets (PGlite). Playwright tests (52) in place of the smoke scripts, passing against the bundle and the Docker image. README with licensing, `docs/ARCHITECTURE.md` with the ER diagram. Details in [STATUS.md](STATUS.md). |
| After the plan: MCP server | ✅ done (2026-10-13) | Personal API tokens (Account page), `/mcp` with 32 tools over the REST API in-process, page and template text as Markdown with lossless reconcile. Details in [STATUS.md](STATUS.md). |
| After the plan: release 1.0 (PRD section 8, tasks in [PROJECT.md](PROJECT.md)) | feature complete (2026-10-21); release gate open | M1 license (Apache-2.0, DCO, no CLA). M2 accounts: Account page, admin Users page, one-time reset links (`/reset#<token>`), `admin.mjs reset-link`, rate limits. M3 backups: one-zip instance backup with an online SQLite copy, Admin > Backups, scheduled backups (on in the shipped compose, 24 h, keep 7), CLI-only restore with a rollback and a restore drill, README guide. M4 trash: soft delete with Undo, Trash view for DMs and co-DMs, deleted templates list, purge after 30 days, MCP `list_trash` and `restore_page`. M5 release process: CI, a tag-triggered release workflow publishing `ghcr.io/merilairon/critical-notes`, app version in `/api/health` and the Account page, `CHANGELOG.md`, `docs/RELEASE.md`, README "Updating". M6 phone width: compact header and drawer below 1024 px, player content views, a `phone` Playwright project. Still to do: pen test, accessibility pass, release candidate, owner approval. See [STATUS.md](STATUS.md). |

### Deviations and findings
- TypeScript is pinned to 6.0.x: Angular 22 does not support TypeScript 7 yet.
- pnpm 11 uses `allowBuilds` in `pnpm-workspace.yaml` instead of `onlyBuiltDependencies`.
- `_copy` parents need a per-type identity key (subclass, class/subclass features, deity, card, item types/properties, subrace, magic variants). It lives in `packages/fivetools/src/kinds.ts`.
- Generic magic variants carry their source in `inherits.source`. Specific variants get *derived* reprint links (e.g. `+1 Longsword|DMG` → `+1 Longsword|XDMG`) instead of inheriting the generic variant's link.
- Class features are indexed as their own entities. The class detail API (milestone b) assembles them.
- 22 of 3,545 reprint links point at entities that don't exist in the data (XDMG rules that exist only as book sections, MPMM cults). The UI shows them as unavailable.
- `pnpm` scripts run on Node 24.15.0 through `devEngines.runtime` in the root `package.json`. The Angular CLI requires Node 24.15 or later, but Volta's pnpm shim ran an older Node.
- Angular critical-CSS inlining is turned off. It uses an inline `onload` handler, which the CSP (`script-src 'self'`) blocks.
- Rendering logic is UI-independent (`packages/fivetools/src/render`: inline render tree, dice, statblock formatters), so most of it is unit-tested without a browser.
- `_versions` variants (e.g. "Mage (Familiar)") inherit `reprintedAs` but are excluded from reprint grouping. Otherwise they competed with their parent in lists, which an end-to-end run caught.
- Homebrew visibility is part of `CampaignPolicy` (`homebrewSources`). Homebrew a campaign isn't allowed to use never shows up in lists, search, entity detail or the source list.
- Reference routes and `/img` require a signed-in user (the content is copyrighted, so it is never served publicly).
- (d) The query DSL is evaluated in memory over the campaign's live pages instead of being compiled to SQL. That is fine at campaign scale; revisit with Postgres in (i).
- (d) The planned `refTag` and `dice` inline nodes are one `tag {markup}` inline node that reuses the 5etools tag renderer, so dice are `{@dice …}` tags. The `divider` block is TipTap's `horizontalRule`.
- (d) Uploads are checked by magic bytes but not yet re-encoded with sharp (no metadata stripping or thumbnails). Planned for (e) or (i).
- (d) The server runs from TypeScript through `tsx` (also with `NODE_ENV=production`). A bundled server build comes with the Docker work in (i).
- (e) The editor's live preview resolves `_copy` on the server (`POST /api/homebrew/preview`) instead of in the browser, so it uses exactly the resolver and index the reference uses.
- (e) Entry strings are edited in a textarea with a toolbar and `{@` autocomplete instead of a CodeMirror instance per string; CodeMirror is used for the JSON view.
- (e) Source scopes are private, instance and campaign. "Shared with campaigns" is an explicit campaign list on a private source rather than a separate scope.
- (e) New source ids follow the 5etools homebrew schema (at least 6 characters of `[-a-zA-Z0-9&+!]`, not starting with UA/XUA); the plan's looser format would have produced exports 5etools rejects.
- (e) Outside a campaign, the reference shows the user's own and instance-wide homebrew. Campaign-only homebrew stays inside its campaign.
- (e) Homebrew magic variants are indexed as single items (no expansion across base items).
- (f) One `templates` table (with `kind` and a JSON `definition`) and one `template_versions` table instead of separate block and page template tables. The definitions are validated in code (`@cn/shared` zod schemas, `@cn/templates`).
- (f) Insert modes: "fill" and "leave as fields" both insert plain copies; "linked" is filled and follows the template. Copies are not tracked in `template_usage`; linked instances (derived on page save) and pages created from a page template are.
- (f) Linked instances are updated by rewriting the stored page bodies when the template is saved (so search, the player projection and exports always see current content). A page open in another editor gets the usual 409 on its next save.
- (f) In attributes (stat grid values, captions), an unfilled variable becomes empty: attributes cannot hold field nodes.
- (f) Besides `$rulesetRef`, templates have `$rulesetTag` (a `{@condition …}` tag for the campaign's edition) and `{{rules.*}}` (ruleset terms such as "Race"/"Species").
- (f) The campaign's default template for a page type is applied by the normal page-create endpoint (fields mode); `?template=0` opts out.
- (g) Tracker actions go through one pure reducer (`@cn/shared/tracker`) that the server applies in order, so two DM tabs never overwrite each other; the state is stored as JSON on the tracker row. Live updates use an in-process event hub (one server process; several would need a shared pub/sub).
- (g) Attunement is a flag on an item a character owns (at most 3), not an `attuned_to_page_id`; coins are kept per owner ("party" or a character page); `loot_awards` records awarded loot blocks so the same loot is not handed out twice by accident.
- (g) The encounter difficulty is computed in the browser with the ruleset code (the server resolves names, CR and XP). The DMG 2014 suggestion to ignore much weaker monsters is not applied (5etools' builder does not by default either).
- (g) Ending a combat writes the player characters' hit points back to their pages. The player view is a full-screen route for a second screen; players themselves can open it once (h) lets them into campaigns.
- (h) Roles are `dm` (the owner), `codm` and `player`. A co-DM can do everything a DM can, except manage members and roles, invite co-DMs, and change the edition.
- (h) Players' reference leaves out the campaign-only homebrew source (it is the DM's prep). Homebrew sources shared with the campaign stay visible.
- (h) A player's edit of their character page is merged around the blocks they can't see; a link they keep to a page they can't see stays as plain text.
- (h) Unidentified items show to players as "Unidentified item" (no reference link, no notes); only game masters identify or rename them. Not in the plan; added because the item's identity is DM knowledge.
- (h) The campaign export leaves out trackers. `selected` pages import as DM-only, because their viewers are users of the old instance.
- (h) The edition migration rewrites simple `name|source` tags and uid fields; tags with other layouts (class features) are listed but keep their old target.
- (i) Postgres: the schema, its migrations and the parity test are done, but the app runs on SQLite only. The services use better-sqlite3's synchronous API; running on Postgres needs an async data layer first.
- (i) `APP_SECRET` is gone: nothing is signed (session tokens are random, stored as hashes). Session cookies are `Secure` when `PUBLIC_URL` is https (or `SECURE_COOKIES=1`), not whenever `NODE_ENV=production`, so plain-http LAN installs can sign in.
- (i) The `data-update` service only pulls the clones (in a stock git image, as the user who owns them); the app re-indexes when it restarts, instead of the tools container running the indexer.
- (i) The Playwright tests use the real 5etools data (not the synthetic fixture) and the system Chrome; unit and API tests keep using the fixture.
- (i) The project's own license was not chosen at the time. Decided 2026-10-16 (task M1.2): Apache-2.0, DCO sign-off, no CLA; see `LICENSE`, `CONTRIBUTING.md` and the README "Licensing" section.
- (after the plan) MCP server for AI assistants, at the user's request. Bearer tokens are accepted only on `/mcp`, never on the REST API; the tools call the REST API in-process as the token's user. Page and template text goes through a Markdown dialect (`:::secret`, `:::dm`, `{@tags}`, `[[links]]`…) with placeholder lines for blocks Markdown can't express. Homebrew sources can be created, changed and shared but not deleted through MCP (too much at stake for one tool call). No OAuth yet: clients paste a token.
- (after the plan) Task M2.9: the password reset link is `/reset#<token>` (URL fragment), not `/reset/:token` as the task text says. A fragment is never sent to the server, so the token stays out of the access logs for the page request and out of `Referer`, and out of browser history once the page has stripped it. The page reads it, removes it from the address bar with `history.replaceState` before its first request, and keeps it only in memory. The API call itself still carries it in the path (`/api/auth/reset/:token`), so a reverse-proxy access log can hold a live token until it is used or expires. Raised with the Product Manager and approved by the owner on 2026-10-16 (decision D5 in PROJECT.md).
- (after the plan) Task M3.2: the backup zip has a fourth entry, `checksums.json` (path, size and sha256 of `app.sqlite` and every upload file), written last, beside `manifest.json`, `app.sqlite` and `uploads/` (the task text names three). The hash of a file is only known after it has been streamed, while restore wants the version facts before it extracts anything, so two small JSON files avoid reading the archive twice. It detects corruption and truncation, not tampering (anyone who can alter the zip can recompute it). Decision D7 of docs/design/backup.md, approved by the owner on 2026-10-17 (B1 in PROJECT.md).
- (after the plan) Task M3.2: the manifest has a `trigger` field (`api`, `cli` or `scheduler`: who started the backup), which the task text does not list. Retention reads it: API-created backups younger than 7 days are protected and not counted toward `BACKUP_KEEP`, so a stolen admin cookie cannot rotate every earlier backup out in minutes. It is a required argument of `BackupService.create`, set by the route, the command or the scheduler and never read from a request; an unreadable manifest counts as `api`. Decision D1 of docs/design/backup.md, approved by the owner on 2026-10-17 (B1).
- (after the plan) Task M3.2: the backup reader is not fflate's streaming `Unzip`, which the design (sections 5, 9.1) named. Measured in M3.2: that reader locates the end of a deflate entry that has a data descriptor by scanning for `PK\x07\x08` and `PK\x01\x02`, and deflate stores incompressible data as raw blocks, so random bytes containing the signature fail with `unexpected EOF` at level 1 and level 6 alike (the design's experiment only used repeated, compressible bytes). Every JPEG, PNG and WebP is incompressible, so a real instance would eventually produce a backup that cannot be restored (a 15 MiB image holds the four bytes with probability about 0.4 percent, per file). The design's plan B was taken: `services/backup-zip.ts` reads the central directory with positional reads and inflates each entry with `node:zlib`, with the same gate (`compression === 8` before any byte is read), name allowlist, caps and ratio limits, an end record with comment length 0, entries that tile the file exactly, and the crc and sha256 checks. The format itself is unchanged (standard zip, still written with fflate `ZipDeflate` at level 1, level 6 for the database; `unzip -t`, Python `zipfile` and 7-Zip read it). The writer also writes its own central directory, with zip64 records where needed, because fflate's `Zip.end()` wraps 32-bit offsets and the 16-bit entry count (checked: a 4.6 GB archive and a 200,003-entry archive both verify and extract; Info-ZIP `unzip` 6.0 reports its zip-bomb heuristic on the archive with offsets above 4 GiB and passes with `UNZIP_DISABLE_ZIPBOMB_DETECTION=TRUE`, Python and 7-Zip pass it). A departure from design sections 5 and 9.1 (not from the format), to be raised with the Product Manager and the Security Architect; M3.3 reuses `readBackup` unchanged.
- (after the plan) Task M3.2: the manifest's `uploads.missing` (uploads rows without a main file) is computed from the file listing taken after the database snapshot and before the zip is written, not by a post-check after writing, because `manifest.json` is the first entry and cannot be rewritten. Files that vanish between the listing and the copy are skipped with a warning (`lastWarnings`). The order guarantee (snapshot first, listing after) is unchanged.
- (after the plan) Task M3.2 measurements (design 17), one machine (16 cores, tmpfs under `/tmp`, so no disk limits), `BackupService.create` then `readBackup` extraction and `prepareRestoredDatabase`, uploads incompressible (images): small (6 MiB database, 50 files, 10 MiB): backup 0.6 s, extract 0.06 s; medium (214 MiB database of text, 500 files, 732 MiB): zip 738 MiB, backup 36 s, extract 2.7 s, database preparation 0.5 s; large (21 MiB database, 200 files, 3,000 MiB): zip 3,003 MiB, backup 114 s, extract 7.6 s. Backup throughput is bounded by fflate's JavaScript deflate (about 26 MB/s for incompressible data including the snapshot and the verify pass), well under the design's guess of 100 to 200 MB/s, so a 5 GB instance needs about 3 minutes to back up; restore extraction runs at 400 MB/s. The RTO target (under 15 minutes for 200 MB of database and 5 GB of uploads) holds for restore; the first-start index rebuild is not measured here. Peak RSS growth while backing up 520 MB of uploads: 9 to 12 MiB when garbage is collected as it is produced, 60 to 74 MiB when V8 collects lazily (fflate's output buffers); the largest single write is 64 KiB and the event loop p99 delay is about 19 ms. 200,000 files plus 3: written in 52 s, verified in 10 s, extracted in 20 s.
- (after the plan) Task M3.2: the server test project's `testTimeout` is 20 s instead of vitest's 5 s (`apps/server/vitest.config.ts`). `transfer.test.ts`, `homebrew.test.ts` and `mcp.test.ts` each have one test that takes about 4.1 s on its own, so on a busy machine (a full parallel run with other load) they fail with a timeout although nothing is wrong. The M3.2 backup tests are kept light by default (about 80 MB of uploads, 3,000 written entries); `CN_SLOW_TESTS=1` runs the original sizes (520 MB with RSS and event-loop checks, 66,000 entries with the zip64 end records).
- (after the plan) Task M3.3 deviations from docs/design/backup.md, all small and on the safe side: (1) the restore marker is created with a no-clobber `link()` of a fully written, fsynced temp file instead of `open(..., 'wx')` followed by a write, so it has the same `EEXIST` semantics but is never empty or torn if the process dies in between (a plain `wx` create is the fallback on file systems without hard links). (2) The exclusive probe connection is closed right after the confirmation and the pre-swap check, not held until the end (design 7.1 point 3 admits that the lock protects nothing once the file is renamed). Holding it open made SQLite checkpoint and delete `-wal` by name at close, on files that had been moved away or, in a rollback, moved back, so a rolled-back restore was not byte-identical (it left a changed file and an extra empty `-wal`). Closing it before the first move lets SQLite finish on the real files, so a clean database comes back byte for byte after a rollback; a hot WAL from a crashed server is merged into `app.sqlite` once (the data is the same) and the pre-restore copy is one self-contained file instead of an `app.sqlite` plus a stale `-wal`. From that point the marker (every starting server checks it before AND after opening the database) and the no-clobber install are the protection, as the design says for the time after the first rename. (3) A second lock, `.restore.lock` (an exclusive SQLite lock on a small file, released by the kernel when the process dies), keeps two restores of the SAME zip from both running: without it the second would see the first's marker with an equal sha256 and be taken for a resume, which is dangerous on a wiped instance where the database probe has nothing to lock. (4) `--keep-tokens` requires `--yes`; the design's alternative, an interactive typed confirmation, was not built. (5) Without `--yes` and without a terminal the command exits 64 before the marker and before any staging (the design says after staging): same exit code, no wasted extraction. (6) A restore that fails before the swap removes the marker also when it was left by an earlier crashed run of the same restore that had not yet changed anything live (phase `started` or `staged`, no move list); the design says "only if it created it", which would leave a marker nobody can clear for a bad file. (7) `--check` stages and prepares the database exactly like a restore (extraction, migration check, schema allowlist, integrity, migration of the staged copy), in a temp folder that is deleted, and needs the same free space; the design's "verify budget" is therefore the restore budget. It never probes, writes no marker and no log line. (8) A resumed restore that is already in the `swapping` phase does not open the live database again and does not ask for confirmation; a resume before that point asks again unless `--yes`.
- (after the plan) Task M3.3 mutation checks (the guard is removed, a test must fail; 19 mutations, 18 killed at first, and the one that survived, the stale `-wal`/`-shm` left out of the move list, got a test of its own, `the old -wal and -shm move together with app.sqlite`, which then kills it): no-clobber `link()` replaced by `rename`, racer sweep removed, pre-swap dev/ino check removed, a `rollingBack` marker rolled forward, a different zip accepted for an existing marker, the server-running refusal ignored, `--keep-tokens` without `--yes`, the `index.sqlite` deletion removed, the marker overwritten instead of created exclusively, the uploads symlink check removed, the move list not persisted before the moves, the marker check removed from the top of `main.ts` and from after `openAppDb`, the schema allowlist skipped, the session purge skipped, other commands allowed during a restore, the carry-over disabled, the rollback of the uploads removed, the stale `-wal`/`-shm` left out of the move list.
- (after the plan) Task M3.3 review round 1 (accepted deviation 2 stands, now written into docs/design/backup.md 7.1 and 8): the probe fails closed (exit 78 for anything but a corrupt or not-a-database file; `SQLITE_BUSY*`/`SQLITE_LOCKED*` are "server running"); the root `chown` is `lchown`, skips the old uploads tree and never follows links, `restore-log.jsonl` is opened with `O_NOFOLLOW` and `fchmod` on the descriptor; markers are shape-validated; the marker is re-read under the lock; the probe is always released before the swap; odd live files are refused before the marker exists; design change accepted by the Security Architect: a canonical `sqlite_stat1`/`sqlite_stat4` is tolerated and dropped from the staged copy (the allowlist stays strict for everything else). The install falls back to an exclusive copy when hard links are unsupported. New exit code 78. Mutation checks of these guards: 20 (including "probe fails open", which the first list missed); 18 were killed at first, and the two survivors (the root chown default not asserted, the temp-marker sweep hidden by the finish step's own cleanup) got stronger tests that now kill them.
- (after the plan) Task M3.4: small deviation from docs/design/backup.md section 13: the backup list reads each file's bounded manifest head once (first zip entry, deflate only, at most 1 MiB, cached by name and size, the same read that already classifies `trigger`) and shows app version, migration level and counts, which the task text asks for; the design said the list reads no zip. Nothing else in the zip is read. Also `BackupService.status()` gained `lastErrorCode` and `assertApiCreateAllowed()` was extracted from `create()`; the routes show fixed sentences only. Download hardening beyond the design: `O_NONBLOCK` and `nlink === 1` on open, a 60 s idle cut-off on the stream, `HEAD` answered 405, `ip` on the audit lines.
- (after the plan) Task M3.5 deviations from docs/design/backup.md section 12, small: (1) failure retries back off 15 min, 1 h, 4 h, 16 h (never beyond the interval) instead of "at the next interval", so one transient failure (a full disk someone just fixed) does not cost a whole day; a persistent failure still produces at most a handful of attempts per day. (2) `BACKUP_EVERY_HOURS` invalid does not throw in `loadConfig` (that would also block `restore` and `backup` on the command line); `loadConfig` returns `backupEveryHoursError` and `main.ts` refuses to start on it. (3) With no backup at all the scheduler also makes the one catch-up (the design speaks of "the newest backup is older than the interval"). (4) Sleeps are cut into chunks of at most 30 minutes and the due time is re-derived from the clock each time (a 720 h interval exceeds Node's timer limit; suspend and clock steps are absorbed); backups named later than the clock are ignored. (5) `GET /api/admin/backups` gained an additive `schedule` field and the page one line; no new endpoint. (6) `main.ts` gets `SIGTERM`/`SIGINT` handlers only when the scheduler is on (up to 8 s for a running backup); the default signal behaviour is unchanged otherwise.
- (after the plan) Task M3.7 (server half): (1) supersedes M3.5 deviation 6: SIGTERM/SIGINT are always handled (`src/lib/shutdown.ts`), not only with the scheduler on; a manual web backup is also awaited (up to 8 s), a second signal exits 143/130. (2) `assertBackupDirWritable` runs in the `BackupService` constructor and in `main.ts`; the `restore` command does not check `BACKUP_DIR` because it never writes there. (3) New CLI exit code 73 (`admin backup` with an unwritable `BACKUP_DIR`) and failure code `dir-not-writable` on the backup list. (4) `GET /api/admin/backups` gained `directory` and `adminPrograms` (additive, admin-only), an absolute path in an otherwise path-free DTO, which is the point of the task. (5) The compose default `BACKUP_EVERY_HOURS` is 24 (decision B2); `${VAR:-24}` also turns an empty value into 24, so `0` is how to turn it off.
- (after the plan) Task M4.1: (1) the trash list returns `{ items }` of deleted tree roots (`id, title, type, icon, subpageCount, deletedAt`); purge answers 400 (same as restore of a live page) for a page that is not deleted. (2) Purge deletes no upload files or rows: uploads are campaign-owned with no per-page reference table, so there is nothing to garbage-collect and nothing can dangle. (3) The automatic purge runs 60 s after start and every 24 h (not at the instant of start, so indexing and the first requests are done), and defers 5 min at a time while a backup runs or a restore marker exists. (4) `restore` needed no fix; its walk was extracted into `trashTree`, shared with purge and the listing.
- (after the plan) Task M4.1 fix round: owner decision, co-DMs may view, restore and purge the trash (`requireDm`). Purge is deliberately never on the MCP allowlist (irreversible); M4.4 may add only `GET .../trash`. The purger skips a pass when the clock is more than 10 min behind the newest `updatedAt`/`deletedAt` or its last run.
- (after the plan) Task M4.2: (1) routes are `GET /api/templates/trash` (registered before `/:id`) and `POST /api/templates/:id/restore`; the list has no definitions and no expiry because templates are not purged (follow-up: decide whether trashed templates should be purged after 30 days like pages). (2) `dmCampaignIds` now includes co-DMs: this ALSO changes list, get, edit, delete and usage of campaign templates for co-DMs (consistent with pages' `requireDm`; before, they could create campaign templates but not see or edit them). Needed for "GM/co-DM may restore"; raised with the Product Manager. (3) Restore does not re-establish a campaign default. (4) A page template whose `extendsRef` parent is still in the trash is refused with 409; a parent that no longer exists at all does not block restore (the template's `issues` report it).
- (after the plan) Task M4.3: (1) per owner decision the editor's page delete lost its `confirm()`; the "Deleted · Undo" toast carries the subpage count. (2) The toast also hosts a 4 s plain notice ("Restored ...") through `CampaignStore.toast`, as design 4.1 asks for a status text after Undo. (3) `TRASH_RETENTION_DAYS` is now exported from `@cn/shared` (review round 1) and `TRASH_RETENTION_MS` on the server derives from it; no behaviour change. (4) Focus after Undo/Dismiss goes to the first `h1` or `input` inside the campaign content area (`data-campaign-main`).
- (after the plan) Task M4.7: (1) purge is allowed while live children extend the template, instead of a 409: restoring needs the parent only to keep the trash consistent, but a purge is the user's explicit, irreversible decision and the 30-day scheduler cannot ask; the child already copes with a missing parent (it reports an `issues` entry, like for a trashed parent) and the user can pick another parent. (2) No schema change: versions and defaults cascade, `template_usage` has no foreign key so it is deleted explicitly, and `pages.from_template_id` is set to null. (3) `TrashPurger.runOnce()` now returns pages plus templates purged (the `templates` option is optional). (4) The allowlist rule became `^/api/templates(/(?!trash$)ID)?$`. (5) Purge response is `{ purged: [id] }`, like the page purge.
- (after the plan) Task M4.7 hardening: the purger reports a failing kind through the log and `lastRunFailed` and returns the partial count, instead of throwing, so the other kind still runs (the daily schedule is unchanged); `purgeIds` now returns the ids it purged and `purgeExpired` counts those; a small `TemplateService.trashed()` reads scope and campaign for the audit line; the GET allowlist rule also excludes `export` and whitespace/control characters in the id.
- (after the plan) Task M4.6: (1) no new route: the section lives in `TemplateLibrary` as a child component, so it follows the library's personal vs campaign context; outside a campaign the trash is filtered client-side to personal templates (the API also returns the campaigns the person runs) so that a restored row always appears in the list shown above. (2) The section is hidden entirely when there is nothing to show (players see nothing), instead of an empty-state panel; the "No deleted templates." panel only appears after the last row was acted on. (3) `TemplateApi` gained `trash`, `restore` and `purge`. (4) The existing `reload()` of the library became `protected` so the child can ask for it through a `changed` output. (5) Not done: the 400 "template to extend was not found" on editing a child of a purged parent is an editor concern and is left to the editor's existing error display. (6) Not verified in a real browser by eye: only jsdom specs and one headless e2e.
- (after the plan) Task M4.6 review fixes: the library's `(changed)` handler is `refresh()` (catches reload failures into the library message); the initial load of the section is silent (no loading text) and only Try again shows it; the 409 message is also written to the status region.
- (after the plan) Task M4.6 QA fixes: the accessible-name pattern of the accepted page Trash (M4.3) changed from `Delete <name> permanently` to `Delete permanently: <name>` (WCAG 2.5.3) in `trash.ts`, its spec, `e2e/trash.spec.ts` and `docs/design/trash-ui.md`, plus the `sr-only` separator; a chain of trashed parents is tracked client-side in the block (`then`), because the API only reports the direct parent.
- (after the plan) Task M5.2: the CI workflow triggers on pushes to `main` and on pull requests, not on every push to every branch (the task text says "every push"). A push to a branch with an open pull request would otherwise run the same gate twice; branches without a pull request are covered by running the gate locally. `workflow_dispatch` lets the owner start it by hand on any branch. The build step is followed by the restore drill (`pnpm --filter @cn/server drill`), which the M3.3 note asked M5.2 to call.
- (after the plan) Task M5.6: the 1.0.0 changelog entry says phone-width layouts are not part of the release and gives a known failure (top navigation overflows by about 35 px at 390 px), because Epic M6 (PRD P0 "before 1.0") was not done then. Superseded: the owner decided (D7, 2026-10-19) that M6 lands before the tag, M6 is done (2026-10-21), and the paragraph was removed in the documentation sweep (G1.3). The entry now has a "Phone-width screens for players" item that says the layout was tested in emulation only.
- (after the plan) Task M6.3: on campaign pages the phone menu's Rules group shows only the read-only "name · rules" line, as the desktop header does, not the Sources button and cross-edition box that the design text lists (on a campaign they edit the global preview context, not the campaign). The Templates link stays in the menu for everyone.
- (after the plan) Task M6.4: the phone layout changes a few things on desktop too, listed in STATUS.md ("Desktop (>= 1024 px) differences that remain, by design"): a wrapping reader `h1` and editable title, a read-only look for disabled fields, the inventory as cards at every width, and a muted placeholder colour. The owner has not yet accepted them. The PRD says the DM's prep views may stay desktop-first, and they do.
- (after the plan) Task M6.5: the browser test for phone width runs the player specs in an emulated phone (390 x 844, touch) on its own server (port 3211), not on a device, and not the DM's flows.
- (after the plan) Task M5.5: the release workflow does not set the version; the tag must equal the root `package.json` version or the workflow fails, so the tagged commit is exactly the tested one.
- (after the plan) Task M5.3: the PRD (M5) wants browser tests in CI on a self-hosted runner with a 5etools clone. `.github/workflows/e2e.yml` exists but is inactive until the owner registers a runner (decision D4), so `pnpm e2e` is run locally only for now. Owner decision 2026-10-22: skip the self-hosted runner (D4); the local run stays the browser-test gate.
- (2026-10-22, owner) Task M6.4/M6.5 accepted: the desktop differences from the phone work (wrapping titles, plain read-only fields, inventory cards at every width, darker placeholders), phone coverage by Chrome emulation only, and the 29 px inline dice target.
- (2026-10-23, owner) Release 1.3 design decisions. N1 page history: saves by the same author and source within **2 minutes** fold into one revision row instead of PRD N1's "every save kept" (deviation; a bad paste can overwrite at most the last 2 minutes of earlier state); retention is tiered (all rows 30 days, one per day after that, one per month after a year, soft 500 MB per campaign); restore brings back content only (title, type, body, details, properties), never visibility, viewers, parent, tags, icon, cover or `playerUserId`. N3 reveal: inferred from saves, no explicit reveal route; stream limits 6 per user (oldest evicted), 100 per campaign, 500 global, ring 200 events or 10 minutes. I2 query views: phone tables scroll sideways with a sticky title column; the player-visibility fixes go inside I2.2; no Cards sort control; drag reorder, column widths, saved viewer sort, grouping, inline edit and CSV export stay out. I3 tracker: the design's rule defaults are accepted (temp HP convention, 2024 stable wording, Delay as `moveAfter`).
- (2026-10-24) Task N3.2 deviations from docs/design/reveal.md, all small: (1) `PageService.onCommitted` takes `PageChange[]` (one flush), not a single change, because the more-than-3 collapse needs the whole batch. (2) The batch rule is enforced at runtime: a page write inside someone else's transaction without `pages.batch()` throws (rolling that transaction back), and `batch` inside a transaction throws; no static test. (3) `resync` is a bus message without a token and is not stored in the ring, so replay never includes it. (4) `Cache-Control: no-store` is set on the response after `streamSSE`, which otherwise overwrites it with `no-cache` (the tracker stream gets it too). (5) The `retry:` hint is random 3 to 6 s and leads the `hello` frame. (6) `EVENTS_HEARTBEAT_MS` is a test-only seam, undocumented on purpose. (7) `end()` waits at most 500 ms for the last frame, then cuts a stalled reader. (8) The tracker stream's membership re-validation on heartbeat is not wired in (backlog; the shared `lib/sse.ts` has the `onHeartbeat` hook).
