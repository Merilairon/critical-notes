# Instance backup and restore: design and threat notes

Task M3.1 · Owner: Database Reliability Engineer · QA: Security Architect · Reference: PRD §8 M3 · Date: 2026-10-17

**Status: approved 2026-10-17.** Security Architect: PASS (round 4, after three rounds of fixes). Owner: D1-D10 approved as recommended (D3 no encryption or signing in 1.0; D9 scheduler is built as the stretch task M3.5, off by default). Design only; nothing here is implemented. Rule 4 of `docs/PROJECT.md` (both schemas) does not apply: M3 adds no table and no column. Every other rule of section 4 applies to M3.2 to M3.6.

## 1. What exists today (read from the code)

| Area | Fact (file) | Consequence |
|---|---|---|
| Data layout | `config.ts`: `DATA_DIR` (default `./var`, Docker `/data/app`) holds `app.sqlite`, `index.sqlite`, `uploads/`. `ensureDataDirs` creates only `DATA_DIR` and `uploads/`. Nothing else in `src` reads or writes under `DATA_DIR`: **no secrets file, no key file, no session file**. Cookie and token secrets are not persisted; sessions and tokens live in `app.sqlite`. | A backup of `app.sqlite` + `uploads/` is the complete state. A restore needs nothing else. |
| App DB | `db/index.ts` `openAppDb`: one `better-sqlite3` connection, `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`, then drizzle `migrate()` on every open. | A WAL file and `-shm` exist while the server runs. A plain file copy of `app.sqlite` is not safe. `openAppDb` always migrates, so **restore and backup must not use it on a file they have not yet validated**. |
| Migration level | `drizzle/meta/_journal.json` lists `{idx, tag, when}` (today idx 0 to 6, last tag `0006_accounts`). drizzle's migrator creates `__drizzle_migrations (id, hash, created_at)`; one row per applied migration, `hash` = sha256 of the `.sql` file text, `created_at` = the journal `when`. The migrator applies a migration only if `max(created_at) < migration.when`. | The level is the set of rows in `__drizzle_migrations`. It is read from the snapshot, never from the running build. |
| Uploads | `services/uploads.ts`: file id = `newId()` (UUIDv7-style, 36 chars). Main file `uploads/<id>`, thumbnail `uploads/<id>.thumb` (a stored WebP, 400 px, **not derived at read time**; older uploads may lack it, `readThumb` returns null). Written with `flag: 'wx'` (never overwritten), **file first, then the `uploads` row**. Max 15 MiB per file (`MAX_UPLOAD_BYTES`). `uploads.sha256` holds the digest of the main file. **No code deletes upload files today** (`grep unlink/rm` finds none); deleting a campaign leaves orphan files. | Upload files are write-once and immutable, and a row never exists without its file. This is what makes a lock-free snapshot correct (section 4). Thumbnails must be in the backup. |
| Startup | `main.ts`: `ensureDataDirs` → `openIndexDb` → `openAppDb` (migrates) → purge expired sessions and resets → reference indexer → `homebrew.syncIndex()` → built-in templates → **`if pageSearch.count() === 0` then `pages.reindexAll()`**. | `index.sqlite` holds the page search index (`page_search`, `page_fts`) as well as the 5etools reference index. Restore must delete `index.sqlite*`, otherwise a stale non-empty page index is never rebuilt (section 8.6). |
| CLI | `cli/admin.ts` checks `existsSync(appDbPath)` and then calls `openAppDb` (which migrates) **before** dispatching to `SUBCOMMANDS`; `Subcommand.run` is synchronous and returns a string; exit codes in `EXIT`. | M3.3 needs two changes (section 18): an entry that skips the generic open and allows an absent database (`restore` onto a wiped instance), and async support. |
| Docker | `Dockerfile`: runtime stage `USER node` (uid 1000), `DATA_DIR=/data/app` owned by `node`, `VOLUME /data/app`; `docker-compose.yml` mounts named volume `app-data:/data/app`, `restart: unless-stopped`. `dist/admin.mjs` ships in the image next to `main.mjs`. | Restore runs as `node` inside a container that shares the volume. A running `app` container and a `run --rm` container see the same files and the same SQLite locks. |
| App version | Root `package.json` has **no `version`** field; `apps/server/package.json` says `0.0.0`. M5.4 adds the single source. | Section 16. |
| Admin routes | `app.ts`: `app.use('/api/admin/*', requireAdmin)`; `requireAdmin` rejects any request authenticated by an API token. MCP `isAllowed` is a closed allowlist that matches no `/api/admin` path. `lib/audit.ts`: one JSON log line per event. `lib/rate-limit.ts`: in-memory `RateLimiter`. `compress()` is applied to all `/api/*` except event streams. | Backup routes inherit admin-only and MCP-unreachable by being mounted under `/api/admin/backups`. The compress middleware must skip them. |
| Libraries | `fflate` 0.8.3 and `better-sqlite3` 13.0.3 are already dependencies of `@cn/server`. | No new dependency. |

## 2. Goals and non-goals

Goal (PRD M3): one documented way to back up everything that matters, safe while the server runs, restorable on a fresh or wiped instance, with a restore that is tested in CI. **Done when** a backup taken while users edit restores to a working instance with the same users, campaigns, homebrew, templates and images.

Targets (a self-hosted instance, so modest): **RPO** = time since the last backup (manual, or `BACKUP_EVERY_HOURS`; recommended daily). **RTO** for a typical instance (database up to 200 MB, uploads up to 5 GB) = under 15 minutes including the index rebuild. Both numbers are estimates until M3.2 benchmarks them (section 14).

Out of scope for 1.0 (explicit): point-in-time recovery (SQLite WAL archiving), incremental backups, encryption inside the app, cloud upload, deleting backups from the UI, restore from the UI or API, backups of Postgres (section 15), backing up `index.sqlite`, the 5etools data, or the `backups/` directory itself.

## 3. What is in the zip, and why

`backup-YYYYMMDDTHHMMSSZ.zip` (UTC) has exactly these entries, in this order, and nothing else:

| Entry | Content | Why |
|---|---|---|
| `manifest.json` | Format facts, versions, migration level, counts (section 6). Written **first**, small (under 1 MiB). | Restore can refuse (wrong format, newer level, wrong engine) after reading a few KB, before extracting or hashing anything. |
| `app.sqlite` | A consistent copy made with the SQLite online backup API, converted to `journal_mode = DELETE` so it is one self-contained file. | All users, campaigns, pages, homebrew, templates, tokens, invites, sessions. |
| `uploads/<id>` and `uploads/<id>.thumb` | Every regular file in `uploads/` whose name matches `^[0-9a-f-]{36}(\.thumb)?$`. | Images. Thumbnails are stored files, so they are state. |
| `checksums.json` | `{ entries: [{ path, size, sha256 }] }` for every entry above except itself and `manifest.json`. Written **last**. | Integrity of every byte after a copy or download (section 6.2). |

Deliberately excluded: `index.sqlite*` (derived, rebuilt on start), `backups/`, `pre-restore-*`, `.restore-*`, `.tmp-*`, any `-wal`/`-shm`, anything that does not match the upload name pattern, the 5etools clones (never ours to redistribute), `.env`, `PUBLIC_URL`, host name, user names in the manifest (the manifest carries counts only, so listing a backup leaks nothing).

**Deviation from the task text (log in `docs/PLAN.md` if accepted):** the task names three entries; this design adds `checksums.json` as a fourth. Reason: the hash of every file is only known after it has been streamed, but restore wants the version facts before it extracts anything. Two small JSON files avoid reading the archive twice.

## 4. Consistency while the server writes

**Database.** `better-sqlite3`'s `db.backup(destination, { progress })` wraps `sqlite3_backup_*`. Read from `lib/methods/backup.js` and the SQLite documentation, not assumed:

- It copies page ranges in steps (first call transfers nothing to set up, then 100 pages per step unless `progress` returns a number), yielding to the event loop between steps through `setImmediate`. The server stays responsive.
- The result is a consistent snapshot as of the last step. Writes made through **the same connection** between steps are mirrored into the destination by SQLite itself. The server has exactly one app-db connection (`db.$client`), so in-process writes never restart a backup.
- A write from **another process or connection** (the CLI running `backup` or `reset-link` while the server runs) restarts the copy from page 1. Under constant foreign writes it can starve. Rules: `BackupService` takes the connection as a parameter; the CLI uses a larger step (`progress` returns 2000 pages) and the service enforces a wall-clock limit of 10 minutes for the database phase, failing with a clear message. **Never return `0` from `progress`**: the wrapper then transfers 0 pages per tick and never ends.
- The destination must be a fresh path (it overwrites an existing file).

Steps of the database phase: back up into `backups/.tmp-<id>/app.sqlite` (dir mode 0700) → open the copy → `PRAGMA journal_mode = DELETE` → `PRAGMA integrity_check` must return `ok` → read `__drizzle_migrations` and counts → close. Rejected alternative: `VACUUM INTO`. It is a single synchronous statement that blocks the event loop for the whole copy, which for a large database freezes every request.

**Uploads versus database: order.** Because upload files are write-once and written before their row, the rule is:

1. Take the database snapshot **first** (time T0).
2. Enumerate `uploads/` **afterwards** (time T1 > T0).

Every row in the snapshot was committed before T0, so its file was complete before T0 and is in the listing. Files that appeared between T0 and T1 are **orphans** in the backup (a file without a row): harmless, never served (`/api/uploads/:id` looks up the row first), and tolerated on restore. The reverse order could produce a row without a file, which is the one inconsistent outcome, so it is forbidden.

Enumeration rules: `readdir` once, filter by the name regex, `lstat` each (regular file only, symlinks skipped and logged), a file that vanishes between listing and open (ENOENT) is skipped with a warning.

**Rule handed to M4 (trash and purge):** if a later task starts physically deleting upload files, it must not unlink a file while `BackupService` is running (`backups.isRunning()`), or it breaks the T0 < T1 guarantee (a row in the snapshot whose file was deleted before it was archived). Defer the unlink to a sweep that skips while a backup runs.

