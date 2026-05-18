# Flint TODO

Working backlog. Bullets under each item are concrete sub-tasks; question
blocks are notes to me when I (Claude) need clarification before implementing.

---

## Drag-and-drop import — DONE
Drop OS files/folders onto a project-tree folder → copied via
`import_external_files` Rust command. Hover-to-expand at 1.2s, blue dashed
drop-target outline, ` (n)` filename uniquification on collision.

Files: `commands/file.rs` (`import_external_files`, `copy_dir_recursive`),
`api.ts` (`importExternalFiles`), `FileTree.tsx` (Tauri
`onDragDropEvent` listener with physical→CSS pixel conversion).

---

## Bug — "modified" tag triggered by sidecar files — DONE
`isSidecarFile()` helper in `src/lib/sidecarFiles.ts` consulted in
`App.tsx` before setting `fileStatuses`. Hot reload still fires.

---

## Bug — BIN save reload churn — DONE
Write-echo suppression: `core/write_echo.rs` exposes `mark()` /
`consume()`, backed by a 1.5s window keyed on canonicalized paths.
`save_ritobin_to_bin` and the `.ritobin` cache write in the read path
mark their target paths before writing; the project watcher consumes the
mark and skips emitting `file-changed` for matched events.

---

## BIN split — DONE (initial)
Right-click any `.bin` in the file tree (except `_Concat`) → "Split BIN
by Class…". Modal lists every class in the BIN with object counts and
checkboxes; classes our classifier flagged as VFX are checked by default
(`VfxSystemDefinitionData`, `Particle*`, `TrailDef`, `BeamDef`, etc).
Confirm → writes a sibling `Skin{N}_VFX.bin` next to the parent, removes
the moved objects, appends the new file's project-relative path to the
parent's `dependencies` so the engine merges them back at load.

Wire format is byte-compatible with Quartz's `bin:combineLinkedBins`
(the inverse op): `objects` map + `dependencies` string list.

Files: `flint-ltk/src/bin/split.rs` (`classify_vfx_objects`,
`group_by_class`, `split_bin`), `commands/bin_split.rs`
(`analyze_bin_for_split`, `split_bin_entries`), `BinSplitModal.tsx`,
`FileTree.tsx` (context menu entry), `App.tsx` (modal mount),
`types.ts` (`'binSplit'` ModalType).

**Refinements shipped 2026-04-27:**
- Output now always lands at `<wad_root>/data/<filename>` (Riot
  convention) instead of next to the parent BIN.
- Right-click on a `data/` folder → multi-source split: walks every
  `.bin` under the folder (skipping `/animations/`), unions class
  groups across them, and writes one shared output. Owner BIN
  (largest `/skins/skinNN.bin`) gets the new dependency link.
- VFX preset / All / None pill buttons no longer overlap.

**Follow-ups (not done):**
- Reference-graph audit before splitting — currently splitting can in
  theory orphan a hash-reference if a non-VFX class references a VFX
  hash. Engine merges linked deps so this is fine in practice; would
  still be nice to surface a warning in the modal.
- Make the modal show resolved class names with hash-cache hits, not
  just raw hex (currently shows hex when the hash isn't in the BIN
  cache — usually fine since most classes resolve).

---

## BIN organizer — auto-consolidate — DONE
Right-click `data/` → "Organize VFX (auto-consolidate)…". Confirm dialog
shows the preview (VFX object count, non-VFX merge count, owner BIN,
deletion estimate); confirm runs the pass.

Action:
- Walks every `.bin` under the folder, skipping `/animations/`.
- Pulls every VFX-class object from every source (incl. owner) into a
  consolidated `<wad_root>/data/VFX.bin`.
- Merges every non-owner non-VFX object into the owner BIN
  (skip-on-collision — owner's existing version of any duplicate hash
  wins).
