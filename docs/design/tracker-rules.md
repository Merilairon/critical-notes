# Tracker rules spec (Task I3.1)

Version 1.3, 2026-10-23. Owner: Game Designer. QA: Product Manager. Consumers: I3.2 (reducer), I3.3 (UI), I3.4 (tests).
Design only: no code. Rules are paraphrased in a few words and cited by heading (section 10 has the source table). This
respects the PROJECT.md §4 "Data" rule (never commit or upload `5etools-data/`, `var/`, test traces or screenshots
containing rules text): the doc copies no rules text and no 5etools text; it keeps only short field and trait names (for example the cost marker in an option name and the tag names) and counts.
Marks: **[PLACEHOLDER]** = tunable default; **[CHECK n]** = row n of the verification checklist (section 11).

## 0. Principles and data model

1. **Fast at the table** (PRD principle 5): one click or key per rule event. Resets, ticks and rolls are automatic; the DM can always override by hand.
2. **The DM is the referee.** The tracker records and reminds; it never blocks (a warning chip, not a disabled button, where a rule says "can't").
3. **Hidden stays hidden** (PROJECT.md §4, first rule). Every new field is DM-only unless section 7 lists it. The projection is a whitelist built by explicit field copy (as `projectTrackerForPlayers` already does); never a spread of a combatant.
4. **Statblock facts are snapshotted** into the combatant at `add`. An edited or deleted statblock cannot change a running fight. Custom combatants get the same fields by hand.
5. **Edition follows the statblock, not the campaign.** A 2014 dragon in a 2024 campaign behaves as printed. The campaign ruleset only supplies defaults for hand-made combatants and PC rules, through `Ruleset`/`RulesetFeatures` (no edition-string comparisons outside `packages/fivetools/src/ruleset` and `edition`). The rules in this epic are nearly identical in both editions; differences are stated per rule. Today no flag is needed.

New optional fields on `Combatant` (stored in the existing `trackers.state` JSON; old rows lack them, so every field is optional and defaulted on parse; I3.2 confirms no schema migration):

| Field | Applies to | Contents |
|---|---|---|
| `dying` | `pc`, or any combatant the DM flags | `{ successes 0-3, failures 0-3, status 'dying' \| 'stable' \| 'dead' }`, absent when not at 0 HP |
| `legendary` | exists **only** when the creature has legendary actions | `{ perRound, perRoundLair, used }`; `perRoundLair` defaults to `perRound` when the statblock has none |
| `resistance` | exists **only** when the creature has Legendary Resistance (split from `legendary` because a creature can have either one without the other, e.g. several non-legendary-action monsters have the trait) | `{ max, maxLair, used }`; `maxLair` defaults to `max` |
| `inLair` | any combatant | boolean, default false. A **manual toggle** per combatant (works for custom combatants and any statblock). Convenience only: adding a lair row offers "mark creatures of this legendary group as in lair" once; the pairing is never automatic and never re-derived |
| `recharge` | monsters | list of `{ name, min 2-6, ready }` |
| `readied` | anyone | `{ trigger, spell }` or absent |
| `tieRank` | anyone | integer, default 0; tie-break for equal initiative (section 6); the lair row uses a large value so it loses ties |
| `kind: 'lair'` | one pseudo-combatant | the lair-action turn (section 4) |

Effective values: `perRound` used = `inLair ? perRoundLair : perRound`; same for resistance `max`.

## 1. Death saving throws

