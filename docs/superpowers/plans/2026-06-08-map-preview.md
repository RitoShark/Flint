# Map Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 3D map preview that opens in a separate window, renders a map project's mapgeo geometry with textures auto-connected from the materials bin, and live-reloads when textures or the bin change.

**Architecture:** Hybrid split. Rust parses the mapgeo (decoding packed vertex buffers into flat f32 arrays) and the materials bin (building a submesh-name → diffuse-texture-path table), returns both as a binary IPC payload. Rust also decodes textures (.tex/.dds) to raw RGBA on demand. A separate Tauri window hosts a Babylon.js scene that builds meshes from the arrays, lazily fetches textures into RawTextures with unlit PBR materials, and reloads on the existing `file-changed` watcher event.

**Tech Stack:** Rust (Tauri 2, `ritoshark` crates: `rs_mapgeo`, `rs_bin`, `rs_tex`, `rs_hash`), TypeScript/React, Babylon.js 9, Vite.

**Spec:** `docs/superpowers/specs/2026-06-08-map-preview-design.md`

---

## Key facts the implementer must know

- **The connection chain (deterministic):** mapgeo `Submesh.name` == material name == the key of a `StaticMaterialDef` entry in the materials bin. That entry's `samplerValues` list holds `StaticMaterialShaderSamplerDef` embeds; the one whose `TextureName == "DiffuseTexture"` has the `texturePath` we render.
- **Bin field names are FNV1a-32 hashed.** Use `ritoshark`'s hash (re-exported; `rs_hash::fnv::fnv1a`) to compute the hash of a field name and look it up in `entry.fields` / `Pointer.fields` / `Embed.fields` (all `IndexMap<u32, BinValue>`). Class hashes (`StaticMaterialDef`, `StaticMaterialShaderSamplerDef`) are FNV1a-32 of the class name. Values may also already be readable if the bin was loaded with a mapper — but do NOT rely on text; match by hash.
- **Vertex decode:** A `VertexBuffer.data` is raw bytes. Walk `VertexDescription.elements` in order; each element's offset is the running sum of prior `format.byte_size()`; the per-vertex stride is `description.vertex_size()`. We only need `ElementName::Position` (read as 3×f32 from `XyzFloat32`) and `ElementName::Texcoord0` (2×f32 from `XyFloat32`). Compute normals in Babylon (mirrors the SKN path), so we can skip packed-normal handling.
- **Variant auto-detect:** `flint.json` stores `map_id` only. Scan `content/*/Map*.wad.client/data/maps/mapgeometry/<map_id>/` for `*.mapgeo`; pair each with the same-stem `*.materials.bin`. Use the first complete pair.
- **Reuse, don't reinvent:**
  - Texture decode: `decode_to_clamped_rgba` in `src-tauri/src/commands/assets/texture_convert.rs` (uses `Texture::from_bytes` / `from_dds_bytes` then `.decode_rgba()`). For preview we want the UNcropped RGBA, so write a sibling `decode_full_rgba` that skips the multiple-of-4 crop.
  - Texture path resolution: `resolve_asset_path(asset_path, bin_path)` (`src-tauri/src/commands/assets/mesh.rs:636`) already strips the `ASSETS/` prefix and searches WAD folders. Call it to turn a bin `texturePath` into a real file path.
  - Live reload: `start_preview_watcher(project_path)` (`src-tauri/src/commands/project/project_watcher.rs:195`) already emits a `"file-changed"` event `{ path, kind }` for any change under `content/`. `app.emit` broadcasts to ALL windows, so the separate preview window receives it. No new watcher.
  - Binary IPC: return `tauri::ipc::Response::new(bytes)` (see `convert_tex_bytes_to_dds`). Decode on the frontend like `decodeMeshPayload` in `src/lib/api/mesh.ts`.
  - Babylon patterns: copy engine lifecycle, try/catch render loop, synchronous dispose, unlit `PBRMaterial`, camera framing + degenerate-box guard from `src/components/preview/ModelPreview.tsx`; reuse the `SubmeshRange`/slicing contract from `src/lib/babylon/meshBuilder.ts`.
  - Standalone window mounting: `src/main.tsx` already branches on `window.location.hash === '#design-lab'` to mount a different root without booting the app.

## File structure

**Rust (new):**
- `src-tauri/src/commands/project/map_preview.rs` — all map-preview commands + helpers + unit tests.

**Rust (modified):**
- `src-tauri/src/commands/project/mod.rs` — add `pub mod map_preview;`
- `src-tauri/src/main.rs` — register the three new commands in `generate_handler!`.
- `src-tauri/src/commands/assets/texture_convert.rs` — add `pub(crate) fn decode_full_rgba`.

**Frontend (new):**
- `src/lib/api/mapPreview.ts` — typed bindings + binary payload decode.
- `src/components/preview/MapPreviewWindow.tsx` — standalone window root.
- `src/components/preview/MapPreview.tsx` — the Babylon renderer.

**Frontend (modified):**
- `src/lib/api/index.ts` — export `./mapPreview`.
- `src/main.tsx` — branch on `#map-preview` hash to mount `MapPreviewWindow`.
- The map project UI — add a "Preview Map" button (Task 11).

---

## Task 1: Rust — full (uncropped) RGBA decode helper

**Files:**
- Modify: `src-tauri/src/commands/assets/texture_convert.rs` (add fn near `decode_to_clamped_rgba`, ~line 76)

- [ ] **Step 1: Add the helper**

In `texture_convert.rs`, immediately after `decode_to_clamped_rgba`'s closing brace, add:

