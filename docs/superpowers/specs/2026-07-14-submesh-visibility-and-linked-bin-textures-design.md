# Animation-driven submesh visibility + linked-bin texture resolution

**Date:** 2026-07-14
**Status:** Approved, ready for implementation

## Problem

Two gaps in the SKN model preview:

1. **Submesh visibility is not driven by the skin/animation data.** League skins hide/show
   submeshes two ways: a static `initialSubmeshToHide` / `initialSubmeshShadowsToHide` on
   `SkinCharacterDataProperties`, and per-animation-clip `SubmeshVisibilityEventData` events
   (`mShowSubmeshList` / `mHideSubmeshList`, keyed by frame). Flint's preview shows *all*
   submeshes and only lets the user toggle them manually — so meshes look wrong (extra
   swords, wrong hair, etc.) and animations don't swap submeshes the way they do in-game.

2. **Texture (material) resolution only looks at `skinN.bin` (+ `*Concat.bin`).** Material
   defs that live in bins referenced through the skin bin's `linked` header are missed, so
   some submeshes render untextured/magenta.

## Key facts established during design (from code exploration)

- **Skeletal `.anm` playback already works** end-to-end: `rs_anim` → `flint_ltk::mesh::animation::bake_animation_file` → `src/lib/babylon/animationPlayer.ts`.
- **Submesh show/hide already works**, keyed by submesh *name*: `ModelPreview.tsx` holds
  `visibleMaterials: Set<string>` and applies `m.setEnabled(visibleMaterials.has(name))`.
  Today it's only user-driven via the Materials popup checkboxes.
- **Submesh names already reach the frontend** in the mesh wire payload (`MaterialRange.name`).
- **BIN `hash` / `list[hash]` values decode to raw `u32`** (`BinValue::Hash(u32)`), never
  resolved strings. The hash is **FNV1a-32 over the lowercased ASCII bytes** of the original
  name (`ritoshark::hash::fnv1a`, a `const fn`). Verified: `fnv1a("Kayn_Skin20_Slayer_Hair_MAT") == 0xa973e905`.
- There is a **working TypeScript reference** at `Ruby/packages/hex-render` that implements
  this exact feature; its parsing + runtime algorithm is the model for the port.

Verified class/field hashes:

| Name | Kind | FNV1a-32 |
|---|---|---|
| `SubmeshVisibilityEventData` | class | `0xbcf56e70` |
| `AtomicClipData` | class | `0x5bd9a1e6` |
| `BlendableClipData` | class | `0x505dd936` |
| `SequencerClipData` | class | `0x8d30a7c0` |
| `SkinCharacterDataProperties` | class | `0x9b67e9f6` |
| `mShowSubmeshList` | field | `0x6d4d42d0` |
| `mShowSubmeshHash` | field | `0x6c77d058` |
| `mHideSubmeshList` | field | `0xbb41a45b` |
| `mHideSubmeshHash` | field | `0xaa6dabb3` |
| `mEventDataMap` | field | `0xf598463e` |
| `mStartFrame` | field | (via `fnv1a("mStartFrame")`) |
| `initialSubmeshToHide` | field | `0x80b7f78f` |
| `initialSubmeshShadowsToHide` | field | `0xf4ba5c9e` |

## Design decisions (confirmed with user)

1. **Default on open:** apply the static `initialSubmeshToHide` baseline so the mesh looks
   correct immediately, but **do not auto-play** an animation. Events fire only when the user
   plays or scrubs.
2. **Manual vs animation:** while an animation plays, its events control visibility and the
   Materials checkboxes **reflect** the live state (single source of truth). When paused / no
   animation, manual toggles behave as today.
3. **Recompute model:** on loop-wrap or scrub, reset to the baseline hidden set, then replay
   all events with `startFrame/fps <= t` in order (hide-then-show, show wins). Forward
   monotonic playback applies only the `(tPrev, tCur]` delta.
4. **Linked-bin texture search:** follow the skin bin's direct `linked` list (on top of the
   existing concat merge). No project-wide scan.

## Feature 1 — Submesh visibility

### Rust

New module `flint-ltk/src/mesh/submesh_visibility.rs`:

- `pub struct SubmeshVisEvent { pub start_frame: f32, pub hide_hashes: Vec<u32>, pub show_hashes: Vec<u32> }`
- `pub struct InitialHidden { pub hide: Vec<String>, pub shadow_hide: Vec<String> }`
- `parse_initial_hidden(bin: &Bin) -> InitialHidden` — from `SkinCharacterDataProperties`
  (`0x9b67e9f6`): `initialSubmeshToHide` (`0x80b7f78f`, `String`, split on whitespace);
  `initialSubmeshShadowsToHide` (`0xf4ba5c9e`, `String`, split on comma). Both may be absent.
- `parse_clip_visibility_events(bin: &Bin) -> HashMap<String, Vec<SubmeshVisEvent>>` —
  keyed by clip name (the `mEventDataMap` owner). For each clip entry whose class is Atomic /
  Blendable / Sequencer, walk `mEventDataMap` (`0xf598463e`, a `Map`); for each value that is
  an `Embed`/`Pointer` with class `0xbcf56e70`, read `mStartFrame`, combine hide/show
  scalar+list fields (dropping zero hashes). Sort events by `start_frame`.
  - The clip **name** must match how the frontend names clips today. Reuse the existing
    clip-name derivation from `extract_animation_list` so events line up with the animation
    list rows. If a clip name can't be derived, fall back to the clip's map-key hash string.

