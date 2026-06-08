# Ground-Tile PSD Stitcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two buttons in the Map Preview window: "Combine ground → PSD" builds one layered PSD (5×5 grid, variant/stage pits as hidden groups) from the open project's ground tiles; "Apply PSD → textures" writes each PSD layer back to its `.tex` by layer name. Never touches the bin.

**Architecture:** Rust discovers ground `.tex` tiles in the open project, decodes them to RGBA (existing `decode_full_rgba`), places each by its grid-cell name into a big canvas, and writes a minimal hand-rolled PSD (RGBA8, RAW channels, layer groups via `lsct`) ported from ag-psd. Apply reads the PSD layers (the `psd` crate), and re-encodes each named layer's pixels back into its source `.tex` format (existing `Texture::encode` path).

**Tech Stack:** Rust (Tauri 2, `ritoshark::tex`, `image`), the `psd` crate (read), a new in-house `psd_write` module, TypeScript/React.

**Specs:** `docs/superpowers/specs/2026-06-08-ground-tile-psd-stitcher-design.md` + the ag-psd port research (in this conversation).

---

## Key facts the implementer must know

- **Ground tiles are a complete 5×5 grid.** Names: `ground_<col><row>_...tex`, col ∈ a–e, row ∈ 1–5, each 2048×2048. Canvas = 10240×10240. Overlap cells: **B2** (baronpit: default + tunnel/upgraded/walled) and **D4** (dragonpit: default + chemtech/cloud/earth/fire/ocean). Verified in the current SRX project.
- **Texture location:** `content/<layer>/<wad>/assets/maps/kitpieces/<...>/textures/`. Discover under the open project, same as the preview.
- **Decode:** `crate::commands::texture_convert::decode_full_rgba(&bytes) -> image::RgbaImage` (BC1 alpha fix included).
- **Encode (save-back):** mirror `convert_dds_to_tex` (`texture_convert.rs:159-225`): read the ORIGINAL `.tex` to learn its `ritoshark::tex::TexFormat`, then `Texture::encode(&rgba, fmt, false)` (or `Texture::from_rgba_bgra8(&rgba)` for `Bgra8`), `.to_bytes()`, and patch byte 8 (`0x01` for BC1/BC3, else `0x00`). Keeps each tile's original format.
- **PSD WRITE format (ported from ag-psd)** — big-endian; minimal RGBA8 + groups + RAW:
  - Header(26): `8BPS`, u16 ver=1, 6×0, u16 channels=4, u32 H, u32 W, u16 depth=8, u16 colorMode=3.
  - ColorModeData: u32 len=0. ImageResources: u32 len=0.
  - LayerAndMask = section(round2): [LayerInfo section(round4, lengthInclPad)] + [GlobalLayerMaskInfo u32=0] + pad2.
  - LayerInfo: `i16 -N` (negative = has alpha), then N layer records (bottom-to-top), then channel image data.
  - **Channel order per layer: A,R,G,B = ids `-1,0,1,2`.** Each channel-info `length = 2 + W*H` (RAW: u16 compression=0 + W*H bytes). Divider/marker layers: 4 channels, each `length=2`, no bytes.
  - Layer record: rect(4×i32) | channelCount u16 | per-chan(id i16, len u32) | `8BIM` | blendKey 4 (`norm`) | opacity u8(255) | clipping u8(0) | flags u8 | filler u8(0) | extra-section(round1){ maskInfo u32=0, blendRanges u32=0, pascalName(pad4), additionalInfo }.
  - **flags:** visible leaf=`0x08`; hidden=`|0x02`; group divider/marker=`|0x10`.
  - **Groups (lsct):** a group expands to, bottom→top: `</Layer group>` bounding divider (lsct type **3**, body 4B = u32 type) → the group's children → named folder marker (lsct type **1** open, body 16B = u32 type + `8BIM` + `pass` + u32 subType=0). Children between them.
  - **additionalInfo blocks** (each: `8BIM` + key + section): `luni` (round4, lengthInclPad) = u32 charCount + UTF-16BE chars (no null); `lsct` (round2) as above. Leaf layer → just `luni`. Folder marker → `luni` + `lsct`(type1). Bounding divider (name `</Layer group>`) → `luni` + `lsct`(type3).
  - Channel image data: after all records, per layer per channel: u16 compression=0 [+ W*H raw bytes for real tiles].
  - Composite (to EOF): u16 compression=0, then R,G,B,A planes each W*H (use the flattened visible composite, or solid is structurally valid).
  - Padding: pascalName→mult 4; layerInfo→mult4 (len incl pad); luni→mult4; lsct→mult2; layer-and-mask→mult2.
