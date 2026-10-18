# Campaign trash and "Deleted · Undo" toast: screen sketch

Task M4.3 · Owner: UX Architect · Implementer: Frontend Developer · QA: Evidence Collector · Date: 2026-10-18

Design only. No application code. Server behaviour is fixed by M4.1 (`apps/server/src/routes/campaigns.ts`, `PageService.trash/restore/purge`, `TrashEntryDto` in `packages/shared/src/pages.ts`). Format and conventions follow `docs/design/admin-users-ui.md`. No new library: Angular standalone + signals + OnPush, Tailwind tokens from `apps/web/src/styles.css`, `HttpClient`, `errorMessage()` from `core/http.interceptor.ts`.

## 1. What exists today (and what changes)

| Fact | Where | Consequence |
|---|---|---|
| The only place a page is deleted is the **Delete** button in the editor toolbar (`page-editor.html`, `remove()`), behind `confirm('Delete "x" and its subpages?')`, then `store.deletePage()` and navigation to the campaign overview. | `page-editor.ts` | The toast starts there. The tree has no delete action. |
| Campaign nav is the `nav` array in `campaign-shell.ts`; `gm: true` hides an entry from players. | `campaign-shell.ts` | Trash is one more `gm: true` entry. |
| GM-only routes use `canActivate: [gmGuard]` (rule in PROJECT.md §4). | `app.routes.ts` | Same for `trash`. |
| The only toast is the dice toast in `app.html` (`role="status"`, 4 s, `pointer-events-none`, bottom right). | `app.ts`, `app.html` | Not reusable: it cannot hold a button and 4 s is too short for Undo. The undo toast is a separate element. |
| Destructive confirmations everywhere else are native `confirm()`. | 10 call sites | Trash uses `confirm()` too (section 3.4). |

## 2. Entry point, route, guard

- Nav entry in `nav` between Templates and Settings: `{ path: ['trash'], label: 'Trash', icon: '🗑️', gm: true }`. Players never see it (`visibleNav` filters it). No count badge (it would cost a request on every campaign load).
- Route, a child of the campaign shell next to `templates`: `{ path: 'trash', loadComponent: () => import('./campaign/trash').then((m) => m.CampaignTrash), title: 'Trash', canActivate: [gmGuard] }`. A player who types the URL lands on `/c/:id` (guard); the server returns 403 regardless.
- New file `apps/web/src/app/campaign/trash.ts`, class `CampaignTrash`, selector `cn-campaign-trash`. Gets the campaign id from `CampaignStore.id()`.

## 3. Trash view

### 3.1 Layout (desktop, `sm` and up)

```
Trash                                                     (h1)
Deleted pages stay here for 30 days, then they are removed for good.
Restoring a page brings back its subpages. If its parent page is also
in the trash, the page returns to the top level.

<div role="status"> (empty unless an action just finished) </div>
<div role="alert">  (empty unless an action failed)        </div>

+------------------------------------------------------------------------------+
| 📍  Old Harbour                                      [Restore] [Delete        |
|     Location · 3 subpages                                       permanently]  |
|     Deleted 2 days ago · purged in 28 days                                    |
+------------------------------------------------------------------------------+
| 🧙  Brother Aldric                                   [Restore] [Delete ...]   |
|     NPC · no subpages                                                         |
|     Deleted today · purged in 30 days                                         |
+------------------------------------------------------------------------------+
```

- Container: `mx-auto w-full max-w-3xl p-4 sm:p-6`. `h1.font-display.text-3xl.font-bold`. Intro `text-sm text-muted`.
- List: `<ul class="mt-4 space-y-2">`, rows `<li class="flex flex-col gap-3 rounded-xl border border-line bg-panel p-3 sm:flex-row sm:items-center sm:justify-between">`. The `<ul>` has `aria-label="Deleted pages"`.
- Left block: `icon ?? PAGE_TYPE_ICONS[type]` in `aria-hidden` span; title `font-semibold break-words` (never `truncate`, a clipped title hides what is being deleted); second line `text-sm text-muted`: `{PAGE_TYPE_LABELS[type]} · {n} subpage(s)` ("no subpages" for 0, "1 subpage"); third line `text-sm text-muted`: age line below. The title is plain text, not a link: a deleted page cannot be opened.
- Age line: `Deleted {today | yesterday | N days ago} · purged in N days` (`purged today` when 0 left, "tomorrow" when 1). Days left = `max(0, RETENTION_DAYS - floor((now - deletedAt)/86400000))`. Reuse the server's retention constant if it is exported from `@cn/shared`; otherwise one `const RETENTION_DAYS = 30` in `trash.ts` with a comment pointing at the server. Wrap in `<time [attr.datetime]="iso" [title]="deletedAt | date:'medium'">`. When 3 days or fewer remain the whole line gets `text-accent` (the words stay the cue, not the colour).
- Order: newest `deletedAt` first (sort client-side, stable).
- Actions (right block, `flex gap-2`): **Restore**: `rounded-md border border-line px-3 py-1.5 hover:border-accent`. **Delete permanently**: same box plus `text-accent`. No filled primary button: the page has many rows and nothing is the single main action (same reasoning as the admin table). Accessible names include the page: `aria-label="Restore Old Harbour"`, `aria-label="Delete Old Harbour permanently"` (visible text starts the label, so voice control works).

