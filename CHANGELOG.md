# Changelog

All notable changes to Critical Notes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Before you update, read the entries between your version and the new one, and
[make a backup](README.md#updating). Database changes are applied when the server starts and cannot be undone.

## [Unreleased]

The prep and play release. The DM gets a history of every page with compare and restore, can reveal secrets and
handouts to the players while they are reading, and gets more help at the combat table. A player's save no longer
destroys the DM's hidden links. **This release changes the database and the change cannot be undone: back up first**
(see [Upgrade notes](#upgrade-notes) below).

### Added

- **Page history (game master only).**
  - Every change to a page is saved as a version: edits in the web editor, a player's edits to their character,
    edits by an AI assistant, restores, templates, imports and edition changes. Open a page and choose **History** in
    the toolbar (it is hidden for players and in "Preview as player").
  - Saves by the same person within 2 minutes become one version, so typing does not create hundreds of entries.
    Change this with `HISTORY_COALESCE_MINUTES` (0 keeps every save).
  - Each entry shows who made the change and when. Changes made through an AI token are marked **via AI assistant**
    with the token's name.
  - **Compare** a version with the current page, or two versions with each other. Changes are shown as added and
    removed text, marked with `+` and `-`, underline and strike-through, and with spoken words for screen readers.
    Changes to the title, type, details and properties are listed under "Other changes".
  - **Restore** brings an earlier version back as a new version, so you can **Undo restore**. A restore brings back
    content only: title, type, text, details and properties. It does not change who can see the page, its parent, tags,
    icon or who owns a player character.
  - Old versions are thinned so history does not grow without end: every version is kept for 30 days, then one per
    day, then one per month after a year, and a page or campaign over its limit is thinned early (oldest first, never
    the last 30 days). The settings are `HISTORY_KEEP_ALL_DAYS`, `HISTORY_COALESCE_MINUTES`,
    `HISTORY_MONTHLY_AFTER_DAYS`, `HISTORY_MAX_PER_PAGE` and `HISTORY_MAX_MB_PER_CAMPAIGN`; the defaults are in the
    [README](README.md#configuration). Thinning stops history from growing; it does not make the database file smaller.
  - Players never see history, and a campaign export does not include it.
  - AI assistants with a game master's token get two new tools: `get_page_history` (list the versions of a page, or read
    one in full) and `restore_page_version` (needs a read and write token).
- **Reveal to players.**
  - **Reveal now** in a block's options menu (`Ctrl+.`) reveals a DM secret or a DM-only block at once, with a 15
    second **Undo**. **Share now** (and **Share with chosen players**) does the same for a handout page.
  - Players see it while they play, without reloading: a short message ("New: ...", "New details on this page"), a
    **New** label in the page tree and on the page, and a highlight on the revealed block. A player who is typing on
    that page is offered **Reload** instead of having their text replaced.
  - The message only tells the player's browser to look again. It never carries a title or text; the browser then
    asks for the page like any other request, so the usual rules about what a player may see still apply.
  - If the live connection fails for a long time, the browser falls back to checking now and then. Live updates need one
    server process, which is what the shipped `docker-compose.yml` runs. The limits are `EVENTS_MAX_CONNECTIONS` and
    `EVENTS_MAX_PER_CAMPAIGN`.
- **Combat tracker.**
  - **Death saves** for player characters: success and failure marks, a d20 field and **Roll for me**, Natural 20
    (back up at 1 HP) and Natural 1 (two failures), **Stable** and **Dead**, and extra failures for damage at 0 HP
    (two for a critical hit). Damage that brings a character past 0 HP by at least their maximum HP kills at once.
    Damage that temporary HP absorbs adds no failure; this is a table convention, and the help text in the tracker
    says so. Players see these marks for characters only.
  - **Legendary actions** (spend and undo; they refill when the creature's turn starts) and **Legendary Resistance**
    (use and give back; a new round never resets it), read from the statblock when you add the creature. Players never
    see either.
  - **Recharge** abilities: mark one as used, and at the start of the creature's turn the tracker rolls the d6 and
    shows the roll to you only.
  - **Lair actions**: a hidden row on initiative 20 that loses ties, and a toggle for creatures that are in their lair.
    While a hidden row acts, players see no highlighted turn.
  - **Ready** (with a trigger; players see it for player characters only) and **Move after**, which moves a combatant
    to just after another one. Move after is the tracker's way to handle Delay, a table convention rather than a rule
    printed in the core books. When the active creature moves, the turn passes on at once and its conditions do not
    tick.
  - A **More** section on each row, two toolbar groups, and one-key shortcuts on a row (press `?` for the list).
- **Query block views.** A query block can show its pages as a **table** or as **cards** as well as a list. A column
  picker chooses and orders the columns (type, tags, dates, details and properties). Anyone who views a table can sort
  it by clicking a header; that sorting is not saved. Players see only the rows and columns they may see.

### Changed

- Empty values in a query now sort last in both directions.
- A backup may now compress its database up to 200 to 1 instead of 50 to 1 when it is checked, because a database with
  a lot of history compresses very well. Backups and restores work as before.

### Fixed

- A player saving a page no longer destroys the game master's content on it.
  - Links to pages the player cannot see survive when the player edits another paragraph or the text around them, also
    when the link's label is bold or italic or appears more than once in the paragraph. The link comes back without
    bold or italic.
  - A callout or other container saved without its contents keeps its DM-only blocks. Repeated or reused block ids can
    no longer duplicate DM-only blocks or take over their ids.
  - A link or embed that a player adds to a page they cannot see is dropped from their save (a link becomes plain text),
    so a save cannot be used to find out which pages exist.
  - A player cannot mark a block as revealed.
  - Players still never receive the hidden pages' ids or DM-only text. To keep this safe, a player's save has limits: a
    paragraph can hold at most 100,000 characters (text plus link labels) and a page at most 2 MB. See Known issues.
- The live combat view closes when someone loses access while it is open (removed from the campaign, disabled, signed
  out, password changed, or no longer a co-DM for the DM view). It used to check only when it opened. The check runs
  at least every 25 seconds.

### Upgrade notes

1. **Back up first**, with the version that is running now, and copy the backup off the machine:
   - Docker: `docker compose exec app node admin.mjs backup`
   - Without Docker: `node apps/server/dist/admin.mjs backup`
2. **Update.**
   - Docker: set `CN_VERSION` to the new version in `.env` (or follow `latest`), then
     `docker compose pull && docker compose up -d`.
   - Without Docker: check out the new tag, run `pnpm install && pnpm build`, and restart the server.
3. **Migration 0007 adds the page history table.** It runs when the server starts and **cannot be undone**.
4. History starts empty. The first time a page is edited after the upgrade, its earlier state is stored as a
   "before history was recorded" version, so you can get back to what the page was before that edit.
5. Sessions and logins keep working. Nobody is signed out.
6. The new settings are optional and their defaults suit most tables: `HISTORY_KEEP_ALL_DAYS` (30),
   `HISTORY_COALESCE_MINUTES` (2), `HISTORY_MONTHLY_AFTER_DAYS` (365), `HISTORY_MAX_PER_PAGE` (200),
   `HISTORY_MAX_MB_PER_CAMPAIGN` (500), `EVENTS_MAX_CONNECTIONS` (500) and `EVENTS_MAX_PER_CAMPAIGN` (100). See the
   [README](README.md#configuration).
7. **There is no downgrade.** To go back, stop the app, set `CN_VERSION` back to your old version and restore the
   backup you made before updating:
   `docker compose run --rm app node admin.mjs restore /data/app/backups/<file> --yes`. This discards everything
   written since that backup, signs everyone out, and revokes API tokens and invite links.
   Starting an older version on an upgraded database is not refused, but it is not supported.
8. Backups made by 1.3 are refused by 1.2.x (exit code 66, "update first"). Backups from 1.2.x restore into 1.3 and are
   migrated on the way.

### Known issues

- If a player rewrites the label of a link to a page they cannot see, the link is lost when they save. When a link is
  kept on a bold or italic label, it comes back without bold or italic.
- A long paragraph written by the DM (over 100,000 characters, text plus link labels) cannot be saved by a player.
- Players can save pages only up to 2 MB.
- The check on page-link properties can confirm to a player who already knows a hidden page's id that the page exists.
  Fixed in 1.3.1.
- When a player moves a paragraph into a container, such as a callout, it may lose the DM's hidden link. Fixed in
  1.3.1.
- A player who was offline when something was revealed is not told about reveals on pages they did not have open. They
  see the change when they open the page.
- History folds saves by the same author within 2 minutes into one version, so a paste you regret can overwrite up to 2
  minutes of earlier state. Lower `HISTORY_COALESCE_MINUTES` for finer versions.

## [1.2.0] - 2026-10-22

The editor's block options can now be used from the keyboard. There is nothing to do when updating; no database change is
needed.

### Added

- The editor's block options (turn into, wrap, move up and down, duplicate, delete, DM-only) can be opened without a mouse: press `Ctrl+.` with the caret in a block, or use the new "Block options" button in the formatting toolbar. The menu works with the arrow keys, Home, End, Esc and Tab, and a screen reader is told what an action did ("Block moved down").
- Block options has "Move up" and "Move down" (before, a block could only be moved by dragging).

### Changed

- Block options (move, duplicate, wrap) add an empty paragraph when they leave a table, list, callout, embed or rule as the last block, so a caret can always go below it.
- Every page title now ends with "— Critical Notes" (Trash, the campaign pages and the campaign overview were missing it), and the title is set before the page loads where the route knows it.
- Accessibility: Trash shows its "purged in N days" text in the accent colour from 3 days left; checked for contrast in both themes (8.5:1 and 5.7:1) and the days are written out, so colour is not the only cue.

### Fixed

- On a wide window that is less than 500 px high (a laptop with a docked console, a landscape tablet, or any window in forced-colours mode), the second row of the top bar covered the page heading.

## [1.1.2] - 2026-10-22

An accessibility and size release. There is nothing to do when updating; no database change is needed. The web app loads
about a third less code on first open.

### Changed

- Accessibility: tables in pages are named after the heading above them, in the editor and in the read-only view.
- Accessibility: the editor's `/`, `[[` and `{@` menus tell screen-reader users how many results there are and which one is active.
- Accessibility: heading levels in pages, the player preview and reference entries no longer skip a level under the page title (the look is unchanged).
- Accessibility: the editor's block drag handle is at least 24 x 24 px (44 x 44 px on touch).
- Accessibility: in forced-colours (high-contrast) mode the primary buttons have a border and the selected reference row, the current menu item and the active suggestion are outlined.
- Accessibility: the reference list is a plain list of buttons (the current entry is marked) instead of a listbox with buttons inside.

### Fixed

- Ctrl+K no longer starts Firefox's own search while a confirmation dialog is open.

## [1.1.1] - 2026-10-22

An accessibility release. There is nothing to do when updating; no database change is needed.

### Changed

- Every confirmation (deleting, leaving, discarding changes, ending combat) now asks in the app's own dialog instead of the browser's confirm box: keyboard and screen-reader friendly, and it follows the dark theme.
- Accessibility: the search box and the reference pickers are proper comboboxes: arrow keys, the active result is announced, and the number of results is read out.
- Accessibility: the editor's formatting toolbar buttons are at least 24 x 24 px (44 x 44 px on touch), and the admin screens' row buttons are taller (about 34 px, 44 px on touch).
- Accessibility: the "DM" badge on secret blocks is larger (12 px) and readable in the dark theme.
- Long page titles on the campaign overview, in "Linked from" and in the sidebar wrap instead of being cut off.

## [1.1.0] - 2026-10-22

Follow-up to 1.0.0: one new account feature, an accessibility pass, and a fix for the page count players see.
There is nothing to do when updating; no database change is needed.

### Added

- **Sign out other sessions** on the Account page: ends every other browser session of your account without changing
  your password. This browser stays signed in.

### Changed

- Revoking an AI token on the Account page asks in the app's own dialog instead of the browser's confirm box.
- Accessibility: after you open another page, focus moves to its main heading (and the page is announced), so keyboard
  and screen-reader users start at the top of the new page.
- Accessibility: form fields in campaign settings, NPC lists and statblocks, the homebrew editors, the reference
  filter, the command palette and the editor blocks now have a border that meets the 3:1 contrast minimum.
- Accessibility: the campaign sidebar links and header buttons are at least 24 x 24 px on desktop.

### Fixed

- Accessibility: the phone campaign menu is a proper dialog (was an invalid role on `aside`); editors now have a page
  heading and a named editing area; read-only task items, ability scores, reference pickers and the "DM only" menu
  ticks have proper names; read-only page icons are no longer shown as disabled text boxes; primary buttons use readable
  text in the dark theme.
- The campaign list (and the AI assistant's `list_campaigns`) now counts only the pages a player can see. Before, a
  player's count included pages hidden from them (no titles or text were exposed).

## [1.0.0] - 2026-10-22

The first stable release. It adds account recovery, instance backups and restore, undo for deletions, a layout for
phone-width screens, and a published Docker image to update from.

### Before you start

- Critical Notes ships **no game content**. You clone the 5etools data yourself (about 1 GB; the optional images are
  about 13 GB) and should use it only for books you own. See [Before you start](README.md#before-you-start-the-5etools-data).
- **Backups are not encrypted.** A backup holds password hashes and DM secrets. Encrypt it before it leaves your
  machine ([Copying backups off the machine](README.md#copying-backups-off-the-machine)).
- With the shipped `docker-compose.yml`, backups are written into the same `app-data` volume as your data, so
  `docker compose down -v` deletes them too. Copy them elsewhere or set `BACKUP_DIR`.
- `GET /api/health` is public. It returns only `ok` and the version; a reverse proxy can restrict it.

### Added

- **Accounts and administration.**
  - Every user has an Account page where they change their display name and password.
  - Admins get a **Users** page (Admin > Users) to disable and enable accounts, grant and revoke the admin role,
    delete a user (you choose, per campaign they own, whether to transfer it or archive it), and create a one-time
    password reset link. Protected actions ask for the admin's own password again.
  - **Password reset links.** A link opens `/reset#<token>`, works once, expires after 24 hours, and a newer link
    replaces an older one. Anyone with shell access can create one when the only admin is locked out:
    `docker compose exec app node admin.mjs reset-link <username>`.
  - Disabled accounts cannot sign in, and their API tokens stop working.
  - Sign-in and reset attempts are rate limited. Set `TRUST_PROXY=1` only behind a reverse proxy that overwrites
    `X-Forwarded-For`.
- **Backups and restore.**
  - **Admin > Backups** makes a backup with one click, lists them, and downloads one (after you enter your password).
    `node admin.mjs backup` does the same from the command line.
  - A backup is one zip with the database and all uploads. It is made while the app runs, and read back and checked
    before it counts.
  - **Scheduled backups.** The shipped `docker-compose.yml` makes one every 24 hours and keeps the newest 7
    (`BACKUP_EVERY_HOURS`, `BACKUP_KEEP`; set `BACKUP_EVERY_HOURS=0` to turn it off). A bare install keeps them off
    until you set `BACKUP_EVERY_HOURS`. `BACKUP_DIR` puts the backups on another disk.
  - **Restore is done on the command line only**, on purpose: `node admin.mjs restore <file> --check` verifies a
    backup without changing anything, and `--yes` restores it. It signs everyone out, revokes API tokens and invite
    links, keeps your old data in a `pre-restore-<time>` folder, and rolls back if it fails. A backup from an older
    version is upgraded while restoring; a backup from a newer version is refused.
  - A written guide with recovery steps and a restore rehearsal: [Backups](README.md#backups).
- **Trash.**
  - Deleting a page moves it, with its subpages, to the Trash. The editor no longer asks for confirmation; a
    **Deleted · Undo** message appears instead.
  - A **Trash** page for DMs and co-DMs lists deleted pages, with Restore and Delete permanently. Trash is emptied
    after 30 days.
  - Deleted templates get the same treatment: a **Deleted templates** list in the template library, with Restore and
    Delete permanently, and automatic removal after 30 days.
  - AI assistants can list the trash (`list_trash`) and restore a deleted page (`restore_page`). Permanent deletion
    (purge) is not available to them.
- **Phone-width screens for players.** Below 1024 px the header is one compact row with a menu, and the campaign
  navigation opens as a drawer. Joining by invite, reading shared pages, your own character, the inventory, the dice
  log and the combat screen for players are laid out for widths from 320 to 430 px, with 44 px tap targets and 16 px
  form text, except inline dice rolls (about 29 px high), the editor's formatting toolbar (21 to 34 px) and the inline
  "Sign in" link on the invite page. A browser test runs these player flows in an emulated phone (390 x 844, touch). This was checked in
  Chrome's phone emulation only: iOS Safari, a real on-screen keyboard and notched screens have not been tried on real
  devices. The DM's prep screens (settings, encounters, the tracker controls, the admin pages) stay desktop-first and
  can still be cramped or overflow on a phone.
- **Version in the app.** The Account page shows the version, `GET /api/health` returns it (`{"ok":true,"version":...}`),
  and every backup records it.
- **Published Docker image.** `ghcr.io/merilairon/critical-notes` for `linux/amd64` and `linux/arm64`, tagged `X.Y.Z`,
  `X.Y` and `latest`. The amd64 image was tested; the arm64 image is built by the release workflow and has not been run
  on arm64 hardware. `docker-compose.yml` uses it; pin a version with `CN_VERSION`. To build from a checkout instead,
  add `-f docker-compose.build.yml`.
- **License and project files.** Critical Notes is licensed under the Apache License 2.0. The repository has a contributing
  guide (DCO sign-off, no CLA), a security policy, third-party notices, issue and pull request templates, and a CI check
  for every pull request.

### Changed

- Some screens look slightly different on a desktop as well, because the phone layout shares their code: a page title
  you can read is a heading that wraps, and an editable title wraps over several lines instead of being cut off;
  read-only fields show plain text with a dash for an empty value; the inventory is a list of cards at every width;
  placeholder text is darker for contrast.
- Deleting a page no longer asks for confirmation. Use Undo, or restore it from the Trash within 30 days.
- Changing your password signs out your other sessions (the current one stays).

### Upgrade notes

- This is the first stable release; there is nothing to migrate from a previous stable version, and no setting is required.
- If you ran a development build of Critical Notes, **make a backup first**. This release adds database migrations that
  cannot be undone, and you cannot go back to the older build with the migrated data.

## [1.0.0-rc.3] - 2026-10-22

Third release candidate. It fixes the findings of the CodeQL code scan; none of them changes what you see.

- **Security hardening:** several regular expressions that could run slowly on crafted input are now linear, and the
  helper that sets a value by path refuses `__proto__`, `constructor` and `prototype` keys.
- **Reference data:** the content hash of indexed rows is now SHA-256 instead of SHA-1. The first start after the update
  rewrites the reference rows once.

What to test is the same as for rc.1 and rc.2. A release candidate publishes only its own tag; it does not move `1.0` or
`latest`.

## [1.0.0-rc.2] - 2026-10-22

Second release candidate. It fixes one bug found while testing rc.1.

- **Backups:** two backups could, in a rare race, both think they held the backup lock after a crashed backup left a stale
  lock behind. Taking over a stale lock is now serialised.

What to test is the same as for rc.1: the image on `linux/arm64`, an update on a volume that holds data, and phone-width
screens for players on a real phone. A release candidate publishes only its own tag; it does not move `1.0` or `latest`.

## [1.0.0-rc.1] - 2026-10-22

First release candidate of 1.0.0. It exists to prove the release pipeline and the image, not to add anything.

What to test:

- The image on `linux/amd64` and, above all, `linux/arm64` (a Raspberry Pi or another arm64 machine). The arm64 build has
  never run.
- An update from a previous build on a volume that holds data, and `/api/health` showing `1.0.0-rc.1`.
- Phone-width screens for players on a real phone. They were checked in Chrome's phone emulation only.

The changes in 1.0.0 are listed in the draft above, under "Unreleased". A release candidate publishes only the tag
`1.0.0-rc.1`; it does not move `1.0` or `latest`.

[Unreleased]: https://github.com/Merilairon/critical-notes/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/Merilairon/critical-notes/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/Merilairon/critical-notes/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/Merilairon/critical-notes/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Merilairon/critical-notes/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Merilairon/critical-notes/releases/tag/v1.0.0
[1.0.0-rc.3]: https://github.com/Merilairon/critical-notes/releases/tag/v1.0.0-rc.3
[1.0.0-rc.2]: https://github.com/Merilairon/critical-notes/releases/tag/v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/Merilairon/critical-notes/releases/tag/v1.0.0-rc.1
