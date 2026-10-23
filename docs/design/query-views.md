# Query block views: table, cards and the column picker

Task I2.1 · Owner: UX Architect · Implementer: Frontend Developer (I2.2) · QA: UI Designer · Date: 2026-10-23

Design only. No application code changed. Inputs: `docs/PROJECT.md` §4 (rules) and §6.5, `docs/PRD.md` §10 I2, `docs/design/phone-layout.md` (M6.2), `docs/design/trash-ui.md` for format, `packages/blocks/src/query.ts` and `registry.ts`, `packages/shared/src/facets.ts` and `properties.ts`, `apps/server/src/services/pages.ts` (`queryFor`), `apps/server/src/routes/campaigns.ts` (`/query`, `/properties`), and in `apps/web`: `editor/views/atom-views.ts` (`QueryView`, editor), `blocks/block-view.ts` and `block-view.html` (`QueryBlock`, read-only), `editor/extensions/nodes.ts`, `styles.css`. No new library: Angular standalone, signals, OnPush, zoneless, Tailwind v4.1 and the tokens in `styles.css`. No `innerHTML`. Never hard-code a colour.

## 0. What exists today (so I2.2 knows its starting point)

| Fact | Where |
|---|---|
| The block attrs **already declare** `view: 'list' \| 'table' \| 'cards'` (default `list`) and `columns: string[]` (max 10 strings of 80, default `[]`). The TipTap node already carries both (`nodes.ts:76`). Nothing reads them. | `registry.ts:143-144` |
| Two components render a query: `QueryView` (editor, with a Configure panel: types, tags, relation, sort with 3 fixed options) and `QueryBlock` (read-only, used by player views, previews and embeds). Both draw the same `<ul class="cn-query-results">` of icon + title links. `QueryBlock` ignores `view` and `columns`. | `atom-views.ts:178`, `block-view.ts:91` |
| `POST /api/campaigns/:id/query` takes `{filter, contextPageId}` and returns `{rows: QueryRowDto[]}`. A row is the page summary (id, parentId, type, title, icon, visibility, updatedAt, sortKey) plus `tags`, `facet`, `props`. It does **not** take columns: it always returns every facet field and every property value the viewer may see. | `campaigns.ts:294`, `properties.ts:75` |
| For players, `queryFor` removes DM-only property values (by definition), removes DM-only facet fields (`FACET_DM_ONLY_FIELDS`: `statblockUid`, `statblockHomebrewEntityId`, `itemHomebrewEntityId`), clears facet page links to pages they cannot see, and nulls `parentId` of unseen parents. Filtering and sorting run over the projected rows. | `pages.ts:519` |
| `GET /properties` returns all definitions to the DM and only non-DM-only ones to players. | `campaigns.ts:314` |
| Sorting is server side, persisted in `filter.sort` (`field`, `dir`), fields `title`, `type`, `tags`, `updatedAt`, `createdAt`, `facet.<key>`, `prop.<key>`; nulls sort last; `limit` default 100, max 500. | `query.ts` |
| Errors are swallowed: a failed request shows "No matching pages". There is no loading state in `QueryBlock`. | `block-view.ts:100` |

Consequence: **the persisted-attr schema needs no change and no migration** (section 8). The work is rendering, the picker, a projection hardening on the server (section 9), and the states.

## 1. Decisions in one page

| # | Decision | Why |
|---|---|---|
| D1 | Three views: **List** (today, unchanged and still the default), **Table**, **Cards**. One component, `view` selects the template. Editor and read-only share it (section 10). | Two components drawing the same rows is how they drift. |
| D2 | `columns` is an ordered list of column keys using the **same field grammar as the query DSL**: `type`, `tags`, `updatedAt`, `createdAt`, `facet.<key>`, `prop.<key>`. **Title is always shown, always first, and never in `columns`.** | Reuses `fieldValue`; the title is the link and the row header. |
| D3 | **Empty `columns` means "sensible defaults", resolved at render time and not persisted** (section 5.3). | Switching an old List block to Table must give a useful table before anyone opens the picker. |
| D4 | The table is a **real `<table>`** with `caption`, `th scope`, `aria-sort`. No `role="grid"`, no ARIA table on divs. | Native semantics are free and the content is read-only. |
| D5 | **Phone: the table stays a table**, scrolls sideways inside its own wrapper, with a sticky title column. Authors who want a phone-first block choose Cards. No automatic switch of view. | Respects the author's choice and keeps table semantics; phone-layout D9 allows inner scrolling. Open question Q1. |
| D6 | Sorting has two layers: the **default sort** (persisted, server side, `filter.sort`, set in Configure) and **viewer sort** (click a column header, client side, per viewer, not persisted, resets on reload). | A player must be able to sort a table without editing the page; a DM sets the order players see first. |
| D7 | Only **scalar** fields can be the persisted default sort (title, type, dates, number, date, text, select and checkbox details and properties). Page links, reference links, tags and multi-selects sort only client side, by their displayed text. | The server sorts `pageLink` by page id, which looks random on screen. |
| D8 | The column picker is **ordered rows with move up, move down, remove** plus an **"Add a column" grouped `<select>`**. No drag and drop in 1.3. | Fully keyboard and screen reader operable, works at 390 px. Drag can be added later as an enhancement. |
| D9 | **What a player sees is decided on the server**: rows already projected; `columns` and `filter.sort` of the block are cleaned of DM-only keys by the block's `project` hook (section 9). The client also renders only columns it can resolve. | Today a DM-only key name inside `columns` would travel in the page body to players. |
| D10 | Loading, error and empty are three different states with different text (section 6). | Today all three look like "No matching pages". |
| D11 | Touch rules from phone-layout D4: sort buttons, title links, picker buttons and the view radios are at least 44 x 44 CSS px on `touch:`; links inside cells are secondary (24 px minimum with the row padding). | Consistency with M6. |

