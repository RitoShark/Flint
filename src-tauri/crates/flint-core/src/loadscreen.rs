//! Loading-screen project assets: spritesheet encoding, uibase extraction,
//! and the animation block injected into the uibase BIN.
//!
//! Distinct from `loadscreen_banner`, which drives a mask-based VFX overlay
//! on the skin BIN rather than the loading screen's own uibase.


pub fn encode_spritesheet_to_tex(
    rgba_deflated: Vec<u8>,
    width: u32,
    height: u32,
    assets_base: &std::path::Path,
) -> Result<(), String> {
    use std::io::Read;
    use flate2::read::DeflateDecoder;
    use rayon::prelude::*;

    let width = width as usize;
    let height = height as usize;
    let total_pixels = width * height;
    let expected_uncompressed_bytes = total_pixels * 4;

    tracing::info!(
        "Decompressing deflated spritesheet RGBA ({} bytes expected)",
        expected_uncompressed_bytes
    );

    let mut decoder = DeflateDecoder::new(&rgba_deflated[..]);
    let mut decompressed = Vec::with_capacity(expected_uncompressed_bytes);
    decoder.read_to_end(&mut decompressed)
        .map_err(|e| format!("Failed to decompress deflate stream: {}", e))?;

    if decompressed.len() != expected_uncompressed_bytes {
        return Err(format!(
            "Decompressed data size mismatch: expected {} bytes, got {}",
            expected_uncompressed_bytes,
            decompressed.len()
        ));
    }

    tracing::info!("Parallel encoding spritesheet BC1 blocks...");

    let row_bytes = width * 4;
    let block_row_bytes = row_bytes * 4;

    // 64 block rows (256 pixel rows) per chunk.
    let block_rows_per_chunk = 64;
    let chunk_bytes_size = block_row_bytes * block_rows_per_chunk;

    let compressed_chunks: Result<Vec<Vec<u8>>, String> = decompressed
        .par_chunks(chunk_bytes_size)
        .enumerate()
        .map(|(chunk_idx, chunk_data)| {
            let chunk_height = if (chunk_idx + 1) * block_rows_per_chunk * 4 <= height {
                block_rows_per_chunk * 4
            } else {
                height - chunk_idx * block_rows_per_chunk * 4
            };

            let expected_chunk_len = width * chunk_height * 4;
            if chunk_data.len() != expected_chunk_len {
                return Err(format!(
                    "Invalid chunk size: expected {}, got {}",
                    expected_chunk_len,
                    chunk_data.len()
                ));
            }

            let surface = intel_tex_2::Surface {
                width: width as u32,
                height: chunk_height as u32,
                stride: row_bytes as u32,
                data: chunk_data,
            };

            let comp = intel_tex_2::bc1::compress_blocks(&surface);
            Ok(comp)
        })
        .collect();

    let compressed_chunks = compressed_chunks?;
    let total_compressed_size: usize = compressed_chunks.iter().map(|c| c.len()).sum();
    let mut bc1_data = Vec::with_capacity(total_compressed_size);
    for chunk in compressed_chunks {
        bc1_data.extend_from_slice(&chunk);
    }

    tracing::info!("Writing TEX file to output directory...");

    let mut header = Vec::with_capacity(12);
    header.extend_from_slice(b"TEX\0");
    header.extend_from_slice(&(width as u16).to_le_bytes());
    header.extend_from_slice(&(height as u16).to_le_bytes());
    header.push(0); // is_extended_format
    header.push(10); // Format::Bc1 is 10
    header.push(0); // resource_type (texture = 0)
    header.push(0); // flags (no mipmaps = 0)

    let tex_path = assets_base
        .join("UI.wad.client")
        .join(SPRITESHEET_ASSET_PATH);
    if let Some(parent) = tex_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output directory: {}", e))?;
    }
    let mut output = std::fs::File::create(&tex_path)
        .map_err(|e| format!("Failed to create TEX file: {}", e))?;

    use std::io::Write;
    output.write_all(&header)
        .map_err(|e| format!("Failed to write TEX header: {}", e))?;
    output.write_all(&bc1_data)
        .map_err(|e| format!("Failed to write TEX data: {}", e))?;

    tracing::info!("Successfully wrote spritesheet TEX: {}", tex_path.display());
    Ok(())
}

