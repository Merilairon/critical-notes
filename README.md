# Critical Notes

A self-hosted campaign manager for D&D 5e, for a DM and their players. Campaign notes are pages built from
blocks (like Notion), with NPCs, locations, sessions, quests, factions and player characters as typed pages.
The rules (spells, monsters, items, …) come from your own local copy of the 5etools data, for the 2014 or the
2024 rules.

- **Campaigns locked to an edition.** A campaign uses the 2014 or 2024 rules; the reference, search and
  `{@tags}` follow it. Other-edition content can be allowed per campaign, with a badge. A campaign can later
  move to the other edition: you see every reference and what it becomes before anything changes.
- **Pages and blocks.** Text, callouts, read-aloud boxes, DM secrets, tables and roll tables, images, columns,
  tabs, embedded statblocks and spells, page cards, live queries ("all NPCs in this town"), `[[links]]` with
  backlinks, custom properties.
- **The reference.** Browse and search everything in your 5etools data, with statblocks in the 2014 or 2024
  style and hover previews for every `{@tag}`.
- **Homebrew** in the 5etools format: form and JSON editors with a live preview, variants of official
  creatures, revisions, import and export of 5etools homebrew files.
- **Templates** for blocks and whole pages, with typed fields; linked copies follow template changes.
- **Encounters and combat.** Difficulty by the campaign's rules, an initiative tracker, and a live view for
  the players' screen that never shows hidden creatures. Loot goes to the party's inventory.
- **Players.** Invite links, a co-DM role, players editing their own character. What the DM hides is never
  sent to a player's browser: the server leaves it out of every response.
- **Campaign export and import** as a zip file.
- **AI assistants (MCP).** Connect Claude or another MCP client with a personal token: it can read and write
  pages, encounters, the inventory, homebrew and templates, with exactly your rights.

## Before you start: the 5etools data

