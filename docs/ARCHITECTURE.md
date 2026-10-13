# Architecture

How Critical Notes is put together: the packages, the two databases, how a request is served, how the DM's
secrets stay on the server, and the data model. For setup and use, see the [README](../README.md).

## The pieces

```mermaid
flowchart LR
  subgraph Browser
    web["apps/web<br/>Angular app"]
  end
  subgraph Server["apps/server (Hono on Node)"]
    routes["routes/<br/>auth, campaigns, play,<br/>reference, homebrew,<br/>templates, uploads, img"]
    services["services/<br/>pages, visibility, campaigns,<br/>homebrew, templates, encounters,<br/>trackers, inventory, transfer, migration"]
    indexer["reference/<br/>indexer + ReferenceService"]
  end
  appdb[("DATA_DIR/app.sqlite<br/>campaigns, pages, users, …")]
  indexdb[("DATA_DIR/index.sqlite<br/>reference index (rebuildable)")]
  uploads[("DATA_DIR/uploads/")]
  src[["5etools-src<br/>(read-only)"]]
  img[["5etools-img<br/>(read-only)"]]

  web -- "/api (JSON, SSE)" --> routes
  web -- "/img" --> routes
  routes --> services
  services --> appdb
  services --> uploads
  routes --> indexer
  indexer --> indexdb
  indexer -. "reads at startup" .-> src
  routes -. "serves files" .-> img
```

The shared packages hold everything that does not depend on a framework, so the server and the web app use
the same code:

