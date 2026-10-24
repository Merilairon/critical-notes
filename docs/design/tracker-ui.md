# Tracker UI design (Task I3.3)

Version 1.2, 2026-10-24. Owner: UX Architect. Implementer: Frontend Developer (I3.3). QA: Evidence Collector. Test input for I3.4.
Design only: no application code changed. Inputs: `docs/design/tracker-rules.md` v1.2 (rules, projection; the owner accepted its defaults), `docs/design/phone-layout.md` (44 px targets, `touch:`/`short:`, tokens, z-index scale, lanes), the merged reducer in `packages/shared/src/tracker.ts` (action and field names below are the real ones), and the current `play/tracker-page.html`, `tracker-page.ts`, `tracker-player.ts`.
Rules text: this note paraphrases and copies no rules or 5etools text (PROJECT.md §4 "Data"). Help copy in section 9 is the app's own short wording.
Constraints that stay: Angular standalone, signals, OnPush, zoneless, Tailwind v4 tokens (`bg-panel`, `border-line`, `text-muted`, `text-accent`, `bg-bg`, `--focus`), no `innerHTML`, never a hard-coded colour, light and dark through the existing tokens.

## 0. Decisions in one page

| # | Decision | Why |
|---|---|---|
| D1 | A combatant row has three tiers: **identity block** (always), **status strip** (conditions; always), and **rule panels** (only the ones that apply). Rare actions (Ready, Move after, In lair, makes-death-saves flag) live behind one per-row **More** button, not on the row. | Fast at the table (rules principle 1): frequent controls are one click, rare ones do not crowd a 390 px row. |
| D2 | A panel exists only if the combatant has the data. No `legendary` object: no legendary panel. Lair row: no HP/AC/conditions/death saves/Ready/Move after at all (absent, not disabled). | Rules sections 2-4; I3.2 handoff note "hide HP/AC controls on the lair row". |
| D3 | **State is never colour alone.** Every state has a word and a shape. Colour only reinforces. | WCAG 1.4.1. |
| D4 | Every control is a real `<button>`, `<input>` or `<select>`. **More** is a button with `aria-expanded` and `aria-controls` (not `<details>`). No pip is a clickable `span`; steppers replace "click a pip". | Keyboard and screen reader operation for free. |
| D5 | Touch (`touch:` of phone-layout): every **new** control is at least 44 x 44 px. The existing **row** controls (initiative box, HP box, hide, remove, condition `x`, `+ condition`, `+ notes`) and the page **toolbar** buttons are raised to 44 px too. The app header buttons are not touched (M6.3 did them). Sizes are `min-height`/`min-width` in px with wrapping text, never a fixed `height`, so text can grow at 200 %. Desktop keeps the current compact sizes. | A row where only the new controls are large looks broken; the toolbar holds Next turn. |
| D6 | The server answer is the only truth: no optimistic updates. A failed action shows the page's alert, the row stays as it was, and focus stays on the control that was used. | Matches `act()`. |
| D7 | One visually hidden polite live region announces each action result (8.3). Visible text is never duplicated by an `sr-only` copy. The recharge note is a separate, visible, DM-only status region. | One announcement per event. |
| D8 | **One DOM order, equal to the visual order at every width.** Layout changes use wrapping and `basis-full`, never CSS `order`. | WCAG 1.3.2, 2.4.3. |
| D9 | Optional/P2 items are in section 12 and are not built in I3.3. | Scope. |

## 1. Shared pieces

### 1.1 Classes (add to `apps/web/src/styles.css`, plain CSS like the neighbours, prefix `cn-trk-`)

| Class | Purpose | Rules |
|---|---|---|
| `.cn-trk-panel` | One rule panel inside a row | `margin-top: .5rem; padding: .5rem .625rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--bg)`. Legendary and resistance sit side by side from `sm` through `grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr))`. |
| `.cn-trk-title` | Panel label: `text-xs` semibold uppercase `text-muted` | Real text, 12 px floor. |
| `.cn-trk-step` | Stepper button (minus / plus) | `.cn-btn` plus `padding-inline: 0; min-width: 2rem`; under `touch` `min-width: 44px; min-height: 44px`. |
| `.cn-trk-pip` | One pip: `display: inline-grid; place-items: center; width: 1.25rem; height: 1.25rem; border: 2px solid var(--ink); font-size: .8rem; line-height: 1`. rem sizes follow text zoom; pips are not targets. | Modifiers below. |
| `--round` | Success and resistance pips: `border-radius: 50%` | |
| `--square` | Failure pips: `border-radius: .15rem` | |
| `--diamond` | Legendary action pips: rotated 45 degrees, glyph counter-rotated by a child | |
| `[data-on='true']` | Filled: `background: var(--ink); color: var(--bg)` (success, resistance, legendary = available) or `background: var(--accent); border-color: var(--accent); color: var(--accent-ink)` (failure). A filled pip carries a glyph: success `✓`, failure `✕`, legendary and resistance `●`; an empty pip is an outline with no glyph. | Fill, glyph and shape all differ. |
| `.cn-trk-chip` | Status chip (`Active turn`, `Readied`, `In lair`, `Dying`, warnings) | Like `.cn-badge` (12 px floor), `border: 1px solid var(--control)`, `border-radius: 9999px`, padding `.125rem .5rem`, a leading `aria-hidden` glyph, then the word. Warning chips use `▲`. |
| `.cn-trk-status` | The sticky status slot (alert and recharge note, 6.2) | In flow, never `fixed`. |

Borders: the existing `.cn-btn` outline is `var(--line)` (decoration, as phone-layout defines it); text inputs and selects use `var(--control)` (3:1). Chips and pips use `--control` / `--ink` / `--accent`. Do not use `--muted` for a pip border.

No animation is required. Any fade is 150 ms inside `@media (prefers-reduced-motion: no-preference)`.

### 1.2 Accessible names

Names start with the verb and end with the combatant's name: `Spend 1 legendary action of Adult Red Dragon`. **The visible text is always contained in the accessible name** (WCAG 2.5.3); where the visible text is longer than a useful name, the name starts with the visible text and appends the creature. Two creatures with one name get the same names; the live-region sentence repeats the name.

## 2. Combatant row

