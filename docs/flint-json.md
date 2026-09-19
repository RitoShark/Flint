# `flint.json` reference

[Documentation index](README.md) · [Project workflow](projects.md)

`flint.json` lives in the project root, beside `mod.config.json`. It records Flint's project identity, source assets, and extraction choices. It is not an application settings file or a list of commands to execute. Changing a source skin number does not extract that skin; changing a prefix does not move files or rewrite BIN references.

This reference describes schema **2**, as implemented in [project.rs](../src-tauri/crates/flint-core/src/project/project.rs). Prefer Flint's project controls for changes that affect files.

## Example: skin project

```json
{
  "schema": 2,
  "pid": "ebf4a355-2d42-48c5-b160-b2d328eedec9",
  "kind": "skin",
  "source": {
    "champion": "Ahri",
    "skin_id": 27,
    "game_version": "16.17.8104348",
    "branch": "live"
  },
  "repath_prefix": "MyCreator/My-Skin",
  "extract": {
    "sfx": true,
    "vo": true
  },
  "created_at": "2026-09-19T10:00:00Z",
  "modified_at": "2026-09-19T10:15:00Z"
}
```

The names, UUID, build and timestamps above are illustrative. Flint generates the identity and timestamps and records the source it used.

## Every current field

| Field | JSON type / default when absent | Purpose |
|---|---|---|
| `schema` | Integer; `0` on read | File schema version. Flint writes `2`. Older versions trigger a save into the current format when opened. This is not the Flint application version or League patch. |
| `pid` | String; empty | Stable project identifier, generated as a UUID v4. Used by the project index to recognize moves and renames. Opening a project without an ID generates one. |
| `kind` | String; `"skin"` | Project type: `"skin"`, `"map"`, `"loading-screen"`, or `"tft"`. Controls which type-specific source fields Flint writes. |
| `source` | Object; empty/default fields | Provenance: which game assets the project started from. |
| `source.champion` | String; empty | Internal champion/character name, such as `Ahri`. Written for skin and TFT projects when nonempty. |
| `source.skin_id` | Unsigned 32-bit integer; `0` | Source skin number, including the selected chroma's number. `0` means base skin and is omitted on save. Written for skin and TFT projects. |
| `source.map_id` | String or null; absent | Map identifier, such as `map11`. Written for map projects. |
| `source.variant` | String or null; absent | Map variant base name, such as `srx_baseworld`. Written for map projects. |
| `source.game_version` | String or null; absent | Full game build recorded at extraction, read from the install's `Game/content-metadata.json` when available. Describes the original bytes; editing this does not update them. |
| `source.branch` | String or null; absent | Source branch, normally `live` or `pbe`. The serializer accepts a string; this is provenance, not a download selector. |
| `repath_prefix` | String or null; absent | Creator/project portion of the asset namespace, e.g. `MyCreator/My-Skin`, used beneath `ASSETS/`. The stored value does **not** include `ASSETS/`. Used when resolving or renaming repathed assets. |
| `extract` | Object; empty/default fields | Records the audio choices made during extraction. It is not a live extraction switch. |
| `extract.sfx` | Boolean; `false` | Whether sound-effect extraction was requested. `false` is omitted on save. |
| `extract.vo` | Boolean; `false` | Whether voiceover extraction was requested, including available locale WADs. `false` is omitted on save. This does not guarantee that every locale extraction succeeded. |
| `created_at` | RFC 3339 date-time string; required | Project creation timestamp, retained when saving. |
| `modified_at` | RFC 3339 date-time string; required | Metadata save timestamp. Saving writes the current UTC time; it is not a timestamp for every asset edit. |

Optional fields with no value are omitted when Flint saves. Empty champion names, zero skin IDs, and false audio flags are omitted too, so `"extract": {}` and a missing `source.skin_id` are normal.

## Other project types

A map uses the same top-level structure, with `"kind": "map"` and a source such as:

```json
{
  "map_id": "map11",
  "variant": "srx_baseworld",
  "game_version": "16.17.8104348",
  "branch": "live"
}
```

That is the **source object**, not a complete `flint.json`. A loading-screen project omits champion, skin, map and variant source fields on save. A TFT project uses `"kind": "tft"` and can retain champion and skin fields. These values describe the project; they do not convert existing content into another project type.

## Older files and manual edits

Schema 1 stored `champion`, `skin_id`, `map_id`, and `league_path` at the top level. Flint reads those legacy fields and folds the identity fields into `source` where the new fields are empty. It does not write the legacy fields back. The absolute `league_path` is no longer persisted; installation paths belong in application settings.

Older projects that encoded a map as `champion: "map-<id>"`, or a loading screen as `champion: "loading-screen"`, are normalized on open. A `project.json` path can be accepted as an entry point, but the current loader still requires `mod.config.json` in that directory.

Use valid JSON without comments or trailing commas. A malformed `flint.json` is not reliably reported as a hard project-open error: the current loader can ignore its metadata and continue from `mod.config.json`, then backfill an ID. Back up the file before manual edits. Unknown custom keys in `flint.json` are not preserved by its typed save path.

Do not copy a `pid` into a separate project that should have its own identity. Do not change `repath_prefix` independently of the asset paths and BIN references. Use the project rename workflow to keep those changes together.

## What belongs elsewhere?

| Information | Location |
|---|---|
| Mod name, display name, version, description, authors, layers | `mod.config.json` |
| Game files to package | `content/<layer>/...` |
| Readable custom names for hashed paths | `files.txt`, and supported embedded-hashtable project files |
| Checkpoint history | `.flint/` |
| League install and projects-root settings | Flint application settings |
| CDN patch selection | Load from CDN dialog and manifest session; no `flint.json` CDN switch exists |

The frontend receives a flattened runtime `Project` object with fields such as `champion`, `skin_id`, `source_branch`, `extract_sfx`, and `project_path`. That IPC object is not the on-disk schema: `source_branch` maps to `source.branch`, and `extract_sfx` maps to `extract.sfx`.