**Rule (both versions, as the tracker implements them).**
- A character dropped to 0 HP falls unconscious and, at the start of each of its turns, rolls a plain d20 (no modifiers unless a feature says so): 10+ success, 9- failure. 3 successes: stable. 3 failures: dead. Counts need not be consecutive and clear on healing or stabilizing.
- Natural 20: regain 1 HP and wake (counts clear). Natural 1: two failures. Same in 2014 and 2024.
- Damage while at 0 HP: one failure; a critical hit (any hit from within 5 feet on an unconscious creature is a critical hit) is two. Same in both editions.
- Massive damage: if the damage left over after reaching 0 is at least the maximum HP, the creature dies at once. Same in both editions.
- Healing above 0: the creature is conscious at that HP, counts clear.
- Stable: no more saves, stays at 0 HP; an untreated stable creature regains 1 HP after 1d4 hours (2014 text; 2024 keeps the same state **[CHECK 2]**). The tracker does not count hours.
- Stabilizing: a DC 10 Wisdom (Medicine) check, *Spare the Dying*, or healing; the DM rules it, the tracker offers "stable" as a button.
- Temporary HP **[CHECK 1]**: both editions say damage reduces temporary HP first. Neither says in so many words whether damage fully absorbed by temp HP at 0 HP counts as "damage taken" for a failure. **Tracker default (both editions): absorbed damage adds no failure; only damage that gets past temp HP does.** This is a table convention, not printed rules text, and the I3.3 UI help text must say so. The table can override with the manual failure button.
- Monsters and most NPCs are dead at 0 HP unless the DM decides otherwise; the DM may flag any combatant as making death saves.

**Difference table.** 2014 vs 2024: none that changes a number. The 2024 book moves the "unconscious creature hit from within 5 feet" crit wording into the Unconscious condition and describes Stable as a state in the glossary **[CHECK 2]**. One implementation.

**Tracker behaviour.**
- An `hp` change taking a `pc` (or flagged) combatant from above 0 to 0 creates `dying { 0, 0, 'dying' }`. If the overflow (damage minus HP left, after temp HP) is at least `hpMax`: `dead` at once. The reducer must compute the overflow before the existing `Math.max(0, ...)` clamp (today it is lost). `hpMax` null: no massive-damage check.
- Damage on a `dying` combatant: +1 failure (+2 with an optional `crit` flag on the `hp` action), after the temp-HP rule above.
- Action `deathSave { id, roll? }`: `roll` is the d20 the player rolled at the table (normal case, typed by the DM); without it the server rolls `ctx.d20`. Outcomes: 20 sets hp 1 and clears `dying`; 1 adds two failures; otherwise success or failure; 3 successes `stable`, 3 failures `dead`. Manual +success, +failure and reset are also offered (features such as Bless, rulings).
- Healing above 0 or an HP edit above 0 clears `dying`. Back to 0 after being stable restarts at 0/0.
- Reminder: when a `dying` combatant becomes active the death-save control is highlighted; nothing is rolled by itself. `next` skips nothing. Stable/dead combatants stay in the order until the DM removes them (a dead PC may be revived).
- Counters never leave 0-3: actions are applied in order by the server, extras are clamped.

**Player projection.** For `pc` only: successes, failures and status, shown to the whole table (the dice are rolled in the open and these are the players' own characters). **Default on; the "hide counts" DM switch is optional/later (P2)**: v1 ships without it; the question is Q1. Non-PC combatants: never any `dying` data; players see the existing `health: 'down'` and nothing else. Rolls, overflow and the massive-damage note are DM-only.

## 2. Legendary actions

**Rule.** A legendary creature gets a number of legendary actions (3 unless the statblock says otherwise). Out of its own turn, only at the end of another creature's turn and one at a time, it spends them on options from its list; some options cost 2 or 3. Spent uses return at the start of its own turn. It cannot use them while incapacitated or unable to act.
**2014 vs 2024.** 2014 prints "can take 3 legendary actions" in a header paragraph and puts the cost in the option name (a "costs N actions" marker). 2024 prints a stat line "Legendary Action Uses: 3 (4 in Lair)", a larger number in the lair, and says all expended uses return at the start of the creature's turn. Some 2024 options add a text-only lockout (the option cannot be repeated until the creature's next turn starts), which the tracker does not enforce. Reset timing is the same. How surprise interacts with legendary actions is open **[CHECK 3]**; the tracker does not model surprise.

