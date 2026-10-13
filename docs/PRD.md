# Critical Notes: Product Requirements

| | |
|---|---|
| Status | Draft for review |
| Date | 2026-10-13 |
| Covers | The product as built (milestones (a) to (i) plus the MCP server) and what comes next |
| Related | [PLAN.md](PLAN.md) (original technical plan), [STATUS.md](STATUS.md) (engineering state), [ARCHITECTURE.md](ARCHITECTURE.md) |

## 1. Summary

Critical Notes is a self-hosted campaign manager for D&D 5e. A DM keeps the whole campaign in one place: NPCs, locations, sessions, quests, factions, player characters, encounters, loot and homebrew. Every rules reference links to the DM's own copy of the 5etools data, locked to the campaign's edition (2014 or 2024). Players join the same campaign and see exactly what the DM shares, never more. An AI assistant can help with prep through MCP.

The core product is built and tested. What separates it from a public 1.0 is not more features, but the basics a self-hosted product needs to be trusted with years of campaign notes: account recovery, backups, undo for deletions, a license, and a release process. This document lists what exists, then the work ahead in three groups (must-haves, nice-to-haves, improvements), prioritized into a roadmap.

## 2. Problem and opportunity

DMs prepare in a patchwork: notes in Notion, Obsidian or Google Docs, rules on 5etools or D&D Beyond, encounters on Kobold Fight Club, initiative on paper or a VTT, handouts in chat. The pieces don't know about each other:
- Rules references in notes are dead text: no statblock on hover, no edition awareness, no "where did I use this monster?".
- Sharing with players means copying text out of private notes, and secrets leak when the DM forgets to delete a paragraph.
- 2024 rules arrived next to the 2014 ones. Mixed references in one campaign confuse the table, and moving a campaign to the new edition is manual.
- Homebrew lives in separate JSON files, outside the notes that use it.

Critical Notes connects these: notes, rules, homebrew, encounters and player sharing in one self-hosted app, where the server decides what each player can see.

## 3. Users

| Persona | Who | What they need most |
|---|---|---|
| **The DM** (primary) | Runs a weekly campaign; preps 1–3 hours a week; owns the books | Fast prep, rules at hand, secrets that stay secret, one place for everything |
| **The co-DM** | Shares the prep or runs side sessions | The same tools as the DM, without owning the campaign |
| **The player** | Joins through an invite | Recaps, handouts, their own character, the party's loot, the combat screen at the table |
| **The host** | Runs the instance (often the DM) on a home server or VPS | Easy install, painless updates, backups, user accounts that can be recovered |
| **The AI-assisted DM** | Preps with Claude or another assistant | An assistant that can read and write the campaign safely, with undo |

## 4. Goals, non-goals and how we measure

**Goals**
1. A DM can go from "nothing" to "session 1 prepared and shared with players" in one evening.
2. No DM secret ever reaches a player by accident (enforced on the server, tested on every response).
3. Nothing a user writes is lost: not by a mistaken delete, a conflicting edit, an AI assistant, an update or a dead disk.
4. Rules references are always right for the campaign's edition.
5. Installing and updating takes minutes, for someone comfortable with Docker.

**Non-goals**
- A virtual tabletop (battle maps with tokens, fog of war, line of sight).
- A rules engine for character building (level-up automation, full sheet calculation).
- A hosted public service, or any distribution of rules content: users bring their own 5etools clone and must own their books.
- Native mobile apps (a responsive web app is the target).

**Measures.** The app is self-hosted and sends no telemetry, so measures come from releases, issues and short user interviews, not tracking:
- Time from install to the first shared page (target: under 30 minutes, measured in moderated tests).
- Share of active campaigns with at least one player (from voluntary feedback and support conversations).
- Data-loss or secret-leak reports: zero tolerated; each is a release blocker.
- Upgrade problems reported per release.

## 5. Product principles

1. **Own your data.** Self-hosted; exports in open formats (campaign zip, 5etools homebrew, template files).
2. **Never redistribute content.** The app reads the user's local clone; nothing from WotC ships with it.
3. **The server enforces visibility.** Hiding in the browser is not hiding. Every new endpoint is projected for players and covered by the sentinel test.
4. **Edition integrity.** References follow the campaign's edition; mixing is an explicit, visible choice.
5. **Fast at the table.** Anything used during play (search, statblocks, tracker, dice) must work in a second or two.
6. **Lossless.** Edits through any path (editor, player edit, AI assistant, import) keep what they didn't change.

## 6. What exists today

All of the following is built and tested (unit, API and browser tests; see [STATUS.md](STATUS.md)).