- **PSD READ (apply):** use the `psd` crate (`chinedufn/psd`) — add `psd = "0.3"` to `src-tauri/Cargo.toml` (verify latest at impl time). It exposes per-layer `name()`, bounds (`layer_top/left/bottom/right`), and `rgba()` pixels. If a chosen version lacks group-aware traversal we don't care — apply only needs flat layers by name.

## File structure

**Rust (new):**
- `src-tauri/src/commands/project/map_tiles.rs` — discovery, combine/apply commands, ground classification.
- `src-tauri/src/core/psd_write.rs` (or `commands/project/psd_write.rs`) — the minimal PSD writer.

**Rust (modified):**
- `src-tauri/src/commands/project/mod.rs` — `pub mod map_tiles;`
- `src-tauri/src/commands/mod.rs` — re-export `map_tiles`.
- `src-tauri/src/main.rs` — register the two commands.
- `src-tauri/Cargo.toml` — add `psd` (read) dep.

**Frontend (modified):**
- `src/lib/api/mapPreview.ts` — `combineGroundToPsd`, `applyPsdToTextures` bindings.
- `src/components/preview/MapPreview.tsx` — two buttons + result toasts.

---

## Task 1: PSD writer module — header + sections scaffold

**Files:**
- Create: `src-tauri/src/core/psd_write.rs`
- Modify: `src-tauri/src/core/mod.rs` (add `pub mod psd_write;`)

- [ ] **Step 1: Create the module with the public types + big-endian helpers**

Create `src-tauri/src/core/psd_write.rs`:

```rust
//! Minimal Adobe PSD writer: 8-bit RGBA layers organised into groups, RAW
//! (uncompressed) channel data. Ported from ag-psd's write path (see the
//! ground-tile stitcher plan). Big-endian throughout. Only what we emit is
//! implemented — no masks, effects, text, RLE.

use image::RgbaImage;

/// A single image layer placed at (x, y) on the canvas.
pub struct PsdLayer {
    pub name: String,
    pub x: u32,
    pub y: u32,
    pub image: RgbaImage,
    pub visible: bool,
}

/// A group (folder) of layers. Groups are not nested in this writer.
pub struct PsdGroup {
    pub name: String,
    pub visible: bool,
    pub layers: Vec<PsdLayer>,
}

/// The document: canvas size + a flat list of top-level groups (and loose
/// layers via a group with empty name if ever needed).
pub struct PsdDoc {
    pub width: u32,
    pub height: u32,
    pub groups: Vec<PsdGroup>,
}

fn w_u16(out: &mut Vec<u8>, v: u16) { out.extend_from_slice(&v.to_be_bytes()); }
fn w_u32(out: &mut Vec<u8>, v: u32) { out.extend_from_slice(&v.to_be_bytes()); }
fn w_i16(out: &mut Vec<u8>, v: i16) { out.extend_from_slice(&v.to_be_bytes()); }
fn w_i32(out: &mut Vec<u8>, v: i32) { out.extend_from_slice(&v.to_be_bytes()); }
fn w_sig(out: &mut Vec<u8>, s: &[u8; 4]) { out.extend_from_slice(s); }

/// Pascal string: 1-byte len + ASCII bytes, then zero-pad so total len
/// (including the length byte) is a multiple of `pad_to`.
fn w_pascal(out: &mut Vec<u8>, s: &str, pad_to: usize) {
    let bytes: Vec<u8> = s.bytes().take(255).map(|b| if b < 128 { b } else { b'?' }).collect();
    out.push(bytes.len() as u8);
    out.extend_from_slice(&bytes);
    let mut total = 1 + bytes.len();
    while total % pad_to != 0 { out.push(0); total += 1; }
}

/// UTF-16 BE string with a u32 char-count prefix, no null terminator.
fn w_unicode(out: &mut Vec<u8>, s: &str) {
    let units: Vec<u16> = s.encode_utf16().collect();
    w_u32(out, units.len() as u32);
    for u in units { w_u16(out, u); }
}

/// Write a length-prefixed section: reserve u32, run `body`, optionally pad the
/// body to `round`, then back-patch. `len_incl_pad` controls whether the
/// patched length counts the padding (matches ag-psd's writeTotalLength).
fn w_section(out: &mut Vec<u8>, round: usize, len_incl_pad: bool, body: impl FnOnce(&mut Vec<u8>)) {
    let len_pos = out.len();
    w_u32(out, 0);
    let start = out.len();
    body(out);
    let mut body_len = out.len() - start;
    let unpadded = body_len;
    while body_len % round != 0 { out.push(0); body_len += 1; }
    let patched = if len_incl_pad { body_len } else { unpadded } as u32;
    out[len_pos..len_pos + 4].copy_from_slice(&patched.to_be_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pascal_pads_to_4() {
        let mut o = Vec::new();
        w_pascal(&mut o, "ab", 4); // 1 len + 2 + pad -> 4
        assert_eq!(o.len(), 4);
        assert_eq!(o[0], 2);
    }
    #[test]
    fn unicode_be_count() {
        let mut o = Vec::new();
        w_unicode(&mut o, "Hi");
        assert_eq!(&o[0..4], &[0, 0, 0, 2]); // count = 2
        assert_eq!(&o[4..8], &[0, b'H', 0, b'i']);
    }
}
```