```rust
/// Decode a DDS or TEX file's top mipmap to full RGBA with NO block-boundary
/// crop. Used by the map preview, which uploads pixels straight to a Babylon
/// RawTexture (never re-encodes), so the multiple-of-4 crop that
/// `decode_to_clamped_rgba` applies for re-encoding is both unnecessary and
/// would shift UVs. Returns (rgba_image).
pub(crate) fn decode_full_rgba(data: &[u8]) -> Result<image::RgbaImage, String> {
    if data.len() < 4 {
        return Err("File too small to be a valid texture".into());
    }
    let texture = if &data[0..4] == b"DDS " {
        Texture::from_dds_bytes(data).map_err(|e| format!("Failed to parse texture: {:?}", e))?
    } else {
        Texture::from_bytes(data).map_err(|e| format!("Failed to parse texture: {:?}", e))?
    };
    texture
        .decode_rgba()
        .map_err(|e| format!("Failed to decode top mipmap: {:?}", e))
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo build --manifest-path src-tauri/Cargo.toml --lib`
Expected: builds (a `dead_code` warning for the new fn is acceptable until Task 7 uses it).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/assets/texture_convert.rs
git commit -m "feat(map-preview): add uncropped RGBA decode helper"
```

---

## Task 2: Rust — module skeleton + variant discovery (with tests)

**Files:**
- Create: `src-tauri/src/commands/project/map_preview.rs`
- Modify: `src-tauri/src/commands/project/mod.rs`

- [ ] **Step 1: Register the module**

In `src-tauri/src/commands/project/mod.rs`, add after `pub mod map_project;`:

```rust
pub mod map_preview;
```

- [ ] **Step 2: Write the failing test + skeleton**

Create `src-tauri/src/commands/project/map_preview.rs`:

```rust
//! Map preview: discover a map project's mapgeo+materials pair, parse the
//! geometry and material→texture links, and decode textures for a 3D preview
//! rendered in a separate window. See docs/superpowers/specs/2026-06-08-map-preview-design.md.

use std::path::{Path, PathBuf};

/// A discovered mapgeo + materials-bin pair inside a map project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MapPreviewSource {
    /// Absolute path to the `.mapgeo` file.
    pub mapgeo: PathBuf,
    /// Absolute path to the sibling `.materials.bin` file.
    pub materials: PathBuf,
    /// Variant stem, e.g. "base_srx".
    pub variant: String,
}