| Area | Capabilities |
|---|---|
| **Rules reference** | Indexes the local 5etools data (about 6 s cold, milliseconds when unchanged), including inheritance and fluff. Browse lists with filters, detail pages, 2014 and 2024 statblock styles, hover previews for every `{@tag}`, Ctrl+K search, art from the image clone, clickable dice with a dice log. |
| **Editions** | Campaigns locked to 2014 or 2024 rules; "allow other-edition content" with badges; per-source toggles; reprints grouped so each list shows the right printing; a guided edition change with a dry run. |
| **Campaigns** | Create, settings, house rules, archive; export and import as a zip. |
| **Pages** | A page tree with drag and drop; typed pages (NPC, location, session, quest, faction, player character, item, lore, handout) with their own details; views per type (NPC list, location tree, session log, quest board, factions, party); custom properties; tags; search over titles and text. |
| **Editor** | Block editor with a "/" menu: headings, lists, checklists, callouts, read-aloud boxes, DM secrets, tables and roll tables, stat grids, images, columns, tabs, collapsible sections, embedded statblocks, page cards, live queries, encounter and loot blocks. `[[page links]]` with backlinks, `{@rules}` references, DM-only blocks, "preview as player". |
| **NPC statblocks** | Pick a bestiary creature for an NPC, or customize a copy (stored as campaign homebrew). |
| **Homebrew** | Sources (private, shared with campaigns, instance-wide, or campaign-only); form editors for 11 entry types and a JSON editor; live preview; variants of official entries; validation against the 5etools schema; revisions; delete and restore; "used in"; import from files, folders or URLs; export as 5etools homebrew. |
| **Templates** | Block and page templates with typed fields; 13 built-ins that work in both editions; linked copies that follow template changes; page templates with inheritance and subpages; a default template per page type; apply to existing pages; import and export. |
| **Encounters and combat** | Encounter builder with difficulty for both editions; initiative tracker (turns, HP, temporary HP, conditions with durations, hidden combatants, keyboard control); a live player screen; ending combat writes the characters' HP back; loot blocks award items and coins to the inventory. |
| **Inventory** | The party's stash and each character's items and coins; attunement (max 3); unidentified items shown as such to players. |
| **Players and sharing** | Roles (DM, co-DM, player); invite links with expiry and use limits; members and roles; pages shared with everyone or chosen players; players edit their own character; secrets are removed on the server from every response a player gets. |
| **AI assistants** | MCP endpoint with personal tokens (read only, or read and write); 31 tools covering pages, encounters, inventory, homebrew and templates; page text as Markdown with lossless edits; the same permissions as the user. |
| **Platform** | Docker image and compose file (non-root, read-only rules data), bundled server build, image uploads cleaned of metadata, SQLite database (Postgres schema ready, not yet usable), README and architecture docs. |

## 7. Prioritization

**Method.** Each item is scored on value (how many personas, how often, how bad the problem is) and effort (S: days, M: one to two weeks, L: several weeks), then ranked:

| Priority | Meaning |
|---|---|
| **P0** | Required before a public 1.0. Each closes a trust gap: data loss, account lockout, legal or release blockers. |
| **P1** | Next release after 1.0. High value for the core loop (prep → play → share). |
| **P2** | Valuable; scheduled when P1 is done or when a contributor picks it up. |
| **P3** | Later or opportunistic. |

**Must-haves** close gaps in what a self-hosted product must do. **Nice-to-haves** are new capabilities. **Improvements** make existing features better or finish them.

## 8. Must-haves (P0, before 1.0)

| ID | Item | Why it matters | Effort |
|---|---|---|---|
| M1 | Choose and publish the project license | Nobody can legally use, fork or contribute without one; it also sets the stance on content (bring your own data). | S |
| M2 | Account recovery and user administration | There is no email and no reset: a forgotten password locks a player out for good, and a password can't be changed in the UI (the API exists). | M |
| M3 | Instance backup and restore | Campaign export covers one campaign, not users, tokens, personal homebrew or templates. A dead disk loses everything. | M |
| M4 | Trash: restore deleted pages | Deleting a page deletes its subpages. The data is kept and a restore endpoint exists (used by AI assistants), but the web app has no way back. | S |
| M5 | Release process | No CI, no versions, no published image, no upgrade notes. Hosts need to know what changed and that updates are safe. | M |
| M6 | Phone-width check of the player and table flows | Players use phones at the table. Layouts are responsive in places but have not been tested on phones. | S–M |

### M1 License
- Decide the license for the code (e.g. MIT or AGPL-3.0; AGPL keeps hosted forks open).
- Add `LICENSE`, update the README licensing section, add a short `CONTRIBUTING.md`.
- **Done when:** the repository states the license; the README's content notice (WotC, SRD CC-BY-4.0, bring your own data) is reviewed.