The `<li>` stays and carries `data-trk-id`. `aria-labelledby` pointing at the name span is a nice-to-have: verify it with Playwright `ariaSnapshot` and drop it if the list-item semantics get worse. The active row keeps `aria-current="true"` and `ring-2`, and adds the chip **Active turn** (glyph `▶`) because the ring alone is not text.

### 2.1 One DOM order (D8)

Inside the `<li>`, in this order, for every width:

1. **Identity block** (`flex flex-wrap items-center gap-x-2 gap-y-1`):
   1. initiative input
   2. name span (`min-w-0 flex-1 basis-40 [overflow-wrap:anywhere]`), with the kind text
   3. chips group (`Active turn`, `Readied: <trigger>`, `In lair`, `hidden`; a `<span class="flex flex-wrap gap-1">`; full width on phone with `max-sm:basis-full`)
   4. AC chip
   5. HP block (`font-mono` current/max, `+N temp`, bar)
   6. HP change input
   7. **Apply** button
   8. crit checkbox label (only when 4.4 says so)
   9. action group `<span class="flex gap-3">` with: hide toggle, **More** button, Remove
2. **Status strip**: conditions, `+ condition`, `+ notes` (and the notes textarea when open).
3. **More panel** (when open; 7.2): directly after the status strip, which is next to the **More** button's own line.
4. **Rule panels**, fixed order: Death saves -> Legendary -> Resistance -> Recharge.

Tab order = this order; it also equals reading order. Desktop gets the same order, and the browser just lays more items on one line.

### 2.2 Desktop (sm and up)

```
[init] ▶ Name  PC · +2   (Active turn)(Readied: ...)(In lair)    🛡 17   HP 24/31 ▮▮▮▯   [-7/+5 ][Apply] [ ]Crit   [👁][More v][✕]
conditions: (Stunned (2) x) (+ condition) (+ notes)
[More panel]
[Death saves]
[Legendary actions]  [Legendary resistance]      (side by side)
[Recharge]
```

The action group is kept apart from the numbers by `ml-auto` so Remove sits at the far right. `gap-3` (12 px) between hide, More and Remove: Remove has no confirm and must not be adjacent to a frequent target.

### 2.3 Phone, 390 px (and 320, and 200 % text)

Width budget at 390: page padding 16 + 16 leaves 358; `li` padding 8 + 8 + border leaves about 340 px. The same DOM order wraps into these lines:

```
L1: [init 56x44] [Name ...............(flex-1 basis-40, wraps)]
L2: (Active turn) (Readied: ...) (In lair) (hidden)          chips group, basis-full
L3: 🛡 AC 17    HP 24/31 ▮▮▮▯ (+3 temp)                       wraps; HP block min-w-0
L4: [HP change input  flex-1 ] [Apply]  [ ] Critical hit       Apply min 44x44
L5: [👁 44]  [More 44+]  [✕ 44]                                gap-3 (12 px), Remove last
L6: conditions + "+ condition" + "+ notes"                      each min 44 tall
L7: More panel (open)
L8+: panels, full width, stacked
```

- Name: `min-w-0 flex-1 basis-40`, so the name takes the rest of L1 and the chips group (`basis-full`) always starts L2. The `AC` chip and HP block flow after the chips on L3; the HP input (`flex-1 min-w-[8rem]`) starts L4 because the HP block is `basis-full` below `sm`.
- The HP input: placeholder `-7 / +5`, `inputmode="text"` (it takes `-`, `+`, `=`, `t`), `enterkeyhint="done"`, 16 px under `touch`. Enter still submits; `Apply` is the visible equivalent. Apply's name is `Apply hit point change to <name>`.
- The L5 action group is its own `basis-full` line on phone with 12 px gaps, so hide, More and Remove are separate targets of at least 44 px with space between them.
- Height cost: a plain monster row is about 5 lines at 390; each panel adds about 90 px. A boss with all panels is roughly 630-650 px. This is the price of inline controls; the absent-panel rule and the More button keep ordinary rows short.

### 2.4 Text zoom 200 %

Rows wrap. Pips grow with rem (20 px -> 40 px); the stepper group wraps under the pips (`flex flex-wrap items-center gap-x-3 gap-y-1`). Buttons use `min-height`/`min-width` 44 px with wrapping text, so they may grow wider or taller with the text and never overflow. No fixed `h-` on rows or panels.

### 2.5 Dimming

The existing row-wide `opacity-60` for combatants at 0 HP is replaced: a combatant with `hp !== null && hp <= 0` gets a dashed border and `bg-panel-2` (the same treatment the player view already uses). Text stays at full contrast. Use `hp <= 0` for the dimming, the death-save panel and the `Down` chip, because `update` accepts negative hit points.

## 3. Toolbar

### 3.1 Two toolbars, one sticky container

The sticky container (`sticky top-0 z-10`) holds, top to bottom:

1. `<div role="toolbar" aria-label="Combat">`: **Prev** and **Next turn** (or **Start combat** before the first turn). Nothing else.
2. The **status slot** (`.cn-trk-status`, 6.2): the alert container and the recharge note, both always in the DOM, empty when idle.
3. `<div role="toolbar" aria-label="Combat setup">`: `Roll missing`, `Reroll monsters`, `+ Monster`, `+ Character`, `+ Other`, `+ Lair`, `Keys and rules`, `End combat`.

The e2e suite does not select the toolbar role (checked), so renaming and splitting is safe; the old `Combat` label stays on the turn toolbar.

- At `sm` and up the setup toolbar is inside the sticky container as today (one wrapping row, buttons as today, 44 px under `touch`).
- **Below `sm`** the setup toolbar is **not sticky** (it is placed after the sticky container in DOM; sticky container = turn toolbar + status slot only). Its buttons are 44 px and wrap. `Keys and rules` is in this non-sticky row.
- **Round pill**: it stays in the page `<header>` (where it is today) and is therefore not visible while scrolled on a phone. This is deliberate: a pill plus Prev and Next plus the help button was 440+ px at 390 and Prev/Next alone wrap at 200 % text. The round is announced in the live region on every Next/Prev (`Round 3. Aldric's turn.`) and the `Next turn` button's accessible name is `Next turn, round 3` (visible text unchanged; the `◀`/`▶` glyphs on Prev and Next are `aria-hidden`, so the name contains the visible text).
- In landscape phones (`short`) and at heights under 500 px the sticky container is `static` (a sticky block of 100+ px on a 390 px high viewport is not acceptable).
- Budget (measured by QA, 13.2): turn toolbar row <= 64 px at 100 % text; with a one-roll recharge note or an alert, container <= 130 px; at 200 % text Prev and Next wrap to two rows, so the empty container <= 160 px and with one roll <= 270 px.

