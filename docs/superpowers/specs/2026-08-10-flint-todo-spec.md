# flint-todo — Spec

**Date:** 2026-08-10
**Source:** `E:\RitoShark\Tools\flint-todo.md`
**Companion:** `docs/superpowers/plans/2026-08-09-flint-todo-plan.md` (how; this
doc is what and why). Where they disagree, this doc wins.

Behaviour and acceptance criteria only. Implementation approach, file-level
findings and sequencing live in the plan.

## Status of the source list

| Todo line | State |
|---|---|
| Thumbnail — hide sliders by default | **Shipped** `9b0c393` |
| Thumbnail — mirror model | Spec'd below (§1) |
| Project — port to classic skins | **Partly shipped** 2.8.1; remainder §2 |
| Project — NoSkinLite on right-click | Spec'd below (§3) |
| Bin Editor — persistentvfx template | Spec'd below (§4) |
| Bin Editor — find/replace + linked bin search | Spec'd below (§5) |
| Bin Editor — show every particle system | Spec'd below (§6) |
| Bin Editor — leap to next system | Spec'd below (§6) |
| Settings — Bin Editor section | Spec'd below (§7) |
| Settings — syntax colour theme | Spec'd below (§8) |

Two items carry an **assumption** because the question is still open. Each is
marked; if the assumption is wrong the spec for that item changes.

---

## 1. Thumbnail — mirror a model

**Goal.** Flip a model horizontally so a pose can face the other way without
turning it around (`orbit + 180` shows the model's back, which is not the same
thing).

**Behaviour.**
- A "Mirror" toggle in the model layer's properties, next to Scale/Turn.
- Toggling mirrors the model across its own vertical axis, in place. Position,
  scale and rotation values are unchanged and keep their meaning.
- Mirroring is per model layer, so two models on one artboard can face each other.
- The toggle participates in undo/redo as a single step, and persists in saved
  presets.

**Acceptance criteria.**
- A mirrored model renders **lit correctly** — no inside-out faces, no black or
  inverted shading. This is the whole risk of the feature (negating one scale
  axis flips winding order); a mirror that renders inside-out is a failed
  implementation, not a cosmetic issue.
- Exporting the poster reproduces exactly what the artboard showed.
- Toggling twice returns to a pixel-identical render of the original.
- An old preset with no `mirrored` field loads unmirrored.

**Out of scope.** Mirroring text, disc or env layers. Mirroring the whole
composition at once.

---

## 2. Project — League Classic skin scope

**Shipped in 2.8.1.** A "Classic" switch beside PBE swaps the champion list to
the League Classic roster; the picker sorts the Classic skin (number 300+) first
and selects it by default; champions with no Classic skin fall back to base.

**Remaining — ASSUMPTION.** "*selection with only classic skin or every variant*"
is read as a **scope filter in the picker**, not as converting an existing live
project onto the jade character folder. Converting an existing project is a
separate, much larger feature and is explicitly NOT specified here.

**Behaviour.**
- With the Classic switch on, the skin picker offers two scopes: **Classic only**
  and **All variants**.
- **Classic only** lists just the Classic skin (300+). A champion with none shows
  an empty list and an inline note saying this champion has no Classic skin
  because its current look is already the original.
- **All variants** lists everything the jade champion carries — the Classic skin
  plus the jade ports of live skins — Classic first.
- The scope resets to Classic only whenever the Classic switch is turned on.

**Acceptance criteria.**
- Ahri under Classic only shows exactly one skin, Classic Ahri.
- Ashe under Classic only shows zero skins and the explanatory note, and the
  Create button stays disabled.
- Switching scope never changes the selected champion.

---

## 3. Project — NoSkinLite

**Goal.** Make a finished mod apply no matter which skin the player has selected,
by cloning its skin BIN into every skin slot for that champion.

**ASSUMPTION.** The todo says "*if skin is on skin 0*". Specified here as
**offered only when the project's skin is 0**. Quartz's implementation accepts
any source skin, so this is a deliberate narrowing; if the intent was "any skin",
drop the gate and the rest of this section stands unchanged.

**Behaviour.**
- A "NoSkinLite" item on the project-root right-click menu, shown only for a skin
  project whose skin id is 0.
- Confirm-gated, stating plainly that it writes many new files into the project.
- On run it clones the project's `skin0.bin` into every missing slot
  `skin1..skin{max}`, rekeying each clone's `SkinCharacterDataProperties` and
  `ResourceResolver` entries and fixing `mResourceResolver` so each resolves to
  its own index.
- **Any `skinN.bin` already present is skipped**, never overwritten — a
  hand-edited skin must survive the operation untouched.
- Progress is reported through the status bar; the result toast states how many
  slots were written and how many were skipped.
- The file tree refreshes when it finishes.

**Skin ceiling.**
- Taken from CommunityDragon's raw game-data directory listing for the champion
  (`json/latest/game/data/characters/{alias}/skins/`), as the maximum `skin<N>.bin`
  present, plus a margin so a newly-shipped Riot skin still lands in an existing
  clone.
- **Not** from `champion-summary` / `champions/{id}` — those list only officially
  released skins and miss chroma, PBE and unreleased slots.
- A failed or slow lookup must not block the UI: fall back to a fixed ceiling and
  carry on, saying so in the result toast.

**Acceptance criteria.**
- Running it twice in a row writes zero files the second time and reports that.
- A project with a hand-edited `skin7.bin` still has that exact file afterwards.
- With the network unplugged it completes on the fallback ceiling.
- Each written clone opens in the BIN editor and resolves to its own skin index.

