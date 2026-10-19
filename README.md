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
docker compose up -d       # pulls the published image the first time; then open http://localhost:3000
```

No published release yet, or the pull is denied (the package is private)? Build the image from this checkout instead:
`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.

The first visit asks you to create the admin account. Players join through invite links that a DM creates
in the campaign's settings (there is no open sign-up).

- The 5etools folders are mounted read-only. Your data (database, search index, uploaded images) lives in the
  `app-data` volume, and `docker compose down -v` deletes it. Scheduled [backups](#scheduled-backups) are on by
  default (one every 24 hours, into that same volume), so [copy them off the machine](#copying-backups-off-the-machine).
- The app runs as an unprivileged user, on port 3000 inside the container (`PORT=8080 docker compose up -d`
  to publish another port).
- Set `PUBLIC_URL` to the address people use (for example `https://notes.example.org` behind a reverse proxy
  that handles TLS). With an `https://` address, session cookies are marked Secure.

**Image and versions.** Compose uses the published image `ghcr.io/merilairon/critical-notes` (linux/amd64 and
linux/arm64). `docker compose pull && docker compose up -d` moves to the newest release; database migrations run when the
server starts, so [make a backup first](#backups). Pin a version with `CN_VERSION=1.2.0` in `.env` (the default is `latest`).
To build from a checkout instead (before the first release, if the pull is denied, or while developing):
`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.

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
| `BACKUP_KEEP` | `7` | Backups to keep, 1 to 1000 (an invalid value logs a warning and uses 7). Backups made from the web page are protected for 7 days and do not count until then |
| `BACKUP_EVERY_HOURS` | off (`24` in `docker-compose.yml`) | Make a backup in the server every N hours, 1 to 720 (`0` or unset = off; recommended `24`). The shipped `docker-compose.yml` turns it on with 24; put `BACKUP_EVERY_HOURS=0` in the `.env` next to it to turn it off, see [Backups](#scheduled-backups). After downtime one catch-up backup is made about a minute after start; it is skipped while a backup or a restore is running. An invalid value stops the server from starting. The Backups page shows the next run |
| `BACKUP_DIR` | `DATA_DIR/backups` | Where backup zips go; use another disk or mount so the backups survive the data. Must not be inside the web build, the uploads or the 5etools folders, or `DATA_DIR` itself, and must not be world-writable (the server refuses to start) |
| `PORT` | `3000` | |
| `PUBLIC_URL` | `http://localhost:4200` | The address people open; requests from other origins are refused |
| `SECURE_COOKIES` | from `PUBLIC_URL` | `1` or `0` to override (for example behind a TLS-terminating proxy that forwards plain http) |
| `TRUST_PROXY` | off | `1` behind a reverse proxy that overwrites `X-Forwarded-For`, so rate limits tell clients apart. Leave off when the port is reachable directly (the header could be spoofed); the app logs one warning if it sees the header while this is off |
| `WEB_DIST_DIR` | `./apps/web/dist/web/browser` | The built web app, served in production |

## Locked out? Recover an account

Anyone with shell access to the server (or its container) can issue a one-time password reset link for any
enabled user, including the only admin. Admins can also create links from the Admin page.

```sh
docker compose exec app node admin.mjs reset-link <username>      # with Docker
node apps/server/dist/admin.mjs reset-link <username>             # without Docker, after `pnpm build`
```

It prints the link (`<PUBLIC_URL>/reset#<token>`) on stdout and nothing else, so it can be piped; hints go to
stderr. Open the link, choose a new password; the link works once, expires after 24 hours and replaces any
earlier link for that user. Reading the settings works as for the server: environment variables, plus the
repository `.env` outside Docker (so run it with the same `DATA_DIR` and `PUBLIC_URL` as the server; the
Docker image has them set). It is safe to run while the app is running, but `admin.mjs` must be the same version as the running server (it applies pending migrations when it opens the database). Exit codes: 1 unknown user, 2 disabled
user (enable it first; this command cannot), 3 no database found at `DATA_DIR`, 64 wrong usage.

## Backups

Years of campaign notes should not live on one disk. A backup is a single zip file with your whole instance in it,
and you can make one in a few seconds while the app is running. This section shows how to make backups, how to
get them off the machine, and how to restore one. Restoring is done on the command line, on purpose.

Jump to: [Quick start](#quick-start) · [What is in a backup](#what-is-in-a-backup) ·
[Making backups](#making-backups) · [Copying backups off the machine](#copying-backups-off-the-machine) ·
[Restoring](#restoring) · [Restoring onto a new or wiped machine](#restoring-onto-a-new-or-wiped-machine) ·
[Exit codes](#exit-codes) · [When something goes wrong](#when-something-goes-wrong) ·
[If you think you were compromised](#if-you-think-you-were-compromised) ·
[Rehearse a restore](#rehearse-a-restore) · [File permissions](#file-permissions)

### Quick start

With Docker (run these in the folder with `docker-compose.yml`):

```sh
# 1. make a backup; it prints its path
docker compose exec app node admin.mjs backup
# 2. copy it out of the container (use the name printed in step 1)
docker compose cp app:/data/app/backups/backup-<time>.zip .
# 3. prove it would restore; changes nothing
docker compose run --rm app node admin.mjs restore /data/app/backups/backup-<time>.zip --check
```

Without Docker (run these in the repository folder, after `pnpm build`):

```sh
# 1. make a backup; it prints the path, by default var/backups/backup-<time>.zip
node apps/server/dist/admin.mjs backup
# 2. a copy somewhere else (see "off the machine" below: encrypt it)
cp var/backups/backup-<time>.zip /some/other/disk/
# 3. prove it would restore; changes nothing
node apps/server/dist/admin.mjs restore var/backups/backup-<time>.zip --check
```

To restore, see [Restoring](#restoring). Then do two more things today: check that [scheduled
backups](#scheduled-backups) are on (they are by default with Docker; a bare install needs `BACKUP_EVERY_HOURS`) so
you do not depend on remembering, and decide where the copies go (the backup is on the same disk as your data until
you move it).

### What is in a backup

`backup-<UTC date and time>.zip`, for example `backup-20261017T223817Z.zip` (the time is UTC), holds:

| In the zip | What it is |
|---|---|
| `app.sqlite` | The database: users, **password hashes**, **API-token hashes**, sessions, every campaign with its pages, DM secrets, homebrew, templates, encounters, inventory, invites |
| `uploads/` | Every uploaded image and its thumbnail |
| `manifest.json`, `checksums.json` | The app version, the database version, counts, and a checksum of every file, so a damaged copy is noticed |

It does **not** hold the 5etools data or the search index: those are rebuilt from your clones (the index on the
first start after a restore). It also does not hold your settings (`.env`, `docker-compose.yml`, `PUBLIC_URL`):
keep those somewhere safe yourself.

> **Treat a backup like the database.** Anyone who gets the file gets every password hash and every DM secret
> of every campaign, in plain form (the app does not encrypt backups). Do not email it, do not put it in a shared
> folder, and encrypt every copy that leaves your machine (see [below](#copying-backups-off-the-machine)).
> Only admins can download one from the web page, and only after typing their password again.

> **A backup next to the data protects you from mistakes, not from a dead disk.** By default backups are in
> `backups/` inside the data directory, on the same disk. With Docker that is the `app-data` volume, and
> `docker compose down -v` deletes the volume together with every backup in it. Until a copy is somewhere else,
> you have protection against "I deleted the wrong campaign", not against "the disk died".

### Making backups

There are three ways. All of them make the same kind of file, safely while the server is running and people are
editing, and each file is read back and checked before it counts.

**From the web page.** Sign in as an admin and open **Admin > Backups** (`/admin/backups`), then choose
**Back up now**. The page lists every backup with its size, who made it (web page, command line or scheduled) and
what it holds, and has the **Download** button. You can make at most 3 backups per 10 minutes this way.

**From the command line.**

```sh
# with Docker; the path printed is inside the container: /data/app/backups/backup-<time>.zip
docker compose exec app node admin.mjs backup
# without Docker, from the repository folder
node apps/server/dist/admin.mjs backup
```

It prints the path of the new zip on stdout and nothing else there; the progress, a short audit line and a reminder
go to stderr. (In a cron job or script use `docker compose exec -T app ...`, which does not need a terminal.) Exit
code 0 means the backup exists and was verified. If the server is writing constantly, a command-line backup can be
restarted several times and give up after 10 minutes with exit code 70: run it again when the instance is quiet (see
[When something goes wrong](#when-something-goes-wrong)).

#### Scheduled backups

Set `BACKUP_EVERY_HOURS` and the server makes a backup by itself every N hours (1 to 720). With Docker Compose it
is **on by default**: the shipped `docker-compose.yml` uses 24 hours and keeps the newest 7. A bare install
(without Docker) is **off by default**; we recommend `24` there too. This matters for more than convenience: retention keeps only the newest
backups, so if you only ever make them by hand, the day you finally need one it may be the old one you made last
spring. A schedule keeps fresh backups coming and is also what protects your older ones from being pushed out (see
[Retention](#how-long-backups-are-kept)).

With Docker, put `BACKUP_EVERY_HOURS`, `BACKUP_KEEP` or `BACKUP_DIR` in a `.env` file next to `docker-compose.yml`;
Compose passes them into the container (an empty `BACKUP_KEEP` or `BACKUP_DIR` counts as unset, an empty
`BACKUP_EVERY_HOURS` as the default 24). For example, `.env` with `BACKUP_EVERY_HOURS=0`
turns scheduled backups off, and `BACKUP_EVERY_HOURS=12` makes one every 12 hours. Without Docker, add
`BACKUP_EVERY_HOURS=24` to `.env` in the repository folder (or the server's environment).

Run `docker compose up -d` after changing `.env`. The server log says `Scheduled backups: every 24 h, keeping 7` at start,
and the Backups page shows `Scheduled backups: every 24 hours, next run <time>`.

- The next run is the newest backup (from any source) plus the interval, so a backup you make by hand postpones
  the next scheduled one, and a restart does not reset the clock.
- After downtime, or on the first start, if nothing is newer than the interval, **one** catch-up backup is made
  about a minute after the server starts (60 to 90 seconds). Missed runs are not repeated.
- A scheduled run is skipped, not queued, while another backup or a restore is running, and tried again after 5
  minutes. If a run fails it retries after 15 minutes, then after longer waits; the Backups page shows the last
  error and the server log has a `backup.failed` line.
- A value that is not a whole number from 1 to 720 (`24h`, `1.5`) stops the **server** from starting, with
  `Refusing to start: BACKUP_EVERY_HOURS must be a whole number from 1 to 720 ...`. The command line still works.

#### How long backups are kept

After every successful backup the oldest ones are deleted so that the newest `BACKUP_KEEP` remain (default `7`,
allowed 1 to 1000). A failed backup deletes nothing. Only files named like `backup-<date>T<time>Z.zip` are ever
touched; ordering uses the time in the name, so copying a file does not change its age.

- **`BACKUP_KEEP` counts files, not days.** With `BACKUP_EVERY_HOURS=24` and the default 7 you have the last 7
  days; with `BACKUP_EVERY_HOURS=1` you would have only the last 7 hours. If you might notice a mistake
  later than that, raise `BACKUP_KEEP` (each backup is about the size of your database plus your uploads) and copy
  older backups off the machine.
- **Backups made with Back up now are never removed automatically during their first 7 days and do not count
  towards `BACKUP_KEEP` until then; after that they count like any other (you can still delete them by hand).**
  This stops a stolen admin session from clicking "Back up now" a few times and rotating all your real
  backups out. In practice: right after a busy week of web-page backups you will see more than 7 files; they join
  the normal count once they are a week old. At most `3 x BACKUP_KEEP` of these young web-page backups are allowed
  (21 by default); beyond that **Back up now** refuses and says to use the command line, which has no such cap.
- Deleting a backup by hand (delete the file) is fine. There is no delete button on purpose.

#### Putting backups on another disk (`BACKUP_DIR`)

`BACKUP_DIR` (default `DATA_DIR/backups`) is where zips are written and listed. Point it at another disk or mount
so a dead data disk does not take the backups with it. The server refuses to start (and the command line refuses
to run) if it is `DATA_DIR` itself, inside or around the uploads, the web build or the 5etools folders, or
world-writable, or if the user the app runs as cannot write in it (see [When something goes wrong](#when-something-goes-wrong)). If you
change it later, backups in the old place are no longer listed or cleaned up.

With Docker, mount a host folder and set `BACKUP_DIR` in the `.env` next to `docker-compose.yml`. The app runs as
the unprivileged user `node` (uid 1000), so the folder must belong to that user.

Create the folder with the right owner **before** the first `docker compose up`; if it does not exist, Docker
creates it owned by root, and the server then refuses to start (see [When something goes wrong](#when-something-goes-wrong)):

```sh
mkdir -m 700 /mnt/backupdisk/critical-notes && sudo chown 1000:1000 /mnt/backupdisk/critical-notes
```

```sh
# .env
BACKUP_DIR=/backups
```

Under Docker, `BACKUP_DIR` is a path **inside the container** (use an absolute path such as `/backups`; a relative
path would be wrong), not a path on the host. A folder outside the `app-data` volume therefore has to be mounted there. `docker-compose.yml`
has no such mount, so add one in a `docker-compose.override.yml` next to it (Compose reads that file automatically):

```yaml
# docker-compose.override.yml
services:
  app:
    volumes:
      - /mnt/backupdisk/critical-notes:/backups
```

Inside the container the files are then in `/backups/` (use that path in the restore commands below). A host folder
also makes the next section easier: it is a normal folder you can `rsync`.

#### Stopping the server while a backup runs

When the server gets a stop request (`docker compose stop`, `docker stop`, `systemctl stop`, Ctrl+C), it stops
accepting requests and waits up to 8 seconds for a running backup, whether it is scheduled or from the web page. Then
it closes its databases and exits. If the backup did not finish in time, the log says `Shutting down: the running
backup did not finish in time; it was stopped, nothing was published and its partial files and lock were removed`:
no partial file is ever listed, and a new backup can start right after the restart. Only a forced end (a second stop
request while it waits, `kill -9`, a power cut) leaves leftovers behind; see "A backup is already running" under
[When something goes wrong](#when-something-goes-wrong). An idle server
stops well under a second; a stop during a backup can take up to about 10 seconds (the 8-second wait plus a moment
to finish open requests). Compose allows 15 seconds (`stop_grace_period`), so `docker compose stop` is never cut
short. With plain `docker run`, Docker's default is 10 seconds, so add `--stop-timeout 15` if you may stop the
container during a backup.

### Copying backups off the machine

Do this regularly (right after each scheduled backup is a good rhythm), and **encrypt first**: only encrypted
files should ever leave the machine. Any of these work: `age`, `gpg`, or a backup tool that encrypts, such as
restic or borg. With gpg, which is on most systems:

```sh
mkdir -p encrypted-copies
# encrypt (asks for a passphrase)
gpg --symmetric --cipher-algo AES256 --output encrypted-copies/backup-20261017T223817Z.zip.gpg backup-20261017T223817Z.zip
# later: decrypt it again, privately
( umask 077; gpg --output backup-20261017T223817Z.zip --decrypt encrypted-copies/backup-20261017T223817Z.zip.gpg )
```

Keep the passphrase in a password manager, not next to the file: a backup you cannot decrypt is not a backup. Copy
only the `.gpg` file to a cloud drive, another computer, or a USB disk kept elsewhere, and delete the plain zip you
encrypted from any shared or synced location. (`gpg --decrypt` writes a world-readable file unless you set `umask 077`
first, as above, or run `chmod 600` on the result.)

**Download from the web page.** On **Admin > Backups**, choose **Download** on a backup and type your password. The
page swaps the password for a single-use link that works for 60 seconds, and your browser saves the file. If it
says "too many downloads", wait a few seconds and choose Download again. If you run the app behind a reverse proxy,
its access log records the full address of the download, which contains the one-time `ticket=` parameter. The
ticket is useless after one use, but tell your proxy to leave that parameter out of its logs.

**With Docker, copy it out of the container.** Use the name of the file as listed on the Backups page or printed by
the `backup` command:

```sh
docker compose cp app:/data/app/backups/backup-20261017T223817Z.zip .
```

(Run it in the folder with `docker-compose.yml`. The copy has mode 0600 and may belong to uid 1000, so if that is
not you, you may need `sudo` to read it. `docker compose cp app:/data/app/backups/ ./all` copies the whole
folder.) If you set `BACKUP_DIR` to a host folder as above, you do not need `cp`: the files are already there.

**Without Docker, or from a host folder**, with `rsync` or `scp`:

```sh
rsync -av --include='*.gpg' --exclude='*' encrypted-copies/ you@otherbox:/srv/critical-notes-backups/
scp encrypted-copies/backup-20261017T223817Z.zip.gpg you@otherbox:/srv/critical-notes-backups/
```

Both send only the encrypted files. `rsync` without `--delete` keeps every backup on the other side, including those the app has since
rotated out: good for history, but it grows until you clean it up.

### Restoring

**Restoring is only done from the command line, on the machine that runs the app, never from the web page.**
It replaces all your data, and a restore that anyone with a stolen admin cookie could start would be a way to
swap in someone else's database. Whoever can run these commands can already read your data directory anyway.

What you need: the backup file, shell access, and the app **stopped**. Restore refuses to run while the server is
up (exit code 69).

#### It is 3 a.m. and something is wrong

Breathe. Nothing is lost yet if you do these in order and avoid the list at the end.

1. **List your backups.** The newest is last:
   `docker compose run --rm app ls -1 /data/app/backups` (Docker) or `ls -1 var/backups` (without Docker). If you
   copied backups elsewhere, use the newest of those.
2. **Check the one you will use** with `restore <file> --check` (recipes below). It prints the file's `sha256`; compare it
   with `sha256sum <file>` on a copy you kept elsewhere to know the file is the one you saved.
3. **Restore it** with the recipe below. Your current data is moved aside, not deleted, so you can still undo.

What **not** to do:

- `docker compose down -v`, `docker volume prune` or `docker system prune --volumes`: they delete the volume with
  your data **and** your backups.
- Do not copy `app.sqlite` by hand while the server runs: the newest changes are in a second file (`app.sqlite-wal`),
  and a copy without it is incomplete or damaged. Use `backup`.
- Do not start the app (`docker compose up -d`) on a new machine before you restore: it would create an empty
  instance first.
- Do not unzip a backup over the data directory, and do not delete `pre-restore-*` before you have checked the
  restored instance.

*Last resort*, only if the zip is all that survived and `--check` refuses it (for example exit 65 because of an
extra object in the database): `unzip -p backup.zip app.sqlite > app.sqlite` and `unzip backup.zip 'uploads/*'` give you
the raw files. This **skips every protection of the restore**: no checksum or schema check, and sessions, API
tokens and invite links are not cleared. Put them in an empty data directory with the app stopped, start the app,
then reset your admin password and revoke tokens by hand. Prefer `restore` whenever it accepts the file.

#### With Docker

```sh
docker compose stop app
```

Check the file first. This changes nothing and tells you what is in it:

```sh
docker compose run --rm app node admin.mjs restore /data/app/backups/backup-20261017T223817Z.zip --check
```

You should see `... is complete and restorable. Nothing was changed.`, when it was made, how many users, campaigns
and uploads it holds, and the enabled administrators in it. If the backup is not in the volume (it came from
somewhere else), mount it for the command; the `-v` needs the full path of the file on the host (here the current
folder), and the path after the colon is where it appears inside the container:

```sh
docker compose run --rm -v "$PWD/backup-20261017T223817Z.zip:/restore/backup.zip:ro" app node admin.mjs restore /restore/backup.zip --check
```

Now restore. Without `--yes` it prints the plan and asks `Replace the current data with this backup? [y/N]`;
with `--yes` it goes ahead:

```sh
docker compose run --rm app node admin.mjs restore /data/app/backups/backup-20261017T223817Z.zip --yes
# starts the app again; the first start rebuilds the search index and takes longer than usual
docker compose up -d
```

The report ends with `Docker: docker compose up -d (works whether or not the container exists)`, which is the command
to use.

Verify: open the app, sign in (everyone has to sign in again), open a campaign you know and look at the newest page
and an image. Then delete the safety copy (below). If it is not what you wanted, restore another backup the same
way.

#### Without Docker

You need a build (`pnpm build`) and the **same settings as the server**: the commands read the repository `.env`
and the environment, so run them from the repository folder and with the same `DATA_DIR` (and `BACKUP_DIR`) the
server uses. If you start the server from a service file that sets variables, set the same ones for these commands.

```sh
# stop the server first (however you run it: Ctrl+C, systemctl stop, ...)
node apps/server/dist/admin.mjs restore var/backups/backup-20261017T223817Z.zip --check   # verify only
node apps/server/dist/admin.mjs restore var/backups/backup-20261017T223817Z.zip --yes     # replace the data
# start the server again
```

Run it as the same user as the server. If you run it as root, the restored files are handed to the owner of the
data directory.

#### What restore does

- **Replaces the database and the uploads** with the backup. Everything done after the backup was made is gone from
  the running instance, and the report says when that was.
- **Moves your previous data aside, it does not copy or delete it.** It goes to `pre-restore-<time>/` inside the data
  directory (in Docker `/data/app/pre-restore-<time>/`) and stays until you remove it. It still contains the old
  password hashes and tokens, so **delete it once you have verified the restored instance**. With Docker:
  `docker compose exec app sh -c 'rm -rf /data/app/pre-restore-*'` (this removes every such folder; look at the
  names in the report first). If you restored something by mistake, the files you need are in that folder.
- **Signs everyone out.** All sessions and password-reset links are cleared. Make a new reset link for yourself if
  needed: `node admin.mjs reset-link <username>` (see [Locked out?](#locked-out-recover-an-account)).
- **Revokes API tokens and invite links** (MCP tokens, player invites), because they may have been made or revoked
  after the backup. People make new ones. `--keep-tokens --yes` keeps them as they were in the backup; read its
  warning first, because it brings back tokens that were revoked later, even after a compromise.
- **Carries over restrictions you made after the backup**: users you disabled, and tokens and invites you revoked,
  stay disabled and revoked, so a restore does not undo a lock-out. `--no-carry-restrictions` turns that off. The
  report lists what was carried over. Users created after the backup are *not* in the restored instance (the
  safety copy still holds them) and the report names them.
  **If the report says `Enabled administrators: none`**, a carried-over restriction locked out every admin
  (`reset-link` will say the user is disabled, exit 2). Run the restore again with `--no-carry-restrictions`
  (and `--yes`), then review Admin > Users. Running restore again is allowed after a finished restore: it treats the
  just-restored state as the live data, moves it aside to a new `pre-restore-<time>/` folder (the earlier
  `pre-restore-*` folder stays; the report lists it as an older folder), and installs the backup again. Delete the
  `pre-restore-*` folders once you are done.
- **Prints a report on stdout** (the plan and any prompt go to stderr). Read the line `Enabled administrators:`:
  a name you do not recognise means the backup is compromised. A block starting **`CHECK THESE NOW`** lists
  admins who were demoted, and users who were deleted, in the live data since the backup; they are back as they
  were in the backup. Disable or demote them in Admin > Users, or reset their passwords. Restoring onto an instance
  that had no users (started once and left empty) prints the same block with the backup's admins, and a wiped
  machine prints a note that the live data `could not be compared`: both are harmless.
- **Rebuilds the search index on the next start** (the first start is slower). This needs your 5etools data
  mounted as usual.
- **Migrates an older backup.** A backup from an older version is upgraded to the current database version as part
  of the restore (the report says `Migrated N steps`). A backup made by a **newer** version is refused (exit 66):
  update the app first, then restore. A backup whose migration history does not match (a fork, an edited database)
  is refused (exit 67); restore it with the same checkout or Docker image that made the backup (check your git history
  from around the date in the file name).
- **Does not touch** the 5etools data, `.env`, or the compose file.

Every restore writes a line to `restore-log.jsonl` in the data directory (who, when, which file).

#### Restoring onto a new or wiped machine

1. Get the app ready as in [Running it with Docker](#running-it-with-docker) (or without Docker), but stop before the
   start command: clone the 5etools data, restore your settings (`.env` or the compose file, especially
   `PUBLIC_URL`), and with Docker the image is pulled by `docker compose up` (`docker compose pull` fetches it ahead of time; from a checkout use `-f docker-compose.yml -f docker-compose.build.yml build`).
2. **Do not run `docker compose up` yet** (or start the server). With Docker, `docker compose run` creates the
   volume for you.
3. Get the backup file onto the machine (decrypt it first if you encrypted it) and run the `--check` and the
   `--yes` restore from above. There is no previous data, so the report says nothing was moved aside.
4. Start the app and sign in with your old password. With Docker use `docker compose up -d`. The restore ran in a
   temporary container, so `docker compose start app` finds nothing to start on a machine where the app never ran.

#### Exit codes

The commands use these exit codes (`backup` and `restore` share them; 1 to 3 are also used by `reset-link`):

| Code | Meaning |
|---:|---|
| 0 | Done (for `restore --check`: the backup is complete and would restore) |
| 1 / 2 | `reset-link`: unknown user / disabled user |
| 3 | No database found at `DATA_DIR` (`backup`), or the backup file does not exist or cannot be read (`restore`) |
| 64 | Wrong usage, an unknown option, `--keep-tokens` without `--yes`, or no terminal to ask on and no `--yes` |
| 65 | Not a valid backup (damaged, incomplete, or not one of ours) |
| 66 | Made by a newer version: update first |
| 67 | Different migration history: restore with the same checkout or Docker image that made the backup |
| 69 | The server is running: stop it first |
| 70 | Failed (the message says why; for example a database copy that could not finish in 10 minutes) |
| 71 | The restore was rolled back: your data is exactly as before |
| 72 | You answered no at the prompt: nothing was changed |
| 73 | The backup folder (`BACKUP_DIR`) is not writable by the user running the command: see [When something goes wrong](#when-something-goes-wrong) |
| 74 | Not enough disk space |
| 75 | A restore is running or was interrupted: finish it first |
| 76 | A backup is already running |
| 77 | The rollback itself failed: follow the instructions it printed |
| 78 | `Cannot lock app.sqlite`: see below |

### When something goes wrong

**The restore was interrupted (power cut, killed terminal, `Ctrl+C`).** The data directory holds a marker file
(`.restore-in-progress`) and the app refuses to start until the restore is finished. With Docker and the default
`restart: unless-stopped`, the app container then restarts over and over and prints the same message each time;
this is harmless. Finish it:

```sh
docker compose stop app
docker compose run --rm app node admin.mjs restore /data/app/backups/<the same file> <the same flags>
docker compose up -d
```

Use the same backup file and the same flags (`--yes`, `--keep-tokens`...). If the file was not in the volume and you
gave it with `-v ...:/restore/backup.zip:ro`, use the same `-v` again. The command says
`Continuing the interrupted restore of ...` and carries on, or starts over if the swap had not begun. If a rollback
was under way, running it again finishes the rollback and brings your old data back (exit 71); you can then start
the restore again. Every command except `restore` is refused with exit code 75 until then.

The message printed gives a short version of this ("abort by hand"); this is the complete list: your previous
data is in `pre-restore-<time>/` inside the data directory; move `app.sqlite` (and `app.sqlite-wal` and
`app.sqlite-shm`, if they are there) and `uploads/` back to their old places (remove a newly installed
`app.sqlite` first if one stands there), remove the `.restore-*` folders, then delete the file
`.restore-in-progress`. Do that only if you cannot run the restore again. If a rollback fails (exit 77), the
message lists these steps and running the restore command again retries the rollback.

**`A backup is already running` (exit 76, or "Back up now" is refused).** Only one backup runs at a time. If the
previous one was killed (a reboot, `kill -9`), it looks like it is still running for 2 minutes: wait and try
again. Half-written files left by a killed backup are cleaned up after an hour and are never listed. (A normal stop
removes its own unfinished backup, so this only applies after a forced end such as `kill -9`, a power cut or a second
stop request: a backup started within 2 minutes of that says "already running".)

**The command-line backup takes forever or fails with "did not finish within 10 minutes".** A command-line backup
copies the database in steps and has to start a step again whenever the server writes to it in between. On a
very busy server it can be starved. Run it when nobody is editing, or make the backup from the web page or
schedule it (those run inside the server).

**`Not enough free space` (exit 74, or HTTP 507 "Not enough free disk space for a backup" on the page).** A backup
needs room for about two copies of the database, your uploads, and 64 MiB. Free space, lower `BACKUP_KEEP`, or
point `BACKUP_DIR` at a bigger disk. A restore needs the larger of three times the zip's size and its unpacked
size, plus 64 MiB, in the data directory; the message gives the numbers, and nothing has been changed.

**`Cannot lock app.sqlite (...)` (exit 78).** The restore could not get the exclusive lock it needs on the database
and refuses to go on in case the server is running. It also appears when `app.sqlite` cannot be read by the user
running the command (for example it became owned by root after a command was run as root). Check that the app is
really stopped (`docker compose ps`), and that you run the command as a user that can write the data directory
(inside Docker: use `docker compose run --rm app ...`, not a different image or `--user`). On network drives and
some odd mounts file locking does not work at all; restore on a local disk.

**`The server is running` (exit 69).** Stop the app first. With Docker, `docker compose stop app`.

**The backup is refused.**
- Exit 65, `This is not a complete Critical Notes backup`: the file is damaged, cut short (an interrupted copy),
  or not a backup. Get the copy again and compare its size with the original. The checks apply to the content,
  so a file that unzips fine can still be refused if it was changed.
- Exit 66, `made by a newer Critical Notes`: update the app (`docker compose pull && docker compose up -d`, or `-f docker-compose.yml -f docker-compose.build.yml up -d --build` from a checkout) and run
  the restore again.
- Exit 67, `The migration history of this backup differs`: it was made by another branch, a fork or with an
  edited database. Restore it with the same checkout or Docker image that made the backup (check your git history
  from around the date in the file name).
- Exit 65, `has an extra schema object (...)`: the restore only accepts a database that contains exactly this
  app's own tables. A leftover from `ANALYZE` (`sqlite_stat1`) is tolerated; anything else that was added to the
  database by hand (an index, a view, a trigger) is refused, and the message names it. Remove it from the live
  database, make a new backup, and restore that.
- `The new backup failed its verification pass`: the backup was made, read back and did not pass, so nothing was
  kept (and no older backup was deleted). It happens, rarely, with a database full of repeated blocks that
  compresses more than 50 to 1. Try again; if it keeps happening, report it.

**`Refusing to start: The backup folder ... is not writable by this user` (the command-line `backup` prints the same
sentence and exits 73).** The app user cannot write in `BACKUP_DIR` (or the mount is read-only: remove `:ro`), usually because the host folder did not exist before
`docker compose up` and Docker created it owned by root. The server checks this at start (it creates a missing folder,
mode 700, then writes and removes a small test file), so you see the problem at once instead of at the first backup. The
message gives the Docker and bare-install fixes and shows the path as the app sees it, so with a bind mount
(`/backups` above) fix the **host** folder: `sudo chown 1000:1000 /mnt/backupdisk/critical-notes`, mode 700. A bare install
needs a folder its own user can write. With `restart: unless-stopped` a container that refuses to start restarts over
and over until you fix the folder; run `docker compose stop app` first if you want a quiet log. If a backup fails later
because the folder became unwritable, the Backups page shows `The last backup failed: the server may not write in the
backup folder (BACKUP_DIR). Fix the folder owner (Docker: chown 1000:1000 on the folder); the server log has its path.`

**The server will not start and says `Refusing to start: BACKUP_DIR ...`** The folder is not allowed (see
[BACKUP_DIR](#putting-backups-on-another-disk-backup_dir)) or `BACKUP_EVERY_HOURS` is invalid. The message names the
variable. (A folder the app user cannot write in has its own message, just above.)

**The web download ends with "too many downloads" or the link was refused.** Three downloads run at a time:
wait a few seconds and press Download again. A link works once and for 60 seconds; press Download again for a new one.
The password prompt allows 5 attempts a minute.

**Opening a backup by hand.** A backup is a normal zip. To look inside without restoring (a copy of the file on
another machine is enough):

```sh
unzip -l backup-20261017T223817Z.zip      # lists manifest.json, app.sqlite, uploads/..., checksums.json
unzip -p backup-20261017T223817Z.zip manifest.json     # when it was made, counts, database version
```

This only reads the file; never restore by unpacking it over the data directory. Use `restore`, which checks the
file first and handles the rest. If your copy of the app is gone, a backup is still a plain zip whose `uploads/`
folder holds your images and `app.sqlite` is a SQLite database.

If `unzip` stops with "overlapped components ... zip bomb" on a backup that has a single entry over 4 GiB (a very
big database or image collection), that is a false alarm of the Info-ZIP `unzip` 6.0 checker. The file is valid:
use `7z x`, Python's `zipfile`, or `UNZIP_DISABLE_ZIPBOMB_DETECTION=TRUE unzip ...`.

### If you think you were compromised

Restore from a backup made **before** the incident, not the newest one: a backup of a compromised instance brings
the attacker's admin account back with it. Then: reset every admin password, review **Admin > Users**, leave the
tokens revoked (do not use `--keep-tokens`), restore with `--no-carry-restrictions` if the live data may have been
tampered with (an attacker may have disabled the real admins, and restore keeps that by default), delete the
`pre-restore-*` folder (it holds the old state, including what the attacker left; wipe it securely or keep it on an
encrypted disk), and rotate anything else that was reachable from the server. Scheduled backups help here: they make
sure a pre-incident backup exists.

### Rehearse a restore

An untested backup is a hope, not a backup. Once, and again after you update, restore one into a scratch copy
that cannot hurt your real data, on another port. Use a recent backup and your own copy of it, not the live files.

With Docker, using a throwaway volume (`rehearsal`) and the image your compose file runs (`docker compose images` shows it; below `ghcr.io/merilairon/critical-notes:latest`, or `critical-notes:local` when built from a checkout):

```sh
docker run --rm -v "$PWD/backup-20261017T223817Z.zip:/restore/backup.zip:ro" -v rehearsal:/data/app ghcr.io/merilairon/critical-notes:latest node admin.mjs restore /restore/backup.zip --yes
docker run -d --rm --name rehearsal-app -p 3999:3000 -e PUBLIC_URL=http://localhost:3999 -v rehearsal:/data/app ghcr.io/merilairon/critical-notes:latest
# open http://localhost:3999, sign in with your old password, look at a campaign and an image; then:
docker stop rehearsal-app
docker volume rm rehearsal
```

(The restore report ends with `docker compose up -d`; that line is for compose installs. For the rehearsal you start
the container with `docker run` as shown. `docker stop` ends the container within a second. If `volume rm` says "in use", wait a moment and run it again.)

(Add `-v "$PWD/5etools-data/5etools-src:/data/5etools-src:ro"` to the second command if you want the rules reference
in the rehearsal.) Without Docker, from the repository folder, with a scratch data directory:

```sh
mkdir /tmp/rehearsal
DATA_DIR=/tmp/rehearsal node apps/server/dist/admin.mjs restore backup-20261017T223817Z.zip --yes
DATA_DIR=/tmp/rehearsal PORT=3999 PUBLIC_URL=http://localhost:3999 NODE_ENV=production pnpm --filter @cn/server start:dist
# check it in the browser, stop it with Ctrl+C, then: rm -rf /tmp/rehearsal
```

Environment variables take precedence over `.env`, so the scratch directory does not touch the real one. If you set
`BACKUP_DIR` in your `.env`, set it to something outside the scratch directory as well, or leave it unset.

Developers can run the automated drill, which starts a server on a temporary folder, makes a backup, wipes the
folder, restores, and checks the data over HTTP (about 15 seconds, no 5etools data or network needed):

```sh
pnpm --filter @cn/server build && pnpm --filter @cn/server drill      # or: pnpm drill
```

### File permissions

Backups and the data directory contain secrets, so keep them private. The app creates the `backups/` folder with
mode 0700 and every backup zip with 0600, whatever your umask is, and the restore log is 0600. It does not change
the mode of `DATA_DIR` itself, so on a shared machine run `chmod 700 var` (or your `DATA_DIR`) yourself. In Docker
the app runs as the unprivileged user `node` (uid 1000) and the data lives in a Docker volume; if you put
`BACKUP_DIR` on a host folder, make it `chown 1000:1000` and `chmod 700`. Copies you make (`docker compose cp`,
`rsync`) belong to you: keep them as private as the originals, and encrypted.

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

- **This project's code.** Critical Notes is licensed under the [Apache License 2.0](LICENSE)
  (Copyright (c) 2026 Merilairon). The license covers only this repository's own code and documents. It does
  not cover or grant any right in the game content below. Contributions are accepted under the same license,
  with a DCO sign-off (`git commit -s`) and no CLA; the details come with CONTRIBUTING.md.
- **Game content and art.** The rules text, statblocks and other content in 5etools, and the art in
  5etools-img, belong to Wizards of the Coast, the credited artists or their rights holders. Only the text of
  the System Reference Documents 5.1 and 5.2 is available under
  [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/), and reuse needs the attribution statement from the
  SRD. This repository contains none of the content. The app builds a local index (`DATA_DIR/index.sqlite`, a
  derived copy of the entities in your clone) and shows the content and images to the players you invite, and
  over MCP to the AI service you connect. The host is responsible for that use. Use it for books you own; this
  is advice, not a license from Wizards. Do not publish a server with this content to the public.
- **5etools.** The 5etools code is MIT-licensed (Copyright (c) 2017 TheGiddyLimit and contributors). Parts of
  `packages/fivetools` (the edition table, the `{@tag}` registry, the source-name maps) are adapted from it, and
  the MIT notice is kept in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The
  [5etools-utils](https://www.npmjs.com/package/5etools-utils) package (MIT) supplies the homebrew schemas and
  the edition source lists at run time; its npm package ships no license file.
- **Third-party code** (dependencies, the bundled AI agent definitions, the 5etools license notice) is listed
  in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **Your data** stays in your `DATA_DIR`. Your notes and homebrew are yours. An export that contains 5etools
  text or art stays under the terms of that content.
- **Trademarks.** Critical Notes is an unofficial fan project. It is not affiliated with, endorsed or
  sponsored by Wizards of the Coast. "Dungeons & Dragons" and "D&D" are trademarks of Wizards of the Coast LLC,
  used here only to describe compatibility; the project uses no Wizards logos.