**Post-check.** After the zip is written, the service compares the snapshot's `uploads.id` values with the archived names. Rows without a main file are recorded in `manifest.uploads.missing` (count only) and in the audit line. A missing file is a warning, not a failure: a backup of a damaged instance is still worth having, and the admin must see the warning (the list response carries it).

## 5. Streaming and memory bounds

Measured with fflate 0.8.3 in this repository's `node_modules` (scratch experiment, to be repeated as automated tests in M3.2):

- The streaming writer is `Zip` plus one `ZipDeflate` per entry; `Zip.ondata` is synchronous and has **no back-pressure**, so the writer must push one chunk, then `await` the output stream's write/drain before pushing the next.
- 70,000 entries produced a valid archive that `unzip` and Python's `zipfile` read, so the 16-bit entry-count limit is not a problem. A single entry larger than 4 GiB is untested; M3.2 refuses to archive an entry of 4 GiB or more with a clear error (the database is the only candidate), and restore caps `app.sqlite` at 4 GiB to match.
- **Never use `ZipPassThrough` (stored) and never `{ level: 0 }`.** In streaming mode an entry has a data descriptor (sizes after the data). For a stored entry, fflate's streaming `Unzip` finds the end by scanning for the descriptor signature `PK\x07\x08`; data that contains that byte pattern was extracted **wrongly** (`stored adv` false in the experiment). `{ level: 0 }` produced `unexpected EOF` on the same data. `level: 1` and `level: 6` round-tripped the adversarial data correctly. Images are already compressed, so level 1 costs almost no size and little CPU. **Rule: every entry uses `ZipDeflate` with `level: 1`, except `app.sqlite` which uses level 6** (SQLite files compress 2x to 4x). M3.2 includes an upload whose bytes contain `PK\x07\x08` repeatedly (a test with random bytes alone would pass and prove nothing).
- Restore reads the archive with a small central-directory reader (`services/backup-zip.ts`: positional reads, `node:zlib` raw inflate), not with fflate's streaming `Unzip`. Measured with fflate 0.8.3: `Unzip` finds the end of a deflate entry that has a data descriptor by scanning for `PK\x07\x08` or `PK\x01\x02`, and deflate stores incompressible data (JPEG, PNG, WebP) as raw blocks, so such uploads fail with `unexpected EOF` at levels 1 and 6; this was the design's plan B. The writer still uses fflate `ZipDeflate` (level 1; level 6 for the database) for every entry, but writes the central directory and the zip64 end records itself, because `Zip.end()` wraps 32-bit offsets and the 16-bit entry count. The format is unchanged. Known interop note: Info-ZIP `unzip` 6.0 reports its zip-bomb heuristic on archives with entries beyond 4 GiB; use `UNZIP_DISABLE_ZIPBOMB_DETECTION=TRUE`, 7-Zip or Python for manual extraction.
- `unzipSync`/`unzip` (whole-archive-in-memory) are **forbidden** for restore: the buffer is the size of the archive.

Memory model: files are read with `fs.createReadStream(..., { highWaterMark: 64 KiB })`, each chunk hashed (`crypto.createHash('sha256')`) and pushed, then the loop awaits the write. At most a few 64 KiB chunks are in flight. The only O(n) state is the checksum list, about 200 bytes per entry (200,000 upload files = about 40 MB; restore holds `checksums.json` in memory, section 9.2). **Hard limit, identical for writer and reader: at most 200,000 files under `uploads/` plus the 3 fixed entries (`app.sqlite`, `manifest.json`, `checksums.json`), 200,003 entries in all** (a main file and its thumbnail each count as one upload file, so about 100,000 uploads); beyond it the backup fails with a message (and N14/object storage becomes the real answer). Acceptance (M3.2): peak RSS growth under 64 MiB while archiving over 500 MB of uploads.

CPU: `ZipDeflate` is synchronous per chunk (64 KiB at level 1 is well under a millisecond), and the `await` per chunk yields to the event loop, so request latency stays flat. No worker threads (`AsyncZipDeflate`) are needed, which also avoids workers in the esbuild bundle.

## 6. Manifest, checksums and what restore verifies

### 6.1 `manifest.json`

```json
{
  "kind": "critical-notes-backup",
  "format": 1,
  "createdAt": "2026-10-17T09:30:00.000Z",
  "trigger": "api",
  "app": { "version": "1.0.0" },
  "database": {
    "engine": "sqlite",
    "sqliteVersion": "3.50.1",
    "bytes": 52428800,
    "migrations": [
      { "tag": "0000_init", "hash": "<sha256 of the .sql>", "when": 1791000000000 }
    ],
    "latestTag": "0006_accounts",
    "latestWhen": 1792175408862
  },
  "counts": { "users": 3, "campaigns": 2, "uploads": 41 },
  "uploads": { "files": 82, "bytes": 123456789, "missing": 0 }
}
```

- `format` is the zip layout version. Restore refuses `format` greater than it knows ("made by a newer Critical Notes") and refuses unknown `kind`. Increase only for layout changes, never for schema changes.
- `database.migrations` is built from the **snapshot's** `__drizzle_migrations` rows (`hash`, `created_at` → `when`), with `tag` filled in by matching `hash` against the running build's journal (null when unknown, e.g. a database ahead of the build). `latestTag`/`latestWhen` are the last element.
- `trigger` is `api`, `cli` or `scheduler` (who started this backup). Prune reads it (section 11); an unreadable manifest is treated as `api`.
- `app.version` is **informational only**. No compatibility decision uses it; the migration chain decides. It is used in the refusal message ("this backup was made by 1.2.0").
- `database.bytes` is the size of the snapshot file that becomes `app.sqlite`; restore uses it only to **lower** the cap for that entry (9.2).
- `counts` are the numbers restore echoes so the admin can eyeball "same users, campaigns, uploads".
- No host name, URL, user name or path appears anywhere in the manifest.

### 6.2 `checksums.json` and the restore verification order

`{ "entries": [ { "path": "app.sqlite", "size": 1234, "sha256": "..." }, ... ] }`, one object per file entry. **The manifest and checksums are attacker-controlled in a hostile file.** They are used only to compare against what was actually read, never to build a path, a limit that raises a cap, or a compatibility decision. Every `path` in `checksums.json` must itself pass the section 9.1 regex (else refusal) and is only compared with the names seen. Restore proves, in order, and stops at the first failure with nothing outside the staging directory touched:

1. First zip entry is `manifest.json`, size at most 1 MiB, valid against a zod schema; `kind`, `format`, `engine` accepted.
2. Early, advisory migration check from the manifest (section 7.2). The **binding** check is re-derived from the staged database itself (section 8, step 3).
3. Each entry passes the gate of section 9.1 (name allowlist, `compression === 8`, no duplicate, count limit).
4. While streaming each entry to staging: byte count never exceeds the cap for its kind (section 9.2); sha256 computed on the decompressed bytes.
5. The last entry is `checksums.json`; **nothing follows it** and the end of the archive was seen (section 9.1); the set of extracted names equals the set listed, and every size and sha256 matches. A missing, extra or mismatching entry fails (this catches truncated and corrupted archives; a truncated zip has no `checksums.json` at all).
6. Database checks on the staged copy (section 8, step 3).

**Checksums are not authenticity.** Anyone who can alter the zip can recompute `checksums.json`. They detect corruption and truncation, nothing else (section 14, B5).

## 7. Restore rules

### 7.1 Only into a stopped instance

Options evaluated:

| Option | Verdict |
|---|---|
| PID file written by `main.ts` | Rejected. Goes stale after `kill -9`/OOM/power loss and then blocks restore forever; PIDs mean nothing across containers (`docker compose run` has its own PID namespace); needs a server change in the hot path. |
| TCP probe of `PORT` | Rejected. The CLI cannot know the right port or host from inside another container; a server on another port or bound elsewhere passes the probe. |
| Advisory lock file (`flock`) | Rejected. Node has no `flock`; emulations with `O_EXCL` are pid files again. |
| **SQLite lock probe on `app.sqlite`, combined with a restore marker** | **Chosen.** The probe tests the actual resource, and the kernel releases it when the server dies, however it dies. The marker closes the gaps a lock cannot (below). |

The probe (verified by experiment on better-sqlite3 13.0.3: a holder process writing in WAL mode makes it fail with `SQLITE_BUSY`; after `kill -9` of the holder it succeeds and recovers the WAL):

```
db = new Database(app.sqlite, { fileMustExist: true, timeout: 500 }); db.pragma('locking_mode=EXCLUSIVE');
db.prepare('select count(*) from sqlite_master').get(); db.exec('begin exclusive');
```

`SQLITE_BUSY` means another connection is open: **refuse** ("the server is running; stop it first", plus the Docker line). The probe connection **stays open and exclusive until the restore finishes** and doubles as the read-only window onto the live data used for the carry-over diff (8.1). Limits, stated honestly: it relies on POSIX file locks, which are unreliable on network file systems and some virtualised bind mounts; SQLite itself is unsafe there too. If the database file does not exist (wiped instance) there is nothing to probe; the marker alone protects.

**Marker.** `DATA_DIR/.restore-in-progress`, created with `O_EXCL` (`wx`) **before the probe**, written atomically (temp file, `fsync`, `rename`, `fsync` of the directory). Content (JSON): format version, restore start time, OS user, **sha256 and name of the zip**, staging and pre-restore paths, flags, phase and `next` step; at phase `staged` also the **sha256 and size of the staged `app.sqlite`**; and `liveMoved`, the list of live files moved into the pre-restore directory (with sizes), so "already done" can be checked against the file system. A restore that fails before the swap removes the marker only if it created it.

**Decision on the swap race (R2): the database file is still swapped by rename, hardened; option (a) "copy into the live file under the lock" is rejected.** Reasons for rejecting (a): `better-sqlite3`'s `backup()` writes only *from* an open connection *to a file path* (it opens its own destination connection, which would collide with the held exclusive lock) and there is no API to restore *into* an open connection; the alternative is a table-by-table copy inside one transaction, which couples restore to the schema, breaks on triggers and `sqlite_sequence`, and inflates the WAL by the whole database. Option (b), made tight:

