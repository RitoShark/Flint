# Checkpoints

The Timeline tab and checkpoint dialog share the same history browser. Search
matches checkpoint names, tags, and displayed dates. Filter by manual or automatic
checkpoints; pages contain 30 entries. Focus a row and use arrow keys to move,
then Enter or Space to select it. Restore and delete act on the checkpoint named
in the details header. File comparisons use the previous checkpoint in the full
history, even when a search or filter hides that checkpoint.

## Creation policy

- Named, manual checkpoints always save when requested.
- Exporting or syncing to a launcher does not create a checkpoint.
- Consecutive paint saves reuse the first paint checkpoint for 15 minutes.
  This preserves the state before that editing window, not every individual save.
- Fixes, recolors, and restores retain their pre-operation backup behavior.
- Automatic requests reuse the latest checkpoint when its file contents already
  match the project. Manual checkpoints are not deduplicated.

## Storage

File contents remain deduplicated by SHA-256. New objects use Zstandard compression
when it produces a smaller file. Checkpoint manifests and hash caches use
pretty-printed JSON. The `.flint` directory is marked hidden on Windows when
created or accessed through checkpoint history or the hash cache.
Raw objects from existing projects remain readable for previews and restores.
Existing history is not pruned or recompressed. Deleting a checkpoint removes
its manifest; it does not currently reclaim unreferenced stored objects.

Regression checks: `cargo test -p flint-core checkpoint --lib` from `src-tauri`.
