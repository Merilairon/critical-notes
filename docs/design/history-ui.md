# Page history panel: screen sketch (Task N1.4)

Owner: UX Architect · Implementer: Frontend Developer · QA: Evidence Collector · Date: 2026-10-26

Design only. No application code. Server behaviour is fixed by `docs/design/page-history.md` (sections 3, 6, 7, 12) and the N1.3 routes in `apps/server/src/routes/campaigns.ts` (region "page history"). Patterns reused from `docs/design/trash-ui.md` (focus after actions, always-present live regions, `aria-disabled` while busy, 44 px targets at 390 px, tokens only) and `docs/design/phone-layout.md`. Constraints (PROJECT.md §4): Angular standalone, signals, OnPush, zoneless; no `innerHTML`; no hard-coded colours, no `dark:` variants; GM-only UI. No new library.

## 0. Decisions in one page

| # | Decision | Why |
|---|---|---|
| D1 | History is a **panel on the page**, not a route. A **History** button in the editor toolbar (GM only) toggles it. It renders as a `<section>` in the editor, between the page content and the backlinks section. | page-history.md §6.2: no new route, so no `gmGuard`; the panel is simply not rendered for players and the server checks regardless. |
| D2 | **Compare by checkbox:** tick one version to compare it with the current page, tick two to compare them (older to newer, order fixed automatically). | One mental model, no modes, works with keyboard and touch. |
| D3 | **Restore has no confirm dialog.** It is non-destructive (append-only history), so it is followed by a visible result and an **Undo restore** button. | A confirm adds friction to something that can be undone. Undo is a second restore of the version that was current. |
| D4 | Diff is **client-side on `docText`**: line diff, then word diff inside changed lines. Added and removed are shown by **symbol, text decoration and screen-reader words**; colour only reinforces. | WCAG 1.4.1. The server computes no diff (page-history.md §7). |
| D5 | Restore never auto-retries after a 409. The panel loads the newer state and asks the GM to look again. | A restore must not overwrite someone's save unseen. |
| D6 | Lazy: the panel component is `@defer`red on first open, so players and GMs who never open it download nothing. | Cost. |

## 1. Entry point and placement

