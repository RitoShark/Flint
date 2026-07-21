# Sub-project B — `hematite-flint` crate + Tauri commands (Skin Fixer backend)

## Context

Second of three sub-projects for the **Flint Skin Fixer**. Sub-project A landed
`hematite-orchestrate` in Hematite `main` (rev `96ce760`), exposing:

- `fix_folder(folder, config, selected_fixes, champions, hash_provider, opts, progress) -> Result<ProcessResult>`
- `FixOptions { dry_run, detect_only, repath, restore_anm, relocate_combo_bins, game_wad, live }`
- `list_fixes(config) -> Vec<FixInfo{ id, name, description, severity, enabled, wad_level }>`
- `ProgressSink` trait (+ `NoopSink`), `LiveGameProvider`, `GameFileAccess`

This sub-project makes Flint drive that engine in-process: a `hematite-flint`
wrapper crate + three Tauri commands. Sub-project C (the modal UI) consumes
these commands.

## Goal

- Add `crates/hematite-flint` to the Flint Cargo workspace, depending on
  `hematite-orchestrate` / `hematite-file` / `hematite-types` pinned at Hematite
  rev `96ce760` (rs_* inside them is `daff556`, identical to Flint's ritoshark
  rev — no dual rs_* compile).
- The crate provides a small, Flint-facing API:
  - `list_available_fixes() -> Vec<FixEntry>` — the fix catalog (via
    `orchestrate::list_fixes` over the loaded config).
  - `scan_project(project_dir, fix_ids) -> ProjectFixReport` — detect-only pass
    over the project's `content/` folder(s); reports per-fix detection results.
  - `run_fixes(project_dir, fix_ids, progress) -> ProjectFixReport` — real
    extract→fix→rebuild pass; emits progress via a `ProgressSink`.
  - Config loading (remote fetch + cache + embedded fallback, ported from
    Hematite's `remote.rs`).
- Three Tauri commands in `src-tauri` wrapping the crate, plus progress events.

## Config source — remote fetch like the CLI (decided)

Port Hematite's `remote.rs` fetch/cache/fallback into `hematite-flint`:

- Fetch `fix_config.json` + `champion_list.json` from
  `https://raw.githubusercontent.com/RitoShark/Hematite/main/config/…`,
  1-hour TTL cache, stale-cache fallback, then **embedded** fallback.
- **Embedded fallback JSON is vendored** into the crate
  (`crates/hematite-flint/config/fix_config.json` + `champion_list.json`,
  copied from Hematite `main`) via `include_str!` — so offline / first-run
  always works, mirroring the CLI's embedded fallback.
- **HTTP client = Flint's existing reqwest** (`0.13`, `rustls-no-provider` +
  ring — the shared stack per Flint's dep rules). Do NOT add a second HTTP
  stack or `reqwest::blocking` at a different version. Fetch runs inside the
  command's `spawn_blocking` (or use the async client) so it never blocks the
  Tauri IPC thread.
- Cache dir: Flint's app-cache location (reuse the same `%APPDATA%` discovery
  Flint already uses; a `hematite/` subfolder). 1-hour TTL.
- Keep the CLI's **"prefer embedded when newer"** version gate
  (`version_newer`) so a stale remote can't drop a fix id the bundled engine
  expects.

## Architecture

```
crates/hematite-flint  (new)
  → hematite-orchestrate  (git, rev 96ce760)  — fix_folder, list_fixes, FixOptions, ProgressSink
  → hematite-file         (git, rev 96ce760)  — LmdbHashProvider::load_from_appdata
  → hematite-types        (git, rev 96ce760)  — FixConfig, ChampionList, ProcessResult
  → reqwest (Flint's existing pin)            — remote config fetch
```

