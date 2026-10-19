# Phone layout guidance

Task M6.2 · Owner: UX Architect · Implementers: Frontend Developer (M6.3, M6.4) · QA: UI Designer · Date: 2026-10-19

Design only. No application code changed. Inputs: `docs/qa/phone-audit.md` (M6.1, 16 issues plus the 320 px, landscape, text zoom and axe runs), `docs/PROJECT.md` §4 (rules) and M6.2 to M6.5, `docs/PRD.md` §8 M6, the existing code in `apps/web/src/app` (`app.html`, `app.ts`, `campaign/campaign-shell.ts`, `campaign/undo-toast.ts`, `play/inventory-page.ts`, `play/tracker-player.ts`, `campaigns/campaign-list.ts`, `campaign/page-editor.html`, `campaign/facet-form.ts`, `styles.css`). Format follows `docs/design/trash-ui.md` and `docs/design/admin-users-ui.md`. No new library: Angular standalone, signals, OnPush, zoneless, Tailwind v4.1 tokens from `styles.css`, no `innerHTML`, light and dark themes through the existing tokens (`bg-panel`, `border-line`, `text-muted`, `text-accent`, `bg-bg`, `--color-focus`). Never hard-code a colour.

## 0. Decisions in one page

| # | Decision | Why |
|---|---|---|
| D1 | **Minimum supported width 320 CSS px**, portrait and landscape phones, up to 200 % text. Reflow rule: no sideways page scroll at 320 (WCAG 1.4.10). | The header alone needs 369 px today; 320 is the audit's proposal and the only value that also fixes 360. |
| D2 | **Two header tiers.** Below `lg` (1024 px) the header is the compact one-row header of section 3. At `lg` and up the existing inline header stays as it is (desktop is out of scope). Landscape phones (844 px wide) are below `lg`, so they get the compact header too. | One breakpoint instead of a width plus a height rule. |
| D3 | **Header height is fixed in px, not rem**: 56 px (portrait phones and tablets), 48 px in short landscape. One row, never wraps, at any text size. | The audit measured 159-199 px and up to 483 px at 200 % text. |
| D4 | **Touch targets are px, text is rem.** Primary actions are at least 44 x 44 CSS px; secondary controls at least 24 px with spacing. Applies to every touch device (`pointer: coarse`) or any width below 640 px, so landscape phones are covered. | Landscape phones are wider than `sm`, so a width-only rule misses them. |
| D5 | **Form text is 16 px or more on touch** (iOS Safari zooms on focus below 16 px), control height 44 px, shared classes `.cn-input`, `.cn-btn`, `.cn-btn-primary` in `styles.css` instead of copy-pasted utilities. | Audit #10, #11. |
| D6 | **Lanes, not a pile, for overlays.** The dice log is a popover under the header (never a fixed bottom panel). Dice result toast: top lane under the header on phones, bottom right from `sm`. Undo/notice toast: bottom lane. Nothing else may be `fixed` at the bottom. A new roll never shows a toast while the log is open. | Audit #6; avoids a shared-state stack between the app shell and the campaign shell. |
| D7 | **One z-index scale** (section 2.6). | Audit stacking section. |
| D8 | **Safe areas:** keep `viewport-fit` at its default (do not add `cover`), add `interactive-widget=resizes-content`, and write `env(safe-area-inset-*)` into the fixed elements anyway (it resolves to 0 today). | See section 2.5. |
| D9 | Long text wraps inside its box (`overflow-wrap: anywhere`); wide things (tables, statblocks, code) scroll inside their own `overflow-x-auto` wrapper. The page never scrolls sideways. | Audit #12, #13. |
| D10 | Card lists beat tables on narrow screens (inventory). Grids use `minmax(min(100%, Nrem), 1fr)` so rem-based minimums react to text zoom. | Audit #9, 200 % text run. |

## 1. Tiers and breakpoints

Tailwind v4 defaults are kept (`sm` 640, `md` 768, `lg` 1024, `xl` 1280). Phone work uses these names:

| Name | Condition | Tailwind | Used for |
|---|---|---|---|
| phone | width < 640 | `max-sm:` | stacking, full-width buttons, collapsed panels |
| compact header | width < 1024 | `max-lg:` / `lg:hidden` | header of section 3, campaign drawer (already `max-lg`) |
| touch | `pointer: coarse` or width < 640 | `touch:` (custom variant below) | 44 px targets, 16 px form text |
| short | landscape and height <= 500 px | `short:` (custom variant below) | 48 px header, two-column drawer nav |

Add to `apps/web/src/styles.css` next to the existing `@custom-variant dark`:

```css
@custom-variant touch (@media (pointer: coarse), (max-width: 639.98px));
@custom-variant short (@media (orientation: landscape) and (max-height: 500px));
```

Rules that follow from this:

- Mobile first: write the phone layout without prefix, add `sm:` / `lg:` for wider. Exception: where the existing code is desktop-first (`max-lg:` on the drawer), leave it.
- **Phone landscape (844 x 390, 667 x 375)** is `sm` and `md` wide, below `lg`, `touch` and `short`. It gets: sm-style 2-column content, compact header at 48 px, 44 px targets, two-column drawer navigation.
- **Tablet portrait (768)** is compact header, `sm` content, `touch`. Desktop windows narrower than 1024 get the compact header too (acceptable: one extra tap into the menu).
- Card grids: `grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))]` instead of `sm:grid-cols-2`, so a 200 % text size on a 640 px viewport drops to one column by itself.
- Do not set `maximum-scale` or `user-scalable=no` on the viewport meta (blocks zoom, fails WCAG 1.4.4).

## 2. Foundations (all in `apps/web/src/styles.css`, `apps/web/src/index.html`)

### 2.1 Tokens

```css
:root {
  --cn-tap: 44px;        /* minimum primary target */
  --cn-header-h: 56px;   /* compact header height, used to offset the top toast */
}
@media (orientation: landscape) and (max-height: 500px) {
  :root { --cn-header-h: 48px; }
}
```

Use `min-h-[44px] min-w-[44px]` (px) for targets, not `min-h-11` (rem, 2.75rem), because at 200 % text `min-h-11` becomes 88 px and four header buttons no longer fit in 320 px. Text, padding inside cards and gaps stay rem.

### 2.2 Shared form and button classes

Replace the per-file utility strings in `auth/*.ts`, `invites/invite-page.ts`, `account/account-page.ts`, `campaigns/campaign-list.ts`, `play/inventory-page.ts`, `campaign/facet-form.ts` and `.cn-prop-input` with these. Plain CSS like the rest of `styles.css` (no `@apply`).

```css
.cn-input, .cn-prop-input {
  width: 100%;
  border: 1px solid var(--color-line);
  border-radius: 0.375rem;
  background: var(--color-bg);
  color: var(--color-ink);
  padding: 0.375rem 0.625rem;
  font-size: 0.875rem;
  line-height: 1.4;
}
.cn-btn, .cn-btn-primary {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem;
  border-radius: 0.375rem; padding: 0.5rem 0.875rem;
  font-size: 0.875rem; font-weight: 500;
}
.cn-btn { border: 1px solid var(--color-line); background: transparent; color: var(--color-ink); }
.cn-btn:hover { border-color: var(--color-accent); }
.cn-btn-primary { background: var(--color-accent); color: var(--color-accent-ink); border: 1px solid transparent; }
.cn-btn:disabled, .cn-btn-primary:disabled { opacity: 0.6; }

@media (pointer: coarse), (max-width: 639.98px) {
  .cn-input, .cn-prop-input, select.cn-input, select.cn-prop-input { min-height: 44px; font-size: 1rem; }
  textarea.cn-input { min-height: 5.5rem; }
  .cn-btn, .cn-btn-primary { min-height: 44px; min-width: 44px; font-size: 1rem; }
  input[type='checkbox'], input[type='radio'] { width: 1.5rem; height: 1.5rem; accent-color: var(--color-accent); }
  .cn-badge { font-size: 0.75rem; }
}
.cn-badge { font-size: 0.75rem; } /* was 0.68rem = 10.9 px; floor is 12 px everywhere (audit #15) */
```

