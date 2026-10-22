# Release certification: Critical Notes 1.0

Task G1.4. Date: 2026-10-22. Assessor: Reality Checker. Commit under test: `7a795a6` plus the uncommitted working tree
(G1.1 F25 fix in `fetch-url.ts`, G1.2 accessibility fixes in `apps/web`, G1.3 documentation). Version in
`package.json`: `1.0.0-dev`.

**This report does not approve the release. That decision belongs to the owner (decision D3).**

## Verdict: NEEDS WORK

Update (re-verification after the owner installed buildx 0.38.1, and after the orchestrator fixed the phone combat
regression). Both original blockers are closed on the evidence below. The verdict stays NEEDS WORK because the
remaining items are release-process steps that cannot be done before a tag. They are not defects in the build.

### Blockers now (what stops a tag)

1. **Nothing has run on GitHub and nothing is published.** No tag, no release candidate, no CI run, no GHCR image.
   So these are unproven: the `ci.yml`/`release.yml` workflows, the restore drill in CI, `docker compose pull` upgrade,
   the multi-platform (`linux/arm64`) build, and the update-on-real-data check. Cut `1.0.0-rc.1` to prove them.
2. **Release text still reads pre-release:** `SECURITY.md:19` "Critical Notes is alpha"; `README.md:54` "No published
   release yet..."; versions `1.0.0-dev`; changelog heading `## [Unreleased]` with the `RELEASE NOTE` comment.
3. **Owner approval (D3) is not given**, and the working tree is uncommitted.
4. The full `pnpm e2e` after the fix was run by the orchestrator, not by me (my own full run, below, failed before the fix). My post-fix evidence is the browser suite against the Docker image (99 passed, 8 skipped). Re-run `pnpm e2e` in a clean checkout of the commit to tag.

### Closed since the first version of this report

- Former blocker 1 (`combat.spec.ts:58` phone failure from the skip link): reported fixed by the orchestrator
  (`pnpm e2e` 99 passed / 8 skipped, phone 29/29). I observed the same fix working in the Docker run below
  (99 passed, 8 skipped, 0 failed, phone project included). I did not read the fix itself.
- Former blocker 2 (Docker image from the shipped Dockerfile): see "Docker re-verification".

### Docker re-verification (shipped Dockerfile, buildx 0.38.1)

| Step | Command | Result |
|---|---|---|
| Build | `docker build -t cn-cert:real .` | Exit 0 (BuildKit, multi-stage, the real `Dockerfile`; built for the host platform amd64 only). |
| Compose build | `docker compose -f docker-compose.yml -f docker-compose.build.yml build` | Exit 0, `Image critical-notes:local Built`. |
| Start on empty volumes | two `docker run` containers of `critical-notes:local`, ports 3410 and 3411, no app-data volume, 5etools clones mounted read-only | Both `GET /api/health` returned `{"ok":true,"version":"1.0.0-dev"}`. |
| Browser suite against the image | `E2E_BASE=http://localhost:3410 E2E_PHONE_BASE=http://localhost:3411 E2E_NO_ARTIFACTS=1 pnpm exec playwright test` | **99 passed, 8 skipped, 0 failed** (exit 0). Desktop and phone projects both ran; the 8 skips are the phone-only tests inside the desktop project, by design. |
| Cleanup | containers removed, `docker image prune -af`, `ss -ltn` | No containers or images left (Docker had 0 images before I started); nothing listening on 3410/3411. |

Not covered by this: `linux/arm64` (not built; needs buildx multi-platform with emulation or an arm64 host), the
`release.yml` workflow itself, upgrade over a volume with data from an earlier image, the `HEALTHCHECK` over time.

## Evidence: commands run

