# How to cut a release

This is the checklist for the maintainer who publishes a version. Pushing a tag `vX.Y.Z` is the only thing that
publishes anything: the workflow [`.github/workflows/release.yml`](../.github/workflows/release.yml) then tests the commit,
builds the Docker image for `linux/amd64` and `linux/arm64`, pushes it to GitHub Container Registry (GHCR) and creates
the GitHub Release. Nobody approves it in between, so everything below happens **before** you push the tag.

After reading this you can publish a release candidate, then the release, and you know how to take one back.

Jump to: [One-time GitHub setup](#one-time-github-setup) · [Gate checklist](#gate-checklist) ·
[Release steps](#release-steps) · [Release candidates and pre-releases](#release-candidates-and-pre-releases) ·
[What the workflow does](#what-the-workflow-does) · [If something goes wrong](#if-something-goes-wrong) ·
[The `latest` caveat](#the-latest-caveat)

## One-time GitHub setup

You do these once, in the GitHub web interface. The workflow cannot do them for you.

1. **Push `main` and make it the default branch.** The repository's local branch is `main`, but the remote may still
   have `master`. Push `main` first, then Settings > General > Default branch. The workflow refuses a tag whose commit
   is not on `origin/main`.
2. **Allow the actions** if you restricted Actions (Settings > Actions > General). The workflow only uses actions
   pinned by commit SHA (the list is in the workflow and in `.github/dependabot.yml`). Workflow permissions can stay at
   "Read repository contents"; the workflow asks for the extra rights it needs, only in the publish job.
3. **Add a tag protection rule for `v*`** (Settings > Rules > Rulesets, target "Tags", pattern `v*`, restrict
   creation to maintainers). Whoever can push a tag can publish an image under the project's name.
4. **Make the package public after the first publish.** GHCR creates the package `critical-notes` as private. Open your
   profile or organisation > Packages > `critical-notes` > Package settings > Change visibility > Public, so
   `docker compose pull` works without logging in. In the same place choose "Connect repository".
   The first release candidate is the right moment to do it (see below).

## Gate checklist

Do not tag until every line is true. Run the commands in a clean checkout of the commit you will tag.

- [ ] `pnpm -s typecheck && pnpm -s lint && pnpm -s test` passes.
- [ ] `pnpm build` passes, and the restore drill passes: `pnpm --filter @cn/server drill`.
- [ ] `pnpm e2e` passes (it needs the 5etools data clone: `pnpm data:clone`).
- [ ] The Docker image works on an empty volume. Build it (`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`),
      then run the browser tests against it with `E2E_BASE=http://localhost:3000 pnpm exec playwright test` (a fresh
      instance is required).
- [ ] An update works on real data: start the previous release's image on a volume with data, back up, switch to the
      new image (`docker compose up -d`) and check that the campaigns are there and `/api/health` shows the new version.
- [ ] The tasks in [PROJECT.md](PROJECT.md) section 5.7 for this release are done: penetration test (G1.1),
      accessibility pass (G1.2), documentation sweep (G1.3) and release certification (G1.4), with the owner's approval.
- [ ] Every item of PRD section 8 for the release has evidence, and nothing in the changelog claims work that is not done.
- [ ] README, [STATUS.md](STATUS.md) and the changelog describe what ships (new settings in the README table, new
      behaviour in the changelog).
- [ ] Any change that needs the reader to do something while updating (a new required setting, a manual step) is in the
      changelog under **Upgrade notes** and, if it is permanent, in the README "Updating" section.
- [ ] The CI workflow is green on the commit on `main`.

Note that the release workflow runs a shorter gate itself (typecheck, lint, test, build, restore drill, then a smoke
test of the image), without the browser tests. The browser tests are your job.

## Release steps

Replace `1.0.0` with your version. Use [semantic versioning](https://semver.org/): a breaking change to stored data or
to the configuration is a new major version, new features a minor version, fixes a patch version.

1. **Branch from the latest `main`**, for example `chore/release-1.0.0`.
2. **Set the version** in the root `package.json` and, to keep them equal, in the workspace packages. The build bakes
   the root version into the server, and the workflow fails if the tag differs from it.

   ```sh
   sed -i 's/"version": "1.0.0-dev"/"version": "1.0.0"/' package.json apps/*/package.json packages/*/package.json
   git diff --stat      # 7 files, one line each
   ```

   (Use the version you are replacing in the pattern; after the first release it is the previous release number.)
3. **Update `CHANGELOG.md`.**
   - Rename the heading `## [Unreleased]` to `## [1.0.0] - YYYY-MM-DD` (today's date). The heading must look exactly like
     that: `scripts/changelog-section.mjs` finds the section by the version in the brackets, and the workflow uses the
     text under it as the release notes.
   - Add a new, empty `## [Unreleased]` above it.
   - Delete the `RELEASE NOTE` comment at the top of the file (first release only).
   - Update the link references at the bottom: `[Unreleased]` compares the new tag with `main`, and the new version
     links to its tag, for example:

     ```
     [Unreleased]: https://github.com/Merilairon/critical-notes/compare/v1.0.0...HEAD
     [1.0.0]: https://github.com/Merilairon/critical-notes/releases/tag/v1.0.0
     ```

     (For versions after the first, `[1.1.0]` compares with `v1.0.0`: `.../compare/v1.0.0...v1.1.0`.)
   - Check the result. This is the exact command the workflow runs; it prints the release notes and exits 1 if the
     section is missing or empty:

     ```sh
     node scripts/changelog-section.mjs 1.0.0
     ```

   > The repository ships with the 1.0.0 entry drafted under `## [Unreleased]`, because the date is not known yet.
   > The workflow does **not** accept `[Unreleased]`: until you rename the heading, a tag fails in the first job
   > with `CHANGELOG.md has no "## [1.0.0]" section`.
4. **Commit and merge to `main`** through a pull request. Use a signed-off, conventional message
   (`git commit -s -m "chore: release 1.0.0"`, no co-author lines) and wait for CI.
5. **Tag that exact commit** on `main` and push the tag. Then the workflow starts.

   ```sh
   git switch main && git pull
   git log -1 --oneline               # is this the release commit?
   git tag -a v1.0.0 -m "Critical Notes 1.0.0"
   git push origin v1.0.0
   ```
6. **Watch the run** (Actions > Release). A full run takes a while because the arm64 image is built under emulation
   (the job allows 60 minutes).
7. **Check the result.**

   ```sh
   docker pull ghcr.io/merilairon/critical-notes:1.0.0
   docker run --rm -d --name cn-check -p 3999:3000 ghcr.io/merilairon/critical-notes:1.0.0
   curl http://localhost:3999/api/health        # {"ok":true,"version":"1.0.0"}
   docker rm -f cn-check
   ```

   Also open the GitHub Release (the notes are the changelog section), and check that the image shows both platforms
   (`docker buildx imagetools inspect ghcr.io/merilairon/critical-notes:1.0.0`).

## Release candidates and pre-releases

**Cut a release candidate first.** The `linux/arm64` build has never been run: the workflow has not run on GitHub yet, and
the arm64 half (Raspberry Pi and home servers) was only checked by reading the lockfile. The first tag is the real test.
Use `v1.0.0-rc.1` and do the steps above with these differences:

- The tag must match `^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`. A hyphen followed by letters, digits, dots or
  hyphens makes it a pre-release: `v1.0.0-rc.1`, `v1.0.0-rc.2`, `v1.1.0-beta.1`. Anything else (`v1.0`, `1.0.0`,
  `v1.0.0_rc1`) fails the first job.
- The root `package.json` version must be the same text without the `v`: `1.0.0-rc.1`. (The `sed` pattern in step 2
  needs the version you are replacing.)
- `CHANGELOG.md` needs its own section, `## [1.0.0-rc.1] - YYYY-MM-DD`. A short one is enough (what to test, and
  what has changed since the last candidate). Keep the `## [Unreleased]` draft of 1.0.0 in place; the final release
  renames it.
- A pre-release publishes **only** the tag `1.0.0-rc.1` and a GitHub pre-release. It does not move `1.0` or
  `latest`, so anyone on the default `CN_VERSION` is not affected.
- Try it: `CN_VERSION=1.0.0-rc.1 docker compose up -d`, on a Raspberry Pi or an arm64 machine too, and update from a
  previous build on a volume with data.
- When the pre-release is good, make the package public (above), fix what you found (a fix is a new `rc.N`), and then
  cut the final release: version `1.0.0`, the changelog section `## [1.0.0]`, tag `v1.0.0`.

## What the workflow does

On a pushed tag matching `v*`, in this order. Each job needs the one before it.

1. **verify**: the tag is `vX.Y.Z` or `vX.Y.Z-pre`; it equals the root `package.json` version; the tagged commit is on
   `origin/main`; and `node scripts/changelog-section.mjs X.Y.Z` finds a non-empty section.
2. **gate**: install with the lockfile, then typecheck, lint, test, build and the restore drill (the same steps as
   `ci.yml`). Node 24.15.0.
3. **publish**: builds the amd64 image and smoke tests it (it must start on an empty volume and answer `/api/health`
   with exactly this version), logs in to GHCR with the built-in `GITHUB_TOKEN`, pushes the multi-platform image
   (`linux/amd64`, `linux/arm64`) with provenance and SBOM attestations, and creates the GitHub Release titled
   "Critical Notes X.Y.Z" with the changelog section as its notes. Tags pushed: `X.Y.Z`, plus `X.Y` and `latest` for a
   stable version only. A pre-release gets a GitHub pre-release and its own tag only.

The workflow never rewrites the version. The tagged commit is exactly the commit that was tested.

## If something goes wrong

**The run failed in `verify` or `gate`.** Nothing was published. Delete the tag, fix the cause on `main` (a new commit,
perhaps a new version bump), and tag again.

```sh
git push --delete origin v1.0.0
git tag -d v1.0.0
```

**The run failed in `publish`.** Look at the step that failed.

- Before "Build and push": nothing was pushed. Delete the tag as above and fix it.
- After the push (only the GitHub Release step is missing, for example): the image exists. Use "Re-run failed jobs" on
  the run. If the Release was created, you will see an "already exists" error and you are done.

**A published version is bad.** Fix forward. Do not move or reuse a tag, and do not change the content of a published
version: people have pinned it, and the image's attestations refer to it.

1. Publish a fixed patch version (`1.0.1`) with a changelog entry that says what was wrong. That also moves `latest`
   and `1.0` to the fix.
2. Warn people: edit the bad GitHub Release and add a line to the top of its notes ("Do not use: backups made with
   it cannot be restored; update to 1.0.1"). You can also set it to a pre-release.
3. If it must not be pulled at all (it destroys data, or leaks something), delete the version in GHCR: Packages >
   `critical-notes` > Package settings > the version > Delete. Delete the tag in the same way as above. The
   multi-platform image is several versions in the list; delete the tagged one and the untagged ones next to it.
   Anyone who already pulled it keeps it, so say so in the Release.

If the bad version moved `latest`, the fixed release moves it back. Until it exists, tell people to pin the previous
version (`CN_VERSION=1.0.0` in `.env`).

**Rolling back an instance** is not a version switch. Migrations only go forward, so a database used by a newer version
is not safe for an older image. The way back is a restore of the backup that was made before the update (see
README > Updating). The release notes of a version that changes the database should say so.

## The `latest` caveat

`latest` and `X.Y` move to **whichever stable tag is pushed last**. The workflow has no guard that compares versions.
Pushing `v1.1.1` (a backport) after `v1.2.0` would point `latest` and `1.1` at the older release. Until a guard exists
(a known gap, see [STATUS.md](STATUS.md)):

- Tag releases in version order, and tag a backport only when you also mean to move `latest`; or
- publish a backport as a pre-release tag (`v1.1.1-backport.1`), which never moves `latest`; or
- afterwards, retag by hand: `docker buildx imagetools create -t ghcr.io/merilairon/critical-notes:latest ghcr.io/merilairon/critical-notes:1.2.0`
  (this needs `docker login ghcr.io` with a token that can write packages).

Users who want control pin the version with `CN_VERSION`, which this makes the recommended way to run it.
