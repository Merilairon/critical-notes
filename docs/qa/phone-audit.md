# Phone audit (Task M6.1)

Date: 2026-10-19. Branch: `worktree-agent-aaa440e2372380907`. App code unchanged. Feeds M6.2 (guidance), M6.3 (header and navigation) and M6.4 (player content views); `docs/PRD.md` §8 M6 says "Done when: the player flows above pass a browser test at phone width".

## What was tested and how

- The built bundle (`pnpm build`, `node apps/server/dist/main.mjs`) on port 3377 with a fresh `DATA_DIR` in the session scratchpad and the 5etools clone linked through `FIVETOOLS_SRC_PATH` / `FIVETOOLS_IMG_PATH`. The real `var/` was never touched.
- System Chrome (`/opt/google/chrome/chrome`) through Playwright with phone emulation: `isMobile`, `hasTouch`, device scale 2, taps (`.tap()`), viewport height 844. Widths 360, 390 and 430. Light and dark theme (`colorScheme`) for every flow except the registration submit and the editor typing, which ran in light only. A second run added 320 px, landscape (844 x 390), a larger root font (150 % and 200 %) and axe-core 4.7 at 390 px (see the extra sections).
- Seed (all invented content): DM "Dara Master", campaign "The Lantern Coast Chronicles" (2014), shared location with a heading, long paragraphs, two dice tags (`{@dice 1d20+5}`, `{@damage 2d6+3}`), a DM secret, a shared NPC with a long title, PC page "Wren Tallow" assigned to the player, party stash and character inventory with coins, an encounter of custom creatures run as a tracker (round 1), three invite links, then three players registered through the links, one of them assigned the PC.
- Measured per page (`MEASURE` in the audit script): `document.scrollingElement.scrollWidth` vs `clientWidth` and `main.scrollWidth` vs `clientWidth`, elements poking past the viewport, interactive element bounding boxes (flag below 44 px in either dimension), overlapping interactive boxes, clipped text, computed font sizes below 12 px, header height. Keyboard: the viewport was shrunk to 480 px high at 390 px wide only (360 and 430 were not run) while a field had focus. This is a stand-in, not a real on-screen keyboard: no visual-viewport resizing and none of a real keyboard's scroll-into-view behaviour.
- **Tap criterion:** a primary action is at least 44 x 44 CSS px. A *primary action* is a control a player needs to finish a flow's task: submit buttons (join, sign in, reset, save, change password), Add/Spend in the inventory, an inline dice roll, the dice log and theme/menu buttons in the header, and the header and drawer links that lead to the flows. Secondary controls (the Sources button, selects for an occasional setting, text links such as "Sign in first") are listed but not graded.
- **Grades:** `PASS with Low notes` = no H, O, R or K failure, and only full-width primary buttons of 36-43 px high. `FAIL Med` = a primary target of 35 px or less, a clipped or overlapping control or cut-off text, or a cramped keyboard case, but the flow can still be completed. `FAIL High` = the page scrolls sideways or a flow is blocked. A 40 px button is therefore not graded like a 28 px nav link.
- Criteria letters used below: **H** no horizontal page scroll and nothing cut off at the right edge; **T** tap targets of primary actions at least 44 px; **O** no clipped or overlapping controls or text; **R** readable text (12 px or more, no cut-off words); **K** usable with the keyboard area (focused field visible, the action reachable, enough room left).
- Dark theme gave the same layout numbers as light in every flow. Colour contrast was **not** measured in this audit (screenshots of dark were only looked at for the campaign drawer).

## Flow by width

PASS means none of H, T, O, R, K failed on the flow's pages. FAIL lists the letters that failed. The numbers refer to the issue list below.

