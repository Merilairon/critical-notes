# Changelog

All notable changes to Critical Notes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Before you update, read the entries between your version and the new one, and
[make a backup](README.md#updating). Database changes are applied when the server starts and cannot be undone.

<!--
  RELEASE NOTE (delete this comment when you cut the release; see docs/RELEASE.md):
  The text below is the draft of the 1.0.0 entry. At release time rename the heading "## [Unreleased]" to
  "## [1.0.0] - YYYY-MM-DD", and put a new empty "## [Unreleased]" above it. The release workflow only reads a
  "## [X.Y.Z] - date" section, never "[Unreleased]".
-->

## [Unreleased]

The first stable release. Critical Notes can now be trusted with years of campaign notes: you can recover a locked-out
account, back up and restore the whole instance, undo deletions, and update from a published image.

Phone-width layouts are **not** part of this release: the screens have not been audited or tuned for narrow phones.

### Added

- **Accounts and administration.**
  - Every user has an Account page where they change their display name and password. Changing the password signs
    out their other sessions.
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
  - AI assistants can read the trash with the `list_trash` tool. They cannot restore or purge.
- **Version in the app.** The Account page shows the version, `GET /api/health` returns it (`{"ok":true,"version":...}`),
  and every backup records it.
- **Published Docker image.** `ghcr.io/merilairon/critical-notes` for `linux/amd64` and `linux/arm64`, tagged `X.Y.Z`,
  `X.Y` and `latest`. `docker-compose.yml` uses it; pin a version with `CN_VERSION`. To build from a checkout instead,
  add `-f docker-compose.build.yml`.
- **License and project files.** Critical Notes is licensed under the Apache License 2.0. The repository has a contributing
  guide (DCO sign-off, no CLA), a security policy, third-party notices, issue and pull request templates, and a CI check
  for every pull request.

[Unreleased]: https://github.com/Merilairon/critical-notes/commits/main