- Updates owner's `dependencies` to link the new VFX BIN.
- Deletes any non-owner source BIN that ends up empty.
- Prunes dead links from owner's dependency list (entries pointing at
  files we just deleted).

Reads happen up front; if a parse fails the project is untouched. Refuses
to overwrite an existing `data/VFX.bin` — pick a different name to retry.

Files: `flint-ltk/src/bin/split.rs` (`organize_vfx_in_folder`,
`OrganizeResult`), `commands/bin_split.rs` (`preview_organize_vfx`,
`organize_bins_vfx`), `FileTree.tsx` (right-click handler with confirm
dialog), `api.ts` (wrappers).

**Follow-ups (not done):**
- Per-project skip list for BIN paths the user explicitly wants left
  alone (e.g. `data/SFX.bin` if they hand-curated it).
- Allow specifying a custom output filename in the confirm dialog
  (currently hardcoded to `VFX.bin` — collision triggers a clear error).

---

## WAD explorer right side — base/empty state — partially DONE
Right-side panel previously only showed quick-filter cards on empty
state. Now also shows a "Recent WADs" list above the cards (last 8
expanded WADs, name + category, click to scroll-to-WAD with the same
mechanic the cheat-sheet uses).

Files: `wadExplorerStore.ts` (new `recentWads: string[]` +
`pushRecentWad` action, session-only), `WadExplorer.tsx` (push on
expand, render recent list in `QuickActionPanel`).

**Still TODO:** folder preview when the user selects a folder node in
the WAD tree (grid of immediate children with sizes + count). That's
shared infrastructure with the custom file explorer item below — defer
until that lands.

---

## Custom file explorer — partially DONE
Folder grid view shipped. Click any folder in the project tree → the
right-side preview panel routes to a grid of cards for the immediate
children. Texture cards get a thumbnail decoded once (cached via existing
`imageCache.ts`); other files show their type icon. Click a child to
navigate into / open it. "↑ Up" button on the breadcrumb walks back to
the parent.

Implementation:
- Rust commands: `is_directory`, `list_folder_contents` in
  `commands/file.rs`. The list command sorts directories first, files
  second (alphabetical inside each), and skips `.ritobin` sidecars.
- `FolderGridView.tsx` — grid container + per-entry card. Reuses the
  existing image cache + Rust DDS/TEX decoder for thumbnails.
- `PreviewPanel.tsx` — directory check before `read_file_info`; folder
  selection short-circuits the file-preview pipeline.
- `FileTree.tsx` — folder click now also sets `selectedFile` and
  navigates to the preview view (still toggles expansion).

**Follow-ups shipped 2026-04-27:**
- Full-res modal: double-click a texture card → opens
  `FullResImageModal` with the image at native pixel size, drag-to-pan,
  scroll-to-zoom (cursor stays anchored to the same image pixel during
  zoom), Fit / 1:1 buttons, pixelated rendering past 2× zoom.
- Lazy thumbnail decoding: each texture card now defers its decode
  until an IntersectionObserver fires (200px rootMargin). Cache hits
  still render instantly on mount.

---

## General slowness — partially addressed (clarified by user 2026-04-26)

User clarified the actual pain: **project creation and WAD explorer
indexing are ~50% slower than the old version of Flint**. The frontend
re-render fix is unrelated to this — those are heavy Rust-side ops, not
React renders.

**Cut 1 (DONE — adjacent):** `useAppState()` was the biggest known
frontend offender. It
called every store's bare hook with no selector, subscribing all 22
consumers to the full snapshot of nine stores. A new log line, a toast,
or any field change re-rendered every component using it (incl.
TitleBar/StatusBar which are always mounted). Fixed by switching to
`useShallow` selectors that pick only the fields the legacy `state`
object surfaces. Action methods are read once per render off
`getState()` since their refs are stable.