Details:

- `.cn-prop-input` keeps its name (used by `properties-panel.ts`, `inventory-page.ts`); it inherits the new rule. Put all the `.cn-input`, `.cn-btn` rules above (including the media block) inside `@layer components { ... }`, so Tailwind utilities such as `w-24`, `w-full` or `sm:w-20` on the same element win. (Do not layer the `fieldset:disabled` rule of 6.1.)
- 16 px applies to `input`, `select`, `textarea` (iOS zooms on all three). The `font-size: 1rem` lives in the `touch` media block; on a desktop browser narrowed to 360 px the width clause makes it 16 px as well, which is fine.
- Checkboxes and radios: the control is 24 px, the **label** around it is the 44 px target (`<label class="flex min-h-[44px] items-center gap-3">`). Never leave a bare 13 px checkbox (header "Legacy" box, inventory "attuned").
- Buttons that were `px-2 py-0.5` (Add, Spend, "Add" custom item, "Save name", "Change password", "Leave this campaign", "Sign in", "Create account and join", "Go to sign in", reset submit) become `.cn-btn` or `.cn-btn-primary`. On phone, form submit buttons are `w-full`: `class="cn-btn-primary w-full sm:w-auto"`.
- Autofill and keyboards: add `inputmode="numeric"` to quantity, coin amount, level and ability score inputs; `autocapitalize="off" autocorrect="off" spellcheck="false"` stays on username and token fields. Leave `type="number"` where it is.

### 2.3 Long text and wide content

```css
.cn-prose, .cn-block-view, h1, h2, h3, h4, .cn-wrap { overflow-wrap: anywhere; }
.cn-prose table, .cn-prose pre { display: block; max-width: 100%; overflow-x: auto; }
.cn-prose img, .cn-prose video { max-width: 100%; height: auto; }
```

(Use the real class names of the block view container; `.cn-prose` exists at `styles.css:91`.) `overflow-wrap: anywhere` (not `break-word`) also lowers the min-content width, so flex children with `min-w-0` shrink instead of pushing the layout. Tailwind v4.1 has the utility `wrap-anywhere` for single elements. Titles, card names and list rows never use `truncate` for a name a player must read (the trash design says the same); `truncate` is allowed only where the full text is on the same screen elsewhere (the header campaign name; the full name is in the drawer).

### 2.4 Text zoom (150 % and 200 %)

Rules, because the audit's header growth (552/736 px documents) came from rem-based widths that cannot shrink:

1. Anything in a flex row gets `min-w-0` (and `flex-1` for the text). Anything that must not shrink is an icon button of fixed px size.
2. No `w-<n>` rem widths on header or nav items. Widths in a header row come from px buttons plus one `flex-1 min-w-0` text slot.
3. At 200 % text the header stays one row of 56 px: the text slot truncates, buttons do not grow (px).
4. Content wraps. A page may become longer, never wider. `main` is the only scroller and scrolls vertically only.
5. Line length: prose container `max-w-prose` or `max-w-4xl`, never wider than the viewport minus gutters (`p-4`).
6. Two-column layouts use the auto-fill grid of section 1, not `sm:grid-cols-2`.

### 2.5 Safe areas and viewport

`apps/web/src/index.html`, replace the meta tag with:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content" />
```

- **`viewport-fit`: do not add `cover`.** Without `cover` (the default `auto`) iOS Safari keeps all page content inside the safe area on every side and in both orientations, which is the behaviour the audit saw. Nothing in the app draws edge to edge, so `cover` gains nothing and would force every fixed element to be padded. Revisit only if a full-bleed table screen is wanted (then also add the padding below, which is why it is specified now).
- **`env()` anyway.** Fixed or edge-hugging elements add `max()` padding with the safe inset so switching to `cover` later is one line. Values resolve to `0` today, so nothing changes visually:
  - Header: `pt-[env(safe-area-inset-top)] pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))]` (with `min-h-[calc(56px+env(safe-area-inset-top))]` if `cover` is ever turned on; today `min-h-[56px]`).
  - Drawer (`aside`): `pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]`.
  - Undo toast and notices: `bottom-[max(0.75rem,env(safe-area-inset-bottom))]`, `left-[max(0.75rem,env(safe-area-inset-left))]`, `right-[max(0.75rem,env(safe-area-inset-right))]`.
  - Dice toast: top lane `top-[calc(var(--cn-header-h)+0.5rem)]`; bottom lane `bottom-[max(0.75rem,env(safe-area-inset-bottom))]`.
  - Combat player screen (no header): `pt-[max(1rem,env(safe-area-inset-top))] px-[max(1rem,env(safe-area-inset-left))]`.
- **`interactive-widget=resizes-content`** makes Android Chrome shrink the layout viewport when the keyboard opens, so the root `h-dvh` column, the editor and the bottom lane fit above the keyboard. iOS Safari ignores the key and keeps its own behaviour (visual viewport scroll). Not testable in desktop emulation; it is a one-attribute change and can be reverted. Owner decision requested (section 9).
- Main scroller: add `scroll-pb-24` (scroll-padding-bottom 6rem) so a focused field scrolls clear of toasts and the keyboard edge. The shell already has `scroll-pb-32` while a toast is shown; keep it, and add `pb-[calc(8rem+env(safe-area-inset-bottom))]` there.

### 2.6 z-index scale

Tailwind v4 accepts any integer (`z-35`, `z-45`). One scale, lowest to highest:

| z | Layer | Today | Change |
|---|---|---|---|
| 10-20 | In-page sticky bars and local menus (tracker-page `z-10`, editor `z-10`, `ref-picker`/`reference-list`/shell "+ New" menu `z-20`) | same | none |
| 30 | **App header and its popovers** (app menu, dice log) | none (header is static, no z) | header gets `relative z-30` |
| 35 | Campaign drawer backdrop | `z-20` | `z-35` |
| 40 | Campaign drawer (`aside`), Sources panel, editor block-menu backdrop | `z-30` / `z-40` / `z-40` | drawer `max-lg:z-40`; others unchanged |
| 45 | Dice result toast | `z-50` | `z-45` |
| 50 | Undo/notice toast, `.cn-block-menu` | `z-50` / `50` | unchanged |
| 60 | Modal dialogs and overlays: command palette, `page-template-dialog`, `template-insert`, `admin/step-up-dialog`, delete and reset-link dialogs; `.cn-suggest` (slash menu) | `z-50` / `60` | dialogs and palette `z-60`; `.cn-suggest` stays 60 |

Why the backdrop must move: once the header is `relative z-30`, a backdrop at 20 would sit under the header, so the header would stay bright and tappable while the drawer is open. Backdrop 35 and drawer 40 cover the header. Opening the drawer, the Sources panel or any dialog closes the header popovers (they are all closed on any route change and on `Escape`).

## 3. Pattern A: the compact header (M6.3)

File: `apps/web/src/app/app.html`, `app.ts`. Fixes audit #1, #2, #3, #5-of-header part, E1 (320), E2 (landscape), E3 (zoom), E6 (admin overflow).

### 3.1 What stays visible, what goes into the menu

Compact tier (below `lg`), left to right, **one row, `flex-nowrap`**:

| Context | Items in the row |
|---|---|
| Signed in, campaign page (`context.campaign()` set) | [1] campaign drawer button, [2] campaign name (link to the campaign overview, `truncate`, takes the free width), [3] search, [4] dice log, [5] app menu |
| Signed in, other page | [1] brand "Critical Notes" (link `/`, takes the free width), [2] search, [3] dice log, [4] app menu |
| Signed out (login, invite, reset) | brand, spacer, theme button (44 px). No menu. |
| Combat player screen | no header (`bare()`, unchanged) |

Everything else moves into the app menu, in this order:

1. **Navigate:** Campaigns, Reference, Homebrew, Templates (see open question Q2 about Templates for players).
2. **Rules:** on campaign pages the line "`<campaign name>` · 2014 rules" as read-only text, then the "Sources…" button, then the cross-edition checkbox row. On other pages: the rules edition `<select>` (16 px, 44 px tall) in a labelled row, then the cross-edition checkbox row, then "Sources…".
3. **Administration** (only `auth.user()?.isAdmin`): Users, Backups.
4. **Preferences:** Theme row (button showing "Theme: System / Light / Dark", cycles with the existing `theme.cycle()`).
5. **Account** (separator above): the signed-in display name (link to `/account`), then Sign out.

On `lg` and up the existing inline header is untouched (nav links, search with the `Ctrl K` hint, campaign label, sources, dice, theme, account, sign out). The nav list is one array in `app.ts` (`navLinks`: label, path, `adminOnly`) iterated by both tiers, so the two cannot drift.

### 3.2 Structure and classes

```html
<header class="relative z-30 flex shrink-0 items-center gap-1 border-b border-line bg-panel
               min-h-[56px] short:min-h-[48px]
               pt-[env(safe-area-inset-top)] pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(0.5rem,env(safe-area-inset-left))]
               lg:min-h-0 lg:flex-wrap lg:gap-3 lg:px-3 lg:py-2">
  <!-- 1. only on campaign pages, below lg -->
  <button type="button" class="cn-hdr-btn lg:hidden" aria-label="Campaign navigation" [attr.aria-expanded]="layout.drawerOpen()" aria-controls="campaign-drawer" (click)="layout.drawerOpen.set(true)"><span aria-hidden="true">☰</span></button>
  <!-- 2. text slot -->
  <a routerLink="/" class="min-w-0 flex-1 truncate font-display text-lg font-bold tracking-tight text-accent lg:flex-none">Critical Notes</a>
  <!-- on campaign pages below lg the text slot is the campaign name instead -->
  ...