**Data (5etools, checked on the local data).**

| Need | Field | Notes |
|---|---|---|
| Has legendary actions | `legendary` (array of `{name, entries}`) | 396 monsters |
| Uses per round | `legendaryActions` (number) | only 13 monsters (values 2, 3, 5); absent = 3 |
| Uses per round in lair | `legendaryActionsLair` (number) | 46 monsters (2024 statblocks, e.g. XMM Adult Red Dragon = 4); absent = same as above |
| Cost of an option | none; parse "(Costs N Actions)" from the option name, default 1 | display only |
| Header text | `legendaryHeader` | 6 monsters; display only |
| Group | `legendaryGroup {name, source}` | 240 monsters; links to lair text (section 4) |

A parse failure falls back to 3 and the DM edits the number. Custom combatant: the DM types `perRound` (0 means none, no `legendary` object).

**Tracker behaviour.**
- `legendary.used` 0..effective perRound. Controls: spend 1/2/3, undo; pips. Over-spend allowed with a warning chip, stored capped.
- **Reset:** automatic when the creature becomes the active combatant (`next`, `start`): `used` = 0. `prev` does not restore the old count (documented; use undo). `end` leaves counts alone.
- Warning chip (not a block) when the creature has Incapacitated, Paralyzed, Stunned, Unconscious or Petrified.
- Edge cases: two legendary creatures after the same turn (each own counter); creature added mid-fight starts at 0 used; removal drops the state.
- **Optional/later (P2, not in v1):** a "legendary action available" hint on the creature after `next`. Justification for later: pure convenience; the pips already show it.

**Player projection.** Nothing. The counter, the costs and the very fact that the creature has legendary actions stay DM-only. `PlayerCombatant` gains no field here.

## 3. Legendary resistance

**Rule.** When the creature fails a saving throw it may choose to succeed instead, a limited number of times per day (usually 3). A day (long rest), not a round or a fight, restores it.
**2014 vs 2024.** Same trait. 2024 statblocks often give a larger lair number in the trait name: "3/Day, or 4/Day in Lair".
**Data.** No structured field; the count is only in the trait name. Observed shapes: `Legendary Resistance (N/Day)` (358), `(N/Day, or M/Day in Lair)` (43), `(N/Day, or M/Day in Domain)` (17), `(N/Day in This Form)` (3), and typo variants (no comma, lower-case "lair"). Parse rule for I3.2: trait name starts with `Legendary Resistance`; first `(\d+)/Day` is `max`; an optional second `(\d+)/Day in (Lair|Domain)` is `maxLair` (Domain treated as Lair); no match = no `resistance` object.
**Tracker.** `resistance.used`/`max`; controls "use one", undo; pips. Never reset by `next` or a new round. Starts full at `add` (per-day persistence across fights is Q3; v1: the DM edits the count when adding the creature).
**Player projection.** Nothing. Remaining uses are a DM secret.

## 4. Lair actions

