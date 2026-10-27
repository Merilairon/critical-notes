# Properties panel by keyboard and mouse (H1.3)

Checked 2026-10-27 on main at 25a4e91, in a real browser (system Chrome through Playwright, a throwaway `DATA_DIR`
under `/tmp`, the bundled server on `localhost:3210`, fresh DM account). Spec: `e2e/properties-keyboard.spec.ts`
(7 tests plus the sign-in setup). Not tested: a real screen reader, a real phone, forced colours, other browsers.

## Question

During I2.2 a custom property ("Mood") vanished while a script sent Tab, arrow and Enter keys with focus on the
Properties panel. Can a stray Enter or a mouse click delete a property definition (which drops its values on every
page) without a confirmation?

## Finding: in the app, no; through MCP, yes

The earlier static check said the button goes through native `confirm()`. It does not. On current main
`PropertiesPanel.removeDef` calls the app's own `ConfirmService.ask()` (`role="alertdialog"`, title "Delete
property?", message "Delete the property "X" from every page in this campaign?", confirm button "Delete property").
In the web app, `store.deleteProperty` runs only after that answer is true. No native dialog appears (the e2e
`watch()` helper fails any test on one).

**What is and is not confirmed**

- **Web UI: always the app dialog.** Every UI route to `DELETE /api/campaigns/:id/properties/:id` goes through it.
- **MCP: no in-app confirmation.** The tool `delete_property` (`apps/server/src/mcp/tools/pages.ts`, about lines
  310 to 320) looks the key up and calls the same route (allowlisted in `apps/server/src/mcp/api.ts`, about line
  32). It deletes the definition and its values on every page at once. Its only guard is the client-side
  `destructive: true` hint, which depends on the MCP client asking its user. This spec does not cover MCP.
- **API:** the route itself has no confirmation; there is no undo.

Verified in the browser:

- **Mouse click** on the ✕ button opens the dialog; Cancel keeps the property.
- **Enter or Space on the ✕ button** opens the dialog. Focus goes to **Cancel** (not the destructive button), so a
  second Enter or Space cancels. Esc cancels. Focus returns to the ✕ button. The page behind is inert.
- **Stray keys inside the panel** (Tab, Shift+Tab, ArrowUp/Down/Left/Right, Enter, Space, Esc, one pass): while the
  dialog is closed, no key deletes anything; Enter or Space on a delete button only opens the dialog. In this
  stray-key test the spec cancels every dialog it opens (Escape) before the next key, so that test sends no keys into
  an open dialog. Keys inside the dialog are covered by the other tests.
- **What deletes it in the UI:** the dialog open AND focus on "Delete property": Enter (opens dialog), **Tab**
  (moves to "Delete property"), then Enter or Space. That is the only keyboard route. No single key press or click
  deletes, but a scripted fast sequence with a Tab right after the Enter can. A human reading the dialog is not
  required by the code, only by the default focus (Cancel).
- *Observed in exploration, not reproduced by the spec:* an earlier spec version appeared to delete a property in
  some fresh campaigns when a stray Tab landed just after the dialog mounted; an exploratory script sending Enter,
  Tab, ArrowUp, Space on a delete button deleted "Notes"; the I2.2 disappearance of "Mood" may have been this or the
  MCP tool (not determined); unbounded Tab/Enter sequences leave the panel and reach the header (Enter on Sign out
  ended a session once). None of this is asserted by the spec.

**Product change:** none made. The web UI needed none. The MCP path is a product decision (follow-up below), not
changed here.

**Known limit of the spec:** the stray-key test does about 17 key presses with browser round trips each and is marked
`test.slow()` (3x budget). Under very heavy host load (16 busy loops, load about 40) the earlier, longer version timed
out; it passed unloaded and with 8 busy loops.

## Keyboard operation table

| Control | Keys | Result |
|---|---|---|
| Panel toggle (`summary` "Properties") | Enter / Space | Opens or closes the panel |
| Text, number, date, URL input | type; Tab or Enter commits (`change`) | Value saved via the page autosave |
| Select | Up/Down (or Space/Alt+Down to open); Enter | Changes the value, `change` saves |
| Multi-select chips | Tab to a chip; Enter / Space | Toggles it (`aria-pressed`) |
| Checkbox | Space | Toggles |
| Page link / Reference picker | Tab into it; type to search; arrows and Enter pick | As the page picker, not changed here |
| ✕ "Delete property <name>" | Enter / Space | Opens the confirm dialog, Cancel focused; deletes nothing |
| Confirm dialog | Enter / Space on Cancel; Esc | Cancels, focus back on ✕ |
| Confirm dialog | Tab to "Delete property", then Enter / Space | Deletes the definition and its values on all pages |
| Confirm dialog | Tab / Shift+Tab | Cycles Cancel and Delete property only (focus trap) |
| "+ Add property" | Enter / Space | Opens the form (Name, Type, Options, Reference kind, DM only, Only for type) |
| Add form | Enter in Name submits; Cancel button; Add button | Creates or closes. There is no Esc handling in the form |

Tab order: label row ✕ then the value control, row by row (the ✕ of the next row is reached right after the
previous value control).

## Other findings and recommendations

1. **Recommendation, Moderate: no Undo or trash for a property definition.** `PropertyService.remove` hard-deletes the
   definition, and its values go with it, on every page. **There is no undo.** Page delete has Undo plus a 30-day
   trash; this has only the dialog, and the dialog can be answered with Tab+Enter. Suggest soft delete with an Undo toast (as `undo-toast.ts`)
   or at least restore from the page history for values. Needs a design and server work: follow-up, not built.
2. **Recommendation, Minor: default button.** Cancel is focused first, which is the right default (unlike native
   `confirm()`, where Enter on OK deletes). Keep it. Naming the number of pages that hold a value would help
   people judge ("12 pages have a value for Mood").
3. **Target size (WCAG 2.5.8, AA).** The ✕ button is **10 x 16 px** on a fine pointer at 1440 px, below 24 x 24. It
   passes through the spacing exception: no other target lies within a 24 px circle centred on it (measured, 0 hits).
   With a coarse pointer or at 500 px it is **44 x 44** (`touch:` variant). Passes; fragile if neighbours move.
4. **Contrast at rest (WCAG 1.4.11 Non-text Contrast, AA), Moderate.** The ✕ is `opacity-40`: about 1.77:1 against
   white until hover or focus, which **fails 1.4.11 (needs 3:1)** (touch is full opacity). It is the only visible cue for the delete control. Suggest
   `opacity-70` or more (3:1 or better). Not changed here (outside the unconfirmed-delete question).
5. Focus ring: with keyboard focus the ✕ has a solid 2 px accent outline (offset 2 px) and goes to full opacity. Passes
   (an earlier reading of `outline: none` came from script focus, which is not `:focus-visible`).

## Follow-ups (not built)

- Undo or trash for property definitions (finding 1).
- Raise the rest opacity of the ✕ (finding 4): the ~1.77:1 rest contrast fails 1.4.11.
- Count affected pages in the dialog text.
- **MCP `delete_property` deletes without an in-app confirmation** (only the client-side `destructive` hint).
  Recommendation for the Product Manager and owner to decide: require an explicit `confirm: true` argument (or the
  property label) in the tool, or keep the tool off by default. Not changed in H1.3.