/// Find and extract the uibase chunk from UI.wad.client in the game files.
pub fn extract_uibase_from_game(league_path: &std::path::Path) -> Result<Vec<u8>, String> {
    let ui_wad_path = league_path
        .join("Game")
        .join("DATA")
        .join("FINAL")
        .join("UI.wad.client");

    if !ui_wad_path.exists() {
        let alt_paths = [
            league_path.join("Game").join("DATA").join("FINAL").join("UI").join("UI.wad.client"),
            league_path.join("DATA").join("FINAL").join("UI.wad.client"),
        ];
        for alt in &alt_paths {
            if alt.exists() {
                return extract_uibase_chunk(alt);
            }
        }
        return Err(format!(
            "UI.wad.client not found. Searched: {}",
            ui_wad_path.display()
        ));
    }

    extract_uibase_chunk(&ui_wad_path)
}

/// Extract the uibase chunk from a WAD file by its known hash.
pub fn extract_uibase_chunk(wad_path: &std::path::Path) -> Result<Vec<u8>, String> {
    use crate::wad::adapter::WadHandle;

    tracing::info!("Extracting uibase from: {}", wad_path.display());

    let uibase_hash: u64 = 0x667b27d63a614c36;

    let mut reader = WadHandle::open(wad_path)
        .map_err(|e| format!("Failed to open UI.wad.client: {}", e))?;

    let chunk = *reader
        .get_chunk(uibase_hash)
        .ok_or_else(|| format!(
            "uibase chunk (hash {:016x}) not found in {}",
            uibase_hash,
            wad_path.display()
        ))?;

    let bytes = reader
        .wad_mut()
        .load_chunk_decompressed(&chunk)
        .map_err(|e| format!("Failed to decompress uibase chunk: {}", e))?;

    tracing::info!("Extracted uibase: {} bytes", bytes.len());
    Ok(bytes)
}

