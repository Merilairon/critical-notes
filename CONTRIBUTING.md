# Contributing to Critical Notes

Thanks for helping. This file gets you from a fresh checkout to a passing gate, and lists the rules a change
has to follow. For what the app does and how to run it, see [README.md](README.md); for how the pieces fit
together, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Set up

You need Node 24.15 or later, pnpm 11 (the `packageManager` field in `package.json` pins it) and git.

```sh
pnpm install
cp .env.example .env       # optional; the defaults work from the repository root
```

### The 5etools data

Critical Notes ships no game content. The reference, search and browser tests read two git repositories that
you clone yourself, into `./5etools-data/` (git-ignored):

```sh
pnpm data:clone            # both repos (SKIP_IMG=1 for the data only; the images are about 13 GB)
pnpm data:update           # later: pull the latest data
```

The data clone (`5etools-src`, about 1 GB) is enough for development and for the browser tests. Use the data
only for books you own; see the Licensing section of the README.

### Run it

```sh
pnpm dev                   # server on :3000 (tsx watch), web on :4200 (proxies /api and /img)
```

Open http://localhost:4200. The first visit asks you to create the admin account.

## The gate

Run this before every change goes in. It must pass:

```sh
pnpm -s typecheck && pnpm -s lint && pnpm -s test
```

If your change touches the UI, also run the browser tests. They build the app, start a server on a fresh
data folder and drive the system Chrome (set `CHROME_PATH` to use another one). They need the 5etools data
clone from above.

```sh
pnpm e2e         # all projects: desktop (1440 x 1000) and phone
pnpm e2e:phone   # only the phone project
```

The phone project (Task M6.5) runs `players.spec.ts` and `combat.spec.ts` with the player in an emulated phone
(390 x 844, touch, mobile user agent) plus the phone checks of `docs/design/phone-layout.md` (no sideways scroll,
header height, 44 px targets, 16 px fields, the menu's Sign out). It starts its own second server on port 3211 with
its own data folder, so its sign-ups do not count against the 8 per minute of the desktop run; keep ports 3210 and
3211 free. Add phone checks to those two specs inside `isPhone()` guards, using `e2e/phone-checks.ts`, and on a
phone open the app menu before you click Sign out. Emulation is not a device: iOS zoom, the notch and the on-screen
keyboard need a real phone. Against a running instance (`E2E_BASE`) the phone project needs a second fresh one in
`E2E_PHONE_BASE`.

Unit and API tests use a small invented fixture, not 5etools content, so the gate runs without the clone.

In CI the browser tests run only on a self-hosted runner that holds the clone (`.github/workflows/e2e.yml`, for
pull requests from this repository only, no artifacts). Runner setup: `docs/STATUS.md`, "Browser tests in CI".

## The rules

A change that breaks one of these is not merged.

- **Players never receive DM content.** Any endpoint that returns campaign content projects it for players
  and gets a sentinel string in `apps/server/test/visibility.test.ts` (a marker in DM-only content that the
  test asserts never appears in a player's response). MCP read tools are crawled by that test too.
- **GM-only UI.** New GM-only routes use `canActivate: [gmGuard]`; the server checks regardless.
- **Schema changes** go into both `apps/server/src/db/schema.ts` and `apps/server/src/db/schema.pg.ts`, then
  run `pnpm --filter @cn/server db:generate`. The parity test must pass.
- **No edition string comparisons** (`'2014'`, `'2024'`, `'classic'`, `'one'`) outside
  `packages/fivetools/src/ruleset` and `edition`. ESLint enforces it.
- **No raw HTML.** No `innerHTML`, no `bypassSecurityTrust*`. A lint guard enforces it.
- **Angular.** Standalone components, signals, OnPush, zoneless. An `effect` that calls async code wraps it in
  `untracked`.
- **Data.** Never commit or upload `5etools-data/`, `var/`, or test traces and screenshots that contain rules
  text or art. This also goes for issues and pull requests.
- **Docs.** A change in behaviour updates `docs/STATUS.md`. A departure from the plan is logged in
  `docs/PLAN.md` (deviations) and raised with the maintainers.
- **Scope.** Do what the issue or task says. Ideas go in a separate issue, not into the diff.

## Branches and releases

- **`main`** is the default branch. It is always releasable and passes the gate.
- Work on short-lived branches cut from the latest `main`, named by type: `feat/user-auth`, `fix/login-redirect`,
  `docs/data-clone`, `chore/deps-update`. Rebase on `main` before you open the pull request, keep the branch small,
  and delete it after it merges. Never force-push `main`; on your own branch use `git push --force-with-lease`.
- Releases are tags on `main` named `vX.Y.Z` (semantic versioning), for example `v1.0.0`.

## Commits and sign-off

- **Conventional Commits.** Write messages as `type(scope): summary`, for example
  `fix(server): hide revealed secrets from players` or `docs: explain the data clone`.
- **No co-author lines.** Commits carry no `Co-Authored-By` trailers.
- **DCO sign-off.** Sign every commit with `git commit -s`, which adds a `Signed-off-by: Your Name <you@example.org>`
  line. That line states that you agree to the [Developer Certificate of Origin](https://developercertificate.org/):
  in short, that you wrote the change or have the right to submit it under the project's license, and that you
  understand the contribution is public and kept on record. There is no CLA, and you keep your copyright.
  Contributions are accepted under the project's license, the [Apache License 2.0](LICENSE). If you forgot
  the sign-off, `git commit --amend -s` fixes the last commit, and `git rebase --signoff <base>` fixes a
  series.

## Pull requests

1. Keep the change small and on one topic.
2. Run the gate (and `pnpm e2e` for UI changes) and fix what fails.
3. Fill in the pull request template, including the checklist.

## Reporting problems

- Bugs and feature ideas: open an issue with the template. Describe the problem in your own words; never paste
  rules text or art from 5etools or any book.
- Security problems: do not open a public issue. Follow [SECURITY.md](SECURITY.md).