### 3.2 `+ Lair` and `Keys and rules`

| Control | Behaviour |
|---|---|
| `+ Lair` | `aria-pressed` like its siblings; opens the add form (7.1). Always enabled (more than one lair row is allowed). |
| `Keys and rules` | `aria-expanded`, `aria-controls="cn-trk-help"`; opens the help (section 9). Shortcut `?`. |

The footer `<p>` of keys is replaced by the help panel; a one-line hint `Press ? for keys and rules.` stays under the list.

## 4. Death saves

A combatant **makes death saves** if `kind === 'pc'` or `deathSaves` is true. The panel is shown when it makes death saves, `hp !== null && hp <= 0`, and `dying` exists.

### 4.1 Panel anatomy

```
Death saves — Dying                       (title row: text + status chip)
Successes  ○ ○ ○   [−] 0 of 3 [+]         group "Successes of <name>"
Failures   □ □ □   [−] 0 of 3 [+]         group "Failures of <name>"
Roll       d20 [  ]  [Record roll]  [Roll for me]
Natural    [Nat 20: up at 1 HP]  [Nat 1: two failures]
Status     [Stable] [Clear counts]  ...  [Dead]
```

- `<div class="cn-trk-panel" role="group" aria-labelledby="cn-trk-ds-{id}">`; the title is a `<p id>` (no headings inside list rows).
- Pips are `aria-hidden`; the visible words `0 of 3` are what a screen reader reads (no `sr-only` duplicate).
- **Success pip**: circle, glyph `✓` when filled. **Failure pip**: square, glyph `✕` when filled. Empty: outline only.
- **Steppers** `−`/`+`: `deathSaveAdjust { id, successes: ±1 }` or `{ failures: ±1 }`. Names `Remove a success from <name>`, `Add a success to <name>`, and the failure pair. The server clamps and settles. The buttons stay enabled at the ends (never block); a no-op is announced (`Brenna already has 3 failures`). Do not use `disabled` (it drops the button from the tab order mid-use).
- **Roll input**: `type="number" min="1" max="20" inputmode="numeric"`, `aria-label="Death save d20 roll of <name>"`, placeholder `d20`. **Enter** submits `deathSave { id, roll }`. Invalid or empty: `aria-invalid="true"`, live message `Enter 1 to 20`, no request. After a successful record:
  - if this combatant is the **active** one, focus moves to **Next turn** (the turn is done);
  - otherwise focus stays in the field (several PCs may be rolled in a row).
  - `Escape` in the field moves focus to this row's **More** button (never to `body`, so row-scoped keys keep working).
- **Record roll**: the visible equivalent; stays enabled and validates.
- **Roll for me**: the **client** rolls a d20 (`crypto.getRandomValues` with rejection sampling to avoid modulo bias) and sends `deathSave { id, roll }`. The number is shown to the DM only: the Action live region says `Brenna: death save, rolled 7, a failure. 2 successes, 1 failure.` The client roll must **not** use `DiceService` (it writes the shared dice log and toast, which players see); it is a private helper in the tracker page. QA checks that the dice log is unchanged after Roll for me.
- **Nat 20** and **Nat 1**: `deathSave { id, roll: 20 }` / `{ roll: 1 }`. Visible text `Nat 20: up at 1 HP` / `Nat 1: two failures`; accessible names `Nat 20: up at 1 HP, death save for <name>` and `Nat 1: two failures, death save for <name>` (the visible text is a prefix). Plain `.cn-btn`, not accent. No confirm (undo is the steppers or an HP edit). After a nat 20 the panel disappears; focus moves to the row's HP input.
- **Stable**: `deathSaveAdjust { id, reset: true, status: 'stable' }`, which gives stable with 0/0 (the reducer resets, then applies the status). **Clear counts** (shown only on a stable combatant with non-zero counts): the same payload. **Dead**: `deathSaveAdjust { id, status: 'dead' }`. **Back to dying**: `deathSaveAdjust { id, reset: true }`.
- Spacing: all buttons in the panel have at least 8 px between them (`gap-2`); **Dead** is separated from Stable and the Nat buttons by at least 16 px (own group, `ms-4` or its own line on phone) because it is the least reversible-looking choice.

### 4.2 States

| `dying.status` | Title chip (text + shape) | Shown | Hidden |
|---|---|---|---|
| `dying` | `Dying` with `▼` | pips, both steppers, roll input, Record roll, Roll for me, Nat 20, Nat 1, Stable, Dead | Back to dying, Clear counts |
| `stable` | `Stable` with `■` | pips, steppers, **Clear counts** (if counts > 0), **Back to dying**, Dead | roll input, Record roll, Roll for me, Nat 20, Nat 1, Stable (a roll on a stable character would restart the count; hiding is not blocking, the manual path stays one tap away) |
| `dead` | `Dead` with `⊗`; the name gets `line-through` | pips as stored, **Back to dying** | everything else |

- Stable with non-zero counts now only comes from reaching 3 successes (the Stable button clears the counts). The stored counts are shown as stored, and the player view keeps its rule (10.1).
- Massive damage arrives as `dead` with 0/0. The panel shows `Dead` and, when failures < 3, the note `Set by hand or by massive damage.` (an honest hint; the state keeps no reason).
- Dead PCs stay in the order.

### 4.3 The Stable button

One tap, no counts left over. There is no "counts kept" state to explain; the help does not mention one.

### 4.4 Damage while down and the crit flag

Damage at `hp <= 0` adds failures through `applyDamage`, including on a **stable** combatant and on one without a `dying` object. So the **Critical hit** checkbox (44 px label row, 24 px box) is shown when: the combatant makes death saves, `hp <= 0`, and `dying?.status !== 'dead'`. Checked: `Apply` sends `hp { id, change, crit: true }`. It resets after every apply. Heals ignore it.
Announcements are built from the diff: `Brenna took 7 damage and has 1 failure.` If the temp HP dropped and failures did not change: `Brenna: 7 damage absorbed by temporary hit points, no failure.` (the table convention of the help).

### 4.5 Who does not get the panel