1. `main.ts` checks the marker **at the very top**, before `ensureDataDirs`, `openIndexDb` and `openAppDb`, and **again right after `openAppDb`** (closing the database and exiting 1 if it appeared). The message says: "a restore is running or was interrupted".
2. Restore creates the marker (`wx`) **before** the probe. A server that passed the first check before the marker existed must already hold, or be about to open, the database: if it holds it, the probe returns `SQLITE_BUSY` and restore refuses; if it opens later, it either waits on the exclusive lock or sees the marker in its second check and exits.
3. **Pre-swap check (what is actually verified).** A second connection can never re-probe: the held probe connection is exclusive, so any other connection gets `SQLITE_BUSY`. The check is therefore: the probe connection is still open (`db.open`, and a trivial `select 1` succeeds) **and** `stat(DATA_DIR/app.sqlite)` returns the same `dev` and `ino` that were recorded by a `stat` of the path taken right after the lock was acquired (better-sqlite3 exposes no file descriptor, so this is the equivalent of comparing the path with the held fd). Equal means the path still names the locked inode. (On a wiped instance there is no live database, so there is no lock, no stat comparison and no `liveMoved`; the marker and the no-clobber `link()` are then the only protection from the start.) **The probe is released before the first rename, not held to the end.** After the confirmation and the dev/ino check, restore closes the probe connection and writes `phase: "swapping"`. Holding an exclusive WAL connection across the moves makes SQLite checkpoint and delete `-wal` and `-shm` by name on files that were moved or moved back, so a rolled-back restore would not be byte-identical. From the release on, protection is the marker (checked by every starting server at the top of `main.ts` and again after `openAppDb`), the `.restore.lock` that keeps a second restore out, and the no-clobber `link()` install with the racer sweep. Windows, stated: (a) a server that passed its first check before the marker existed and is still opening the database obtains it after the release, hits the second check and exits, having at worst run a pending migration on the old database; (b) a process outside `main.ts` that ignores the marker can write to the old file before the move (its changes then sit in the pre-restore copy and were not seen by the carry-over diff) or create a `-wal` after the list is built (moved aside by the racer sweep or caught by the post-link `-wal` check); (c) a server holding an old inode that closes later may unlink `app.sqlite-wal` by name, so a server must not be started until the restore reports completion. A server that already holds the database cannot be present, because the probe returned `SQLITE_BUSY` for it. *Later improvement (not 1.0):* a stable lock target, a small `DATA_DIR/.lock.sqlite` that the server also opens and restore never swaps (or an `fcntl` lock on it), so the lock survives the swap.
4. **Residual window, admitted:** a process that opens the database *without* going through `main.ts` and without the marker (a hand-run script) can still interleave. That is host-level tampering, outside the threat model; the pre-restore copy still holds the real old state.

`restart: unless-stopped` plus the marker means a server that is *not* stopped will **crash-loop** (exit 1 each time) while the marker exists; this is intended and harmless. The guide (M3.6) must say: **stop the container before restoring and before wiping the volume** (`docker compose stop app`), and start it only after the restore reports success.

While the marker exists, `backup`, `reset-link` and every other CLI subcommand that opens the database **refuse** (exit "restore in progress"), and the server's scheduler and `BackupService.create` refuse.

### 7.2 Migration level

Comparison of the manifest's `database.migrations` with the running build's journal, element by element from index 0, is an **early, advisory** check (a clean message before extracting gigabytes). The binding decision is re-derived from the **staged database's own `__drizzle_migrations` rows** (section 8, step 3), because the manifest is attacker-controlled and drizzle's `migrate()` only compares `max(created_at)` with each journal `when`: a forged huge `created_at` would make the migrator skip every migration silently. Rules (applied to the staged rows, `hash` and `created_at` pairs in order):

| Case | Decision |
|---|---|
| Same pairs as the build journal, same length | Accept. |
| Rows are a **strict prefix** of the build journal (backup is older) | **Accept.** The common case is restoring an old backup onto an upgraded install. The staged copy is migrated before the swap, so a migration failure aborts with live data untouched. The report says "migrated N steps". |
| More rows than the build, a row not in the journal, a different `hash` or `created_at` at the same index, rows out of order, or a gap | **Refuse** (exit code "newer" when it has extra rows, "different history" otherwise). No override flag. |
| `engine` is not `sqlite` | Refuse. |

The database engine can only move forward; this is also why there is no override.

## 8. Restore procedure

Runs from the CLI only (section 10): `node dist/admin.mjs restore <file> [--check] [--yes] [--keep-tokens] [--no-carry-restrictions]`.

1. **Preflight.** `<file>` is a readable regular file (not a directory or device; resolved once with `realpath`). Compute its sha256 (streamed). `DATA_DIR` exists (created 0700 if new). `uploads/` and `DATA_DIR` itself must not be symlinks, and `uploads/` must not be a mount point (compare `st_dev` with `DATA_DIR`): refuse otherwise with a clear message. Free space on the `DATA_DIR` file system must be at least `max(3 x zip size, sum of the declared uncompressed sizes capped by 9.2) + 64 MiB`; actual writes are still bounded by the caps and an `ENOSPC` aborts cleanly. Without `--check`, create the marker (7.1), then run the probe and keep it, recording `dev` and `ino` of `app.sqlite` right after the lock is acquired (7.1, point 3; skipped when no database exists). With `--check` neither marker nor probe is used and the live data is never touched (staging only; the carry-over diff is skipped).
2. **Stage.** Create `DATA_DIR/.restore-<timestamp>/` (mode 0700, same file system as the target so renames are atomic). Stream-extract per sections 6.2 and 9 into `staging/app.sqlite` and `staging/uploads/...`. Any failure deletes staging and the marker (if this run created it); nothing else has changed.
3. **Verify and prepare the staged database.** In this order, so that hostile schema objects never execute:
   1. Open the staged file **read-only** (`readonly: true`) with `PRAGMA trusted_schema = OFF`, `PRAGMA cell_size_check = ON`, `PRAGMA query_only = ON`.
   2. Read its `__drizzle_migrations` rows and apply the section 7.2 rules against the build journal (`readMigrationFiles` output). Refuse on any mismatch.
   3. **Mandatory schema allowlist, run before `PRAGMA integrity_check`:** the sorted `(type, name, tbl_name, sql)` rows of its `sqlite_master` must equal those of a `:memory:` database migrated to **the same journal prefix** (the first N journal entries, N = the staged row count). This rejects planted triggers, views, virtual tables, altered columns and extra indexes. It runs *before* any migration or write, so a hostile trigger or view cannot fire during migration or the purges. There is no weaker fallback; if the comparison is unstable for real upgrade histories it is a **blocker test for M3.3** (section 19) and the answer is a design change, not a silent downgrade of the check.
   4. Then run `PRAGMA integrity_check` (must be `ok`) and `PRAGMA foreign_key_check` (empty).
   5. Close the read-only handle. Reopen read-write through a restore-specific variant of `openAppDb` that sets `trusted_schema = OFF` and `cell_size_check = ON` *before* migrating (today's `openAppDb` cannot; M3.2 adds the variant, which calls drizzle's `readMigrationFiles` and `db.dialect.migrate` on the already-configured connection). Migrate to the build level; then re-compare `sqlite_master` with a `:memory:` database migrated to the full journal (must be equal).
   6. In **one transaction**: `DELETE FROM sessions`, `DELETE FROM password_resets`; unless `--keep-tokens`, `UPDATE api_tokens SET revoked_at = :now WHERE revoked_at IS NULL` and the same for `campaign_invites`; then the carry-over of live restrictions (8.1) unless `--no-carry-restrictions`.
   7. Set `PRAGMA journal_mode = DELETE` explicitly (or `wal_checkpoint(TRUNCATE)`, then close) so that **no `-wal`/`-shm` can remain**; close; assert neither file exists beside the staged `app.sqlite`.
   8. Count `uploads` rows without a main file in `staging/uploads` (warning, not fatal) and list enabled admins for the report.
   9. **Make it durable:** `fsync` every staged file and every staged directory, compute the sha256 and size of the final staged `app.sqlite`, then record `phase: "staged"` with them in the marker (atomic write).
4. **Confirmation.** Print the plan: backup date, app version, counts, what will be purged and carried, where the old state will be kept. `--check` stops here with exit 0 (verify-only; also usable on a schedule to prove backups restore). Without `--yes`, ask on a TTY; with no TTY and no `--yes`, exit 64. `--keep-tokens` prints a warning ("revoked tokens and invites in this backup become active again, including any that were revoked because of a compromise") and **always requires `--yes`** (or an interactive typed confirmation).
5. **Swap.** Every step is written to the marker as `next: <step>` **before** it runs (atomic marker write), is **idempotent by inspecting the file system** (see recovery below), and is followed by an `fsync` of the affected directories. Steps:
   1. Create `DATA_DIR/pre-restore-<timestamp>/` (0700), name recorded in the marker.
   2. **Write the intended move list first:** before any move, the marker gets `liveMoved` = the list of live files that exist (`app.sqlite`, `-wal`, `-shm`, with sizes; an empty list if there is no live database); until this write `liveMoved` is `null`, meaning step 2 has not started. Then move those files **together** into the pre-restore directory. A crash after moving `app.sqlite` but before `-wal`/`-shm` is finished by the resume, which completes every listed move not yet done (all three move or none, never a subset left behind). A stale `-wal` or `-shm` beside the new file would replay old frames over the restored database and silently corrupt it, so all three move or none.
   3. Move live `uploads/` into it; move `staging/uploads` to `uploads/` (an empty directory when the backup has none).
   4. **Racer sweep, then install.** If anything stands at `app.sqlite`, `-wal` or `-shm` (for example an empty database created by a server that passed its first marker check before the marker existed), it is **racer debris**: move it into the pre-restore directory as `racer-<n>-app.sqlite` (and `-wal`/`-shm`), with `<n>` chosen so that no existing file is ever overwritten and never touching the files recorded in `liveMoved`. Then install `staging/app.sqlite` with the no-clobber `link()` of 7.1, unlink the staging name, assert no `-wal`/`-shm` at the target. If `link()` still fails with `EEXIST` (a racer is still active) or a `-wal`/`-shm` appears after the link, run the **rollback** below.
   5. Delete `index.sqlite`, `index.sqlite-wal`, `index.sqlite-shm` (8.6).
   6. Remove the empty staging directory, `fsync` `DATA_DIR`, write one final `restore.completed` record, remove the marker, release the probe.
