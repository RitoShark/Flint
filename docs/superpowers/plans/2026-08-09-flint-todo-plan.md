# flint-todo — implementation plan

**Date:** 2026-08-09
**Source:** `E:\RitoShark\Tools\flint-todo.md`
**Status:** Proposed. Two items are blocked on a question (marked **BLOCKED**).

Ordered by ratio of value to risk, not by the order in the todo. Each item says
what exists today, so the estimate is grounded rather than guessed.

---

## Tier 1 — small, self-contained, no unknowns

### 1. Thumbnail: hide the transform sliders by default

**Today:** `PropertiesPanel.tsx` renders seven `SliderNum` rows for a model layer
(scale, orbit, tiltX, rollZ, posX/Y/Z) plus four `DlSlider`s, all always visible.
The panel is a tall wall of sliders before you have done anything.

**Plan:** keep scale + orbit always visible (the two people actually reach for),
move tilt / roll / position into a collapsed "Transform" disclosure. Persist the
open/closed state in the existing thumbnail preset store so it survives a reload.

**Open question — "open on modifier's button press."** Two readings: a click-to-
toggle disclosure, or hold a modifier (Alt) to peek while held. A hold-to-peek
that collapses on release is unusual for a properties panel and fights the
existing Alt-drag brush-resize gesture used elsewhere in Flint. Recommend a
plain toggle, with the section auto-opening whenever any of its values is
non-default (so an existing preset never hides state you already set).

### 2. Bin Editor: list every VFX system, and leap to the next one

**Today:** the BIN tools panel's VFX section has exactly two buttons, Fold All
and Unfold All. There is no system index and no way to jump between systems.
`particlePath` does not appear anywhere in the frontend.

**Plan:** purely lexical over the live Monaco model — no backend, same approach
as the existing emitter copy/paste feature:

- Reuse `findEnclosingBlock` / the bracket-stack scanner in
  `lib/editor/blockExtraction.ts` to index every `VfxSystemDefinitionData` block
  and pull its `particlePath` (falling back to the entry key when absent).
- Render the index as a list in the tools panel; clicking a row calls
  `revealLineInCenter` + selects the block.
- Bind "next / previous system" (F8 / Shift+F8) off the same index, wrapping at
  the ends, so you can walk a large VFX bin without scrolling.

Rebuild the index on content change, debounced — a 573 KB skin BIN should not
re-scan on every keystroke.

### 3. Settings: a Bin Editor section

**Today:** `SettingsModal` has six tabs (`creator`, `general`, `theme`, `paths`,
`integrations`, `dev`). Nothing configures the editor; the tools panel's section
collapse state and the minimap threshold are hardcoded in `BinEditor.tsx`.

**Plan:** add a `binEditor` tab with the settings that already exist as constants:

- which tools-panel sections start expanded (skinScale / materialOverride / VFX)
- minimap on/off and the size threshold that currently force-disables it
- word wrap, font size
- run Unhash automatically when a BIN opens

Persist through the existing config store (same pattern as
`flint_verbose_logging` / `unknownPreviewByExt`). This is mostly plumbing —
lifting hardcoded values into settings, not new behaviour.

---

## Tier 2 — real work, no blockers

### 4. Bin Editor: syntax colour themes

**Today:** `registerRitobinTheme` (`lib/editor/ritobinLanguage.ts`) hardcodes one
palette: 16 token rules plus ~10 editor colours, `inherit: false`, registered
once under a single `RITOBIN_THEME_ID`. Three components consume that id
(`BinEditor`, `WadPreviewPanel`, `MonacoViewers`).

**Plan:**

