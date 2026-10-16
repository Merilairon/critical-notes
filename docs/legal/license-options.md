# License options for Critical Notes

| | |
|---|---|
| Task | M1.1 in [PROJECT.md](../PROJECT.md); PRD §8 M1 and §12 |
| Date | 2026-10-16 |
| Status | Input for the owner's decision (M1.2). Nothing here chooses the license. |

**This is not legal advice.** It is a working brief by a compliance checker (an AI agent), built from public
license texts, the repository and the installed packages. It has not been reviewed by a lawyer. Statements about
Wizards of the Coast, the 5etools mirror and CC-BY-4.0 are the author's reading, not an opinion on which anyone
should rely. Before a public announcement, a hosted demo or an SRD-only mode (N11), get advice from a lawyer
who knows software and game-content licensing in your jurisdiction.

## 1. What the license covers, and what it cannot

The license applies to **this repository's own code and documents**. It does not touch the game content:

- Rules text, statblocks and art in 5etools-src and 5etools-img belong to Wizards of the Coast and the credited
  artists. No choice below grants or removes any right in them.
- The repository contains none of that content (checked: tests only use entity names; the 5etools folders are
  git-ignored and mounted at run time). Keep it that way, so that the license of the code is the only one that
  applies to what is published.
- Parts of `packages/fivetools` are adapted from MIT-licensed 5etools code (the edition matching table in
  `expand/items.ts`, the tag registry in `tags/registry.ts` from `Renderer.tag.*`, the source-name maps read from
  `parser.js`). Whatever license is chosen, the 5etools MIT notice must stay in
  [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). All three options below allow this.

Without any license file, the default is "all rights reserved": nobody may copy, modify or run-and-redistribute
the code. Every package here is `"private": true` with no `license` field. A public repository without a license
is therefore not open source.

## 2. The three options

| | MIT | Apache-2.0 | AGPL-3.0-only (or -or-later) |
|---|---|---|---|
| Type | Permissive | Permissive | Strong copyleft, with a network clause |
| Self-hosting for own use | Free | Free | Free; no obligation if you do not modify it |
| Closed-source fork or product | Allowed | Allowed | Not allowed: derived works stay AGPL |
| **Hosted fork (SaaS)** | Allowed, can stay private and closed | Allowed, can stay private and closed | Allowed, but section 13 requires offering the modified source to every user who interacts with it over a network |
| Patent grant | None stated | Explicit grant from each contributor; ends for a party who sues over the work | Explicit grant (section 11) |
| Notice duties for users | Keep copyright and license text | Keep license, copyright, and any NOTICE file; mark changed files | Keep notices; give source of the work and its modifications; license the whole under AGPL |
| Contributions | Inbound = outbound by convention (GitHub terms); no explicit clause | Section 5: contributions are under Apache-2.0 unless stated; clearest of the three | Same convention as MIT; copyright stays with each contributor |
| Later relicensing by the owner | Owner can issue newer versions under another license; contributed code can go into an AGPL or proprietary work (permissive) | Same | Hardest: moving to a more permissive license needs every contributor's consent (or a CLA from the start) |
| Fit with this project's dependencies | Full | Full | Full (see section 3) |
| Reader's effort | Shortest text, universally known | Longer, well known to companies | Long; some companies and contributors avoid AGPL code entirely |

### MIT

- **For:** maximum adoption and the least friction (PRD §12 already says so). Same license as 5etools and
  5etools-utils, so the licensing story is simple for users and for a community that already uses MIT data tools.
- **Against:** anyone can host a closed, paid fork without giving anything back, and can use the name's
  goodwill (the license grants no trademark rights, but also no protection). No patent clause.
- **Fits when:** the goal is a community tool where you do not mind commercial reuse.

### Apache-2.0

- **For:** MIT's freedom plus an explicit patent grant and a clear contribution clause (section 5). Three of
  the project's own dependencies (MCP SDK, drizzle-orm, uuidv7) already use it, so the NOTICE handling is a
  known quantity. It is the choice that most often satisfies a company's legal team.
- **Against:** same as MIT regarding closed hosted forks. Slightly more paperwork: a NOTICE file (if you add
  one), and changed files should carry notices. Not compatible with GPLv2-only code (no such dependency exists).
- **Fits when:** you want permissive terms and care about patents or about contributions from companies.

### AGPL-3.0

- **For:** the one option that answers the PRD's "keeps hosted forks open" worry. If someone modifies Critical
  Notes and runs it as a service, users of that service can get the source. Self-hosters who run it unmodified
  are unaffected. A closed commercial fork is blocked.
