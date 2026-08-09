# flint-todo — Implementation Plan

**Date:** 2026-08-10
**Spec:** `docs/superpowers/specs/2026-08-10-flint-todo-spec.md` (what and why).
This doc is **how**: the systems, the files, the order. Where the spec and this
doc disagree on behaviour, the spec wins.

Every finding below was read out of the codebase or measured against a live
endpoint. Nothing here is assumed unless it says ASSUMPTION.

---

## The five systems

Eight todo items collapse into five systems. Building the system once and
spending it twice is the whole point of the grouping.

| System | Serves | New surface |
|---|---|---|
| S1 Skin-port engine | §2 Port to Jade, §3 NoSkinLite | 2 modals, 2 commands, 0 new engine code |
| S2 BIN tools panel | §4 persistent VFX + idle particles, §6 VFX index | Extracted panel folder, 3 new sections |
| S3 BIN graph search | §5 search + linked-bin search | 1 command, 1 side panel |
| S4 Editor settings | §7 Bin Editor tab, §8 syntax theme | 1 settings tab, N theme presets |
| S5 Model mirror | §1 mirror a model | 1 layer field |

---

## S1 — Skin-port engine (§2, §3)

### What already exists

`src-tauri/crates/flint-core/src/port_jade.rs` (committed `1d2bad0`, 5 tests,
clippy clean) is the engine, and it is already general:

```rust
retarget_skin_bin(source: &Bin, character: &str, skin_id: u32) -> Result<Bin, String>
port_skin_bin(source_bin, dest_skins_dir, dest_character, targets: &[u32]) -> PortOutcome
```

It rekeys the `SkinCharacterDataProperties` entry to
`fnv1a("Characters/{character}/Skins/Skin{N}")`, the `ResourceResolver` entry to
`.../Resources`, and repoints `mResourceResolver` — preserving whether the source
stored that link as a string or a link. Existing files are never overwritten.

**NoSkinLite is the same call with a different character and target list.** Port
to Jade passes `Jade_<Champ>`; NoSkinLite passes `<Champ>` unchanged. No second
engine, no shared-trait abstraction — one function, two callers.

### Change 1 — rename the module

`port_jade.rs` → `skin_port.rs`, `flint-core/src/lib.rs` updated. The name has to
stop saying "jade" the moment NoSkinLite calls it. `jade_character_name` stays
where it is; it is jade-specific and that is honest.

### Change 2 — two Tauri commands

New `src-tauri/src/commands/project/skin_port.rs`:

```rust
port_project_to_jade(project_path, champion, source_skin_id, targets: Vec<u32>) -> PortOutcome
port_project_no_skin_lite(project_path, champion, source_skin_id, targets: Vec<u32>) -> PortOutcome
```

Both resolve the same way:

- **Source BIN** — reuse `find_skin_bins(project, source_skin_id)` from
  `commands/project/chroma.rs` (already handles both the `skin{N}/` directory
  layout and the flat `skins/skin{N}.bin` layout). Lift it to a shared helper
  rather than copying it.
- **Destination** — `content/<layer>/<champ>.wad.client/data/characters/<char>/skins/`,
  where `<char>` is `jade_<champ>` for Port to Jade and `<champ>` for NoSkinLite.
  The WAD folder is the **live** champion's in both cases: League Classic content
  ships inside the live champion's WAD (`Jade_Ahri` lives in `Ahri.wad.client`),
  which is exactly what `wad_champion_name()` in
  `flint-wad/src/wad/extractor.rs` already encodes.

Both invalidate the `.ritobin` sidecar next to each written BIN (same reason
`apply_loadscreen_banner` does) and `crate::core::write_echo::mark` each write so
the preview watcher does not treat them as external edits.

### Change 3 — target discovery

**Verified live**, `raw.communitydragon.org/latest/game/data/characters/jade_ahri/skins/`
returns 32 `skin<N>.bin` files:

```
0, 1, 2, 27..41, 52, 53, 62, 63, 88..95, 301, 302
```

That set is **sparse**, not a range. So:

- **Port to Jade — "every variant" means exactly the slots the jade character
  ships**, read from that listing. A 0..max range would write ~270 dead BINs.
- **NoSkinLite — a contiguous `0..max + 20` range**, matching Quartz's behaviour
  and the spec's stated ceiling rule. A skin that lands in a gap still needs a
  clone there; a jade slot that does not exist does not.

