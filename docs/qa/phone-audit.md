# Phone audit (Task M6.1)

Date: 2026-10-19. Branch: `worktree-agent-aaa440e2372380907`. App code unchanged. Feeds M6.2 (guidance), M6.3 (header and navigation) and M6.4 (player content views); `docs/PRD.md` §8 M6 says "Done when: the player flows above pass a browser test at phone width".

## What was tested and how

- The built bundle (`pnpm build`, `node apps/server/dist/main.mjs`) on port 3377 with a fresh `DATA_DIR` in the session scratchpad and the 5etools clone linked through `FIVETOOLS_SRC_PATH` / `FIVETOOLS_IMG_PATH`. The real `var/` was never touched.
- System Chrome (`/opt/google/chrome/chrome`) through Playwright with phone emulation: `isMobile`, `hasTouch`, device scale 2, taps (`.tap()`), viewport height 844. Widths 360, 390 and 430. Light and dark theme (`colorScheme`) for every flow except the registration submit and the editor typing, which ran in light only.
- Seed (all invented content): DM "Dara Master", campaign "The Lantern Coast Chronicles" (2014), shared location with a heading, long paragraphs, two dice tags (`{@dice 1d20+5}`, `{@damage 2d6+3}`), a DM secret, a shared NPC with a long title, PC page "Wren Tallow" assigned to the player, party stash and character inventory with coins, an encounter of custom creatures run as a tracker (round 1), three invite links, then three players registered through the links, one of them assigned the PC.
- Measured per page (`MEASURE` in the audit script): `document.scrollingElement.scrollWidth` vs `clientWidth` and `main.scrollWidth` vs `clientWidth`, elements poking past the viewport, interactive element bounding boxes (flag below 44 px in either dimension), overlapping interactive boxes, clipped text, computed font sizes below 12 px, header height. Keyboard: the viewport was shrunk to 480 px high while a field had focus (a stand-in for an on-screen keyboard, not a real one).
- Criteria letters used below: **H** no horizontal page scroll and nothing cut off at the right edge; **T** tap targets of primary actions at least 44 px; **O** no clipped or overlapping controls or text; **R** readable text (12 px or more, no cut-off words); **K** usable with the keyboard area (focused field visible, the action reachable, enough room left).
- Dark theme gave the same layout numbers as light in every flow. Colour contrast was **not** measured in this audit (screenshots of dark were only looked at for the campaign drawer).

## Flow by width

PASS means none of H, T, O, R, K failed on the flow's pages. FAIL lists the letters that failed. The numbers refer to the issue list below.

