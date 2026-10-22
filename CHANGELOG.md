# Changelog

All notable changes to Critical Notes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Before you update, read the entries between your version and the new one, and
[make a backup](README.md#updating). Database changes are applied when the server starts and cannot be undone.

<!--
  RELEASE NOTE (delete this comment when you cut the release; see docs/RELEASE.md):
  The text below is the draft of the 1.0.0 entry. Its "### Upgrade notes" heading is the one the README "Updating"
  section refers to: keep an "Upgrade notes" heading in every release that needs the reader to do something.
  At release time rename the heading "## [Unreleased]" to
  "## [1.0.0] - YYYY-MM-DD", and put a new empty "## [Unreleased]" above it. The release workflow only reads a
  "## [X.Y.Z] - date" section, never "[Unreleased]".
-->

## [Unreleased]

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
- **Published Docker image.** `ghcr.io/merilairon/critical-notes` for `linux/amd64` and, once the first release
  candidate has been confirmed to run on arm64, `linux/arm64`, tagged `X.Y.Z`,
  `X.Y` and `latest`. `docker-compose.yml` uses it; pin a version with `CN_VERSION`. To build from a checkout instead,
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

[Unreleased]: https://github.com/Merilairon/critical-notes/commits/main
[1.0.0-rc.2]: https://github.com/Merilairon/critical-notes/releases/tag/v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/Merilairon/critical-notes/releases/tag/v1.0.0-rc.1
