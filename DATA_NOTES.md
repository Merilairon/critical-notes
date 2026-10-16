# 5etools data notes

What the data actually looks like, found by surveying a fresh shallow clone. Later design decisions are based on these findings.

- **5etools-src:** `v2.37.0`, commit `8c026b8`, Oct 8 2026, in `5etools-data/5etools-src`.
- **5etools-img:** `v2.37.0`, commit `4386d1b`, in `5etools-data/5etools-img`, 13 GB on disk.
- **Schemas:** npm `5etools-utils@0.17.21` (MIT).

The survey scripts walk every JSON file under `data/` except `adventure/`, `book/` and `generated/`.

## 1. Layout of `data/`

| Kind | Files | Top-level arrays |
|---|---|---|
| Monsters | `bestiary/bestiary-<src>.json` (111 files) + `bestiary/index.json` (source → file) | `monster` |
| Monster fluff | `bestiary/fluff-bestiary-<src>.json` + `bestiary/fluff-index.json` | `monsterFluff` |
| Legendary groups / templates | `bestiary/legendarygroups.json`, `bestiary/template.json` | `legendaryGroup`, `monsterTemplate` |
| Spells | `spells/spells-<src>.json` + `index.json`, `fluff-spells-*.json` + `fluff-index.json` | `spell`, `spellFluff` |
| Spell class lists | `spells/sources.json` (`{SRC: {SpellName: {class:[{name,source}], …}}}`), `generated/gendata-spell-source-lookup.json` | n/a |
| Classes | `class/class-<name>.json` + `index.json`, `fluff-class-*.json` | `class`, `subclass`, `classFeature`, `subclassFeature`, `classFluff`, `subclassFluff` |
| Species/races | `races.json`, `fluff-races.json` | `race`, `subrace`, `raceFluff` |
| Backgrounds / feats / optional features | `backgrounds.json`, `feats.json`, `optionalfeatures.json` (+ fluff files) | `background`, `feat`, `optionalfeature` |
| Items | `items.json`, `items-base.json`, `magicvariants.json`, `fluff-items.json` | `item`, `itemGroup` / `baseitem`, `itemProperty`, `itemType`, `itemTypeAdditionalEntries`, `itemEntry`, `itemMastery` / `magicvariant` / `itemFluff` |
| Conditions | `conditionsdiseases.json` | `condition`, `disease`, `status` |
| Rules | `actions.json`, `variantrules.json`, `senses.json`, `skills.json`, `languages.json`, `tables.json` | `action`, `variantrule`, `sense`, `skill`, `language`, `table`, `tableGroup` |
| Other entities | `trapshazards.json`, `objects.json`, `vehicles.json`, `deities.json`, `rewards.json`, `cultsboons.json`, `decks.json`, `bastions.json`, `recipes.json`, `homecrafts.json`, `charcreationoptions.json`, `psionics.json` | `trap`/`hazard`, `object`, `vehicle`, `deity`, `reward`, `cult`/`boon`, `deck`/`card`, `facility`, `recipe`, `crochetPattern`, `charoption`, `psionic` |
| Loot tables | `loot.json` | `individual`, `hoard`, `gems`, `artObjects`, `magicItems`, `dragon`, … |
| Books / adventures | `books.json` (66) / `adventures.json` (101) metadata + `book/book-<id>.json`, `adventure/adventure-<id>.json` content (`data: [entries…]`) | `book`, `adventure` |
| Derived | `generated/gendata-*.json` (tag redirects, spell sources, subclass lookup, tables, maps) | n/a |
| Not relevant to us | `foundry*.json` (VTT data), `makebrew-creature.json`, `makecards.json`, `renderdemo.json`, `converter.json`, `encounterbuilder.json` (encounter shapes), `life.json`, `names.json`, `msbcr.json` | |

`homebrew/index.json` and `prerelease/index.json` are empty loaders (`toImport: []`). No homebrew content ships with the repo.