**Cut 2 (DONE — instrumentation):** added phase-timing logs to the two
paths the user called out as slow:
- `create_project` logs every phase (LMDB prime, find_champion_wad,
  wad_contains_skin_bin, core_create_project mkdir, extract_skin_assets,
  organize_project) plus a total summary with per-phase percentages.
- `get_wad_chunks` logs open/parse, hash collect, LMDB resolve, and
  build-response timings, plus cache hit/miss state and chunk count.

User to run the slow ops once and copy the `[TIMING]` lines from the
console / log panel. Next cut targets whichever phase actually dominates.

**Suspects worth confirming once timings come back:**
- `wad_contains_skin_bin` (project creation step 2b) opens AND mounts the
  champion WAD just to scan the TOC for one of two hashes. The full mount
  parses the entire chunk table — probably 10-100ms wasted per project
  create. Could be fused into `extract_skin_assets`'s mount.
- `WadReader::open` uses a `File` handle, not mmap. `Wad::mount(file)`
  reads TOC via syscalls. By contrast `extract_skin_assets` uses
  `Mmap::map(...)` then `Wad::mount(Cursor::new(&mmap[..]))`. Switching
  `WadReader` to mmap would mostly help repeated reads — likely small win
  for cold opens.
- 3000-chunk LMDB resolve loop in `resolve_hashes_lmdb` is ~3000 individual
  heed `db.get` calls in one read txn. heed serialization overhead per call
  may matter at this scale.
- Tauri IPC serialization of 3000 `ChunkInfo` structs per WAD load.
  Per-WAD payload is ~150KB JSON — adds up if explorer loads many.

**Remaining frontend suspects (separate from the user's main complaint):**
- BIN editor reparses on every keystroke — debounce + diff-parse.
- Tree build via per-folder IPC roundtrip — bulk listing could help.
- Image cache eviction policy under heavy preview load.

---

## Animated loadscreen preset — NEEDS USER SPEC
User mentioned: loadscreen banners can have a static-mat-with-mask setup
that makes them look animated. A right-click action would scaffold this.

I don't yet know:
- The exact BIN structure / class names involved in the animated mask
  pipeline (UV scrolling material? Mask texture binding? Where does the
  reference live — in the loadscreen tex's BIN or somewhere else?).
- What inputs the user expects the right-click to ask for (mask texture
  path? Scroll speed? Loop direction?).
- What "preset" means in this context — a fixed configuration, a chosen
  template from a list, or a parameterised generator?
- Whether this targets a specific class of skins (e.g. only legendary+
  loadscreens) or applies to anything.

**Action item:** user to describe the asset layout (one example skin that
already has this animated banner — point me at the BIN entries and
textures) before I spec the implementation.

---

## Map project fetch — NEEDS USER SPEC
User mentioned this is a detailed thing they want to explain.

I don't yet know:
- Does this mean fetching base map assets (Howling Abyss, SR variants) for
  modding the map itself? Or fetching map-specific overrides for a
  champion skin?
- The skin-id concept doesn't map cleanly to maps — maps have variants,
  not numbered skins. What's the project schema for "Map" mode? Is there
  a target map ID equivalent to a skin ID?
- Source WADs to crawl: `Maps/Shipping/Map11/Map11.wad.client` etc.?
- Refathering rules — do we still rewrite paths to
  `ASSETS/{creator}/{project}/`, or is there a map-specific convention?

**Action item:** user to describe the workflow end-to-end (input the user
provides → assets fetched → folder layout in the project) before I
implement.

---

## Suggested order
1. **Bug — "modified" tag** (small, daily annoyance)
2. **Bug — BIN save reload churn** (small, daily annoyance)
3. **General slowness** — profile first, fix top 3
4. **WAD explorer right side** — small, high polish/effort ratio
5. **BIN split** — needs the modal + Rust split logic
6. **Custom file explorer (re-scoped)** — depends on having a stable
   folder-selection path through PreviewPanel
7. **Animated loadscreen preset** — blocked on user spec
8. **Map project fetch** — blocked on user spec
