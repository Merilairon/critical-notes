# Third-party notices

Critical Notes includes, adapts or ships third-party material. This file lists it with the notices its licenses
require. The license of Critical Notes' own code is described in the [README](README.md#licensing).

## 1. Included in this repository

### AI agent definitions (agency-agents)

The 35 agent files below in `.claude/agents/` come unmodified from
[msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents), commit `4bce55aa8b97`
(installed 2026-10-13). `.claude/agents/project-assistant.md` is the project's own and not part of it.

<details>
<summary>The 35 files</summary>

- `agents-orchestrator.md`
- `design-ui-designer.md`
- `design-ux-architect.md`
- `design-ux-researcher.md`
- `engineering-backend-architect.md`
- `engineering-code-reviewer.md`
- `engineering-data-visualization-engineer.md`
- `engineering-database-reliability-engineer.md`
- `engineering-devops-automator.md`
- `engineering-frontend-developer.md`
- `engineering-git-workflow-master.md`
- `engineering-i18n-engineer.md`
- `engineering-identity-access-engineer.md`
- `engineering-knowledge-graph-engineer.md`
- `engineering-minimal-change-engineer.md`
- `engineering-realtime-collaboration-engineer.md`
- `engineering-software-architect.md`
- `engineering-technical-writer.md`
- `game-designer.md`
- `narrative-designer.md`
- `product-manager.md`
- `product-sprint-prioritizer.md`
- `project-manager-senior.md`
- `security-appsec-engineer.md`
- `security-architect.md`
- `security-penetration-tester.md`
- `specialized-developer-advocate.md`
- `specialized-mcp-builder.md`
- `support-legal-compliance-checker.md`
- `testing-accessibility-auditor.md`
- `testing-api-tester.md`
- `testing-evidence-collector.md`
- `testing-performance-benchmarker.md`
- `testing-reality-checker.md`
- `testing-test-automation-engineer.md`

</details>

```
MIT License

Copyright (c) 2025 AgentLand Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. 5etools and game content

**Game content is not included.** Critical Notes contains no rules text, statblocks or art. At run time it
reads the 5etools clones the user provides (`FIVETOOLS_SRC_PATH`, `FIVETOOLS_IMG_PATH`). That content and art
belong to Wizards of the Coast and the credited artists; the portions from the System Reference Documents 5.1
and 5.2 are available under CC-BY-4.0.

**5etools code.** Parts of `packages/fivetools` are adapted from 5etools code: the edition matching table
(`expand/items.ts`), the tag registry (`tags/registry.ts`, from `Renderer.tag.*`) and the source-name maps read
from `js/parser.js` (`node/loader.ts`). The rest follows how 5etools works: the `_copy`/`_mod` inheritance of its
data, the `{@tag}` syntax, and how it decides a source's edition. 5etools is MIT-licensed:

```
MIT License

Copyright (c) 2017 TheGiddyLimit and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**5etools-utils** ([TheGiddyLimit/5etools-utils](https://github.com/TheGiddyLimit/5etools-utils), MIT) is a
run-time dependency: it supplies the homebrew schemas and the edition source lists. Its npm package declares
`"license": "MIT"` but contains no license file (reviewed 2026-10-16 for version 0.17.21), so the image carries
no copyright line for it; the 5etools notice above is the closest text. See
[docs/legal/license-options.md](docs/legal/license-options.md).

## 3. Dependencies shipped in builds and the Docker image

The server bundle, the web app and the Docker image contain npm packages under their own licenses. None of
them are stored in this repository; they are installed from `pnpm-lock.yaml`.

| License | Notable packages |
|---|---|
| MIT (most packages) | Angular, TipTap and ProseMirror, ngx-tiptap, Hono, zod, better-sqlite3, @node-rs/argon2, fflate, the mdast and micromark Markdown libraries, 5etools-utils |
| Apache-2.0 | sharp, @img/sharp-linux-x64, drizzle-orm, @modelcontextprotocol/server and core, rxjs, uuidv7, detect-libc |
| LGPL-3.0-or-later | libvips and part of the libraries bundled with it (`@img/sharp-libvips-*`), see below |
| BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, BlueOak-1.0.0, CC0-1.0 | smaller packages, e.g. fractional-indexing (CC0-1.0), tslib (0BSD), minimatch (BlueOak-1.0.0) |

**libvips.** sharp loads libvips as a separate shared library from the `@img/sharp-libvips-<platform>` package,
so it can be replaced with another build. That package bundles about 25 libraries; its README lists the license
of each (LGPL-3.0, MPL-1.1, BSD, MIT and others). Sources: [lovell/sharp-libvips](https://github.com/lovell/sharp-libvips)
and [libvips/libvips](https://github.com/libvips/libvips).

**Where the full license texts are:**
- Web app: `3rdpartylicenses.txt`, written by the Angular build to `apps/web/dist/web/`; in the Docker image at
  `/app/licenses/web-3rdpartylicenses.txt`.
- Server bundle: `apps/server/dist/THIRD_PARTY_LICENSES.txt` (in the image at
  `/app/licenses/server-THIRD_PARTY_LICENSES.txt`) holds the full license text of every package bundled into
  `main.mjs` and `index.mjs`, plus any NOTICE files. `apps/server/scripts/licenses.mjs` generates it from
  esbuild's metafile on every `pnpm --filter @cn/server build`. `main.mjs.LEGAL.txt` (in the image at
  `/app/main.mjs.LEGAL.txt`) still collects the license comments esbuild found in the code. The packages kept
  outside the bundle (better-sqlite3, @node-rs/argon2, sharp with libvips) keep their license files under
  `/app/node_modules/`; 5etools-utils has none (see above).
- This file is in the image at `/app/licenses/THIRD_PARTY_NOTICES.md`.
- A complete list of packages and licenses: `pnpm licenses list --prod --filter @cn/server --filter @cn/web`.

Two bundled packages ship no license file in their npm package: `@hono/zod-validator` (MIT) and `drizzle-orm`
(Apache-2.0). The generated file says so and, for Apache-2.0, adds the standard license text. No bundled package
carries an Apache-2.0 NOTICE file (checked 2026-10-16). `@modelcontextprotocol/server` is mid-way through a
relicense from MIT to Apache-2.0 and says so in its LICENSE file; the generated file reproduces that text.