- **Makes death saves, `hp <= 0`, `dying` absent** (flag set after they dropped, or an old tracker): one button `Start death saves for <name>` (`deathSaveAdjust { id, reset: true }`, which creates the dying state 0/0; verified in the reducer) instead of a panel.
- **Monster, NPC, custom without the flag**: no panel and no pips. At `hp <= 0` the row shows the chip `Down` (`▼`). The reducer may still hold a `dying` for them (I3.2 handoff); the UI ignores it, and it is never projected. The More panel has `Makes death saves` (`update { patch: { deathSaves } }`); turning it on at `hp <= 0` shows `Start death saves`.
- **Lair row**: never.

### 4.6 Active dying PC

When a combatant that is dying is the active one, its panel gets the active ring and the line `Roll a death save for <name>.` Focus is **not** moved by `n`/Next or by anything else (no focus steal). The DM reaches the field with `d` when focus is inside the row, or by Tab.

## 5. Legendary actions and Legendary Resistance

Both are DM-only, and exist only when the state has `legendary` / `resistance`. Legendary actions are spent on **other** creatures' turns, so the controls always act on the row they are in, never on "the active combatant".

### 5.1 Legendary actions panel

```
Legendary actions · in lair: 4 per round
◆ ◆ ◇ ◇   2 of 4 left
Spend  [1] [2] [3]    [Undo]
▲ Stunned: may not take legendary actions        (warning chip, when applicable)
```

- Pips: diamond; filled with `●` = available, outline = spent. Text `2 of 4 left` (effective max = `inLair ? perRoundLair : perRound`). At `used >= max` the text is `None left` with `▲`.
- **Spend** group (`role="group" aria-label="Spend legendary actions of <name>"`): `.cn-btn` `1`, `2`, `3` (`3` only if max >= 3, `2` only if max >= 2), names `Spend N legendary action(s) of <name>` (visible `1` is a substring), `legendarySpend { id, amount }`. They stay enabled at 0 left (stored capped); the live region says what happened (`had only 1 left`).
- **Undo**: `legendaryUndo { id, amount: 1 }`, name `Give back one legendary action of <name>`; a no-op at `used === 0` is announced.
- Reset is automatic when the creature becomes active (`next`, `start`, and also after a Move after by the active creature); not announced (it would speak for each legendary creature each turn). `prev` does not restore.
- **Warning chip** (a hint, buttons stay enabled): when the combatant has any of Incapacitated, Paralyzed, Stunned, Unconscious, Petrified, or `hp !== null && hp <= 0`: `▲ <first match>: may not take legendary actions` (for hp: `▲ Down: may not take legendary actions`).

### 5.2 Legendary resistance panel

```
Legendary resistance · in lair: 4
● ● ○   2 of 3 left          [Use one]  [Give back]
```

Round pips, words `2 of 3 left` / `None left` (`▲`). `Use one` -> `legendaryResist { id }`, `Give back` -> `{ id, undo: true }`, names `Use one Legendary Resistance of <name>` / `Give back one Legendary Resistance of <name>`. Both stay enabled at the ends; no-ops announced. Never changes on `next`. Diamonds (actions) and circles (resistance) differ on purpose.

### 5.3 Editing the numbers: later (P2)

A form to edit legendary per round / in lair and resistance max / in lair / spent is **not** in I3.3 (section 12). The numbers come from the statblock snapshot at `add`; a custom combatant gets none in I3.3. Consequence for the table: a Legendary Resistance already spent on another day cannot be pre-set (rules Q3 said the DM edits the count on add). The API supports it (`update` patch), so it is a UI-only follow-up.

## 6. Recharge abilities and the DM roll note

### 6.1 Chips

```
Recharge   [● Fire Breath (5–6): Ready]   [○ Wing Buffet (6): Spent]
```

- **One chip per distinct name** (case-insensitive), in statblock order, because `rechargeUsed` and `rechargeSet` act on **every** entry with that name. A chip is "Ready" only if all its entries are ready, else "Spent". Threshold shown from the first entry.
- A plain `<button type="button">`, 44 px high under `touch`, wrapping text; glyph `●`/`○` is `aria-hidden`. Visible text `<name> (<min>–6): Ready` or `: Spent` (`(6)` for min 6). Accessible name starts with the visible text: `<name> (<min>–6): Ready. Mark used, <creature>` / `<name> (<min>–6): Spent. Mark recharged, <creature>`. No `role="switch"` (an on/off reading of "ready" is confusing).
- Click when ready -> `rechargeUsed { id, name }`. Click when spent -> `rechargeSet { id, name, ready: true }` (manual override).
- Hint text under the chips: `Click when used. A spent ability rolls when this creature's turn starts. Click a spent one to mark it recharged.`

### 6.2 The status slot: alerts and the roll note

The sticky status slot (3.1) holds two **always-present** containers, so nothing is injected into a fresh live region:

1. `<div role="alert">`: the action error (`errorMessage`), text wraps, `Dismiss` button (44 px) when non-empty. Errors are shown **here**, in view of the sticky block, with no `scrollIntoView`. A new action clears it.
2. `<div role="status" aria-live="polite" aria-atomic="true">`: the DM-only recharge note.