- **Button:** `History` in the toolbar of `page-editor.html`, next to "Apply template", shown only when `store.isGm()` and not `previewing()`. Classes as the neighbours (`cn-btn px-2 py-1 text-sm font-normal text-muted`). It carries `aria-expanded` and `aria-controls="cn-history-panel"`. Label: `🕑 History`.
- **Panel:** `<section id="cn-history-panel" aria-labelledby="cn-history-h">` after the page content and before the backlinks section, `mt-6 border-t border-line pt-3`. Rendered only while open (`@if (historyOpen())` around an `@defer`). Opening scrolls the panel into view and moves focus to its `h2` (`tabindex="-1"`). Closing (the toolbar button again, the panel's **Close** button, or Esc anywhere inside the panel) returns focus to the toolbar button.
- **Component:** `apps/web/src/app/campaign/history-panel.ts`, `CampaignHistoryPanel`, selector `cn-history-panel`. Inputs: `pageId`, `revision` (the editor's current page revision), `refresh` (the editor's `savedCount()`, like the backlinks panel), `blocked` (true while the editor status is `conflict` or `error`). Outputs: `restored(page: PageDto)` and `stale(page: PageDto)`; the editor adopts either (`page.set(page)`, `store.patchSummary`, `savedCount++`), replacing the body, facet and property forms. The editor also exposes its `flush()` to the panel. Pure diff code lives in `apps/web/src/app/campaign/history-diff.ts` (no Angular), with a unit spec.
- **Preview as player** hides the toolbar button and closes the panel. The panel never appears for a player, in a read-only view or on a trashed page.
- Open state is not persisted; a deep link opens the page with the panel closed.

## 2. Layout and rows

```
History                                              [Close]       (h2)
Earlier versions of this page. Tick one to compare it with the current
version, or two to compare them with each other.
Restoring brings back the title, type, text, details and properties.
Visibility, who can see it, position, tags, icon, cover and which
player owns a character stay as they are.

<div role="status"> (result of the last action)   </div>
<div role="alert">  (failure of the last action)   </div>

fieldset "Versions to compare"
+--------------------------------------------------------------------------+
| [ ] Version 14 · Current                                                  |
|     Jan via AI assistant (Claude desktop) · Today 14:32 · 3.1 KB          |
+--------------------------------------------------------------------------+
| [ ] Version 13                                                   [Restore]|
|     Jan · Today 09:10 · Restored from version 9 · 3.0 KB                 |
+--------------------------------------------------------------------------+
| [ ] Version 12                                                   [Restore]|
|     Mira (player) · Yesterday 21:40 · 3.0 KB                              |
+--------------------------------------------------------------------------+
                         [Load older versions]
```

- List `<ul aria-label="Versions">` of `<li class="flex flex-col gap-2 rounded-xl border border-line bg-panel p-3 sm:flex-row sm:items-center sm:justify-between">`. Newest first (server order).
- **Left block:** `<label>` wrapping the checkbox (`h-5 w-5`, label hit area at least 44 px high) and the text `Version {revision}`; the checkbox's accessible name is `Compare version 12`. The newest row also shows the word `Current` as a `cn-badge` (it equals the live page).
- **Who** (second line), from the list item fields `author`, `source`, `tokenName`, `cause`:

| `source` | Text |
|---|---|
| `web` | `{author.displayName}` |
| `player` | `{author.displayName} (player)` |
| `mcp` | `{author.displayName} via AI assistant ({tokenName})`; `tokenName` null: `via AI assistant (deleted token)` |
| `system` | `Earlier version (before history started)` (the baseline row) |
| author null | `Deleted user` in place of the name |

- **Cause label** (appended after the time, omitted for `edit`): `create` Created · `restore` Restored from version {restoredFrom} · `template_sync` Template sync · `template_apply` Template applied · `edition_migration` Edition migration · `import` Imported · `tracker` Combat update · `baseline` Earlier version. Tracker rows are shown, not hidden (keeps `before` paging simple).
- **When:** `<time [attr.datetime]="iso" [title]="createdAt | date:'medium'">`. Text `Today 14:32`, `Yesterday 21:40`, otherwise `12 Oct 2026 21:40` (locale default). A coalesced row shows the time of its first save (page-history.md §4.1); nothing to explain.
- **Size** `bytes` as `3.1 KB`. A row whose `title` differs from the row below it adds `Title: "Old Harbour"` so renames are visible in the list. Never `truncate`; use `[overflow-wrap:anywhere]`.
- **Restore** button: `cn-btn px-3 py-1.5`, visible text `Restore`, `aria-label="Restore version 12"`, `aria-describedby="cn-history-scope"` (the intro paragraph that says what is and is not restored). The current row has no Restore button (it is the live page).
- Selection limit two. When two are ticked the other checkboxes get `aria-disabled="true"` and ignore clicks; the hint line under the list (always rendered, empty otherwise, `text-sm text-muted`) says `Two versions selected. Untick one to choose another.`

## 3. Comparing and the diff

### 3.1 Which two versions

- One ticked: **ticked (old) to the current page (new)**. The current page is the newest row, so no extra fetch: use the editor's saved page. If the editor has unsaved or pending edits the pane notes `Unsaved changes in the editor are not included.`
- Two ticked: older revision number is "from", newer is "to", regardless of tick order.
- Ticking fetches `GET /history/:rev` (cache by revision in a `Map` for the life of the open panel).
- Nothing ticked: `Pick a version to see what changed.` (`text-muted`).

### 3.2 Text diff

Input: `docText(a.body, 'dm')` and `docText(b.body, 'dm')` from `@cn/blocks` (the GM sees DM-only and secret blocks; the panel is GM only). `docText` drops formatting, images and structure, so the pane says once under its heading: `Compares text only. Formatting and images are not compared.`

Algorithm (`history-diff.ts`, pure):

1. Split on `\n` into lines. LCS (Myers) line diff gives `equal | removed | added`. Guard: if `lines_a * lines_b > 4,000,000` (docText is capped at 50,000 chars), trim the common prefix and suffix and treat the middle as one removed block and one added block.
2. In each hunk with adjacent removed and added lines, pair them in order and run a **word diff** (tokens split on whitespace, whitespace kept) on each pair. Unpaired lines stay whole-line changes.
3. Runs of more than 6 unchanged lines collapse to a button `Show {n} unchanged lines`, leaving 3 lines of context on each side. Expanding keeps focus on the diff region.

Rendering (text interpolation only, no `innerHTML`):

- Container `<div role="region" aria-label="Changes from version 12 to version 14" tabindex="0">`, `font-mono text-sm`, `white-space: pre-wrap; overflow-wrap: anywhere`, `rounded-xl border border-line bg-panel`, `max-h-[70vh] overflow-y-auto`. Never scrolls sideways.
- Each line is a `<div>` with an `aria-hidden` gutter: `+` added, `−` removed, blank for context.
- **Added text:** `<ins>`, underlined (`underline decoration-2`), `font-semibold`. **Removed text:** `<del>`, `line-through`. A whole added line is one `<ins>` run (gutter `+`); a removed line is one `<del>` run (gutter `−`). Colour is extra only: `bg-accent/10` on added lines, `text-muted` on removed text. Meaning survives in monochrome and forced colours.
- **Screen readers:** each contiguous changed run is preceded by an `sr-only` word, `added: ` or `removed: `. Context lines have none. A word-diff line therefore reads `The harbour master removed: Aldric added: Brenna keeps the keys`.
- **Summary** above the pane (plain text, also referenced by `aria-describedby` of the region): `Text: 12 words added, 4 words removed in 3 places.` or `No text differences.`

### 3.3 Everything else that changed

Under the text pane, a `<dl>` headed `Other changes` lists only fields that differ: **Title** (`"Old" to "New"`), **Type**, **Details** (field label, old to new, scalars only), **Properties** (label, old to new). Values cut at 80 characters with an ellipsis. Deep equality decides. Labels come from the facet and property definitions when found, else the raw key. DM-only properties show (GM only). If nothing differs anywhere: `These two versions are identical.`

## 4. States

| State | Behaviour |
|---|---|
| Loading list | `Loading history…` in the status region; the list container has `aria-busy="true"`. |
| Empty | Pages that predate N1 and were never edited (no backfill, page-history.md §12.8): `No earlier versions yet. Versions are kept from the next edit on.` No checkboxes. |
| Single row | Just the current row plus `This is the only version so far.` |
| Error (list) | `role="alert"`: `Could not load history: {errorMessage(err)}` and **Try again** (`aria-disabled` while retrying). 403 or 404: `History is not available for this page.` |
| Detail loading | Pane shows `Loading versions…` with `aria-busy`. |
| Detail error | Alert inside the pane `Could not load version {n}.` with **Try again**; the list stays usable. 404 (pruned meanwhile): `Version {n} no longer exists.`, untick it, reload the list. |
| Pagination | First request `GET /history?limit=50`. Exactly 50 items back: **Load older versions** shows and requests `before={smallest revision shown}&limit=50`, appending. Fewer than 50: the button is replaced by `That is the oldest saved version.` After an append the status says `{n} older versions loaded` and focus moves to the checkbox of the first appended row. The button is `aria-disabled` and `aria-busy` while loading; a failure uses the list alert and keeps focus on the button. Dedupe by revision on append. |
| Refresh | When the editor reports a save (`refresh` changes) the first page reloads quietly, keeping ticks by revision where the row still exists (coalescing can remove rows; a vanished ticked row is unticked). Not announced. |

## 5. Restore flow

1. GM presses **Restore** on a row. If `blocked` (editor in conflict or error): alert `Resolve the save problem on the page first.`, no request. Otherwise the panel calls the editor's `flush()` so the revision sent is current.
2. `POST /history/{rev}/restore` with `{ revision: <editor page revision after flush> }`. The pressed button gets `aria-disabled`, `aria-busy`, text `Restoring…`; other Restore buttons are `aria-disabled`.
3. **Success, `restored: true`:** emit `restored(page)`; the editor shows the restored title, text, details and properties without reload. The list reloads, the new top row (`Restored from version {rev}`) is Current, ticks clear. Status: `Restored version {rev}. Saved as version {n}. Visibility, tags and other settings were not changed.` with a button **Undo restore** (no timer; stays until the next action or Close). Focus moves to the panel `h2`; the live region announces the message.
4. **Undo restore:** `POST /history/{previousCurrent}/restore` with `{ revision: <new revision> }`, where `previousCurrent` is the revision that was newest before step 2 (kept in a signal). It is a normal restore: status `Undone. The page is back to version {previousCurrent}.` and another new row. If it fails, the standard error handling below applies and the button goes away.
5. **`restored: false`:** nothing was written. Status `Version {rev} already matches the current page, so nothing changed.` No Undo. (This also covers versions that differ only in the player assignment, page-history.md §7.)
6. **Warnings** (`warnings: string[]`, shown whether or not a write happened): a bordered box under the status message, `<p class="font-semibold">Restored with notes</p>`, a `<ul>` with each string as text (for example `The page linked in "Patron" no longer exists; the link was cleared`) and a **Dismiss** button. It is part of the status live region so it is announced after the message, and stays until dismissed, the next restore or Close.
7. **409 (stale):** the body carries the current page. The panel emits `stale(page)` so the editor shows the newer state, reloads the list, and raises an alert: `This page was changed by someone else just now. The newest version is loaded. Review it and press Restore again if you still want version {rev}.` The target row stays ticked, so the diff to the new current page is already on screen. No automatic retry. Focus stays on the Restore button pressed. If the 409 body has no page, the panel fetches it with `GET /pages/:pid`.
8. **Other errors (400, 404, 500, network):** `role="alert"` with `errorMessage(err)`; focus stays on the pressed button; nothing changes. A 404 on the revision also unticks it and reloads the list.
9. **"Content only" (page-history.md Q4, decided):** Restore replaces title, type, body, details and properties. It never touches visibility, viewers, parent, position, tags, icon, cover, or access-bearing details such as which player owns a character. This is stated in the intro (section 2), tied to every Restore button with `aria-describedby`, and repeated in the success message. A restore of an old `type` that changes the details shape is allowed; the server decides and returns warnings.

## 6. Keyboard and screen reader

- Tab order: toolbar History button, (panel `h2`, programmatic focus only), Close, checkboxes and Restore buttons in row order, Load older, then the diff region (`tabindex="0"`, arrow keys scroll it), `Show n unchanged lines` buttons, Other changes. DOM order equals visual order at every width; no CSS `order`.
- Esc inside the panel closes it and focuses the toolbar button. Space toggles a checkbox, Enter or Space presses buttons.
- The panel adds one `h2`; rows have no headings; each `<li>` is named by its checkbox label. `fieldset` + `legend` ("Versions to compare") groups the checkboxes.
- Live regions (`role="status" aria-live="polite" aria-atomic="true"` and `role="alert"`) are in the DOM from the first render of the panel, never inserted together with their text. No `sr-only` duplicates of visible text, other than the `added:` / `removed:` prefixes.
- Busy state uses `aria-disabled` and `aria-busy`, never `disabled` (focus must not vanish).
- Focus is never dropped to `<body>`: after restore the `h2`; after a failure the pressed control; after Close the toolbar button; after Load older the first new checkbox; after expanding unchanged lines the diff region.

## 7. Phone width (390 px) and zoom

- Panel in the page flow at full width inside the page's own gutters. The diff is a single unified column (no side by side).
- Row `flex-col`: line 1 checkbox + `Version n` + badge; line 2 who; line 3 time, cause, size (wraps); Restore full width below (`max-sm:w-full`). Checkbox label, Restore, Load older, Undo restore, Dismiss, Close and `Show n unchanged lines` are at least 44 px tall under `touch:` (`min-h-[44px]`).
- Diff text at least 14 px (`text-sm`), `pre-wrap` and `overflow-wrap:anywhere`, so there is no horizontal page scroll; vertical scroll only inside the region. At 200 % text and 320 px nothing is clipped or overlaps.
- Results appear in the panel's own status region (not the shell's undo toast lane), which is in view because focus moves to the `h2`.