</header>
```

with, in `styles.css`:

```css
.cn-hdr-btn {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 44px; min-height: 44px; border-radius: 0.375rem;
  color: var(--color-muted); font-size: 20px; line-height: 1;
}
.cn-hdr-btn:hover { background: var(--color-panel-2); color: var(--color-ink); }
.cn-hdr-btn[aria-expanded='true'] { background: var(--color-panel-2); color: var(--color-ink); }
@media (min-width: 1024px) { .cn-hdr-btn { min-width: 0; min-height: 0; padding: 0.25rem 0.5rem; font-size: 1rem; } }
```

Glyphs are 20 px fixed pictograms (not scaled by text zoom, they carry `aria-hidden` and the button has an `aria-label`). Text in the row (brand, campaign name) uses `text-base`/`text-lg` in rem and truncates.

Visible names that must exist (the e2e suite and screen readers rely on them): `Search (Ctrl K)`, `Dice log`, `Theme: <mode>`, link `Campaigns`, `Reference`, `Users` (admin only), button `Sign out`. In the compact tier these live in the menu; in the `lg` tier they are inline. See section 8 for the e2e consequence.

### 3.3 Width budget (the proof it fits)

Row padding 8 px each side, gap 4 px, buttons 44 px.

| Viewport | Campaign page: free width for the campaign name | Other page: free width for the brand |
|---|---|---|
| 320 | 320 - 16 - 4 x 44 - 4 x 4 = **112 px** | 320 - 16 - 3 x 44 - 3 x 4 = **160 px** ("Critical Notes" at `text-lg` bold is about 125 px, fits at 100 % text) |
| 360 | 152 px | 200 px |
| 390 | 182 px | 230 px |
| 430 | 222 px | 270 px |

At 200 % text the brand and the name truncate with an ellipsis; buttons keep 44 px (px units), so nothing overflows and the height stays 56 px. The full campaign name is in the drawer header (wrapping) and the menu's Rules row.

### 3.4 The app menu (disclosure, not a modal)

- Trigger: `<button class="cn-hdr-btn" aria-label="Menu" aria-expanded aria-controls="app-menu"><span aria-hidden="true">⋯</span></button>`.
- Panel (render with `@if (menuOpen())`; never both a hidden copy and the visible one, so `getByRole` counts stay correct): `<div id="app-menu" class="absolute inset-x-2 top-full z-30 mt-1 max-h-[calc(100dvh-var(--cn-header-h)-0.5rem)] overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-xl sm:inset-x-auto sm:right-2 sm:w-80">`.
- Every row: `<a|button class="flex min-h-[44px] w-full items-center gap-3 rounded-md px-3 text-left text-base hover:bg-panel-2">` and the active route row `bg-panel-2 font-semibold text-ink` plus `aria-current="page"`. Group labels: `<h2 class="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">`. Separator `<hr class="my-1 border-line">`.
- Dismiss: outside tap (a `fixed inset-0 -z-10` sibling inside the header's stacking context catches it), `Escape` (focus returns to the trigger), any route change (`NavigationEnd`, already observed in `app.ts`), opening another popover. Opening it moves focus to the first row. There is no focus trap (it is non-modal); the panel also closes when focus leaves the header and the panel together.
- State: `menuOpen = signal(false)` and `diceLogOpen` in `app.ts`; opening one sets the other to false. Layout state shared with the campaign shell (`drawerOpen`) lives in a small root-provided service (`core/layout.service.ts`, `drawerOpen = signal(false)`), because the shell and the header are siblings, not parent and child.
- Max height with the keyboard-sized viewport (480 px high): the panel scrolls (`overflow-y-auto`); verify the Sign out row is reachable.

### 3.5 Budget summary (M6.3 acceptance numbers)

| Condition | Header height | Share of viewport |
|---|---|---|
| 320-430 portrait, 100 % text | 56 px | 6.6-8 % of 700-844 |
| 320-430 portrait, 200 % text | 56 px (px units) | same |
| Landscape 844 x 390 and 667 x 375 | 48 px | 12-13 % |
| 200 % text, landscape | 48 px | 12-13 % |
| Safe-area top (only if `viewport-fit=cover` is ever used) | 56 px + inset | n/a |

This beats the audit's proposal (at most 56 px, 48 px landscape, at most 15 % of the viewport at 200 % text) with room. A header that grows past 56/48 px at any width or text size fails the check.

## 4. Pattern B: campaign navigation drawer (M6.3)

File: `campaign/campaign-shell.ts`. Fixes audit #3 (drawer rows), #4 (no close control), E2 (landscape drawer).

- The "☰ Campaign" button inside the shell (own row, 30 px, `lg:hidden`) is **removed**; the header's button (section 3) opens the drawer through `LayoutService.drawerOpen`. The shell reads `layout.drawerOpen()` instead of its local `sidebarOpen`. That frees about 44 px of vertical space on every campaign page.
- Drawer `aside`: keep `max-lg:fixed max-lg:inset-y-0 max-lg:left-0`, change z to `max-lg:z-40`, width to `w-72 max-lg:w-[min(20rem,85vw)]`, add `id="campaign-drawer"`, `role="dialog"` only below `lg` is not possible with a static attribute; instead use `[attr.role]="isNarrow() ? 'dialog' : null"` with `aria-modal="true"` and `aria-label="Campaign navigation"`, where `isNarrow` is a `matchMedia('(max-width: 1023.98px)')` signal. On `lg` and up it remains the plain sidebar.
- Scrolling: below `lg` the whole `aside` is one scroller: `max-lg:overflow-y-auto max-lg:overscroll-contain`, and the page-tree region drops its own `min-h-0 flex-1 overflow-y-auto` below `lg` (`lg:min-h-0 lg:flex-1 lg:overflow-y-auto`). Landscape (390 px high) cannot hold a nested scroller plus 13 nav rows.
- Top block (replaces the current one): 
  1. a row with the **close button** (`✕`, `cn-hdr-btn`, `aria-label="Close campaign navigation"`, `lg:hidden`) on the right and the link "← All campaigns" on the left (`flex min-h-[44px] items-center`, `text-sm`);
  2. the campaign name `h2` **without `truncate`**: `font-display text-lg font-bold break-words`, with the ruleset badge after it (wrap allowed).
- Nav rows: `<a class="flex min-h-[44px] items-center gap-2 rounded px-3 text-base text-muted hover:text-ink lg:min-h-0 lg:px-2 lg:py-1 lg:text-sm">`. In `short` the nav list is two columns: `<nav class="flex flex-col p-2 short:grid short:grid-cols-2 short:gap-x-1">`. Active combat row stays first (it spans both columns: `short:col-span-2`), same 44 px height.
- "Pages" header row: the "+ New" button gets `cn-hdr-btn`-sized target (`min-h-[44px] min-w-[44px]`) below `lg`. Its menu (`absolute right-0 z-20`) stays `w-48`; items `min-h-[44px]` on touch.
- Page tree rows (`page-tree.ts`): `min-h-[44px]` on touch for the row link and the expand toggle; indent steps capped so a depth-4 page still leaves 120 px of text at 320 px (indent `pl-3` per level, not `pl-4`).
- Behaviour: opens with focus on the close button; `Escape` and backdrop tap close it and return focus to the header ☰ button; following a link closes it (already true). While open, `main` gets `inert` (set from the shell's host binding) so Tab does not wander behind the backdrop.
- Safe area: `pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]` on the `aside`; the `fixed inset-0` backdrop is `z-35` and `bg-black/30` (works in both themes).
- Do not render the drawer's backdrop at `lg` (`lg:hidden`, already).

## 5. Pattern C: dice result toast and dice log (M6.3, shell)

Files: `app.html`, `app.ts`. Fixes audit #6, #7 (log "clear" button), E7 (Undo/dice overlap), part of #1 (toast fell off the screen because of the widened layout).

### 5.1 Lanes

```
        phone (< sm)                         sm and up