Critical Notes ships **no game content**. It reads two git repositories that you clone yourself:
[5etools-src](https://github.com/5etools-mirror-3/5etools-src) (the data, about 1 GB) and
[5etools-img](https://github.com/5etools-mirror-3/5etools-img) (art and tokens, about 13 GB, optional).
Use them only for books you own; see [Licensing](#licensing).

```sh
pnpm data:clone            # both repos into ./5etools-data/ (SKIP_IMG=1 for the data only)
# or by hand:
git clone --depth 1 https://github.com/5etools-mirror-3/5etools-src.git 5etools-data/5etools-src
git clone --depth 1 https://github.com/5etools-mirror-3/5etools-img.git 5etools-data/5etools-img
```

## Running it with Docker

```sh
docker compose up -d       # builds the image the first time; then open http://localhost:3000
```

The first visit asks you to create the admin account. Players join through invite links that a DM creates
in the campaign's settings (there is no open sign-up).

- The 5etools folders are mounted read-only. Your data (database, search index, uploaded images) lives in the
  `app-data` volume: back that up.
- The app runs as an unprivileged user, on port 3000 inside the container (`PORT=8080 docker compose up -d`
  to publish another port).
- Set `PUBLIC_URL` to the address people use (for example `https://notes.example.org` behind a reverse proxy
  that handles TLS). With an `https://` address, session cookies are marked Secure.

**Updating the 5etools data:**

```sh
docker compose --profile tools run --rm data-update   # pulls the latest data into ./5etools-data
docker compose restart app                             # re-indexes on start (only changed files are read)
```

## Running it without Docker

Requires Node 24.15 or later, pnpm 11 and git.

```sh
pnpm install
pnpm build                 # the server bundle (apps/server/dist) and the web app (apps/web/dist)
NODE_ENV=production pnpm --filter @cn/server start:dist   # serves the app on http://localhost:3000
pnpm data:update           # later: pull the latest 5etools data and re-index
```

### Configuration

Environment variables, or a `.env` file in the repository root (see `.env.example`). Relative paths are
resolved from the repository root.

| Variable | Default | |
|---|---|---|
| `FIVETOOLS_SRC_PATH` | `./5etools-data/5etools-src` | The 5etools data clone |
| `FIVETOOLS_IMG_PATH` | `./5etools-data/5etools-img` | The image clone (optional; missing images show a placeholder) |
| `DATA_DIR` | `./var` | Database, search index and uploads |
| `PORT` | `3000` | |
| `PUBLIC_URL` | `http://localhost:4200` | The address people open; requests from other origins are refused |
| `SECURE_COOKIES` | from `PUBLIC_URL` | `1` or `0` to override (for example behind a TLS-terminating proxy that forwards plain http) |
| `WEB_DIST_DIR` | `./apps/web/dist/web/browser` | The built web app, served in production |

## Using it

**Editions.** Pick 2014 or 2024 rules when you create a campaign. The campaign's reference shows the printing
for its edition (a 2014 campaign shows the PHB Fireball, a 2024 one the XPHB Fireball); "Also printed as …"
links reach the other. Turn on "Allow 2024 content" (or "Allow legacy (2014) content") in the campaign's
settings to mix them. "Change edition" (owner only) lists every reference in the campaign and what it maps to
before it changes anything.

**What players see.** New pages are visible to the DM only. A page can be shared with everyone or with chosen
players; a player always sees their own character. Inside a shared page, "DM secret" blocks and blocks marked
DM-only (`Ctrl+Shift+D`) stay hidden until you mark them revealed (`Ctrl+Shift+R`). "Preview as player" shows a
page exactly as a player receives it.

**Writing.** Type `/` for blocks, `[[` to link (or create) a page, `{@` to insert a rules reference such as
`{@spell fireball|XPHB}`, and dice like `{@dice 2d6+3}`.

**Homebrew.** Under Homebrew, create a source (its name, abbreviation and edition), then add creatures,
spells, items, species, backgrounds, feats and more, in the form editor or as 5etools JSON. "Copy to homebrew"
on any reference entry starts a variant that stores only your changes. Import 5etools homebrew files (or a
URL); export a source as a 5etools homebrew file. Share a source with chosen campaigns, or keep quick
one-off creatures in a campaign's own homebrew.

**Templates.** Write placeholders in a template's text: `{{name}}`, `{{dc: number = 13}}`,
`{{creature: reference<monster>}}`, `{{mood: select(calm|angry)}}`; `{{rules.race}}` becomes "Race" or
"Species" by the campaign's edition. Insert a template with `/` → Template…, as a copy or linked (linked
copies update when the template changes). Page templates create whole pages, optionally with subpages, and a
campaign can use one by default for each page type.

## Connecting an AI assistant (MCP)

Critical Notes has an [MCP](https://modelcontextprotocol.io) endpoint at `/mcp`, so an AI assistant can prep
with you: "add the innkeeper as an NPC with a secret", "plan an encounter for session 4", "write a homebrew
potion".

1. Under **Account** (click your name at the top), create a token: read only, or read and write, with an
   expiry. It is shown once, with the setup for common clients.
2. Add the server to your client. For Claude Code:

   ```sh
   claude mcp add --transport http critical-notes https://notes.example.org/mcp --header "Authorization: Bearer cn_…"
   ```

   Clients that only start local programs (such as Claude Desktop) can reach it through
   [mcp-remote](https://www.npmjs.com/package/mcp-remote); the Account page shows that setup too.

The assistant acts as you: as a DM it can do what you can; as a player it sees only what is shared with you
and edits only your own character. It writes page text as Markdown with a few extras (the server explains
them to the model when it connects):

| Markdown | Becomes |
|---|---|
| `{@spell fireball\|xphb}`, `{@dice 2d6}` | rules references, as typed in the editor |
| `[[Stonehill Inn]]` | a link to that page |
| `:::secret` … `:::` | a DM secret (`:::secret{revealed}` once revealed) |
| `:::dm` … `:::` | blocks only game masters see |
| `:::callout{tone=warning}`, `:::read-aloud`, `:::details[Title]` | callouts, read-aloud boxes, collapsible sections |
| `:::roll-table{dice=d6}` around a table | a roll table |
| `:::columns` / `:::column`, `:::tabs` / `:::tab[Title]` | layouts |
| `::embed{uid="monster:goblin\|mm"}` | an embedded statblock |
| `<!-- cn:block … -->` | a block Markdown can't show (an encounter, loot, a query…), kept as is |

Edits through Markdown change only what changed: everything else, including blocks Markdown can't show and
blocks a player can't see, stays exactly as it was. Revoke a token on the Account page at any time.

## Development

```sh
pnpm dev                   # server on :3000 (tsx watch), web on :4200 (proxies /api and /img)
pnpm -s typecheck && pnpm -s lint && pnpm -s test     # the gate before every change goes in
pnpm e2e                   # builds, starts the server on a fresh data folder, runs the browser tests
pnpm index [--force]       # rebuild the reference index by hand
pnpm --filter @cn/server db:generate                   # migrations after a schema change (both dialects)
```

- The browser tests (Playwright, in `e2e/`) drive the system Chrome (`CHROME_PATH` for another one) and need
  the real 5etools data. `E2E_BASE=http://localhost:3000 pnpm exec playwright test` runs them against a
  server that is already running, which must be a fresh instance.
- Unit and API tests use a small invented fixture instead of 5etools content.
- The app database is SQLite. `apps/server/src/db/schema.pg.ts` mirrors the schema for Postgres, with its
  own migrations in `apps/server/drizzle-pg/`; a test applies both and compares them. The services still use
  the synchronous SQLite driver, so running on Postgres needs a port of the data layer first.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit together, with the data model.
  [docs/PLAN.md](docs/PLAN.md) is the original plan with its deviations; [docs/STATUS.md](docs/STATUS.md)
  the current state; [DATA_NOTES.md](DATA_NOTES.md) what the 5etools data looks like.

## Licensing

- **Game content and art.** The rules text, statblocks and other content in 5etools, and the art in
  5etools-img, belong to Wizards of the Coast and the credited artists. The portions from the System Reference
  Documents 5.1 and 5.2 are available under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
  Critical Notes does not contain, copy or redistribute any of it: it reads the clone on your own machine
  while it runs. Use it for books you own. Do not publish a server with this content to the public.
- **5etools.** The 5etools code is MIT-licensed (Copyright (c) 2017 TheGiddyLimit and contributors). The data
  handling in `packages/fivetools` (inheritance with `_copy`, the `{@tag}` syntax, edition rules) follows how
  5etools works. The [5etools-utils](https://www.npmjs.com/package/5etools-utils) package (MIT) supplies the
  homebrew schemas and the edition source lists at run time.
- **Third-party code** (dependencies, the bundled AI agent definitions, the 5etools license notice) is listed
  in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **Your data** stays in your `DATA_DIR`; exports are yours.
- **This project's own license** has not been chosen yet.