## 8. Light and dark

Existing tokens only: rows `border-line bg-panel`, secondary text `text-muted`, Restore and Close `cn-btn`, Undo restore `bg-accent text-accent-ink`, added-line tint `bg-accent/10` (decoration only), removed text `text-muted`, warnings box `border-line bg-panel` (the words "Restored with notes" are the cue), focus ring the global `:focus-visible`. Meaning never depends on a tint (D4). Evidence Collector measures `text-muted` on `bg-panel` for removed text and the tint behind added text in both themes (4.5:1).

## 9. GM-only

- Button and panel exist only for `store.isGm()` (DM and co-DM). No route, so no `gmGuard`; the three endpoints refuse non-GMs on the server before reading anything (page-history.md §6). If the server returns 403 or 404 the panel shows the section 4 message.
- Nothing about history (counts, "last edited by") appears where a player can see it: page tree, summaries, backlinks, search, player preview. This panel adds none.
- Snapshots contain DM-only blocks and properties: render for the GM only, keep them in component memory only (no `localStorage`, no store), drop the cache on Close.

## 10. Handoff

1. `history-diff.ts` (`diffLines`, `diffWords`, `collapse`) with a spec: identical texts, pure add, pure remove, replacement pairing, one-word change, the 6-line collapse boundary, the size-guard fallback, empty to text, CRLF.
2. `history-panel.ts` (signals `items`, `selected`, `detail`, `status`, `alert`, `warnings`, `undoTarget`, `loading`, `done`), toolbar button and `@defer` in `page-editor.html`/`.ts`, `adopt()` for `restored`/`stale`, `flush()` exposure.
3. Unit spec of the panel (source labels, selection limit, restore success, `restored: false`, 409, warnings, pagination) and one e2e: edit twice, open History, compare, restore, undo restore.
4. Update `docs/STATUS.md`. No deviation from the PRD.