**Rule.** A creature fighting in its lair takes a lair action on initiative count 20 each round, losing initiative ties at 20, choosing one effect, not repeating the same effect two rounds in a row. Same in both editions.
**2014 vs 2024.** Same initiative rule. In 2024 the lair information sits in the statblock entry and changes numbers in the lair (legendary uses, resistance, section 2/3); in 2014 it is on a separate lair block, modelled in 5etools as the legendary group's `lairActions`.
**Data.** `legendarygroups.json`: `{name, source, lairActions, regionalEffects, mythicEncounter}`, linked by `legendaryGroup`. The tracker needs only the existence of lair actions; the text is shown through the existing reference viewer, never copied into the tracker state.
**Tracker.**
- A lair row (`kind: 'lair'`, `initiative: 20`, name "Lair actions", `ref` = group key if known, `hidden: true` by default). Added by a toolbar button, or suggested (one click, never automatic) when a monster whose group has `lairActions` is added. One per tracker by default; more allowed.
- **Pairing with `inLair`:** none automatic. `inLair` is the manual toggle from section 0; adding the row offers a one-time "mark creatures of group X as in lair" for statblock creatures. Custom combatants are toggled by hand. Removing the row changes no `inLair`.
- **Ordering:** `tieRank` of the lair row is a large value so `sortCombatants` places it after every other combatant with initiative 20 (section 6 gives the full sort key).
- No HP, conditions or death saves on the row; those controls are hidden. It can be the active turn; `next` passes through it. A free-text "last effect used" note on the row reminds the no-repeat rule.
- A warning chip when every combatant of the row's group is dead or removed. The row stays until the DM removes it.
**Player projection.** The row is hidden by default, so the projection drops it, and **`activeId` becomes null while it acts** (existing hidden-turn behaviour). Accepted trade-off (Q6): players see the active highlight vanish for one beat, the same as for any hidden combatant. If the DM un-hides it, players see only the name and the initiative 20. The note and `ref` never project.

## 5. Recharge abilities

**Rule.** An ability marked "Recharge X-6" (or "Recharge 6") is spent when used. At the start of each of the creature's turns the DM rolls a d6 for each spent ability; X or higher makes it available. Same in both editions. Short-rest/long-rest recharges are text only and not tracked.
**2014 vs 2024.** None mechanically. 2024 prints "Recharge 5-6" in the name; the 5etools name still carries the `{@recharge 5}` tag.
**Data.** The tag is in the **name** of an action, bonus action, reaction or trait: `{@recharge 5}` (min 5), `{@recharge 4}`, bare `{@recharge}` (min 6), `{@recharge 6}` (2 entries). Local counts: actions 531 / 139 bare / 70 with 4; bonus actions 37 / 15 bare / 37; a handful of reactions and traits. Parse: `\{@recharge(?:\s+(\d))?\}` over the `name` of entries in `action`, `bonus`, `reaction`, `trait`; min = digit or 6. Store name (tag stripped), `min`, `ready: true`. Legendary options are never recharge.
**Tracker.**
- "Used" sets `ready: false`; a spent ability shows its threshold ("Fire Breath 5-6").
- On `next`/`start`, when a combatant becomes active, each spent ability rolls 1d6 on the server (reducer context gains `d6` or `die(sides)`; today only `d20` exists) and becomes ready on roll >= `min`. The result shows as a DM-only toast ("Fire Breath: rolled 4, needs 5, still spent"). A manual "recharged" toggle overrides. `prev` does not undo a roll.
- **Optional/later (P2):** a "recent rolls" list (**[PLACEHOLDER]** 5 entries). Justification for later: the toast already shows the result; the list is audit convenience.
- Edges: used twice before the turn stays spent; added creatures start ready; removed creatures drop their state.
**Player projection.** Nothing. Spent state tells players when the breath is back.

## 6. Ready and delay

### Ready
**Rule.** The Ready action: on its turn a creature picks a perceivable trigger and a response; the response uses its reaction when the trigger happens before the start of its next turn. A readied spell is cast on the turn (slot used) and held with concentration; unused, it is lost. Same in both editions.
**Tracker.** `ready { id, trigger, spell }` sets `readied`. "Fire" (the trigger happened) just clears `readied`. **Reaction tracking is deferred (Q4)**, so firing does not mark a reaction as used; the DM remembers it. `readied` also clears automatically when that combatant next becomes active (the readied action lapses). Badge "Readied" with the trigger visible to the DM.
**Player projection.** `pc`: `readied: true` plus the trigger text (the players know it). **Non-PC (monster, NPC, custom): hidden, nothing projected** (the trigger and the very act of waiting are DM information).