- [ ] **Step 2: Wire the module**

In `src-tauri/src/core/mod.rs`, add `pub mod psd_write;` (place alphabetically with the other `pub mod`s).

- [ ] **Step 3: Test**

Run: `cargo test --manifest-path src-tauri/Cargo.toml psd_write -- --nocapture`
Expected: `pascal_pads_to_4` + `unicode_be_count` PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/core/psd_write.rs src-tauri/src/core/mod.rs
git commit -m "feat(psd): minimal PSD writer scaffold (helpers + section writer)"
```

---

## Task 2: PSD writer — assemble a full document (layers + groups + RAW channels)

**Files:**
- Modify: `src-tauri/src/core/psd_write.rs`

- [ ] **Step 1: Add the channel-plane extractor + a flattened-layer model**

Add to `psd_write.rs` (above `mod tests`):

```rust
/// One layer as it appears in the file (groups are flattened into divider
/// markers). RAW channel data is built lazily during write.
struct FileLayer<'a> {
    name: String,
    x: u32, y: u32,
    img: Option<&'a RgbaImage>, // None for divider/marker layers
    visible: bool,
    lsct: Option<u32>,          // section divider type: 1 open, 2 closed, 3 bounding
    lsct_has_key: bool,         // folder markers carry 8BIM+'pass'+subType
}

/// Extract one 8-bit plane (offset 0=R,1=G,2=B,3=A) from an RGBA image, row-major.
fn plane(img: &RgbaImage, offset: usize) -> Vec<u8> {
    let raw = img.as_raw(); // RGBA8 interleaved
    let mut out = Vec::with_capacity((img.width() * img.height()) as usize);
    let mut i = offset;
    while i < raw.len() { out.push(raw[i]); i += 4; }
    out
}
```

- [ ] **Step 2: Flatten groups → bottom-to-top FileLayer list**

Add:

```rust
/// Flatten the document's groups into the bottom-to-top file order ag-psd uses:
/// for each group -> [bounding divider (lsct 3)] ++ children ++ [folder marker (lsct 1/2)].
fn flatten<'a>(doc: &'a PsdDoc) -> Vec<FileLayer<'a>> {
    let mut out = Vec::new();
    for g in &doc.groups {
        // bottom sentinel
        out.push(FileLayer {
            name: "</Layer group>".into(), x: 0, y: 0, img: None,
            visible: true, lsct: Some(3), lsct_has_key: false,
        });
        // children, bottom-to-top == vec order
        for l in &g.layers {
            out.push(FileLayer {
                name: l.name.clone(), x: l.x, y: l.y, img: Some(&l.image),
                visible: l.visible, lsct: None, lsct_has_key: false,
            });
        }
        // top sentinel (named folder marker, open=1)
        out.push(FileLayer {
            name: g.name.clone(), x: 0, y: 0, img: None,
            visible: g.visible, lsct: Some(1), lsct_has_key: true,
        });
    }
    out
}
```

- [ ] **Step 3: Write one layer record + collect its channels**

Add the per-layer record writer and the additional-info writer:

```rust
/// Channels for a layer in (id, data) order: A,R,G,B = -1,0,1,2.
/// Divider/marker layers (img None) emit 4 empty channels (length 2 each).
fn layer_channels(fl: &FileLayer) -> Vec<(i16, Option<Vec<u8>>)> {
    match fl.img {
        Some(img) => vec![
            (-1, Some(plane(img, 3))),
            (0, Some(plane(img, 0))),
            (1, Some(plane(img, 1))),
            (2, Some(plane(img, 2))),
        ],
        None => vec![(-1, None), (0, None), (1, None), (2, None)],
    }
}

fn w_additional_info(out: &mut Vec<u8>, fl: &FileLayer) {
    // luni (round 4, length incl pad): unicode name
    w_sig(out, b"8BIM");
    w_sig(out, b"luni");
    w_section(out, 4, true, |o| w_unicode(o, &fl.name));
    // lsct (round 2) if this is a divider/marker
    if let Some(t) = fl.lsct {
        w_sig(out, b"8BIM");
        w_sig(out, b"lsct");
        w_section(out, 2, true, |o| {
            w_u32(o, t);
            if fl.lsct_has_key {
                w_sig(o, b"8BIM");
                w_sig(o, b"pass"); // pass-through blend for the folder
                w_u32(o, 0);       // subType
            }
        });
    }
}