### 3.2 Phone, 390px

```
+--------------------------------------+   16px gutters (p-4)
| Trash                                |
| Deleted pages stay here for 30 days, |
| then they are removed for good. ...  |
|                                      |
| +----------------------------------+ |
| | 📍 Old Harbour                   | |
| | Location · 3 subpages            | |
| | Deleted 2 days ago               | |
| | Purged in 28 days                | |
| | [        Restore               ] | |
| | [  Delete permanently          ] | |
| +----------------------------------+ |
+--------------------------------------+
```

- Below `sm` the row is a column; the two buttons are full width, stacked, each `py-2.5` (44px tall minimum), Restore first. They never sit side by side at 390px (long labels plus 44px targets would overflow).
- The shell already collapses the sidebar below `lg` behind the "☰ Campaign" button, so Trash is reached through it. No horizontal scroll: titles wrap (`break-words`), nothing has a fixed width. The toast is full width (section 4.2).
- The age line may wrap onto two lines; keep the two facts as two `<span class="block sm:inline">` separated by ` · ` only from `sm` up.

### 3.3 Actions

| Action | Request | Confirmation | After success |
|---|---|---|---|
| Restore | `POST /api/campaigns/:cid/pages/:pid/restore` -> `{ restored: ids }` | none (reversible: it can be deleted again) | Remove the row. Status: `Restored "Old Harbour" with 3 subpages.` plus an inline link `Open page` (`routerLink` to `p/:pid`). Call `store.reloadPages()` so the sidebar tree shows it at once. |
| Delete permanently | `DELETE /api/campaigns/:cid/pages/:pid/purge` -> `{ purged: ids }` | native `confirm()` (3.4) | Remove the row. Status: `Permanently deleted "Old Harbour" and 3 subpages.` |

Rules for both:
- Per-row busy: the row's buttons get `aria-disabled="true"` + `aria-disabled:opacity-60`, handlers return early (do not use `[disabled]`, which drops focus; same convention as the account and admin pages). The clicked button text becomes `Restoring…` / `Deleting…`.
- Focus after a row disappears: move focus to the same action button of the next row (or the previous when it was last); when the list becomes empty, focus the `h1` (`tabindex="-1"`). Never leave focus on a removed node (it falls to `<body>` and a keyboard user loses their place).
- 404/400 from the server (the 30-day purge removed it meanwhile, or another tab restored it): not an error for the person. Remove the row, reload the list, status `"Old Harbour" is no longer in the trash.`
- Any other failure: `role="alert"` region (always in the DOM) shows `errorMessage(err)`; the row stays; focus stays on the button.
- The status and alert regions sit above the list, both always in the DOM with text swapped in (the admin-page pattern), so screen readers announce them. The status text stays until the next action.

### 3.4 Delete permanently confirmation

Native `confirm()`, like every other destructive confirm in the app (members, properties, encounters, tokens). It is keyboard and screen-reader accessible for free and works at 390px. Text:

- With subpages: `Permanently delete "Old Harbour" and its 3 subpages? This cannot be undone.`
- Without: `Permanently delete "Brother Aldric"? This cannot be undone.`
- Singular: `and its 1 subpage`.

A styled `cdkTrapFocus` dialog (as `step-up-dialog.ts`) is a possible later consolidation of all `confirm()` calls; it is not part of M4.3.

### 3.5 States