## 2. Data model of a column

A column key resolves to a **column definition** (client side, computed from row data, `FACET_FIELDS`, and the properties list). Nothing about it is stored except the key.

| Key | Header | Cell | Sortable (viewer) | Allowed as default sort (server) |
|---|---|---|---|---|
| (title) | "Title" (fixed) | icon + title link, row header | yes | yes |
| `type` | Type | type icon + `PAGE_TYPE_LABELS` text | yes (by label) | yes |
| `tags` | Tags | `.cn-badge-plain` chips | yes (joined text) | no |
| `updatedAt` | Updated | `<time datetime>` short date; the year is shown when it is not the current year | yes | yes |
| `createdAt` | Created | same | yes | yes |
| `facet.<key>` | `FACET_FIELDS[...].label` | by field type (table below) | yes | scalar types only |
| `prop.<key>` | definition `label` | by property type | yes | scalar types only |

Cell rendering by value type (facet field type or property type; same renderer):

| Type | Table cell | Notes |
|---|---|---|
| `text` | text, wraps | `overflow-wrap: anywhere` (phone-layout 2.3) |
| `longtext` (session summary) | text clamped to 2 lines in the table, 4 in a card | full text is on the page; no expander |
| `number` | right aligned, `tabular-nums` | header right aligned too |
| `select` | `.cn-badge-plain` | text, never colour alone |
| `multiselect` | `.cn-badge-plain` chips in a wrapping row | |
| `date` | locale short date (`<time datetime="YYYY-MM-DD">`; year shown when not the current year) | sorts by the ISO value |
| `checkbox` | visible text "Yes" or "No" (muted for No) | not a ticked box glyph alone |
| `pageLink` | link to the page, text = its title from the campaign store (`store.byId`) | **if the page is not in the store, render the empty cell, never the id** |
| `refLink` | the reference name, linking like the existing properties panel does | resolved with the same helper the properties panel uses; falls back to the empty cell. Q4 |
| `url` | link, text = host, `rel="noopener noreferrer"`, only `http(s)`/`mailto` (the value is already validated) | |
| empty / null | `—` (aria-hidden) plus `<span class="sr-only">empty</span>` | screen readers say "empty", not "dash" |
| unknown key (property deleted, field of another type) | the empty cell | the column itself stays, see 4.5 |

## 3. Layouts

Containers, not viewports, decide the layout: the block can sit in a Columns block or the narrow page layout. Put `container-type: inline-size` (Tailwind `@container`) on the block wrapper (`.cn-embed` of the query block, one element, not on the table wrapper). Tailwind v4's named container sizes do **not** match our breakpoint (`@sm` is 24rem, `@lg` is 32rem), so use arbitrary values (`@min-[30rem]:` and `@max-[29.99rem]:`) or one plain `@container (min-width: 30rem)` rule in `styles.css`. Container breakpoints below: **narrow** under 30rem (480 px), **wide** from 30rem. The `touch:` variant of phone-layout (viewport width and pointer) is separate from this container-based narrow/wide: touch sizes (44 px) follow the device, layout follows the container, and the two never replace each other. A 390 px phone gives a content width of about 358 px, so it is always narrow; a desktop page body (prose width, roughly 45 to 50rem) is wide.

### 3.1 Block frame (all views)

```
+--------------------------------------------------------------+
| Title of the query (optional)                    [Configure] |  <- Configure only in the editor
+--------------------------------------------------------------+
| ... the view ...                                             |
+--------------------------------------------------------------+
| 12 pages                       Showing the first 100 of more |  <- footer, 0.8125rem, --muted
+--------------------------------------------------------------+
```

- The frame is today's `.cn-embed` (border `--line`, panel background). Title stays the block's `title` attr.
- The footer is `<p role="status">`: "12 pages" (singular "1 page"). When `rows.length === filter.limit` it adds "Showing the first 100. Narrow the filters to see others." because the server cut the list (the client cannot know more exist, so the wording says "the first 100" only at the limit). The status element is also the sort announcer (section 7.4).
- In the editor the title input and Configure button stay as they are (the Configure button becomes 44 px on touch).