One shared frontend helper in `src/lib/data/skinSlots.ts`:
`fetchSkinSlots(alias): Promise<number[]>` — parses the directory listing, 10s
timeout, and on failure returns `null` so each caller applies its own fallback
(Jade: error out, there is nothing to guess; NoSkinLite: ceiling 99, and say so
in the toast).

### Change 4 — two modals

**Decided 2026-08-10: two separate modals, not one moded component.**
`src/components/modals/PortToJadeModal.tsx` and
`src/components/modals/NoSkinLiteModal.tsx`, both modelled on
`ChromaPortModal.tsx` — which is already the right shape: a gallery of
selectable targets, All / None, a live count, and a `Port (n)` primary.

They differ enough to earn separate files: Jade picks from a sparse slot list
with real skin artwork, NoSkinLite picks from a dense numeric range where art is
meaningless. What they genuinely share — the selection grid — is extracted as
`src/components/modals/skin-port/TargetGrid.tsx` rather than duplicated.

Jade card art: CDragon `skin.tilePath` per slot where one exists (jade champions
do resolve through `champions/60103.json`), else a numbered placeholder. Slots
with no CDragon entry still appear — the directory listing is the authority on
what exists, CDragon's skin JSON is only the artwork.

Menu items go in `src/lib/editor/fileContextMenuOptions.ts` beside
`Port to Chromas…` (line 83), in the `Project` submenu:

- `Port to Jade…` — skin projects, hidden when the project's champion is already
  a `Jade_*` alias.
- `NoSkinLite…` — **shown only when the project's skin id is 0** (decided
  2026-08-10; the spec's gate is kept, deliberately narrower than Quartz).
  Confirm-gated, since it writes many new files.

### Acceptance

- Re-running writes nothing and the toast says how many were skipped.
- A hand-edited `skinN.bin` in the destination survives.
- Rust tests already cover the rekeying; the commands get a temp-dir test for
  source resolution and the never-overwrite rule.

---

## S2 — BIN tools panel (§4, §6)

### What already exists

The panel is `BinSidePanel`, defined **inline inside**
`src/components/preview/BinEditor.tsx` (line 378), which is already 1440 lines.
It has three collapsible sections — Skin Scale, Material Override, VFX — and it
works on the **ritobin text**, not the BIN tree: `parseSkinScale`,
`applySkinScaleToText`, `ensureMaterialOverride`, `insertMaterialOverrideEntry`
splice strings, and every insertion lands through `applyContentToEditor` as one
undoable Monaco edit.

That text-first idiom is correct and is kept. It is why the panel works on a
file with unsaved edits and on text that does not currently parse.

### Change 1 — extract before extending

Adding two form-heavy sections plus a live index to a 1440-line file makes it
~2500. So first, with no behaviour change:

```
src/components/preview/bintools/
  BinToolsPanel.tsx        the shell: head, close, section list
  SkinScaleSection.tsx
  MaterialOverrideSection.tsx
  VfxSection.tsx
src/lib/editor/binTools/
  skinScale.ts             moved, unit-tested
  materialOverride.ts      moved, unit-tested
```

Pure text functions move to `src/lib/editor/binTools/` with tests, matching how
`blockExtraction.ts` and `bracketCheck.ts` are already organised. This is a
prerequisite commit, verified by "the panel behaves identically".

### Change 2 — §6 VFX system index

New `VfxIndexSection`. A lexical scan of the live Monaco model for
`VfxSystemDefinitionData` blocks, labelled by particle path, falling back to the
entry key. Engine is `src/lib/editor/binTools/vfxIndex.ts`
(`indexVfxSystems(text) -> {line, label, key}[]`), reusing `scanLineBraces` from
`blockExtraction.ts` so there is one brace scanner, not two.

Lexical, not a parse, for the spec's own acceptance criterion: *the list is
correct on a file that is mid-edit and temporarily unparseable.* Recomputed on a
300ms debounce, exactly like the panel's existing parse effect. Clicking a row
reveals it; `Alt+]` / `Alt+[` step next/previous with wrap, registered as Monaco
actions so they only fire with the editor focused.

### Change 3 — §4 persistent VFX and idle particles