- Extract the rule list into named presets — VS Dark (today's, the default),
  a Flint-accent variant, and a high-contrast one — and register all of them.
- Settings → Bin Editor picks one; the choice calls `monaco.editor.setTheme`,
  so all three consumers follow without prop-threading.
- Store the id, not the palette, so a preset can be retuned in a later release.

Per-token custom colours are explicitly **out of scope for v1** — a full colour
editor is a much bigger surface, and presets cover the actual complaint.

### 5. Thumbnail: mirror a model

**Today:** `ModelLayer` carries `scale`, `orbit`, `tiltX`, `rollZ`, `posX/Y/Z`.
`orbit + 180` turns the model around (you see its back) — that is not a mirror.

**Plan:** add `mirrored?: boolean` to `ModelLayer`, a toggle in the properties
panel, and negate `scaling.x` on the model root in the scene.

**The landmine:** negating one axis flips winding order. In Babylon the mesh will
render inside-out (front faces culled) unless the materials' `sideOrientation` is
flipped to match, and any normal-mapped material needs its normals handled too.
Budget the work for that, not for the one-line scale negation — this is the item
most likely to look "done" and be visibly wrong on a lit model.

### 6. Bin Editor: search panel with linked-bin search

**Today:** Monaco's own Ctrl+F / Ctrl+H work inside the open file only. Nothing
searches the `linked` bins, even though Riot hoists shared entries into them
(a Yasuo skin54 links 17 bins) — so a search that misses them misses most of the
skin.

**Plan:** a left-side `BinSearchPanel` beside the editor, VSCode Search-view
shaped:

- Current-file matches from `model.findMatches`, with replace / replace-all
  routed through `pushEditOperations` so it stays one undo step.
- Linked-file matches from a new command that resolves the BIN's `linked` header
  and converts each to text. The backend halves already exist —
  `ritobin::read_linked_bin_trees` and `find_linked_bin_ritobin_text` — so this
  is a thin command plus result plumbing, not new format work.
- Results grouped by file; clicking a linked-file hit opens that BIN and reveals
  the line.

**Load linked bins lazily and cache per session.** The existing rule applies: a
skin can link 17 bins, so converting all of them on every keystroke is not
acceptable. Search on submit, not on type.

### 7. Bin Editor: persistent VFX + idle particles

**Today:** the tools panel builds `materialOverride` blocks through a clean pair
of helpers — `ensureMaterialOverride` (creates the list if absent) and
`insertMaterialOverrideEntry` (appends one `SkinMeshDataProperties_MaterialOverride`
embed at the right indent). Both of the blocks below want the same treatment.

**Schema** — read off `E:\RitoShark\Tools\champion-bin-schema.ritobin` lines
205–375, inside the `SkinCharacterDataProperties` entry. That file is a
SYNTHETIC all-fields reference (its three condition blocks are byte-identical and
it mixes Aatrox spells with Ahri/Ashe/Graves values), so treat it as authoritative
for **names and types**, never for values.

```
PersistentEffectConditions: list2[pointer] = {
    PersistentEffectConditionData {
        OwnerCondition:  pointer   -- driver tree
        SourceCondition: pointer   -- driver tree
        PersistentVfxs:  list2[embed] of PersistentVfxData
        SubmeshesToShow: list2[hash]
        SubmeshesToHide: list2[hash]
        ForceRenderVfx:  bool
    }
}

PersistentVfxData {
    boneName:                  string
    targetBoneName:            string
    effectKey:                 hash
    Scale:                     f32
    PlaySpeedModifier:         f32
    ShowToOwnerOnly:           bool
    AttachToCamera:            bool
    UseDifferentKeyForOtherTeam: bool
    EffectKeyForOtherTeam:     hash
    0x9dba9f88:                u32
    0xeaf5370d:                pointer = 0x34262325 { AnimationName: string }
}

idleParticlesEffects: list[embed] = {
    SkinCharacterDataProperties_CharacterIdleEffect {
        effectKey:      hash
        boneName:       string
        targetBoneName: string
        effectName:     string
        Position:       vec3
    }
}
```

Driver trees seen in the reference: `AllTrueMaterialDriver { mDrivers: list[pointer] }`,
`NotMaterialDriver { mDriver: pointer }`, and the leaf
`HasBuffDynamicMaterialBoolDriver { Spell: hash, mScriptName: string, mDeactivateEarlySeconds: f32, 0x149271dd: bool }`.

**Plan — two tiers, because the two blocks are not equally hard.**

*Idle particles are flat.* Five scalar fields, no nesting. `ensureIdleParticles` /
`insertIdleParticleEntry` mirroring the material pair, driven by a five-field
form. This one is genuinely "similar to materialOverride" and should ship first.

*Persistent effects are not.* The VFX half is flat and forms cleanly
(`PersistentVfxData` rows, the two submesh lists, `ForceRenderVfx`) — but
`OwnerCondition` / `SourceCondition` are **recursive pointer trees**, and a flat
form cannot express an arbitrary one. Do not attempt a general tree editor in v1.
Offer the shape Riot actually ships instead: a buff condition (spell hash, script
name, deactivate-early seconds) with an optional NOT, emitted as
`AllTrueMaterialDriver { mDrivers: [ HasBuff… ] }` or
`NotMaterialDriver { mDriver: HasBuff… }`. Anything more exotic stays hand-edited
in the text, which the template must not clobber.

**Keep unnamed fields as raw hashes.** `0x9dba9f88`, `0xeaf5370d`, the
`0x34262325` class and `0x149271dd` have no dictionary name. Emit them verbatim
as hash-keyed fields rather than guessing a name — rs_bin round-trips them fine,
and a wrong guessed name is a silently broken BIN.

**Verify against one real champion BIN before shipping.** The schema file is
synthesized; a live `skinN.bin` that actually uses `PersistentEffectConditions`
is the round-trip test (write the block, save, re-read, diff). The oracles if
anything looks off are the C# LeagueToolkit and ritobin.

**Tie-in worth noting:** `SubmeshesToShow` / `SubmeshesToHide` are the same
submesh-name space the model preview already drives through `initialSubmeshToHide`
and the animation visibility timeline. Previewing a persistent-effect state in the
viewer is a natural follow-up — out of scope here, but it argues for parsing these
into a typed structure rather than only emitting text.

---

## BLOCKED — need a decision before planning

### 8. "port project to classic skins (selection with only classic skin or every variant)"

**Half of this shipped today** (2.8.1): a Classic switch beside PBE swaps the
champion list to the League Classic roster, and the skin picker sorts the Classic
skin first and selects it by default. The jade ports of live skins stay in the
list.

The parenthetical — "*selection with only classic skin or every variant like no
skinlite*" — now reads clearly given item 9: **a scope choice at creation time,
by analogy with NoSkinLite's "clone into every slot"**. Either the project covers
just the Classic skin (301), or it covers every jade variant the champion has.

Two jobs remain, and it is worth knowing which is wanted:

- **(a) A picker filter** — "Classic only" vs "All variants", so the jade ports
  can be hidden. Small: one segmented control over the existing list, which today
  sorts Classic first and selects it but shows everything.
- **(b) Convert an existing live project to Classic** — re-target a finished
  Ahri project onto `jade_ahri` / skin 301, repathing `data/characters/ahri` →
  `data/characters/jade_ahri` and every asset reference with it. Refather-class,
  close in size to `hard_rename_project`.

(a) is almost certainly what the line means. Confirm before building (b).

### 9. NoSkinLite in the right-click menu

**Resolved.** "no skinlite" is the feature name **NoSkinLite**, not the word
"no" — the todo line reads "*NoSkinLite* selection on right click menu if skin is
on skin 0". It does not exist in Flint; the reference implementation is Quartz's
`quartz-lib/src/bin/noskinlite.rs`, exposed as a Windows shell verb
(`v("32noskinlite", "NoSkinLite", "noskinlite")` in `commands/context_menu.rs`).

**What it does:** clones a source `skinN.bin` into every skin slot
`skin0..skin{max}` for that champion, rekeying the `SkinCharacterDataProperties`
and `ResourceResolver` entries and fixing `mResourceResolver` so each clone
resolves to its own skin index. The result is a mod that shows no matter which
skin the player has selected.

Details worth carrying over rather than rediscovering:

- **The skin ceiling comes from CDragon's raw directory listing**
  (`json/latest/game/data/characters/{alias}/skins/`), max of the `skin<N>.bin`
  filenames — **not** `champion-summary` / `champions/{id}`, which only list
  officially released skins and miss chroma / PBE / unreleased slots (Akali is
  101, not 92; Bel'Veth 28, not 5). Plus a `+20` future margin, with a fallback
  of 99 when the fetch fails, on a 10s timeout so an unreachable network doesn't
  freeze the menu.
- **Existing `skinN.bin` files are skipped unconditionally** so hand-edited skins
  are never clobbered.

**Plan for Flint:** this is a natural sibling of the "Create Project" item added
to the WAD explorer in 2.8.1 — same menu, same `parseSkinBinPath` gate. Add a
project-tree context item on a `skinN.bin` (and/or a project-root action) that
runs the clone over the project's own `content/<layer>/<champ>.wad.client` tree.

**The "if skin is on skin 0" gate** is the interesting part: offer it only when
the project's skin is 0, i.e. the base-skin mod that the user wants to apply
everywhere. Worth confirming that is the intent rather than a general "any source
skin" action — Quartz's `run()` takes any source BIN, so restricting to skin 0 is
a deliberate narrowing, not a technical limit.

**Library-first:** the clone logic belongs in `RitoShark-Crates`, not copied from
Quartz into Flint. Same rule that governs every other format-level capability
(golden rule 4) — ask the owner, implement in the library, bump the pinned rev.

---

## Suggested order

1, 2, 3 first — they are contained, and 3 unblocks the settings half of 4.
Then 4, then 6 (the highest-value one, and the one that most needs uninterrupted
time). 5 and 7 whenever, once their respective unknowns (winding order; the real
BIN shape) are settled. 8 and 9 on answers.

---

## Housekeeping

`flint-todo.md` sits at the Tools root, which the ecosystem rules say not to do
("Don't leave loose files at the Tools root — file them under `docs/<app>/`").
It belongs at `Tools/docs/flint/flint-todo.md`. Not moved — it is the owner's
working file and moving it would break wherever it is pinned.