## 2. Sources and editions

**Source IDs.** Every entity has a `source` (e.g. `PHB`, `XPHB`, `MM`, `XMM`, `DMG`, `XDMG`, `XGE`, `TCE`, `MPMM`) and usually a `page`. Book and adventure metadata has `id`, `source`, `name`, `group` (core/supplement/setting/…), `published` (ISO date), `author`, `cover`, `parentSource`, `revised`, `alias`.

**Books have no `edition` field.** I checked v2.7.0 and v2.37.0, and neither has one. Here is how edition can actually be determined.

| Signal | Where | Notes |
|---|---|---|
| `sourcesClassic` / `sourcesModern` / `sourcesLegacy` enums | `5etools-utils/schema/site/sources-5etools.json` | 147 classic, 36 modern. Legacy = PHB, DMG, MM, EEPC, VGM, MTF, Screen. 5etools' own tests use these lists. |
| Publish date vs XPHB (2024-09-17) | `books.json` / `adventures.json` `published` | This is `SourceUtil.isClassicSource` in `js/utils.js`. It **agrees with the lists for every source used in the data.** |
| Entity `edition: "classic" \| "one"` | `background` (70 one), `baseitem` (176 mixed), `class`, `subclass`, `race`, `magicvariant` | Overrides the source's edition. `items-base.json` mixes both editions in one file. |
| `srd` / `basicRules` | 2014-era SRD 5.1 / Basic Rules flags | `srd` can be a string: the entity's name in the SRD, e.g. "Arcane Hand". |
| `srd52` / `basicRules2024` | 2024 SRD 5.2 / free rules flags | v2.7.0 had `freeRules2024`, now gone. Read both names. |

**Gaps.**
- `HFLotT` and `RWG` (Sep 2026) aren't in the 5etools-utils lists yet; the date rule correctly classes them as modern.
- 15 sources used in the data have no `books.json` / `adventures.json` entry (e.g. `EEPC`, `MFF`, `VD`, `DrDe`), but every one of them is in the lists.
- `Generic` appears only in encounter-builder shapes and render demos, not in rules content.

**Resolver order:** homebrew declared edition → lists → date → classic with a warning.

**Reprints.** `reprintedAs` is an array (2,610 refs). Each element is either:
- a string `"Name|SOURCE"` (2,539 refs), or
- `{uid: "Name|SOURCE", tag}` (71 refs): a cross-type reprint, e.g. optionalfeature → feat (fighting styles), variantrule → hazard (Falling), item → item group.

The target can be in the same edition (VGM → MPMM) or the other (PHB → XPHB), and one entity can have several targets (Aasimar → MPMM and XPHB). 17 monsters carry `isReprinted`.

**Other source refs.** `otherSources` (older) and `referenceSources` (newer, a plain array of IDs) both appear, along with `additionalSources`.

**Default tag sources stay classic.** Each tag class in `js/render.js` has a `defaultSource`: spell/feat/race/class/background/condition/skill/sense/action → PHB, creature → MM, item/table/hazard/trap/variantrule/deck/reward → DMG, itemMastery/facility → XPHB/XDMG. So 2024 content always writes the source explicitly (`{@spell fireball|XPHB}`).

## 3. Inheritance: `_copy` / `_mod`

**Where it's used.** `_copy` appears on 2,970 entities:
- monster 1,144, monsterFluff 1,274, itemFluff 149, subclass 124, raceFluff 90, subclassFeature 75, item 67, background 26, subclassFluff 22, race 16, legendaryGroup 16
- smaller counts on deity, deck, featFluff, magicvariant and others

**Identity keys** for the parent go beyond name+source, depending on type: `shortName`, `className`, `classSource`, `subclassShortName`, `subclassSource`, `level`, `raceName`, `raceSource`, `pantheon`, `abbreviation`. The resolver needs an identity function per entity type.