### Delay (minimal v1: one mechanism, "move after")
**Rule.** Delay is not in the SRD; it is a DMG optional rule in 2014 and discussed in the 2024 books; the source page is open **[CHECK 4]**. Mechanically: a creature gives up its place and acts later; its initiative changes permanently to the new spot.
**v1 mechanism.** One action `moveAfter { id, afterId }`: the combatant takes the initiative of `afterId` and the position immediately after it. There is no "delayed" state, badge or "resume"; the interrupt-later-in-the-round variant is deferred. A delay is the DM pressing "move after..." on the active combatant and choosing a combatant later in the order; that one action also hands the turn on (no separate `next`).
- **Sort key** (replaces today's order): initiative desc, `tieRank` asc, `initBonus` desc, name, id. `moveAfter` sets mover.initiative = target.initiative, mover.tieRank = target.tieRank + 1, and adds 1 to the `tieRank` of every other combatant at that initiative with a `tieRank` greater than the target's, so the mover lands right after the target. The lair row keeps its large `tieRank`. `moveAfter` onto the lair row's own initiative is allowed.
- **Rules of use:** the target must be a different combatant. If the mover is the active combatant, the target must come later in the current order (else a no-op rejected with a message); a non-active combatant may move anywhere (late arrival, fixing a mistake).
- **If the mover is active:** its turn ends without ticking its conditions (it did not finish its turn; they tick on its next real turn end); `activeId` becomes the combatant that followed it in the old order **and that combatant's turn starts at once**, exactly as after `next` (its legendary uses reset, its spent recharge abilities roll, its readied action lapses, a dying character's death save is highlighted); the mover's own conditions do not tick. The merged I3.2 reducer rejects (HTTP 400) a move after itself, an unknown id, the active combatant to an earlier slot, or the active combatant past the end of the order (nothing is later).
- **Round counter:** unchanged by the move. A wrap past the end of the (new) order increments the round as usual; the moved combatant acts once in the new spot this round if it is still ahead of the active turn, and in its new place every round after.
- **`prev`:** uses the current order only; the previous position is not restored (limitation, documented). **`next`:** no special case; the user does not press it after a delay by the active combatant.
- **Player projection.** No new field and no badge. The changed initiative number and order show as they do today for visible combatants; hidden combatants stay absent. Players learn "delayed" only as order, as at a physical table.

## 7. Player projection summary

| Field on `PlayerCombatant` | Who | Shown |
|---|---|---|
| `dying` (`successes`, `failures`, `status`) | `pc` only | yes (v1 always on; hide switch is later) |
| `readied` (+ `trigger`) | `pc` only | yes |
| lair row | `kind: 'lair'` | only if un-hidden; name and initiative only |
| `legendary`, `resistance`, `inLair`, `recharge`, `tieRank`, death-save `roll`, overflow note, `readied` of non-PCs, notes, `ref`, `ac` | | **never** |

Leak checklist for I3.2/I3.4 (extend `apps/server/test/visibility.test.ts` with sentinel strings):
1. Sentinels in `legendary`, `resistance`, `recharge` names, a monster's `readied.trigger` and a hidden combatant's `dying` must not appear in the player GET, the player SSE event, the `PlayerTrackerView`, nor error messages.
2. `activeId` is null while a hidden combatant or the hidden lair row acts.
3. The `{ dm, player }` listener payloads remain separate objects; the projection copies fields explicitly.
4. A hidden lair row leaves no gap in anything numeric the player sees (round, indexes): the player order is the filtered list.
5. Recharge rolls and toasts are DM-only; player events carry only the projected view. Neither `tieRank` nor `inLair` projects.

## 8. Reducer/API surface (proposals for I3.2)