6. **Report** (stdout, no secrets) and exit 0: see 8.1 and the list in 8.2.

**Crash and power-loss recovery (defined).** The precondition is: *no marker, or a marker whose recorded zip sha256 equals the sha256 of the file being restored now* (a **resume**). A marker for a different zip refuses with the marker's contents printed; a human then either finishes with the original file or follows the manual rollback in the guide. Resume rules:

- **Before `phase: "staged"`:** delete the staging directory and start again at step 2 (re-extract; cheap and simplest). No pre-restore directory exists yet.
- **From `phase: "staged"` onward:** staging is **not** re-extracted. Each swap step first inspects the file system and skips what is already done: if `liveMoved` is `null` step 2 has not started and starts normally; otherwise it is done when every file listed in `liveMoved` exists in the pre-restore directory, and any listed file still at the live path is moved now (**extra, unlisted files at the live path are tolerated**; they are racer debris, swept in step 4); step 3 is done when `pre-restore/uploads` exists and `uploads/` is the staged tree (the staging directory no longer holds `uploads/`); **step 4 is done when the target `app.sqlite` has the sha256 recorded in the marker at phase `staged` (or is the same inode as the staging file), in which case only the leftover staging name is unlinked** (this covers a crash between `link()` and the unlink). If the staged file needed by a step is neither in staging nor at its target, restore aborts, leaves the marker, and prints the manual instructions (everything old is in `pre-restore-<ts>/`).
- The pre-restore directory recorded in the marker is reused, never duplicated.
- **A marker with `rollingBack` is always continued as a ROLLBACK, never rolled forward**, whatever the zip or flags of the new run (otherwise a crash during rollback could end with the new database installed and the old uploads moved back). Only after the rollback completes (marker removed) may a fresh restore start.
- An **aborted resume** (state that can neither be completed nor rolled back automatically) leaves the marker and the staging and pre-restore directories untouched; the server stays refused, which is the safe state.