- **Against:**
  - Fewer adopters and contributors; some companies ban AGPL software, and some hosting platforms and
    distributions avoid it.
  - Section 13 only triggers for **modified** versions. An unmodified hosted copy owes nothing beyond the
    license text, so AGPL does not stop a competitor from hosting the original.
  - It does not protect the data model or the idea, only the code as written.
  - Relicensing later is hard without a CLA, and a CLA discourages contributors. Without a CLA the owner cannot
    offer a separate commercial license (dual licensing).
  - Operators who add a small patch (a theme, a config tweak) must publish it; this surprises hobbyists.
  - The owner must provide a "source" link in the running app for modified versions; a footer link is a small
    feature to add.
- **Fits when:** keeping hosted forks open matters more than the widest adoption.

### Hosted forks, contributions, dependencies in one line each

- **Hosted forks:** only AGPL obliges a modified hosted fork to publish its changes. MIT and Apache-2.0 do not.
- **Contributions:** with any of the three, contributors keep their copyright and license their work under the
  project license. Apache-2.0 says so in the license itself; for MIT and AGPL the usual practice (GitHub's terms,
  or a DCO sign-off in CONTRIBUTING, task M1.4) does the same. A CLA is only needed if the owner wants the right
  to relicense or dual-license; it is not needed for MIT or Apache-2.0.
- **Dependencies:** no dependency blocks any of the three (section 3).

## 3. Dependency license check

Command: `pnpm licenses list --prod` (pnpm 11.0.9, run 2026-10-16, workspace-wide). It reported 292 package
entries: **no GPL, AGPL, SSPL, proprietary, unlicensed or "UNKNOWN" license**.

| License | Entries | Remarks |
|---|---|---|
| MIT | 248 | Angular, TipTap, Hono, zod, better-sqlite3, @node-rs/argon2, 5etools-utils and most others |
| Apache-2.0 | 20 | sharp, @img/sharp-linux-x64, drizzle-orm, @modelcontextprotocol/server and core, rxjs, uuidv7, detect-libc, and the @eslint and @humanfs groups (tooling) |
| BSD-2-Clause / BSD-3-Clause | 10 / 3 | e.g. fast-uri, esquery, source-map-js |
| ISC | 6 | |
| 0BSD, CC0-1.0, BlueOak-1.0.0, (MIT OR CC0-1.0) | 1 each | tslib, fractional-indexing, minimatch, type-fest |
| LGPL-3.0-or-later | 1 | `@img/sharp-libvips-linux-x64` (libvips) |

Notes:

- The workspace-wide listing includes some tooling that is not in the server bundle (for example the @eslint
  packages). What the **server bundle** contains is 76 packages: 70 MIT, 4 Apache-2.0 (MCP SDK core and server,
  drizzle-orm, uuidv7), 1 BSD-3-Clause (fast-uri) and 1 CC0-1.0 (fractional-indexing). This is the list the new
  generated file covers (section 5).
- **Compatibility with each option.** MIT, BSD, ISC, 0BSD, CC0 and BlueOak are permissive and combine with MIT,
  Apache-2.0 and AGPL-3.0 alike. Apache-2.0 code can be combined into an AGPL-3.0 (version 3) work; the combined
  work is then AGPL. The one pairing Apache-2.0 cannot do is GPLv2-only, which does not occur.
- **libvips (LGPL-3.0-or-later).** It is not linked into our code: sharp loads it as a separate shared library
  from its own npm package, the user can replace it, and the license text and source links travel with the
  package. This is the ordinary LGPL pattern and does not change the choice. The package bundles about 25
  libraries with their own licenses (MPL-1.1 for cairo, BSD, MIT, and the AOM patent license among them);
  these are listed in the package README and are shipped unmodified in the image.
- **Two packages ship no license file in their npm tarball:** `@hono/zod-validator` (declares MIT) and
  `drizzle-orm` (declares Apache-2.0); plus `5etools-utils` (declares MIT, ships no file; it stays outside the
  bundle). The declared license is clear, but the copyright line is missing from the shipped artifact. The
  generator notes this and, for Apache-2.0, appends the standard text.
- **The MCP SDK is mid-relicense.** Its LICENSE file says the project is moving from MIT to Apache-2.0 and that
  some contributions remain MIT. Both are permissive; the full text is reproduced in the generated file.
- No bundled package ships an Apache-2.0 NOTICE file (checked in the installed packages), so nothing has to be
  copied beyond the license texts. The generator will pick one up if a future dependency adds it.
- Not checked: transitive licenses inside the web app's build beyond what Angular lists in
  `3rdpartylicenses.txt`; fonts, icons and images used by the web app (no audit was part of this task).