fn w_layer_record(out: &mut Vec<u8>, fl: &FileLayer, chans: &[(i16, Option<Vec<u8>>)], w: u32, h: u32) {
    let (top, left, bottom, right) = match fl.img {
        Some(img) => (fl.y as i32, fl.x as i32, (fl.y + img.height()) as i32, (fl.x + img.width()) as i32),
        None => (0, 0, 0, 0),
    };
    w_i32(out, top); w_i32(out, left); w_i32(out, bottom); w_i32(out, right);
    w_u16(out, chans.len() as u16);
    for (id, data) in chans {
        w_i16(out, *id);
        let len = 2 + data.as_ref().map(|d| d.len()).unwrap_or(0);
        w_u32(out, len as u32);
    }
    w_sig(out, b"8BIM");
    w_sig(out, b"norm");
    out.push(255); // opacity
    out.push(0);   // clipping
    let mut flags = 0x08u8;            // bit3 mandatory
    if !fl.visible { flags |= 0x02; }  // hidden
    if fl.lsct.is_some() { flags |= 0x10; } // divider/marker: pixel data irrelevant
    out.push(flags);
    out.push(0);   // filler
    // extra-data section (round 1)
    w_section(out, 1, true, |o| {
        w_u32(o, 0); // layer mask data: none
        w_u32(o, 0); // blending ranges: none
        w_pascal(o, &fl.name, 4);
        w_additional_info(o, fl);
    });
    let _ = (w, h); // (kept for signature symmetry; rect uses image dims)
}
```

- [ ] **Step 4: Top-level `write_psd`**

Add:

```rust
/// Serialize the document to PSD bytes.
pub fn write_psd(doc: &PsdDoc) -> Vec<u8> {
    let (w, h) = (doc.width, doc.height);
    let flat = flatten(doc);
    // Precompute channels once (also reused for the channel-data block).
    let all_chans: Vec<Vec<(i16, Option<Vec<u8>>)>> = flat.iter().map(layer_channels).collect();

    let mut out = Vec::new();
    // Header
    w_sig(&mut out, b"8BPS");
    w_u16(&mut out, 1);            // version
    out.extend_from_slice(&[0u8; 6]);
    w_u16(&mut out, 4);            // channels
    w_u32(&mut out, h);
    w_u32(&mut out, w);
    w_u16(&mut out, 8);            // depth
    w_u16(&mut out, 3);            // RGB
    // Color mode data
    w_u32(&mut out, 0);
    // Image resources
    w_u32(&mut out, 0);
    // Layer and mask section (round 2)
    w_section(&mut out, 2, false, |lm| {
        // Layer info section (round 4, length incl pad)
        w_section(lm, 4, true, |li| {
            w_i16(li, -(flat.len() as i16)); // negative: has alpha
            for (fl, chans) in flat.iter().zip(all_chans.iter()) {
                w_layer_record(li, fl, chans, w, h);
            }
            // channel image data
            for chans in all_chans.iter() {
                for (_id, data) in chans {
                    w_u16(li, 0); // RAW
                    if let Some(d) = data { li.extend_from_slice(d); }
                }
            }
        });
        // Global layer mask info
        w_u32(lm, 0);
    });
    // Composite image data (to EOF): RAW, R,G,B,A planes. Use a blank/flattened
    // composite — a transparent canvas is structurally valid and avoids a
    // separate flatten pass. (Editors regenerate the composite anyway.)
    w_u16(&mut out, 0); // RAW
    let blank = vec![0u8; (w * h) as usize];
    for _ in 0..4 { out.extend_from_slice(&blank); }
    out
}
```

- [ ] **Step 5: Compile**

Run: `cargo build --manifest-path src-tauri/Cargo.toml --lib`
Expected: builds (warnings about unused `w`/`h` ok).

- [ ] **Step 6: Round-trip test (write → read back with the `psd` crate)**

First add the read dep — in `src-tauri/Cargo.toml` `[dependencies]` add:

```toml
psd = "0.3"
```

(Verify the latest version with `cargo add psd --manifest-path src-tauri/Cargo.toml --dry-run` first; adjust.)

Add a test to `psd_write.rs`'s `mod tests`:

```rust
    #[test]
    fn roundtrip_two_layers_one_group() {
        use image::{Rgba, RgbaImage};
        let mut a = RgbaImage::new(4, 4);
        for p in a.pixels_mut() { *p = Rgba([10, 20, 30, 255]); }
        let mut b = RgbaImage::new(4, 4);
        for p in b.pixels_mut() { *p = Rgba([40, 50, 60, 128]); }
        let doc = PsdDoc {
            width: 4, height: 4,
            groups: vec![PsdGroup {
                name: "Base".into(), visible: true,
                layers: vec![
                    PsdLayer { name: "tileA".into(), x: 0, y: 0, image: a, visible: true },
                    PsdLayer { name: "tileB".into(), x: 0, y: 0, image: b, visible: false },
                ],
            }],
        };
        let bytes = write_psd(&doc);
        std::fs::write(std::env::temp_dir().join("flint_psd_rt.psd"), &bytes).unwrap();

        let parsed = psd::Psd::from_bytes(&bytes).expect("psd parses");
        assert_eq!(parsed.width(), 4);
        assert_eq!(parsed.height(), 4);
        let names: Vec<String> = parsed.layers().iter().map(|l| l.name().to_string()).collect();
        assert!(names.iter().any(|n| n == "tileA"), "layers: {names:?}");
        assert!(names.iter().any(|n| n == "tileB"), "layers: {names:?}");
    }
