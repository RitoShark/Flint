# LTK → RitoShark backend migration — design

**Branch:** `backend-refactor` · **Date:** 2026-06-04 · **Status:** approved-with-revisions, pre-implementation

## Goal

Replace Flint's dependency on `league-toolkit` (the `ltk_*` crates) with the owner's own
[`RitoShark-Crates`](https://github.com/RitoShark/RitoShark-Crates) workspace, so the Rust backend
runs on a single, owned format layer. Done domain-by-domain, each phase independently testable, on an
isolated branch with high risk tolerance (will not merge until stable — base `main` keeps working).

This is **Phase B** of a larger two-track effort. **Phase A** (move texture/mesh *decode* to a
TypeScript frontend library + GPU upload, to kill the `BCn → RGBA → PNG → base64 → IPC` waste in the
current preview path) is **deferred** until the owner's TS lib is ready, and is intentionally **out of
scope for this spec**. Note the synergy: Phase 1 here (textures via `rs_tex`) exposes raw BCn blocks,
which is exactly the input Phase A will consume.

## Owner constraints (these override defaults)

1. **RitoShark is a git dependency, not a path dependency.** Flint pins a rev of
   `github.com/RitoShark/RitoShark-Crates`. When the lib needs a feature, this effort produces a
   precise written list; the **owner implements it and pushes to `main`**; Flint then bumps the rev.
   Claude never edits RitoShark.
2. **Hematite is hands-off.** The owner will update Hematite to talk to RitoShark separately. Flint
   keeps calling Hematite as-is and only adapts `commands/editor/fixer.rs` to whatever the updated
   Hematite API exposes, once it's ready. Consequence: `league-toolkit` remains in the tree
   *transitively via `hematite-ltk`* until that update lands — but **all of Flint's own direct `ltk_*`
   deps are removed** by this effort.
3. **Experimental, agent-parallelized.** Work may be split one-agent-per-file-type for speed.

## Key architectural insight — the seam already exists

`flint-ltk` is already Flint's insulation layer: `src/commands/` almost never touches `league-toolkit`
directly — it calls `flint-ltk` functions (`parse_skn_file`, `bin_to_text`, `build_wad_from_directory`,
…) and two re-export modules, `flint_ltk::ltk_types` and `flint_ltk::hematite`. ~200 of the ~215 LTK
call sites live *inside* `flint-ltk`.

**Therefore: swap flint-ltk's guts, keep its face.** Rewrite flint-ltk internals to call RitoShark while
holding its public function signatures stable, so `src/commands/` changes almost nothing (mainly the
`ltk_types` re-export module). This is what makes a phase-by-phase swap safe — the app compiles and runs
at every step.

## Wiring

- `flint-ltk/Cargo.toml` gains: `ritoshark = { git = "https://github.com/RitoShark/RitoShark-Crates", rev = "fb7832e", default-features = true }`
  (default features already include all formats). Pinned rev today: `fb7832e0c05efba104a7397942bb4137455e44ab`.
  For dev velocity we may use `branch = "main"` + `cargo update -p ritoshark` after each owner push.
- **Both libraries coexist** for the whole migration. Each `ltk_*` dependency line is deleted only when
  its last use is gone. No `#[allow(dead_code)]`, no dead fallback paths (per project rules).
- Editions interop: `flint-ltk` is edition 2021, `ritoshark` is edition 2024 — fine, editions are
  per-crate and local `rustc` is 1.91.1 (≥ 1.85 required); CI is `@stable`. No toolchain bump.

## Migration phases (each independently testable)

`league-toolkit` keeps compiling until the final phase, so nothing breaks mid-flight.

| # | Phase | Replaces with | Gating | Risk |
|---|---|---|---|---|
| 0 | Wire RitoShark git dep; establish pattern; Flint-side BIN↔JSON shim | — | none | none |
| 1 | **Textures** — `decode_*_to_png`, TEX↔DDS, encode | `rs_tex` | none | low |
| 2 | **Mesh** — SKN/SCB/SCO (drops `accessor::<T>()` generics) | `rs_mesh` | none | low |
| 3 | **Anim** — SKL/ANM (deletes the `catch_unwind` hack) | `rs_anim` | none | low |
| 4 | **Hash / RST / Audio / file-detect** (incl. binary-level `ltk_rst`→`rs_rst`) | `rs_hash`,`rs_rst`,`rs_audio`,`rs_file` | none | low |
| 5 | **BIN** — read/write, ritobin text, JSON, the tree-walks | `rs_bin` | none | 🔴 high (largest surface) |
| 6 | **WAD** — read/extract now; **build** later | `rs_wad` | build blocked on owner's `WadBuilder` | 🔴 high |
| 7 | **Final LTK removal** — adapt `fixer.rs`, delete last `ltk_*` lines | — | blocked on owner's Hematite update | med |

Textures lead deliberately: zero gaps, *and* `rs_tex`'s raw BCn blocks seed the deferred Phase A.
Phases 0–5 and the read/extract half of 6 are **unblocked now**. Phase 6-build and Phase 7 are gated on
owner pushes (WadBuilder; Hematite update).

### Per-domain notes

- **BIN value model**: LTK's `PropertyValueEnum` + typed `Container`/`Optional`/`Map` sub-enums → RitoShark's
  flatter `BinValue` (one recursive enum; `List`/`Map`/`Embed`/`Pointer`/`Option` carry a `BinType` tag +
  plain `Vec`/`IndexMap<u32, BinValue>`). Field/class/entry keys are FNV1a-32 via `rs_hash::fnv1a` (same as
  today). The 4 recursive tree-walks (`repath/refather.rs`, `wad/extractor.rs` path-collect,
  `mesh/animation.rs` path-extract, plus `champion_schema.rs` / `dev.rs`) get **rewritten but simpler**.
- **Ritobin text**: `rs_bin::from_text` + `to_text`, byte-exact round-trip. The display-side hash dict
  (`HashMapProvider` from LMDB) becomes `rs_hash::HashMapper` populated from the same LMDB entries.
  `from_text` ignores the mapper (deterministic hashing), so text→bin needs no dict.
- **BIN↔JSON**: implemented **Flint-side** in `flint-ltk` over `BinValue` (serde_json), shape transient
  (only needs bin→json→bin self-consistency). Not on the owner's list — unless owner prefers it in `rs_bin`.
- **Mesh**: `rs_mesh` exposes direct vertex fields (`position`/`normal`/`uv`/`blend_indices`/`blend_weights`)
  instead of LTK's generic `accessor::<Vec3>(ElementName::Position)` — simpler. SKN indices `u16`.
- **Anim**: legacy `r3d2sklt` skeletons → clean `UnsupportedVersion` error (no panic), so the `catch_unwind`
  wrappers in `mesh/skl.rs` / `mesh/animation.rs` are deleted.
- **File detect**: `ltk_file::LeagueFileKind` → `rs_file::detect(&[u8]) -> FileKind`.
- **Out of scope / unchanged**: `ltk_modpkg`, `ltk_mod_project`, `ltk_mod_core`, `ltk_fantome`,
  `ltk_inibin` (orthogonal modding crates, stay); `bin/jade/` and `wad_jade/` (already standalone, no LTK).

## What RitoShark must gain (owner's list)

See companion file: `2026-06-04-ritoshark-additions-for-flint.md`. Summary:

1. **`rs_wad`: `WadBuilder` + zstd encoder** — build WAD v3.4 from loose `(path, bytes)` entries:
   XXH64 path-hash, zstd compress, dedup-by-data, TOC sorted by hash, offset/checksum computation,
   `to_bytes`/`to_writer`/streaming-callback. *Required* — it's the one gap that genuinely belongs in
   the format crate (export: Fantome / ModPkg / LTK-Manager).
2. *(optional)* **`rs_bin`: serde/JSON** — `#[derive(Serialize, Deserialize)]` + `to_json`/`from_json`.
   Otherwise handled Flint-side.

## Testing strategy — differential, leveraging byte-exactness

Both libs claim byte-exact round-trips, so per phase a **temporary differential harness** runs both
engines on real game files and asserts identical output: tex → identical decoded RGBA; mesh → identical
vertex/index buffers; bin → identical ritobin text + re-encoded bytes; wad → identical *parsed-then-
reserialized* bytes (passthrough). Catches RitoShark gaps before the LTK path is deleted; then the LTK
path is removed and a golden-file regression check may stay. Real-file tests skip cleanly when game
files are absent (CI stays green).

> **WAD-build caveat**: byte-identical-to-LTK is *not* the bar for building-from-loose-files (zstd
> level/dict differences produce different-but-valid compressed bytes). Bar = valid v3.4 that the game/
> tools accept and that decompresses identically.

Per-phase verification: `cargo clippy --lib --bins -- -D warnings -A clippy::needless_return`,
`npx tsc --noEmit`, and a real run via `npm run tauri dev`. Never standalone `cargo build` (wipes the
incremental cache).

## Agent parallelization

Phase 0 is serial (Claude): sets up the shared `Cargo.toml` + `lib.rs` re-export seam and establishes the
pattern. Phases 1–4 are independent domains → one agent each, but they touch shared files (`lib.rs`
re-exports, `Cargo.toml`). Coordination: each agent edits **only its domain's internal modules** and
returns the precise `lib.rs`/`Cargo.toml` deltas; Claude applies shared-file edits centrally to avoid
conflicts. Phase 5 (BIN) is large and partly serial. Detailed in the implementation plan.

## Risks / open items

- BIN tree-walk rewrite is the bulk of the effort (flatter target helps).
- `WadBuilder` correctness — must produce valid v3.4 the game accepts; differential decode test guards it.
- Phase 7 timing depends entirely on the owner's Hematite update.
- `convert_bin_to_json` appears unused on the frontend; confirm before keeping it (candidate for deletion).
