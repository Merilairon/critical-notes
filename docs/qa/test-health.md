# Test health: the load-sensitive tests (H1.1)

Measured 2026-10-31 on a 16-core desktop with a steady unrelated load of about 2 to 5. "Quiet" = one `vitest run --project server` alone;
"loaded" = the same while a second full server run loops in the background (it was started by the owner of H1.1 and killed by pid afterwards).

## Causes

| Test | Cause | Evidence | Fix |
|---|---|---|---|
| `homebrew.test.ts` "keeps private sources private...", `mcp.test.ts` "writes homebrew, with validation", `transfer.test.ts` "imports as a new campaign..." (20 s timeouts) | The first homebrew entity save compiles the whole 5etools `brew-fast` JSON schema with ajv, lazily (`homebrewValidator()` in `src/homebrew/schema.ts`). That is CPU only: about 2.5 s alone, 6.6 s inside a quiet full run (16 test files compete), 14 to 19 s loaded. Each of the three files runs in its own fork, so each pays it, and it landed inside whichever test saved first. One slow `POST .../entities` of 16 s was seen in a loaded run, 4 s from the 20 s limit. | `SLOW 6611ms POST /api/homebrew/sources/.../entities` (quiet), tests 16.4 s, 15.7 s, 14.4 s (loaded) | `warmHomebrewValidator()` in `test/helpers.ts`, called in the `beforeAll` of the three files, hook budget `HOMEBREW_WARMUP_TIMEOUT` (90 s, reason: one-time compile that is 16 s under load; previously 30 s hook). The tests now take 0.1 to 0.6 s even loaded. No production change. |
| `backup-routes.test.ts` "a stalled reader is cut off after the idle time" | Was a real 200 ms idle timer firing while setup (a password hash per ticket) was still running. Already fixed before this task in 74cd422: the test records the watchdog callbacks and fires them itself. | 0.17 s quiet, 0.6 s loaded, 7 loaded and quiet runs, no failure | none needed; not reproducible |
| `restore-crash.test.ts` "resumes to a complete restore from every point" (22 s quiet, 45 to 48 s loaded) | Not a flake in the current code: it is 23 sequential points, each spawns a `node --import tsx` child that loads the whole admin CLI (about 0.5 s CPU alone, 1.5 s for `done:finish`). The test timeout is 240 s, so loaded it keeps a 5x margin. The slowness scales with CPU load only. | per-point laps: spawn 0.5 s, in-process rerun 0.03 s (quiet) | no change; margin recorded here. If it ever fails, the first thing to look at is the point that was running (`killed at <point>` is in the assertion message). |

## The `pnpm e2e` run that timed out (I3.3)

Cause not found. The run was not kept: `playwright-report/` and `test-results/` are overwritten by every run (the ones on disk are from 2026-10-27, passing),
and the config has `workers: 1` with a 60 s test timeout, so "many specs timing out after about a minute" means every spec in a row hit the 60 s limit, which points at
one shared stall (the bundled server or Chrome stopped answering, or the machine was suspended or starved) rather than at one spec.
Nothing in the repository tells which. Next time, keep `playwright-report/`, `test-results/*/trace.zip` and the server stdout (do not set `E2E_NO_ARTIFACTS`),
and check `dmesg`/`journalctl` for memory pressure at that time. Not guessed further.

## Rule

A test that needs a one-time expensive setup does it in `beforeAll` with a written budget; a test body never carries it.

## Verification (QA, 2026-10-31)

Run in `.wt/h1-1` at 6425e07, 16 cores, with a second `pnpm exec vitest run --project server` looping in the background for the whole time
(unrelated desktop load of about 9 at the start). `uptime` before: load 9.22, 20.76, 18.09; after: 25.23, 26.51, 21.98 (21:37 to 21:44).

| Run | `pnpm -s test` exit | Server project | Web project | Wall |
|---|---|---|---|---|
| 1 | 0 | 58 files, 1003 passed, 1 skipped, 54.3 s | 50 files, 550 passed, 12.1 s | 87 s |
| 2 | 0 | 58 files, 1003 passed, 1 skipped, 52.4 s | 50 files, 550 passed, 12.4 s | 72 s |
| 3 | 0 | 58 files, 1003 passed, 1 skipped, 54.4 s | 50 files, 550 passed, 12.3 s | 83 s |
| 4 | 0 | 58 files, 1003 passed, 1 skipped, 56.5 s | 50 files, 550 passed, 17.4 s | 81 s |
| 5 | 0 | 58 files, 1003 passed, 1 skipped, 50.9 s | 50 files, 550 passed, 11.3 s | 76 s |

Load average at the end of each run: 24.7, 22.8, 28.4, 27.3, 25.2. 5 of 5 green.

Negative control (the five files only, same machine, load about 20, run once each, sequentially): the tests of the old test tree (981b000) against the fixed tree (6425e07).

| Test | Old tests | Fixed tests |
|---|---|---|
| homebrew "keeps private sources private..." | 10.7 s | 0.33 s |
| transfer "imports as a new campaign..." | 10.5 s | 0.37 s |
| mcp "writes homebrew, with validation" | 11.0 s | 0.26 s |
| backup-routes "a stalled reader is cut off..." | 0.50 s | 0.30 s |
| restore-crash "resumes to a complete restore from every point" | 26.9 s | 25.9 s |

So the fix, not luck, removed the 10+ s homebrew/transfer/mcp cost from the test bodies (it moved to the 90 s `beforeAll`).

Caveat: H1.1 is only partly resolved.
- The three homebrew-schema flakes have a measured cause and a measured effect.
- The old tests also passed in the control (10 to 11 s is under the 20 s limit at this load), so the original failure itself was not reproduced here; the evidence is the margin, not a red run.
- `restore-crash` was never reproduced as a failure; no change was made, and it still takes 26 s under load (limit 240 s). The cause of any earlier failure is unknown.
- The I3.3 e2e timeout cause is not found, and `pnpm e2e` was not part of these five runs.
- The `backup-routes` "refuses to start on an invalid BACKUP_DIR" test takes 7 to 9 s under load in both trees; it is not a listed flake, but it uses a fraction of its margin worth watching.
- Five green runs on one machine and one afternoon show the margin, not that flakes are gone.