```

- [ ] **Step 7: Run the round-trip**

Run: `cargo test --manifest-path src-tauri/Cargo.toml psd_write::tests::roundtrip -- --nocapture`
Expected: PASS — the `psd` crate parses our bytes and finds tileA/tileB. If it fails, inspect the panic; the most likely culprit is a section length (re-check `len_incl_pad` on layer-info vs layer-and-mask). Also manually open `%TEMP%/flint_psd_rt.psd` in GIMP once to confirm groups+visibility.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/core/psd_write.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(psd): write grouped RGBA PSD (RAW), round-trip verified via psd crate"
```

---

## Task 3: Ground discovery + classification

**Files:**
- Create: `src-tauri/src/commands/project/map_tiles.rs`
- Modify: `src-tauri/src/commands/project/mod.rs`, `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Register module**

In `commands/project/mod.rs` add `pub mod map_tiles;`. In `commands/mod.rs` add `map_tiles` to the `pub use project::{...}` re-export list.

- [ ] **Step 2: Discovery + grid/variant classification with tests**

Create `map_tiles.rs`:

```rust
//! Ground-tile PSD stitcher: combine the open map project's ground textures
//! into one layered PSD and apply an edited PSD back to the .tex files.
//! Texture-only — never touches the bin (bin edits crash maps).

use std::path::{Path, PathBuf};