/// Scan a directory for `<stem>.mapgeo` files and pair each with a sibling
/// `<stem>.materials.bin`. Returns all complete pairs, sorted by stem.
fn find_pairs_in_dir(dir: &Path) -> Vec<MapPreviewSource> {
    let mut pairs = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return pairs;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Match "<stem>.mapgeo" exactly (file_name ends with ".mapgeo",
        // but NOT ".materials.bin" etc.).
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !name.ends_with(".mapgeo") {
            continue;
        }
        let stem = name.trim_end_matches(".mapgeo").to_string();
        let materials = dir.join(format!("{stem}.materials.bin"));
        if materials.exists() {
            pairs.push(MapPreviewSource {
                mapgeo: path.clone(),
                materials,
                variant: stem,
            });
        }
    }
    pairs.sort_by(|a, b| a.variant.cmp(&b.variant));
    pairs
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(path: &Path) {
        fs::write(path, b"x").unwrap();
    }

    #[test]
    fn find_pairs_matches_by_stem() {
        let tmp = std::env::temp_dir().join("flint_mp_test_pairs");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        touch(&tmp.join("base_srx.mapgeo"));
        touch(&tmp.join("base_srx.materials.bin"));
        // A mapgeo with no materials sibling — must be ignored.
        touch(&tmp.join("lonely.mapgeo"));

        let pairs = find_pairs_in_dir(&tmp);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].variant, "base_srx");
        assert!(pairs[0].mapgeo.ends_with("base_srx.mapgeo"));
        assert!(pairs[0].materials.ends_with("base_srx.materials.bin"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn find_pairs_empty_when_none() {
        let tmp = std::env::temp_dir().join("flint_mp_test_empty");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        assert!(find_pairs_in_dir(&tmp).is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml map_preview -- --nocapture`
Expected: `find_pairs_matches_by_stem` and `find_pairs_empty_when_none` PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/project/map_preview.rs src-tauri/src/commands/project/mod.rs
git commit -m "feat(map-preview): variant pair discovery with tests"
```

---

## Task 3: Rust — resolve the project's map directory and discover the source

**Files:**
- Modify: `src-tauri/src/commands/project/map_preview.rs`

- [ ] **Step 1: Add discovery that reads flint.json and scans the mapgeometry dir**

Add to `map_preview.rs` (above the `#[cfg(test)]` module):

```rust
/// Read `map_id` from a project's flint.json.
fn read_map_id(project_path: &Path) -> Result<String, String> {
    let flint = project_path.join("flint.json");
    let text = std::fs::read_to_string(&flint)
        .map_err(|e| format!("Failed to read flint.json: {e}"))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Invalid flint.json: {e}"))?;
    json.get("map_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "flint.json has no map_id (not a map project?)".to_string())
}

/// Discover the mapgeo + materials pair for a map project. Looks under every
/// `content/<layer>/Map*.wad.client/data/maps/mapgeometry/<map_id>/`.
pub fn discover_map_source(project_path: &Path) -> Result<MapPreviewSource, String> {
    let map_id = read_map_id(project_path)?;
    let content = project_path.join("content");
    let mut all_pairs: Vec<MapPreviewSource> = Vec::new();

    // content/<layer>/<wad>/data/maps/mapgeometry/<map_id>/
    if let Ok(layers) = std::fs::read_dir(&content) {
        for layer in layers.flatten() {
            let wad_root = layer.path();
            if !wad_root.is_dir() {
                continue;
            }
            if let Ok(wads) = std::fs::read_dir(&wad_root) {
                for wad in wads.flatten() {
                    let dir = wad
                        .path()
                        .join("data")
                        .join("maps")
                        .join("mapgeometry")
                        .join(&map_id);
                    if dir.is_dir() {
                        all_pairs.extend(find_pairs_in_dir(&dir));
                    }
                }
            }
        }
    }

    all_pairs.sort_by(|a, b| a.variant.cmp(&b.variant));
    all_pairs
        .into_iter()
        .next()
        .ok_or_else(|| format!("No mapgeo+materials pair found for map '{map_id}' in this project"))
}
```

- [ ] **Step 2: Add a test that builds the nightmap-like layout**

Add inside `mod tests`:

```rust
    #[test]
    fn discover_finds_pair_in_nested_layout() {
        let tmp = std::env::temp_dir().join("flint_mp_test_discover");
        let _ = fs::remove_dir_all(&tmp);
        let geo_dir = tmp
            .join("content")
            .join("base")
            .join("Map11.wad.client")
            .join("data")
            .join("maps")
            .join("mapgeometry")
            .join("map11");
        fs::create_dir_all(&geo_dir).unwrap();
        touch(&geo_dir.join("base_srx.mapgeo"));
        touch(&geo_dir.join("base_srx.materials.bin"));
        fs::write(
            tmp.join("flint.json"),
            br#"{ "kind": "map", "map_id": "map11" }"#,
        )
        .unwrap();

        let src = discover_map_source(&tmp).unwrap();
        assert_eq!(src.variant, "base_srx");
        let _ = fs::remove_dir_all(&tmp);
    }
```

- [ ] **Step 3: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml map_preview -- --nocapture`
Expected: 3 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/project/map_preview.rs
git commit -m "feat(map-preview): discover map source from flint.json + content tree"
```

---

## Task 4: Rust — materials bin → submesh-name → diffuse-texture-path table (with test)

**Files:**
- Modify: `src-tauri/src/commands/project/map_preview.rs`

- [ ] **Step 1: Add the material-table extractor**

The materials bin is parsed with `ritoshark`'s bin API. Field/class names are
FNV1a-32. Add to `map_preview.rs`:

```rust
use ritoshark::bin::{Bin, BinValue};
use ritoshark::prelude::Parse as _; // Bin::from_path / from_bytes

/// Map of submesh/material name -> diffuse texture path (as stored in the bin,
/// e.g. "ASSETS/Maps/.../foo.tex").
pub type MaterialTable = std::collections::HashMap<String, String>;

// FNV1a-32 helpers. ritoshark re-exports rs_hash; field names are case-
// insensitive lowercased per the hashing rule.
fn h(name: &str) -> u32 {
    ritoshark::hash::fnv1a(name)
}

/// Pull a String field out of a field map by its (hashed) name.
fn get_string(fields: &indexmap::IndexMap<u32, BinValue>, name: &str) -> Option<String> {
    match fields.get(&h(name)) {
        Some(BinValue::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// Build the submesh-name → diffuse-texture-path table from a materials bin.
pub fn build_material_table(materials_bin: &Path) -> Result<MaterialTable, String> {
    let bin = Bin::from_path(materials_bin)
        .map_err(|e| format!("Failed to parse materials bin: {:?}", e))?;

    let static_material_def = h("StaticMaterialDef");
    let mut table = MaterialTable::new();

    for entry in &bin.entries {
        if entry.class_hash != static_material_def {
            continue;
        }
        // The material's own name (== the mapgeo submesh name).
        let Some(mat_name) = get_string(&entry.fields, "name") else {
            continue;
        };

        // samplerValues: list of StaticMaterialShaderSamplerDef embeds.
        let Some(BinValue::List { items, .. }) = entry.fields.get(&h("samplerValues")) else {
            continue;
        };

        for item in items {
            let fields = match item {
                BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. } => fields,
                _ => continue,
            };
            let texture_name = get_string(fields, "TextureName").unwrap_or_default();
            if texture_name == "DiffuseTexture" {
                if let Some(tex_path) = get_string(fields, "texturePath") {
                    table.insert(mat_name.clone(), tex_path);
                    break;
                }
            }
        }
    }

    Ok(table)
}
```

NOTE for implementer: verify the exact `ritoshark` re-export paths at build time
(`ritoshark::bin::{Bin, BinValue}`, `ritoshark::hash::fnv1a`, `indexmap::IndexMap`).
If a path differs, fix the `use` — the logic is unchanged. `rs_bin`'s `BinValue::List`
has fields `{ is_list2, item, items }`; we only read `items`.

- [ ] **Step 2: Add a test against a synthetic bin**

The most robust test builds a tiny `Bin` in memory, serializes it, and runs the
extractor. Add inside `mod tests`:

```rust
    #[test]
    fn material_table_extracts_diffuse() {
        use ritoshark::bin::{Bin, BinEntry, BinValue};
        use ritoshark::prelude::Serialize as _;

        let mut sampler = indexmap::IndexMap::new();
        sampler.insert(super::h("TextureName"), BinValue::String("DiffuseTexture".into()));
        sampler.insert(
            super::h("texturePath"),
            BinValue::String("ASSETS/Maps/Foo/bar.tex".into()),
        );

        let mut fields = indexmap::IndexMap::new();
        fields.insert(super::h("name"), BinValue::String("Foo/Bar_MAT".into()));
        fields.insert(
            super::h("samplerValues"),
            BinValue::List {
                is_list2: true,
                item: ritoshark::bin::BinType::Embed,
                items: vec![BinValue::Embed {
                    class: super::h("StaticMaterialShaderSamplerDef"),
                    fields: sampler,
                }],
            },
        );

        let bin = Bin {
            is_patch: false,
            patch_header: [0; 8],
            version: 3,
            linked: vec![],
            entries: vec![BinEntry {
                path_hash: 1,
                class_hash: super::h("StaticMaterialDef"),
                fields,
            }],
            patches: vec![],
        };

        let tmp = std::env::temp_dir().join("flint_mp_mat.bin");
        std::fs::write(&tmp, bin.to_bytes().unwrap()).unwrap();

        let table = build_material_table(&tmp).unwrap();
        assert_eq!(
            table.get("Foo/Bar_MAT").map(String::as_str),
            Some("ASSETS/Maps/Foo/bar.tex")
        );
        let _ = std::fs::remove_file(&tmp);
    }
```

NOTE: confirm `BinType::Embed` and the `Bin`/`BinEntry`/`BinValue` literal field
names against `rs_bin/src/bin.rs` (verified in spec: `Bin { is_patch, patch_header,
version, linked, entries, patches }`, `BinEntry { path_hash, class_hash, fields }`,
`BinValue::List { is_list2, item, items }`, `BinValue::Embed { class, fields }`).
Adjust the literal if the enum’s `BinType` variant name differs.

- [ ] **Step 3: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml map_preview -- --nocapture`
Expected: 4 tests PASS. If the synthetic-bin construction fights the API, fall
back to committing a tiny real `.materials.bin` fixture under
`src-tauri/tests/fixtures/` and load that instead — keep the assertion.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/project/map_preview.rs
git commit -m "feat(map-preview): extract submesh→diffuse-texture table from materials bin"
```

---

## Task 5: Rust — decode mapgeo geometry into flat arrays (with test)

**Files:**
- Modify: `src-tauri/src/commands/project/map_preview.rs`

- [ ] **Step 1: Add geometry decode**

Add to `map_preview.rs`:

```rust
use ritoshark::mapgeo::{ElementFormat, ElementName, MapGeometry};

/// One submesh draw range, in the same shape the frontend meshBuilder expects.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SubmeshRange {
    pub name: String,
    pub start_vertex: u32,
    pub vertex_count: u32,
    pub start_index: u32,
    pub index_count: u32,
}

/// Decoded, render-ready geometry: one global vertex pool + index list, plus
/// submesh ranges. Positions/uvs are flat f32; indices are u32. Normals are
/// computed in Babylon (mirrors the SKN path), so we don't emit them.
#[derive(Debug, Default)]
pub struct DecodedGeometry {
    pub positions: Vec<f32>, // len = vertex_count * 3
    pub uvs: Vec<f32>,       // len = vertex_count * 2
    pub indices: Vec<u32>,
    pub submeshes: Vec<SubmeshRange>,
    pub bbox_min: [f32; 3],
    pub bbox_max: [f32; 3],
}

/// Read 3 little-endian f32 from a slice at offset.
fn read_f32x3(buf: &[u8], at: usize) -> [f32; 3] {
    [
        f32::from_le_bytes(buf[at..at + 4].try_into().unwrap()),
        f32::from_le_bytes(buf[at + 4..at + 8].try_into().unwrap()),
        f32::from_le_bytes(buf[at + 8..at + 12].try_into().unwrap()),
    ]
}
fn read_f32x2(buf: &[u8], at: usize) -> [f32; 2] {
    [
        f32::from_le_bytes(buf[at..at + 4].try_into().unwrap()),
        f32::from_le_bytes(buf[at + 4..at + 8].try_into().unwrap()),
    ]
}

/// Decode all models of a parsed mapgeo into a single geometry pool.
pub fn decode_geometry(geo: &MapGeometry) -> Result<DecodedGeometry, String> {
    let mut out = DecodedGeometry::default();
    out.bbox_min = [f32::MAX; 3];
    out.bbox_max = [f32::MIN; 3];

    for model in &geo.models {
        let desc = geo
            .vertex_descriptions
            .get(model.vertex_description_id as usize)
            .ok_or("vertex_description_id out of range")?;
        let stride = desc.vertex_size();

        // Compute byte offset of Position and Texcoord0 within a vertex.
        let mut pos_off: Option<usize> = None;
        let mut uv_off: Option<usize> = None;
        let mut running = 0usize;
        for el in &desc.elements {
            match el.name {
                ElementName::Position if el.format == ElementFormat::XyzFloat32 => {
                    pos_off = Some(running)
                }
                ElementName::Texcoord0 if el.format == ElementFormat::XyFloat32 => {
                    uv_off = Some(running)
                }
                _ => {}
            }
            running += el.format.byte_size();
        }
        let pos_off = pos_off.ok_or("model has no float Position attribute")?;

        // The model may span multiple vertex buffers; for the standard static
        // map layout there is one. Use the first buffer id.
        let vbuf_id = *model
            .vertex_buffer_ids
            .first()
            .ok_or("model has no vertex buffer")? as usize;
        let vbuf = geo
            .vertex_buffers
            .get(vbuf_id)
            .ok_or("vertex_buffer_id out of range")?;
        let ibuf = geo
            .index_buffers
            .get(model.index_buffer_id as usize)
            .ok_or("index_buffer_id out of range")?;

        let base_vertex = (out.positions.len() / 3) as u32;
        let base_index = out.indices.len() as u32;

        // Decode this model's vertices.
        for v in 0..model.vertex_count as usize {
            let vbase = v * stride;
            let p = read_f32x3(&vbuf.data, vbase + pos_off);
            for i in 0..3 {
                out.bbox_min[i] = out.bbox_min[i].min(p[i]);
                out.bbox_max[i] = out.bbox_max[i].max(p[i]);
            }
            out.positions.extend_from_slice(&p);
            let uv = match uv_off {
                Some(o) => read_f32x2(&vbuf.data, vbase + o),
                None => [0.0, 0.0],
            };
            out.uvs.extend_from_slice(&uv);
        }

        // Append this model's indices, offset into the global pool.
        for &idx in &ibuf.indices {
            out.indices.push(base_vertex + idx as u32);
        }

        // Submesh ranges (offset to the global pool).
        for sm in &model.submeshes {
            out.submeshes.push(SubmeshRange {
                name: sm.name.clone(),
                start_vertex: base_vertex + sm.min_vertex,
                vertex_count: sm.max_vertex.saturating_sub(sm.min_vertex) + 1,
                start_index: base_index + sm.index_start,
                index_count: sm.index_count,
            });
        }
    }

    if out.positions.is_empty() {
        out.bbox_min = [0.0; 3];
        out.bbox_max = [0.0; 3];
    }
    Ok(out)
}
```

NOTE for implementer: confirm `ritoshark::mapgeo::{...}` re-export path and the
`Submesh` field names (`name`, `index_start`, `index_count`, `min_vertex`,
`max_vertex` — verified in spec). `MapModel` fields used: `vertex_description_id`,
`vertex_buffer_ids`, `index_buffer_id`, `vertex_count`, `submeshes`.

- [ ] **Step 2: Test against the real nightmap mapgeo if present, else skip**

Add inside `mod tests`:

```rust
    #[test]
    fn decode_real_mapgeo_if_available() {
        // Opportunistic: only runs on a machine with the nightmap project.
        let p = dirs_next_home()
            .join("AppData/Roaming/Flint/projects/nightmap/content/base/Map11.wad.client/data/maps/mapgeometry/map11/base_srx.mapgeo");
        if !p.exists() {
            eprintln!("skip: real mapgeo not present at {}", p.display());
            return;
        }
        use ritoshark::prelude::Parse as _;
        let bytes = std::fs::read(&p).unwrap();
        let geo = ritoshark::mapgeo::MapGeometry::from_bytes(&bytes).unwrap();
        let decoded = decode_geometry(&geo).unwrap();
        assert!(!decoded.positions.is_empty());
        assert_eq!(decoded.positions.len() % 3, 0);
        assert!(decoded.positions.iter().all(|f| f.is_finite()));
        assert!(!decoded.submeshes.is_empty());
        eprintln!(
            "decoded {} verts, {} submeshes",
            decoded.positions.len() / 3,
            decoded.submeshes.len()
        );
    }

    fn dirs_next_home() -> std::path::PathBuf {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(std::path::PathBuf::from)
            .unwrap_or_default()
    }
```

- [ ] **Step 3: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml map_preview -- --nocapture`
Expected: PASS. On this dev machine the real-mapgeo test prints vert/submesh
counts (proves decode works on actual data). On other machines it self-skips.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/project/map_preview.rs
git commit -m "feat(map-preview): decode mapgeo vertex/index buffers into flat arrays"
```

---

## Task 6: Rust — `load_map_preview` command (binary payload)

**Files:**
- Modify: `src-tauri/src/commands/project/map_preview.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add the command assembling the binary payload**

The payload mirrors `src/lib/api/mesh.ts` `decodeMeshPayload`:
`[u32 meta_len][meta json utf-8][pad to 4][positions f32][uvs f32][indices u32]`.

Add to `map_preview.rs`:

```rust
use ritoshark::prelude::Parse as _;

#[derive(serde::Serialize)]
struct MapPreviewMeta {
    variant: String,
    vertex_count: u32,
    index_count: u32,
    submeshes: Vec<SubmeshRange>,
    /// submesh-name -> diffuse texture path (bin path, may be absent for some)
    materials: MaterialTable,
    bounding_box: [[f32; 3]; 2],
}

/// Parse a map project's geometry + material links and return a binary payload.
#[tauri::command]
pub async fn load_map_preview(project_path: String) -> Result<tauri::ipc::Response, String> {
    let project = PathBuf::from(&project_path);
    let source = discover_map_source(&project)?;

    let bytes = std::fs::read(&source.mapgeo)
        .map_err(|e| format!("Failed to read mapgeo: {e}"))?;
    let geo = MapGeometry::from_bytes(&bytes)
        .map_err(|e| format!("Failed to parse mapgeo: {:?}", e))?;
    let decoded = decode_geometry(&geo)?;
    let materials = build_material_table(&source.materials)?;

    let meta = MapPreviewMeta {
        variant: source.variant,
        vertex_count: (decoded.positions.len() / 3) as u32,
        index_count: decoded.indices.len() as u32,
        submeshes: decoded.submeshes,
        materials,
        bounding_box: [decoded.bbox_min, decoded.bbox_max],
    };

    let meta_json = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(&(meta_json.len() as u32).to_le_bytes());
    out.extend_from_slice(&meta_json);
    while out.len() % 4 != 0 {
        out.push(0);
    }
    for f in &decoded.positions {
        out.extend_from_slice(&f.to_le_bytes());
    }
    for f in &decoded.uvs {
        out.extend_from_slice(&f.to_le_bytes());
    }
    for i in &decoded.indices {
        out.extend_from_slice(&i.to_le_bytes());
    }

    Ok(tauri::ipc::Response::new(out))
}
```

- [ ] **Step 2: Register the command**

In `src-tauri/src/main.rs`, inside `generate_handler![ ... ]`, after the
`commands::map_project::create_map_project,` line add:

```rust
            commands::map_preview::load_map_preview,
```

- [ ] **Step 3: Build**

Run: `cargo build --manifest-path src-tauri/Cargo.toml --lib`
Expected: compiles. Fix any `ritoshark` path mismatches surfaced here.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/project/map_preview.rs src-tauri/src/main.rs
git commit -m "feat(map-preview): load_map_preview command returning binary geometry payload"
```

---

## Task 7: Rust — `load_map_texture` command (RGBA payload)

**Files:**
- Modify: `src-tauri/src/commands/project/map_preview.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add the texture command**

Reuses `resolve_asset_path` (search starts from the materials bin dir) and the
`decode_full_rgba` helper from Task 1. Add to `map_preview.rs`:

```rust
/// Decode one texture (referenced by a bin texturePath) to raw RGBA.
/// Payload: [u32 width][u32 height][rgba bytes].
#[tauri::command]
pub async fn load_map_texture(
    project_path: String,
    texture_path: String,
) -> Result<tauri::ipc::Response, String> {
    let project = PathBuf::from(&project_path);
    // Resolve relative to the discovered materials bin so the WAD-folder search
    // in resolve_asset_path has the right starting point.
    let source = discover_map_source(&project)?;
    let bin_dir = source
        .materials
        .parent()
        .ok_or("materials bin has no parent dir")?
        .to_string_lossy()
        .to_string();

    let resolved = crate::commands::mesh::resolve_asset_path(texture_path.clone(), bin_dir)
        .await
        .map_err(|e| format!("Could not resolve texture '{texture_path}': {e}"))?;

    let data = std::fs::read(&resolved)
        .map_err(|e| format!("Failed to read texture '{resolved}': {e}"))?;
    let rgba = crate::commands::texture_convert::decode_full_rgba(&data)?;

    let (w, h) = rgba.dimensions();
    let mut out: Vec<u8> = Vec::with_capacity(8 + rgba.as_raw().len());
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    out.extend_from_slice(rgba.as_raw());
    Ok(tauri::ipc::Response::new(out))
}
```

NOTE: confirm the module path `crate::commands::texture_convert` and
`crate::commands::mesh` resolve (they are re-exported through `assets/mod.rs`;
match how other code refers to them — e.g. `commands::mesh::resolve_asset_path`
is already in `main.rs`). Adjust the `crate::commands::...` prefix if needed.

- [ ] **Step 2: Register the command**

In `src-tauri/src/main.rs`, after the `load_map_preview` line add:

```rust
            commands::map_preview::load_map_texture,
```

- [ ] **Step 3: Build**

Run: `cargo build --manifest-path src-tauri/Cargo.toml --lib`
Expected: compiles (the `decode_full_rgba` dead-code warning from Task 1 is gone).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/project/map_preview.rs src-tauri/src/main.rs
git commit -m "feat(map-preview): load_map_texture command returning raw RGBA"
```

---

## Task 8: Rust — `open_map_preview_window` command

**Files:**
- Modify: `src-tauri/src/commands/project/map_preview.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add the window-open command**

Add to `map_preview.rs`:

```rust
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Open (or focus) the separate map-preview window for a project.
#[tauri::command]
pub async fn open_map_preview_window(
    app: tauri::AppHandle,
    project_path: String,
) -> Result<(), String> {
    const LABEL: &str = "map-preview";

    // If it already exists, focus it and tell it to load this project.
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.set_focus();
        let _ = win.emit("map-preview-load", project_path);
        return Ok(());
    }

    let encoded = urlencoding::encode(&project_path);
    let url = format!("index.html#map-preview?project={encoded}");

    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App(url.into()))
        .title("Flint — Map Preview")
        .inner_size(1100.0, 720.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("Failed to open map preview window: {e}"))?;

    Ok(())
}
```

NOTE: `urlencoding` is a common transitive dep; if it's not available, encode
inline (replace spaces with `%20` and `\\`/`/` are safe in the hash) or add the
crate to `src-tauri/Cargo.toml`. Verify `decorations` default — the new window
uses native decorations (we did not set `.decorations(false)`), so it gets a
normal OS title bar. Good for v1.

- [ ] **Step 2: Register the command**

In `src-tauri/src/main.rs`, after the `load_map_texture` line add:

```rust
            commands::map_preview::open_map_preview_window,
```

- [ ] **Step 3: Build**

Run: `cargo build --manifest-path src-tauri/Cargo.toml --lib`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/project/map_preview.rs src-tauri/src/main.rs
git commit -m "feat(map-preview): open_map_preview_window command (separate window)"
```

---

## Task 9: Frontend — API bindings + payload decode

**Files:**
- Create: `src/lib/api/mapPreview.ts`
- Modify: `src/lib/api/index.ts`

- [ ] **Step 1: Write the bindings**

Create `src/lib/api/mapPreview.ts`:

```ts
import { invoke } from '@tauri-apps/api/core';
import { invokeCommand } from './core';
import type { SubmeshRange } from '../babylon/meshBuilder';

export interface MapPreviewData {
    variant: string;
    submeshes: SubmeshRange[];
    /** submesh name -> { diffuse texture path } */
    materials: Record<string, string>;
    bounding_box: [[number, number, number], [number, number, number]];
    positions: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
}

export interface MapTexture {
    width: number;
    height: number;
    rgba: Uint8Array;
}

/** Decode the [u32 meta_len][meta json][pad][positions][uvs][indices] payload. */
function decodeMapPayload(buf: ArrayBuffer): MapPreviewData {
    const view = new DataView(buf);
    const metaLen = view.getUint32(0, true);
    const metaBytes = new Uint8Array(buf, 4, metaLen);
    const meta = JSON.parse(new TextDecoder('utf-8').decode(metaBytes));

    let off = 4 + metaLen;
    if (off % 4 !== 0) off += 4 - (off % 4);

    const vertexCount: number = meta.vertex_count;
    const indexCount: number = meta.index_count;

    const positions = new Float32Array(buf.slice(off, off + vertexCount * 3 * 4));
    off += vertexCount * 3 * 4;
    const uvs = new Float32Array(buf.slice(off, off + vertexCount * 2 * 4));
    off += vertexCount * 2 * 4;
    const indices = new Uint32Array(buf.slice(off, off + indexCount * 4));

    return {
        variant: meta.variant,
        submeshes: meta.submeshes,
        materials: meta.materials,
        bounding_box: meta.bounding_box,
        positions,
        uvs,
        indices,
    };
}

export async function openMapPreviewWindow(projectPath: string): Promise<void> {
    return invokeCommand('open_map_preview_window', { projectPath });
}

export async function loadMapPreview(projectPath: string): Promise<MapPreviewData> {
    const buf = await invoke<ArrayBuffer>('load_map_preview', { projectPath });
    return decodeMapPayload(buf);
}

export async function loadMapTexture(
    projectPath: string,
    texturePath: string,
): Promise<MapTexture> {
    const buf = await invoke<ArrayBuffer>('load_map_texture', { projectPath, texturePath });
    const view = new DataView(buf);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    const rgba = new Uint8Array(buf.slice(8));
    return { width, height, rgba };
}
```

NOTE: `invoke` returns the raw bytes as `ArrayBuffer` for commands returning
`tauri::ipc::Response` (same as `read_skn_mesh` in `mesh.ts`). Confirm
`SubmeshRange` is exported from `meshBuilder.ts` (it is, line 6).

- [ ] **Step 2: Export from the api index**

In `src/lib/api/index.ts`, add alongside the other `export * from './...'` lines:

```ts
export * from './mapPreview';
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors from these files.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api/mapPreview.ts src/lib/api/index.ts
git commit -m "feat(map-preview): frontend API bindings + binary payload decode"
```

---

## Task 10: Frontend — MapPreview renderer + standalone window root

**Files:**
- Create: `src/components/preview/MapPreview.tsx`
- Create: `src/components/preview/MapPreviewWindow.tsx`
- Modify: `src/main.tsx`

- [ ] **Step 1: Write the renderer**

Create `src/components/preview/MapPreview.tsx`. This adapts `ModelPreview.tsx`:
engine created once, try/catch render loop, synchronous dispose, unlit PBR,
camera framing with degenerate-box guard, per-submesh meshes via the
`meshBuilder.ts` contract, lazy RawTexture loading + cache, and live reload via
the `file-changed` event.

```tsx
/**
 * Flint - MapPreview
 * 3D preview of a map project's mapgeo, with textures auto-connected from the
 * materials bin and live reload. Rendered inside the separate map-preview window.
 */
import React, { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Engine as BabylonEngine } from '@babylonjs/core/Engines/engine';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';

import * as api from '../../lib/api';
import { createEngine } from '../../lib/babylon/engine';
import { buildSknMeshes, type MeshDTO } from '../../lib/babylon/meshBuilder';

interface MapPreviewProps {
    projectPath: string;
}

export const MapPreview: React.FC<MapPreviewProps> = ({ projectPath }) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const engineRef = useRef<BabylonEngine | null>(null);
    const sceneRef = useRef<Scene | null>(null);
    const cameraRef = useRef<ArcRotateCamera | null>(null);
    const meshesRef = useRef<Mesh[]>([]);
    const texCacheRef = useRef<Map<string, RawTexture>>(new Map());
    const dataRef = useRef<api.MapPreviewData | null>(null);

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState('');

    // ── Engine once ────────────────────────────────────────────────────────
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const engine = createEngine(canvas);
        engineRef.current = engine;
        const scene = new Scene(engine);
        sceneRef.current = scene;
        scene.clearColor = new Color4(0.106, 0.106, 0.106, 1.0);

        const camera = new ArcRotateCamera('cam', Math.PI / 2, Math.PI / 3, 1000, Vector3.Zero(), scene);
        camera.attachControl(canvas, true);
        camera.wheelDeltaPercentage = 0.05;
        camera.panningSensibility = 20;
        cameraRef.current = camera;

        const light = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene);
        light.intensity = 1.2;
        light.specular = new Color3(0, 0, 0);

        let errs = 0;
        engine.runRenderLoop(() => {
            try { scene.render(); }
            catch (e) { if (++errs <= 5) console.error('[map-render] frame threw:', e); }
        });
        const onResize = () => engine.resize();
        window.addEventListener('resize', onResize);

        return () => {
            window.removeEventListener('resize', onResize);
            texCacheRef.current.forEach(t => t.dispose());
            texCacheRef.current.clear();
            meshesRef.current.forEach(m => { m.material?.dispose(); m.dispose(); });
            meshesRef.current = [];
            engine.dispose();
            engineRef.current = null;
            sceneRef.current = null;
        };
    }, []);

    // ── Build geometry + materials ───────────────────────────────────────────
    const buildScene = React.useCallback(async () => {
        const scene = sceneRef.current, camera = cameraRef.current;
        if (!scene || !camera) return;
        setLoading(true); setError(null);
        try {
            const data = await api.loadMapPreview(projectPath);
            dataRef.current = data;

            // Tear down old meshes (keep texture cache; textures keyed by path).
            meshesRef.current.forEach(m => { m.dispose(); });
            meshesRef.current = [];

            const dto: MeshDTO = {
                positions: data.positions,
                indices: data.indices,
                uvs: data.uvs,
                submeshes: data.submeshes,
                bbox: data.bounding_box,
            };
            const { meshes } = buildSknMeshes(dto, scene);
            meshesRef.current = meshes;

            // Camera framing with degenerate guard.
            let [[minX, minY, minZ], [maxX, maxY, maxZ]] = data.bounding_box;
            const ok = [minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)
                && maxX >= minX && maxY >= minY && maxZ >= minZ;
            if (!ok) { minX = minY = minZ = -1; maxX = maxY = maxZ = 1; }
            const center = new Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
            const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.01) || 5;
            camera.target = center;
            camera.radius = size * 1.5;
            camera.lowerRadiusLimit = size * 0.05;
            camera.upperRadiusLimit = size * 10;
            camera.panningSensibility = 8000 / Math.max(camera.radius, 0.001);

            // Assign materials; lazily load textures.
            setStatus(`${meshes.length} submeshes`);
            for (const mesh of meshes) {
                const mat = new PBRMaterial(mesh.name + '_mat', scene);
                mat.unlit = true; mat.metallic = 0; mat.roughness = 1; mat.environmentIntensity = 0;
                mat.backFaceCulling = false;
                mesh.material = mat;
                const texPath = data.materials[mesh.name];
                if (texPath) void applyTexture(mat, texPath);
                else mat.albedoColor = new Color3(1, 0, 1); // magenta: no material entry
            }
            setLoading(false);
        } catch (e) {
            setError((e as Error).message || 'Failed to load map'); setLoading(false);
        }
    }, [projectPath]);

    const applyTexture = React.useCallback(async (mat: PBRMaterial, texPath: string) => {
        const scene = sceneRef.current;
        if (!scene) return;
        try {
            let tex = texCacheRef.current.get(texPath);
            if (!tex) {
                const { width, height, rgba } = await api.loadMapTexture(projectPath, texPath);
                if (!sceneRef.current) return;
                tex = RawTexture.CreateRGBATexture(rgba, width, height, scene, false, true);
                tex.wrapU = Texture.WRAP_ADDRESSMODE;
                tex.wrapV = Texture.WRAP_ADDRESSMODE;
                texCacheRef.current.set(texPath, tex);
            }
            mat.albedoTexture = tex;
            mat.albedoColor = new Color3(1, 1, 1);
        } catch (e) {
            console.error('[map-tex] failed', texPath, e);
            mat.albedoColor = new Color3(1, 0, 1); // magenta: texture missing
        }
    }, [projectPath]);

    // Initial build + rebuild when project changes.
    useEffect(() => { void buildScene(); }, [buildScene]);

    // ── Live reload via the existing `file-changed` event ────────────────────
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let debounce: ReturnType<typeof setTimeout> | undefined;
        void api.startPreviewWatcher?.(projectPath).catch(() => {});
        listen<{ path: string; kind: string }>('file-changed', (ev) => {
            const p = ev.payload.path.toLowerCase();
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => {
                if (p.endsWith('.mapgeo') || p.endsWith('.materials.bin')) {
                    void buildScene();
                } else if (p.endsWith('.tex') || p.endsWith('.dds')) {
                    // Reload any cached texture whose resolved file changed: simplest
                    // correct approach is to drop the cache entry by basename match
                    // and reassign affected materials.
                    reloadChangedTexture(p);
                }
            }, 150);
        }).then(u => { unlisten = u; });
        return () => { if (debounce) clearTimeout(debounce); unlisten?.(); };
    }, [projectPath, buildScene]);

    const reloadChangedTexture = React.useCallback(async (changedLowerPath: string) => {
        const data = dataRef.current;
        if (!data) return;
        const base = changedLowerPath.split(/[\\/]/).pop() || '';
        // Find material texPaths whose filename matches the changed file.
        for (const [submesh, texPath] of Object.entries(data.materials)) {
            if (!texPath.toLowerCase().endsWith(base)) continue;
            texCacheRef.current.get(texPath)?.dispose();
            texCacheRef.current.delete(texPath);
            const mesh = meshesRef.current.find(m => m.name === submesh);
            if (mesh?.material) await applyTexture(mesh.material as PBRMaterial, texPath);
        }
    }, [applyTexture]);

    return (
        <div style={{ position: 'absolute', inset: 0, background: '#1b1b1b' }}>
            <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', outline: 'none' }} />
            {loading && <div style={overlay}>Loading map…</div>}
            {error && <div style={{ ...overlay, color: '#f88' }}>⚠️ {error}</div>}
            {!loading && !error && <div style={badge}>{status}</div>}
        </div>
    );
};

const overlay: React.CSSProperties = {
    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
    color: '#ddd', font: '14px system-ui', pointerEvents: 'none',
};
const badge: React.CSSProperties = {
    position: 'absolute', bottom: 8, left: 8, color: '#aaa', font: '12px system-ui',
    background: 'rgba(0,0,0,0.4)', padding: '2px 8px', borderRadius: 4, pointerEvents: 'none',
};
```

NOTE: `buildSknMeshes(dto, scene)` is called with no skeleton — it builds plain
meshes and `VertexData.ComputeNormals` handles normals. `MeshDTO.normals` and
`uvs` are optional/required per `meshBuilder.ts`; `uvs` is required and we pass it.
If `startPreviewWatcher` is not exported from the api index, call it via
`invokeCommand('start_preview_watcher', { projectPath })` instead — verify and
adjust (it exists as a Rust command).

- [ ] **Step 2: Write the window root**

Create `src/components/preview/MapPreviewWindow.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { MapPreview } from './MapPreview';

/** Parse ?project=... from the location hash (#map-preview?project=...). */
function projectFromHash(): string {
    const hash = window.location.hash; // "#map-preview?project=..."
    const q = hash.indexOf('?');
    if (q < 0) return '';
    const params = new URLSearchParams(hash.slice(q + 1));
    return params.get('project') || '';
}

export const MapPreviewWindow: React.FC = () => {
    const [project, setProject] = useState<string>(() => projectFromHash());

    // The Rust side emits "map-preview-load" when the window is reused.
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        listen<string>('map-preview-load', (ev) => setProject(ev.payload))
            .then(u => { unlisten = u; });
        return () => unlisten?.();
    }, []);

    if (!project) {
        return <div style={{ color: '#ddd', padding: 24, font: '14px system-ui' }}>
            No project specified for map preview.
        </div>;
    }
    return <MapPreview key={project} projectPath={project} />;
};
```

- [ ] **Step 3: Branch in main.tsx**

In `src/main.tsx`, add the import near the `DesignLab` import:

```ts
import { MapPreviewWindow } from './components/preview/MapPreviewWindow';
```

Add a detection const next to `isDesignLab` (after line ~64):

```ts
const isMapPreview =
    typeof window !== 'undefined' && window.location.hash.startsWith('#map-preview');
```

Change the `root.render(...)` call so map-preview mounts its own root (mirrors the
design-lab branch). Replace the existing ternary in `root.render` with:

```ts
root.render(
    isMapPreview
        ? React.createElement(React.StrictMode, null, React.createElement(MapPreviewWindow))
        : isDesignLab
            ? React.createElement(React.StrictMode, null, React.createElement(DesignLab))
            : React.createElement(
                  React.StrictMode,
                  null,
                  React.createElement(AppProvider, null, React.createElement(App))
              )
);
```

Also guard the backend log listener so it still attaches for the preview window
(it's fine to attach; change `if (!isDesignLab)` to `if (!isDesignLab && !isMapPreview)`
ONLY if the listener causes noise — otherwise leave it attaching, the preview
benefits from logs). Default: leave `initBackendLogListener()` attaching.

- [ ] **Step 4: Type-check + build the frontend**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/preview/MapPreview.tsx src/components/preview/MapPreviewWindow.tsx src/main.tsx
git commit -m "feat(map-preview): Babylon renderer + standalone preview window root"
```

---

## Task 11: Frontend — "Preview Map" button entry point

**Files:**
- Modify: the map project view. Likely `src/components/editor/PreviewPanel.tsx`
  (info-bar) OR a project header/toolbar. Implementer: locate where a map
  project's main view renders and add the button there. A reliable, low-risk
  home is the `PreviewPanel` toolbar when the active project `kind === 'map'`.

- [ ] **Step 1: Find the active project kind in the chosen component**

Search for where the active project/tab exposes `kind` / `map_id`:

Run: `rg "kind === 'map'|map_id|activeTab|projectPath" src/components/editor/PreviewPanel.tsx src/components/layout`
Identify the component that always renders for a map project and has access to
`projectPath`.

- [ ] **Step 2: Add the button**

In the chosen component, import the api and render a button that calls
`openMapPreviewWindow(projectPath)`. Example for the `PreviewPanel` toolbar
(add near the `preview-panel__filename` span, gated on map projects):

```tsx
// at top: import * as api from '../../lib/api';  (already imported in PreviewPanel)
// Render where appropriate:
<button
    className="btn btn--sm"
    title="Open 3D map preview in a separate window"
    onClick={async () => {
        try { await api.openMapPreviewWindow(projectPath); }
        catch (e) { console.error('open map preview failed', e); }
    }}
>
    <span dangerouslySetInnerHTML={{ __html: getIcon('image') }} />
    <span>Preview Map</span>
</button>
```

Gate it so it only shows for map projects. If the component has the project
`kind`, wrap with `{projectKind === 'map' && (...)}`. If only `projectPath` is
available, a cheap check is to read flint.json kind via an existing project API,
or always show it and let the Rust command return a clear error for non-map
projects. Prefer gating on `kind === 'map'` if available.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(map-preview): add Preview Map button for map projects"
```

---

## Task 12: Manual verification (the real proof)

**Files:** none (run the app).

- [ ] **Step 1: Launch**

Run: `npm run tauri dev`
Expected: app builds (first Rust build is slow) and launches.

- [ ] **Step 2: Open the nightmap project and click Preview Map**

Open project `nightmap`. Click "Preview Map".
Expected: a SEPARATE OS window titled "Flint — Map Preview" opens.

- [ ] **Step 3: Confirm geometry + textures**

Expected in the new window: the map geometry renders; orbit/pan/zoom work; most
submeshes show real textures (not all magenta). The bottom-left badge shows a
submesh count. If geometry is mirrored/inside-out, adjust the coordinate handling
in `decode_geometry` (negate X on positions, as the SKN backend does) — this is
the documented verify-at-implementation item; fix and re-run.

- [ ] **Step 4: Confirm live reload**

In the MAIN window, recolor or replace one of the map's textures (e.g. via the
recolor flow, or replace a `.tex`/`.dds` under the mapgeometry/asset folder).
Expected: within a moment, the preview window updates that texture without a
manual refresh.

- [ ] **Step 5: Confirm window reuse**

With the preview open, click "Preview Map" again.
Expected: the existing window focuses (no duplicate window).

- [ ] **Step 6: Final commit (if any tweaks were made)**

```bash
git add -A
git commit -m "fix(map-preview): coordinate/orientation + verification tweaks"
```

---

## Self-review notes (addressed)

- **Spec coverage:** window-open (T8/T10), discovery/no-flint.json-change (T2/T3),
  submesh→texture chain (T4), geometry decode (T5), RGBA textures (T1/T7), lazy +
  cached textures (T10), live reload via existing watcher/event (T10), error→magenta
  + overlays (T10), separate-window mounting via hash (T10), button entry (T11),
  manual verification incl. orientation (T12). All spec sections map to a task.
- **Types:** `SubmeshRange` shared between Rust (`#[derive(Serialize)]`) and TS
  (`meshBuilder.ts`); `MapPreviewData`/`MapTexture` defined once in `mapPreview.ts`
  and consumed in `MapPreview.tsx`. Payload byte layout identical on both sides.
- **Risk flagged honestly:** ritoshark re-export paths and mapgeo orientation are
  the two verify-at-build/verify-visually items, called out at their tasks rather
  than assumed.