### 3.2 List (unchanged)

`<ul class="cn-query-results">` of icon + title links. The only changes: `aria-label` on the `ul` (query title, else "Query results"), 44 px high link rows on touch, the footer and the new states. Rows keep `track row.id`.

### 3.3 Table, wide (desktop, container at least 30rem)

```
+--------------------------------------------------------------------------+
| NPCs in Neverwinter                                         [Configure]  |
+--------------------------------------------------------------------------+
| Title                  v Status      Attitude     Faction       Updated   |
|------------------------+-------------+------------+-------------+--------|
| [npc] Sildar Hallwinter  Alive        Friendly     Lords'...     Oct 12   |
| [npc] Gundren Rockseeker Missing      Neutral      —             Oct 09   |
| [npc] Nezznar            Alive        Hostile      Black Spider  Sep 30   |
+--------------------------------------------------------------------------+
| 3 pages                                                                  |
+--------------------------------------------------------------------------+
```

- `<table>` `width: 100%`, `table-layout: auto`, `border-collapse: collapse`. Title column `min-width: 12rem`; other columns `min-width: 6rem`; cells wrap.
- Wrapper `overflow-x: auto` with `tabindex="0"`, `role="region"` and a short constant `aria-label="Scrollable table"` (the table's own name comes from its caption, so the title is not announced twice; keyboard users can scroll it; axe `scrollable-region-focusable`). Focus ring is the global `--focus` outline.
- Header cells: `padding: 0.5rem 0.75rem`, `font-size: 0.8125rem`, weight 600, colour `--muted`, background `--panel-2`, bottom border `--line`. The sorted header uses `--ink` and shows ▲ or ▼ (`aria-hidden`, colour `--accent`).
- Body cells: `padding: 0.5rem 0.75rem`, bottom border `--line`, vertical align top. Row hover and the row containing keyboard focus (`tr:hover`, `tr:focus-within`): `background: color-mix(in srgb, var(--panel-2) 60%, transparent)` on ordinary cells. The sticky title cell (3.4) is opaque, so a translucent hover would not show on it: give the sticky cell the **opaque** equivalent for hover and focus, `color-mix(in srgb, var(--panel-2) 60%, var(--panel))`, so the whole row reads as one band. No zebra stripes.
- Title cell is `<th scope="row">` (weight 500, link colour `--link`). Row header semantics matter: a screen reader reading "Status" cell announces the title.
- Number columns: right aligned header and cell.

### 3.4 Table, narrow (container under 30rem, includes 390 px phone)

Same `<table>`, same semantics. Changes only:

- The wrapper scrolls sideways; the page does not (phone-layout D9, WCAG 1.4.10 allows a data table to scroll in two dimensions, and the horizontal scroll is inside a focusable region).
- **Sticky title column**: `th[scope=row]` and the Title header get `position: sticky; left: 0; background: var(--panel)` (header: `--panel-2`), `min-width: 9rem; max-width: 11rem`, and a 1 px right border `--line`. The name of the row therefore stays visible while the other columns scroll.
- Scroll hint: **no fade in 1.3 (deferred, optional)**. The affordance is the focusable, named scroll region, the sticky column's right border and the cut-off next column. If the owner wants a fade later it needs one explicit recipe checked in both themes (a shadow of `color-mix(in srgb, var(--ink) 12%, transparent)` on `--panel`), not a fixed black.
- Header and cell padding stay `0.5rem 0.75rem`; on `touch:` the row minimum height is 44 px (title link has `min-height: 44px; display: inline-flex; align-items: center`).
- Sketch at 390 px (358 px content), columns Title, Status, Attitude, Faction:

```
+------------------------------------+
| NPCs in Neverwinter    [Configure] |
+------------------------------------+
| Title        | Status  Attit... >> |   <- scrolls inside the box
|--------------+---------------------|
| [npc] Sildar | Alive   Friendly    |
| Hallwinter   |                     |
|--------------+---------------------|
| [npc] Gundren| Missing Neutral     |
+------------------------------------+
| 2 pages                            |
+------------------------------------+
```

Why not stacked "label: value" rows by CSS (`display: block` on cells)? Because `display` changes on `table` elements drop their table semantics in several screen readers. Cards are the supported way to get a stacked layout.

### 3.5 Cards

Grid: `grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 1fr)); gap: 0.75rem` (the phone-layout D10 recipe with a smaller minimum). At 390 px that is one column; at a 48rem page body, three.

Card (a `<li>` inside `<ul role="list" class="cn-cards">`; the `ul` has the aria-label as in 3.2):

```
+----------------------------------+
| [npc]  Sildar Hallwinter         |  <- title link, font-display, 1rem, wraps
| Status        Alive              |
| Attitude      Friendly           |
| Faction       Lords' Alliance    |
| Updated       Oct 12             |
+----------------------------------+
```

- Header line: type icon (`aria-hidden`) + title link. Under it a `<dl>` with one `dt`/`dd` pair per column, in column order. `dt`: 0.75rem, `--muted`; `dd`: 0.875rem, `--ink`. Layout of each pair: two columns `minmax(5rem, 38%) 1fr` when the card is wider than 14rem, so the label and value sit on one line. Pairs whose value is empty are **omitted** from the card (a card is not a grid, empty rows are noise); the data is still in the table view.
- The card is one 44 px+ target: the title link stretches over the whole card (`a::after { content: ''; position: absolute; inset: 0 }` with the card `position: relative`). Links inside the card (`pageLink`, `refLink`, `url`) get `position: relative; z-index: 1` so they stay separately clickable.
- Card surface: background `--panel`, border `1px solid var(--line)`, radius `0.5rem`, padding `0.75rem`. Hover: border `--accent`. Keyboard focus on the title link draws the ring on the card: `a:focus-visible { outline: none } a:focus-visible::after { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: inherit }`.
- Cards use the same columns as the table. Defaults (empty `columns`) give 3 (5.3). For explicit columns the first 4 are shown in a narrow container, all of them from wide. This keeps a 10-column table from becoming a 700 px tall card on a phone. Q2 (low stakes).
- No images or covers in 1.3 (page covers are not in the query row).

### 3.6 Editor (Configure panel)

The existing panel gains a **Display** section above Types. The panel layout becomes one column below 30rem container width.

```
Configure
 View            (o) List   ( ) Table   ( ) Cards          <- radios in a fieldset
 Columns                                                    <- shown for Table and Cards; hint in List
   1  Status            [Up] [Down] [Remove]
   2  Attitude          [Up] [Down] [Remove]
   3  Statblock  DM only [Up] [Down] [Remove]
      Players will not see this column.
   [ Add a column v ] [Add]
   Reset to default columns
 Default sort    [ Title A to Z v ]   ( ) Ascending ( ) Descending
 Types / Tags / Relation   (unchanged)
```

Details are in section 4.

## 4. The column picker

### 4.1 Where and when

The existing Configure panel styles bare `input`/`select` through `.cn-query-config input, .cn-query-config select` (no classes, 0.2rem padding, `min-width: 10rem`). The picker does not rely on that: its select, buttons and radios use `.cn-input` and `.cn-btn` from phone-layout 2.2 (16 px text and 44 px height on touch). I2.2 may migrate the old controls to the same classes in the same panel so the panel is consistent, but need not.


Inside the editor's Configure panel (`QueryView`), because only editors change it. Players never see the picker. In **List** view the Columns group is replaced by the muted line "Switch to Table or Cards to choose columns." (the choice is kept in the block, see 8.3, so switching views loses nothing).

### 4.2 Choices offered

Grouped in the select as `<optgroup>`s, in this order, each option's value is the column key:

1. **Page**: Type, Tags, Updated, Created.
2. **Details**: facet fields. If `filter.types` is empty or has several types, offer the **union by key** (`facet.status` once, even though NPC, Quest, Faction and Session all have a `status`), with the first label as option text. (Optional, deferred: a hint with the types that have the key, e.g. "Status (NPC, Quest, Faction, Session)".) If one type is chosen, offer exactly that type's fields. Pure link/reference fields are included (Faction, Location...).
3. **Properties**: the custom property definitions whose `appliesTo` is null or intersects `filter.types` (or all, when no types are chosen). Option text = `label`, key `prop.<key>`.

Rules:

- Already chosen columns are not offered again.
- DM-only entries (`FACET_DM_ONLY_FIELDS`, definitions with `dmOnly`) are offered **only to the DM**, with a "(DM only)" suffix in the option text. Players who can edit a page (their own character) get neither, because their field and property lists are already filtered (`GET /properties`; facet fields by `FACET_DM_ONLY_FIELDS`).
- Maximum **10** columns (the schema limit). At 10 the select and Add button are disabled and the hint reads "10 columns is the maximum."
- When the select is empty (everything chosen) it is replaced by the hint "All available columns are shown."

### 4.3 Shown-columns list

`<ol aria-label="Columns shown, in order">`. Each `<li>`: position number, label, optional "DM only" badge, and three buttons: **Move up**, **Move down**, **Remove**. Buttons are text buttons ("Up", "Down", "Remove") with an accessible name that includes the column: `aria-label="Move Status up"`, `"Move Status down"`, `"Remove Status"`. Up on the first item and Down on the last use `aria-disabled="true"` (not `disabled`, so focus is not lost while the user is on the button) and do nothing.

Touch: each button `min-height: 44px; min-width: 44px`; the row wraps so on a 390 px phone the label is on the first line and the three buttons on the second (`flex-wrap`, buttons `flex: 1`).

A warning line under a DM-only column: "Players will not see this column." (`--muted`, linked to the row with `aria-describedby`).

### 4.4 Focus and announcements

All announcements go to one polite live region inside the panel.

| Action | Result for focus | Announcement |
|---|---|---|
| Add | focus returns to the select (now showing the next option); new row is the last | "Added Status. 4 columns shown." |
| Remove | focus moves to the Remove button of the item now at that position, or to the previous one, or to the select if none left | "Removed Status. 3 columns shown." |
| Move up/down | focus stays on the same button of the moved item (re-focused after render) | "Status moved to position 2 of 4." |
| At the end (aria-disabled press) | none | "Status is already first." / "...last." |
| Reset | focus on the Reset button | "Columns reset to the default for these pages." |
| Escape inside the panel | closes Configure, focus on the Configure button | none |

### 4.5 Stale and invalid columns

A key in `columns` can stop resolving: the property was deleted, or the type filter changed so a facet field no longer applies.

- **Editor**: the row stays in the list with the label "Removed property (prop.xyz)" or "Not available for these pages (facet.status)", a warning badge, and its Remove button. The picker never silently drops a key, so editing the filter is not destructive. The read view shows no column for it.
- **Read view**: a column whose key does not resolve to a definition is **not rendered** (no header, no cells). A key that resolves but has no value for a row renders the empty cell.
- Duplicate keys in `columns` render once (first wins).

### 4.6 Default columns ("Reset")

The same function as the empty-`columns` default (5.3). Reset sets `columns` back to `[]`.

## 5. Sorting, empty `columns` defaults

### 5.1 Default sort (persisted)

Today the select has three hard-coded options. It becomes: **"Default sort" = a select of Title, Type, Updated, Created, and every chosen column whose type is scalar (D7), plus the existing fixed "Session number" entry unchanged** (optional cleanup, deferred: later drop it once `facet.number` is choosable from the columns). Next to it two radios Ascending / Descending. Writes `filter.sort = {field, dir}`; default `title`, `asc` as today.

If the chosen sort field is removed from the columns it stays valid (the server sorts on any field), but the select shows it as "Status (not shown)". If it is a non-scalar field (hand-edited JSON or MCP), the read view still gets the server order and the sorted header indicator shows nothing.

### 5.2 Viewer sort (client side)

- Table only. Cards and List have no header and **no viewer sort in 1.3** (deferred, optional: a "Sort by" `<select>` plus a "Reverse order" `aria-pressed` toggle, 44 px on touch, could be added later; Q3).
- Sort control in the table: each sortable `<th>` contains one `<button type="button">` whose text is the column name. Click cycles **ascending, descending, back to default order** (the order the server returned). Only the active column has `aria-sort="ascending|descending"` on its `<th>`; others have no `aria-sort` attribute (per the ARIA authoring practices). The ▲ ▼ glyph is `aria-hidden`.
- The client sorts only the rows it holds (at most `limit`, max 500). It uses the same comparison as `query.ts` `compare` (numbers numerically, strings with `localeCompare(..., {numeric: true, sensitivity: 'base'})`, empty values last in both directions). The key is the **raw value for `type` and `select`** (as the server sorts them, so a header click and the persisted default sort agree) and the **display value** only for what the server cannot sort meaningfully: page links (page title), tags (joined) and multi-selects. When `rows.length === limit` the status text says so: "Sorted by Status, ascending. Only the 100 loaded pages are sorted."
- Ties keep server order (stable sort).
- State lives in a component signal. Not stored, not in the URL (keeps blocks simple; revisit if asked).

### 5.3 Default columns when `columns` is empty

Resolved at render, never written to the document:

- Table: `type`, then up to **3** more: if `filter.types` has exactly one type with details, its first 3 `FACET_FIELDS` that are not `longtext` and not DM-only (NPC: Role, Status, Attitude; Quest: Status, Priority, Quest giver; Session: Session #, Date, Status; Location: Kind, Part of; Faction: Status, Attitude to party, Headquarters; PC: Player, Max HP, AC; Item: none). Otherwise `updatedAt`. If `type` is redundant (exactly one type chosen) it is dropped and `updatedAt` is appended.
- Cards: the same list capped at 3.
- List: no columns.

The cap and the omission keep the first table useful and short, and the author can open the picker to change it.

## 6. States

Same three states in all views, rendered in place of the rows, inside the frame, with the title and footer kept.

| State | Condition | Text and behaviour |
|---|---|---|
| Loading | `results.isLoading()` and no previous value | `aria-busy="true"` on the frame; the view shows a muted line "Loading pages..." (not a skeleton: skeletons would need row counts and cause layout shift). A reload with a previous value keeps the old rows and sets `aria-busy` only. |
| Error | `results.error()` | A bordered notice (`role="alert"`, border `--accent`, text `--ink`): "Could not load these pages." and a `.cn-btn` "Try again" (`results.reload()`), 44 px on touch. Replaces the current silent "No matching pages". |
| Empty | loaded, zero rows | "No matching pages." in `--muted`. In the editor add: "Change the filters in Configure." In the table the whole `<table>` is not rendered (an empty table with headers is noise); in cards and list the `ul` is replaced by the message paragraph. |

Edge cases:

- Table or Cards with zero resolvable columns (all stale): the view renders with Title only (a one-column table) and, in the editor, the Configure panel shows the stale-column warnings. Never an error.
- A player whose query matches only pages they cannot see gets the Empty state, which is indistinguishable from a query with no matches. That is intended: the text must not say "hidden".

## 7. Keyboard, screen reader, touch

### 7.1 Table semantics

```html
<div class="cn-table-wrap" role="region" aria-label="Scrollable table" tabindex="0">
  <table class="cn-table">
    <caption class="cn-table-title">NPCs in Neverwinter</caption>   <!-- the query title; omitted when empty (then `aria-label="Query results"` on the table) -->
    <thead><tr>
      <th scope="col" aria-sort="ascending"><button type="button">Title <span aria-hidden="true">▲</span></button></th>
      <th scope="col"><button type="button">Status</button></th>
    </tr></thead>
    <tbody>
      <tr><th scope="row"><a href="...">Sildar Hallwinter</a></th><td>Alive</td></tr>
    </tbody>
  </table>
</div>
```

- The visible query title becomes the `<caption>` in the Table view (so it is announced as the table name); in List and Cards it is the `aria-label` of the list. The editor's title `<input>` stays above and is not the caption (the caption shows the saved value).
- The wrapper is a named region only because it is the scroll container; it is the sole `role="region"` of the block (landmark noise is small: at most a handful per page).
- Icons (`PAGE_TYPE_ICONS`) are `aria-hidden` when the type column or text follows; the type is also given as visually hidden text in the title cell of Table when no `type` column is present: `<span class="sr-only">NPC: </span>`.

### 7.2 Keyboard

| Where | Keys |
|---|---|
| Table | Tab walks header sort buttons, then links in row order. The scroll region is one Tab stop before the table; arrow keys scroll it when focused. No arrow-key grid navigation (it is not a grid). |
| Sort button | Enter or Space cycle the sort. Focus stays on the button. |
| Cards | Tab walks title links (each card one stop), then inner links. Enter on the title opens the page. |
| Picker | Native controls: radios (arrow keys inside the group), select (arrows, type-ahead, Enter on Add), buttons. Escape closes Configure. |
| Editor | The block is `contenteditable="false"`; Tab enters it and leaves it normally. The existing block menu (`Ctrl+.`) is unaffected. |

### 7.3 Touch (phone-layout D4, D5)

- On `touch:` (the custom variant defined in `phone-layout.md` section 1): sort buttons fill their header cell and are at least 44 px high; title links 44 px; View radios as three 44 px segments; picker buttons 44 px; select and inputs from `.cn-input` (16 px text, 44 px high); the Configure button 44 px.
- Links inside cells (page links, refs) are secondary targets: 24 px minimum with the cell's own padding between them. Cards are a single 44 px+ target; inner links keep their own hit area.
- Text is rem; targets are px. Check at 200 % text: the table scrolls, cards drop to one column by themselves, nothing is cut.

### 7.4 Announcing sort and results

The footer `role="status"` carries "Sorted by Status, ascending." (after a viewer sort) in addition to the count, so the change is announced without moving focus. The count is announced only when it changes from the previous load, not on first render.

## 8. Persisted block attributes

### 8.1 The attrs

| Attr | Type | Default | Notes |
|---|---|---|---|
| `title` | string, max 120 | `''` | unchanged |
| `filter` | `queryFilterSchema` | empty filter | unchanged; `filter.sort` is the **default sort** |
| `view` | `'list' \| 'table' \| 'cards'` | `'list'` | **already in** `registry.ts` and in the TipTap node |
| `columns` | `string[]`, max 10, each max 80 | `[]` | **already in** both |

No new attr in 1.3. Viewer sort is not persisted (5.2). Column widths, row density and per-column sort direction are explicitly out (Q5).

Schema tightening for I2.2 (non-breaking): validate each `columns` entry against the key grammar `^(type|tags|updatedAt|createdAt|facet\.[A-Za-z0-9_]+|prop\.[A-Za-z0-9_]+)$` with a max of 80 characters. `title` is not allowed in `columns` (it is implicit); the renderer ignores it if present. An entry that fails the grammar makes the **sanitizer repair the whole attrs object to defaults** today (`safeParse` fails, `def.attrs.parse({})`), which would wipe the filter. So use a `.catch()`/filter on the array (drop bad entries, keep the rest) instead of rejecting: `columns: z.array(z.string().max(80)).max(10).transform(drop invalid)` style, tested in `blocks.test.ts`.

### 8.2 Existing blocks that only have the list view

- Stored blocks have `view` and `columns` or not; either way **nothing is migrated and `SCHEMA_VERSION` stays 1** because the change is additive with defaults. Reads treat a missing, `null` or unknown `view` as `list` and a missing or non-array `columns` as `[]` (the read-only `QueryBlock` reads `n.attrs` raw, projected docs do not pass the sanitizer again, so it must apply the fallback itself).
- Rendering of an old block is byte-for-byte the List view of today (plus the aria-label, footer and the new states). Nobody's page changes until an author picks Table or Cards.
- First switch from List to Table writes `view: 'table'` only. `columns` stays `[]` so the table uses the defaults of 5.3 and keeps following the type filter. Choosing a column writes the explicit list.
- Rollback / downgrade safety: an older build that does not know `table` or `cards` would ignore the attr and show a list, since the node attrs are strings and the renderer ignores them. The data stays valid in the old schema (`z.enum` there already lists all three).
- Export/markdown: queries are evaluated live; the markdown serializer (`packages/blocks/src/markdown`) needs no change; I2.2 confirms it does not break on the two extra attrs (a unit test round trip).
- MCP page tools that write bodies: `view` and `columns` pass through the same sanitizer; no tool change.

### 8.3 Switching views is non-destructive

`columns` is kept when `view` goes back to `list`. The same `columns` serve both Table and Cards.

## 9. What players see

Principle (PROJECT §4): the server is the boundary; the client never relies on hiding.

| Item | Rule | Status today |
|---|---|---|
| Rows | Only pages the player can see, filtered and sorted over projected data. Unchanged. | done (`queryFor`) |
| Cell values | Only what the projected row contains: no DM-only property values, no DM-only facet fields, facet page links to unseen pages are null. The renderer reads only the row; it never calls another endpoint for hidden data. | done for facets and `props` by definition |
| Property **page links** to unseen pages | `props` of type `pageLink` still carry the unseen page's id in the response (only facets are cleared). The renderer shows the empty cell (no store entry), but the id should not be sent either. **I2.2 server change**: clear `pageLink` property values whose target the viewer cannot see, as `projectFacetForPlayers` does for facets. Add to the sentinel test. | gap, small |
| Columns that name DM-only keys | `columns` and `filter.sort.field` are attrs inside the page body that players receive. **I2.2 server change**: the `query` block gets a `project` hook (the registry already supports `project`) that removes from `columns` any key that is DM-only for the viewer and resets `filter.sort` to the default if its field is DM-only. This needs `ProjectContext` to carry `isHiddenField(field): boolean` (built from `FACET_DM_ONLY_FIELDS` and `properties.list().filter(dmOnly)`), the same way it already carries `canSeePage`. Without it a property's key name (for example `prop.secret_motive`) is sent to players even though its values are not. | gap |
| Header labels | The renderer takes labels only from `FACET_FIELDS` and from `GET /properties`, which for players omits DM-only definitions. A column key with no resolvable definition renders nothing (4.5), so a key that slipped through never produces a header. | by design |
| Picker | Editors only. A player who can edit their own page sees only the fields and properties they may see, with no "DM only" entries (4.2). | by design |
| Empty text | Identical for "no matches" and "everything matching is hidden" (6). | by design |
| pc facet `playerUserId` (existing behaviour) | `playerUserId` is not in `FACET_DM_ONLY_FIELDS` (`updateAsPlayer` rejects it as DM-only), so it travels in player query rows and facet. Not rendered by I2 (it is not a `FACET_FIELDS` entry, so not pickable), but flagged as a security follow-up outside I2. | pre-existing |
| `where` conditions on DM-only fields (existing behaviour) | Evaluated over projected rows, so for a player a condition on a hidden property sees `null` and, for `empty`/`neq`, can match more pages than the DM sees. The condition itself is in the attrs players receive. Not changed by I2 (Q6). | pre-existing |

Tests for I2.2 / I2.3 (in the plan, not written now): add to `apps/server/test/visibility.test.ts` a page whose query block lists a DM-only property column and a DM-only facet column (sentinel strings in the property key, label and value; `statblockUid`) and assert the player's `GET /pages/:id` body and `/query` response contain none of the sentinels; add a `pageLink` property to an unseen page and assert the id is absent. Also: a blocks unit test for the new `project` hook; `ProjectContext.isHiddenField` is **optional** (other `projectDoc` callers, such as exports and the merge, do not pass it and behave as today); and a test that a player saving a page does **not** strip the DM's hidden columns: the merge (`mergePlayerEdit`) must keep the stored `columns` and `filter.sort` of a query block the player edited, because the player's copy was cleaned by the hook.

## 10. Components and CSS (for I2.2)

- One standalone OnPush component `cn-query-results` (new file next to `QueryBlock`, used by both `QueryBlock` and `QueryView`) with inputs `rows`, `view`, `columns`, `filter`, `title`, `loading`, `error`, `editing`; it owns the templates for List, Table, Cards, states and viewer sort. The picker is a second component, `cn-query-columns`, used only inside `QueryView`'s Configure panel. Request logic stays in the host components (`httpResource`). `QueryBlock` gains `view` and `columns` inputs and `block-view.html` passes `n.attrs?.['view']` and `n.attrs?.['columns']`.
- The properties list for headers and the picker comes from the existing properties request (the properties panel already loads it; reuse its store or service rather than a third `httpResource`). Players get the filtered list.
- CSS goes in `styles.css` next to `.cn-query-*`, using only existing tokens: `--panel`, `--panel-2`, `--ink`, `--muted`, `--line`, `--control` (field borders), `--accent`, `--link`, `--focus`, `.cn-input`, `.cn-btn` (phone-layout 2.2). The existing `.cn-badge` (uppercase, bold, `nowrap`, `currentColor` border, 0.75rem) is built for the legacy/modern edition labels and is wrong in a data cell. Add a quiet variant `.cn-badge-plain`: sentence case (`text-transform: none`), weight 400, `white-space: normal`, wrapping chips (`flex-wrap` on the cell's chip row, `gap: 0.25rem`), 1 px `--line` border, text `--ink` on `--panel-2`. Pairing is `--ink` on `--panel-2` in both themes (the same pair the properties panel uses); I2.2 verifies 4.5:1 for the chips and for `--muted` on `--panel-2` headers with axe in light and dark. New classes: `.cn-table-wrap`, `.cn-table`, `.cn-cards`, `.cn-card`, `.cn-badge-plain`, `.cn-query-state`, `.cn-seg` (view radios). Light and dark need no extra rules because every colour is a token; the only computed colours are `color-mix` of tokens (row hover and focus).
- No `innerHTML`, no `bypassSecurityTrust*`; all values go through interpolation; links are `routerLink` or validated `http(s)`/`mailto` hrefs with `rel="noopener noreferrer"`.
- Performance (feeds I2.3): rendering at most 500 rows by 10 columns is plain DOM with `@for ... track row.id`; no virtual scroll in 1.3. Viewer sort is O(n log n) on at most 500 rows. If I2.3 shows slow rendering above 200 rows, add `content-visibility: auto` on `tbody tr` first.

## 11. Acceptance checks for I2.2 / QA

1. An old block (no `view`, no `columns`) renders exactly as today, in editor and read-only, after load and after a save round trip; sanitizer output has `view: 'list'`.
2. Table, Cards, List switch in Configure and persist after reload; `columns` survive a switch to List and back.
3. Column picker: add, remove, move; 10-column cap; stale keys shown with warnings; announcements fire (Playwright with `aria-live` text checks); focus rules of 4.4.
4. Table semantics: caption, `th scope`, one `aria-sort` at a time; axe passes in light and dark at 1280 and 390 px.
5. 390 px: no sideways page scroll, table scrolls inside its region, sticky title column, 44 px sort buttons and title links (`touch` project in Playwright), 200 % text.
6. Players: sentinel crawl described in section 9; the player's table has no DM-only column, no hidden id, same rows as the projected query.
7. Empty, loading, error states each reachable (error via a forced 500 route).
8. Keyboard only: tab order, Enter/Space on sort, Escape from Configure returns focus.

## 12. Open questions

Owner decisions (with a recommendation): Q1, Q3, Q5, Q6, Q7. Q2 is low stakes. Q4 is for the developer to answer.

- **Q1 (owner). Phone default for tables.** Decision taken: tables stay tables and scroll with a sticky title column. Alternative: below 30rem automatically render Cards (the usual mobile choice, no sideways scroll, but the author's "Table" is not what a player on a phone sees). Recommendation: keep as designed; authors who care pick Cards.
- **Q2 (low stakes). Fields per card on a narrow container.** Cap at 4 columns, or show all chosen columns? Recommendation: cap at 4 on narrow containers.
- **Q3 (owner). Sort control on Cards.** Deferred in this design. Add the "Sort by" select and reverse toggle later, or never? Recommendation: defer until players ask.
- **Q4 (developer). Reference links in cells.** Is there a cheap synchronous name for a reference uid (`speciesUid`, `backgroundUid`, `itemUid`) on the client, or does it need a lookup per row? If not cheap, I2.2 shows the empty cell for `refLink` columns and omits `refLink` fields from the picker until a batch name lookup exists.
- **Q5 (owner). Out of scope, confirm:** drag and drop reordering, column widths, saving the viewer sort, grouping rows, inline editing of cells, CSV export of a query.
- **Q6 (owner). `where` conditions on DM-only fields for players.** Pre-existing, outside I2: should the `query` block `project` hook also drop such conditions (changing what a player's list contains vs the DM's) or leave them? Recommendation: leave as is and raise with the Product Manager; I2.2 should not change filter semantics. Also raise the `playerUserId` follow-up.
- **Q7 (owner). Server change inside I2.2.** The `project` hook with `isHiddenField` and the player `pageLink` property clearing (section 9) touch `packages/blocks` and `pages.ts`, beyond "the server already projects query rows". Confirm they belong to I2.2 rather than a separate security task (recommendation: inside I2.2, they are small and must ship with the feature).