## 4. README "Licensing" section: claim by claim

The README is not edited here (M1.3 does that). Verdicts for the text as of commit `c817055`.

| # | Claim | Verdict |
|---|---|---|
| 1 | Rules text, statblocks and other content in 5etools, and the art in 5etools-img, belong to Wizards of the Coast and the credited artists | **Correct** as a summary. It is the owner's position, not a verified ownership chain, and the 5etools repos are a fan mirror. Keep wording as "belong to ... or their rights holders". |
| 2 | Portions from SRD 5.1 and 5.2 are available under CC-BY-4.0 | **Correct.** Wizards published SRD 5.1 and SRD 5.2 under CC-BY-4.0. Add: only the SRD text is covered, not everything in 5etools that resembles it, and reuse needs the attribution statement from the SRD. |
| 3 | "Critical Notes does not contain, copy or redistribute any of it: it reads the clone on your own machine while it runs" | **Partly incorrect; correct it.** The repository contains none of it (true). But the app **does make a copy**: `DATA_DIR/index.sqlite` holds every 5etools entity after inheritance is resolved, with a full-text index (ARCHITECTURE.md). It is rebuildable and stays in the operator's data folder, but "only reads" understates it. Also, "on your own machine" is not always so: the server may be a VPS or a home server, and it **serves** the content and images over HTTP to invited players, and via MCP to whichever AI service the user connects. Suggested wording: the project distributes none of it; the app builds a local index from the user's clone and shows it to the people the host invites. |
| 4 | "Use it for books you own." | **Correct as advice**, but it is guidance, not a license from Wizards, and the app does not verify ownership. Keep, and do not present it as granting rights. |
| 5 | "Do not publish a server with this content to the public." | **Correct and consistent** with PRD §12 (no hosted demo or SRD-only mode before legal advice). Consider adding that sharing with a private table of friends is the intended use, which is the grey area the owner should be aware of. |
| 6 | The 5etools code is MIT-licensed (Copyright (c) 2017 TheGiddyLimit and contributors) | **Correct.** Verified against `LICENSE.md` in the local 5etools-src clone (not modified). |
| 7 | The data handling in `packages/fivetools` "follows how 5etools works" | **Correct but vague.** Some parts are adapted from 5etools source (see section 1), so the README should say "adapted from" and keep the MIT notice. THIRD_PARTY_NOTICES.md now says "adapted from" and names the edition table, the tag registry and the source-name maps. |
| 8 | 5etools-utils (MIT) supplies the homebrew schemas and the edition source lists at run time | **Correct** (`"license": "MIT"` in its package.json, version 0.17.21). Add that the npm package ships no license file, so the image has no copyright line for it. |
| 9 | Third-party code (dependencies, the bundled AI agent definitions, the 5etools license notice) is in THIRD_PARTY_NOTICES.md | **Correct**, with these fixes made to THIRD_PARTY_NOTICES.md in this task: the claim that 5etools-utils is "installed with its own license file" was wrong and is corrected; the "not produced yet" paragraph is replaced now that the generated file exists; the agent MIT notice (Copyright (c) 2025 AgentLand Contributors) was kept as is and not re-checked against upstream (open question 7). |
| 10 | "Your data stays in your DATA_DIR; exports are yours." | **Partly incorrect.** DATA_DIR is correct. "Exports are yours" is true for the user's own notes and homebrew, but an export that contains 5etools text or art does not become the user's to relicense. Suggested wording: your notes and homebrew are yours; exports may include third-party content, which stays under its own terms. |
| 11 | "This project's own license has not been chosen yet." | **Correct today.** It is replaced in M1.3. Until then the code is all rights reserved (see section 1). |

**DATA_NOTES.md §9** (reviewed, as the task requires). Bullets 1 and 2 (5etools code and 5etools-utils MIT;
content and art owned by WotC and artists; SRD 5.1/5.2 CC-BY-4.0): **correct**. Bullet 3, "never copies...
It reads a user-supplied local clone at runtime": **overstated**, the same as README claim 3, because the app
builds the derived `index.sqlite` copy and shows the content to invited players. **Corrected in DATA_NOTES.md in
this task.**

Missing from the README, for M1.3 to consider: no affiliation or endorsement statement (the product name and
README use "D&D"; use the name descriptively and do not use Wizards logos or trade dress, and check Wizards'
current Fan Content Policy and trademark terms; I did not verify their current text); and a sentence that the
chosen license covers only this repository's own code.

## 5. THIRD_PARTY_NOTICES.md review and the generated license file