Two more sections, both emitting text through the same
`applyContentToEditor` single-edit path.

Schema is recorded in `docs/superpowers/plans/2026-08-09-flint-todo-plan.md` §7,
read from `champion-bin-schema.ritobin` lines 205-375. That file is a synthetic
all-fields reference — authoritative for names and types, **never for values**.

- **Idle particles** — five fields (effect key, bone, target bone, effect name,
  position x/y/z), appends one
  `SkinCharacterDataProperties_CharacterIdleEffect` to `idleParticlesEffects`,
  creating the list when absent.
- **Persistent VFX** — appends one `PersistentEffectConditionData` to
  `PersistentEffectConditions`. The form covers the flat `PersistentVfxData`
  rows plus `SubmeshesToShow` / `SubmeshesToHide` / `ForceRenderVfx`. The
  condition is offered only as a buff condition (spell hash, script name,
  deactivate-early seconds, optional NOT) emitted as `AllTrueMaterialDriver` or
  `NotMaterialDriver` wrapping `HasBuffDynamicMaterialBoolDriver`.

Fields with no dictionary name (`0x9dba9f88`, `0xeaf5370d`, class `0x34262325`,
`0x149271dd`) are emitted as raw hash-keyed fields. Never guess a name — an
invented name hashes to something else and silently changes the field.

Emission goes through pure builders in
`src/lib/editor/binTools/persistentVfx.ts` and `idleParticles.ts`, unit-tested
against expected ritobin text, then verified end-to-end against a **real**
champion BIN that already uses `PersistentEffectConditions` — not only the
synthetic reference.

---

## S3 — BIN graph search (§5)

### The problem this exists for

Riot's build hoists entries shared between skins out of `skinN.bin` into
`DATA/<Champ>_Skins_SkinA_Skins_SkinB….bin`. Yasuo skin54 links **17** bins. A
search confined to the open file misses most of a skin. This is already recorded
in `CLAUDE.md` and is what makes the linked half of this feature the point
rather than a bonus.

### Change 1 — one command

`list_linked_bin_texts(bin_path) -> Vec<{path, text}>` in
`commands/bin/bin.rs`, built on the existing
`flint_core::mesh::ritobin::resolve_linked_bin_path` and the `.ritobin` sidecar
cache (`create_ritobin_cache`). Returns the direct `linked` list only — no
recursion, mirroring `find_linked_bin_ritobin_text`.

**Lazy.** A skin can link 17 bins and skin54.bin alone is 573 KB. The command is
called once per search submit and its result is cached per `(binPath,
fileVersion)` on the frontend; it is never called per keystroke.

### Change 2 — search side panel

`src/components/preview/BinSearchPanel.tsx`, rendered as a sibling of
`BinSidePanel` in the same flex row (not an `inset:0` overlay — results need to
sit beside the code, unlike Paint and Mask which replace it).

- Query, replace, and case / whole-word / regex toggles.
- Results grouped by file: open BIN first, then each linked BIN, with a per-group
  count and a line preview per hit.
- Open-file hit → reveal and select. Linked-BIN hit → open that BIN in the editor
  and reveal there.
- **Replace and Replace All apply to the open file only.** Linked results are
  marked read-only in the UI. Replace All is one `pushEditOperations` call, so
  one undo step.
- Search runs on submit. Editing the open file after a search marks the results
  visibly stale rather than silently serving old line numbers.

Matching logic is a pure module (`src/lib/editor/binSearch.ts`) so the
case/word/regex semantics are unit-tested once and shared by both halves.

---

## S4 — Editor settings and syntax theme (§7, §8)

### Change 1 — a Bin Editor settings tab

`SettingsTab` in `src/components/modals/SettingsModal.tsx` (line 23) gains
`'binEditor'`; the panel body goes in
`src/components/modals/settings/BinEditorTab.tsx`, following `ThemeTab` /
`IntegrationsTab`.

Settings, all persisted in `uxStore` (which already owns the minimap
preference): which tools sections start expanded, minimap on/off and the
line-count threshold above which it is force-disabled, word wrap, font size,
whether Unhash runs automatically when a BIN opens.

Defaults reproduce today's behaviour exactly. `MINIMAP_MAX_LINES` becomes the
default value of a setting rather than a constant.