| State | Markup |
|---|---|
| Loading | `<p role="status" class="text-muted">Loading trash…</p>` in place of the list. h1 and intro already visible. |
| Load error | `<div role="alert">` with `errorMessage(err)` and a `Try again` button (secondary style). A 403 (role lost meanwhile) shows the server text plus `<a class="cn-link" routerLink="/c/:id">Back to the campaign</a>`. |
| Empty | Panel `rounded-xl border border-line bg-panel p-6 text-center`: `<p class="font-semibold">The trash is empty.</p><p class="text-sm text-muted">Pages you delete show up here for 30 days.</p>`. The intro paragraph stays. |
| Empty after last action | Same empty panel; the status message of the action stays visible above it. |

## 4. "Deleted · Undo" toast

### 4.1 Behaviour

- Trigger: successful `store.deletePage()` from the editor's Delete button. Nothing else deletes pages today; any future delete action calls the same store method and gets the toast.
- **Remove the `confirm()` in `PageEditor.remove()`** (decision for the Product Manager to approve at QA hand-off if unsure): with Undo and a 30-day trash, a confirm before a recoverable delete is friction; the toast replaces it. Subpages are the reason people hesitate, so the toast text states the count.
- State lives in `CampaignStore`, not in `PageEditor`: the editor navigates to the overview right after deleting and is destroyed, which would take a component-local toast with it. Add `readonly undo = signal<{ pageId: string; title: string; subpages: number } | null>(null)`. `deletePage()` computes the subpage count from `pages()` (descendants by `parentId`) before the request, then sets `undo` after success. `undoDelete()` calls `POST .../restore`, `reloadPages()`, clears `undo`, returns the page id. `leave()` clears `undo` and the timer.
- The toast is rendered by `CampaignShell` (it outlives page navigation inside the campaign; it disappears on leaving the campaign).
- Text: `Deleted "Old Harbour" and 3 subpages` (`Deleted "Brother Aldric"` for 0) and an **Undo** button, then a dismiss button `✕` (`aria-label="Dismiss"`).
- Timeout: **10 seconds** (the dice toast's 4 s is too short to read, decide and reach a button). The timer pauses while the pointer is over the toast or focus is inside it, and restarts at 10 s when both end (WCAG 2.2.1: no pressure on a keyboard or screen-reader user). When it expires the toast is removed; the page remains restorable from Trash for 30 days, and the page never claims otherwise.
- Only one toast at a time: a second delete replaces the first (the first page is still in Trash). Undo always means "the most recent delete".
- Undo success: remove the toast, navigate to `/c/:id/p/:pageId`, status toast text `Restored "Old Harbour"` (same region, 4 s, no button). The tree, backlinks and search come back with it (server reindexes on restore).
- Undo failure: the toast text becomes `Could not undo. Open the trash to restore it.` with a `Trash` link (`routerLink` to `trash`) and `role="alert"`; it stays until dismissed.
- Esc while focus is inside the toast dismisses it.

### 4.2 Placement and markup

```
Desktop: bottom-left of the viewport (the dice toast owns bottom-right)
+------------------------------------------------+
| Deleted "Old Harbour" and 3 subpages  [Undo] ✕ |
+------------------------------------------------+

390px: full width, 16px from the edges, above the safe area
+------------------------------------------+
| Deleted "Old Harbour" and 3 subpages     |
| [  Undo  ]                            ✕  |
+------------------------------------------+
```

- Region: one wrapper rendered **always** (not inside `@if`) by the shell: `<div class="fixed inset-x-4 bottom-4 z-50 sm:right-auto sm:max-w-md" role="status" aria-live="polite" aria-atomic="true">`. Content (the toast card) is swapped in; a live region that is inserted already filled is often not announced.
- Card: `flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel px-4 py-3 shadow-xl`. Text `text-sm`. Undo button: `rounded-md bg-accent px-3 py-1.5 font-semibold text-accent-ink` (primary: it is the one action; `--accent-ink` flips in dark mode). Dismiss: `rounded px-2 py-1 text-muted hover:text-ink`. At 390px the Undo button is `min-h-11`. Wrap uses `flex-wrap`, so the text takes the first line and the buttons the second.
- No slide or fade animation (or guard it with `motion-safe:`).
- Announcement: the live region reads the text. Add `<span class="sr-only">Undo is available for 10 seconds.</span>` inside the card so non-visual users know there is a time limit. The Undo button carries `aria-label='Undo delete of "Old Harbour"'` (visible text "Undo" is its prefix).
- Focus: **never moved automatically** (stealing focus after navigation is worse than a slightly slower Undo). To make Undo reachable by keyboard without crossing the whole page, render the region **directly after the campaign `<section>` in the shell template**, so Tab from the page content reaches it next. The Trash page remains the guaranteed way back.
- After Undo or Dismiss with focus on the button: move focus to the page `h1` / main content of the current route (the restored page's title input after navigation). Do not drop it to `<body>`.

## 5. Light and dark

Only existing tokens; no hard-coded colours and no `dark:` variants (the theme flips the CSS variables).

| Element | Classes |
|---|---|
| Row / panels | `border-line bg-panel` |
| Secondary text | `text-muted` |
| Restore, Delete permanently | `border border-line` + `hover:border-accent`; Delete adds `text-accent` |
| Expiring-soon line | `text-accent` (text carries the meaning) |
| Undo | `bg-accent text-accent-ink` |
| Toast | `border-line bg-panel shadow-xl` |
| Focus | global `:focus-visible` ring (`--focus`); do not override |

Contrast: `text-muted` on `bg-panel` and `text-accent` on `bg-panel` are already used on the account and admin pages; the two new pairings (`text-accent` on `bg-panel` for the expiring line, `text-accent-ink` on `bg-accent` for Undo) must still be measured in both themes by the Evidence Collector (4.5:1 for text).

## 6. Accessibility requirements

1. Trash page: one `h1`; rows are a labelled `<ul>`; no extra headings per row.
2. Every action button names the page; busy state with `aria-disabled`, not `disabled`.
3. Status and alert regions always in the DOM; the toast region always in the DOM; the toast announces its time limit.
4. Focus is never lost: after Restore/Delete permanently (next row or `h1`), after Undo/Dismiss (main content), after a failed action (stays).
5. Toast timer pauses on hover and focus; Esc dismisses; works with keyboard only (Tab from content reaches it).
6. State is never colour-only: "purged in N days" is words; expiring rows use colour as an extra.
7. Touch targets at least 44px at 390px (buttons `py-2.5`, Undo `min-h-11`).
8. Text spacing and 200% zoom: no clipped titles, no horizontal scroll.
9. Native `confirm()` text names the page and the subpage count.

## 7. Evidence Collector: what to check

Setup: a campaign with a GM and a player; a page "Old Harbour" with 2 subpages (one nested), a link from another page to it (backlink), and a distinctive word in its body for search.

1. Entry: GM sees Trash in the campaign nav; the player does not. Player opening `/c/:id/trash` is redirected to `/c/:id` and the API returns 403.
2. Delete "Old Harbour" in the editor: no `confirm()` appears; toast reads `Deleted "Old Harbour" and 2 subpages` with Undo; screen reader (or the DOM live region) announces it and the 10 s limit.
3. Undo within 10 s: page and both subpages are back in the tree, the backlink and the search for the distinctive word work, you land on the page, `Restored` message shows. Repeat with keyboard only (Tab from content to Undo, Enter).
4. Let the toast expire (and hover to confirm it pauses): the page is in Trash, with "Deleted today · purged in 30 days" and "2 subpages".
5. Restore from Trash: same checks as step 3 (subpages, backlinks, search); the row disappears; focus lands on the next row's button or the h1; the status message is announced.
6. Restore a child whose parent is still in the trash: it appears at the top level.
7. Delete permanently: `confirm()` text has the subpage count; cancel does nothing; confirm removes the row; search no longer finds the word; API `GET .../pages/:pid` is 404.
8. Two deletes in a row: only one toast, both pages in Trash, Undo restores the latest.
9. Age text: set `deletedAt` back 28 days (test DB): "Deleted 28 days ago · purged in 2 days" in the accent colour; a 30-day-old item is gone after the purge job.
10. States: empty (copy, h1 focus after last row), loading, forced 500 (alert + Try again), stale row (restore an id the server already purged: row is removed, no error).
11. 390px, light and dark: no horizontal scroll, buttons stacked and 44px tall, toast full width and not covering the Undo target, screenshots of Trash with items, empty, and the toast; axe 0 violations on the Trash page with items and on the page showing the toast.
12. Contrast of the two new pairings in both themes (section 5).
13. Regression: the dice toast still shows bottom right and does not overlap the undo toast; deleting from a campaign then leaving it leaves no stray toast.

Not covered by this design (explicitly out of scope): templates trash (M4.2), the MCP `list_trash` tool (M4.4), the e2e spec (M4.5), a shared styled confirm dialog.