### M2 Account recovery and user administration
- *As any user,* I can change my password and display name on the Account page.
- *As the host (admin),* I can see all users, reset a user's password (the app shows a one-time temporary password or a reset link to pass on), disable or delete a user, and make another user an admin.
- *As the host,* if I lose the admin password, a documented command-line reset works (e.g. `node dist/index.mjs reset-password <user>` or a Docker one-liner).
- **Done when:** no account can end up permanently locked; deleting a user keeps their campaigns' content (ownership transfer or a clear rule for campaigns they own).

### M3 Instance backup and restore
- One documented way to back up everything: the database (with SQLite's online backup, safe while running) and uploads, as a single archive.
- An admin button or command to make a backup, and a restore procedure that is tested in CI.
- Optional: scheduled backups to a folder with retention.
- **Done when:** a backup taken while users edit restores to a working instance with the same users, campaigns, homebrew, templates and images.

### M4 Trash
- *As a game master,* deleted pages (with their subpages) appear in a campaign trash for 30 days, with Restore and Delete permanently.
- Homebrew already has delete/restore; templates get the same.
- **Done when:** a deleted page tree can be restored from the UI with links, backlinks and search intact.

### M5 Release process
- CI runs the gate (typecheck, lint, tests) on every change; the browser tests run where a 5etools clone is available (self-hosted runner), never redistributing it.
- Semantic versions, a changelog, a published Docker image per release, upgrade notes (migrations run automatically on start).
- **Done when:** a host can pin a version, read what changed, and upgrade with `docker compose pull && docker compose up -d`.

### M6 Phone-width player and table flows
- Check at 360–430 px wide: joining by invite, reading shared pages, own character page, inventory, the combat player screen, dice.
- Fix what breaks; the DM's prep views may stay desktop-first.
- **Done when:** the player flows above pass a browser test at phone width.

## 9. Nice-to-haves (new capabilities)

| ID | Item | Value | Effort | Priority |
|---|---|---|---|---|
| N1 | **Page history**: every save kept, compare and restore; edits by AI tokens labelled as such | Undo for mistakes and for AI edits; essential once assistants write | M | **P1** |
| N2 | **Campaign activity feed**: who changed what, recently (DM view), "what's new" for players since their last visit | Co-DMs stay in sync; players find new handouts and recaps | M | **P1** |
| N3 | **Reveal to players**: reveal a secret or share a handout during the session with one click, highlighted for players live | The table moment: "you find a letter" | S–M | **P1** |
| N4 | **Generators from the 5etools data**: random encounters by environment and difficulty, loot hoards (`loot.json`), names (`names.json`), roll tables that roll on click | Faster prep and improvisation, using data the user already has | M | **P1** |
| N5 | **OAuth sign-in for the MCP endpoint**, so it can be added as a claude.ai connector | Opens AI assistance to users who don't use Claude Code or desktop config files | M | **P2** |
| N6 | **Interactive maps**: an uploaded map with pins linked to pages, and player-visible versus DM-only pins | Locations are spatial; DMs want to click a map | L | **P2** |
| N7 | **Timeline and calendar**: sessions on a real calendar; in-world dates for events | Planning sessions; keeping long campaigns straight | M | **P2** |
| N8 | **Relationship graph** of NPCs, factions and locations from links and details | See the web of a city or plot at a glance | M | **P2** |
| N9 | **Shared dice log** for the table (rolls visible to the campaign, with a private DM option) | Today's dice log is per browser | S | **P2** |
| N10 | **Real-time co-editing and presence** (who's on this page; simultaneous edits) | Today a conflicting save asks to reload | L | **P2** |
| N11 | **SRD-only mode**: start without a 5etools clone, using only CC-BY SRD content | Lets people try the app in minutes; needs a legal review first | M | **P2** |
| N12 | **Session recap helper**: from the session's notes, a draft "previously on…" for players (in-app or through MCP prompts) | The most requested player-facing artifact | S–M | **P3** |
| N13 | **Character sheet depth**: spells, features, skills and saving throws on the PC page | Players want everything in one place; overlaps D&D Beyond | L | **P3** |
| N14 | **Postgres at run time** and several server processes (with shared live updates) | Larger hosts; the schema already exists | L | **P3** |
| N15 | **Offline reading** (installable app, cached campaign for the table) | Bad Wi-Fi at game stores | M | **P3** |
| N16 | **Translations** of the interface | Non-English tables | M | **P3** |
| N17 | **Export to a VTT** (e.g. Foundry journal entries and actors) | Moves prep into play tools | L | **P3** |

## 10. Improvements to existing features

| ID | Area | Improvement | Why | Effort | Priority |
|---|---|---|---|---|---|
| I1 | Players | A player's save keeps the DM's links to pages the player can't see (today they turn into plain text for good) | Silent data loss on shared character pages | M | **P1** |
| I2 | Editor | Query block: table and card views, and a column picker (only the list view exists) | Query blocks are the "database" feature; lists alone limit them | M | **P1** |
| I3 | Combat | Tracker: death saves, legendary actions and resistances, lair actions, recharge abilities, delay and ready | Common in every boss fight; DMs track them on paper today | M | **P1** |
| I4 | Editor | Edit conflicts: show both versions and merge, instead of "reload" | Co-DMs and AI assistants editing the same page | M | **P2** |
| I5 | Search | Snippets in players' search results (they get titles only) | Players can't tell results apart | S | **P2** |
| I6 | Templates | View and restore older template versions (stored, no UI) | Undo for template edits, which propagate to linked copies | S | **P2** |
| I7 | Homebrew | Variant form shows inherited values as placeholders | Today only overridden fields show, which confuses | M | **P2** |
| I8 | Media | Use the upload thumbnails in galleries, pickers and campaign covers (made, not used) | Faster pages, especially on phones | S | **P2** |
| I9 | Campaigns | Campaign covers and descriptions on the campaign list | Recognizing campaigns at a glance | S | **P2** |
| I10 | Onboarding | Better first run: a guided first campaign (choose edition, create a session and an NPC, invite a player), useful empty states | Supports the "first evening" goal | M | **P2** |
| I11 | Accessibility | WCAG 2.1 AA audit and fixes (editor, tracker, menus, contrast in both themes) | Usable by everyone; keyboard-heavy DMs benefit too | M | **P2** |
| I12 | Homebrew | Forms for classes, subclasses and their features (JSON only today) | Class homebrew is popular but hard in JSON | L | **P3** |
| I13 | Homebrew | Expand homebrew magic variants across base items, and official variants onto homebrew base items | Parity with 5etools behaviour | M | **P3** |
| I14 | Editions | Edition change also maps class-feature style references | Completes the migration for character-heavy campaigns | M | **P3** |
| I15 | Export | Include combat trackers in campaign exports; map "selected" viewers on import | Complete round trips between instances | S | **P3** |
| I16 | AI assistants | Keep underline and highlight when a paragraph is edited through Markdown | Small formatting loss today | S | **P3** |
| I17 | Encounters | Optional DMG 2014 rule to ignore much weaker monsters in the difficulty | Matches some DMs' expectations | S | **P3** |
| I18 | Editor | Offer the gallery block in the "/" menu (it exists and renders, but can't be added there) | Several images side by side, e.g. a set of handouts | S | **P3** |

## 11. Roadmap

| Release | Theme | Contents |
|---|---|---|
| **1.0** | Trustworthy to self-host | M1–M6 |
| **1.1** | Prep and play loop | N1 page history, N3 reveal to players, I1 keep hidden links, I3 tracker additions, I2 query views |
| **1.2** | Stay in sync | N2 activity feed, N4 generators, I4 merge on conflict, I5 player snippets, I10 onboarding |
| **Later** | Grow | N5 OAuth for MCP, N6 maps, N7 calendar, N8 graph, N9 shared dice, N10 co-editing, N11 SRD-only mode, then P3 items as demand shows |

Order inside a release follows the tables. A data-loss or secret-leak bug interrupts any release.

## 12. Risks and open questions

| Risk or question | Notes | Owner |
|---|---|---|
| Legal position of reading 5etools data | The app distributes nothing and tells users to own their books, but the data source is a fan mirror. Get a legal opinion before promoting a hosted demo or SRD-only mode (N11). | Product |
| License choice (M1) | MIT maximizes adoption; AGPL-3.0 keeps hosted forks open. Decide before any public announcement. | Product |
| AI assistants changing campaigns | MCP writes are permission-checked and edits are lossless, but a wrong instruction can still rewrite or delete content. Page history (N1) and the trash (M4) are the safety net; ship them before promoting MCP. | Product / Eng |
| Single-process design | Live combat updates and SQLite assume one server process. Fine for a group of friends; revisit with N14 if hosts ask for scale. | Eng |
| Upstream data changes | 5etools formats change over time. Keep the real-data smoke tests in CI on a self-hosted runner (M5). | Eng |
| Unclear demand for deep character sheets (N13) | Many players already use D&D Beyond. Validate with interviews before building. | Product |

## 13. Appendix: where the details are

- Engineering state, health checks and known technical debt: [STATUS.md](STATUS.md)
- Original plan, milestone table and every deviation from it: [PLAN.md](PLAN.md)
- How the system fits together, with the data model: [ARCHITECTURE.md](ARCHITECTURE.md)
- What the 5etools data looks like: [../DATA_NOTES.md](../DATA_NOTES.md)
- Setup, configuration, MCP connection and licensing: [../README.md](../README.md)