| Run | Command | Result |
|---|---|---|
| Gate | `pnpm -s typecheck && pnpm -s lint && pnpm -s test` | Exit 0. Typecheck clean (all packages, `ngc`, `tsc -p e2e`). `check-no-raw-html: ok`. Vitest: 46 files, 792 tests passed. Web (`ng test`): 28 files, 241 tests passed. |
| Restore drill | `pnpm --filter @cn/server drill` | `[drill] PASSED` (backup while editing, wipe, `restore --check`, restore, campaign/page/image back, search index rebuilt, work after backup gone). |
| Focused server tests | `vitest run` on `admin`, `reset`, `trash`, `backup-restore`, `admin-cli` | 5 files, 95 tests passed. |
| Full browser run (my run BEFORE the fix; the orchestrator's post-fix run: 99 passed, 8 skipped, phone 29/29) | `pnpm e2e` (builds, then desktop on 3210 and phone on 3211) | **FAILED then**: 93 passed, 8 skipped, 1 failed, 5 did not run (exit 1). Failure above. The 8 skips are the `players.spec.ts` "as a player on a phone" tests in the `app` project (`test.skip(() => !isPhone())`, by design). |
| Regression check, trash | `trash.spec.ts:95, 104, 118, 141` | All 4 passed (Undo, Restore, Delete permanently, player has no Trash). |
| Regression check, page tree / editor / campaign | `campaign.spec.ts` (7 tests), `editor.spec.ts` (7 tests, including Ctrl+K), `homebrew.spec.ts`, `templates.spec.ts`, `account.spec.ts`, `admin.spec.ts` | All passed. |
| Old Search name | `grep -rn "Search (Ctrl" e2e apps/web/src` | No matches. No spec selects the old name. |
| Phone project | `phone-setup` and `phone` in the same run | `players.spec.ts` 19/19 passed in the phone project (7 screens with the 44 px/16 px/no-scroll sweep, drawer and menu). `combat.spec.ts` phone: 3 passed, 1 FAILED (:58), 5 did not run. |
| Docker, real Dockerfile (first attempt) | `docker build .`; `docker compose ... build` | Failed then: buildx missing. Superseded by the re-verification above (both exit 0). |
| Docker, scratch Dockerfile (classic, first attempt, superseded) | build, then `E2E_BASE=http://localhost:3210 E2E_PHONE_BASE=http://localhost:3211 pnpm exec playwright test` against two containers | Image built. 93 passed, 13 skipped, 1 failed (`combat.spec.ts:58`, same cause). Containers and image removed afterwards. |
| Ports | `ss -ltn` after the runs | Nothing listening on 3210/3211. Only e2e-config ports were used. |

The bundled server in the e2e run is a fresh `pnpm build`, so it includes the uncommitted G1.2 and F25 changes. The
`test-results/` and `playwright-report/` folders are overwritten by that run (they were already ignored).

## PRD section 8 "Done when" criteria

| ID | Criterion (PRD wording) | Status | Evidence |
|---|---|---|---|
| M1 | The repository states the license | PASS | `LICENSE` is the Apache License 2.0; `package.json` `"license": "Apache-2.0"`; README "Licensing" section (line 880) names Apache-2.0 and `Copyright (c) 2026 Merilairon`; `CONTRIBUTING.md` exists. |
| M1 | The README's content notice (WotC, SRD CC-BY-4.0, bring your own data) is reviewed | PASS (document check only) | README lines 880-899 state no game content ships, WotC, CC-BY-4.0 and the 5etools licence. "Reviewed" is a human legal judgement: I read it for presence and consistency, not for legal sufficiency. `THIRD_PARTY_NOTICES.md` is present. |
| M2 | No account can end up permanently locked | PASS | Admin reset link (`e2e/admin.spec.ts:139`, passed), disable/enable (:169), token revoke on reset (:209), password change and sign-out of other sessions (:221). CLI `node admin.mjs reset-link <user>` documented in README (lines 190-208) and tested in `apps/server/test/admin-cli.test.ts`. Last-admin guard: `admin.test.ts` plus pentest A8 (live: sole admin cannot demote, disable or delete self; race of two admins leaves one). |
| M2 | Deleting a user keeps their campaigns' content | PASS | `e2e/admin.spec.ts:262` (campaign with a member is transferred), `admin.test.ts` (transfer or archive rules, decision D5). |
| M3 | A backup taken while users edit restores to a working instance with the same users, campaigns, homebrew, templates and images | PASS | `pnpm --filter @cn/server drill` PASSED (run today, output above), covering backup-while-editing, users/login, campaign, page, byte-identical image and index rebuild. `backup-restore.test.ts`, `restore-*.test.ts`, `backup-*.test.ts` pass in the 792. Homebrew and templates are covered by the unit tests rather than the drill; I did not read each assertion. |
| M3 | Restore procedure tested in CI | NOT VERIFIED | `.github/workflows/ci.yml` runs the drill (line 52-53), but no workflow has ever run on GitHub (no tags; STATUS says "Never run on GitHub"). It passes locally only. |
| M4 | A deleted page tree can be restored from the UI with links, backlinks and search intact | PASS | `e2e/trash.spec.ts:95` (Undo), `:104` (Restore from Trash view), `:118` (permanent delete), `:141` (player blocked); `apps/server/test/trash.test.ts:94` "brings back subpages, backlinks, references and search rows". Templates: `e2e/templates.spec.ts:114` (restore and permanent delete). All passed in the full run. |
| M5 | A host can pin a version, read what changed, and upgrade with `docker compose pull && docker compose up -d` | NOT VERIFIED | There is no published image, no tag (`git tag` is empty), no GitHub release run, and the package is unpublished. `CN_VERSION` pinning and the changelog exist on paper (`docker-compose.yml`, `CHANGELOG.md`); the pull-and-upgrade path cannot be exercised. The upgrade-on-real-data check in RELEASE.md was not run. |
| M5 | CI runs the gate on every change; browser tests on a runner with a 5etools clone | NOT VERIFIED | `ci.yml`, `e2e.yml`, `release.yml` exist. None has run on GitHub. `e2e.yml` is inactive until a self-hosted runner is registered (owner decision D4, still Open). |
| M5 | Semantic versions, a changelog, a published Docker image per release, upgrade notes | FAIL (as of today) | Version is `1.0.0-dev`; the changelog heading is `## [Unreleased]` (the release workflow only reads `## [1.0.0] - date`); no published image. The changelog has an "Upgrade notes" subsection. This is expected before a tag, but it is not done. |
| M6 | The player flows (join by invite, shared pages, own character, inventory, combat player screen, dice) pass a browser test at phone width | PASS (emulation only, as scoped) | Post-fix: phone project 99 passed / 0 failed in my Docker run, 29/29 reported by the orchestrator. Owner approved the emulation-only scope and the 29 px dice target. Before the fix (my first run) the result was:  invite join, shared page, own character, inventory, members, account and drawer all pass (`players.spec.ts` phone, 19/19). The combat player screen test `combat.spec.ts:58` (phone) **fails** and five later combat/loot tests did not run, so the combat player screen and dice-at-the-table flow have no passing phone evidence. Cause: the G1.2 skip link (blocker 1). Dice on a phone is also only emulation, see owner decisions. |

| Gate item | The Docker image works on an empty volume | PASS (amd64) | Re-verification above. arm64 NOT VERIFIED. |

Summary: 8 PASS rows (M6 and the Docker image now included), 3 NOT VERIFIED rows (restore in CI, upgrade via `docker compose pull`, CI/browser tests on a runner: D4 was skipped by the owner, so the browser tests stay local-only by decision), 1 FAIL row (M5 versions, changelog heading and published image: expected before a tag, not done).

## Security and accessibility reports

### `docs/security/pentest-1.0.md`
- No open High or Critical finding in F1-F25. F22-F24 informational, F25 Low and fixed (uncommitted).
- Limits the report states, and which I repeat rather than accept as "tested": loot award and the player inventory
  under hidden items; reference routes and homebrew file import as a player; redirect-to-private and DNS rebinding
  live (code review only, no redirect unit test); MCP write tools never called; A6-A8 used one DM-only sentinel set
  and a hidden-combatant tracker, a visible combatant surviving the filter is covered by a unit test only.
- A6-A9 were run by the owner/orchestrator, not the pentester (the pentester's agent was halted by tooling). The
  reset-link `Host` probe was refused earlier by the origin check, so Host-header influence on the link is a code
  review only.
- The F25 fix is not re-run live; unit tests and the gate pass (the `homebrew.test.ts` run is inside my 792).
- Open backlog: F22 (campaign list counts hidden pages), F23 (tracker name visible to players), F24 (no "sign out other sessions").
- Scope was one local instance, not the Docker image.

### `docs/qa/a11y-1.0.md`
- Five new screens (Account, Users, Backups, Reset, Trash) pass axe (0 violations) and keyboard checks at 1280, 390 and 320 px, light and dark.
- Limits: no real screen reader; no real device, forced-colors, reduced-motion or voice-control run; Trash aged-item style not seeded.
- Field-border contrast fix is **partial**: `border-line` inputs remain on settings, NPC, statblock, homebrew editors, the command palette, reference list and editor atoms (1.4.11, Serious outside the five screens).
- Open: no focus or announcement on route change (app-wide); the editor and content views (M6.4 backlog list) were not audited.
- The report asked G1.4 to confirm no spec depends on the old Search name or the `role="group"` tree: confirmed, none does. But the same G1.2 change (skip link) **did** break `combat.spec.ts:58` (blocker 1), which the G1.2 report did not predict.

## Open release-gate items (docs/RELEASE.md "Gate checklist")

Unchecked in the file today, with my status:

| # | Item | Status |
|---|---|---|
| 1 | `pnpm -s typecheck && pnpm -s lint && pnpm -s test` passes | Done in this run (box still unticked in RELEASE.md; must be run in a clean checkout of the tagged commit). |
| 2 | `pnpm build` passes and the restore drill passes | Done in this run (build inside `pnpm e2e`; drill PASSED). Not in a clean checkout. |
| 3 | `pnpm e2e` passes | **Not met**: 1 failed, 5 did not run. |
| 4 | Docker image works on an empty volume (compose build, then browser tests against it) | **Not met / NOT VERIFIED**: buildx missing on this host; scratch-Dockerfile run also hit the :58 failure. |
| 5 | An update works on real data (previous image, backup, switch, `/api/health` shows the new version) | Not done. There is no previous release image to update from. |
| 6 | `SECURITY.md` finished: public contact, no TODO, and "Critical Notes is alpha" reworded | Not done. `SECURITY.md:19` still says "Critical Notes is alpha". The contact is `baetens-jan@hotmail.com` (line 9); the owner must confirm that is the public address wanted. No TODO found. |
| 7 | Stale README text removed after the first publish | Not done (cannot be until a publish): "No published release yet, or the pull is denied..." at `README.md:54` (and the "Image and versions" section). |
| 8 | GHCR package public; anonymous `docker pull` tested | Not done (nothing published). |
| 9 | After rc.1 and G1.1-G1.4, re-read every changelog claim; keep the `linux/arm64` claim only if rc.1 ran on arm64 | Not done. The arm64 build has never run anywhere. The wording in `CHANGELOG.md:80` and `README.md:69` is already conditional ("untested until the first release candidate has run on an arm64 machine"). |
| 10 | G1.1-G1.4 done, with the owner's approval | G1.1, G1.2, G1.3 ticked in PROJECT.md; G1.4 is this report; owner approval (D3) is Open. |
| 11 | Every PRD section 8 item has evidence, or is listed in the changelog as not included | Not met: see the table (M5 and M6 rows). |
| 12 | README, STATUS and changelog describe what ships | G1.3 did the sweep; STATUS lines for G1.1, G1.2 and G1.4 must be updated when this lands (per G1.3's note). The changelog must not claim the phone combat screen passes while `combat.spec.ts:58` fails. |
| 13 | Upgrade notes in the changelog and README "Updating" | Present in the draft; unchecked pending the release. |
| 14 | CI workflow green on the commit on `main` | Not done. No workflow run has ever happened. The remote default branch was to be switched from `master` to `main` (RELEASE.md one-time setup 1; not verified here). |

Release-mechanics items (all expected, none done): version `1.0.0-dev` is not `1.0.0` in the 7 `package.json` files;
`CHANGELOG.md` still has `## [Unreleased]`, the `RELEASE NOTE` comment, and no comparison links; no release
candidate has been cut; no tag exists. The working tree is uncommitted (17 modified files plus `docs/qa/a11y-1.0.md`
and `docs/security/` untracked), so "the commit on `main`" does not yet exist.

## Owner decisions still open (docs/STATUS.md and PROJECT.md section 8)

| Decision | State | Effect on certification |
|---|---|---|
| D3: approval of the first commit and each release | Open | The release cannot be approved by this report. |
| D4: self-hosted runner with a 5etools clone for CI browser tests | Skipped by the owner (recorded); was Open; `e2e.yml` inactive, "never run on GitHub" | `pnpm e2e` stays a local-only gate. A regression like blocker 1 would not be caught in CI. |
| M6.4 desktop differences (wrapping reader title and editable title, read-only fields as plain text, inventory card list at every width, darker placeholders) | "Owner to accept", listed in STATUS | Not accepted on record. Needs a yes or a revert. |
| Phone coverage is emulation only | Decided as scoped (STATUS: certified as scoped; emulation only) | No iOS Safari input zoom, notch/safe area, on-screen keyboard, or real Android Chrome; also no dark mode, axe, widths 320/360/430, landscape or text-zoom automation at phone size. The changelog says so. |
| Inline dice roll target is 29 px high, not 44 | Open for the owner ("a design decision") | Dice on a phone is the one PRD M6 flow with a known sub-44 px target. The e2e sweep does not check it. |
| Editor formatting toolbar 21-34 px | Excluded in the sweep by name (`KNOWN_SMALL`) | Listed gap, not hidden. |
| Docker image on arm64 | Unverified | Needs an rc.1 on an arm64 machine. |

## What I did not test

- The real `Dockerfile` build, `linux/arm64`, and any upgrade-in-place from an earlier image.
- Anything on GitHub (CI, e2e, release workflows, GHCR visibility).
- Real devices, screen readers, forced-colors, reduced motion.
- The five phone combat tests that did not run after the :58 failure (`combat.spec.ts:78, 92, 101, 116, 129` in the phone project). The same five passed in the desktop `app` project in this run, which shows the app logic works, but not at phone width.
- A clean checkout run: everything ran in the working tree with uncommitted changes.

## Required before this can be re-assessed as CERTIFIED

1. (Done) Tab order fix and phone combat: closed. Gate re-run after the template move: typecheck, lint, 792 + 241 tests pass.
2. (Done for amd64) The real image builds with buildx and passes the browser suite on empty volumes. Still to do: arm64, and the update-on-real-data check once a previous image exists.
3. Cut `1.0.0-rc.1`, confirm the CI and release workflows actually run, test arm64, make the GHCR package public.
4. Owner: D3 (release approval) is the only open decision; D4, M6.4 differences, emulation-only phone and the 29 px dice target are recorded. Confirm the SECURITY.md contact.
5. Before the final tag: reword "alpha" in `SECURITY.md`, remove the README "No published release yet" lines, bump versions, rename the changelog heading, update the STATUS lines, and re-run `pnpm e2e` in a clean checkout.

**Verdict: NEEDS WORK (remaining: nothing published or run on GitHub, release text, owner approval). Re-assessment required after rc.1. Owner approval is not given by this report.**

## Update 2026-10-22 (after the first run): phone combat regression fixed

The blocker "`pnpm e2e` fails" is cleared. The G1.2 skip link sat outside `@if (!bare())` in `apps/web/src/app/app.html`, so it was the first tab stop on the bare table screen. It is now inside that block, so the combat player view again starts with "← Campaign" (phone-layout 6.7 and 9.6). Re-run by the orchestrator: `pnpm e2e:phone` 29 passed; `pnpm e2e` 99 passed, 8 skipped (the same figures as M6.5); typecheck and lint clean. The unit tests were re-run by the Reality Checker after the move: 792 + 241 passed, typecheck and lint clean.

Verdict is unchanged: **NEEDS WORK**. The Docker blocker named in this paragraph was closed by the buildx re-verification at the top of this report; see "Blockers now" there.

## Owner decisions 2026-10-22
- D4 (self-hosted runner): skipped. Browser tests stay a local gate; criterion "browser tests on a runner" is accepted as not applicable for 1.0.
- M6.4 desktop differences: approved. Phone coverage by emulation only: approved. 29 px inline dice target: approved.
- Still open: D3 (release approval), the SECURITY.md contact and "alpha" wording, the Docker image check, arm64, publishing and tagging.

## SECURITY.md (2026-10-22, owner)
Rewritten: private vulnerability reporting through the repository's Security tab only (the email address is removed), acknowledgement within 7 days, latest release only, "alpha" removed. Open: the repository setting "Private vulnerability reporting" must be enabled before the tag; otherwise the policy points at a button that does not exist.