Both functions walk the `ritoshark::bin::BinValue` tree using the same recursion shape as
`extract_animation_paths_from_value`. Hash constants come from `const fn ritoshark::hash::fnv1a`.

### Surfacing to the frontend

- Extend `AnimationClipInfo` with `events: Vec<SubmeshVisEvent>` (empty when the clip has none).
- Extend the animation-list payload (`AnimationList`) with `initial_hide: Vec<String>` and
  `initial_shadow_hide: Vec<String>`. `read_animation_list` already reads the anim bin and can
  locate the skin bin (via the existing `resolve_skn_for_anm` / skin-bin helpers) to parse the
  initial-hide fields; if the skin bin isn't found, return empty vecs (non-fatal).
- Wire types through `src/lib/api/mesh.ts` (`AnimationClipInfo`, `AnimationList`).

### Frontend runtime

New `src/lib/babylon/submeshVisibility.ts`:

- `fnv1a32Lower(name: string): number` — gated ASCII A–Z fold, init `0x811c9dc5`,
  prime `0x01000193`, using `Math.imul` and `>>> 0`.
- `class SubmeshVisibilityTimeline` built from `{ submeshNames, initialHide, events, fps }`:
  - `baselineHidden(): Set<string>` — names in `initialHide` (lowercased match).
  - `hiddenAt(tSeconds): Set<string>` — fold: start from baseline, apply every event with
    `startFrame/fps <= t` in order (hide hashes → hide, show hashes → show; show wins).
    Resolves hashes to names via a `hash → name` map built from `submeshNames`.
  - `eventsBetween(tPrev, tCur)`: half-open `(tPrev, tCur]` for the forward-delta fast path.

`ModelPreview.tsx`:

- On mesh load, after `visibleMaterials` is initialized, apply the baseline: set
  `visibleMaterials` = all names minus `baselineHidden()`. (No auto-play.)
- Shadow-hide (`initial_shadow_hide`): drop those submeshes from the shadow generator's
  render list (separate from `visible`), so they still render in the world pass but cast no
  shadow. Uses the existing shadow setup in `ModelPreview.tsx`.
- On play tick: advance `tPrev → tCur`; if monotonic forward, apply `eventsBetween` delta to
  `visibleMaterials`; on loop-wrap or scrub (detected by `tCur < tPrev` or a seek), call
  `hiddenAt(tCur)` and replace `visibleMaterials` wholesale. Because visibility flows through
  `visibleMaterials`, the Materials checkboxes reflect the live state automatically.
- When the user manually toggles while **paused/no animation**, behavior is unchanged.

### Tests

Rust (`submesh_visibility.rs` inline `#[cfg(test)]`):
- `fnv1a("Kayn_Skin20_Slayer_Hair_MAT") == 0xa973e905`.
- `initialSubmeshToHide` splits on whitespace; shadow list splits on comma.
- A synthetic BIN with an `AtomicClipData` → `mEventDataMap` → `SubmeshVisibilityEventData`
  yields the expected hide/show hash vectors, sorted by `start_frame`, zeros dropped.

TS (`submeshVisibility.test.ts`):
- `fnv1a32Lower` matches the Rust value for a known name.
- `hiddenAt` folds baseline + events correctly (hide-then-show, show wins; scrub back
  recomputes from baseline).

## Feature 2 — Linked-bin texture resolution

In `commands/assets/mesh.rs::read_skn_mesh_inner`, the step that assembles `combined_text`
(skin bin ritobin + concat bin ritobin) gains a third source:

- After locating the skin bin, `read_bin` it and read `bin.linked: Vec<String>`.
- Resolve each linked path to a project-local `.bin` (reuse the existing asset-path →
  disk-path resolution used elsewhere in the mesh command). For each that exists, convert to
  ritobin text and append to `combined_text`.
- `extract_texture_mapping_from_text` + the existing `StaticMaterialDef` / FNV1a hash↔name
  bridge then resolve material defs that live in linked/shared bins.

Scope: **direct linked list only**, additive to the current concat merge. No project-wide scan.

## Out of scope (YAGNI)

- Gear / form-state submesh systems (only `initialSubmeshToHide` + per-clip events).
- Auto-play on open.
- Project-wide bin scan for textures.
- Any change to the skeletal `.anm` pipeline (already works).

## Files touched

Rust:
- `flint-ltk/src/mesh/submesh_visibility.rs` (new)
- `flint-ltk/src/mesh/mod.rs` (module decl + re-export)
- `flint-ltk/src/mesh/animation.rs` (`AnimationClipInfo.events`, `AnimationList` initial-hide fields)
- `src-tauri/src/commands/assets/mesh.rs` (`read_animation_list` surfacing; linked-bin merge in `read_skn_mesh_inner`)

Frontend:
- `src/lib/babylon/submeshVisibility.ts` (new)
- `src/lib/babylon/submeshVisibility.test.ts` (new)
- `src/lib/api/mesh.ts` (types)
- `src/components/preview/ModelPreview.tsx` (baseline apply + playback-driven visibility)