**Out of scope.** Undo. Cloning anything other than the skin BIN.

---

## 4. Bin Editor — persistent VFX and idle particles

**Goal.** Add the two `SkinCharacterDataProperties` blocks from a form instead of
hand-writing nested ritobin.

Schema is recorded in the plan (§7) and was read from
`E:\RitoShark\Tools\champion-bin-schema.ritobin` lines 205-375. That file is a
synthetic all-fields reference: authoritative for names and types, never values.

**Idle particles — behaviour.**
- A tools-panel section with a five-field form: effect key, bone, target bone,
  effect name, position (x/y/z).
- Adding appends one `SkinCharacterDataProperties_CharacterIdleEffect` to
  `idleParticlesEffects`, creating the list if absent.
- Insertion is one undoable edit and lands at the correct indent.

**Persistent VFX — behaviour.**
- A tools-panel section that adds one `PersistentEffectConditionData` to
  `PersistentEffectConditions`.
- The form covers the flat parts: the `PersistentVfxData` rows (bone, target
  bone, effect key, scale, play-speed modifier, the three booleans, other-team
  effect key), `SubmeshesToShow`, `SubmeshesToHide`, `ForceRenderVfx`.
- The condition is offered as a **buff condition** — spell hash, script name,
  deactivate-early seconds — with an optional NOT, emitted as
  `AllTrueMaterialDriver` or `NotMaterialDriver` around
  `HasBuffDynamicMaterialBoolDriver`.

**Acceptance criteria.**
- A BIN with a block inserted by the form saves, re-reads and round-trips
  byte-identically apart from the intended addition.
- Fields with no dictionary name (`0x9dba9f88`, `0xeaf5370d`, class `0x34262325`,
  `0x149271dd`) are emitted as raw hash-keyed fields, never as a guessed name.
- A hand-written condition tree more complex than the form can express is left
  untouched when other parts of the block are edited.
- Verified against a real champion BIN that already uses
  `PersistentEffectConditions`, not only against the synthetic reference.

**Out of scope.** A general recursive driver-tree editor. Previewing the effect.

---

## 5. Bin Editor — search panel with linked-bin search

**Goal.** Find and replace across a skin's whole BIN graph, not just the open
file. Riot hoists shared entries into linked bins, so a search confined to the
open file misses most of a skin.

**Behaviour.**
- A search panel beside the editor: query, replace, and the usual case /
  whole-word / regex toggles.
- Results are grouped by file — the open BIN first, then each linked BIN — with
  a match count per group and a line preview per hit.
- Clicking a hit in the open file reveals and selects it. Clicking a hit in a
  linked BIN opens that BIN and reveals it there.
- Replace and Replace All apply to the **open file only**; linked-BIN results are
  read-only and say so. Replacing across files is out of scope.
- Search runs on submit, not per keystroke.

**Acceptance criteria.**
- Searching a term that exists only in a linked BIN finds it.
- A skin linking many bins stays responsive; the panel never converts linked bins
  on every keystroke.
- Replace All is a single undo step.
- Results survive edits to the open file without going stale silently — either
  they refresh or they are visibly marked as out of date.

---

## 6. Bin Editor — VFX system index and navigation

**Goal.** See every VFX system in the open BIN and move between them without
scrolling.

**Behaviour.**
- The tools panel lists every `VfxSystemDefinitionData` in the file, in document
  order, labelled by its particle path and falling back to the entry key.
- Clicking a row reveals and selects that system in the editor.
- Keyboard: next system and previous system, wrapping at both ends.
- The list tracks edits without a manual refresh, and updating it must not make
  typing in a large VFX BIN feel slow.

**Acceptance criteria.**
- The count matches the number of `VfxSystemDefinitionData` blocks in the file.
- Navigation visits every system exactly once per cycle.
- The list is correct on a file that is mid-edit and temporarily unparseable.

---

## 7. Settings — Bin Editor section

**Goal.** Stop the editor's behaviour being hardcoded.

**Behaviour.** A Bin Editor tab in Settings exposing: which tools-panel sections
start expanded; minimap on/off and the file-size threshold above which it is
force-disabled; word wrap; font size; whether Unhash runs automatically when a
BIN opens.

**Acceptance criteria.**
- Every setting takes effect on the next BIN opened without an app restart.
- Settings persist across restarts.
- Defaults reproduce today's behaviour exactly, so an existing user notices no
  change until they touch something.

---

## 8. Settings — syntax colour theme

**Goal.** Let the BIN editor's syntax colours be changed.

**Behaviour.**
- A theme picker in the Bin Editor settings section offering named presets. The
  default preset is today's palette, unchanged.
- Switching applies immediately to every open BIN view — the editor, the WAD
  preview pane and the WAD-explorer viewers all follow.

**Acceptance criteria.**
- Switching and switching back is visually lossless.
- The choice survives a restart.
- A preset removed in a later release falls back to the default rather than
  rendering uncoloured.

**Out of scope for v1.** Per-token custom colours and importing external themes.

---

## Cross-cutting

- No emoji anywhere in new UI, copy or assets.
- No container-inside-container panels; follow the flattening done for the asset
  path cheat sheet.
- Icons and glyphs centred by their container's layout, never by hand-tuned pixel
  offsets.
- A dialog with a footer Cancel gets no header close button.
- Anything format-level belongs in `RitoShark-Crates`, not copied into Flint.