**Reviewed and changed** ([THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)):

- Section 2: 5etools-utils paragraph corrected (no license file ships with the package).
- Section 3: "Where the full license texts are" now names the generated file; the closing paragraph records the
  packages without a license file, the (empty) NOTICE result and the MCP SDK relicense.
- Unchanged and still accurate: the 35 agent files list (this task did not re-diff the upstream commit; the
  file count and names match `.claude/agents/`), the 5etools MIT text, the license table (the Apache-2.0 row
  lists sharp, @img/sharp-linux-x64, drizzle-orm, the MCP packages, rxjs and uuidv7, which agrees with the
  scan; add detect-libc if you want completeness).

**Added to the build:**

- `apps/server/scripts/licenses.mjs` (new): from esbuild's metafile it finds every npm package that ended up in
  the bundle, reads its LICENSE/LICENCE/COPYING/NOTICE files and writes them with name, version, declared
  license and source URL to `apps/server/dist/THIRD_PARTY_LICENSES.txt` (about 148 KB, 76 packages). Packages
  with no license file are named, and Apache-2.0 ones get the standard text. The build prints a warning listing
  them.
- `apps/server/scripts/build.mjs`: turns on esbuild's `metafile` and calls the generator after bundling.
- `Dockerfile`: copies the file to `/app/licenses/server-THIRD_PARTY_LICENSES.txt`, next to the web app's
  `web-3rdpartylicenses.txt` and THIRD_PARTY_NOTICES.md.

`dist/` is git-ignored, so the file is generated per build, not committed.

## 6. Recommendation

This is a recommendation for the owner to weigh, not a decision (M1.2 is the owner's).

**Recommended: Apache-2.0**, unless the owner decides that keeping hosted forks open outweighs adoption, in
which case **AGPL-3.0**. MIT is a reasonable third.

Reasoning:

1. The project is a self-hosted tool for small groups with a PRD goal of adoption and contributions; permissive
   terms serve that best, and the dependency tree (and 5etools itself) is already permissive.
2. Apache-2.0 gives MIT's freedom plus an explicit patent grant and an explicit contribution clause, at the cost
   of slightly more paperwork. It also matches the license of the MCP SDK the product is built around.
3. AGPL-3.0 is the only option that addresses the hosted-fork concern, but it stops only **modified** hosted
   forks, narrows the contributor and adopter pool, and makes any later change of license depend on all
   contributors. The value of that protection is highest if the owner expects a commercial host to be a real
   threat, which the PRD does not show yet.
4. The decision is easiest to take **before** the first outside contribution: after that, going from AGPL to a
   permissive license needs everyone's consent, while going from a permissive license to AGPL for new releases
   is possible.

If AGPL is chosen: add a "source code" link to the app for modified versions, decide on a DCO or CLA in M1.4,
and say in the README that operators who modify the app must publish the changes. If Apache-2.0 is chosen: add
a short NOTICE file only if there is something to put in it; it is not required.

## 7. Open questions for the owner

1. Is keeping hosted forks open (AGPL) worth fewer adopters, or is the goal the widest reuse (Apache-2.0/MIT)?
2. Do you want the option to relicense or dual-license later? If yes, start a CLA or DCO policy now, before
   contributions arrive (M1.4).
3. Should the license text say "or any later version" (AGPL) or pin the version?
4. Who is the copyright holder named in `LICENSE` (you, a pseudonym, or an organization)?
5. May the 5etools-utils license gap be accepted as is, or should the build add a copyright line for it
   (upstream issue or a note in THIRD_PARTY_NOTICES.md)?
6. Do you want a lawyer's opinion on serving 5etools-derived content to a private table, and on the product
   name, before the public announcement (PRD §12 already asks for this before any hosted demo)?
7. The statement about the agent definitions (MIT, AgentLand Contributors) was not re-verified against upstream
   in this task; please confirm if those files will ship in the public repository.

### To record in D1 (proposed defaults; answer yes or no to each)

1. **License:** Apache-2.0. Yes/no?
2. **Relicensing:** keep the option open through a DCO sign-off (`Signed-off-by` on commits), with **no CLA**.
   Contributions come in under the project license. This is the lightest policy, but later relicensing then
   needs contributors' consent. Yes/no?
3. **Version wording:** not applicable to Apache-2.0 (if AGPL is chosen instead: "AGPL-3.0-or-later"). Yes/no?
4. **Copyright holder in `LICENSE`:** `Copyright (c) 2026 <OWNER NAME OR HANDLE>` (placeholder; the owner must
   supply the name). Name: ____