Flint pins the three hematite crates by **git rev `96ce760`** in
`src-tauri/Cargo.toml` (the workspace root). `hematite-flint` is a **workspace
member** (`src-tauri/crates/hematite-flint`), like `flint-ltk`. It does NOT
need to appear in `flint-ltk/Cargo.toml` (flint-ltk doesn't use it), so unlike
the ritoshark dual-pin, hematite is pinned in ONE place — the binary crate.

### Crate modules

- `lib.rs` — public API re-exports + the three top-level fns.
- `config.rs` — ported remote fetch/cache/embedded loader → `load_config() ->
  (FixConfig, CharacterRelations)`. Vendored JSON under `config/`.
- `hashes.rs` — `hash_provider() -> Arc<dyn HashProvider>` via
  `hematite_file::LmdbHashProvider::load_from_appdata()` with the TXT fallback
  the CLI uses (`hematite_file::TxtHashProvider`). Flint already ships/downloads
  this LMDB (`%APPDATA%\RitoShark\Requirements\Hashes`), so no new download
  path is needed — but surface a clear error if the LMDB is missing so the UI
  can tell the user to download hashes.
- `run.rs` — `scan_project` / `run_fixes`: resolve the project's WAD-folder
  root(s) under `content/`, call `orchestrate::fix_folder` with
  `detect_only: true` (scan) or `false` (run), aggregate `ProcessResult`s into
  a `ProjectFixReport`.
- `report.rs` — Flint-facing serde types (`FixEntry`, `ProjectFixReport`,
  `DetectedFix`, `AppliedFixSummary`) that the Tauri layer serializes to the UI.

### Project → folders

A Flint project stores WADs as unpacked folders under `content/<layer>/*.wad.client/`.
`fix_folder` already accepts a directory and finds `.wad.client` folders inside
it (it walks the tree, `is_wad_folder`). So `run.rs` passes the project's
`content/` dir (or each `<layer>` dir) to `fix_folder`; confirm during impl
whether one call over `content/` handles all layers or we iterate layers. Reuse
the same folder-detection semantics the CLI relies on — do not reimplement WAD
discovery.

### Progress

`run_fixes` takes a Flint `ProgressSink` impl that forwards
`stage`/`fix_applied`/`note` to a Tauri **event** (`hematite-fix-progress`,
payload `{ project, stage?, fix?, count?, note? }`), so the modal shows live
progress. `scan_project` can use `NoopSink` (fast, no rebuild).

### Live game + repath

- `live`: attempt `LiveGameProvider` auto-detection; pass `Some(&provider)` when
  found, `None` otherwise (every live feature fails open). Gate behind a param
  so the UI can offer "use live game for recovery" (default on if detected).
- `repath`: **off** for v1 (the fixer repairs in place; repath is a separate
  concern). `FixOptions.repath = None`.
- `restore_anm` / `relocate_combo_bins`: driven by whether their fix ids
  (`anm_remover`… no — `combo_bin_relocate`, and `--restore-anm` maps to a flag)
  are in the selected set, mirroring the CLI's mapping. Confirm the exact id↔flag
  mapping against `hematite-cli/src/args.rs::collect_selected_fixes` during impl.

## Tauri commands (`src-tauri/src/commands/editor/skin_fixer.rs`)

```rust
#[tauri::command] async fn hematite_list_fixes() -> Result<Vec<FixEntry>, String>;
#[tauri::command] async fn hematite_scan_projects(project_paths: Vec<String>, fix_ids: Vec<String>) -> Result<Vec<ProjectFixReport>, String>;
#[tauri::command] async fn hematite_run_fixes(app: AppHandle, project_paths: Vec<String>, fix_ids: Vec<String>, use_live: bool) -> Result<Vec<ProjectFixReport>, String>;
```

- Registered in `main.rs` `invoke_handler`.
- Heavy work runs in `tokio::task::spawn_blocking` (the engine is sync + CPU/IO
  heavy). `hematite_run_fixes` emits `hematite-fix-progress` events via the
  `AppHandle`.
- `hematite_scan_projects` runs `detect_only` for each project and returns the
  per-fix detection reports the modal filters to "detected" fixes.
- One project failing does not abort the batch — collect per-project errors into
  its `ProjectFixReport.error`.

## Non-goals

- No UI (that's Sub-project C).
- No repath, no `.fantome`/`.bin` single-file fixing (folder/projects only).
- No new hash-download path — reuse Flint's existing LMDB; error clearly if
  absent.
- No checkpoint logic in the crate — the **UI** (C) creates the checkpoint
  before calling `hematite_run_fixes` (mirrors the recolor modal), so the crate
  stays a pure fix driver.

## Rev-lock

Pin `hematite-orchestrate`/`-file`/`-types` at Hematite `main` rev `96ce760` in
`src-tauri/Cargo.toml`. Their `rs_*` is `daff556` = Flint's ritoshark rev; keep
them in lockstep on any future bump (ecosystem library-first rule). After
adding, run `cargo update -p hematite-orchestrate` (lock-only) then
`cargo clippy --lib --bins -- -D warnings -A clippy::needless_return`. NEVER run
a standalone `cargo build`/`cargo check` in Flint (wipes the Tauri dev cache).

## Testing

- `hematite-flint` unit tests: `version_newer` ordering (port the CLI's tests);
  `list_available_fixes` returns a non-empty catalog with names/descriptions
  from the embedded config; config loader falls back to embedded when the cache
  dir is unavailable (offline path).
- `report.rs` serde round-trip (types (de)serialize as the UI expects).
- The full `scan_project`/`run_fixes` need a real WAD folder + LMDB — gate those
  behind an `#[ignore]` integration test pointing at a gitignored fixture (same
  approach as Hematite's `golden_path_parity`).
- Verify: `cargo clippy --lib --bins -- -D warnings -A clippy::needless_return`,
  `npx tsc --noEmit` (no frontend yet, but confirm nothing broke). The Tauri
  dev server compiles the Rust — do not standalone-build.

## Files

- Create: `src-tauri/crates/hematite-flint/{Cargo.toml, src/lib.rs, src/config.rs,
  src/hashes.rs, src/run.rs, src/report.rs, config/fix_config.json,
  config/champion_list.json}`.
- Create: `src-tauri/src/commands/editor/skin_fixer.rs`.
- Modify: `src-tauri/Cargo.toml` (workspace members += hematite-flint; the three
  hematite git deps at rev 96ce760), `src-tauri/src/commands/editor/mod.rs`
  (re-export), `src-tauri/src/main.rs` (register the 3 commands).