| Flow | 360 | 390 | 430 |
|---|---|---|---|
| 1a. Invite link, register (`/invite/:token`) | FAIL T (#10, #11) | FAIL T (#10, #11) | FAIL T (#10, #11) |
| 1b. Sign-in (`/login`), wrong-password message | FAIL T (#10, #11) | FAIL T (#10, #11) | FAIL T (#10, #11) |
| 1c. Reset (`/reset` without a token, and `/reset#<token>` form) | FAIL T (#10, #11) | FAIL T (#10, #11) | FAIL T (#10, #11) |
| 2. Shared page reading (location, NPC) | FAIL H, O, T (#1, #3, #12, #13) | FAIL O, T (#3, #12, #13) | FAIL O, T (#3, #12, #13) |
| 3. Own character page, editing | FAIL H, T, K (#1, #2, #8) | FAIL T, K (#2, #8) | FAIL T, K (#2, #8) |
| 4. Inventory | FAIL H, T (#1, #9) | FAIL T (#9) | FAIL T (#9) |
| 5. Combat player screen (`/trackers/:id/view`) | PASS | PASS | PASS |
| 6. Dice toast and dice log | FAIL H, O, T (#1, #6, #7) | FAIL O, T (#6, #7) | FAIL O, T (#6, #7) |
| Header and campaign navigation (drawer) | FAIL H, T, K (#1, #2, #3, #4) | FAIL T, K (#2, #3, #4) | FAIL T, K (#2, #3, #4) |
| Campaigns list | FAIL H, O (#5) | FAIL T (#3) | FAIL T (#3) |
| Account page | FAIL H, T (#1, #3, #10, #11) | FAIL T (#3, #10, #11) | FAIL T (#3, #10, #11) |

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
5. **Campaigns list at 360: the "Import campaign" / "New campaign" buttons run past the right edge** (`main` 388/360; the "New campaign" label is cut in `H-Campaigns-list-player--360-light.png`). Fine at 390 and 430. Severity: Medium. Component: `apps/web/src/app/campaigns/campaign-list.ts`. Owner: M6.3.
6. **The dice toast sits on top of the dice log.** Both are fixed at the bottom right (`right-4 bottom-4` and `right-3 bottom-3`); with the log open, the toast (about 104 x 90 px, about 4 s) covers its roll totals column. At 390 the boxes are log x 90-378 / y 745-832 and toast x 270-374 / y 738-828; the image at 360 shows the toast hiding the totals. Both also cover the last lines of the page. The log can only be closed with the 🎲 button in the header. Severity: Medium. Evidence: `F6b-dice-log-open-360-light.png`, `F6a-dice-toast-390-light.png`. Component: `apps/web/src/app/app.html` (shared file: coordinate with M6.3). Owner: M6.4.
7. **Dice targets are too small to tap.** Inline rolls are 59 x 18 and 51 x 18 px; the "clear" button in the log is 27 x 16 px. Rolling works with a tap (verified: result 19 for `1d20+5`, log entry added). Severity: Medium. Component: `apps/web/src/app/reference/render/roll.ts`, `apps/web/src/styles.css` (`.cn-roll`, line 298), `app.html` (log). Owner: M6.4.
8. **Own character page: the properties panel pushes the text far down, and the editor is cramped with the keyboard open.** The panel stacks 11+ fields (player, species, background, HP, temp HP, AC, speed, passive perception, inspiration, ability scores…) and the editor starts 1188 px down on a 390 px phone (about 1.4 screens). Fields are 30 px high (`.cn-prop-input`). The "/" menu works with the keyboard-sized viewport (24 items listed, first row 310 x 31) but opens over the header. The player-only "typing and Saved" path worked at all three widths. Severity: Medium. Evidence: `F3-own-character-page-editor--390-light.png`, `F3b-editor-slash-menu-with-keyboard-open-h-480--390-light.png`. Component: `apps/web/src/app/campaign/properties-panel.ts`, `facet-form.ts`, `page-editor.html`, editor suggestion styles. Owner: M6.4.
9. **Inventory controls are small and cramped.** "Add" 44 x 26, "Spend" 59 x 26, amount 96 x 30, coin select 56 x 31, quantity 64 x 30, the "attuned" checkbox 13 x 13, the remove "×" and "+ Item" are text-sized. The item row (name, quantity, attuned, owner select, ×) is squeezed so "Wren personal dagger" wraps over three lines and the row edge reaches past the card border by a few px at 390 (`F4-inventory-390-light.png`). With the keyboard-sized viewport the coin field and "Add" stayed visible together and Add worked (7 gp credited). Severity: Medium. Component: `apps/web/src/app/play/inventory-page.ts`. Owner: M6.4.
10. **Form fields are 30-38 px high with 14 px text.** Invite, sign-in, reset and account inputs; 14 px text makes iOS Safari zoom in on focus (cannot be verified here, no iOS). Severity: Low to Medium. Component: shared `.cn-prop-input` and the auth form styles in `apps/web/src/styles.css`, `auth/*.ts`, `invites/invite-page.ts`, `account/account-page.ts`. Owner: M6.4 (the rule itself belongs in M6.2 guidance).
11. **Primary buttons are just under 44 px.** "Create account and join" 40, "Sign in" 40, reset submit 36, "Go to sign in" 40, "Save name" 32, "Change password" 32, "Leave this campaign" 34. Severity: Low. Component: as #10. Owner: M6.4.
12. **Long page titles are cut off on shared pages.** The title is a single-line read-only `<input>` (294 px wide, text 567 px): "Odessa Quillfeather, Lantern Keeper" shows as "Odessa Quillfeathe" and cannot wrap; a player cannot read the rest (`F2b-shared-NPC-page-390-light.png`). Severity: Medium. Component: `apps/web/src/app/campaign/page-editor.html`. Owner: M6.4.
13. **A long unbroken word or URL is cut off, not wrapped.** `Supercalifragilistic…_Thorncliff_Causewa` is clipped at the right edge of a shared page paragraph, with no scroll or wrapping (`F2-shared-page-reading-390-light.png`). The page does not scroll sideways, so the text is simply lost. Severity: Low (needs a very long word). Component: block view / `styles.css`. Owner: M6.4.
14. **Combat player screen has no way back.** It is full screen with no header by design (second screen at the table), but a player who opens it from the drawer has only the browser Back. Layout itself passes. Severity: Low. Component: `apps/web/src/app/play/tracker-player.ts`. Owner: M6.4.
15. **Smallest text.** The source badge ("2014") is 10.9 px on the campaigns list. Everything else measured was 12 px or more. Severity: Low. Component: `styles.css` (`.cn-badge`). Owner: M6.4.
16. **Incidental, not verified:** on a shared NPC page a player sees the properties controls (role text field, status/attitude/faction/location selects) looking editable (`disabled=false`, only the title input is `readonly`). They may sit in a disabled fieldset or be refused by the server; not tested whether a player can change them. Outside the phone scope; for the product owner to check. Component: `properties-panel.ts`.

## What could not be tested

- No real phone, no iOS Safari, no real on-screen keyboard (only a 480 px high viewport), no real touch gestures beyond Playwright taps (no pinch, long press, scrolling momentum). The 14 px input zoom on iOS (#10) is inferred from the font size.
- Colour contrast in dark and light (axe not run here); dark was compared on layout numbers only.
- Registration with the keyboard open was run in light only; editor typing in light only.
- Admin pages, the DM's prep views and the encounter builder (out of scope); co-DM role; the page tree sidebar content beyond the drawer; search palette, Sources panel, Reference browser, image uploads; the account page's API token section beyond layout; the dice log with 50 entries.
- 320 px width (earlier tasks mention header reflow at 320 px) and landscape orientation.
- Live updates of the combat player screen (the view was loaded at round 1, not watched while the DM changes it).
- A real second player at the same time, and a player with no assigned character.

## Screenshots

About 100 screenshots (flow x width x theme, plus drawer open, keyboard-sized and sign-in error states) were taken. They are **not committed**: they show application screens of a running instance and the PC sheet's rules-derived field labels, and the repository rule is not to commit screenshots that may carry rules text. They remain in the session scratchpad: `/tmp/claude-1000/-home-baetensjan-Projects-critical-notes/2d764459-1ff8-4eaf-b282-92bb131f19d4/scratchpad/m61/shots/`, with the raw measurements in `.../m61/results.json` and `results2.json` and the scripts `seed.mjs`, `audit.mjs`, `audit2.mjs` to `audit5.mjs` in the same folder (all content invented). M6.5 should rebuild a phone Playwright project from `e2e/players.spec.ts` instead of reusing these scripts.

## Suggestions for M6.2 (guidance)

- One tap-target rule (44 px) for primary actions, including inline dice; 16 px minimum for form text.
- A phone header: one compact row plus a menu, instead of four wrapped rows; the campaign name and rules label can move into the drawer.
- A single bottom-right stacking rule for the toast, the dice log and the Undo toast (the Undo/dice overlap noted in M4.3 was not reproduced here, but the dice/log overlap was).
- Long text (titles, URLs) wraps or scrolls inside its own box; the page never scrolls sideways at 360 px.
