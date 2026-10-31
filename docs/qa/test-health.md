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