/// Grid columns a..e -> 0..4.
fn col_index(c: char) -> Option<u32> {
    match c.to_ascii_lowercase() { 'a'..='e' => Some(c.to_ascii_lowercase() as u32 - 'a' as u32), _ => None }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TileGroup {
    Base,
    DragonElement(String), // "Chemtech","Cloud","Mountain"(earth),"Infernal"(fire),"Ocean"
    BaronStage(String),    // "Tunnel","Upgraded","Walled"
}

#[derive(Debug, Clone)]
pub struct GroundTile {
    pub stem: String,    // filename without extension (round-trip key)
    pub path: PathBuf,
    pub col: u32,        // 0..4
    pub row: u32,        // 0..4
    pub group: TileGroup,
}

/// Parse a ground texture filename into a GroundTile, or None if not a ground tile.
fn classify(path: &Path) -> Option<GroundTile> {
    let fname = path.file_name()?.to_str()?;
    let lower = fname.to_lowercase();
    if !lower.ends_with(".tex") { return None; }
    let stem = &lower[..lower.len() - 4];
    // must start "ground_<col><row>_"
    let rest = stem.strip_prefix("ground_")?;
    let bytes = rest.as_bytes();
    if bytes.len() < 2 { return None; }
    let col = col_index(bytes[0] as char)?;
    let row_char = bytes[1] as char;
    if !('1'..='5').contains(&row_char) { return None; }
    let row = row_char as u32 - '1' as u32;

    let group = if lower.contains("dragonpit_chemtech") { TileGroup::DragonElement("Chemtech".into()) }
        else if lower.contains("dragonpit_cloud")  { TileGroup::DragonElement("Cloud".into()) }
        else if lower.contains("dragonpit_earth")  { TileGroup::DragonElement("Mountain".into()) }
        else if lower.contains("dragonpit_fire")   { TileGroup::DragonElement("Infernal".into()) }
        else if lower.contains("dragonpit_ocean")  { TileGroup::DragonElement("Ocean".into()) }
        else if lower.contains("baronpit_tunnel")  { TileGroup::BaronStage("Tunnel".into()) }
        else if lower.contains("baronpit_upgraded"){ TileGroup::BaronStage("Upgraded".into()) }
        else if lower.contains("baronpit_walled")  { TileGroup::BaronStage("Walled".into()) }
        else { TileGroup::Base };

    Some(GroundTile { stem: stem.to_string(), path: path.to_path_buf(), col, row, group })
}

/// Find all ground tiles under the project's content tree.
pub fn find_ground_tiles(project_path: &Path) -> Vec<GroundTile> {
    let mut out = Vec::new();
    let content = project_path.join("content");
    for entry in walkdir::WalkDir::new(&content).into_iter().flatten() {
        if entry.file_type().is_file() {
            let p = entry.path();
            // only the kitpieces .../textures dirs hold ground_ tiles, but classify() guards anyway
            if let Some(t) = classify(p) { out.push(t); }
        }
    }
    out.sort_by(|a, b| a.stem.cmp(&b.stem));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    fn t(name: &str) -> Option<GroundTile> { classify(&PathBuf::from(name)) }

    #[test]
    fn classifies_base_grid_cell() {
        let g = t("ground_a1_alcovetop_a.tex").unwrap();
        assert_eq!((g.col, g.row), (0, 0));
        assert_eq!(g.group, TileGroup::Base);
    }
    #[test]
    fn classifies_dragon_element() {
        let g = t("ground_d4_dragonpit_fire_a.tex").unwrap();
        assert_eq!((g.col, g.row), (3, 3));
        assert_eq!(g.group, TileGroup::DragonElement("Infernal".into()));
    }
    #[test]
    fn classifies_baron_stage() {
        let g = t("ground_b2_baronpit_walled_a.tex").unwrap();
        assert_eq!((g.col, g.row), (1, 1));
        assert_eq!(g.group, TileGroup::BaronStage("Walled".into()));
    }
    #[test]
    fn rejects_non_ground() {
        assert!(t("chaos_base_a_1bitalpha.tex").is_none());
        assert!(t("ground_z9_foo.tex").is_none());
    }
}
```

NOTE: `walkdir` is already a dependency (used elsewhere); confirm with `grep walkdir src-tauri/Cargo.toml`.

- [ ] **Step 3: Test**

Run: `cargo test --manifest-path src-tauri/Cargo.toml map_tiles -- --nocapture`
Expected: 4 PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/project/map_tiles.rs src-tauri/src/commands/project/mod.rs src-tauri/src/commands/mod.rs
git commit -m "feat(map-tiles): ground tile discovery + grid/variant classification"
```

---

## Task 4: combine_ground_to_psd command

**Files:**
- Modify: `src-tauri/src/commands/project/map_tiles.rs`, `src-tauri/src/main.rs`

- [ ] **Step 1: Add the combine command**

Append to `map_tiles.rs`:

```rust
use crate::core::psd_write::{write_psd, PsdDoc, PsdGroup, PsdLayer};

const TILE: u32 = 2048;
const GRID: u32 = 5;

/// Combine the open project's ground tiles into one layered PSD next to the
/// project (`ground_map.psd`). Returns the written path.
#[tauri::command]
pub async fn combine_ground_to_psd(project_path: String) -> Result<String, String> {
    let project = PathBuf::from(&project_path);
    let tiles = find_ground_tiles(&project);
    if tiles.is_empty() {
        return Err("No ground tiles (ground_*.tex) found in this project".into());
    }

    // Decode + place each tile.
    let mut base = Vec::new();
    let mut dragon: std::collections::BTreeMap<String, Vec<PsdLayer>> = Default::default();
    let mut baron: std::collections::BTreeMap<String, Vec<PsdLayer>> = Default::default();

    for t in &tiles {
        let bytes = std::fs::read(&t.path).map_err(|e| format!("read {}: {e}", t.stem))?;
        let img = crate::commands::texture_convert::decode_full_rgba(&bytes)?;
        let layer = PsdLayer {
            name: t.stem.clone(),
            x: t.col * TILE,
            y: t.row * TILE,
            image: img,
            visible: true,
        };
        match &t.group {
            TileGroup::Base => base.push(layer),
            TileGroup::DragonElement(e) => dragon.entry(e.clone()).or_default().push(layer),
            TileGroup::BaronStage(s) => baron.entry(s.clone()).or_default().push(layer),
        }
    }

    let mut groups = vec![PsdGroup { name: "Base".into(), visible: true, layers: base }];
    for (e, layers) in dragon { groups.push(PsdGroup { name: format!("DragonPit · {e}"), visible: false, layers }); }
    for (s, layers) in baron { groups.push(PsdGroup { name: format!("BaronPit · {s}"), visible: false, layers }); }

    let doc = PsdDoc { width: GRID * TILE, height: GRID * TILE, groups };
    let bytes = write_psd(&doc);
    let out = project.join("ground_map.psd");
    std::fs::write(&out, &bytes).map_err(|e| format!("write psd: {e}"))?;
    Ok(out.to_string_lossy().into_owned())
}
```

- [ ] **Step 2: Register**

In `main.rs` `generate_handler![...]` add `commands::map_tiles::combine_ground_to_psd,`.

- [ ] **Step 3: Build**

Run: `cargo build --manifest-path src-tauri/Cargo.toml --lib`
Expected: builds.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/project/map_tiles.rs src-tauri/src/main.rs
git commit -m "feat(map-tiles): combine_ground_to_psd command"
```

---

## Task 5: apply_psd_to_textures command

**Files:**
- Modify: `src-tauri/src/commands/project/map_tiles.rs`, `src-tauri/src/main.rs`

- [ ] **Step 1: Add the apply command (read PSD, re-encode layers to .tex)**

Append to `map_tiles.rs`:

```rust
use ritoshark::tex::{TexFormat, Texture};
use ritoshark::prelude::Serialize as _;

#[derive(serde::Serialize)]
pub struct ApplyReport {
    pub written: u32,
    pub skipped: Vec<String>,
    pub errors: Vec<String>,
}

/// Re-encode an edited RGBA tile into the SAME format as the original .tex and
/// overwrite it (mirrors convert_dds_to_tex's format-matching + byte-8 patch).
fn write_tile_tex(orig: &Path, rgba: &image::RgbaImage) -> Result<(), String> {
    let orig_bytes = std::fs::read(orig).map_err(|e| format!("read orig: {e}"))?;
    let fmt = Texture::from_bytes(&orig_bytes)
        .map_err(|e| format!("parse orig tex: {:?}", e))?
        .format;
    let new_tex = match fmt {
        TexFormat::Bgra8 => Texture::from_rgba_bgra8(rgba),
        _ => Texture::encode(rgba, fmt, false).map_err(|e| format!("encode: {:?}", e))?,
    };
    let mut bytes = new_tex.to_bytes().map_err(|e| format!("to_bytes: {:?}", e))?;
    if bytes.len() >= 9 {
        bytes[8] = match fmt { TexFormat::Bc1 | TexFormat::Bc3 => 0x01, _ => 0x00 };
    }
    std::fs::write(orig, &bytes).map_err(|e| format!("write tex: {e}"))?;
    Ok(())
}

/// Apply an edited PSD back to the project's ground .tex files, matching PSD
/// layers to tiles by layer name (== tile stem).
#[tauri::command]
pub async fn apply_psd_to_textures(project_path: String, psd_path: String) -> Result<ApplyReport, String> {
    let project = PathBuf::from(&project_path);
    let tiles = find_ground_tiles(&project);
    // index tiles by stem
    let by_stem: std::collections::HashMap<String, PathBuf> =
        tiles.into_iter().map(|t| (t.stem, t.path)).collect();

    let psd_bytes = std::fs::read(&psd_path).map_err(|e| format!("read psd: {e}"))?;
    let psd = psd::Psd::from_bytes(&psd_bytes).map_err(|e| format!("parse psd: {:?}", e))?;

    let (pw, ph) = (psd.width(), psd.height());
    let mut report = ApplyReport { written: 0, skipped: vec![], errors: vec![] };

    for layer in psd.layers() {
        let name = layer.name().to_string();
        // skip group markers / dividers
        if name == "</Layer group>" { continue; }
        let Some(orig) = by_stem.get(&name) else { report.skipped.push(name); continue; };

        // The psd crate gives whole-canvas RGBA for the layer; crop to the
        // layer's bounds to recover the tile-sized image.
        let full = layer.rgba(); // Vec<u8> length pw*ph*4 (per psd crate)
        let left = layer.layer_left().max(0) as u32;
        let top = layer.layer_top().max(0) as u32;
        let lw = (layer.layer_right() - layer.layer_left()).max(0) as u32;
        let lh = (layer.layer_bottom() - layer.layer_top()).max(0) as u32;
        if lw == 0 || lh == 0 { report.skipped.push(name); continue; }

        let mut tile = image::RgbaImage::new(lw, lh);
        for ty in 0..lh {
            for tx in 0..lw {
                let sx = left + tx; let sy = top + ty;
                if sx >= pw || sy >= ph { continue; }
                let idx = ((sy * pw + sx) * 4) as usize;
                if idx + 3 < full.len() {
                    tile.put_pixel(tx, ty, image::Rgba([full[idx], full[idx+1], full[idx+2], full[idx+3]]));
                }
            }
        }
        match write_tile_tex(orig, &tile) {
            Ok(()) => report.written += 1,
            Err(e) => report.errors.push(format!("{name}: {e}")),
        }
    }
    Ok(report)
}
```

NOTE for implementer: verify the `psd` crate's actual layer API at build time —
method names may be `layer.layer_top()` vs `layer.top()`, and `rgba()` may
return whole-canvas or layer-sized data. Read the crate docs/source (it's a
small crate) and adjust the crop accordingly. The contract is: get each layer's
pixels + bounds and produce a tile-sized RgbaImage. If `rgba()` already returns
layer-sized data, drop the crop and use it directly.

- [ ] **Step 2: Register**

In `main.rs` add `commands::map_tiles::apply_psd_to_textures,`.

- [ ] **Step 3: Build**

Run: `cargo build --manifest-path src-tauri/Cargo.toml --lib`
Expected: builds (fix any `psd` crate method-name mismatches surfaced here).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/project/map_tiles.rs src-tauri/src/main.rs
git commit -m "feat(map-tiles): apply_psd_to_textures command (layer name -> .tex)"
```

---

## Task 6: Frontend bindings + buttons

**Files:**
- Modify: `src/lib/api/mapPreview.ts`, `src/components/preview/MapPreview.tsx`

- [ ] **Step 1: API bindings**

In `src/lib/api/mapPreview.ts` add:

```ts
export interface ApplyPsdReport { written: number; skipped: string[]; errors: string[]; }

export async function combineGroundToPsd(projectPath: string): Promise<string> {
    return invokeCommand('combine_ground_to_psd', { projectPath });
}
export async function applyPsdToTextures(projectPath: string, psdPath: string): Promise<ApplyPsdReport> {
    return invokeCommand('apply_psd_to_textures', { projectPath, psdPath });
}
```

- [ ] **Step 2: Add two buttons to the Layers panel**

In `MapPreview.tsx`, inside the Layers panel body (near the top, above the
Elemental theme section), add a small "Ground textures" block. Uses the existing
inline `textBtn` style and `openWithDefaultApp` to open the resulting PSD:

```tsx
                        <div style={sectionLabel}>Ground textures</div>
                        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                            <button
                                style={textBtn}
                                onClick={async () => {
                                    try {
                                        const psd = await api.combineGroundToPsd(projectPath);
                                        await api.openWithDefaultApp(psd.replace(/\//g, '\\'));
                                    } catch (e) { console.error('combine psd failed', e); }
                                }}
                            >Combine → PSD</button>
                            <button
                                style={textBtn}
                                onClick={async () => {
                                    try {
                                        // Default to the project's ground_map.psd.
                                        const psd = `${projectPath}/ground_map.psd`;
                                        const r = await api.applyPsdToTextures(projectPath, psd);
                                        console.log('applied psd', r);
                                    } catch (e) { console.error('apply psd failed', e); }
                                }}
                            >Apply PSD</button>
                        </div>
```

(If you want a file picker for Apply instead of the fixed `ground_map.psd`, wire
the existing dialog plugin; the fixed path matches what Combine writes and is
fine for v1.)

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors (4 pre-existing).

- [ ] **Step 4: Commit**

```bash
git add src/lib/api/mapPreview.ts src/components/preview/MapPreview.tsx
git commit -m "feat(map-tiles): Combine/Apply PSD buttons in the Layers panel"
```

---

## Task 7: Manual verification

**Files:** none.

- [ ] **Step 1: Launch** `npm run tauri dev -- --release`, open the SRX project, open Preview Map.

- [ ] **Step 2: Combine** — open Layers panel → "Combine → PSD". Expected: `ground_map.psd` is written to the project root and opens in GIMP/Photoshop. Verify: a 10240² canvas; a visible **Base** group with the grid tiles in their correct cells; hidden **DragonPit · …** and **BaronPit · …** groups; each layer named after its tile.

- [ ] **Step 3: Edit** — recolor/desaturate the Base group in GIMP, save (keep it a `.psd`, same path).

- [ ] **Step 4: Apply** — "Apply PSD". Expected: the ground `.tex` files are overwritten; the live map preview updates (texture watcher) showing the recolor. Console logs `{written, skipped, errors}` — `written` should equal the number of edited tiles, `errors` empty.

- [ ] **Step 5: Edge cases** — Apply with no PSD present → clean error toast, no crash. A PSD with an extra layer not matching any tile → that layer in `skipped`, others still written.

- [ ] **Step 6: Commit any tweaks** `git commit -am "fix(map-tiles): verification tweaks"`.

---

## Self-review notes (addressed)

- **Spec coverage:** combine→PSD (T4), grouped layers w/ hidden variants+stages (T2/T4 classification, T2 psd groups), apply→tex by name (T5), texture-only/no-bin (entire design), grid placement A1..E5 (T3 `col/row`), reuse decode/encode (T4/T5), buttons on the open project (T6), round-trip + manual verify (T2/T7). All spec sections map to a task.
- **PSD writer risk:** ported byte-precise from ag-psd (research above); validated by a write→read round-trip with the independent `psd` crate (T2 step 7) before any UI wiring.
- **Types:** `PsdDoc/PsdGroup/PsdLayer` (writer), `GroundTile/TileGroup` (discovery), `ApplyReport/ApplyPsdReport` (Rust/TS) consistent across tasks. Command names match bindings (`combine_ground_to_psd`, `apply_psd_to_textures`).
- **Flagged for impl-time:** exact `psd` crate version + layer API method names (T2 dep add, T5 note) — verified against the crate when added, since the crate's surface can vary by version.
```