**Rollback (defined).** Used only when step 4 fails as above, and recorded step by step in the marker (`rollingBack`), each move idempotent: (1) remove the installed `app.sqlite` only if it is the staged inode, and **move any other file standing at the live names `app.sqlite`, `-wal`, `-shm` aside under a `racer-<n>-` name in the pre-restore directory** (step (3) uses `rename`, which would otherwise overwrite a racer's file); (2) move the **new** `uploads/` back to `staging/uploads` and move `pre-restore/uploads` back to `uploads/` (the uploads swap at step 3 precedes the database install, so rollback must undo it); (3) move the files listed in `liveMoved` from the pre-restore directory back to their live names; (4) delete the staging directory; (5) append `restore.aborted` with the phase, `fsync`, and **remove the marker**, because the live path is again exactly the pre-restore state and the server may start. It differs from an aborted resume in the end state: after a completed rollback the marker is removed and nothing is left to finish; if the rollback itself fails the marker stays with `rollback-failed` and the manual instructions are printed.

**Pre-restore safety copy.** The pre-restore directory contains the old database as one self-contained, checkpointed `app.sqlite`: restore closes the probe before the first move, which merges a hot WAL left by a crashed server into the file (committed data is kept; only uncommitted frames are dropped). A `-wal` or `-shm` appears in it only if another process created one before the move list was written. It is the previous state moved aside, not copied: no time or space cost at restore. **It keeps the old live tokens, password hashes and, after a compromise, any attacker persistence, on disk.** Therefore: the report prints its path and size with "delete it after you have verified the restored instance"; the guide says the same; for a compromise the guide says to delete it with a secure-delete tool or to put the volume through the host's secure-erase practice (journaling and copy-on-write file systems make plain deletion non-erasing, and encrypting the volume is the real control). It is never deleted automatically (it may be the only copy of the newest work). Each restore also lists existing `pre-restore-*` sizes.

**8.1 Post-restore security rules (handed over from `accounts.md` T23).**

| State in the restored file | Rule | Reason |
|---|---|---|
| `sessions` | **Deleted.** Everyone signs in again. | Sessions older than the restore may belong to someone logged out since, or to a thief. |
| `password_resets` | **Deleted.** | Expired, used or superseded links must not return. Issue new links with `admin reset-link`. |
| `api_tokens` | **All revoked** (`revoked_at = now`), unless `--keep-tokens`. | A restored token may have been revoked later because of a compromise. Cost: users recreate AI-assistant tokens, about a minute each. |
| `campaign_invites` | **All revoked**, unless `--keep-tokens`. | Bearer links; a revoked or used-up link must not revive. |
| `users.disabled_at` | Staged value, **plus the live value carried over** (below). | |
| Password hashes, `is_admin`, deleted users | As in the backup, with differences against the live data **reported** (below). | A user who changed their password after the backup gets the old one back. |

**Carry-over of live restrictions (replaces "cannot be reconstructed").** The probe holds the live database exclusively and read-only-usable, so before the swap restore **diffs the live database against the staged copy**, matching by id:

- applied to the staged copy by default (opt-out `--no-carry-restrictions`): `users.disabled_at` where it is set live and not in the backup; `api_tokens.revoked_at` and `campaign_invites.revoked_at` where set live and null in the backup (this matters with `--keep-tokens`; without it everything is revoked anyway);
- **reported only**, never applied: users disabled live but enabled in the backup (so the admin knows what was carried), admins demoted or deleted live and present as admins in the backup, users that exist in the backup but not live (deleted live), users that exist live but not in the backup (their accounts and content are lost; they are listed by username in the report, and the pre-restore copy still holds them), tokens and invites created live (lost).
- **If the live database is unreadable** (corrupt, absent, or **lacking the `users.disabled_at`, `api_tokens.revoked_at` or `campaign_invites.revoked_at` columns**, which an old live database may; the diff is then skipped entirely and treated the same way), including the typical disaster restore onto a fresh disk: the report says so plainly, "live restrictions could not be compared; check Admin > Users and re-disable or demote anyone you had already acted on", and the audit record notes `liveCompared: false`. A wiped instance always lands here.

This reduces, but does not remove, resurrected state: nothing can change live after the diff (the server is stopped), but restrictions held only in a destroyed or unreadable live database cannot be carried and are reported as such.

**What the admin is told** (printed at the end of every successful restore, repeated in M3.6): the restore date and backup date; "everything done after the backup moment is gone"; the carried and reported lists above; that sessions and reset links were cleared and tokens and invites revoked (or the `--keep-tokens` warning); the enabled administrators in the database ("an unknown name here: reset every admin password and treat the backup as compromised"); the pre-restore path and size; and that the first start rebuilds the index.

**8.2 Durable log of operations, and where audit lines go.** `lib/audit.ts` writes to stdout; the CLI contract is "stdout carries only the result". Therefore the CLI uses an audit variant that writes to **stderr**. A `docker compose run` container's logs are not in `docker compose logs app`, so nothing there is durable. M3.2 adds an append-only log `DATA_DIR/restore-log.jsonl` (mode 0600, opened with `O_APPEND`, one JSON object per line, `fsync`ed per record). It lives outside every swapped path and survives restores. Records: `backup.created` (name, size, sha256 of the zip, trigger, actor), `restore.started`, `restore.completed`, `restore.aborted` (each with backup name, zip sha256, flags including `keepTokens` and `carryRestrictions`, `liveCompared`, OS user (uid and `os.userInfo().username`), phase). No secrets, no usernames of users except in the admin list printed to the terminal. The server additionally emits stdout audit lines for `backup.created`, `backup.failed`, `backup.pruned`, `backup.downloaded`, `backup.ticket_issued`, `backup.ticket_denied` (wrong password, expired, reused, wrong binding). Entry names and other untrusted text echoed by the CLI have control characters (including escape sequences) replaced with `?` and are truncated to 120 characters.

**8.6 Interaction with `index.sqlite`.** The page search index (`page_search`, `page_fts`) lives in `index.sqlite`, and `main.ts` rebuilds it only when `pageSearch.count() === 0`. Keeping a stale `index.sqlite` would show search hits for pages that no longer exist (including pages players must not know of) and miss restored ones, with no rebuild. So restore **deletes the whole `index.sqlite`**. The first start then runs the full reference indexer (a one-time cost of seconds to a few minutes, logged as "Reference index ... (ms)"), `homebrew.syncIndex()` and `pages.reindexAll()`. Optimising this is out of scope. The report and the guide tell the host to expect a slower first start.

**8.7 Ownership and permissions.** Staging is created by the process user, so a restore run as `node` yields `node`-owned files. If run as root, after the swap it `chown`s the restored `app.sqlite`, the `uploads/` tree, the pre-restore directory and `restore-log.jsonl` to the uid/gid of `DATA_DIR` (best effort, warns on failure); running as `node` is the documented way. Modes: files 0600, directories 0700, set explicitly (not left to `umask`). M3.6 also advises `DATA_DIR` itself be mode 0700 on non-Docker installs.

## 9. Zip-slip, zip-bomb and archive hardening (restore)

### 9.1 The gate, names, and the end of the archive

The reader parses the central directory first, validates the whole structure, and only then inflates. Gate: every central-directory record must have compression method exactly 8 and the data-descriptor flag; the local header is re-read before an entry's data is touched and must repeat method 8, the same flags and name, an empty extra field, and CRC/sizes that are zero or equal to the directory's; the 16-byte data descriptor must equal the directory record. Layout: the end record is the last 22 bytes with comment length 0; zip64 records, if used, sit at the exact locator position; entries appear in the order manifest, `app.sqlite`, uploads and thumbnails, `checksums.json`, each starting exactly where the previous one ends, the directory starting exactly where the last entry ends. Nothing can hide between entries or after `checksums.json`. The central directory's names are authoritative and are compared with the local headers. Symlinks and directories: the central directory's file-type bits are ignored; every entry is a regular file written to a path built only from constants and an allowlisted id. Exact consumption: the deflate stream must end exactly at the entry's compressed size. Limits in §9.2 are enforced while inflating.

**Names.** An entry is accepted only if its **entire** name matches one of: `manifest.json`, `app.sqlite`, `checksums.json` (each exactly once), or `^uploads/[0-9a-f-]{36}(\.thumb)?$`. All patterns are **anchored with `^` and `$` and have no `m` flag** (so a name containing a newline cannot smuggle a valid line); they are tested against the whole string, and names over 120 bytes, containing NUL, backslash or a drive letter, absolute paths and `..` fail by not matching. A non-matching name **fails the whole restore** (it is not skipped). Output paths are `join(staging, ...)` of constants and matched ids only, with a final `startsWith(staging + sep)` assertion after `resolve`.

**End of archive.** The end record is validated (last 22 bytes, comment length exactly 0, zip64 records at the exact locator position, entry count equal to the directory) before anything is inflated; a missing or malformed end record means a truncated or foreign archive. Nothing follows `checksums.json`, and the backup writer never writes a comment.

### 9.2 Size, count and ratio limits (independent of the manifest)

| Limit | Value |
|---|---|
| Entries | at most 200,000 files under `uploads/` plus the 3 fixed entries = 200,003 (the same constant the writer enforces) |
| `manifest.json` | at most 1 MiB |
| `checksums.json` | at most 48 MiB decompressed. It is read into memory to parse: worst case about 48 MiB of text and roughly 3x that as objects, so a transient restore memory cost near 150 MB at the cap; this is stated and accepted. |
| `uploads/<id>` | at most 16 MiB (`MAX_UPLOAD_BYTES` + 1 MiB) |
| `uploads/<id>.thumb` | at most 4 MiB |
| `app.sqlite` | at most the size **declared in `manifest.database.bytes`** (a lying manifest can only *lower* what is accepted, never raise it), and never more than 4 GiB (backup refuses an entry of 4 GiB or more, so the two limits agree), and never more than free space minus 64 MiB |
| Total decompressed | at most free space minus 64 MiB |
| Compression ratio | an entry exceeding 200:1 after its first 1 MiB aborts (uploads, thumbnails, JSON); `app.sqlite` is held to 50:1, because it legitimately compresses well but a hostile sparse file does not need to |
| Method | deflate (8) only |

Limits are enforced **while inflating** (byte counting in the `ondata` callback, terminating the stream at the cap), never trusted from headers. An abort deletes staging.

### 9.3 Truncated, corrupt, wrong files

Missing end of archive, no `checksums.json`, a truncated entry, a bad deflate stream, a sha256 or size mismatch, or a non-zip file all end in a single refusal with a stable message ("This is not a complete Critical Notes backup") and exit code. A restore never reports success on a partially verified archive.

## 10. Who may create, list, download and restore

| Action | Who | How |
|---|---|---|
| Create | Admin session only | `POST /api/admin/backups` |
| List | Admin session only | `GET /api/admin/backups` |
| Download | Admin session only, plus step-up (below) | `GET /api/admin/backups/:name?ticket=...` |
| Restore | **Host with shell access to the data directory only** | `node dist/admin.mjs restore` |
| Create via CLI | Host with shell access (local trust, like `reset-link`) | `node dist/admin.mjs backup` |
| Delete | Retention only (section 11); no delete endpoint in 1.0 | |

- All three routes sit under `/api/admin/*`, so `requireAdmin` applies, which already rejects any request authenticated with an API token. The backup routes are **not** added to the MCP `ROUTES` allowlist; M3.4 adds a test that `isAllowed(method, path)` is false for every backup route and method.
- **Restore is never exposed over HTTP.** Restore replaces every account, including the admin accounts; an HTTP restore would let a stolen admin cookie plus any crafted zip create an attacker's admin. The CLI requires shell access to the volume, which is already total control (same reasoning as `accounts.md` T20).
- **Step-up for download.** A stolen admin cookie is the realistic abuse (`accounts.md` T10): one `GET` would hand over every password hash, token hash and DM secret. Therefore download is two steps: `POST /api/admin/backups/:name/ticket` with `{ currentPassword }` (verified with `verifyPassword`, limited to 5 per minute per admin, counted before the verification is awaited, as in T10) returns `{ ticket }` (that POST sends `Cache-Control: no-store`); the ticket is 32 random bytes, bound to the **admin id, the session id and the file name**, valid 60 seconds, **single use**, held in memory (bounded map) as a sha256. The browser then navigates to `GET .../:name?ticket=...`, so a multi-gigabyte file is streamed by the browser to disk, never buffered in JavaScript. The `GET` still passes `requireAdmin` (cookie session, admin, no token), so a ticket alone is worth nothing, and a ticket redeemed under another session is denied. Access logs, if any are ever added, must redact the `ticket` query parameter (the app logs none today). Listing and creating need no step-up. Owner decision D4 allows dropping this step.
- **Admins read DM secrets.** A backup contains every campaign's DM-only content, so "admin" means "trusted with everything", exactly as the owner of the database is. The "Players never receive DM content" rule (PROJECT §4) is about projections for players; backup routes return no projection by design and are **exempt from the visibility sentinel test**, covered instead by the admin-only tests. The M3.6 guide and the admin page text state that granting admin gives access to all campaign secrets through backups.

## 11. Retention, disk and concurrency

**Settings.** `BACKUP_KEEP` (integer 1 to 1000, default **7**; invalid values log a warning and use the default). Optional `BACKUP_DIR` (default `DATA_DIR/backups`), see D6. **Validated at startup (and by the CLI):** it is resolved with `realpath`, and the server **refuses to start** (CLI: exits non-zero) if it equals or lies inside `webDistDir`, `uploadsDir`, `fivetoolsSrcPath`, `fivetoolsImgPath`, or if it equals `DATA_DIR` itself (a subdirectory of `DATA_DIR` other than `uploads` is fine, which is the default); it also refuses a world-writable directory, and logs a warning when an existing directory's mode is wider than 0700 (a directory it creates is 0700). This keeps backups out of anything the app serves or the swap replaces. Files live in a directory created with mode 0700; zips are created 0600 by explicit `fchmod`, independent of `umask`.

**Atomic creation.** Write to `backups/.partial-<random>.zip` (`flag: 'wx'`, 0600), `fsync` the file, **verify** (below), rename to the final name `backup-YYYYMMDDTHHMMSSZ.zip`, `fsync` the directory. A listing, a download or a prune never sees a `.partial` file (it does not match the name regex). If the final name exists (two backups in one second), the timestamp is advanced by a second until free. Leftovers (`.partial-*`, `.tmp-*`) older than 1 hour with no live lock are removed at service start and before each backup.

**Verify before publish.** The finished temp file is re-read through the same streaming reader restore uses (hashing to nowhere, no extraction), applying the **same** `compression === 8` gate, name allowlist, entry count, per-entry size, ratio and end-of-archive rules of section 9 (so a backup that restore would refuse is caught when it is made), and compared with `checksums.json`. A failure deletes the temp file and fails the backup, and **prunes nothing**. This proves the writer and the reader agree on every backup, and is the cheap half of "an untested backup is not a backup"; the full restore drill is in CI (M3.3) and is available to the host as `restore --check`.

**Prune.** `prune(keep, origin)` (origin = `api`, `cli` or `scheduler`) runs after every successful, verified backup. Common rules, then the origin-specific eviction rules:

- candidates are files whose name matches `^backup-\d{8}T\d{6}Z\.zip$` (nothing else in the directory is ever touched), ordered by the **timestamp in the name**, not mtime (copying changes mtime);
- the base rule is to delete the oldest while more than `keep` remain; `keep` is clamped to at least 1, so the newest verified backup is never a candidate; the eviction rules below restrict **which** backups that rule may touch and what counts toward `keep`;
- **Origin-restricted eviction (decision for R5): one rule for all origins.** A stolen admin cookie can create backups through the API (3 per 10 minutes) and, with `BACKUP_KEEP=7`, would otherwise rotate every earlier backup out in about 25 minutes. Each backup is classified by the `trigger` in its manifest (`api`, `cli`, `scheduler`). Define two sets:
  - **Protected set P:** API-created backups **younger than 7 days** (constant `API_PRUNE_MIN_AGE_DAYS = 7`). They are always retained and **not counted** toward `keep`.
  - **Ranked set R:** everything else, that is non-API backups **and** API backups aged 7 days or more, ranked together by the **name timestamp** (newest first). The newest `keep` of R are retained; the rest are the deletion candidates.
  - An **unrestricted prune** (started by the CLI or the scheduler) may delete any candidate of R. An **API-started prune** may delete only candidates of R that are **older than 7 days**, and only while more than `keep` remain in R. An API create never evicts anything younger than 7 days.
  - Consequences: a host that only ever uses the UI keeps `keep` backups once they are 7 days old (API backups age into R and are then ranked like any other), so `BACKUP_KEEP` still works for UI-only hosts; making one CLI backup does not delete the API backups older than 7 days, because they are ranked together with it and only the newest `keep` of R survive. The directory can briefly exceed `keep` by the size of P.
  - **`trigger` is set by the entry point** (the route handler passes `api`, the CLI command `cli`, the scheduler `scheduler`) and is **never taken from request input**: no request field, header or query parameter can set it.
  - **Classification reads** use the bounded reader only: first zip entry, deflate only, at most 1 MiB, never a full extraction; the result is cached per file name and size (a changed size re-reads). A zip in the directory that is corrupt, foreign, hand-copied or whose manifest does not parse is classed `api` (conservative) and must not break prune; a name that matches the regex but has no readable manifest is simply `api`.
  - **Disk implication:** to bound P, an API create is **refused (409)** when P holds `3 x keep` backups (21 by default), and the free-space preflight still applies to every create. A flood therefore fills at most that many backups. **Note for the UI:** when flooded, "Back up now" can be blocked for up to 7 days; the page and the guide then say "use the CLI" (`node dist/admin.mjs backup`), which is not subject to the cap.
  - **Residual, stated precisely.** The exposure is **passive**: a one-time flood is protected for 7 days, then ages into R and can push out genuine backups **only if there are no newer genuine backups**, that is, no scheduler or CLI backups since. Pre-compromise backups survive **7 days after the flood**; that is the host's window to notice (audit lines `backup.created`, `backup.pruned` with origin), copy backups off the machine, or enable the scheduler. D9 and the guide rely on that window. An attacker who keeps a session for more than 7 days and keeps flooding is the same case.
  - The earlier idea of a 24-hour floor is **dropped**: it is only a speed bump (create, wait a day, repeat, and the floor backup is the attacker's).
  - Rejected: separate retention classes with their own knob, minimum spacing between creates (slows, does not stop), step-up when a create would prune (a prompt on routine use). Every deletion is audited as `backup.pruned` (name, reason, origin);
- it never runs after a failed backup, so a failing system does not erase its good backups;
- a name currently leased by a download in this process is skipped (the lease is held from ticket redemption until the response ends). Across processes (CLI prune while the server streams) it is still safe on Linux, because the download holds an open file descriptor and an `unlink` does not affect it.

**Disk space.** Preflight needs `statfs(backupDir).bavail` at least `dbBytes (temp copy) + dbBytes + uploadsBytes (worst case, no compression gain) + 64 MiB`; otherwise refuse with the numbers (HTTP 507, CLI exit code "disk"), before creating anything. It does **not** delete old backups to make room: with `BACKUP_KEEP=1` that would open a window with zero backups. The message advises lowering `BACKUP_KEEP`, freeing space or using `BACKUP_DIR`. ENOSPC mid-write is caught, the partial file and the temp directory are removed, and the failure is audited.

**Concurrency.** One backup at a time per data directory: an in-process mutex, plus `backups/.lock` created with `O_EXCL` for cross-process exclusion (CLI versus server), holding start time and pid, whose mtime the holder touches every 15 seconds; a lock older than 2 minutes is stale and may be taken (no pid check: pids are meaningless across containers). **Takeover is atomic:** the taker `rename`s the stale lock to `.lock.stale-<random>` (only one racing taker succeeds; the others get `ENOENT` and retry the normal path), then creates a fresh lock with `O_EXCL`, then deletes the renamed file. A second request gets HTTP 409 "A backup is already running" (CLI exits non-zero).

## 12. Scheduled backups (M3.5, stretch)

- `BACKUP_EVERY_HOURS` (integer 1 to 720; unset or `0` = off). Runs in the server process via a `setTimeout` chain with `unref()`, so it never keeps the process alive and tests need no fake timers beyond one injectable clock.
- The next run is computed from the **newest backup's timestamp in its name** plus the interval, so restarting the server does not reset the schedule.
- **Missed runs:** at start, if the newest backup is older than the interval, run **one** catch-up backup after a 60-second delay (after indexing, jittered by up to 30 s); never replay several missed runs.
- **Overlap:** the same mutex and lock as manual backups. A due run that finds one running is skipped and logged; it is not queued.
- **Failure:** audit `backup.failed` with a short reason, keep the last error in memory for the admin list, retry at the next interval (no tight retry loop). Pruning follows section 11.
- Audit lines use `actor: 'scheduler'`; the interval is not a security boundary. A second server process sharing the directory (N14) is protected by the lock file.

## 13. Download safety

`GET /api/admin/backups/:name?ticket=`:

1. Validate `name` against `^backup-\d{8}T\d{6}Z\.zip$` **before any file system call**; anything else is a uniform 404. The path is `join(backupDir, name)` of a regex-matched constant shape, so traversal cannot occur; additionally open with `O_NOFOLLOW`, `fstat` the descriptor and require a regular file.
2. Redeem the ticket (single use, bound to admin, session and name). Wrong, used or expired: uniform 404.
3. Rate limit: 5 tickets per admin per minute (above) and 3 concurrent downloads per process.
4. Response headers: `Content-Type: application/zip`, `Content-Disposition: attachment; filename="<name>"` (safe because of the regex), `Content-Length` from `fstat`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. The compress middleware must skip this path (deflating a zip wastes CPU and buffers).
5. **Range requests are ignored**: `Accept-Ranges: none`, always a full 200. Also `Referrer-Policy: no-referrer` on this response.
6. Body: `Readable.toWeb(createReadStream(fd))`, back-pressured; nothing is read into memory. A client abort closes the descriptor.
7. Audit `backup.downloaded { actor, name }`, `backup.ticket_issued` and `backup.ticket_denied` (including a **wrong password**, an expired, reused or wrongly bound ticket); never log the ticket, the password or the URL query.

`POST /api/admin/backups` answers **202** with `{ name, status: 'running' }` (a multi-gigabyte backup must not hold an HTTP request open); the page polls `GET /api/admin/backups`, whose response is `{ backups: [{ name, size, createdAt }], running: { name, startedAt } | null, lastError: string | null, lastWarnings: string[] }`. `createdAt` is parsed from the name. **M3.4 amendment:** the list also reads each file's bounded manifest head once (first entry, deflate only, at most 1 MiB, cached by name+size, the same read that classifies the trigger) and returns `trigger`, `appVersion`, `migrationLevel` (the newest migration tag), `counts` and `missingUploads`, `null` when the manifest cannot be read in full; nothing else in the zip is read. `lastError` is a fixed sentence chosen from a stable code, never raw error text. Download hardening added in M3.4: the file is opened with `O_NOFOLLOW | O_NONBLOCK` and refused unless it is a regular file with `nlink === 1`; a download whose reader drains nothing for 60 s is destroyed (slot and lease freed; there is no total cap); the slot check comes before the ticket is redeemed, so a 429 does not burn the ticket; `HEAD` answers 405 without redeeming; audit lines carry the client `ip`.

## 14. Threat notes on backup files

Assets: password hashes (argon2), API-token hashes, invite-link hashes, session ids, every campaign's content including DM-only content, all uploaded images. A backup is the whole instance in one file.

| # | Threat | Where | Control / decision |
|---|---|---|---|
| B1 | Backup file leaks (copied to cloud, left on a laptop, shared by mistake) | file at rest and off the machine | 0600 file, 0700 directory, never served by any static route. **The app does not encrypt in 1.0 (out of scope, D3).** Argon2 slows but does not stop offline guessing of weak passwords; token and session hashes are sha256 of high-entropy secrets and are not guessable, but the content is plaintext. The guide tells hosts to treat backups like the database: encrypt before they leave the machine with a tool of their choice (e.g. `age -p`, `gpg -c`, restic/borg repositories, an encrypted disk or bucket) and to keep copies off the host. A passphrase-encrypted container would wrap the **whole** zip (`backup-....zip.age`) outside this format, so it needs no `format` change when added later. |
| B2 | Stolen admin session downloads everything | download route | Admin-only, API tokens rejected, step-up ticket bound to admin, session and file (D4), 5/min limit, audit lines for issue, denial and download, `no-store`, `no-referrer`, no ranges. |
| B3 | A non-admin or an AI assistant reaches the routes | MCP, other routes | `requireAdmin` rejects token auth; routes absent from the MCP allowlist; test proves both. |
| B4 | Path traversal or arbitrary file read through the download name | download | Strict regex before FS access, constant directory, `O_NOFOLLOW`, regular-file check. |
| B5 | **Tampered or attacker-crafted backup is restored** (new admin, planted triggers, swapped uploads) | restore | `checksums.json` is **not authenticity**; whoever can modify the zip can recompute it. The real control is that restore needs host shell access and the host chooses the file. Restoring a file from an untrusted source is equivalent to installing someone else's database: never do it. Restore additionally allowlists schema objects (section 8, step 3), lists the enabled admins in the report, and revokes tokens and invites. Signing backups (a key held outside `DATA_DIR`) is deferred (D3). |
| B6 | **Restore as privilege escalation** (HTTP restore replaces the admin set) | restore | No HTTP restore, no MCP path, CLI only. A user able to run the CLI can already read the data directory. |
| B7 | **Backup of an already compromised instance** brings the attacker back | restore | Sessions, resets purged; tokens and invites revoked (default); but an attacker-created **admin account and password hash are inside the file**. The restore report lists enabled admins; the guide's compromise checklist says: restore from a backup taken **before** the incident (origin-restricted eviction, section 11, helps ensure one exists), then reset every admin password and review users, and securely dispose of the pre-restore copy (B16). |
| B8 | Resurrected security state | restore | Section 8.1: live restrictions are diffed and carried over by default; what cannot be compared (live database unreadable or absent) is stated in the report. |
| B9 | Zip-slip, zip bombs, resource exhaustion on restore | restore | Section 9. |
| B10 | Backup used to fill the disk (repeated requests) | create | One at a time, 3 creations per admin per 10 minutes, free-space preflight, retention, 202 + polling. |
| B10b | **Backup rotation by a stolen admin cookie** wipes pre-compromise backups (3 per 10 minutes with `KEEP=7`) | create + prune | One ranking rule (section 11): API backups younger than 7 days are retained and not counted; all other backups are ranked by name and the newest `keep` retained; an API prune deletes only candidates older than 7 days; API creates capped at `3 x keep`; `trigger` set by the entry point; every prune audited with origin; D1, D9. |
| B11 | Backup process gets starved or hangs the server | create | Async page-stepped copy, 64 KiB streaming, 10-minute database limit, no worker threads. |
| B12 | Secrets in logs | all | Log only names, sizes, counts and the actor id. Never log the manifest, checksum list, file contents, tickets, query strings, SQL error text containing rows, or restore staging paths beyond the data directory. CLI `info` goes to stderr, results to stdout (existing convention). |
| B13 | Backups sit on the same disk as the data | design | A backup on the same volume does not survive a dead disk or a deleted volume (`docker compose down -v`). The page and the guide say so; `BACKUP_DIR` on a separate volume or mount, and a periodic copy off the machine, are the recommendation. |
| B14 | Admin can read DM secrets via backups | design | Accepted: admin is the host-level role (section 10). The guide and the grant-admin dialog text should say so. |
| B15 | Predictable temp names or world-readable temp data | create | Random names, 0700 temp dir inside the backups dir (same file system), deleted in `finally`, `wx` flags. |
| B16 | **Pre-restore copy keeps old secrets** (old live tokens and hashes, attacker persistence after a compromise) on disk | restore | Printed path and size, "delete after verifying" in report and guide, secure-delete or encrypted-volume advice for compromise, never auto-deleted (8). |
| B17 | Restore actions leave no durable trace (container logs vanish) | restore | `restore-log.jsonl` (8.2), CLI audit to stderr. |
| B18 | Backup directory placed inside served or swapped paths | config | `BACKUP_DIR` validation at startup (section 11). |

Residual risk accepted for 1.0: plaintext backups protected only by file permissions and the host's own storage hygiene.

## 15. Postgres

**Backups are SQLite-only for 1.0.** The Postgres schema (`schema.pg.ts`, `drizzle-pg/`) is a mirror kept in parity but the server does not run on it. M3 therefore adds nothing to Postgres, and `manifest.database.engine` is always `"sqlite"`; restore refuses any other value. **What N14 will need** (so the format does not have to change): (a) the `engine` field, already reserved; (b) a Postgres snapshot method in place of `db.backup()`: logical `pg_dump --format=custom` for small instances, or a physical base backup plus WAL archiving for point-in-time recovery, packaged as a different database entry (e.g. `app.pgdump`) selected by `engine`; (c) the migration level from the drizzle-pg journal and its `__drizzle_migrations` rows, same compatibility rules; (d) restore into a stopped application **and** a stopped, or freshly created, database, with different "is anything connected" probing (`pg_stat_activity` or an exclusive advisory lock instead of the SQLite lock); (e) uploads as a file store or an object store, with the T0 < T1 ordering rule kept; (f) a different place for sessions and a connection-pooler-aware drain. To keep that cheap, M3.2 keeps the database-specific parts in exactly four named functions of `services/backups.ts` (`snapshotDatabase`, `readMigrationLevel`, `prepareRestoredDatabase`, `probeStopped`); it does not introduce an interface or a driver abstraction before there is a second implementation.

## 16. App version source

Root `package.json` has no `version` today. Until M5.4 lands: M3.2 adds `apps/server/src/lib/version.ts` exporting `appVersion()`. In the bundle, `scripts/build.mjs` injects it with esbuild `define: { __APP_VERSION__: JSON.stringify(v) }`, where `v` is the root `package.json` `version` if present, otherwise `apps/server/package.json` `version` (`0.0.0`). Under `tsx` (dev, tests) `appVersion()` reads the same file through `REPO_ROOT`. The Docker build stage already copies the root `package.json`, so the build sees it. The manifest takes `app.version` from this function only. **M5.4 owns the single source of truth** and rewrites `version.ts`'s source and the `define`; the manifest field and its meaning (informational) do not change.

## 17. Size and time estimates (to be replaced by M3.2 measurements)

| Item | Estimate | Basis |
|---|---|---|
| `app.sqlite` | 5 to 200 MB for years of notes of a few campaigns | pages are JSON blocks of a few KB each; this is a guess, not a measurement |
| Uploads | 0.2 to 3 MB each (cleaned, re-encoded, 15 MiB cap), 100 to 2000 files, 0.1 to 5 GB | `cleanImage` re-encodes and limits the longest edge to 8192 px |
| Zip size | about `uploads + db / 3` | images do not compress further |
| Backup time | DB copy: seconds (page-cache speed, hundreds of MB/s); deflate level 1: roughly 100 to 200 MB/s on one core; verify pass is a similar read. 200 MB DB + 5 GB uploads is disk-bound, in the order of 1 to 3 minutes | typical hardware, unmeasured |
| Restore time | extraction at disk speed plus the first-start index rebuild (seconds to a few minutes) | |
| Temporary space | backup: one extra copy of the database (preflight in section 11). Restore: staging up to the declared uncompressed sizes; use the preflight formula `max(3 x zip size, sum of declared sizes) + 64 MiB` (section 8, step 1), not the zip size alone | |

M3.2 benchmarks three fixtures (small, medium with 200 MB DB, large with 3 GB of uploads) and records numbers in `docs/PLAN.md`. The RTO target above stands or is amended with those numbers.

## 18. Task boundaries

| Task | Owns (and files) | Must not do |
|---|---|---|
| **M3.2** Service (`services/backups.ts`, `lib/version.ts`, `scripts/build.mjs` define, tests) | `BackupService`: `create({ actor })` (lock, preflight, snapshot, uploads stream, manifest/checksums, verify, rename, prune), `list()`, `prune(keep, origin)` (origin-restricted eviction, `trigger` in the manifest, API create cap), `status()`, `isRunning()`, `BACKUP_DIR` validation, `appendOpsLog()` for `restore-log.jsonl`, the restore-specific `openAppDb` variant (pragmas before migrate) and the schema-allowlist/migration-row checks, `openForDownload(name)` returning a leased descriptor, `verify(zipPath)` (streaming reader, shared with restore), `restoreInto(...)` building blocks the CLI calls (stream-extract with all section 9 limits, manifest and migration compatibility, staged database preparation, section 8.1 purges). The four database-specific functions of section 15. Config parsing for `BACKUP_KEEP`, `BACKUP_DIR`. Audit lines. | No HTTP routes, no CLI wiring, no timer, no UI, no `main.ts` change, no new table. |
| **M3.3** CLI (`cli/admin-core.ts`, `cli/admin.ts`, `main.ts`, CI) | `backup` and `restore <file> [--check] [--yes] [--keep-tokens] [--no-carry-restrictions]` entries in `SUBCOMMANDS`. Extend `Subcommand`: `run(...)` may return a `Promise<string>`, and an entry may set `needsDb: false` so `admin.ts` skips the `existsSync(appDbPath)` check and `openAppDb` (restore on a wiped instance; backup uses its own connection). Lock probe, marker, staging, swap, pre-restore, `index.sqlite` deletion, chown, report text, new exit codes in `EXIT` (not running required, newer migration level, invalid backup, disk, already running). **`main.ts`: refuse to start while `.restore-in-progress` exists, checked at the very top (before `ensureDataDirs`) and again right after `openAppDb`.** `backup`, `reset-link` and all DB-opening subcommands refuse while the marker exists. The CLI audit variant writes to stderr. Marker handling, crash-resume and no-clobber install exactly as sections 7.1 and 8. CI restore drill: backup → wipe `DATA_DIR` → restore → start server → compare. | No logic duplicated from the service; no HTTP. |
| **M3.4** Endpoints and page (`routes/backups.ts`, `app.ts`, web admin page) | `POST/GET /api/admin/backups`, `POST .../:name/ticket`, `GET .../:name` as in sections 10 and 13; skip `compress()` for the path; rate limits; `isAllowed` negative tests; admin page (Back up now, polling list with warnings and last error, download through the ticket, text on storage and DM-secret exposure, the 409 "use the CLI" message when the API cap is reached, no restore button). | No restore over HTTP, no delete endpoint, no scheduler. |
| **M3.5** Scheduler (`services/backup-scheduler.ts`, `main.ts` wiring) | `BACKUP_EVERY_HOURS`, section 12 rules, injectable clock, last error exposed through `status()`. | No new retention rules; no cron library. |
| **M3.6** Guide (README, `docs/STATUS.md`) | What is inside, Docker and non-Docker backup and restore, the stop-first requirement, off-machine copy, encryption advice (B1), `BACKUP_DIR` on a second volume, the post-restore notice and compromise checklist (B7, 8.1), `--keep-tokens` and `--no-carry-restrictions`, **stop the container (`docker compose stop app`) before restoring and before wiping the volume** (the marker crash-loops a running `restart: unless-stopped` server), pre-restore copy cleanup and secure-delete advice, `DATA_DIR` mode 0700 on non-Docker installs, slow first start. | No new behaviour. |

## 19. Test checklist (QA gate for M3.2 to M3.5)

Service and format (M3.2):
- [ ] **Consistency under writes:** while a loop creates pages in transactions (each transaction inserts two rows that must stay paired) on the server's connection, take a backup; restore it; every pair intact, `integrity_check` ok, row count at least the count when the backup started. A second variant writes from another process (CLI-like) and still completes within the limit.
- [ ] **Round trip equality:** backup → wipe → restore → all tables equal row for row (except the purged and revoked state), and every upload file byte-identical (sha256).
- [ ] **Adversarial upload bytes** (`PK\x07\x08` repeated, sizes around chunk boundaries) round-trip exactly at level 1/6. **Restore of a hand-built zip with a *stored* entry (method 0) that contains `PK\x07\x08` is refused by the `compression === 8` check in the central directory and again in the local header, before any entry data is read**, and the test asserts the entry's bytes were never written. Level-0 deflate entries are refused or fail the sha256 check.
- [ ] **Memory bound:** more than 500 MB of generated uploads archived with peak RSS growth under 64 MiB and event-loop delay (measured) under 100 ms at p99.
- [ ] **Order guarantee:** an upload added mid-backup is present as an orphan or absent, never a row without a file; the post-check counts missing files correctly.
- [ ] **Concurrent requests:** two simultaneous `create()` calls → one runs, the other gets "already running"; two processes (lock file) the same; a stale lock is taken over.
- [ ] **Prune safety:** keep clamps at 1; only regex-matching names are touched (a `notes.txt` and a `backup-x.zip` in the folder survive); ordering uses the name not mtime; the newest is never removed; nothing is pruned after a failed backup; a leased name is skipped; pruning while a download streams does not break that download.
- [ ] **BACKUP_DIR validation:** inside or equal to `webDistDir`, `uploadsDir`, the 5etools paths or `DATA_DIR` is refused at startup; world-writable refused; wider than 0700 warns.
- [ ] **Origin-restricted eviction:** with `KEEP=2` and clock control: an attacker loop of API creates after 1 day leaves every older genuine backup in place and stops with 409 at `3 x keep`; after waiting **more than 24 h** it still cannot evict anything younger than 7 days; after **more than 7 days** the flood has aged into the ranked set and pushes out genuine backups only when no newer genuine backups exist (the stated residual); a **UI-only host** (all backups `api`) keeps exactly `keep` backups once they are 7 days old; **one CLI backup does not delete every API backup older than 7 days** (they are ranked with it, the newest `keep` survive); a scheduler or CLI prune after a flood keeps the protected API backups and the newest `keep` of the ranked set; `backup.pruned` is audited with origin. **`trigger` cannot be set from a request:** no body field, header or query parameter on `POST /api/admin/backups` changes the manifest `trigger`. **Foreign files:** a corrupt zip, a foreign zip and a regex-named non-zip in the backups directory are classed `api` and do not break prune or list. **Bounded classification read:** the manifest read for classification refuses non-deflate entries and first entries over 1 MiB, never extracts anything else, and is cached per name+size (a test counts file reads). Stale-lock takeover by two racers yields one winner.
- [ ] **Caps equal on both sides:** a fixture with 200,000 upload files + 3 is written and restored; 200,001 fails in the writer and is refused by the reader; an EOCD with a non-empty comment is refused; the backup's own verify pass refuses a zip that violates the section 9 limits.
- [ ] **Pre-swap check and racer debris:** killing the probe connection or replacing `app.sqlite` (different inode) before step 2 aborts without swapping; a fake racer creating `app.sqlite`+`-wal`+`-shm` after step 2 ends up under `pre-restore/racer-*` and the install succeeds; a persistent racer triggers the rollback, which restores `uploads/` and the database triple, removes staging and the marker; a rollback failure leaves the marker; a crash between `link()` and the unlink resumes by unlinking the staging name only.
- [ ] **Disk:** preflight refuses with numbers when space is short; simulated ENOSPC mid-write leaves no `.partial` and no temp directory; old backups are untouched.
- [ ] **Atomicity and permissions:** no listing shows `.partial`; file mode 0600, directory 0700 regardless of `umask`; a kill during creation leaves the previous backups intact.
- [ ] **Verify step** catches a deliberately corrupted temp file.

Restore (M3.3):
- [ ] Refused while a server holds the database (real second process); allowed after `kill -9` of that process; allowed on an absent database.
- [ ] **Newer migration level** refused (fixture with an extra migration), **diverged history** refused, **older level** restored and migrated; the staged-copy migration failure aborts with live data untouched.
- [ ] **Corrupted zip** (flipped byte in the middle), **truncated zip** (cut at several offsets including inside the first entry), not-a-zip, empty file, missing `checksums.json`, extra entry not listed, wrong sha256: all refused, `DATA_DIR` byte-identical afterwards, no staging left.
- [ ] **Anchoring:** a name with an embedded newline (`uploads/<valid id>\nx`) and a name valid on its own line are refused. **Entry after `checksums.json`**, trailing bytes after the end-of-central-directory, a missing EOCD: refused. A symlink entry (unix mode in the central directory) is treated as a regular file: accepted only under an allowlisted name and a matching checksum, and no symlink is ever created.
- [ ] **Zip-slip:** entries named `../x`, `/etc/x`, `uploads/../../x`, `uploads\..\x`, `uploads/NUL`, a symlink entry, a directory entry, duplicate names, a name that is a valid id plus `/extra`: refused; nothing written outside staging.
- [ ] **Zip bomb:** a small zip inflating to far over the caps (single entry and many entries) is aborted at the cap with bounded disk use and memory; a lying manifest does not raise the caps.
- [ ] **Planted schema:** a backup whose `app.sqlite` has a trigger or view is refused **before any write**, and a trigger that would write a marker row proves it never fired during migration or the purges. **Forged migration rows:** a database whose `__drizzle_migrations` has a huge `created_at` (so `migrate()` would skip everything) is refused by the row comparison even when the manifest claims a valid level. A manifest `database.bytes` lower than the real file aborts; a `checksums.json` path that fails the regex refuses.
- [ ] **BLOCKER for M3.3 (was an open question): schema-allowlist stability.** For every pair (backup at each historical migration level 0000..latest, applied through the real upgrade path) the migrated staged `sqlite_master` equals a fresh `:memory:` migration. Fixtures are generated by running the old journal prefixes. If this fails, M3.3 stops and raises a design change.
- [ ] **Carry-over:** a user disabled live after the backup is disabled in the restored database; a token revoked live stays revoked under `--keep-tokens`; `--no-carry-restrictions` skips it; an unreadable or absent live database yields the stated report and `liveCompared: false`. `--keep-tokens` without `--yes` is refused and prints the warning.
- [ ] **Durability and resume:** kill the restore at each swap step boundary (and mid-step), re-run with the same zip: completes with exactly one pre-restore directory and no stale `-wal`/`-shm`; re-run with a different zip refuses; markers are written atomically (no torn JSON after a kill); `uploads/` as a symlink or mount point is refused; a racing process creating an empty `app.sqlite` at the target is swept into `pre-restore/racer-*` and the install succeeds (a persistent racer rolls back, see the pre-swap test).
- [ ] **Server vs marker:** a server started while the marker exists exits 1 before touching `DATA_DIR` and also after `openAppDb`; `restart: unless-stopped` crash-loops harmlessly; `backup` and `reset-link` refuse.
- [ ] **restore-log.jsonl:** records for `backup.created`, `restore.started/completed/aborted` appear with the listed fields, mode 0600, survive a restore, and CLI stdout contains no audit line.
- [ ] **Post-restore state:** `sessions` and `password_resets` empty; all tokens and invites revoked, kept with `--keep-tokens`; `disabled_at` unchanged; first login works; the report lists enabled admins.
- [ ] **Stale WAL:** restore over a live-looking database with `-wal`/`-shm` files leaves none beside the new file; the pre-restore directory contains the old triple.
- [ ] **Index:** after restore the first start rebuilds `page_search`; searching finds restored pages and not deleted ones.
- [ ] **Marker:** server refuses to start with the marker; an interrupted swap (kill between renames) is completed by re-running the same restore, with one pre-restore directory.
- [ ] **Container drill (CI):** as user `node` against the image with a named volume: backup, wipe volume contents, restore, start, health check ok, files owned by `node`.
- [ ] `restore --check` leaves the data directory untouched.

HTTP (M3.4):
- [ ] Anonymous 401, non-admin 403, API token of an admin 403, admin 202/200; none of the routes matches `isAllowed`.
- [ ] Ticket bound to session: redeeming under another admin session or another file is denied and audited; the ticket POST has `Cache-Control: no-store`; the download response has `Accept-Ranges: none`, ignores a `Range` header (200 and full length) and sends `Referrer-Policy: no-referrer`; a wrong password is audited.
- [ ] Name validation: `..`, encoded traversal, missing extension, wrong digits, a symlink named like a backup, a directory named like a backup: 404.
- [ ] Download: headers (`attachment`, `no-store`, `nosniff`, length), body equals the file, aborted download releases the lease, no compression; ticket single use, expires, bound to admin, session and name, wrong password 403 and counted; rate limit 429.
- [ ] Concurrent POST: 409 for the second; list shows `running` and then the file.
- [ ] No log line contains a ticket, a password or file contents (capture and grep).

Scheduler (M3.5): runs at the interval with an injected clock; no overlap with a manual run; one catch-up after a long outage, not several; a restart does not reset the schedule; a failed run keeps old backups and reports the error.

## 20. Decisions for the owner

Answer yes or no; each line carries the recommendation.

| # | Decision | Recommended |
|---|---|---|
| D1 | `BACKUP_KEEP` default **7**, minimum 1, retention automatic only (no delete button in 1.0). One rule for all origins: API-created backups younger than 7 days are always kept and not counted; every other backup (including API ones older than 7 days) is ranked by date and the newest `keep` are kept; an API prune deletes only candidates older than 7 days. The directory may briefly exceed `BACKUP_KEEP`; API creates are capped at `3 x keep` ("Back up now" may be blocked for up to 7 days after a flood: use the CLI). Residual: after a flood the genuine backups survive 7 days; enable the scheduler (D9) so newer genuine backups exist. | Yes |
| D2 | A restore **revokes all API tokens and campaign invite links** and clears sessions and reset links; `--keep-tokens` is the opt-out for plain hardware-failure recovery, prints a warning and requires `--yes`. Password hashes stay as in the backup. | Yes |
| D2b | A restore **carries live restrictions over by default**: users disabled live and tokens/invites revoked live stay so in the restored data (opt-out `--no-carry-restrictions`); demotions, deletions and lost users are reported. Needs the live database to be readable. | Yes |
| D3 | **No encryption or signing inside the app for 1.0.** The guide recommends encrypting before copying off-site (`age`, `gpg`, restic/borg, encrypted storage). Passphrase encryption (wrapping the whole zip) and signed backups are deferred, not rejected. | Yes |
| D4 | Downloading a backup needs the admin's password again (two-step ticket, 60 s, single use, bound to admin, session and file), like the other protected admin actions. Costs one extra prompt and about 50 lines. | Yes |
| D5 | Restore is **CLI only**, never an HTTP route or button; the admin page has no restore. | Yes |
| D6 | Add an optional `BACKUP_DIR` setting (default `DATA_DIR/backups`) so backups can go to a second volume or mount; without it, backups share the failure domain of the data. Validated at startup so it cannot point inside served, upload, 5etools or data-root paths. | Yes |
| D7 | Accept the small format deviation: a fourth zip entry `checksums.json` (last) beside `manifest.json`, `app.sqlite`, `uploads/`. Log it in `docs/PLAN.md`. | Yes |
| D8 | Restore deletes `index.sqlite`, so the first start after a restore rebuilds the whole reference index (seconds to minutes) instead of optimising a partial rebuild. | Yes |
| D9 | Scheduled backups (M3.5) stay in the stretch slot, off by default, with one catch-up run after downtime. The guide recommends enabling them: newer genuine backups are what protect against the passive flood case in D1. | Yes |
| D10 | A durable `DATA_DIR/restore-log.jsonl` (0600, append-only) records backups and restores, since container logs of one-off restores vanish. | Yes |

## 21. Open questions

1. **fflate streaming reader at level 1/6.** Shown correct on adversarial data only in the scratch experiment. The `compression === 8` gate is mandatory. If any content breaks the reader, plan B is a central-directory reader on `node:zlib`, which changes the reader, not the format.
2. **Exclusive-lock probe on unusual mounts** (Docker Desktop file sharing, NFS): behaviour unverified; documented as unsupported for restore.
3. **fflate and a single entry of 4 GiB or more** is untested; the design refuses such an entry rather than guessing (and caps restore at 4 GiB).
4. **Step-up UX (D4)** and the grant-admin dialog wording about DM secrets (B14) are for the Security Architect and UX to confirm.
5. **M4 purge** must respect `isRunning()` (section 4); M4's task text needs that line.
6. **Hand-run scripts that bypass `main.ts`** during a restore remain a documented residual (section 7.1, point 4).

Schema-comparison stability, previously an open question, is now a blocker test for M3.3 (section 19).