`deathSave`, `deathSaveAdjust`, `legendarySpend`, `legendaryUndo`, `legendaryResist`, `rechargeUsed`, `rechargeSet`, `lairAdd`, `moveAfter` (when the mover is active it also activates the next combatant, like `next`), `ready`, `readyClear`, `setInLair`, and an extended `hp` (crit flag, overflow). Context gains `d6`/`die(sides)`. `add` takes optional `legendary`, `resistance`, `recharge`, `dying` flag, derived from the statblock. A pure helper `parseStatblockCombatFacts(monster)` in `packages/fivetools` returns `{ legendary, resistance, recharge }`; `packages/shared` stays free of the fivetools dependency.

## 9. Scope summary

In v1: death saves with the rules above (pips for PCs always shown), legendary pips and reset, resistance pips, lair row, recharge with auto-roll and toast, ready (no reaction tracking), `moveAfter` (hands the turn on when the active combatant moves).
Optional/later: hide-death-saves DM switch (P2), recent-rolls list (P2), "legendary available" hint (P2), delayed-interrupt/resume, reaction tracking, per-day resistance persistence.
Failure definition for playtest: a DM runs a boss fight with a dying PC and a legendary creature without paper; at most 2 clicks or 1 key per rule event; zero sentinel leaks (hard fail); counters never leave 0..3 or 0..perRound; no negative or doubled resets on wrap or `prev`.

## 10. Sources (headings are the reference; page cells are for the owner)

The free SRDs are the primary citation where the rule is in them (SRD 5.1 is CC-BY-4.0, SRD 5.2 is CC-BY-4.0). I could not open the printed books here, so every page cell is **owner to fill** and nothing is guessed.

| Rule | SRD 5.1 heading | SRD 5.2 heading | 2014 book, chapter > heading | 2014 page | 2024 book, chapter > heading | 2024 page |
|---|---|---|---|---|---|---|
| Death saves, massive damage, stable | Combat > Damage and Healing (Instant Death; Falling Unconscious; Death Saving Throws; Stabilizing a Creature) | Playing the Game > Damage and Healing | PHB, ch. 9 Combat > Damage and Healing | owner to fill | PHB, Playing the Game > Damage and Healing; Rules Glossary (Unconscious, Stable) | owner to fill |
| Temp HP | Combat > Damage and Healing (Temporary Hit Points) | Playing the Game > Damage and Healing | PHB, ch. 9 > Damage and Healing | owner to fill | PHB, Rules Glossary (Temporary Hit Points) | owner to fill |
| Legendary actions | Monsters > Legendary Creatures (Legendary Actions) | Rules Glossary (Legendary Action) and Monsters > Stat Block rules | MM, Introduction > Legendary Creatures | owner to fill | MM, Reading a Stat Block (Legendary Action Uses) | owner to fill |
| Legendary resistance | the trait in the SRD legendary monsters (e.g. Adult Red Dragon) | the trait in the SRD 5.2 legendary monsters | MM, Introduction > Legendary Creatures; each monster entry | owner to fill | MM, each monster entry | owner to fill |
| Lair actions | Monsters > Legendary Creatures (Lair Actions) | Monsters (lair listings) | MM, Introduction > Legendary Creatures > Lair Actions | owner to fill | MM, each monster entry (lair) | owner to fill |
| Recharge | Monsters > Actions (Limited Usage) | Rules Glossary / stat block rules | MM, Introduction > Statistics > Actions (Limited Usage) | owner to fill | MM, Reading a Stat Block (Recharge) | owner to fill |
| Ready | Combat > Actions in Combat (Ready) | Playing the Game > Actions (Ready) | PHB, ch. 9 > Actions in Combat > Ready | owner to fill | PHB, Playing the Game > Actions > Ready | owner to fill |
| Delay | not in the SRD | not in the SRD | DMG, combat chapter, optional initiative rule (name to fill) | owner to fill | DMG 2024 or PHB 2024 (to fill) | owner to fill |

## 11. Verification checklist (owner, against the printed books)

