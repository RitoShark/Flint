# LTK → RitoShark Migration — Plan 1 (Phases 0–4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire RitoShark into `flint-ltk` and migrate the four zero-gap format domains (textures, mesh, anim, hash/rst/audio/file-detect) off `league-toolkit` onto RitoShark, keeping `flint-ltk`'s public API stable.

**Architecture:** `flint-ltk` is Flint's insulation layer; `src/commands/` calls *its* functions, not LTK directly. We swap each domain's internals to call `ritoshark::*` while holding `flint-ltk`'s function signatures fixed. Both libraries coexist until the last LTK use is deleted. Each domain is verified by a differential test (LTK vs RitoShark on the same bytes) + clippy + a real `npm run tauri dev` run.

**Tech Stack:** Rust, Tauri 2, `ritoshark` (git `fb7832e`), `cargo clippy` as the compile gate.

**Companion docs:** spec → `docs/superpowers/specs/2026-06-04-ltk-to-ritoshark-migration-design.md`; owner's lib additions → `docs/superpowers/specs/2026-06-04-ritoshark-additions-for-flint.md`.

**This is Plan 1 of 4.** Plan 2 = BIN (`rs_bin`, tree-walks, JSON shim). Plan 3 = WAD (`rs_wad` read/extract now; build after owner ships `WadBuilder`). Plan 4 = final LTK removal (after owner's Hematite update; adapt `fixer.rs`).

---

## Coordination protocol (parallel agents)

Phase 0 is **serial (lead)** — it edits the two shared files. Phases 1–4 run as **one agent per domain in parallel**, with this rule to avoid collisions:

- Each domain agent edits **only its own domain's modules** (listed per task). It must NOT edit `flint-ltk/Cargo.toml` or `flint-ltk/src/lib.rs`.
- If an agent needs a re-export changed in `lib.rs::ltk_types` or a dep line removed from `Cargo.toml`, it **returns the exact delta in its report**; the lead applies all shared-file edits centrally after agents return.
- Verification compile is run by the **lead** after integrating each batch, using `cargo clippy --lib --bins -- -D warnings -A clippy::needless_return`. Agents do not run `cargo build`/`cargo check` (cache rule).

---

## Verification commands (used throughout)

- **Compile gate (safe, blessed):** `cargo clippy --lib --bins -- -D warnings -A clippy::needless_return` (run from `src-tauri/`).
- **Frontend:** `npx tsc --noEmit` (run from `Flint - Main/`).
- **Behavior:** `npm run tauri dev` (user-driven smoke of the migrated preview/convert paths).
- **Differential tests:** `cargo test -p flint-ltk <name>` — skip cleanly when game-file fixtures are absent (path via `FLINT_TEST_ASSETS` env var, gitignored). Never commit game assets.

---

## Phase 0 — Wire RitoShark (LEAD, serial)

**Files:**
- Modify: `src-tauri/crates/flint-ltk/Cargo.toml` (add dep)

- [ ] **Step 1: Add the RitoShark git dependency**

In `src-tauri/crates/flint-ltk/Cargo.toml`, immediately after the `ltk_file = { ... }` line (line 38), add:

```toml

# RitoShark crates (owner's workspace — we are migrating off league-toolkit onto these).
# Pinned to main HEAD; bump as the owner pushes (WadBuilder, etc.). Default features = all formats.
ritoshark = { git = "https://github.com/RitoShark/RitoShark-Crates", rev = "fb7832e0c05efba104a7397942bb4137455e44ab" }
```

- [ ] **Step 2: Verify it resolves, downloads, and compiles alongside LTK**

Run (from `src-tauri/`): `cargo clippy --lib --bins -- -D warnings -A clippy::needless_return`
Expected: clean compile. RitoShark + its transitive deps (glam, zstd, image, memmap2, …) build. No version-conflict errors. (First run downloads + builds RitoShark — slower once.)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/crates/flint-ltk/Cargo.toml src-tauri/Cargo.lock
git commit -m "build: add ritoshark git dependency alongside league-toolkit"
```

**Gate:** Do not start Phases 1–4 until Phase 0 compiles clean.

---

## Phase 1 — Textures → `rs_tex` (agent: `tex`)

**Why first:** zero gaps, and `rs_tex`'s raw BCn blocks seed the deferred frontend phase.

**Files (agent edits only these):**
- Modify: `src-tauri/src/commands/assets/texture_convert.rs` (decode + TEX-encode calls)
- Modify: `src-tauri/src/commands/assets/file.rs` (`decode_texture_file_sync`, `decode_dds_to_png`, `decode_bytes_to_png` — lines ~331–415)
- Modify: `src-tauri/crates/flint-ltk/src/checkpoint.rs` (`decode_texture_to_png`, ~427–450)
- Modify: `src-tauri/crates/flint-ltk/src/mesh/texture.rs` (only if it calls `Texture::`/`Tex::` directly)
- Test: `src-tauri/crates/flint-ltk/tests/diff_texture.rs` (new)
- Returns-to-lead: removal of `ltk_texture::*` from `lib.rs::ltk_types` (lines 49–51) once no longer referenced.

**API mapping (LTK → RitoShark):**

| LTK (today) | RitoShark (`ritoshark::tex`) |
|---|---|
| `Texture::from_reader(&mut cur)` → enum `Texture::{Tex,Dds}` | `tex::Texture::from_bytes(&data)?` → struct (one type for TEX *and* DDS via `from_dds_bytes`) |
| `texture.decode_mipmap(0)?.into_rgba_image()?` | `texture.decode_rgba()?` → `image::RgbaImage` |
| `match Texture::Tex(t) => t.format` (`Bc1/Bc3/Bgra8/Etc1/Etc2Eac`) | `texture.format` directly (`TexFormat::{Bc1,Bc1Alt,Bc3,Bc5,Bc7,Etc1,Etc2,Etc2Eac,Bgra8,Rgba16Snorm}`) |
| `Tex::encode_rgba_image(&rgba, EncodeOptions::new(fmt))?` then `.write(buf)` | `tex::Texture::encode(&rgba, fmt, /*mipmaps=*/false)?` then `.to_bytes()?` (uses `ritoshark::prelude::Serialize`) |
| DDS encode via `image_dds::dds_from_image(...)` | keep `image_dds` (not LTK) **or** `texture.to_dds_bytes_bc(fmt)?` — prefer keeping `image_dds` for Phase 1 to minimize change |
| `data[0..4] == b"TEX\0"` / `b"DDS "` sniffing | unchanged (or `rs_file::detect`) |

- [ ] **Step 1: Write the differential test (skips without fixtures)**

Create `src-tauri/crates/flint-ltk/tests/diff_texture.rs`:

```rust
//! Differential: LTK vs RitoShark texture decode must produce identical RGBA.
//! Skips unless FLINT_TEST_ASSETS points at a dir of real .tex/.dds files.
use std::path::PathBuf;

fn assets_dir() -> Option<PathBuf> {
    std::env::var_os("FLINT_TEST_ASSETS").map(PathBuf::from).filter(|p| p.is_dir())
}

#[test]
fn ltk_and_ritoshark_decode_match() {
    let Some(dir) = assets_dir() else { eprintln!("skip: no FLINT_TEST_ASSETS"); return; };
    let mut checked = 0;
    for entry in walkdir::WalkDir::new(&dir).into_iter().filter_map(Result::ok) {
        let p = entry.path();
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !matches!(ext, "tex" | "dds") { continue; }
        let data = std::fs::read(p).unwrap();

        // LTK
        let mut cur = std::io::Cursor::new(&data);
        let ltk = ltk_texture::Texture::from_reader(&mut cur)
            .and_then(|t| t.decode_mipmap(0)).and_then(|s| s.into_rgba_image());
        // RitoShark
        let rs = ritoshark::tex::Texture::from_bytes(&data).and_then(|t| t.decode_rgba());

        match (ltk, rs) {
            (Ok(a), Ok(b)) => {
                assert_eq!(a.dimensions(), b.dimensions(), "dims differ for {:?}", p);
                assert_eq!(a.as_raw(), b.as_raw(), "pixels differ for {:?}", p);
                checked += 1;
            }
            (Err(_), Err(_)) => {} // both reject — fine
            (a, b) => panic!("decode disagreement for {:?}: ltk_ok={}, rs_ok={}", p, a.is_ok(), b.is_ok()),
        }
    }
    eprintln!("diff_texture: compared {checked} files");
}
```

- [ ] **Step 2: Run it** — `cargo test -p flint-ltk --test diff_texture`. Expected: PASS (skip msg if no fixtures; with fixtures, all pixels match). If RitoShark mismatches, STOP and report to lead (likely an `rs_tex` bug for the owner).

- [ ] **Step 3: Swap `texture_convert.rs`** — replace the `decode_to_clamped_rgba` body's `Texture::from_reader`/`decode_mipmap` with `ritoshark::tex::Texture::from_bytes`/`decode_rgba`; replace the format match (`Texture::Tex(t) => t.format`) with `texture.format`; replace `Tex::encode_rgba_image(...).write(buf)` with `tex::Texture::encode(&rgba, fmt, false)?.to_bytes()?`. Keep the byte-8 patch and `image_dds` DDS-encode as-is. Update the `use flint_ltk::ltk_types::{EncodeOptions, Tex, Texture}` import to `ritoshark::tex::{Texture, TexFormat}` (drop `EncodeOptions`/`Tex`).

- [ ] **Step 4: Swap `file.rs` + `checkpoint.rs` + `mesh/texture.rs`** same mapping. Preserve every public fn signature and the base64-PNG output contract (that's removed only in the deferred frontend phase, not here).

- [ ] **Step 5: Compile gate (lead)** — `cargo clippy --lib --bins -- -D warnings -A clippy::needless_return`. Fix fallout (format-variant exhaustiveness: RitoShark has more `TexFormat` variants — handle `Bc5/Bc7/Etc2/Bc1Alt/Rgba16Snorm` in any match, default to BC3 fallback like the ETC arm).

- [ ] **Step 6: Lead removes** `pub use ltk_texture::*` lines from `lib.rs::ltk_types` (49–51); re-run clippy.

- [ ] **Step 7: Commit** — `git commit -am "refactor(tex): decode/encode via ritoshark rs_tex"`

---

## Phase 2 — Mesh → `rs_mesh` (agent: `mesh`)

**Files:** `src-tauri/crates/flint-ltk/src/mesh/skn.rs`, `mesh/scb.rs`; `src-tauri/src/commands/assets/mesh.rs`. Test: `tests/diff_mesh.rs`. Returns-to-lead: remove `ltk_mesh` dep + any `league_toolkit::mesh` re-exports.

**API mapping:**

| LTK | RitoShark (`ritoshark::mesh`) |
|---|---|
| `SkinnedMesh::from_reader(&mut r)` + `.vertex_buffer().accessor::<Vec3>(ElementName::Position)` | `mesh::SkinnedMesh::from_bytes(&data)?` → `.vertices: Vec<SkinnedMeshVertex>` with direct `.position/.normal/.uv/.blend_indices/.blend_weights`; `.indices: Vec<u16>`; `.ranges` |
| `StaticMesh::from_reader` / `from_ascii` | `mesh::StaticMesh::from_scb_reader(&mut r)?` / `StaticMesh::from_sco_str(s)?`; fields `.positions`, `.faces[].{material,indices:[u32;3],uvs}` |

- [ ] Step 1: `tests/diff_mesh.rs` — decode SKN/SCB with both, assert identical positions/normals/uvs/indices. Run; expect PASS/skip.
- [ ] Step 2: Rewrite `skn.rs` to map `SkinnedMeshVertex` fields into the existing `mesh/wire.rs` payload (positions/normals/uvs/indices/bone_weights/bone_indices). Keep `parse_skn_file`'s signature + return type identical.
- [ ] Step 3: Rewrite `scb.rs` (`parse_scb_file` signature stable; SCB faces are `u32`).
- [ ] Step 4: `commands/assets/mesh.rs` — only import changes if it referenced LTK types; texture resolution unchanged.
- [ ] Step 5: Lead compile gate + remove `ltk_mesh` dep line.
- [ ] Step 6: Commit `refactor(mesh): parse skn/scb via ritoshark rs_mesh`.

---

## Phase 3 — Anim → `rs_anim` (agent: `anim`)

**Files:** `src-tauri/crates/flint-ltk/src/mesh/skl.rs`, `mesh/animation.rs` (the `AnimationAsset`/`Animation`/`RigResource` load sites, ~400–430 / 45–60). Test: `tests/diff_anim.rs`. Returns-to-lead: remove `ltk_anim` dep.

**API mapping:**

| LTK | RitoShark (`ritoshark::anim`) |
|---|---|
| `RigResource::from_reader` (SKL), `catch_unwind` for legacy panic | `anim::Skeleton::from_bytes(&data)` → legacy returns `Err(UnsupportedVersion)` (no panic) — **delete the `catch_unwind` wrapper**; handle the `Err` |
| `AnimationAsset::from_reader` / `Animation::from_reader` (ANM) | `anim::Animation::from_bytes(&data)?` → `.fps`, `.tracks[].{joint_hash, frames[].{time,rotation,translation,scale}}` |

- [ ] Step 1: `tests/diff_anim.rs` — SKL joints + ANM track frames match (note: RitoShark may parse legacy SKL as `Err` where LTK panicked — assert RitoShark returns `Err`, not a crash).
- [ ] Step 2: Rewrite `skl.rs` — drop `catch_unwind`, map `Skeleton.joints` into Flint's skeleton struct; keep `read_skeleton` signature.
- [ ] Step 3: Rewrite `animation.rs` load sites — drop `catch_unwind`; map tracks/frames into Flint's animation struct.
- [ ] Step 4: Lead compile gate + remove `ltk_anim` dep + delete the now-unused `catch_unwind` imports.
- [ ] Step 5: Commit `refactor(anim): parse skl/anm via ritoshark rs_anim; drop catch_unwind`.

---

## Phase 4 — Hash / RST / Audio / file-detect (agent: `misc`)

**Files:** `flint-ltk/src/hash/*` (where `ltk_ritobin::HashProvider` *isn't* the concern — that's Plan 2; here it's only non-bin hashing if any), `flint-ltk/src/audio/*` (bnk/wpk if on LTK — verify; may already be standalone), `src-tauri/Cargo.toml` binary-level `ltk_rst` → `rs_rst`, and any `ltk_file::LeagueFileKind` site. Test: `tests/diff_misc.rs`. Returns-to-lead: remove `ltk_file`; replace binary-crate `ltk_rst`.

**API mapping:**

| LTK | RitoShark |
|---|---|
| `ltk_file::LeagueFileKind` (magic detect) | `ritoshark::file::detect(&bytes) -> FileKind` |
| `ltk_rst::*` (binary crate, rev 3222fe) | `ritoshark::rst::*` (Parse/Serialize) |
| hashing (fnv1a-32 / xxh64) if done via LTK | `ritoshark::hash::{fnv1a, xxh64, xxh3_64, elf_lower}` |
| audio bnk/wpk if via LTK | `ritoshark::audio::{Bnk, Wpk}` (HIRC stays opaque — confirm Flint doesn't decode HIRC; if it does, that's a gap → report) |

- [ ] Step 1: Inventory which of these are actually on LTK in Flint today (audio may already be custom). Only migrate real LTK sites.
- [ ] Step 2: `tests/diff_misc.rs` — `detect()` returns equivalent kind for sample magics; rst round-trip matches.
- [ ] Step 3: Swap the confirmed sites. The binary-crate `ltk_rst` in `src-tauri/Cargo.toml` → drop, use `ritoshark` (already a transitive? no — binary crate needs its own `ritoshark` dep line or to go through `flint_ltk`). Route RST through a `flint_ltk` re-export to keep the binary crate's dep surface small.
- [ ] Step 4: Lead compile gate + remove `ltk_file` (and binary `ltk_rst`).
- [ ] Step 5: Commit `refactor(misc): file-detect/rst/hash/audio via ritoshark`.

---

## Self-Review

**Spec coverage:** Phases 0–4 cover the spec's "zero-gap domains" row-for-row (tex/mesh/anim/hash/rst/audio/file-detect). BIN, WAD, Hematite are explicitly deferred to Plans 2–4. ✅
**Placeholder scan:** API-mapping tables + the differential-test code are concrete. The per-site line edits are intentionally delegated to the executing agent reading each file (migration, not greenfield) — each task names exact files + the exact API substitution. ✅
**Type consistency:** `tex::Texture` (struct, `.format`, `.decode_rgba`, `.encode`, `.to_bytes`), `mesh::SkinnedMesh.vertices[].position`, `anim::Animation.tracks[].frames[]`, `file::detect`/`FileKind` — names match the RitoShark API report. ✅
**Open risk:** RitoShark `TexFormat` has *more* variants than LTK — every `match` on format needs new arms or a fallback; flagged in Phase 1 Step 5.