/// FNV-1a hash (lowercase) — matches the hashing used by League BIN files.
pub fn fnv1a_lower(s: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for b in s.to_lowercase().bytes() {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Build a `(field_hash, value)` pair — the hash is the FNV1a-32 of the
/// lowercased field name.
pub fn bin_prop(name: &str, value: crate::bin::BinValue) -> (u32, crate::bin::BinValue) {
    (fnv1a_lower(name), value)
}

/// Relative path (inside UI.wad.client) of the generated spritesheet. Also the
/// marker that identifies OUR injected animation entry in the uibase — the game
/// ships native `UiElementEffectAnimationData` entries (e.g. the loading
/// spinner) with the same class, so class alone is not enough to find ours.
const SPRITESHEET_ASSET_PATH: &str = "assets/animatedloadscreen/spritesheet.tex";

/// Inject the animation configuration object directly into the uibase BIN tree.
pub fn inject_animation_block(
    uibase_bytes: &[u8],
    assets_base: &std::path::Path,
    params: &AnimationParams,
    frame_width: u32,
    frame_height: u32,
) -> Result<(), String> {
    use crate::bin::{BinEntry, BinValue};

    tracing::info!("Injecting animation block into uibase BIN");

    let mut bin = crate::bin::read_bin(uibase_bytes)
        .map_err(|e| format!("Failed to parse uibase BIN: {}", e))?;

    tracing::info!("uibase parsed: {} objects", bin.entries.len());

    // mTextureUV expects pixel coordinates of a single frame (width-1, height-1),
    // NOT normalized UV fractions. Verified against the game's own spinner entry:
    // a 256x128 atlas with 32x32 frames uses {0, 0, 31, 31}.
    let uv_w = frame_width.saturating_sub(1) as f32;
    let uv_h = frame_height.saturating_sub(1) as f32;

    let entry_name = format!(
        "ClientStates/LoadingScreen/UX/LoadingScreenClassic/UIBase/LoadingScreen/{}",
        params.creator_name
    );
    let scene_path = "ClientStates/LoadingScreen/UX/LoadingScreenClassic/UIBase/LoadingScreen";

    let ui_rect = BinValue::Embed {
        class: fnv1a_lower("UiElementRect"),
        fields: vec![
            bin_prop("Position", BinValue::Vec2([0.0, 0.0])),
            bin_prop("Size", BinValue::Vec2([1920.0, 1080.0])),
            bin_prop("SourceResolutionWidth", BinValue::U16(1920)),
            bin_prop("SourceResolutionHeight", BinValue::U16(1080)),
        ].into_iter().collect(),
    };

    let position_ptr = BinValue::Pointer {
        class: fnv1a_lower("UiPositionRect"),
        fields: vec![
            bin_prop("UIRect", ui_rect),
            bin_prop("IgnoreGlobalScale", BinValue::Bool(true)),
        ].into_iter().collect(),
    };

    let atlas_data = BinValue::Pointer {
        class: fnv1a_lower("AtlasData"),
        fields: vec![
            bin_prop("mTextureName", BinValue::String(SPRITESHEET_ASSET_PATH.to_string())),
            bin_prop("mTextureSourceResolutionWidth", BinValue::U32(params.sheet_width)),
            bin_prop("mTextureSourceResolutionHeight", BinValue::U32(params.sheet_height)),
            bin_prop("mTextureUV", BinValue::Vec4([0.0, 0.0, uv_w, uv_h])),
        ].into_iter().collect(),
    };

    let anim_entry = BinEntry {
        path_hash: fnv1a_lower(&entry_name),
        class_hash: fnv1a_lower("UiElementEffectAnimationData"),
        fields: vec![
            bin_prop("name", BinValue::String(entry_name)),
            bin_prop("Scene", BinValue::Link(fnv1a_lower(scene_path))),
            bin_prop("Enabled", BinValue::Bool(true)),
            // Draw above the base scene's static elements: the background has no
            // explicit layer (default 0), icons sit at 20-25. Known-working
            // animated-loadscreen mods use 70 so the sheet covers the loadscreen.
            bin_prop("Layer", BinValue::U32(70)),
            bin_prop("Position", position_ptr),
            bin_prop("TextureData", atlas_data),
            bin_prop("FramesPerSecond", BinValue::F32(params.fps)),
            bin_prop("TotalNumberOfFrames", BinValue::F32(params.total_frames)),
            bin_prop("NumberOfFramesPerRowInAtlas", BinValue::F32(params.cols)),
            bin_prop("mFinishBehavior", BinValue::U8(1)),
        ].into_iter().collect(),
    };

    bin.entries.push(anim_entry);

    tracing::info!("Animation object inserted ({} objects total), writing binary", bin.entries.len());

    let binary_data = crate::bin::write_bin(&bin)
        .map_err(|e| format!("Failed to write modified BIN: {}", e))?;

    let uibase_dir = assets_base
        .join("UI.wad.client")
        .join("clientstates")
        .join("loadingscreen")
        .join("ux")
        .join("loadingscreenclassic");
    std::fs::create_dir_all(&uibase_dir)
        .map_err(|e| format!("Failed to create uibase directory: {}", e))?;

    let uibase_path = uibase_dir.join("uibase");
    std::fs::write(&uibase_path, &binary_data)
        .map_err(|e| format!("Failed to write modified uibase: {}", e))?;

    tracing::info!(
        "Wrote modified uibase ({} bytes) to: {}",
        binary_data.len(),
        uibase_path.display()
    );

    Ok(())
}

/// Holds the animation parameters extracted from an existing uibase bin entry.
pub struct AnimationParams {
    pub creator_name: String,
    pub sheet_width: u32,
    pub sheet_height: u32,
    pub fps: f32,
    pub total_frames: f32,
    pub cols: f32,
}

/// Read the existing uibase BIN in the project and extract the animation params
/// from the injected `UiElementEffectAnimationData` entry.
pub fn extract_animation_params_from_bin(uibase_bytes: &[u8]) -> Result<AnimationParams, String> {
    use crate::bin::BinValue;

    let bin = crate::bin::read_bin(uibase_bytes)
        .map_err(|e| format!("Failed to parse project uibase BIN: {}", e))?;

    let anim_class_hash = fnv1a_lower("UiElementEffectAnimationData");
    let texture_data_hash = fnv1a_lower("TextureData");
    let texture_name_hash = fnv1a_lower("mTextureName");

    // Find OUR injected entry: the game ships native entries of the same class
    // (e.g. the loading spinner), so match on the spritesheet texture path too.
    let anim_entry = bin.entries.iter()
        .filter(|e| e.class_hash == anim_class_hash)
        .find(|e| {
            e.fields.iter()
                .find(|(h, _)| **h == texture_data_hash)
                .and_then(|(_, v)| if let BinValue::Pointer { fields, .. } = v { Some(fields) } else { None })
                .and_then(|fields| fields.iter().find(|(h, _)| **h == texture_name_hash))
                .and_then(|(_, v)| if let BinValue::String(s) = v { Some(s) } else { None })
                .is_some_and(|s| s.eq_ignore_ascii_case(SPRITESHEET_ASSET_PATH))
        })
        .ok_or_else(|| "No Flint animated-loadscreen entry found in project uibase. \
                         Is this a loading-screen project?".to_string())?;

    // Extract creator name from the "name" field
    // It's formatted as "ClientStates/LoadingScreen/.../LoadingScreen/{creatorName}"
    let name_hash = fnv1a_lower("name");
    let creator_name = anim_entry.fields.iter()
        .find(|(h, _)| **h == name_hash)
        .and_then(|(_, v)| if let BinValue::String(s) = v { Some(s.clone()) } else { None })
        .and_then(|full_path| full_path.rsplit('/').next().map(|s| s.to_string()))
        .unwrap_or_else(|| "Flint".to_string());

    let atlas_fields = anim_entry.fields.iter()
        .find(|(h, _)| **h == texture_data_hash)
        .and_then(|(_, v)| if let BinValue::Pointer { fields, .. } = v { Some(fields) } else { None })
        .ok_or_else(|| "TextureData not found in animation entry".to_string())?;

    let src_w_hash = fnv1a_lower("mTextureSourceResolutionWidth");
    let src_h_hash = fnv1a_lower("mTextureSourceResolutionHeight");

    let sheet_width = atlas_fields.iter()
        .find(|(h, _)| **h == src_w_hash)
        .and_then(|(_, v)| if let BinValue::U32(n) = v { Some(*n) } else { None })
        .ok_or_else(|| "mTextureSourceResolutionWidth not found".to_string())?;

    let sheet_height = atlas_fields.iter()
        .find(|(h, _)| **h == src_h_hash)
        .and_then(|(_, v)| if let BinValue::U32(n) = v { Some(*n) } else { None })
        .ok_or_else(|| "mTextureSourceResolutionHeight not found".to_string())?;

    // Extract FramesPerSecond, TotalNumberOfFrames, NumberOfFramesPerRowInAtlas
    let fps_hash = fnv1a_lower("FramesPerSecond");
    let total_hash = fnv1a_lower("TotalNumberOfFrames");
    let cols_hash = fnv1a_lower("NumberOfFramesPerRowInAtlas");

    let fps = anim_entry.fields.iter()
        .find(|(h, _)| **h == fps_hash)
        .and_then(|(_, v)| if let BinValue::F32(n) = v { Some(*n) } else { None })
        .ok_or_else(|| "FramesPerSecond not found".to_string())?;

    let total_frames = anim_entry.fields.iter()
        .find(|(h, _)| **h == total_hash)
        .and_then(|(_, v)| if let BinValue::F32(n) = v { Some(*n) } else { None })
        .ok_or_else(|| "TotalNumberOfFrames not found".to_string())?;

    let cols = anim_entry.fields.iter()
        .find(|(h, _)| **h == cols_hash)
        .and_then(|(_, v)| if let BinValue::F32(n) = v { Some(*n) } else { None })
        .ok_or_else(|| "NumberOfFramesPerRowInAtlas not found".to_string())?;

    tracing::info!(
        "Extracted animation params: creator={}, sheet={}x{}, fps={}, frames={}, cols={}",
        creator_name, sheet_width, sheet_height, fps, total_frames, cols
    );

    Ok(AnimationParams {
        creator_name,
        sheet_width,
        sheet_height,
        fps,
        total_frames,
        cols,
    })
}