## 11. Evidence Collector: what to check

Setup: a campaign with a GM, a player (Mira) and a GM API token named "Claude desktop"; page "Old Harbour" with a DM-only block holding a distinctive word; edit it as GM (web), through the token (MCP) and as Mira, each at least 2 minutes apart; later revoke the token. Also one page never edited since N1.

1. **Entry:** GM and co-DM see `History` in the editor toolbar; the player does not; Preview as player hides it. Panel closed by default; opening puts it below the content, focus on the `h2`, `aria-expanded` true.
2. **Rows:** newest first, newest labelled Current with no Restore. Web edit shows the name, player edit `(player)`, MCP edit `via AI assistant (Claude desktop)`, restored row `Restored from version n`, template sync `Template sync`.
3. **Deleted token / user:** after revoking the token the row reads `via AI assistant (deleted token)`; after deleting the author's user `Deleted user`.
4. **Compare one:** tick an older version: heading `Changes from version a to version b`, summary counts, `Compares text only`.
5. **Compare two:** tick in reverse order: the older is still "from". A third tick is refused with the hint.
6. **Not by colour alone:** in a greyscale or forced-colours screenshot added and removed runs are distinguishable (underline vs strike-through, `+` and `−` gutter). In the DOM every changed run has `added:` or `removed:`.
7. **Word diff and collapse:** changing one word in a long paragraph marks only that word. A page with 200 unchanged lines collapses to `Show n unchanged lines`, operable by keyboard.
8. **Other changes:** rename, change a property, change the type: each is listed. Identical versions say so.
9. **Restore:** press Restore on an older version: no `confirm()`; title, text and properties in the editor change without reload; status shows the new version number; new top row; focus on the `h2`; message announced. Tags, visibility, viewers, parent and icon unchanged. A removed player still has no access to their old character page.
10. **Undo restore:** returns the earlier content as another new row; all earlier rows are still listed. Works with keyboard only.
11. **Restore the current content:** `Version n already matches...`, no new row, no Undo.
12. **Warnings:** restore a version whose linked page was since deleted: `Restored with notes` lists the cleared link; Dismiss removes it; announced once.
13. **Stale 409:** open History in two tabs, save in tab B, restore in tab A: alert as in 5.7, tab A shows B's content, target row still ticked, nothing restored, no auto retry; pressing Restore again succeeds.
14. **Pending edits:** type in the editor and press Restore at once: the typed text is saved first (own version), then the restore applies without a 409.
15. **States:** loading text on a throttled network; empty-page copy; forced 500 on the list (alert, Try again, focus kept); forced 500 and 404 on a detail fetch; forced 500 on restore (alert, focus on the button, nothing changed).
16. **Pagination:** a page with 120 versions shows 50, `Load older versions` adds 50, then 20 and the button becomes `That is the oldest saved version.`; announcement text and focus on the first new checkbox; no duplicate rows.
17. **Player safety:** as Mira, `GET /history`, `GET /history/:rev` and `POST .../restore` are refused; no history control at 390 px or desktop; the distinctive DM word is in no player response (N1.6 sentinel crawl).
18. **Keyboard:** the whole flow (open, tick, read diff, restore, undo, close) with Tab, Space, Enter, Esc only; Esc returns focus to the History button; visible focus ring everywhere; focus never lands on `<body>`.
19. **390 px, light and dark:** no horizontal scroll in panel or diff, rows stacked, Restore full width, every control at least 44 px tall, no clipped titles. Screenshots in both themes: list, one-version diff, two-version diff, collapsed context, restore result with warnings, error alert. At 200 % text and 320 px nothing overlaps.
20. **Contrast and axe:** axe 0 violations on the open panel with a diff and on the result state; contrast per section 8.
21. **Regression:** the editor still autosaves with the panel open; backlinks still render below; closing the panel clears the cache (reopen shows loading); a trashed page has no History.

## 12. Open questions for the owner

None blocking. Assumed and easy to change: tracker rows are shown in the list (page-history.md Q10 allows hiding them); no confirm before Restore because it is undoable; the diff covers text only, with title, type, details and properties shown as a short change list.
