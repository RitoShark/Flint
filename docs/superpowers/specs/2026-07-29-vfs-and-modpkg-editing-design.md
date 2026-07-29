# VFS layer + editable ModPkg — design

**Status:** approved in principle (owner picked "shared in-app VFS layer" and
"VFS first, then modpkg"), not yet implemented.

## Why

Two problems, one root cause.

1. **Three surfaces each build their own fake file explorer.** `WadBrowser.tsx`
   has `buildWadTree`, `WadExplorer.tsx` has its own flattened/virtualised list,
   and `ArchiveEditor.tsx` has a third shape for fantome inner-WADs. They diverge
   in search behaviour, sorting, expand/collapse and context actions, and every
   new archive kind means a fourth copy.
2. **ModPkg is effectively read-only.** `modpkg_edit.rs` is metadata-only by
   design ("File add/remove and per-chunk editing are future work"), and
   `ArchiveEditor` says as much to the user: *"Inner-WAD editing is fantome-only;
   modpkg metadata is editable here."* You can see a chunk count and nothing else.

A single VFS abstraction fixes both: the browsers render one tree component over
a uniform interface, and an editable modpkg becomes "one more mount" rather than
a bespoke editor.

## Non-goals

- **No OS-level mount.** Not a Dokan/WinFsp drive; nothing outside Flint sees
  these paths. (Considered and explicitly rejected — needs a native driver
  dependency and a user install.)
- **No move of this layer into ritoshark.** It is app-side TS. The library owns
  *formats*; this owns *presentation over formats*. If Quartz later wants the
  same thing, promote it then, not speculatively.
- **Not a rewrite of the preview/extract pipeline.** `WadDataSource` already
  abstracts byte-reading for preview; the VFS wraps that rather than replacing it.

## The VFS interface

```ts
export interface VfsEntry {
  path: string;          // full path within the mount, '/'-separated
  name: string;          // last segment
  isDirectory: boolean;
  size?: number;         // uncompressed, when known
  /** Backing identity — chunk hash for WAD/modpkg, disk path for folders. */
  key: string;
}

export interface VfsCapabilities {
  write: boolean;
  rename: boolean;
  delete: boolean;
  add: boolean;
}

export interface Vfs {
  readonly id: string;
  readonly label: string;
  readonly caps: VfsCapabilities;

  list(dir: string): Promise<VfsEntry[]>;   // one level
  read(path: string): Promise<Uint8Array>;
  write?(path: string, bytes: Uint8Array): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
  remove?(path: string): Promise<void>;
  add?(path: string, bytes: Uint8Array): Promise<void>;
}
```

**Capabilities are declared, not guessed.** A CDN mount is read-only, a WAD edit
session is fully writable, a plain mounted WAD is read-only. The tree component
enables context actions off `caps`, so one component serves every surface without
`if (isCdn)` branches scattered through it.

**`list` is one level, not a whole-tree build.** The current `buildWadTree`
materialises every folder node for a 40k-chunk WAD on each keystroke. Mounts keep
a prebuilt path index internally and answer `list(dir)` from it.

**Search stays a mount concern.** `WadExplorer`'s `compileSearch` smart matching
(bare `.` is literal, real metachars engage regex) is deliberate and stays — the
VFS exposes `search(query)` returning flat entries, and the tree renders flat
results in search mode exactly as it does today.

## Mounts

| Mount | Backing | Caps |
|---|---|---|
| `mountWad(wadPath)` | `read_wad_chunk_data` | read |
| `mountWadSession(sessionId)` | `read/write/remove/rename_session_chunk` | full |
| `mountCdnWad(sessionId, idx)` | `cdn_read_inner` | read |
| `mountModpkg(sessionId)` | new commands below | full |
| `mountFolder(dir)` | existing fs commands | full |

The WAD session mount is a thin wrapper over commands that **already exist** —
`rename_session_chunk` (re-keys under `xxhash64(lowercased)`), `remove_session_chunk`,
`write_session_chunk`. That is the model the modpkg side copies.

## ModPkg editing

Today's session stores only a source path and rebuilds from disk on save. To edit
chunks it needs the same delta model the WAD session uses:

```rust
struct ModpkgSessionState {
    source: PathBuf,
    deltas: HashMap<String, ChunkDelta>,   // keyed by chunk path
}

enum ChunkDelta {
    Write(Vec<u8>),
    Delete,
    Rename { to: String },
}
```

`save_modpkg` already decompresses every content chunk into
`HashMap<String, Vec<u8>>` before rebuilding — applying the delta map over that
collection is the whole change. New commands, mirroring `wad_edit.rs` names:

- `read_modpkg_chunk(session_id, path) -> Response` (raw bytes, per the raw-bytes
  IPC rule)
- `write_modpkg_chunk(session_id, path, bytes)` (raw body)
- `remove_modpkg_chunk(session_id, path)`
- `rename_modpkg_chunk(session_id, from, to)`
- `modpkg_dirty_chunks(session_id) -> Vec<String>`

**BIN editing in place** then needs no new machinery: the existing preview route
opens `.bin` through `read_or_convert_bin`; pointing it at the modpkg mount's
`read`/`write` gives Monaco ritobin editing that saves straight back into the
package, no extract/repack round-trip.

### Known sharp edges

- **Multi-layer packages.** `save_modpkg` currently collapses layers onto the base
  ("first occurrence wins"), which is lossy for a genuinely multi-layer package.
  Editing makes that worse (an edit to a shadowed chunk silently targets the
  winner). Either preserve layers through the rebuild or refuse to edit
  multi-layer packages — **decide before shipping edit**, do not inherit the
  collapse silently.
- **Rename re-keys the hash.** Same rule as WAD: the path hash is derived from the
  lowercased path, so a rename is delete-old + write-new, not a metadata tweak.
- **`_meta_/` chunks are not user-visible** and must stay filtered out of the tree
  and untouched by edits.

## Sequencing

1. VFS types + `mountWad` / `mountWadSession`, with the tree component.
2. Migrate `WadBrowser`, then `WadExplorer` (bigger; keep its virtualisation).
3. ModPkg delta session + the five commands above.
4. `mountModpkg` + point `ArchiveEditor` at the shared tree.

Each step is independently shippable and independently verifiable. Steps 1–2 are
a refactor with no user-visible behaviour change — that is the checkpoint that
proves the abstraction before any new feature rides on it.