Recharge note:
- Source: `TrackerDto.rolls`, present only on the DM's `act()` response and the DM SSE event of that action. The page keeps `lastRollRevision`; a `rolls` array is shown once per `revision`, so the own response and own SSE echo do not double it. Another DM tab shows it too.
- Content: heading text `Round N` then one line per roll, **at most 2 lines**, then `+ N more`: `Adult Red Dragon: Fire Breath rolled 4, needs 5 or more. Still spent.` / `... rolled 6, needs 5 or more. Recharged.` The result is in words first; the leading glyph is decoration. The `+ N more` button expands the full list in place (the note then grows; that is the DM's choice).
- It does **not** fade. It stays until the next group of rolls replaces it, or the DM presses `Dismiss` (`Dismiss recharge rolls`, 44 px). `Escape` inside it dismisses and calls `preventDefault`.
- Never sent to players: no player component reads `rolls`.
- The chip state on the creature's row stays the permanent record; the roll value is not kept (P2 "recent rolls").

## 7. Lair row, More panel, Ready, Delay

### 7.1 Lair row

Added by `+ Lair`. The add form (same slot as `+ Other`):

```
Name [Lair actions]   Mark as in their lair: [ ] Adult Red Dragon  [ ] Kobold ...   [Select all monsters]   [Add lair row]
```

- `lairAdd { name, ref: null, markInLair: [ids] }`. **`ref` is always `null` in I3.3** (the page has no legendary-group data); no `Open lair text` link in I3.3. `markInLair` defaults to none checked (never automatic). The list is a `fieldset` with `legend` `Mark as in their lair`, 44 px checkbox labels, scrolling inside (`max-h-48`) over 8 entries.

The row (`kind === 'lair'`):

```
[init 20] Lair actions  (Lair)(hidden)        [👁 Hidden] [✕]
Last effect used [ text input ]
▲ No creature is marked as in lair                (warning chip)
```

- **Not rendered on this row**: AC, HP block, HP input, Apply, crit, conditions, `+ condition`, `+ notes`, death-save panel and Start button, legendary, resistance, recharge, **More** (so no Ready, Move after, In lair, Makes death saves).
- **Hidden toggle**: a button with a fixed accessible name `Hidden from players, <name>` and `aria-pressed` (true = hidden). The same fixed name pattern is used on **every** row's hide toggle (the current button changes its title only). Next to the name, the chip is `hidden` or `Shown to players` (glyph `●`), so both states are words. Starts hidden. After toggling: `Lair actions are now hidden from players` / `shown to players`.
- **Initiative**: the same number input, preset 20. Chip `Lair` (glyph `⌂`).
- **Last effect used**: `<input class="cn-input">` bound to `notes` via `update { patch: { notes } }` on change, `aria-label="Last lair effect used"`, helper text `An effect can't repeat two rounds in a row.` DM-only.
- **Warning chip** `No creature is marked as in lair`: shown when **no living (`hp > 0`) combatant has `inLair === true`**. A hint only; no dismiss.

### 7.2 The More panel (every non-lair row)

The **More** button: visible `More`, chevron glyph, `aria-expanded`, `aria-controls="cn-trk-more-{id}"`; accessible name `More actions for <name>` (`, readied` appended when a readied action exists, with a dot glyph after `More`). The panel is rendered only when open, directly after the status strip (2.1). Contents, each a 44 px row under `touch`:

1. **Ready** (7.3)
2. **Move after...** (7.4)
3. **In lair** switch (`role="switch"`, `setInLair { id, inLair }`), non-PC only; hint `Uses the lair numbers for legendary actions and Legendary Resistance.`
4. **Makes death saves** switch (non-PC only; `update { patch: { deathSaves } }`).

`Escape` inside the panel closes it, **calls `preventDefault`** (the app shell closes the entity preview on any non-prevented Escape), and returns focus to the More button. Several panels may be open; state is `moreFor = signal<Set<string>>`.

### 7.3 Ready

```
Ready   Trigger [ text, 200 max ]  [ ] Readied spell   [Set]  [Cancel]
Helper: Players will see this trigger.      (PCs)   |   Only you will see this trigger.   (monsters, NPCs, custom)
```

- `.cn-btn` `Ready...` reveals a `<form>`; Enter submits, `Escape` cancels (with `preventDefault`). Input `required maxlength="200"`, `aria-label="Trigger of the readied action of <name>"`, the helper is `aria-describedby`. `ready { id, trigger, spell }`. Empty: `aria-invalid`, live message `Enter a trigger`.
- Set: chip `Readied: <trigger>` (full text, wraps; `(spell)` appended), glyph `◷`. The More panel then shows `Clear the readied action of <name>` (`readyClear { id }`) in place of `Ready...`. It lapses by itself at the start of that combatant's turn (help text).

### 7.4 Delay: "Move after..."

```
Move <name> after  [ select: Aldric (initiative 17) v ]  [Move]
```

- Labelled `<select class="cn-input">` and a `Move` `.cn-btn`; no submit on `change`.
- Options: the other combatants in initiative order, `Name (initiative N)`. If the mover is the **active** combatant, only those later in the order; if none, the select is `disabled` with the visible text `No one acts later in this round.`
- `Move` -> `moveAfter { id, afterId }`. **The reducer passes the turn on by itself when the mover was active**: `activeId` becomes the next combatant and its turn starts as for `next` (legendary actions refill, spent recharge abilities roll). So the page **never** tells the DM to press Next and never calls `next`. Announcements: non-active mover `Brenna now acts after Aldric.`; active mover `Brenna now acts after Aldric. <New active>'s turn.` If the move triggered recharge rolls, the recharge note (6.2) appears as for any turn start.
- Focus returns to the moved row's More button after render (the row jumped). Errors (impossible move, API 400) go to the alert (6.2); the select keeps its value. No "delayed" badge, no resume.

## 8. Keyboard, live regions, focus

### 8.1 Shortcuts

Guards for **every** single-key shortcut (the existing handler gets the same):
- skip with `ctrl`/`meta`/`alt`, when `e.defaultPrevented`, when the combat has ended;
- skip when the target is `INPUT`, `TEXTAREA`, `SELECT` or content-editable (the existing guard);
- **skip when the target is inside `[role="dialog"]` or `[aria-modal]`, or a confirm is open** (otherwise `n` advances the turn inside the End-combat dialog);
- for the new keys only: `if (e.repeat) return`.
Escape handlers on the More panel, the help and the note call `preventDefault`, so the shell's Escape (closes the preview) does not also fire.

| Key | Scope | Action |
|---|---|---|
| `n` | page | Next turn (Start before the first). Existing. |
| `p` | page | Previous turn. Existing. |
| `r` | page | Roll missing initiative. Existing. |
| `?` | page | Open/close the help; focus to its heading; back to the opener on close. |
| `d` | **inside a row only** | Focus that row's death-save roll field if the combatant is dying (panel shown); else live message `This combatant is not making death saves.` **No global fallback.** Outside any row: message `Focus a combatant first.` |
| `l` / `Shift+L` | inside a row | Spend / give back 1 legendary action of **that row**. |
| `u` / `Shift+U` | inside a row | Use / give back 1 Legendary Resistance of **that row**. |

"Inside a row" = `document.activeElement.closest('li[data-trk-id]')`. Two fallbacks, for browsers that do not focus buttons on click (Safari): for `l`/`u` only, if no row has focus and **exactly one** combatant has `legendary` (for `l`) or `resistance` (for `u`), act on it; otherwise say `Focus a combatant first.` While the HP or any text field is focused all letters type (the guard), so none of this applies there.

**Existing debt, recorded not fixed**: `n`, `p`, `r` are single-character shortcuts on the whole page and fail WCAG 2.1.4 (no off switch or remap). Having a button for each is not a conformance route. I3.3 adds exactly one page-global single-character key, `?`; the other new keys (`d`, `l`, `Shift+L`, `u`, `Shift+U`) are only active while focus is inside a row, which meets the "active only on focus" clause. A "turn off single-key shortcuts" switch is listed as P2.

### 8.2 Tab order

Toolbar `Combat` -> status slot controls (Dismiss) -> `Combat setup` -> add forms -> per row in initiative order: the order of 2.1 (initiative, name has no stop, HP input, Apply, crit checkbox, hide, More, Remove, conditions, More panel contents, death-save panel, legendary, resistance, recharge). Focus rings are the global `:focus-visible` outline; no panel clips it (`overflow: visible`).

### 8.3 Live regions

| Region | Where | Politeness | Content |
|---|---|---|---|
| Action result | one `sr-only[role=status][aria-live=polite][aria-atomic=true]`, always present | polite | One sentence per user action, built from the diff of that row: `Brenna: death save, rolled 7, a failure. 2 successes, 1 failure.` / `Brenna is stable.` / `Brenna is dead.` / `Brenna is up at 1 HP.` / `Brenna: 7 damage absorbed by temporary hit points, no failure.` / `Adult Red Dragon: 2 legendary actions left.` / `Fire Breath marked used.` / `Round 3. Aldric's turn.` Set to empty, then in `afterNextRender` to the sentence, so identical sentences are announced again. |
| Round pill | existing `aria-live` | polite | unchanged |
| Recharge note | 6.2 | polite | the roll lines |
| Errors | 6.2 | assertive (`role=alert`) | `errorMessage(err)` |

No scroll-into-view on errors (the alert is already in the sticky slot).

### 8.4 Focus after structural changes

A control that disappears moves focus to the nearest surviving control of the same row: HP input after a nat 20; the status buttons after Stable; the More button after Ready, Delay or Escape from the roll field. Never `body`. After `Remove` of a row: the next row's first control, or `+ Monster` if the list is empty.

## 9. Help text (the `Keys and rules` panel)

A `<section id="cn-trk-help" aria-labelledby="cn-trk-help-h">` opened by the button and `?`; scrolls inside on phones; its own `h2` (the only one the page adds). Closes with `Escape` or the button. Copy (typos may be fixed, meaning not):

**Keys**
`n` Next turn · `p` Previous turn · `r` Roll missing initiative · `?` This help.
With focus inside a combatant row: `d` death-save roll field, `l` spend a legendary action, `Shift+L` give one back, `u` use Legendary Resistance, `Shift+U` give one back. Keys do nothing while you type in a field. Every action also has a button.
`Hit points box: -7 damage, +5 heal, =20 set, t5 temporary.`

**Death saves**
- `A player character at 0 HP, or a creature you flag as making death saves, gets death saves. Type the d20 the player rolled, or press Roll for me.`
- `Natural 20: back up at 1 HP. Natural 1: two failures. 10 or more is a success. Damage at 0 HP is a failure, a critical hit is two.`
- **`Temporary hit points: this is a table convention, not printed rules text. Damage that temporary hit points fully absorb adds no death-save failure. Only damage that gets past them does. If your table rules otherwise, use the failure + button.`**
- `Stable clears the counts. A character who reached three successes shows them until healed.`
- **`Monsters and NPCs are simply Down at 0 HP. The tracker may count saves for them quietly, but shows nothing until you turn on "Makes death saves" in More.`**
- `Players see only successes, failures and Dying, Stable or Dead for player characters. They never see your rolls.`

**Legendary and recharge**
- `Legendary actions come back when that creature's turn starts. Previous turn does not give them back; use Give back. Legendary Resistance never resets by itself.`
- `A spent recharge ability rolls a d6 when its creature's turn starts. You see the result in a note that stays until the next roll or until you dismiss it; players never see it. Click a spent ability to mark it recharged by hand.`
- `In lair is a manual switch. It changes the legendary numbers to the lair values.`

**Lair, Ready, Move after**
- `The lair row acts at initiative 20 and loses ties. It starts hidden. Hiding it makes the players' highlight blink off for that turn, like any hidden creature.`
- `Ready: write the trigger. Players see the trigger of a player character; a monster's stays with you. It clears when you clear it or when that creature's next turn starts.`
- `Move after: the creature takes the initiative of the one you pick and acts right after it, from now on. If it was the active creature, its turn passes to the next one at once, and that can trigger recharge rolls and refill legendary actions. Its conditions do not tick when you move it, and Previous turn does not undo a move.`

Page numbers (rules doc §10) are omitted: no placeholders.

## 10. Player view (`tracker-player.ts`)

The UI reads **only** these fields of `PlayerCombatant`:

| Field | Used for | New? |
|---|---|---|
| `id`, `name`, `kind`, `initiative`, `hp`, `health`, `conditions` | as today | no |
| `dying: { successes, failures, status } \| null` | PC death saves | **yes** |
| `readied: { trigger } \| null` | PC readied chip | **yes** |
| `kind === 'lair'` row (name + initiative; `hp`, `health`, `dying`, `readied` null, no conditions) | an un-hidden lair row, no HP or health chip | no new field |

Nothing else is added or read (no legendary, resistance, recharge, `inLair`, `tieRank`, rolls, overflow, notes, AC, `ref`, non-PC readied). The component never spreads or iterates the combatant.

### 10.1 Death saves on the table screen

```
 18  Brenna the Brave          [Dying]                    0/31
     Successes ✓ ✓ ○  2 of 3     Failures ✕ ○ ○  1 of 3
```

- With `dying` on a `pc`: the status chip `Dying` (`▼`), `Stable` (`■`) or `Dead` (`⊗`) replaces the plain `Down` chip. The row keeps the dashed `bg-panel-2` treatment.
- **Strike-through of the name: only for `status === 'dead'`** on a PC (a struck-through dying PC would read as dead). A PC at 0 HP without `dying` (legacy) is also not struck. Monsters and NPCs keep today's behaviour (struck when `health === 'down'`).
- A full-width line under the name with two labelled groups; pips `1.5rem`, same shapes and glyphs as the DM page, aria-hidden; the visible words `Successes ... 2 of 3` are the accessible text (no `sr-only` duplicate).
- Stable or dead: pips shown only if a count is non-zero (stable from three successes; dead from three failures), so the table sees what the DM sees.
- No roll numbers, no massive-damage note. Narrow: groups wrap, no horizontal scroll; at 200 % pips grow.

### 10.2 Readied (PCs only)

Chip under the name before conditions: `Readied: <trigger>` (`◷`), full text, `overflow-wrap: anywhere`, 16 px or more. Non-PC readied is not in the projection.

### 10.3 Live updates

One `sr-only` polite region announces **changes only** (diff the previous and new view; nothing on first load): `Brenna: 2 successes, 1 failure.` / `Brenna is stable.` / `Brenna is dead.` / `Brenna readied an action: <trigger>.` / `Brenna's readied action cleared.`

### 10.4 Empty and error

`No one is in the fight yet.`; a PC at 0 HP with `dying: null`: the existing `Down` chip; load errors: existing paragraph. A hidden-lair beat: the highlight disappears, nothing is added or announced.

## 11. Empty and error states (DM page)

| State | Presentation |
|---|---|
| No combatants | `No combatants yet.` plus `Add monsters or characters with the buttons above. Press r to roll initiative.` |
| No data for a panel | The panel is absent. Never `0 of 0`. |
| Roll input invalid | `aria-invalid`, message in the Action region, no request. |
| Action failed | The sticky alert (6.2); control states unchanged; focus stays on the control used. |
| Impossible Move after | Server message in the same alert. |
| Combat ended | Toolbars and shortcuts off as today; rows read-only: panels keep their pips and words but lose their buttons; More hidden. |
| SSE drops | Not in I3.3 (P2). |
| Loading / load error | Existing. |

## 12. Scope: later / optional (not in I3.3)

- P2: a form in More to edit legendary per round / in lair and Legendary Resistance max / in lair / spent (5 fields, incl. adding them to a custom combatant).
- P2: a `Turn off single-key shortcuts` switch (fixes existing WCAG 2.1.4 debt for `n`, `p`, `r`).
- P2: `Live updates paused` indicator, both pages.
- P2: recent recharge rolls list.
- P2: "legendary action available" hint after `next`.
- P2: DM switch to hide PC death-save counts from the table (rules Q1 b).
- P2: `Add lair row?` suggestion when adding a monster whose group has lair actions, and `Open lair text` (both need the legendary group on the client; `ref` is `null` in I3.3).
- P2: adding recharge abilities to a hand-made combatant.
- Later epics: reaction tracking, delay-interrupt/resume, per-day Legendary Resistance persistence, redesign of the rest of the DM page for phones.

In I3.3 scope (explicit): the 0-HP dimming replacement, 44 px for the existing row controls and toolbar buttons under `touch`, the Apply button, `addMonster` passing combat facts, the sticky split, `+ Lair`, the help panel, `Start death saves`.

## 13. Acceptance checks for the Evidence Collector

Built bundle. Two seeds: **Boss fight** (a dragon-class creature: legendary actions 3 (4 in lair), Legendary Resistance 3 (4 in lair), Fire Breath recharge 5-6; two PCs; a kobold; a custom combatant) and **Dying PC**. Test data only; screenshots stay out of the repository (PROJECT.md §4).

### 13.1 Matrix

| Axis | Values |
|---|---|
| Width | 1280 x 900; 390 x 844 (`isMobile`, `hasTouch`, scale 2); 320 x 640 (overflow only); 844 x 390 landscape (sticky container static) |
| Theme | light, dark |
| Text size | 100 % and 200 % (`document.documentElement.style.fontSize = '200%'`) at 390 and 1280 |
| Pages | DM tracker: a row with each panel; death saves dying / stable 0/0 / stable with 3 successes / dead; More open; Ready form; Move after; lair row hidden and shown; help open; recharge note visible; alert visible. Player view: dying PC, stable, dead, readied PC, lair row un-hidden, boss row (nothing new) |

### 13.2 Layout

- No sideways scroll (`scrollWidth === clientWidth` of document and `main`) at 320, 390, 1280, 100 % and 200 %; no element with `right > innerWidth + 1`.
- **Sticky container height** (turn toolbar + status slot), measured with `getBoundingClientRect().height` at 390: empty slot <= 64 px at 100 % text; with **one** recharge roll note or an alert <= 130 px; at 200 % text empty <= 160 px (Prev and Next wrap to two rows of about 64 px) and with one roll <= 270 px. The toast is capped at 2 lines plus `+ N more`; test with 1 roll and with 5 rolls. At 844 x 390 the container is not sticky (`position: static`). Next turn is reachable without scrolling at any scroll position (portrait).
- A boss row at 390: report its height (expected about 630-650 px at 100 % text), not a gate; a kobold row <= 280 px.
- **DOM order = visual order** at 390 and 1280: for the row, the vertical/then-horizontal reading order of the interactive elements (by `getBoundingClientRect`) equals `document` order; no `order:` or `flex-direction: *-reverse` in the computed styles of the row.

### 13.3 Targets and text

- Under touch emulation every new control and every existing row control and toolbar button is >= 44 x 44 (phone-layout 9.3 snippet scoped to the tracker page; pips excluded). Header buttons are out of scope. Spacing: >= 8 px between neighbouring buttons in the death-save panel, >= 16 px before **Dead**, >= 12 px between hide, More and Remove.
- Inputs 16 px on touch; nothing under 12 px.
- No `truncate` on a name, trigger or message.
- Accessible names (Playwright `ariaSnapshot`): each control's name contains its visible text (check `Nat 20`, `Nat 1`, `Spend 1/2/3`, recharge chips, `Apply`, `More`); the hide button's name is fixed and `aria-pressed` toggles; recharge chips are buttons (no `switch`), with `Ready`/`Spent` in the name once.

### 13.4 Not colour alone

- Greyscale and CVD (deuteranopia, protanopia) screenshots of the death-save panel, legendary and resistance pips, recharge chips and the player view: success vs failure, filled vs empty, Dying/Stable/Dead and Ready/Spent stay distinguishable and each has its word.
- Programmatic: every filled pip has a glyph child; each group has `N of M` as visible text; no `sr-only` text that repeats visible text.
- axe-core (wcag2a, wcag2aa, wcag21aa, wcag22aa) at 390 and 1280, light and dark: 0 violations on both pages in both seeds (`color-contrast`, `button-name`, `label`, `aria-valid-attr-value`, `list`/`listitem`).

### 13.5 Keyboard and screen reader

1. Tab order matches 8.2; focus ring visible and unclipped; no trap. `Escape` closes the More panel, a form, the help and the note, returns focus to the opener, and the entity preview (if open) does **not** close at the same time.
2. Roll field: `17` Enter records a success; if the PC is the active one, focus moves to **Next turn**, else stays in the field. `20` Enter: panel disappears, focus on the HP input. `0` and `21`: `aria-invalid`, `Enter 1 to 20`, no request (network). `Escape` in the field: focus to that row's More button. **Roll for me**: a number between 1 and 20 is sent in the request and spoken to the DM; the dice log and dice toast are unchanged.
3. Steppers at the ends do nothing and say so; counters never leave 0-3 or 0-max in the DOM.
4. Three failures -> `Dead`, name struck through, `Back to dying`. Three successes -> `Stable`, roll controls gone, `Clear counts` visible; `Clear counts` gives stable 0/0. The `Stable` button on a 2-failure character gives stable 0/0 directly.
5. Shortcuts: `n`, `p`, `r` work. `n` with focus inside the End-combat confirm dialog does nothing. `?` toggles the help. `d`, `l`, `Shift+L`, `u`, `Shift+U` work only with focus inside a row and act on that row; held key repeat does not repeat them; in a text field they type; with `Ctrl` nothing happens. With no row focus and exactly one legendary creature, `l` acts on it; with two, the message `Focus a combatant first.` is announced. `d` has no global fallback.
6. Accessibility tree: one Action-region update per action; the recharge note does not double-speak; the alert container exists with no content at load.
7. **Move after on the active creature**: the turn passes on at once (the next combatant is active, the Active turn chip moves); the announcement is `<Mover> now acts after <Target>. <New active>'s turn.`; the page shows no "press Next" text; if the new active has a spent recharge ability, the note appears; legendary pips of the new active refill. Move on a non-active creature: the order changes and the active creature stays. Last in order: the select is disabled with the visible hint.

### 13.6 Functional (I3.4 repeats these)

- Legendary: spend 1, 2, 3 and Undo; pips and text agree; at 0 left the buttons still work, text says `None left`; `Next` refills, `Previous` does not. In lair: max 4. Warning chip appears at `hp <= 0` and with Stunned.
- Resistance: Use one / Give back; `Next` leaves it alone.
- Recharge: two same-name entries render as **one** chip and one click affects both; mark used, `Next` to the creature: the note shows `Round N` and the roll in words and **stays** (no fade, wait 30 s); the chip updates; reload: chip persists, note does not.
- Lair row: `+ Lair`; hidden by default; no AC, HP, HP input, conditions, More, death saves; the hide toggle name is fixed and `aria-pressed` toggles, chip `Shown to players`; the notes field saves; the warning chip appears when no living creature is marked in lair.
- Ready: set on a PC (helper says players see it) and on a monster (helper says only you); both show on the DM row; the player view shows the PC's only; Clear and the next turn remove it.
- Temp HP: damage fully absorbed on a PC at 0 HP -> no failure and the announcement says so; damage past the temp HP -> one; with Critical hit -> two. The Critical hit checkbox is also present on a **stable** PC and a PC at 0 HP without a `dying` object, and absent on a dead one.
- A monster without the flag at `hp <= 0`: `Down` chip, no panel; `Makes death saves` then shows `Start death saves`.

### 13.7 Player view (leak check)

Open the player view in a second context while the DM runs the boss seed. Capture DOM text, attributes, the `sr-only` region and network payloads (GET and SSE).
- Must show: PC pips and status, PC readied trigger, an un-hidden lair row as name + initiative.
- Must not appear anywhere: `legendary`, `resistance`, `recharge`, a recharge ability name, a monster's readied trigger (sentinel `ZZ-SENTINEL-READY`), `inLair`, `tieRank`, AC, any death-save roll value, a monster's or hidden combatant's `dying`, the hidden lair row, DM `notes` (lair last-effect sentinel), the recharge note text, the Roll-for-me number.
- A dying PC's name is **not** struck through; a dead PC's is. 390 and 1280, light and dark, 200 %: pips >= 1.5 rem, status words visible, no overflow, trigger not truncated.

### 13.8 Regression

`pnpm -s typecheck && pnpm -s lint && pnpm -s test` and `pnpm e2e` pass at 1440 x 1000. `tracker-player.spec.ts` gains dying and readied cases; visibility tests stay green. The existing shortcuts and HP syntax keep working.

## 14. Implementer notes (not decisions)

- `addMonster` passes the statblock facts on `add`: from `parseStatblockCombatFacts(entity.data)` (exported by `@cn/fivetools`). It returns `legendary: null` when there is none, but `combatantInput.legendary` is `.optional()` and **rejects `null`**: map `null` to `undefined` (same for `resistance` and an empty `recharge`). `deathSaves` stays false for monsters.
- Derive per-row view state with `computed` on `order()`. A `TrackerRow` child component (`input.required<Combatant>()`) is fine; keep `data-trk-id` on the host `li`.
- Do not mutate the DTO. Build announcements by comparing the previous and next combatant of the touched row.
- No `innerHTML`; all user text by interpolation.
- `Roll for me` uses a private `crypto.getRandomValues` helper, never `DiceService`.

## 15. Open questions

| Q | Question | Options | Recommendation | Decides |
|---|---|---|---|---|
| 3 | `Roll for me` rolls the d20 on the client (private to the DM) and sends `deathSave { roll }`. **Decided by the owner, 2026-10-24: (a).** | (a) client roll (chosen); (b) server rolls | (a) | Owner (done) |

Decided by the coordinator and recorded here (no further input needed): Q1 stable-with-counts is gone (Stable and Clear counts use `reset` + `status: 'stable'`); Q2 lair warning = no living combatant marked in lair; Q4 recharge chips deduped by name; Q5 roll controls hidden when stable or dead (Back to dying stays one tap); Q6 no page numbers in the help.