| # | Item | Where to check | Blocks | Status |
|---|---|---|---|---|
| 1 | Temp HP vs death-save failures (does fully absorbed damage at 0 HP add a failure?) | PHB 2014 Damage and Healing; PHB 2024 Damage and Healing and Temporary Hit Points glossary | **I3.2** (the `hp` action) | Open. Default chosen: absorbed damage adds no failure; owner confirms |
| 2 | 2024 Stable wording (1d4 hours, no saves, Unconscious crit wording) | PHB 2024 glossary: Unconscious, Stable; Damage and Healing | **I3.2** (the `dying` status) | Open. The tracker keeps one implementation either way; hours are not counted |
| 3 | 2024 surprise vs legendary actions; 2014 surprised creature and legendary actions | PHB 2024 Playing the Game > Surprise; MM 2024 Legendary Action rules; PHB 2014 Combat > Surprise | **I3.2** (warning chip list only) | Open. The tracker does not model surprise; only the incapacitated-style warning |
| 4 | Delay source: book, page, name of the optional rule in 2014; whether 2024 has it | DMG 2014 combat chapter; DMG/PHB 2024 | **I3.2** (citation and the `moveAfter` naming; the behaviour is a table convention and does not wait on this) | Open |
| 5 | Page numbers for section 10 | all books | I3.3 help text only | Open, owner to fill |

Gate: the owner accepts the stated defaults in writing, or checks the books. I3.2 does not wait on printed books.

## 12. Open questions

| Q | Question | Options | Consequence | Recommendation | Decides |
|---|---|---|---|---|---|
| 1 | Show PC death-save counts to the table? | (a) always (b) always plus a DM hide switch (c) hidden by default | (a) simplest, matches open dice; (b) extra control and a second projection path; (c) players lose a live cue | (a) in v1, (b) as P2 | Product Manager |
| 2 | Add a `dead` health word for non-PCs? | (a) keep `down` only (b) add `dead` | (a) no projection change, a dead monster looks like an unconscious one; (b) new word, UI, and a DM decision per creature | (a) keep `down` only | Product Manager |
| 3 | Legendary Resistance across fights of one day? | (a) always start full, DM edits the count on add (b) carry used counts between trackers of a campaign | (a) trivial, DM memory; (b) needs campaign-level state and day boundaries | (a) | Product Manager |
| 4 | Track reactions in general? | (a) defer (b) a per-combatant "reaction used" flag reset at its turn start | (a) Ready "fire" only clears the readied badge; (b) more UI, more state, a new projection decision | (a) defer to a later epic | Product Manager |
| 5 | Does moving (delaying) tick conditions? | (a) no, they tick at the end of its real turn (b) yes | (a) matches the rule that the turn did not end; (b) double ticks or early expiry | (a) | Game Designer, confirmed by the Product Manager |
| 6 | Lair row visible to players, and `activeId` null while it acts? | (a) hidden by default, activeId null during its beat (b) visible by default (c) hidden and activeId keeps the previous combatant | (a) reveals nothing but the highlight blinks, as with any hidden combatant; (b) announces a lair; (c) needs projection state | (a); the DM can un-hide | Product Manager |

## 13. Changelog

- 1.3 (2026-10-24): Delay section, action list and scope summary match the merged I3.2 reducer: `moveAfter` on the active combatant hands the turn on and starts the next turn (resets, recharge rolls); invalid moves are rejected.
- 1.2 (2026-10-23): re-QA edits: paraphrased the two book phrases and reworded the no-rules-text claim, §11 gate, temp-HP default flagged as a table convention for I3.3 help text.
- 1.1 (2026-10-23): QA round 1. Per-rule SRD-first source table with "owner to fill" page cells; PROJECT.md §4 citation corrected; verification checklist; both rule versions stated in section 1; `legendary` and `resistance` split with lair variants and a manual `inLair`; Delay reduced to `moveAfter` with edge cases; projection decisions for readied, delayed and the lair row; optional items marked; open questions rewritten with options, consequences, recommendation and decider.
- 1.0 (2026-10-23): first full spec.