**Control keys:**
- `_mod`: `{prop | "*": mod | mod[]}`. `"*"` applies a text mod to every prop.
- `_templates`: `[{name, source}]` → `monsterTemplate.apply` (`_mod` + `_root`).
- `_preserve`: `{prop: true}`.

**Modes used in the data:** prependArr 1,254, replaceTxt 804, replaceArr 212, appendArr 189, setProp 56, insertArr 46, removeArr 38, appendIfNotExistsArr 24, replaceSpells 14, remove 9, addSkills 6, addSpells 6, removeSpells 1.

**Other modes in the code** (`DataUtil.generic.copyApplier`, `js/utils.js`) that homebrew can use: replaceOrAppendArr, replaceName, calculateProp, scalarAddProp, scalarMultProp, prefixSuffixStringProp, addSenses, addSaves, addAllSaves, addAllSkills, maxSize, scalarMultXp, scalarAddHit, scalarAddDc. We implement all of them.

**Merge rules:**
- Props absent on the child are copied from the parent.
- A child prop set to `null` deletes it.
- These props are **not inherited** unless `_preserve`d: `page`, `otherSources`, `referenceSources`, `srd`, `srd52`, `basicRules`, `basicRules2024`, `reprintedAs`, `hasFluff`, `hasFluffImages`, `hasToken`, `tokenCredit`, `tokenCustom`, `foundryTokenScale`, `altArt`, `_versions`.
- Mod strings can contain variables like `<$name$>`, `<$short_name$>`, `<$title_short_name$>`, `<$spell_dc__int$>`, `<$to_hit__str$>`, `<$damage_mod__str$>`, `<$damage_avg__…$>`, resolved against the child.
- ⚠ `calculateProp` runs `eval()` on a formula with `<$prof_bonus$>` / `<$dex_mod$>` in 5etools. **We use a safe arithmetic evaluator instead.**

**Runtime expansions** 5etools does at load time, which we have to port:
- `_versions` (132 entities). Shapes: plain, `_mod`, `_templates`, `_abstract` + `_implementations`. Example: XMM "Animal Lord; Forager".
- `subrace` merging into `race` (a race and its subrace become one entry, e.g. "Elf (High)").
- Generic `magicvariant` × `baseitem` → specific items. Uses `inherits`, `requires`, `excludes`, plus an edition rule: classic generic variants don't apply to "one" base items.
- Class `classFeatures` / `subclassFeatures` refs (`"Name|Class|ClassSrc|Level|Src"`) resolve to feature objects.

## 4. Fluff