| Flow | 360 | 390 | 430 |
|---|---|---|---|
| 1a. Invite link, register (`/invite/:token`) | PASS with Low notes (#10, #11) | PASS with Low notes (#10, #11) | PASS with Low notes (#10, #11) |
| 1b. Sign-in (`/login`), wrong-password message | PASS with Low notes (#10, #11) | PASS with Low notes (#10, #11) | PASS with Low notes (#10, #11) |
| 1c. Reset (`/reset`, and the `/reset#<token>` form) | PASS with Low notes (#10, #11) | PASS with Low notes (#10, #11) | PASS with Low notes (#10, #11) |
| 2. Shared page reading (location, NPC) | FAIL High (H: #1; also #3, #12, #13) | FAIL Med (O, T: #3, #12, #13) | FAIL Med (O, T: #3, #12, #13) |
| 3. Own character page, editing | FAIL High (H: #1; also #2, #8) | FAIL Med (K, T: #2, #8) | FAIL Med (K, T: #2, #8) |
| 4. Inventory | FAIL High (H: #1; also #9) | FAIL Med (T: #9) | FAIL Med (T: #9) |
| 5. Combat player screen (`/trackers/:id/view`) | PASS with Low notes (#14; live updates not watched) | PASS with Low notes (#14; live updates not watched) | PASS with Low notes (#14; live updates not watched) |
| 6. Dice toast and dice log | FAIL High (H: #1; also #6, #7) | FAIL Med (O, T: #6, #7) | FAIL Med (O, T: #6, #7) |
| Header and campaign navigation (drawer) | FAIL High (H: #1; also #2, #3, #4) | FAIL Med (T, K: #2, #3, #4) | FAIL Med (T, K: #2, #3, #4) |
| Campaigns list | FAIL Med (H, O: #5) | FAIL Med (T: #3) | FAIL Med (T: #3) |
| Account page | FAIL High (H: #1; also #3, #10, #11) | FAIL Med (T: #3, #11) | FAIL Med (T: #3, #11) |

Flow 5 caveats: it was loaded once at round 1 and photographed; live updates (the event stream while the DM advances turns or changes HP) were not watched. It has no controls, so the tap criterion does not apply. #14 (no way back) is Low.

Key numbers (`docScroll/docClient`, from `results.json`):

| Page | 360 | 390 | 430 |
|---|---|---|---|
| Any signed-in page with the header | 368/360 (8 px over) | 390/390 | 430/430 |
| Campaigns list (`main`) | 388/360 (28 px over) | 390/390 | 430/430 |
| Header height (campaign pages / non-campaign pages) | 199 px / 160 px | 159 px / 160 px | 161 px / 161 px |
| Invite, sign-in, reset, combat player screen | 360/360 | 390/390 | 430/430 |

What passed: no horizontal scroll at 390 and 430 anywhere; the combat player screen at all three widths (full-screen cards, 20 px text, names wrap, no controls); the invite form with the keyboard-sized viewport (focused password field stays in view, the submit button is 40 px high and reachable by scrolling); the drawer opens, closes on an outside tap and after following a link, and offers the active combat as its first row, which opens `/trackers/:id/view`; a real registration through each invite worked at all three widths; sign-in error text fits; the reset form takes a token and fits.

## Issues

Severity: High (blocks a player flow or breaks the layout), Medium (works but is hard to use or visibly broken), Low (cosmetic or edge case). Evidence names files in the session scratchpad `.../scratchpad/m61/shots/` (not committed, see Screenshots) and rows in `results.json` there. Owner tasks are suggestions.

1. **Header overflows 8 px at 360 px: the whole page can scroll sideways.** The nav (Campaigns, Reference, Homebrew, Templates) is `flex` without wrap and is 368 px wide, so the document is 368 px on a 360 px phone; the layout viewport widens, content is cut at the right edge (page title "Mistwick Harbou…" and the "New campaign" button in the screenshots). This is the same overflow earlier tasks noted at 390 px for the admin header (35 px, `Users` link) and 320 px (M2.7/M2.8/M3.7); admin pages were not in this audit's scope, so the admin case is not re-verified here. Severity: High. Evidence: `F2-shared-page-reading-360-light.png`, `F6b-dice-log-open-360-light.png` (the toast lands at y 757+90, past the 844 px viewport, because of the widened layout), `results.json` rows with `docScroll 368`. Component: `apps/web/src/app/app.html` (the `<nav>`). Owner: M6.3.
2. **The header takes 19 to 24 % of the screen permanently, and a third to 41 % with the keyboard open.** 159-161 px at 390/430, 199 px at 360, on every campaign page: four rows of nav, search, campaign name, dice, theme, account, sign out. It sits outside the scrolling `main`, so it never goes away. With the viewport at 480 px high (keyboard) the editor has about 320 px left (`F3b-editor-slash-menu-with-keyboard-open-h-480--390-light.png`). The "Templates" link is also shown to players. Severity: High. Component: `apps/web/src/app/app.html`, `app.ts`. Owner: M6.3.
3. **Header and navigation targets are 28 to 32 px high.** Nav links 82-90 x 28, Search 66 x 30, dice 36 x 32, theme 30 x 32, account 64 x 28, Sign out 70 x 28, "Sources" 74 x 30, the "Legacy" checkbox 13 x 13, "☰ Campaign" 101 x 30. Drawer rows 271 x 28, the campaign name is cut ("The Lantern Coast C…") and "All campaigns" is a small text link (`N-drawer-open-390-dark.png`; row boxes in the `audit2` output). Severity: Medium. Component: `apps/web/src/app/app.html`, `apps/web/src/app/campaign/campaign-shell.ts`. Owner: M6.3.
4. **Campaign drawer opens over the page with no close button.** It closes on an outside tap and after a link was followed (both verified at 390), but there is no visible close control or backdrop label. Severity: Low. Component: `campaign-shell.ts`. Owner: M6.3.
5. **Campaigns list at 360: the "Import campaign" / "New campaign" buttons run past the right edge** (`main` 388/360; the "New campaign" label is cut in `H-Campaigns-list-player--360-light.png`). Fine at 390 and 430. Severity: Medium. Component: `apps/web/src/app/campaigns/campaign-list.ts`. Owner: M6.4 (the page's own button row); note that the header fix in M6.3 may not clear it, because the 388 px comes from `main`, not from the header (at 320 px it is still 388/320 while the header alone is 369).
6. **The dice toast sits on top of the dice log.** Both are fixed at the bottom right (`right-4 bottom-4` and `right-3 bottom-3`); with the log open, the toast (about 104 x 90 px, about 4 s) covers its roll totals column. At 390 the boxes are log x 90-378 / y 745-832 and toast x 270-374 / y 738-828; the image at 360 shows the toast hiding the totals. Both also cover the last lines of the page. The log can only be closed with the 🎲 button in the header. Severity: Medium. Evidence: `F6b-dice-log-open-360-light.png`, `F6a-dice-toast-390-light.png`. Component: `apps/web/src/app/app.html` (the toast and log live in the shell template; the Undo toast in `campaign/undo-toast.ts` shares the same corner). Owner: M6.3, together with the shell.
7. **Dice targets are too small to tap.** Inline rolls are 59 x 18 and 51 x 18 px; the "clear" button in the log is 27 x 16 px. Rolling works with a tap (verified: result 19 for `1d20+5`, log entry added). Severity: Medium. Component: `apps/web/src/app/reference/render/roll.ts`, `apps/web/src/styles.css` (`.cn-roll`, line 298), `app.html` (log). Owner: M6.4.
8. **Own character page: the properties panel pushes the text far down, and the editor is cramped with the keyboard open.** The panel stacks 11+ fields (player, species, background, HP, temp HP, AC, speed, passive perception, inspiration, ability scores…) and the editor starts 1188 px down on a 390 px phone (about 1.4 screens). Fields are 30 px high (`.cn-prop-input`). The "/" menu works with the keyboard-sized viewport (24 items listed, first row 310 x 31) but opens over the header. The player-only "typing and Saved" path worked at all three widths. Severity: Medium. Evidence: `F3-own-character-page-editor--390-light.png`, `F3b-editor-slash-menu-with-keyboard-open-h-480--390-light.png`. Component: `apps/web/src/app/campaign/properties-panel.ts`, `facet-form.ts`, `page-editor.html`, editor suggestion styles. Owner: M6.4.
9. **Inventory controls are small and cramped.** "Add" 44 x 26, "Spend" 59 x 26, amount 96 x 30, coin select 56 x 31, quantity 64 x 30, the "attuned" checkbox 13 x 13, the remove "×" and "+ Item" are text-sized. The item row (name, quantity, attuned, owner select, ×) is squeezed so "Wren personal dagger" wraps over three lines and the row edge reaches past the card border by a few px at 390 (`F4-inventory-390-light.png`). With the keyboard-sized viewport the coin field and "Add" stayed visible together and Add worked (7 gp credited). Severity: Medium. Component: `apps/web/src/app/play/inventory-page.ts`. Owner: M6.4.
10. **Form fields are 30-38 px high with 14 px text.** Invite, sign-in, reset and account inputs; 14 px text makes iOS Safari zoom in on focus (cannot be verified here, no iOS). Severity: Low to Medium. Component: shared `.cn-prop-input` and the auth form styles in `apps/web/src/styles.css`, `auth/*.ts`, `invites/invite-page.ts`, `account/account-page.ts`. Owner: M6.4 (the rule itself belongs in M6.2 guidance).
11. **Primary buttons are just under 44 px.** "Create account and join" 40, "Sign in" 40, reset submit 36, "Go to sign in" 40, "Save name" 32, "Change password" 32, "Leave this campaign" 34. Severity: Low. Component: as #10. Owner: M6.4.
12. **Long page titles are cut off on shared pages.** The title is a single-line read-only `<input>` (294 px wide, text 567 px): "Odessa Quillfeather, Lantern Keeper" shows as "Odessa Quillfeathe" and cannot wrap; a player cannot read the rest (`F2b-shared-NPC-page-390-light.png`). Severity: Medium. Component: `apps/web/src/app/campaign/page-editor.html`. Owner: M6.4.
13. **A long unbroken word or URL is cut off, not wrapped.** `Supercalifragilistic…_Thorncliff_Causewa` is clipped at the right edge of a shared page paragraph, with no scroll or wrapping (`F2-shared-page-reading-390-light.png`). The page does not scroll sideways, so the text is simply lost. Severity: Low (needs a very long word). Component: block view / `styles.css`. Owner: M6.4.
14. **Combat player screen has no way back.** It is full screen with no header by design (second screen at the table), but a player who opens it from the drawer has only the browser Back. Layout itself passes. Severity: Low (the screen is meant to be a bare second screen; the drawer link and the browser Back button both work). Component: `apps/web/src/app/play/tracker-player.ts`. Owner: M6.4.
15. **Smallest text.** The source badge ("2014") is 10.9 px on the campaigns list. Everything else measured was 12 px or more. Severity: Low. Component: `styles.css` (`.cn-badge`). Owner: M6.4.
16. **Disabled property controls look editable on a read-only page (cosmetic).** A player on a shared NPC page sees the properties panel (role field, status/attitude/faction/location selects) styled like editable controls. They sit inside a disabled `<fieldset>` (`:disabled` matches; my first measurement used `el.disabled`, which is false for controls disabled only through the fieldset, so the earlier "may be editable" wording was wrong). The Application Security Engineer showed on a running instance that every write returns 403 for a player. Not a security issue. Severity: Low. Fix: dim the styling with `fieldset:disabled`, or show plain text for non-editors. Component: `apps/web/src/app/campaign/page-editor.html`, `properties-panel.ts`. Owner: M6.4.

## 320 px, landscape, text zoom, axe (second run)

Same instance, same player session, phone emulation. "Layout viewport" is what the browser chose; when it is wider than the device the page scrolls or shrinks sideways.

### 320 px wide (device 320 x 700)

| Page | Layout viewport | Document scroll / client width | `main` | Header height |
|---|---|---|---|---|
| Campaign overview, inventory, own character, shared page, account | 369 | 369/320 (49 px over) | 320/320 | 187-196 px (23-24 %) |
| Campaigns list | 369 | 369/320 | 388/320 (68 px over; "New campaign" reaches 388) | 196 px |
| Combat player screen | 320 | 320/320 | 320/320 | no header |

Every page with the header is FAIL High at 320 (the header needs about 369 px, the same 368 px as at 360). The combat player screen passes. The shared page also has an element reaching 672 px (the long unbroken word, #13). Screenshots `Z-320-*.png` in the scratchpad.

### Landscape 844 x 390

| Page | Document | Header | Notes |
|---|---|---|---|
| Overview, inventory | 844/844 | 89 px = 23 % of the 390 px height | no sideways scroll |
| Own character | 844/844 | 89 px | editor starts 771 px down (about two screens) |
| Combat player screen | 844/844 | none | PASS: no overflow |

No overflow. The header takes 23 % of the height (the shell issue of #2, Med) and the property panel leaves little room to write. Typing in landscape was not tested.

### Text zoom (root font 150 % and 200 % at 390 px, via `html{font-size}`; a stand-in for the browser's text size setting, not page zoom)

| Page | 150 % | 200 % |
|---|---|---|
| Overview | doc 552/390, header 309 px = 26 % | doc 736/390, header 483 px = 30 % |
| Own character | doc 552/390, editor top 1861 px | doc 736/390, editor top 2599 px |
| Inventory | doc 552/390 | doc 736/390 |

FAIL High on every page with the header at both levels: the document grows to 552 and 736 px because the header's rem-based widths cannot shrink; `main` itself stays 390/390. I did not isolate which header element is the widest. Fix with #1 and #2. Owner: M6.3.

### Contrast and other axe findings (axe-core 4.7, wcag2a/2aa/21aa rules, 390 x 844, light and dark)

| Page | Light | Dark |
|---|---|---|
| Overview, inventory, combat player screen, account, campaigns list | 0 violations | 0 violations |
| Shared page | `list` and `listitem` (serious, 1 node each) | same |
| Own character | `aria-input-field-name` (serious, 1 node) | same |

No colour-contrast violations in either theme on these pages at 390 px. The three findings are not about contrast and not phone-specific: the list/listitem pair matches the earlier "sidebar listitem" follow-up (not isolated to a node here) and the unnamed input matches "editor field names". Owner: G1.2 / M6.4. axe ran with CSP bypassed in the test browser only.

## Numbers for M6.2

Proposals from the measurements; M6.2 decides.

- **Minimum supported width: 320 px.** Today the header alone needs about 369 px, so the target is a header that reflows. If 320 is judged out of scope the floor is 360 px, and the 8 px overflow (#1) must still be fixed.
- **Header height budget.** Measured: 160 px on non-campaign pages, 159-161 px on campaign pages at 390/430, 187-199 px at 320/360, 89 px in landscape, up to 483 px (30 %) at 200 % text. Proposed target: one row of at most 56 px at 320-430 portrait (campaign drawer button inside it), at most 48 px in landscape, and at most 15 % of the viewport height at any text size up to 200 %. The rest goes into a menu or the drawer.
- **Tap targets:** 44 x 44 CSS px for primary actions (defined above); 24 px minimum with spacing for secondary controls; form text 16 px or more.
- **Safe areas.** Not handled today: `apps/web/src/index.html` has `<meta name="viewport" content="width=device-width, initial-scale=1">` without `viewport-fit=cover`, and no `env(safe-area-inset-*)` appears in `apps/web/src`. With the current tag the browser insets the page itself in portrait. Landscape side insets, or any move to `viewport-fit=cover` or a bottom bar, need `env(safe-area-inset-left/right/bottom)` padding on the header, the drawer and the fixed corner elements. Not tested on a real notched device.
- **Stacking order today** (from `apps/web/src`): campaign drawer `z-30` (below `lg`); dice log `z-40` (`app.html`); sources panel and the editor block-menu backdrop `z-40`; dice toast `z-50`; Undo toast `z-50` (`campaign/undo-toast.ts`: `fixed inset-x-4 bottom-4`, full width on phones); command palette and the dialogs `z-50`; two rules in `styles.css` at 50 and 60. The dice toast (bottom right) and the Undo toast (bottom, full width) share z-50 and the same corner, so DOM order decides which is on top. Proposed order, lowest to highest: drawer 30, dice log 40, dice toast 45, Undo toast 50 (it carries an action), modal dialogs and palette 60. Position: one bottom stack with 8 px gaps plus `safe-area-inset-bottom`, the toasts stacked above the dice log instead of over it, and the log closable by an outside tap or a 44 px close button. The Undo/dice overlap noted in M4.3 was not reproduced here; the dice-toast/dice-log overlap was (#6).

## What could not be tested

- No real phone, no iOS Safari, no real on-screen keyboard (only a 480 px high viewport), no real touch gestures beyond Playwright taps (no pinch, long press, scrolling momentum). The 14 px input zoom on iOS (#10) is inferred from the font size.
- Colour contrast was measured with axe-core 4.7 at 390 px only (see below); not at 360/430, and axe cannot judge contrast over images or the hidden dice toast. Owner for a full pass: M6.5 (phone project) or the Accessibility Auditor.
- Registration with the keyboard open was run in light only; editor typing in light only.
- Admin pages, the DM's prep views and the encounter builder (out of scope); co-DM role; the page tree sidebar content beyond the drawer; search palette, Sources panel, Reference browser, image uploads; the account page's API token section beyond layout; the dice log with 50 entries.
- Landscape and text zoom on the DM pages and the dice toast; 320 px on invite, sign-in and reset (only app pages were measured at 320); typing in landscape.
- Live updates of the combat player screen (the view was loaded at round 1, not watched while the DM changes it).
- A real second player at the same time, and a player with no assigned character.

## Screenshots

About 100 screenshots (flow x width x theme, plus drawer open, keyboard-sized and sign-in error states) were taken. They are **not committed**: they show application screens of a running instance and the PC sheet's rules-derived field labels, and the repository rule is not to commit screenshots that may carry rules text. They remain in the session scratchpad: `/tmp/claude-1000/-home-baetensjan-Projects-critical-notes/2d764459-1ff8-4eaf-b282-92bb131f19d4/scratchpad/m61/shots/`, with the raw measurements in `.../m61/results.json` and `results2.json` and the scripts `seed.mjs`, `audit.mjs`, `audit2.mjs` to `audit5.mjs` in the same folder (all content invented). M6.5 should rebuild a phone Playwright project from `e2e/players.spec.ts` instead of reusing these scripts.

## Suggestions for M6.2 (guidance)

- One tap-target rule (44 px) for primary actions, including inline dice; 16 px minimum for form text.
- A phone header: one compact row plus a menu, instead of four wrapped rows; the campaign name and rules label can move into the drawer.
- A single bottom-right stacking rule for the toast, the dice log and the Undo toast (the Undo/dice overlap noted in M4.3 was not reproduced here, but the dice/log overlap was).
- Long text (titles, URLs) wraps or scrolls inside its own box; the page never scrolls sideways at 360 px.