| Package | What it does |
|---|---|
| `packages/fivetools` | Reads 5etools data: the loader, `_copy` inheritance with every `_mod` mode (a safe arithmetic evaluator instead of `eval`), `_versions`, subraces, magic variants, class features, fluff. The edition resolver and reprint groups. Rulesets (2014 and 2024: terminology, encounter difficulty, statblock style). The `{@tag}` tokenizer and the render model for entries. Dice and CR/XP math. Node-only code is in `src/node`. |
| `packages/blocks` | The block document: the registry of block types (zod attribute schemas, content rules), `sanitizeDoc`, the player projection `projectDoc`, `mergePlayerEdit`, text and link extraction, the query DSL. |
| `packages/templates` | Template placeholders (`{{dc: number = 13}}`), typed values, substitution, page template inheritance, the built-in templates. |
| `packages/shared` | The API's types and zod input schemas (used by the server's validators and the web app), page types and facets, the initiative tracker reducer, inventory projections. |
| `apps/server` | The HTTP API on [Hono](https://hono.dev), Drizzle on better-sqlite3, the indexer, image and upload routes, the tracker's event stream. |
| `apps/web` | The Angular app (standalone components, signals, zoneless): the TipTap block editor with Angular node views, the reference browser and renderer, the campaign views. |

## Two databases

- **`app.sqlite`** holds what users create: users and sessions, campaigns and members, pages and their facets
  and properties, homebrew, templates, encounters, trackers, inventory. It is the only thing to back up (with
  `uploads/`). Migrations are in `apps/server/drizzle/`; they run at startup.
- **`index.sqlite`** is derived and can be deleted at any time. It holds the reference: every 5etools entity
  after inheritance is resolved, homebrew entities indexed the same way, full-text search (FTS5) over both, and
  the campaign page search with separate DM and player text. The indexer fingerprints the data files and
  re-reads only when something changed (a no-op start takes milliseconds; a full build about 6 seconds).

The Postgres mirror of the app schema (`src/db/schema.pg.ts`, migrations in `drizzle-pg/`) is kept in step by
`test/pg-parity.test.ts`, which applies both migration sets (Postgres in PGlite) and compares the result. The
services use better-sqlite3's synchronous API, so running on Postgres needs an async data layer first. The
reference index stays SQLite either way.

## Serving a request

1. **Security headers** on every response: a Content Security Policy that allows scripts only from the app
   itself, no framing, same-origin resources.
2. **Session:** the cookie holds a random token; the database holds only its SHA-256. Sessions slide forward
   while used.
3. **Origin check** on every write: requests from another origin are refused, and bodies must be JSON or
   multipart (no simple-form CSRF).
4. **Route and access:** campaign routes resolve the user's role (`dm` = owner, `codm`, `player`).
   `requireDm` admits game masters, `requireOwner` only the owner (members, roles, edition change).
5. **Validation** of inputs with the zod schemas from `@cn/shared`.
6. **Service** logic, then **projection** for players (below), then JSON. Event streams (the tracker) are
   not compressed, so updates arrive at once.

## What players can see

Every response that carries campaign content goes through the player projection when the viewer is a player.
There is no client-side hiding: the browser of a player never receives what they may not see.

- **Pages:** `VisibilityService.visiblePageIds` = pages shared with everyone, `selected` pages that list the
  player, and the player's own characters. Everything else is absent from the tree, lists, search, queries,
  backlinks and links (a link to a hidden page becomes plain text).
- **Blocks:** `projectDoc` drops DM-only blocks and unrevealed secrets with everything inside them.
- **Fields:** DM-only properties and facet fields (`FACET_DM_ONLY_FIELDS`) are left out.
- **Combat:** the player view of a tracker has no hidden creatures, no notes or AC, and health words instead
  of hit points for anything but player characters.
- **Inventory:** unidentified items show as "Unidentified item"; characters the player can't see, and their
  coins, are absent.
- **Edits:** a player may change only their own character. `mergePlayerEdit` puts the blocks they never
  received back in place, so their save cannot delete the DM's notes.

`test/visibility.test.ts` seeds "SENTINEL" strings into every kind of hidden content and requests more than
40 player-reachable endpoints, failing if any response contains one; the browser test `e2e/players.spec.ts`
does the same for every response a real player's browser receives. A new endpoint that returns campaign
content needs both: the projection, and a sentinel in the seed.

## AI assistants (MCP)

`/mcp` is a Streamable HTTP endpoint (`@modelcontextprotocol/server`, a fresh server per request) for AI
assistants. It is the only place that accepts a bearer token: personal API tokens (`api_tokens`, only a
SHA-256 stored), read only or read and write, made and revoked on the Account page.

- **Tools call the REST API in-process** (`app.request`) as the token's user (`mcp/api.ts`). The call
  carries a module-private symbol in the request env, which `sessionMiddleware` turns into that user; nothing
  arriving over HTTP can set it. Every role check, validation and player projection is therefore the one the
  web app gets. An allowlist limits the calls to the ones the tools need: tokens never reach accounts,
  tokens, invites, members, imports, exports or the edition change. Read tokens get only the read tools, and
  the middleware refuses their writes anyway.
- **Page text as Markdown** (`@cn/blocks/markdown`): `docToMarkdown` writes a Markdown dialect (`:::secret`,
  `:::dm`, `{@tags}`, `[[links]]`…); blocks it can't express become `<!-- cn:block <id> … -->` lines.
  `markdownToDoc` reads it back and `reconcile`s it with the version it was made from (longest common
  subsequence on each block's content, level by level), so unchanged blocks are kept exactly and edited ones
  keep their ids. For a player that version is their projection, and kept ids let `mergePlayerEdit` put the
  hidden blocks back in place.
- The sentinel crawl calls every read tool as a player too.

## Editions

A campaign's policy is `{ruleset, crossEdition, sourceOverrides}`. The edition of a source comes from the
`5etools-utils` source lists, then the publication date; an entity can override it (`edition: "classic"`).
Entities that reprint each other (`reprintedAs`) form a reprint group: lists and search show one member per
group (the campaign's edition first), and the others stay reachable. Code outside `ruleset/` and `edition/`
never compares edition strings (an ESLint rule enforces it); it asks the `Ruleset` instead.

## The block editor

Page bodies are ProseMirror JSON in our own schema (`schemaVersion: 1`). The server sanitizes every saved
body against the registry: unknown blocks are kept as `unknownBlock` instead of being lost, and only http(s)
and mailto links survive. The web app renders custom blocks as Angular components inside TipTap; read-only
views (`cn-block-view`) render the same JSON without the editor. No user content is ever inserted as HTML (a
lint check forbids `innerHTML` and `bypassSecurityTrust*`).

## Uploads and images

Uploads are checked by their bytes (PNG, JPEG, GIF, WebP; never SVG), then decoded and re-encoded with sharp,
which applies the orientation and drops all metadata (a phone photo's location included), and stored with a
400 px WebP preview. They are served only to members of their campaign. 5etools images are served from the
read-only clone under `/img` after the path is resolved and checked (no `..`, no symlinks out, image types
only).

## Deployment

`pnpm build` bundles the server with esbuild into `apps/server/dist/main.mjs`. Native modules (better-sqlite3,
argon2, sharp) and `5etools-utils` stay external; `dist/package.json` lists them. The Docker image builds the
bundle and the web app, installs only those packages, and runs as the `node` user with the 5etools clones
mounted read-only.

## Data model

The app database (`apps/server/src/db/schema.ts`). Timestamps are epoch milliseconds; JSON columns are text in
SQLite and `jsonb` in Postgres. Derived tables (`page_links`, `entity_references`, `template_usage`) are
rewritten whenever a page is saved.

```mermaid
erDiagram
  users ||--o{ sessions : "signs in"
  users ||--o{ campaign_members : joins
  campaigns ||--o{ campaign_members : has
  campaigns ||--o{ campaign_invites : "invites with"
  campaigns ||--o{ campaign_source_overrides : "turns sources on/off"
  campaigns ||--o{ campaign_migrations : "logs edition changes"
  campaigns ||--o{ pages : contains
  pages ||--o{ pages : "parent of"
  pages ||--o{ page_tags : tagged
  pages ||--o{ page_viewers : "shared with"
  users ||--o{ page_viewers : sees
  pages ||--o| npc_facets : "NPC details"
  pages ||--o| location_facets : "location details"
  pages ||--o| session_facets : "session details"
  pages ||--o| quest_facets : "quest details"
  pages ||--o| faction_facets : "faction details"
  pages ||--o| character_facets : "character sheet"
  pages ||--o| item_facets : "item details"
  users ||--o{ character_facets : plays
  campaigns ||--o{ property_defs : defines
  property_defs ||--o{ page_property_values : "values of"
  pages ||--o{ page_property_values : has
  pages ||--o{ page_links : "links to (derived)"
  pages ||--o{ entity_references : "uses rules (derived)"
  campaigns ||--o{ uploads : stores
  users ||--o{ homebrew_sources : owns
  campaigns ||--o| homebrew_sources : "campaign-only source"
  homebrew_sources ||--o{ homebrew_source_shares : "shared with"
  campaigns ||--o{ homebrew_source_shares : uses
  homebrew_sources ||--o{ homebrew_entities : contains
  homebrew_entities ||--o{ homebrew_revisions : "history of"
  templates ||--o{ template_versions : "versions of"
  templates ||--o{ template_usage : "used in (derived)"
  pages ||--o{ template_usage : uses
  campaigns ||--o{ templates : "campaign templates"
  campaigns ||--o{ campaign_template_defaults : "default per page type"
  templates ||--o{ campaign_template_defaults : "is default"
  campaigns ||--o{ encounters : plans
  encounters ||--o{ trackers : "runs as"
  campaigns ||--o{ trackers : has
  campaigns ||--o{ inventory_items : holds
  pages ||--o{ inventory_items : "owned by (PC)"
  campaigns ||--o{ currencies : "coins per owner"
  pages ||--o{ loot_awards : "loot handed out"
  users ||--o{ api_tokens : "AI assistant tokens"

  users {
    text id PK
    text username UK
    text display_name
    text password_hash "argon2id"
    bool is_admin
  }
  campaigns {
    text id PK
    text name
    text ruleset "2014 or 2024"
    bool cross_edition
    json house_rules
    text status
  }
  campaign_members {
    text campaign_id PK
    text user_id PK
    text role "dm, codm, player"
  }
  campaign_invites {
    text id PK
    text token_hash UK
    text role
    int expires_at
    int max_uses
    int uses
  }
  pages {
    text id PK
    text campaign_id FK
    text parent_id FK
    text sort_key "fractional index"
    text type
    text title
    text visibility "dm, all, selected"
    json body "block document"
    int revision "optimistic concurrency"
    int deleted_at
  }
  character_facets {
    text page_id PK
    text player_user_id FK
    json classes
    int hp_max
    int hp_current
  }
  property_defs {
    text id PK
    text campaign_id FK
    text key
    text type
    bool dm_only
  }
  homebrew_sources {
    text id PK
    text json_id "5etools source key"
    text edition
    text scope "private, campaigns, instance, campaign"
  }
  homebrew_entities {
    text id PK
    text source_id FK
    text entity_type
    text name
    json data "5etools format, may _copy"
    int current_revision
  }
  templates {
    text id PK
    text kind "block or page"
    text scope "global, user, campaign"
    text builtin_key UK
    int version
    json definition
  }
  encounters {
    text id PK
    text campaign_id FK
    json creatures
    json party
  }
  trackers {
    text id PK
    text encounter_id FK
    text status
    json state "tracker reducer state"
    int revision
  }
  inventory_items {
    text id PK
    text owner_page_id FK "null: party stash"
    text item_uid
    int quantity
    bool attuned
    bool identified
  }
  api_tokens {
    text id PK
    text user_id FK
    text token_hash UK "sha256"
    text scope "read or write"
    int expires_at
    int revoked_at
  }
  uploads {
    text id PK
    text campaign_id FK
    text mime
    text sha256
    int width
    int height
  }
```