- `fluff-*.json` mirrors the entity files: `monsterFluff`, `itemFluff`, `raceFluff`, `backgroundFluff`, `featFluff`, `spellFluff`, `classFluff`, `subclassFluff`, `conditionFluff`, … Each entry is keyed by `name` + `source`, and fluff can `_copy` too.
- Each fluff entry has `entries` (lore) and `images: [{type: "image", href: {type: "internal", path: "bestiary/MM/Goblin.webp"}, credit}]`.
- Entities point at their fluff with `hasFluff` / `hasFluffImages`. Monsters also have `hasToken`, `token: {name, source}` (reuse another creature's token), `altArt`, and `soundClip` (`.opus`).

## 5. `entries` and `{@tag}` markup

**Entries.** An entity's `entries` is an array whose items are strings (with inline tags) or typed objects. Typed objects used in the data:
- Structure: `entries`, `section`, `chapter`, `list` (`style`, `items`), `table` (`caption`, `colLabels`, `colStyles`, `rows`; cells can be `{type:"cell", roll:{exact|min,max}}`), `tableGroup`, `row`, `cellHeader`
- Callouts and quotes: `inset`, `insetReadaloud`, `quote` (`by`), `variant`, `variantInner`, `variantSub`
- Media and embeds: `image`, `gallery`, `statblock` (embed another entity by tag/name/source), `statblockInline`, `spellcasting`
- Item lists: `item`, `itemSub`
- References: `refClassFeature`, `refSubclassFeature`, `refOptionalfeature`, `refFeat`
- Flow and layout: `options`, `hr`, `flowchart`, `flowBlock`, `inline`, `inlineBlock`, `link`
- Dice and abilities: `dice`, `abilityDc`, `abilityAttackMod`, `abilityGeneric`
- Misc: `actions`, `attack`, `homebrew`, `code`

**Tags.** Inline markup is `{@tag arg1|arg2|…}`. Tags nest (`{@b {@i x}}`).
- Entity links take the form `name|source|display text` (source is optional, falling back to the tag's default source).
- `{@filter display|page|key=value|…}`, e.g. `{@filter 1st|spells|level=1|class=Wizard}`.
- The renderer defines 121 tags.

Frequency in the data:

| Group | Tags (occurrences) |
|---|---|
| Entity links | creature 56k, spell 26k, item 21k, condition 12k, variantrule 7k, action, class, background, feat, race, status, deity, card, table, sense, skill, hazard, trap, reward, recipe, language, optfeature, classFeature, subclassFeature, subclass, deck, vehicle, object, facility, itemProperty, itemMastery, cult, boon, charoption, legroup, psionic, vehupgrade, crochet, *Fluff |
| Rolls | dice 15k, damage 12k, dc 16k, hit 6k, d20, chance, recharge, scaledamage, scaledice, autodice, coinflip, skillCheck, savingThrow, ability, hitYourSpellAttack, dcYourSpellSave |
| Statblock | atk, atkr (2024), h, m, actSave, actSaveFail, actSaveSuccess, actSaveSuccessOrFail, actSaveFailBy, actTrigger, actResponse, area 24k |
| Formatting | b, i, u, s, bold, italic, underline, strike, sup, sub, code, kbd, note, tip, color, highlight, style, font, unit, footnote, comic* |
| Navigation | book 6k, adventure 1k, quickref, 5etools, 5etoolsImg, 5etoolsAudio, link, filter, homebrew, loader, hom |

## 6. Images (5etools-img)

The clone holds 19,342 `.webp`, 101 `.pdf` (under `pdf/`) and 8 `.gif` files. Top-level folders: `adventure`, `backgrounds`, `bastions`, `bestiary` (with `tokens/<SRC>/`), `book`, `characters`, `charcreationoptions`, `classes`, `conditionsdiseases`, `covers`, `crochetpatterns`, `decks`, `deities`, `dmscreen`, `feats`, `hazards`, `items`, `languages`, `objects`, `optionalfeatures`, `pdf`, `plutonium`, `races`, `recipes`, `spells`, `traps`, `variantrules`, `vehicles`, plus placeholder files `blank.webp`, `blank-2024.webp` and `blank-friendly.webp`. Our `/img` route serves only `.webp`, `.png`, `.jpg`/`.jpeg` and `.gif`.

Paths in the data are relative to the img repo root. All internal image refs are `.webp` (18,896 refs). Top-level folders referenced:
- Books and adventures: `adventure/<SRC>/…` (7.4k), `book/<SRC>/…` (4.7k)
- Bestiary: `bestiary/<SRC>/<Name>.webp` (4.5k)
- Entity art: `items/<SRC>/<Name>.webp`, `races/`, `classes/`, `backgrounds/`, `spells/`, `feats/`, `languages/`, `conditionsdiseases/`, `deities/`, `recipes/`, `crochetpatterns/`, `vehicles/`, `bastions/`, `objects/`, `traps/`, `hazards/`, `variantrules/`
- Covers and decks: `covers/<SRC>.webp`, `decks/…`

**Tokens aren't referenced in the data; the path is built from the name:**
- `bestiary/tokens/<SRC>/<nameToTokenName(name)>.webp`, where `nameToTokenName` = `toAscii()` and strip `"`.
- Uses `token.{name,source}` when present, otherwise the entity's own name and source, and only when `hasToken` is set.
- Objects and vehicles: `objects/tokens/`, `vehicles/tokens/`.

External images use `{type:"external", url}` (1 occurrence).

## 7. Schemas and the homebrew format

**Schemas.** 5etools-src ships **no JSON schemas**. `test/test-json.js` imports them from npm **`5etools-utils`** (MIT), which has `schema/{site,brew,ua}` and `*-fast` variants (102 files each). We validate homebrew against `schema/brew-fast/homebrew.json` with Ajv.

**Homebrew file format** (`homebrew.json`):
```jsonc
{
  "_meta": {
    "sources": [{ "json": "MyBrew", "abbreviation": "MB", "full": "My Brew", "authors": ["…"],
                  "convertedBy": ["…"], "version": "1.0.0", "url": "…", "color": "ff00ff", "colorNight": "…" }],
    "dateAdded": 1696000000, "dateLastModified": 1696000000,   // unix seconds
    "edition": "classic" | "one",                              // REQUIRED; "if ambiguous, classic"
    // optional: spellSchools, spellDistanceUnits, optionalFeatureTypes, featCategories, psionicTypes,
    //           currencyConversions, dependencies, includes, internalCopies, fonts, status, unlisted
  },
  "monster": [ { "name": "…", "source": "MyBrew", … } ],
  "spell": [], "item": [], "baseitem": [], "race": [], "subrace": [], "background": [], "feat": [],
  "class": [], "subclass": [], "classFeature": [], "subclassFeature": [], "condition": [], "variantrule": [], "table": [],
  "monsterFluff": [], …   // any of ~120 per-type arrays
}
```
- **Required `_meta` fields:** `sources`, `dateAdded`, `dateLastModified`, `edition`.
- **Edition:** 5etools' BrewUtil treats a missing `_meta.edition` as `"classic"`. The edition applies to every source in the file.
- **Source references:** homebrew entities set `source` to a `_meta.sources[].json` key. Tags reference homebrew the same way official content is referenced (`{@creature Foo|MyBrew}`).
- **`_copy`:** homebrew can `_copy` official entities, e.g. `{"_copy": {"name": "Goblin", "source": "XMM"}}`.
- **Dependencies:** `_meta.dependencies` / `includes` name other homebrew sources the file needs.

## 8. Encounter-building rules (checked against 5etools' encounter builder, `js/encounterbuilder/`)

- **2014 (DMG p.82):**
  - Per-character XP thresholds Easy/Medium/Hard/Deadly by level. For example, level 1 = 25/50/75/100 and level 20 = 2800/5700/8500/12700.
  - Sum monster XP × count multiplier: 1 / 1.5 / 2 (3–6) / 2.5 (7–10) / 3 (11–14) / 4 (15+).
  - Fewer than 3 PCs → next multiplier up; 6 or more PCs → next one down (0.5 for a single monster).
  - Daily XP budget per level.
- **2024 (XDMG p.114):**
  - Per-character XP budget Low/Moderate/High by level. For example, level 1 = 50/75/100 and level 20 = 6400/13200/22000.
  - Sum monster XP with **no multiplier**.
- **Shared:** CR → XP. Monster `cr` can be a string or `{cr, lair, coven, xp, xpLair}` (2024 lair XP).

## 9. Licensing

- 5etools code and `5etools-utils` are MIT.
- The *content* (rules text, statblocks) and *art* in these repos are owned by Wizards of the Coast and the credited artists. SRD 5.1 / 5.2 portions are CC-BY-4.0.
- This project never commits or bundles this content. At run time the app reads a user-supplied local clone and builds a derived, rebuildable index of it (`DATA_DIR/index.sqlite`, with full-text search) in the operator's data folder. It shows that content to the people the host invites. The index is the operator's copy and stays under the original terms.