+---------------------------+        +----------------------------------------+
| header 56 px              |        | header                                  |
+---------------------------+        +----------------------------------------+
|  [dice toast, top lane]   |        |                                         |
|  centred, 4 s, no pointer |        |                                         |
|  ...content...            |        |  ...content...                          |
|                           |        |                                         |
| [Undo / notice, bottom]   |        | [Undo toast, bottom left]   [dice toast,|
+---------------------------+        |  max-w-md                    bottom right]
                                     +----------------------------------------+
dice log: popover hanging from the 🎲 button in the header at every width.
```

1. **Dice log** becomes a popover anchored to the header: `<section id="dice-log" aria-label="Dice log" class="absolute right-2 top-full z-30 mt-1 max-h-[min(60dvh,calc(100dvh-var(--cn-header-h)-1rem))] w-[min(20rem,calc(100vw-1rem))] overflow-y-auto rounded-lg border border-line bg-panel p-3 shadow-xl">`. Panel header row: `h2` "Dice log", then two buttons on the right: "Clear" (`cn-btn`, 44 px on touch, `disabled` when empty) and "Close" (`cn-hdr-btn` with `✕`). The list: `<ol role="log" aria-live="polite">`, newest first, rows `flex justify-between gap-3 border-b border-line/60 py-2 text-sm`, the newest row `font-semibold`. Empty state: "Tap or click any dice expression to roll." Dismiss: the 🎲 button, Close, `Escape`, outside tap, route change. The 🎲 button gets `aria-expanded` and `aria-controls="dice-log"`.
2. **Dice result toast** shows only when the log is closed: `@if (toastVisible() && !diceLogOpen() && dice.latest(); as roll)`. When the log is open, the roll appears as the log's first row (announced by `role="log"`), so there is exactly one live announcement per roll. Position:
   - phone: `fixed inset-x-3 top-[calc(var(--cn-header-h)+0.5rem)] z-45 mx-auto flex max-w-xs justify-center pointer-events-none` (the inner card keeps `rounded-lg border border-line bg-panel px-4 py-3 shadow-xl`);
   - `sm` and up: `sm:inset-x-auto sm:top-auto sm:right-[max(1rem,env(safe-area-inset-right))] sm:bottom-[max(1rem,env(safe-area-inset-bottom))] sm:mx-0 sm:max-w-40`.
   Duration stays 4 s. `role="status" aria-live="polite"` stays.
3. **Undo/notice toast** (`campaign/undo-toast.ts`): host class `fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-50 sm:right-auto sm:max-w-md sm:left-[max(1rem,env(safe-area-inset-left))]`. It is the only element allowed in the bottom lane on phones. Its buttons are already `min-h-11`; switch them to `min-h-[44px]` for text zoom. At `sm` the Undo toast (max 448 px, starting at 16 px) and the dice toast (max 160 px from the right) never meet (16 + 448 + 160 + 16 = 640).
4. **Rule for future overlays:** nothing else is `position: fixed` at the bottom edge on a phone. New bottom-edge UI must either join the Undo toast component or use a different edge.

### 5.2 Row cleanup in the same change

- The 🎲 button and every control in the log are 44 px (`cn-hdr-btn`). The log's "clear" is no longer a 27 x 16 text link.
- Landscape: the popover's `max-h` formula above keeps it inside a 390 px viewport (`calc(100dvh - 48px - 1rem)` = 326 px).

## 6. Pattern D: player content views (M6.4)

### 6.1 Page title and reading (audit #12, #13, #15, #16-partly)

File: `campaign/page-editor.html`.

- **Read-only pages** (`!canEdit()`): replace the title `<input readonly>` with `<h1 class="min-w-0 flex-1 font-display text-3xl font-bold [overflow-wrap:anywhere]">{{ p.title }}</h1>`. A player reads "Odessa Quillfeather, Lantern Keeper" in full on two lines. Use `text-2xl sm:text-3xl` below `sm` so one word of 14 characters still fits at 320 (`Quillfeather,` at 24 px is about 140 px).
- **Editable titles**: `<textarea rows="1" class="... resize-none overflow-hidden">` with `(keydown.enter)="$event.preventDefault()"` (single-line semantics) and an `autosize(el)` that sets `el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'` on `input`, after first render and when the value is replaced from the server. (`field-sizing: content` is not used because Safari support was not verified.) Same classes as the h1 (`text-2xl sm:text-3xl`, `[overflow-wrap:anywhere]`). Keep `aria-label="Page title"`.
- **Header row** (icon, title, status): `<header class="flex flex-wrap items-start gap-x-2 gap-y-1">`; icon `w-12 shrink-0`; title `min-w-0 flex-1 basis-40`; the "Saving... / Saved" status becomes `order-last w-full text-xs sm:order-none sm:mt-3 sm:w-auto sm:shrink-0` so it drops below the title on a phone instead of eating 50 px of it.
- **Body text** (`cn-block-view`, `.cn-prose`): `overflow-wrap: anywhere` from section 2.3 fixes the unbroken-word case (#13). Line height at least `1.6` for body text on touch (check `.cn-prose p`); no horizontal scroll inside paragraphs. Tables and `pre` scroll inside their box (section 2.3). Statblock blocks (`cn-statblock`): wrapper `max-w-full overflow-x-auto` is acceptable (a table-like object is one of the two allowed exceptions), but the block must not widen `main`.
- **Breadcrumb**: `flex-wrap` already; links `py-2` on touch (`touch:py-2`) to reach about 32 px; breadcrumbs are secondary navigation (24 px minimum plus spacing satisfied by `gap-x-2`).
- **Details and properties below the title** use the collapse pattern of 6.2 for every page type on a phone, so reading starts near the top.
- **Disabled controls look read-only** (audit #16). Add to `styles.css` (unlayered, so it beats Tailwind utilities without `!important`):

```css
fieldset:disabled :is(input:not([type='checkbox'], [type='radio']), select, textarea) {
  border-color: transparent;
  background: transparent;
  color: var(--color-ink);
  -webkit-text-fill-color: var(--color-ink); /* iOS greys disabled text otherwise */
  opacity: 1;
  appearance: none;          /* hides the select arrow and the number spinner chrome */
  padding-left: 0;
  resize: none;
}
fieldset:disabled input[type='checkbox'], fieldset:disabled input[type='radio'] { opacity: 0.6; }
fieldset:disabled button { display: none; } /* + add class, remove, etc. */
```

  Effect: a player on a shared NPC page sees plain text values (label above, value below, no box), not editable-looking boxes; contrast stays at the ink colour in both themes. Checkboxes and the radio-like pickers stay visible but dimmed. If `facet-form`/`properties-panel` use `aria-disabled` or custom components, give those the same treatment via the `fieldset:disabled` ancestor. Empty values show an en dash via `:placeholder-shown`-free approach: render `-` text in the template when a read-only value is empty (`!canEdit() && !value`), not CSS.

### 6.2 Own character page: stacking of the sheet and properties (audit #8, E2 landscape, keyboard)

Files: `campaign/page-editor.html`, `campaign/facet-form.ts`, `campaign/properties-panel.ts`.

Target: with sheet and properties **collapsed**, the editor starts within the first screen height (at 390 x 844: editor top at most 600 px from the top of the document; today 1188 px).

Phone order (top to bottom): breadcrumb, title row, status, GM toolbar (GM only), **Sheet** `<details>`, **Properties** `<details>`, body (editor or reader), subpages.

1. **Sheet** (`facet-form`, currently an always-open fieldset): wrap in `<details class="mt-3 rounded-xl border border-line bg-panel" [open]="sheetOpen()" (toggle)="sheetOpen.set($any($event.target).open)">`. `sheetOpen` starts as `matchMedia('(min-width: 640px)').matches` (open on `sm` and up, closed on phone), user choice kept for the page in the signal. `<summary class="flex min-h-[44px] cursor-pointer items-center justify-between gap-3 px-3 text-sm">`: left "Character sheet" (for other types: "Details"), right a one-line read-only digest for PC pages, `HP 24/31 · AC 16 · Speed 30 ft` built from the facet value (`text-muted`, `truncate`; hidden when a key is missing). The disabled `<fieldset>` stays inside the `<details>`.
2. **Inside the sheet**, layout rules for `facet-form` (replace `grid gap-x-4 gap-y-2 sm:grid-cols-2`):
   - container `grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-3`;
   - `text`, `select`, `longtext` fields (player, species, background...): `col-span-2 sm:col-span-1` for short text, `col-span-full` for `longtext`;
   - `number`, `date`, `boolean` fields (HP, temp HP, AC, speed, passive perception, inspiration): one cell, so two per row on a phone; the inspiration checkbox is a 44 px label row;
   - all inputs `.cn-input` (44 px, 16 px text);
   - ability scores: keep `grid-cols-3 sm:grid-cols-6`; each cell `text-center`, input `.cn-input text-center`, label `block text-xs font-semibold uppercase`; `inputmode="numeric"`;
   - classes: row `grid grid-cols-[minmax(0,1fr)_4.5rem_44px] items-center gap-2`, class name and level and the remove button on line one, subclass on line two (`col-span-3`); "+ add class" is `cn-btn w-full sm:w-auto`.
3. **Properties** (`<details>` already there, closed by default; keep). Row layout in `properties-panel.ts` (`grid gap-2 sm:grid-cols-[10rem_1fr]`): the label stacks above the value on phone (already single column below `sm`), label `text-sm` (not `text-xs`), delete (`✕`) at 44 px with `touch:opacity-100` (the `opacity-40` hover reveal does not exist on touch). Multi-select chips `rounded-full border px-3 py-2 text-sm` (44 px high on touch, via `touch:min-h-[44px]`). "Open" links `min-h-[44px] inline-flex items-center`.
4. **Editor with the keyboard open:** with `interactive-widget=resizes-content` (2.5) the 56 px header plus the sheet and properties summaries leave about 480 - 56 = 424 px for the editor at the audit's keyboard-sized viewport. The slash menu `.cn-suggest` becomes `width: min(20rem, calc(100vw - 1rem)); max-height: min(20rem, 50dvh);` with items `min-height: 44px` on touch, and stays at z 60 (it may cover the header; accepted by the audit).

### 6.3 Inventory as cards (audit #9, E1 part)

File: `play/inventory-page.ts`. One data-driven list for all widths, no duplicate DOM.

- Section per owner stays (`<section class="mt-4 rounded-xl border border-line bg-panel p-3 sm:p-4">`). Heading row `flex flex-wrap items-center gap-2`, attunement counter `text-sm` (was `text-xs`).
- **Coins:** balances `grid grid-cols-5 gap-1 text-center sm:flex sm:flex-wrap sm:gap-3 sm:text-left` (five 57 px cells fit 320 px). Form below, `mt-2 grid grid-cols-[minmax(0,1fr)_6rem] gap-2 sm:ml-auto sm:flex sm:items-center`: amount `.cn-input` (`inputmode="numeric"`), coin select `.cn-input`. Buttons: `<div class="col-span-2 grid grid-cols-2 gap-2 sm:contents"><button class="cn-btn">Add</button><button class="cn-btn">Spend</button></div>`.
- **Items:** replace `<table>` with `<ul class="mt-2 space-y-2">`; each item:

```html
<li class="rounded-lg border border-line bg-bg p-3">
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <a|span class="font-semibold [overflow-wrap:anywhere]">{{ it.name }}</a> <!-- never truncated -->
      <!-- (unidentified) badge, "from <session>" link: text-xs text-muted, wrap -->
    </div>
    @if (canEditItem) { <button class="cn-btn shrink-0 !px-0" aria-label="Remove {{ it.name }}">✕</button> }
  </div>
  @if (canEditItem) {
    <div class="mt-2 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
      <label class="flex items-center gap-2 text-sm">Qty <input type="number" inputmode="numeric" class="cn-input w-full sm:w-20"></label>
      <label class="flex min-h-[44px] items-center gap-3 text-sm"><input type="checkbox"> Attuned</label>
      <!-- GM only --> <label class="flex min-h-[44px] items-center gap-3 text-sm"><input type="checkbox"> Identified</label>
      <label class="col-span-2 flex flex-col gap-1 text-sm sm:flex-row sm:items-center">Give to <select class="cn-input sm:w-auto">...</select></label>
    </div>
  } @else {
    <p class="mt-1 text-sm text-muted">×{{ it.quantity }}{{ it.attuned ? ' · attuned' : '' }}</p>
  }
</li>
```

  The remove button (about 44 x 44) keeps its `aria-label`. Empty state `<li class="py-2 text-muted">Nothing yet.</li>`. At `sm` and up the same markup renders as a compact wrapping row, so the DM does not lose density; if the DM wants the old table back at `lg` it is a follow-up, not in scope.
- **Add item:** `+ Item` is `cn-btn w-full sm:w-auto`. The picker/custom row `grid gap-2 sm:grid-cols-[1fr_auto]`; custom item form `flex gap-2` with input `min-w-0 flex-1` and a `cn-btn` "Add".
- The card never exceeds the section's border (`min-w-0` on every flex child; the 388-vs-360 style overflow came from non-shrinking cells).
- Landscape: sections are full width, items wrap into 2 columns automatically; no extra rule.

### 6.4 Campaigns list (audit #5, #3 part, #15)

File: `campaigns/campaign-list.ts`. At 360 and 320 the title row (`h1` + two buttons, 388 px) overflows `main`.

- Title row: `<div class="flex flex-wrap items-center justify-between gap-3">`; `h1` `min-w-0 text-3xl` (`text-2xl` below 360 is not needed: "Campaigns" at 30 px is about 140 px); the button group `<span class="flex w-full gap-2 sm:w-auto">` with both buttons `cn-btn`/`cn-btn-primary` and `max-sm:flex-1` so they split the width on a phone and stack under the title. Import is a `<label>` styled as `.cn-btn`; its `sr-only` file input stays focusable (`focus-within:ring`).
- Create form: fields `.cn-input`; the edition radio cards `grid gap-2 sm:grid-cols-2` become the auto-fill grid; submit `cn-btn-primary w-full sm:w-auto`; the cross-edition checkbox row is a 44 px label.
- Campaign cards: grid `grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))]`; name `font-display text-xl font-bold [overflow-wrap:anywhere]` (not truncated); badge 12 px (global `.cn-badge`). Card is one link, whole card is the target (already).
- Check: `main.scrollWidth === main.clientWidth` at 320 and 360.

### 6.5 Forms: sign-in, invite, reset, account (audit #10, #11)

Files: `auth/*.ts`, `invites/invite-page.ts`, `account/account-page.ts`. Rule only; no restructure.

- Inputs: `class="cn-input"` (44 px, 16 px text on touch). Labels stay above the field (`mb-1 block text-sm font-medium`).
- Submit buttons: `cn-btn-primary w-full` (all widths in the narrow auth cards). Secondary actions (`Save name`, `Change password`, `Leave this campaign`, `Go to sign in`): `cn-btn`, `w-full sm:w-auto` on phone.
- Card padding `p-4 sm:p-6` instead of `p-6` so the inner width at 320 is 320 - 32 - 32 - 2 = 254 px (today 240).
- Error text stays `role="alert"`, `text-sm text-accent`, wraps. No fixed `h-` on forms.
- The keyboard case: the form container is `min-h-full` and scrolls in `main`; the submit button must be reachable with the viewport at 480 px high without scrolling more than one screen. (Audit: passes today; keep it that way.)

### 6.6 Dice inline in text (audit #7, E7 part)

Files: `styles.css` (`.cn-roll`, line 298), `reference/render/roll.ts`, `reference/render/entry.html`.

Inline dice sit in running text; a 44 px high inline box would blow up line height. Use an invisible enlarged hit area instead:

```css
.cn-roll { position: relative; }
@media (pointer: coarse), (max-width: 639.98px) {
  .cn-roll::after {
    content: ''; position: absolute;
    inset: -10px -6px;            /* at 16 px text and line-height 1.6 this reaches 44 px tall */
  }
  .cn-prose { line-height: 1.7; } /* gives neighbouring hit areas room; overlaps resolve to the later element */
}
```

- The visible look stays (dotted underline). The role/tabindex/keyboard handlers in `roll.ts` stay.
- Two rolls on adjacent lines overlap by a few px; that is acceptable (the lower line wins). Two rolls on the **same line** keep at least `0.5em` between them (the surrounding text provides it); do not remove spacing in `{@damage}` strings.
- Roll **buttons** that stand alone (the "🎲 roll d6" on roll tables in `entry.html`, the statblock's attack/damage rolls if rendered as separate chips) are real buttons: add `.cn-btn` (44 px on touch).
- The result: the audit's 59 x 18 px target is now 71 x 44 for the hit area. QA cannot see a pseudo-element in `getBoundingClientRect()`: use the `elementFromPoint` check of section 7 or `page.touchscreen.tap` at the offsets.

### 6.7 Combat player screen: the way back (audit #14)

File: `play/tracker-player.ts`. Layout passes at every width; add only:

- A first row above the round line: `<div class="flex min-h-[44px] items-center"><a [routerLink]="['/c', campaignId()]" class="inline-flex min-h-[44px] items-center gap-1 rounded px-2 text-sm text-muted hover:text-ink">← Campaign</a></div>` (not inside a `<header>` element: `e2e/combat.spec.ts:63` asserts the table screen has no `header` containing "Sign out").
- It scrolls away with the page (not sticky), so the second-screen use is not disturbed. It is `text-sm text-muted`, deliberately low-key.
- Wrapper padding `p-4 pt-[max(1rem,env(safe-area-inset-top))] sm:p-8`.
- At 320 and 200 % text: combatant `li` keeps `flex items-center gap-4`; the name slot is `min-w-0 flex-1 [overflow-wrap:anywhere]`; the HP/health chip `shrink-0`; below 360 px the row padding is `px-3` (not `px-5`) to leave room: `px-3 sm:px-5`, `text-lg sm:text-xl`. The initiative cell `w-10` becomes `w-8 sm:w-10`.

## 7. Issue-by-issue mapping

All 16 audit issues plus the extra findings of the second run. "Owner" is the task that implements it.

| # | Issue (severity) | Pattern | Owner | What changes (exact) |
|---|---|---|---|---|
| 1 | Header overflows 8 px at 360 (High) | A | M6.3 | One-row compact header, worst case 304 px of content at 320 (section 3.3); nav moves into the menu. No flex-wrap, `min-w-0` text slot. |
| 2 | Header 159-199 px tall; templates link for players (High) | A | M6.3 | 56 px portrait, 48 px short landscape (px, section 3.5). Templates shown to players: Q2. |
| 3 | Header/nav/drawer targets 28-32 px (Med) | A, B, 2.2 | M6.3 | `cn-hdr-btn` 44 x 44; menu rows `min-h-[44px]`; drawer rows `min-h-[44px]`; "All campaigns" and campaign name row; "Legacy" checkbox becomes a 44 px label row in the menu. |
| 4 | Drawer has no close control (Low) | B | M6.3 | Close button in the drawer top, `Escape`, backdrop tap, focus return. |
| 5 | Campaigns list buttons run past 360 (Med) | D 6.4 | M6.4 | `flex-wrap` title row, buttons `max-sm:flex-1`. Not fixed by M6.3 (the 388 px comes from `main`). |
| 6 | Dice toast covers dice log (Med) | C | M6.3 | Log is a popover under the header; toast hidden while the log is open; lanes top/bottom on phone, bottom left/right from `sm`. |
| 7 | Dice targets 59 x 18, "clear" 27 x 16 (Med) | D 6.6, C | M6.4 (inline, standalone roll buttons), M6.3 (log "Clear"/"Close" in the popover) | `.cn-roll::after` hit area; `.cn-btn` for roll buttons; 44 px log controls. |
| 8 | Own character page stacks 11+ fields, editor far down, keyboard (Med) | D 6.2 | M6.4 | Collapsible Sheet and Properties on phone, digest line, two-column number fields, `interactive-widget`, 16 px inputs. |
| 9 | Inventory controls small and cramped (Med) | D 6.3 | M6.4 | Cards instead of table, 44 px buttons and checkbox labels, coin grid, `min-w-0` everywhere. |
| 10 | Form fields 30-38 px, 14 px text (Low-Med) | 2.2, D 6.5 | M6.3 owns the shared CSS (2.2) in `styles.css`; M6.4 applies it to pages | `.cn-input`: 44 px, 16 px under `touch`. |
| 11 | Primary buttons 32-40 px (Low) | 2.2, D 6.5 | M6.4 | `.cn-btn`/`.cn-btn-primary`, `w-full` on auth cards. |
| 12 | Long page title cut off (Med) | D 6.1 | M6.4 | `h1` for readers, autosizing `textarea` for editors, wrap anywhere. |
| 13 | Long unbroken word cut off (Low) | 2.3, D 6.1 | M6.4 | `overflow-wrap: anywhere` on prose/block view. |
| 14 | Combat player screen has no way back (Low) | D 6.7 | M6.4 | "← Campaign" link row, not a `<header>`. |
| 15 | Smallest text 10.9 px badge (Low) | 2.2 | M6.4 | `.cn-badge { font-size: 0.75rem }`. |
| 16 | Disabled property controls look editable (Low, cosmetic) | D 6.1 | M6.4 | `fieldset:disabled` rules, empty value shown as a dash. |
| E1 | Every page 49 px over at 320 (High) | A | M6.3 | Same as #1; header proof at 320 in 3.3. |
| E2 | Landscape: header 23 % of 390, editor 771 px down (Med) | A, B, D 6.2 | M6.3 (header, drawer two columns), M6.4 (sheet collapse) | 48 px header, `short:` rules, collapsed sheet. |
| E3 | 150 % / 200 % text: document 552/736 px (High) | 2.4, A | M6.3 | px targets, `min-w-0`, one-row header, truncation. |
| E4 | axe: `list`/`listitem` on shared page (serious) | none (not layout) | G1.2 as the audit says; M6.3 may fix it if the offender is the drawer's page tree | Not part of the phone patterns. |
| E5 | axe: `aria-input-field-name` on own character page (serious) | none | G1.2; M6.4 if it is the editor/title control touched in 6.1 | Keep `aria-label="Page title"` on the textarea; name every new input (inventory `aria-label`s stay). |
| E6 | Admin header overflows 35 px at 390 (Users link) | A | M6.3 | `Users` and `Backups` live in the menu's Administration group; `cn-admin-nav` in the page body is unchanged. |
| E7 | Dice toast and Undo toast may overlap for ~4 s (not reproduced) | C | M6.3 | Different lanes by construction (section 5.1). |
| E8 | Safe areas not handled | 2.5 | M6.3 | `env()` padding on header/drawer/toasts; no `viewport-fit=cover`. |

## 8. Conflicts with existing screens and tests

| Where | Conflict | Handling |
|---|---|---|
| Admin pages (`admin/users-page.ts`, `backups-page.ts`) | The `Users` link was the 35 px overflow. `AdminNav` (Users/Backups tabs in the page body) duplicates the menu group. Dialogs are `z-50` (step-up, delete, reset-link). | Keep `AdminNav`. Menu group "Administration" adds Users and Backups. Move the admin dialogs to `z-60`. The deferred "pin the dialog footer at 390 px" follow-up is out of scope here. Admin tables and dialogs are not re-audited; M6.3 QA still runs the overflow check on `/admin/users` and `/admin/backups` (section 9). |
| DM views (encounters, tracker page, encounter builder, reference browser, templates, trash, settings) | They are desktop-first; the header change does not touch their `main` content. Sticky bars inside `main` (`tracker-page` `z-10`, `reference-list` `z-20`) scroll under the header only inside the scroller, header is outside it. | No change required. Their requirement is "no sideways page scroll at 360 and 320 once the header no longer causes it"; they are not re-laid-out. |
| `e2e/*.spec.ts` | Run at 1440 x 1000 (`lg` tier). `admin.spec.ts` expects the `Users` link absent for non-admins; `campaign.spec.ts:77` clicks `Sign out`; `combat.spec.ts:63` expects no `header` containing "Sign out" on the table screen. | At 1440 the desktop tier is unchanged, so these pass. The app menu panel is rendered only when open, never as a hidden duplicate, so `getByRole` counts stay right. The combat back link must not be in a `<header>`. M6.5's phone project must open the menu before clicking "Sign out". |
| Command palette (`Ctrl K`) | Search button changes from text to icon below `lg`. | Same handler (`paletteOpen.set(true)`), same accessible name `Search (Ctrl K)`. |
| `bare()` routes (combat player view) | No header. | Unchanged; its own back link (6.7). |
| Campaign shell `pb-32` under a toast | Header change does not alter it. | Keep; add the safe-area term. |
| `.cn-block-menu` (z 50), `.cn-suggest` (z 60) | Header becomes z 30, so both stay above it. | None. |
| Tailwind utilities vs `.cn-input` | Unlayered CSS beats utilities. | Put `.cn-input`/`.cn-btn` in `@layer components`; the `fieldset:disabled` rule stays unlayered on purpose. |

## 9. Acceptance checks for M6.3 and M6.4 QA

Run on the built bundle at `isMobile: true, hasTouch: true`, device scale 2, light and dark. Widths: 320, 360, 390, 430 (portrait, 700-844 high); landscape 844 x 390 and 667 x 375; text zoom by `document.documentElement.style.fontSize = '150%'` and `'200%'` at 390 and 320 (stand-in for the browser's text size setting). Pages: `/campaigns`, campaign overview, a shared page (with the long title and long word), own character page, inventory, `/account`, the dice popover open, the menu open, the drawer open, `/admin/users`, `/admin/backups` (as admin). Combat player screen: run the layout checks only.

### 9.1 Layout (all pages, all widths and zoom levels)

```js
const r = await page.evaluate(() => ({
  doc: [document.scrollingElement.scrollWidth, document.scrollingElement.clientWidth],
  main: [document.querySelector('main').scrollWidth, document.querySelector('main').clientWidth],
  header: document.querySelector('header')?.getBoundingClientRect().height ?? 0,
  over: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed').length,
}));
```

Pass: `doc[0] === doc[1]`, `main[0] === main[1]`, `over === 0` (elements inside an `overflow-x-auto` wrapper are excluded from this count).

### 9.2 Header height (M6.3)

| Condition | Pass |
|---|---|
| 320, 360, 390, 430 portrait, 100 % text | header `<= 56` px, exactly one row (all item `top` values within 8 px) |
| 320 and 390, 150 % and 200 % text | header `<= 56` px; document not wider than viewport |
| 844 x 390 and 667 x 375 landscape | header `<= 48` px |
| any of the above | header height as share of viewport `<= 15 %` |
| `lg` (1440 x 1000) | desktop tier unchanged, e2e suite passes |

### 9.3 Tap targets

```js
const small = await page.evaluate(() => [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=menuitem],summary,label:has(input[type=checkbox],input[type=radio])')]
  .filter(e => e.offsetParent !== null && !e.closest('.cn-prose') && !e.closest('[aria-hidden=true]') && !e.classList.contains('sr-only'))
  .map(e => ({ t: e.tagName + ' ' + (e.getAttribute('aria-label') || e.textContent.trim().slice(0, 24)), r: e.getBoundingClientRect() }))
  .filter(x => x.r.width < 44 || x.r.height < 44));
```

Pass: on the header (closed and with the menu open), the drawer (open), the dice popover, the inventory page, the account page, the campaigns list, the auth forms: `small` is empty for primary actions (the audit's tap criterion defines them); the remaining entries must be secondary text links (breadcrumbs, "Sources" is NOT secondary any more: it is in the menu at 44 px) with at least 24 px height and 8 px spacing. Checkbox inputs themselves may be 24 px as long as their label box is 44 px. Inline dice and prose links are measured differently (9.6).

### 9.4 Forms

- Every visible `input`, `select`, `textarea` on the pages above: `parseFloat(getComputedStyle(el).fontSize) >= 16` and `height >= 44` under emulation (excluding `type=checkbox|radio|file|range|hidden`).
- No computed font size below 12 px anywhere on the pages (`.cn-badge` included).
- Keyboard stand-in (viewport 390 x 480, focus the last field of the invite form, the account password form, a character-sheet number field, the inventory coin amount): the focused field and its submit button are both within `0..innerHeight` after `scrollIntoViewIfNeeded`, and the header stays 56 px.

### 9.5 Overlays and stacking (M6.3)

1. Roll a die while the log is closed: toast `bottom` lane at `>= sm`, top lane under the header at < `sm`; toast rect does not intersect the header rect or the Undo toast rect; toast disappears after about 4 s.
2. Open the log, roll: no toast element; the log's first row shows the result; the live region (`role="log"`) contains it.
3. Delete a page (GM) and roll within the 4 s: Undo toast bottom, dice toast top (phone) or right (`sm`+): rects disjoint.
4. With drawer open: `document.elementFromPoint` at the header's ☰ button centre returns the backdrop; the drawer's close button is tappable; `Escape` returns focus to the ☰ button.
5. With menu or log open: the item at each row's centre is the row itself (`elementFromPoint`), the dice toast is below them; opening the log closes the menu and vice versa.
6. `getComputedStyle().zIndex` of: header 30, drawer backdrop 35, drawer 40, dice toast 45, Undo toast 50, palette/dialogs 60.
7. Nothing `position: fixed` with `bottom` set exists on a phone except the Undo toast (query all `fixed` elements, assert).

### 9.6 Content (M6.4)

- Shared NPC page at 320/360/390: the `h1` shows the full title (text not clipped: `scrollWidth <= clientWidth` of the title element), the long unbroken word wraps (no element right edge `> innerWidth`).
- Own character page at 390: with sheet and properties closed, the top of the editor is `<= 600` px from the document top and the first screen shows the sheet summary row with the digest. Opening the sheet shows number fields two per row; all inputs 44 px and 16 px.
- Inventory at 320/360/390: no table, items are `<li>` cards, no horizontal overflow, buttons Add/Spend/Remove and the Qty input all `>= 44` px, the attuned label `>= 44` px, the "Wren personal dagger" name fully visible (wrapped, not truncated).
- Campaigns list at 320 and 360: `main.scrollWidth === main.clientWidth`, both buttons fully inside the viewport.
- Read-only page (player on a shared NPC): in the details panel no input has a visible border or filled background (`border-top-color` is transparent); text colour contrast against `bg-panel` passes in both themes (axe `color-contrast`, 0 violations).
- Inline dice: for each `.cn-roll`, `elementFromPoint` at (centre x, centre y - 18) and (centre x, centre y + 18) both return the roll (or its descendant) on the first line of a paragraph; `page.touchscreen.tap` on that point rolls and adds one entry to the log. Standalone roll buttons: bounding box `>= 44` px.
- Combat player screen at 320/360/390/430 and landscape: no overflow, the "← Campaign" link is first in tab order, `>= 44` px, and navigates to `/c/:id`; no element named `header` containing "Sign out" (existing e2e check).
- axe-core (wcag2a, wcag2aa, wcag21aa) on the pages above at 390, light and dark: 0 new violations; the two known non-phone findings (E4, E5) are tracked by G1.2 and are not blockers here unless the new markup causes them.

### 9.7 Regression (both)

`pnpm -s typecheck && pnpm -s lint && pnpm -s test` and `pnpm e2e` pass at the desktop viewport (the e2e suite uses 1440 x 1000, section 8). The visibility sentinel tests are unaffected (no data change). Screenshots from QA stay out of the repository (rules text).

## 10. Open questions for the owner

| # | Question | Default taken here |
|---|---|---|
| Q1 | Add `interactive-widget=resizes-content` to the viewport meta (Android keyboard)? It cannot be tested in desktop emulation. | Yes, listed in 2.5; revert if a real device shows a regression. |
| Q2 | Should "Templates" be hidden from users who are not game master of any campaign (audit #2)? The header does not currently know that without a request. | Keep the link in the menu for everyone until the data is at hand; hiding it needs the campaign roles list. |
| Q3 | Does `lg` (1024) remain the desktop header breakpoint, so a 1024-1279 window gets the inline header that still wraps to two rows? | Yes (D2); desktop header is out of scope. |
| Q4 | Landscape phones get the compact header and the drawer, not the desktop layout. Accept that a DM on a landscape phone sees "desktop-first" pages inside a compact shell? | Yes. |
| Q5 | The editable title becomes an autosizing `textarea` (Enter is blocked). OK, or keep a single-line input and accept truncation for editors only? | Textarea; players reading shared pages get an `h1`. |
| Q6 | Inventory on `sm` and up also loses the table (cards that wrap into rows). Keep the table at `lg` for the DM? | Cards everywhere; revisit only if the DM objects. |
| Q7 | Real-device checks are still missing (iOS Safari input zoom, notch, keyboard). Which device(s) does the owner have for the M6.5 manual pass? | Not assumed. |

## 11. Implementation order

1. M6.3: `styles.css` tokens, variants, `.cn-hdr-btn`, `.cn-input`/`.cn-btn` (section 2); `index.html` meta; `LayoutService`; `app.html` compact header, menu, dice popover and toast lanes; `campaign-shell.ts` drawer; `undo-toast.ts` position and z; z-index moves for dialogs. Gate, then the checks 9.1-9.5.
2. M6.4: page title and reading, read-only fieldset CSS, sheet/properties collapse and facet layout, inventory cards, campaigns list, auth and account forms, inline dice, combat back link. Gate, then the checks 9.1, 9.3, 9.4, 9.6.
3. M6.5 builds the Playwright phone project from `e2e/players.spec.ts` and the combat player view and re-uses the numbers in section 9.