**CSS lands in `settings-polish.css` with the `.fwiz` twin selector.** That file
declares every settings rule for both the modal and the first-time wizard as a
selector list; adding a rule to only one of them is how the two surfaces drifted
last time.

### Change 2 — syntax theme presets

`registerRitobinTheme` in `src/lib/editor/ritobinLanguage.ts` becomes
`applyRitobinTheme(monaco, presetId)`, which **redefines the single
`RITOBIN_THEME_ID`** from the chosen preset's rules and calls
`monaco.editor.setTheme(RITOBIN_THEME_ID)`.

**One id, swapped rules — not N registered theme ids.** Monaco's standalone
theme is global to the instance, so introducing new theme ids leaks the
selection into the ini / JSON / lua editors that also share it. Redefining the
id in place keeps the blast radius at the ritobin editors and updates all three
consumers (`BinEditor.tsx`, `WadPreviewPanel.tsx`,
`wad-explorer/MonacoViewers.tsx`) at once, which is exactly the spec's
"applies immediately to every open BIN view".

Presets live in `src/lib/editor/ritobinThemes.ts` as
`Record<string, {rules, colors}>`. The default preset is today's palette,
byte-identical. An unknown stored preset id falls back to default rather than
rendering uncoloured.

---

## S5 — Model mirror (§1)

`ModelLayer` in `src/lib/thumbnail/layers.ts` (line 54) gains
`mirrored?: boolean`. `setModelTransform` in
`src/lib/thumbnail/studioScene.ts` (line 909) currently does:

```ts
const s = patch.scale / 100;
for (const mesh of m.meshes) mesh.scaling.set(s, s, s);
```

Mirroring is `mesh.scaling.set(m.mirrored ? -s : s, s, s)`, applied from both the
`scale` and the new `mirrored` branch so the two cannot disagree.

**The winding-order risk is likely already handled by Babylon**: `Mesh.render`
flips `sideOrientation` when `_getWorldMatrixDeterminant() < 0`, which is exactly
the negative-scale case. So no `flipFaces()` geometry mutation and no material
change is planned. This is stated as an expectation, not a fact — it is
**verified against a real skin before the item is called done**, and if the
render is inside-out the fallback is a per-mesh `sideOrientation` override, still
without touching geometry.

Toggle sits in the model layer's properties beside Scale / Turn
(`src/components/thumbnail/PropertiesPanel.tsx` line 124), participates in
undo/redo as one step via the existing `onChange(patch, rec)` signature, and
persists in saved presets. A preset with no `mirrored` field loads unmirrored,
which the optional field gives for free.

---

## Order of work

Each numbered block is a shippable slice and gets its own commit(s).

1. **S1 Port to Jade + NoSkinLite** — engine is already committed and green;
   this is commands + one modal + two menu items. Highest value, least risk.
2. **S2a Extract `BinSidePanel`** — no behaviour change, unblocks everything
   after it.
3. **S2b VFX index (§6)** — small, self-contained, proves the extracted shell.
4. **S2c Persistent VFX + idle particles (§4)** — the largest form work.
5. **S3 Search (§5)** — new command plus a new panel; independent of S2 but
   sits in the same editor, so it lands after the panel folder is stable.
6. **S4 Settings tab + theme (§7, §8)** — cheap, and §7 wants to expose settings
   that S2/S3 introduce, so it goes after them.
7. **S5 Mirror (§1)** — fully isolated from the BIN work; can move earlier if
   the thumbnail editor is the priority.

## Verification per slice

- Rust: `cargo clippy --lib --bins -- -D warnings -A clippy::needless_return`
  and `cargo test -p flint-core`. **Never** a standalone `cargo build`/`check` —
  it wipes the incremental cache and costs 15+ minutes on the next dev start.
- TypeScript: `npx tsc --noEmit` and `npm test` for the new pure modules.
- Every pure text/search/index module gets unit tests; UI wiring does not.

## Cross-cutting rules in force

- No emoji in new UI, copy or assets.
- No container-inside-container panels.
- Icons centred by their container's layout — the `<Icon>` span needs
  `display:flex` and the SVG `display:block`, or the glyph sits on the text
  baseline.
- A dialog with a footer Cancel gets no header close button.
- Zero comments in new source. Knowledge goes in `CLAUDE.md`.
- Anything format-level belongs in `RitoShark-Crates`, not copied into Flint.
