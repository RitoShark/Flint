//! Tauri commands for project management
//!
//! These commands expose project management functionality to the frontend.

use flint_ltk::project::{
    create_project as core_create_project,
    open_project as core_open_project,
    register_in_index as core_register_in_index,
    save_project as core_save_project,
    Project,
};
use flint_ltk::repath::{organize_project, rename_project_asset_prefix, OrganizerConfig, RenameResult};
use flint_ltk::bin::{classify_bin, BinCategory};
use flint_ltk::wad::extractor::{
    find_champion_wad, extract_skin_assets, extract_skin_assets_selective, wad_contains_skin_bin,
};
use flint_ltk::hash::{resolve_hashes_lmdb_bulk, ResolvedHashes};
use crate::state::LmdbCacheState;
use crate::core::ipc_trace;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::Emitter;

fn find_companions_wad(league_path: &Path) -> Option<PathBuf> {
    let standard = league_path
        .join("Game")
        .join("DATA")
        .join("FINAL")
        .join("Companions.wad.client");
    if standard.exists() {
        return Some(standard);
    }
    
    let alt_paths = [
        league_path.join("Game").join("DATA").join("FINAL").join("Companions").join("Companions.wad.client"),
        league_path.join("DATA").join("FINAL").join("Companions.wad.client"),
    ];
    for alt in &alt_paths {
        if alt.exists() {
            return Some(alt.clone());
        }
    }
    None
}

/// Create a new project
///
/// # Arguments
/// * `name` - Project name
/// * `champion` - Champion internal name
/// * `skin_id` - Skin ID
/// * `league_path` - Path to League installation
/// * `output_path` - Directory where project will be created
/// * `creator_name` - Creator name for repathing (e.g., "SirDexal")
///
/// # Returns
/// * `Ok(Project)` - The created project
/// * `Err(String)` - Error message if creation failed
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_project(
    name: String,
    champion: String,
    skin_id: u32,
    league_path: String,
    output_path: String,
    creator_name: Option<String>,
    use_jade: Option<bool>,
    is_pbe: Option<bool>,
    is_tft: Option<bool>,
    lmdb: tauri::State<'_, LmdbCacheState>,
    app: tauri::AppHandle,
) -> Result<Project, String> {
    let pbe = is_pbe.unwrap_or(false);
    let source_label = if pbe { "PBE" } else { "Live" };
    tracing::info!(
        "Frontend requested project creation: {} ({} skin {}) from {} install",
        name, champion, skin_id, source_label
    );

    // Per-phase timing — log every step so we can spot what takes "ages".
    // Phase totals print at end of project creation.
    let total_start = Instant::now();
    let mut phase_timings: Vec<(&'static str, std::time::Duration)> = Vec::new();

    let league_path_buf = PathBuf::from(&league_path);
    let output_path_buf = PathBuf::from(&output_path);

    if !league_path_buf.exists() {
        return Err(format!(
            "[E_PBE_PATH_MISSING] {} League folder does not exist at '{}'. Open Settings (Ctrl+,) and re-detect the {} install path.",
            source_label, league_path, source_label
        ));
    }

    // Prime LMDB and open the env (build from .txt files if stale, then mmap)
    let _ = app.emit("project-create-progress", serde_json::json!({
        "phase": "init",
        "message": "Initializing..."
    }));

    let hash_dir = flint_ltk::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let t = Instant::now();
    let env_arc = lmdb.prime(&hash_dir).ok_or_else(||
        "Hash databases not found. Run hash download first.".to_string()
    )?;
    let d = t.elapsed();
    tracing::info!("[TIMING] LMDB prime: {:?}", d);
    phase_timings.push(("lmdb_prime", d));

    // 2. Validate WAD existence before creating project
    let t = Instant::now();
    let is_tft_project = is_tft.unwrap_or(false);
    let wad_path = if is_tft_project {
        find_companions_wad(&league_path_buf)
            .ok_or_else(|| "Companions WAD (Companions.wad.client) not found. Please check League installation.".to_string())?
    } else {
        find_champion_wad(&league_path_buf, &champion)
            .ok_or_else(|| if pbe {
                format!(
                    "[E_PBE_CHAMP_NOT_FOUND] Champion '{}' was not found in your local PBE install. The PBE client may not be updated to a patch that ships this champion yet — try logging into the PBE launcher to apply pending updates, or disable the PBE toggle to use the Live client.",
                    champion
                )
            } else {
                format!(
                    "Champion WAD not found for '{}'. Please check League installation.",
                    champion
                )
            })?
    };
    let d = t.elapsed();
    tracing::info!("[TIMING] find_champion_wad: {:?}", d);
    phase_timings.push(("find_champion_wad", d));

    // 2b. Verify the requested skin's main BIN is actually inside the WAD.
    //
    // CDragon's PBE branch lists skins as soon as Riot's PBE patch metadata is published,
    // but the local PBE client only ships those files after the launcher applies the patch.
    // Without this check, extraction silently succeeds with a partial/empty result and the
    // organizer ends up scanning all BINs as a fallback (see "No main skin BIN found" warning).
    let t = Instant::now();
    let skin_bin_present = wad_contains_skin_bin(&wad_path, &champion, skin_id)
        .map_err(|e| format!(
            "Failed to inspect WAD '{}': {}",
            wad_path.display(), e
        ))?;
    let d = t.elapsed();
    tracing::info!("[TIMING] wad_contains_skin_bin: {:?}", d);
    phase_timings.push(("wad_contains_skin_bin", d));
    if !skin_bin_present {
        let source_label = if pbe { "PBE" } else { "Live" };
        let hint = if pbe {
            "Your local PBE install does not have this skin yet — the PBE launcher needs to apply the latest patch. Open the PBE launcher and let it finish updating, or disable the PBE toggle to use the Live client."
        } else {
            "Your local League install does not have this skin's BIN. The client may need to repair, or this skin ID is not present in this build."
        };
        return Err(format!(
            "[E_PBE_SKIN_NOT_IN_WAD] {} install is missing data/characters/{}/skins/skin{}.bin (also checked zero-padded skin{:02}.bin). {}",
            source_label, champion.to_lowercase(), skin_id, skin_id, hint
        ));
    }

    // 3. Create the project directory structure
    let _ = app.emit("project-create-progress", serde_json::json!({
        "phase": "create",
        "message": "Creating project structure..."
    }));

    let name_clone = name.clone();
    let champion_clone = champion.clone();
    let league_clone = league_path_buf.clone();
    let output_clone = output_path_buf.clone();
    let creator_clone = creator_name.clone();
    let is_tft_clone = is_tft_project;

    let t = Instant::now();
    let project = tokio::task::spawn_blocking(move || -> Result<Project, String> {
        let mut project = core_create_project(&name_clone, &champion_clone, skin_id, &league_clone, &output_clone, creator_clone)
            .map_err(|e| e.to_string())?;
        if is_tft_clone {
            project = project.into_tft(&champion_clone, skin_id);
            core_save_project(&project).map_err(|e| e.to_string())?;
            if let Err(e) = core_register_in_index(&output_clone, &project) {
                tracing::warn!("Failed to refresh projects.json: {}", e);
            }
        }
        Ok(project)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))??;
    let d = t.elapsed();
    tracing::info!("[TIMING] core_create_project (mkdir + manifest): {:?}", d);
    phase_timings.push(("core_create_project", d));
    
    // 4. Extract skin assets into the project
    let _ = app.emit("project-create-progress", serde_json::json!({
        "phase": "extract",
        "message": format!("Extracting {} skin {} assets...", champion, skin_id)
    }));

    tracing::info!("Extracting assets for {} skin {}...", champion, skin_id);

    let assets_path = project.assets_path();
    let champion_for_extract = champion.clone();

    let t = Instant::now();
    let extraction_result = tokio::task::spawn_blocking(move || {
        // Build LMDB resolver closure — point lookups only, no full table load
        let env = env_arc;
        let resolve = move |hashes: &[u64]| -> ResolvedHashes {
            resolve_hashes_lmdb_bulk(hashes, &env)
        };

        // Try selective extraction first — walks the seed BIN's reference
        // graph in memory and pulls only the ~400 chunks the skin actually
        // needs, instead of all ~3700 under `assets/`+`data/`. Cuts the
        // Defender-tax (~12s on Windows) out of project creation.
        //
        // Falls back to whole-WAD extraction if the seed BIN can't be
        // located or the BIN graph fails to parse. Old path stays as a
        // safety net; if a project comes out broken, point the bug at this
        // function and use the fallback as the comparison baseline.
        match extract_skin_assets_selective(
            &wad_path,
            &assets_path,
            &champion_for_extract,
            skin_id,
            &resolve,
            is_tft_project,
        ) {
            Ok(r) => Ok(r),
            Err(e) => {
                tracing::warn!(
                    "Selective extraction failed ({}), falling back to whole-WAD",
                    e
                );
                extract_skin_assets(
                    &wad_path,
                    &assets_path,
                    &champion_for_extract,
                    skin_id,
                    resolve,
                    is_tft_project,
                )
                .map_err(|e| e.to_string())
            }
        }
    })
    .await;
    let extract_elapsed = t.elapsed();
    tracing::info!("[TIMING] extract_skin_assets: {:?}", extract_elapsed);
    phase_timings.push(("extract_skin_assets", extract_elapsed));

    let extraction_result = match extraction_result {
        Ok(Ok(result)) => {
            tracing::info!("Extracted {} assets to project", result.extracted_count);
            result
        }
        Ok(Err(e)) => {
            tracing::error!("Asset extraction failed: {}", e);
            tracing::info!("Cleaning up project directory due to failure...");
            if let Err(cleanup_err) = std::fs::remove_dir_all(&project.project_path) {
                tracing::error!("Failed to clean up project directory: {}", cleanup_err);
            }
            if pbe {
                return Err(format!(
                    "[E_PBE_SKIN_EXTRACT_FAILED] Failed to extract {} skin {} from your PBE install: {}. The skin may not exist in this PBE patch yet — log into the PBE launcher to apply updates, or disable the PBE toggle to use the Live client.",
                    champion, skin_id, e
                ));
            }
            return Err(format!("Asset extraction failed: {}. Project creation cancelled.", e));
        }
        Err(e) => {
            tracing::error!("Extraction task panicked: {}", e);
            if let Err(cleanup_err) = std::fs::remove_dir_all(&project.project_path) {
                tracing::error!("Failed to clean up project directory: {}", cleanup_err);
            }
            return Err(format!("Internal error during extraction: {}", e));
        }
    };

    // 5. Repath assets if creator name is provided; TFT skips repath but still needs concat
    if is_tft_project {
        let _ = app.emit("project-create-progress", serde_json::json!({
            "phase": "concat",
            "message": "Merging linked BINs..."
        }));

        let concat_config = OrganizerConfig {
            enable_concat: true,
            enable_repath: false,
            creator_name: String::new(),
            project_name: name.clone(),
            champion: champion.clone(),
            target_skin_id: skin_id,
            cleanup_unused: false,
            use_jade_engine: use_jade.unwrap_or(false),
            wad_folder_override: Some("Companions.wad.client".to_string()),
        };

        let assets_path_for_concat = project.assets_path();
        let path_mappings = extraction_result.path_mappings.clone();
        let t = Instant::now();
        let concat_result = tokio::task::spawn_blocking(move || {
            organize_project(&assets_path_for_concat, &concat_config, &path_mappings)
        })
        .await;
        let d = t.elapsed();
        tracing::info!("[TIMING] organize_project (concat only, TFT): {:?}", d);
        phase_timings.push(("organize_project_tft_concat", d));

        match concat_result {
            Ok(Ok(result)) => {
                let bins_combined = result.concat_result.as_ref().map(|r| r.source_count).unwrap_or(0);
                tracing::info!("TFT concat complete: {} BINs combined", bins_combined);
            }
            Ok(Err(e)) => tracing::warn!("TFT concat failed (project still usable): {}", e),
            Err(e) => tracing::warn!("TFT concat task panicked (project still usable): {}", e),
        }
    } else if let Some(creator) = creator_name {
        if !creator.is_empty() {
            let _ = app.emit("project-create-progress", serde_json::json!({
                "phase": "repath",
                "message": format!("Repathing assets to ASSETS/{}/{}...", creator, name)
            }));

            tracing::info!("Repathing assets with prefix: ASSETS/{}/{}", creator, name);

            let repath_config = OrganizerConfig {
                enable_concat: true,
                enable_repath: true,
                creator_name: creator.clone(),
                project_name: name.clone(),
                champion: champion.clone(),
                target_skin_id: skin_id,
                cleanup_unused: true,
                use_jade_engine: use_jade.unwrap_or(false),
                wad_folder_override: None,
            };

            let assets_path_for_repath = project.assets_path();
            let path_mappings = extraction_result.path_mappings.clone();
            let t = Instant::now();
            let repath_result = tokio::task::spawn_blocking(move || {
                organize_project(&assets_path_for_repath, &repath_config, &path_mappings)
            })
            .await;
            let d = t.elapsed();
            tracing::info!("[TIMING] organize_project (repath + concat): {:?}", d);
            phase_timings.push(("organize_project", d));

            match repath_result {
                Ok(Ok(result)) => {
                    let paths_modified = result.repath_result.as_ref().map(|r| r.paths_modified).unwrap_or(0);
                    let files_relocated = result.repath_result.as_ref().map(|r| r.files_relocated).unwrap_or(0);
                    let bins_combined = result.concat_result.as_ref().map(|r| r.source_count).unwrap_or(0);
                    tracing::info!(
                        "Project organization complete: {} paths modified, {} files relocated, {} BINs combined",
                        paths_modified,
                        files_relocated,
                        bins_combined
                    );
                }
                Ok(Err(e)) => {
                    tracing::warn!("Repathing failed (project still usable): {}", e);
                    // Don't fail the whole project creation if repathing fails
                }
                Err(e) => {
                    tracing::warn!("Repathing task panicked (project still usable): {}", e);
                }
            }
        }
    }

    let _ = app.emit("project-create-progress", serde_json::json!({
        "phase": "complete",
        "message": "Project created successfully!"
    }));

    let total = total_start.elapsed();
    tracing::info!("[TIMING] === Project creation total: {:?} ===", total);
    for (label, dur) in &phase_timings {
        let pct = (dur.as_secs_f64() / total.as_secs_f64()) * 100.0;
        tracing::info!("[TIMING]   {:>22}: {:>10?}  ({:>5.1}%)", label, dur, pct);
    }

    Ok(project)
}


/// Create a new animated loading screen project
///
/// This command handles:
/// 1. Creating the project directory structure
/// 2. Reading the spritesheet PNG and encoding it as a .tex file
/// 3. Extracting the uibase BIN from UI.wad.client
/// 4. Injecting the animation configuration block into the BIN
/// 5. Writing all output files to the project
#[tauri::command]
pub async fn create_loading_screen_project(
    request: tauri::ipc::Request<'_>,
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, String> {
    // 1. Extract raw binary body
    let body_bytes: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("create_loading_screen_project expects raw binary body; got JSON body".into())
        }
    };

    struct BinaryReader<'a> {
        data: &'a [u8],
        cursor: usize,
    }

    impl<'a> BinaryReader<'a> {
        fn new(data: &'a [u8]) -> Self {
            Self { data, cursor: 0 }
        }

        fn read_string(&mut self) -> Result<String, String> {
            if self.cursor + 4 > self.data.len() {
                return Err("Unexpected end of buffer when reading string length".into());
            }
            let len = u32::from_le_bytes(self.data[self.cursor..self.cursor+4].try_into().unwrap()) as usize;
            self.cursor += 4;
            if self.cursor + len > self.data.len() {
                return Err("Unexpected end of buffer when reading string bytes".into());
            }
            let s = std::str::from_utf8(&self.data[self.cursor..self.cursor+len])
                .map_err(|e| format!("Invalid UTF-8 string: {}", e))?
                .to_string();
            self.cursor += len;
            Ok(s)
        }

        fn read_u32(&mut self) -> Result<u32, String> {
            if self.cursor + 4 > self.data.len() {
                return Err("Unexpected end of buffer when reading u32".into());
            }
            let val = u32::from_le_bytes(self.data[self.cursor..self.cursor+4].try_into().unwrap());
            self.cursor += 4;
            Ok(val)
        }

        fn read_f32(&mut self) -> Result<f32, String> {
            if self.cursor + 4 > self.data.len() {
                return Err("Unexpected end of buffer when reading f32".into());
            }
            let val = f32::from_le_bytes(self.data[self.cursor..self.cursor+4].try_into().unwrap());
            self.cursor += 4;
            Ok(val)
        }
    }

    let mut reader = BinaryReader::new(body_bytes);
    let name = reader.read_string()?;
    let project_path = reader.read_string()?;
    let league_path = reader.read_string()?;
    let creator_name = reader.read_string()?;

    let frame_width = reader.read_u32()?;
    let frame_height = reader.read_u32()?;
    let sheet_width = reader.read_u32()?;
    let sheet_height = reader.read_u32()?;
    let fps = reader.read_f32()?;
    let total_frames = reader.read_f32()?;
    let cols = reader.read_f32()?;
    let _rows = reader.read_f32()?;

    // The remaining bytes are the deflated spritesheet bytes
    let deflated_bytes_vec = body_bytes[reader.cursor..].to_vec();

    tracing::info!(
        "Creating loading screen project '{}' ({}x{} sheet, {} frames)",
        name, sheet_width, sheet_height, total_frames
    );

    let league_path_buf = PathBuf::from(&league_path);
    let output_path_buf = PathBuf::from(&project_path);

    // ── Phase 1: Create project structure ────────────────────────────────
    let _ = app.emit("project-create-progress", serde_json::json!({
        "phase": "create",
        "message": "Creating project structure..."
    }));

    let name_clone = name.clone();
    let creator_clone = creator_name.clone();
    let league_clone = league_path_buf.clone();
    let output_clone = output_path_buf.clone();

    // Loading-screen projects don't have a champion. We still create the
    // standard project layout, then convert the runtime struct to the
    // LoadingScreen shape and re-save flint.json so it carries
    // `kind: "loading-screen"` with no leftover champion/skin_id noise.
    let output_dir_for_index = output_clone.clone();
    let project = tokio::task::spawn_blocking(move || -> Result<Project, String> {
        let project = core_create_project(
            &name_clone,
            "",
            0,
            &league_clone,
            &output_clone,
            Some(creator_clone),
        ).map_err(|e| e.to_string())?;
        let project = project.into_loading_screen();
        core_save_project(&project).map_err(|e| e.to_string())?;
        if let Err(e) = core_register_in_index(&output_dir_for_index, &project) {
            tracing::warn!("Failed to refresh projects.json for loading-screen project {}: {}", project.pid, e);
        }
        Ok(project)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
    ?;

    // ── Phase 2: Encode spritesheet PNG → TEX ────────────────────────────
    let _ = app.emit("project-create-progress", serde_json::json!({
        "phase": "encode",
        "message": "Encoding spritesheet to TEX format..."
    }));

    let assets_base = project.assets_path();
    let sheet_w = sheet_width;
    let sheet_h = sheet_height;

    let tex_result = tokio::task::spawn_blocking(move || {
        encode_spritesheet_to_tex(deflated_bytes_vec, sheet_w, sheet_h, &assets_base)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    if let Err(e) = tex_result {
        tracing::error!("TEX encoding failed: {}", e);
        let _ = std::fs::remove_dir_all(&project.project_path);
        return Err(format!("Spritesheet encoding failed: {}", e));
    }

    // ── Phase 3: Extract uibase from UI.wad.client ───────────────────────
    let _ = app.emit("project-create-progress", serde_json::json!({
        "phase": "extract",
        "message": "Extracting UI base from game files..."
    }));

    let league_for_wad = league_path_buf.clone();
    let uibase_bytes = tokio::task::spawn_blocking(move || {
        extract_uibase_from_game(&league_for_wad)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    let uibase_bytes = match uibase_bytes {
        Ok(bytes) => bytes,
        Err(e) => {
            tracing::error!("uibase extraction failed: {}", e);
            let _ = std::fs::remove_dir_all(&project.project_path);
            return Err(format!("Failed to extract UI base: {}", e));
        }
    };

    // ── Phase 4: Inject animation block into BIN ─────────────────────────
    let _ = app.emit("project-create-progress", serde_json::json!({
        "phase": "inject",
        "message": "Injecting animation configuration..."
    }));

    let assets_base_inject = project.assets_path();
    let creator_for_inject = creator_name.clone();

    let inject_result = tokio::task::spawn_blocking(move || {
        inject_animation_block(
            &uibase_bytes,
            &assets_base_inject,
            &creator_for_inject,
            frame_width,
            frame_height,
            sheet_width,
            sheet_height,
            fps,
            total_frames,
            cols,
        )
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;
    if let Err(e) = inject_result {
        tracing::error!("BIN injection failed: {}", e);
        let _ = std::fs::remove_dir_all(&project.project_path);
        return Err(format!("Configuration injection failed: {}", e));
    }

    // ── Phase 5: Finish ────────────────────────────────────────────────
    let _ = app.emit("project-create-progress", serde_json::json!({
        "phase": "complete",
        "message": "Loading screen project created successfully!"
    }));

    tracing::info!("Loading screen project created at: {}", project.project_path.display());

    let pid = &project.pid;
    let name = &project.name;
    let display_name = &project.display_name;
    let kind = project.kind.as_str();
    let champion = &project.champion;
    let skin_id = project.skin_id;
    let map_id = project.map_id.as_deref().unwrap_or("");
    let creator = project.authors.first().map(|s| s.as_str()).unwrap_or("");
    let version = &project.version;
    let description = &project.description;
    let project_path_str = project.project_path.to_string_lossy().into_owned();

    let mut project_bytes = Vec::new();
    
    let write_string = |buf: &mut Vec<u8>, s: &str| {
        let bytes = s.as_bytes();
        buf.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        buf.extend_from_slice(bytes);
    };

    write_string(&mut project_bytes, pid);
    write_string(&mut project_bytes, name);
    write_string(&mut project_bytes, display_name);
    write_string(&mut project_bytes, kind);
    write_string(&mut project_bytes, champion);
    project_bytes.extend_from_slice(&skin_id.to_le_bytes());
    write_string(&mut project_bytes, map_id);
    write_string(&mut project_bytes, creator);
    write_string(&mut project_bytes, version);
    write_string(&mut project_bytes, description);
    write_string(&mut project_bytes, &project_path_str);

    Ok(tauri::ipc::Response::new(project_bytes))
}

/// Encode a deflated RGBA spritesheet to League TEX format in parallel and write to project
fn encode_spritesheet_to_tex(
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

    // Decompress the deflated RGBA byte stream
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

    // Process chunks of 64 block rows (256 pixel rows)
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

    // Write TEX header manually
    let mut header = Vec::with_capacity(12);
    header.extend_from_slice(b"TEX\0");
    header.extend_from_slice(&(width as u16).to_le_bytes());
    header.extend_from_slice(&(height as u16).to_le_bytes());
    header.push(0); // is_extended_format
    header.push(10); // Format::Bc1 is 10
    header.push(0); // resource_type (texture = 0)
    header.push(0); // flags (no mipmaps = 0)

    // Write to project at UI.wad.client/assets/animatedloadscreen/spritesheet.tex
    let tex_dir = assets_base
        .join("UI.wad.client")
        .join("assets")
        .join("animatedloadscreen");
    std::fs::create_dir_all(&tex_dir)
        .map_err(|e| format!("Failed to create output directory: {}", e))?;

    let tex_path = tex_dir.join("spritesheet.tex");
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

/// Find and extract the uibase chunk from UI.wad.client in the game files
fn extract_uibase_from_game(league_path: &std::path::Path) -> Result<Vec<u8>, String> {
    // Find UI.wad.client in game files
    let ui_wad_path = league_path
        .join("Game")
        .join("DATA")
        .join("FINAL")
        .join("UI.wad.client");

    if !ui_wad_path.exists() {
        // Try alternate location (subdirectory)
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

/// Extract the uibase chunk from a WAD file by its known hash
fn extract_uibase_chunk(wad_path: &std::path::Path) -> Result<Vec<u8>, String> {
    use flint_ltk::wad::reader::WadReader;

    tracing::info!("Extracting uibase from: {}", wad_path.display());

    let uibase_hash: u64 = 0x667b27d63a614c36;

    let mut reader = WadReader::open(wad_path)
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
        .chunk_data(&chunk)
        .map_err(|e| format!("Failed to decompress uibase chunk: {}", e))?;

    tracing::info!("Extracted uibase: {} bytes", bytes.len());
    Ok(bytes)
}

/// FNV-1a hash (lowercase) — matches the hashing used by League BIN files.
fn fnv1a_lower(s: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for b in s.to_lowercase().bytes() {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Build a `(field_hash, value)` pair from a field name and value. rs_bin
/// stores fields as `IndexMap<u32, BinValue>` keyed by the FNV1a-32 of the
/// lowercased field name, so the value is the bare `BinValue` (no wrapper).
fn bin_prop(name: &str, value: flint_ltk::ltk_types::BinValue) -> (u32, flint_ltk::ltk_types::BinValue) {
    (fnv1a_lower(name), value)
}

/// Inject the animation configuration object directly into the uibase BIN tree.
///
/// Instead of text manipulation (which is fragile with brackets), we parse the
/// binary BIN into a BinTree, insert a new BinTreeObject with the animation
/// config, and serialize back to binary.
#[allow(clippy::too_many_arguments)]
fn inject_animation_block(
    uibase_bytes: &[u8],
    assets_base: &std::path::Path,
    creator_name: &str,
    frame_width: u32,
    frame_height: u32,
    sheet_width: u32,
    sheet_height: u32,
    fps: f32,
    total_frames: f32,
    cols: f32,
) -> Result<(), String> {
    use flint_ltk::ltk_types::{BinEntry, BinValue};

    tracing::info!("Injecting animation block into uibase BIN");

    let mut bin = flint_ltk::bin::read_bin_ltk(uibase_bytes)
        .map_err(|e| format!("Failed to parse uibase BIN: {}", e))?;

    tracing::info!("uibase parsed: {} objects", bin.entries.len());

    let uv_w = frame_width as f32 / sheet_width as f32;
    let uv_h = frame_height as f32 / sheet_height as f32;

    let entry_name = format!(
        "ClientStates/LoadingScreen/UX/LoadingScreenClassic/UIBase/LoadingScreen/{}",
        creator_name
    );
    let scene_path = "ClientStates/LoadingScreen/UX/LoadingScreenClassic/UIBase/LoadingScreen";

    // UIRect embed inside Position
    let ui_rect = BinValue::Embed {
        class: fnv1a_lower("UiElementRect"),
        fields: vec![
            bin_prop("Position", BinValue::Vec2([0.0, 0.0])),
            bin_prop("Size", BinValue::Vec2([1920.0, 1080.0])),
            bin_prop("SourceResolutionWidth", BinValue::U16(1920)),
            bin_prop("SourceResolutionHeight", BinValue::U16(1080)),
        ].into_iter().collect(),
    };

    // Position pointer → UiPositionRect
    let position_ptr = BinValue::Pointer {
        class: fnv1a_lower("UiPositionRect"),
        fields: vec![
            bin_prop("UIRect", ui_rect),
            bin_prop("IgnoreGlobalScale", BinValue::Bool(true)),
        ].into_iter().collect(),
    };

    // TextureData pointer → AtlasData
    let atlas_data = BinValue::Pointer {
        class: fnv1a_lower("AtlasData"),
        fields: vec![
            bin_prop("mTextureName", BinValue::String("assets/animatedloadscreen/spritesheet.tex".to_string())),
            bin_prop("mTextureSourceResolutionWidth", BinValue::U32(sheet_width)),
            bin_prop("mTextureSourceResolutionHeight", BinValue::U32(sheet_height)),
            bin_prop("mTextureUV", BinValue::Vec4([0.0, 0.0, uv_w, uv_h])),
        ].into_iter().collect(),
    };

    // Top-level entry
    let path_hash: u32 = 0x93e6_1733;
    let anim_entry = BinEntry {
        path_hash,
        class_hash: fnv1a_lower("UiElementEffectAnimationData"),
        fields: vec![
            bin_prop("name", BinValue::String(entry_name)),
            bin_prop("Scene", BinValue::Link(fnv1a_lower(scene_path))),
            bin_prop("Enabled", BinValue::Bool(true)),
            bin_prop("Layer", BinValue::U32(0)),
            bin_prop("Position", position_ptr),
            bin_prop("TextureData", atlas_data),
            bin_prop("FramesPerSecond", BinValue::F32(fps)),
            bin_prop("TotalNumberOfFrames", BinValue::F32(total_frames)),
            bin_prop("NumberOfFramesPerRowInAtlas", BinValue::F32(cols)),
            bin_prop("mFinishBehavior", BinValue::U8(1)),
        ].into_iter().collect(),
    };

    bin.entries.push(anim_entry);

    tracing::info!("Animation object inserted ({} objects total), writing binary", bin.entries.len());

    let binary_data = flint_ltk::bin::write_bin_ltk(&bin)
        .map_err(|e| format!("Failed to write modified BIN: {}", e))?;

    // Write modified BIN to project
    // Path: UI.wad.client/clientstates/loadingscreen/ux/loadingscreenclassic/uibase
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


/// Open an existing project
///
/// # Arguments
/// * `path` - Path to the .flint project directory
///
/// # Returns
/// * `Ok(Project)` - The loaded project
/// * `Err(String)` - Error message if loading failed
#[tauri::command]
pub async fn open_project(path: String) -> Result<Project, String> {
    let _t = ipc_trace::enter("open_project");
    tracing::info!("Frontend requested opening project: {}", path);

    let path = PathBuf::from(path);

    let project = tokio::task::spawn_blocking(move || core_open_project(&path))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
        .map_err(|e| e.to_string())?;

    // Refresh the projects.json index entry so a project that was moved
    // gets picked up under its new path on the next discover_projects scan.
    if let Some(parent) = project.project_path.parent() {
        let project_clone = project.clone();
        let parent = parent.to_path_buf();
        let _ = tokio::task::spawn_blocking(move || {
            flint_ltk::project::register_in_index(&parent, &project_clone)
        })
        .await;
    }

    Ok(project)
}

/// Walk a projects root directory, return every Flint project found there
/// merged with the on-disk `projects.json` index.
#[tauri::command]
pub async fn discover_projects(
    projects_root: String,
) -> Result<Vec<flint_ltk::project::ProjectListing>, String> {
    let root = PathBuf::from(projects_root);
    tokio::task::spawn_blocking(move || flint_ltk::project::discover_projects(&root))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
        .map_err(|e| e.to_string())
}

/// Drop a single project from the `projects.json` index. Does NOT touch the
/// project folder itself.
#[tauri::command]
pub async fn forget_project(
    projects_root: String,
    pid: String,
) -> Result<bool, String> {
    let root = PathBuf::from(projects_root);
    tokio::task::spawn_blocking(move || flint_ltk::project::remove_from_index(&root, &pid))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
        .map_err(|e| e.to_string())
}

/// Save project state
///
/// # Arguments
/// * `project` - The project to save
///
/// # Returns
/// * `Ok(())` - If save succeeded
/// * `Err(String)` - Error message if save failed
#[tauri::command]
pub async fn save_project(project: Project) -> Result<(), String> {
    let _t = ipc_trace::enter("save_project");
    tracing::info!("Frontend requested saving project: {}", project.name);

    tokio::task::spawn_blocking(move || core_save_project(&project))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
        .map_err(|e| e.to_string())
}

/// Result of a hard rename — the new on-disk location plus what changed.
#[derive(Debug, Serialize)]
pub struct HardRenameResult {
    pub new_project_path: String,
    pub project: Project,
    pub bins_changed: usize,
    pub strings_changed: usize,
    pub folders_renamed: usize,
    pub skipped_bins: Vec<String>,
}

/// Hard-rename a project everywhere: rewrite the asset prefix
/// (`ASSETS/{creator}/{old}` → `…/{new}`) inside every BIN, rename the matching
/// on-disk asset folders, update `mod.config.json` + `flint.json`, and finally
/// rename the project directory itself. Returns the new path + updated project.
///
/// Irreversible — the frontend warns before calling.
#[tauri::command]
pub async fn hard_rename_project(
    project: Project,
    project_path: String,
    new_name: String,
) -> Result<HardRenameResult, String> {
    let _t = ipc_trace::enter("hard_rename_project");
    let new_name = new_name.trim().to_string();
    if new_name.is_empty() {
        return Err("Project name cannot be empty".to_string());
    }
    tokio::task::spawn_blocking(move || hard_rename_inner(project, project_path, new_name))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

fn hard_rename_inner(mut project: Project, project_path: String, new_name: String) -> Result<HardRenameResult, String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(format!("Project folder not found: {}", project_path));
    }

    // Old project segment as it appears in asset paths = the current slug `name`.
    let old_name = project.name.clone();
    let new_slug = sanitize_project_slug(&new_name);

    // 1. Rename the project DIRECTORY first. This is the step most likely to
    //    fail (e.g. a watcher still holding the folder handle on Windows →
    //    "Access is denied"), so doing it first means a failure leaves the
    //    project completely untouched instead of half-renamed. The frontend
    //    stops the preview watcher before calling; the retry covers any lag in
    //    the OS releasing the handle.
    let parent = root.parent().ok_or("Project has no parent directory")?;
    let new_root = parent.join(&new_slug);
    let work_root = if new_root == root {
        root.clone()
    } else if new_root.exists() {
        return Err(format!("A folder named '{}' already exists next to the project", new_slug));
    } else {
        rename_dir_with_retry(&root, &new_root)?;
        new_root.clone()
    };
    let new_project_path = work_root.to_string_lossy().replace('\\', "/");

    // 2. Rewrite asset prefix in BINs + rename on-disk asset folders (new root).
    let content_base = work_root.join("content");
    let rename_result: RenameResult = if content_base.is_dir() {
        rename_project_asset_prefix(&content_base, &old_name, &new_slug)
            .map_err(|e| format!("Failed to rewrite asset paths: {}", e))?
    } else {
        RenameResult::default()
    };

    // 3. Update name + display_name and persist config (mod.config.json +
    //    flint.json) at the new path.
    project.name = new_slug.clone();
    project.display_name = new_name.clone();
    project.project_path = work_root;
    core_save_project(&project).map_err(|e| format!("Failed to save project config: {}", e))?;

    // The frontend reopens the project at the new path, which re-registers it
    // in the index and refreshes the recent-projects list.

    Ok(HardRenameResult {
        new_project_path,
        project,
        bins_changed: rename_result.bins_changed,
        strings_changed: rename_result.strings_changed,
        folders_renamed: rename_result.folders_renamed,
        skipped_bins: rename_result.skipped_bins,
    })
}

/// `fs::rename` a directory, retrying briefly on Windows "access denied" — a
/// just-stopped folder watcher can take a moment to release its handle.
fn rename_dir_with_retry(src: &Path, dst: &Path) -> Result<(), String> {
    let mut last_err = String::new();
    for attempt in 0..10 {
        match std::fs::rename(src, dst) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e.to_string();
                std::thread::sleep(std::time::Duration::from_millis(100 * (attempt + 1)));
            }
        }
    }
    Err(format!(
        "Failed to rename project folder: {}. Close anything using the project folder (editors, Explorer windows) and try again.",
        last_err
    ))
}

/// Filesystem- and asset-path-safe project slug: trim, spaces→hyphens, drop
/// characters illegal in Windows paths, and strip trailing dots/spaces.
fn sanitize_project_slug(name: &str) -> String {
    let mut s: String = name
        .trim()
        .chars()
        .map(|c| match c {
            ' ' => '-',
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c => c,
        })
        .collect();
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    if s.is_empty() {
        s.push_str("project");
    }
    s
}

/// Batched existence check for a list of project directories.
///
/// `cleanStaleProjects` runs at startup over every recent project. Doing one
/// IPC call per project meant N round-trips on every cold boot; this batches
/// them into a single call and parallelizes the disk checks via rayon.
#[tauri::command]
pub async fn projects_path_valid(project_paths: Vec<String>) -> Vec<bool> {
    use rayon::prelude::*;
    project_paths
        .par_iter()
        .map(|project_path| {
            let path = PathBuf::from(project_path);
            if !path.is_dir() {
                return false;
            }
            path.join("mod.config.json").is_file()
                || path.join("flint.json").is_file()
                || path.join("project.json").is_file()
        })
        .collect()
}

/// List files in a project directory
///
/// # Arguments
/// * `project_path` - Path to the project directory
///
/// # Returns
/// * `Ok(FileTree)` - The file tree structure
/// * `Err(String)` - Error message if listing failed
#[tauri::command]
pub async fn list_project_files(project_path: String) -> Result<serde_json::Value, String> {
    let _t = ipc_trace::enter("list_project_files");
    use serde_json::{json, Map, Value};
    use std::collections::HashMap;
    use std::path::PathBuf as StdPathBuf;
    use walkdir::WalkDir;

    let path = PathBuf::from(&project_path);

    if !path.exists() {
        return Err(format!("Project path does not exist: {}", project_path));
    }

    // Iterative tree builder — avoids the stack overflow that the old recursive
    // rayon version caused on rayon worker threads (small stack + deep WAD dirs).
    //
    // Algorithm:
    //   1. WalkDir collects all entries depth-first (dir before its children).
    //   2. We pre-allocate a Map for every directory keyed by its absolute path.
    //   3. We iterate in REVERSE order so every child is fully assembled before
    //      we encounter its parent — then we pop the child's map out of the
    //      HashMap and embed it as "children" in the parent's map.
    fn build_tree(root: &std::path::Path, base: &std::path::Path) -> Value {
        let entries: Vec<_> = WalkDir::new(root)
            .into_iter()
            .filter_map(|e| e.ok())
            .skip(1) // skip the root itself
            .filter(|e| !e.file_name().to_string_lossy().ends_with(".ritobin"))
            .collect();

        // Pre-allocate children maps for every directory.
        let mut dir_maps: HashMap<StdPathBuf, Map<String, Value>> = HashMap::new();
        dir_maps.insert(root.to_path_buf(), Map::new());
        for e in &entries {
            if e.file_type().is_dir() {
                dir_maps.insert(e.path().to_path_buf(), Map::new());
            }
        }

        // Process in reverse depth-first order: leaves → root.
        for entry in entries.into_iter().rev() {
            let entry_path = entry.path().to_path_buf();
            let parent = match entry_path.parent() {
                Some(p) => p.to_path_buf(),
                None => continue,
            };
            let name = entry_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let rel = entry_path
                .strip_prefix(base)
                .unwrap_or(&entry_path)
                .to_string_lossy()
                .replace('\\', "/");

            let node = if entry.file_type().is_dir() {
                // Pop the pre-assembled children map for this dir.
                let children = dir_maps.remove(&entry_path).unwrap_or_default();
                json!({ "path": rel, "children": Value::Object(children) })
            } else {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                json!({ "path": rel, "size": size })
            };

            if let Some(parent_map) = dir_maps.get_mut(&parent) {
                parent_map.insert(name, node);
            }
        }

        Value::Object(dir_maps.remove(root).unwrap_or_default())
    }

    let tree = tokio::task::spawn_blocking(move || build_tree(&path, &path))
        .await
        .map_err(|e| format!("Task failed: {}", e))?;

    Ok(tree)
}

/// Combined open + list-files. One IPC round-trip replacing the
/// `open_project` + `list_project_files` sequence used in
/// [FileTree.handleOpenProject] every time the user opens a project.
#[derive(serde::Serialize)]
pub struct OpenProjectWithTree {
    pub project: Project,
    pub file_tree: serde_json::Value,
}

#[tauri::command]
pub async fn open_project_with_tree(path: String) -> Result<OpenProjectWithTree, String> {
    let _t = ipc_trace::enter("open_project_with_tree");
    let project = open_project(path).await?;
    let project_path = project.project_path.to_string_lossy().to_string();
    let file_tree = list_project_files(project_path).await?;
    Ok(OpenProjectWithTree { project, file_tree })
}

/// Pre-convert all BIN files in a project to .ritobin format
/// This enables instant loading when the user opens BIN files later
///
/// Uses parallel processing with rayon for maximum performance.
/// BIN hashes are cached globally to avoid repeated disk I/O.
///
/// # Arguments
/// * `project_path` - Path to the project directory
/// * `app` - Tauri app handle for emitting progress events
///
/// # Returns
/// * `Ok(usize)` - Number of BIN files converted
/// * `Err(String)` - Error message if conversion failed
#[tauri::command]
pub async fn preconvert_project_bins(
    project_path: String,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use rayon::prelude::*;
    use walkdir::WalkDir;
    
    tracing::info!("Pre-converting BIN files in project: {}", project_path);
    
    let path = std::path::PathBuf::from(&project_path);
    if !path.exists() {
        return Err(format!("Project path does not exist: {}", project_path));
    }
    
    // Pre-warm the hash cache before parallel processing
    // This ensures the cache is initialized on the main thread before workers access it
    tracing::info!("Pre-warming BIN hash cache...");
    let _ = flint_ltk::bin::get_cached_bin_hashes();
    tracing::info!("Hash cache ready");
    
    // Find all .bin files
    let bin_files: Vec<_> = WalkDir::new(&path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().extension()
                .map(|ext| ext == "bin")
                .unwrap_or(false)
        })
        .filter(|e| {
            if let Ok(rel_path) = e.path().strip_prefix(&path) {
                let rel_str = rel_path.to_string_lossy();
                let category = classify_bin(&rel_str);
                
                // Skip Ignore category (corrupt/recursive names)
                if category == BinCategory::Ignore {
                    tracing::warn!("Skipping suspicious BIN file: {}", rel_str);
                    return false;
                }
                
                // Skip Animation BINs - they shouldn't be pre-converted and can have corrupt metadata
                if category == BinCategory::Animation {
                    tracing::debug!("Skipping animation BIN: {}", rel_str);
                    return false;
                }
                
                // Skip ChampionRoot BINs - these reference game data and shouldn't be converted
                if category == BinCategory::ChampionRoot {
                    tracing::debug!("Skipping champion root BIN: {}", rel_str);
                    return false;
                }
            }
            true
        })
        .map(|e| e.path().to_path_buf())
        .collect();
    
    let total = bin_files.len();
    tracing::info!("Found {} BIN files to convert", total);
    
    // Emit initial progress
    let _ = app.emit("bin-convert-progress", serde_json::json!({
        "current": 0,
        "total": total,
        "file": "",
        "status": "starting"
    }));
    
    // Filter to only files that need conversion (not already up-to-date)
    let files_to_convert: Vec<_> = bin_files.iter()
        .filter(|bin_path| {
            let ritobin_path = format!("{}.ritobin", bin_path.display());
            let ritobin_file = std::path::Path::new(&ritobin_path);
            
            if ritobin_file.exists() {
                if let (Ok(bin_meta), Ok(ritobin_meta)) = (fs::metadata(bin_path), fs::metadata(ritobin_file)) {
                    if let (Ok(bin_time), Ok(ritobin_time)) = (bin_meta.modified(), ritobin_meta.modified()) {
                        if ritobin_time >= bin_time {
                            tracing::debug!("[PRECONVERT] CACHE HIT - skipping: {}", bin_path.file_name().unwrap_or_default().to_string_lossy());
                            return false;
                        } else {
                            tracing::debug!("[PRECONVERT] CACHE STALE - will convert: {}", bin_path.file_name().unwrap_or_default().to_string_lossy());
                        }
                    }
                }
            } else {
                tracing::debug!("[PRECONVERT] NO CACHE - will convert: {}", bin_path.file_name().unwrap_or_default().to_string_lossy());
            }
            true
        })
        .cloned()
        .collect();
    
    let cache_hits = total - files_to_convert.len();
    let to_convert_count = files_to_convert.len();
    tracing::info!("[PRECONVERT] {} files need conversion, {} CACHE HITS (already up-to-date)", 
        to_convert_count, cache_hits);
    
    // Atomic counter for thread-safe progress tracking
    let converted = Arc::new(AtomicUsize::new(0));
    let failed = Arc::new(AtomicUsize::new(0));
    
    // Process in batches to control peak memory usage
    const BATCH_SIZE: usize = 50;
    
    for (batch_idx, batch) in files_to_convert.chunks(BATCH_SIZE).enumerate() {
        let batch_start = batch_idx * BATCH_SIZE;
        
        // Emit progress for batch start
        let _ = app.emit("bin-convert-progress", serde_json::json!({
            "current": batch_start,
            "total": to_convert_count,
            "file": format!("Batch {}/{}", batch_idx + 1, to_convert_count.div_ceil(BATCH_SIZE)),
            "status": "converting"
        }));
        
        // Process batch in parallel using rayon
        let converted_clone = Arc::clone(&converted);
        let failed_clone = Arc::clone(&failed);
        
        batch.par_iter().for_each(|bin_path| {
            let bin_path_str = bin_path.to_string_lossy().to_string();
            
            match convert_bin_file_sync(&bin_path_str) {
                Ok(_) => {
                    converted_clone.fetch_add(1, Ordering::Relaxed);
                    tracing::debug!("Converted: {}", bin_path.display());
                }
                Err(e) => {
                    failed_clone.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!("Failed to convert {}: {}", bin_path.display(), e);
                }
            }
        });
        
        // Log batch completion
        let current_converted = converted.load(Ordering::Relaxed);
        tracing::info!("Batch {} complete: {} converted so far", batch_idx + 1, current_converted);
    }
    
    let final_converted = converted.load(Ordering::Relaxed);
    let final_failed = failed.load(Ordering::Relaxed);
    
    // Emit completion
    let _ = app.emit("bin-convert-progress", serde_json::json!({
        "current": total,
        "total": total,
        "file": "",
        "status": "complete"
    }));
    
    tracing::info!("Pre-converted {} BIN files ({} failed, {} skipped)", 
        final_converted, final_failed, total - to_convert_count);
    Ok(final_converted)
}

/// Synchronous helper function to convert a single BIN file to ritobin
/// Used by parallel processing (rayon doesn't work well with async)
fn convert_bin_file_sync(bin_path: &str) -> Result<(), String> {
    use std::fs;
    use flint_ltk::bin::{read_bin_ltk, tree_to_text_cached, MAX_BIN_SIZE};
    
    // Check file size before reading to avoid loading huge corrupt files
    let metadata = fs::metadata(bin_path)
        .map_err(|e| format!("Failed to get file metadata for '{}': {}", bin_path, e))?;
    
    let file_size = metadata.len() as usize;
    
    // Reject suspiciously large files (using the same limit as ltk_bridge)
    if file_size > MAX_BIN_SIZE {
        return Err(format!(
            "BIN file too large ({} bytes, max {} bytes) - likely corrupt, skipping: {}",
            file_size, MAX_BIN_SIZE, bin_path
        ));
    }
    
    let data = fs::read(bin_path)
        .map_err(|e| format!("Failed to read file '{}': {}", bin_path, e))?;

    let bin = read_bin_ltk(&data)
        .map_err(|e| format!("Failed to parse bin file '{}': {}", bin_path, e))?;

    // Use cached hash resolution for performance
    let text = tree_to_text_cached(&bin)
        .map_err(|e| format!("Failed to convert to text for '{}': {}", bin_path, e))?;

    let ritobin_path = format!("{}.ritobin", bin_path);
    fs::write(&ritobin_path, &text)
        .map_err(|e| format!("Failed to write ritobin '{}': {}", ritobin_path, e))?;

    Ok(())
}

/// Delete a project and all its files
///
/// # Arguments
/// * `project_path` - Path to the project directory
///
/// # Returns
/// * `Ok(())` - If deletion succeeded
/// * `Err(String)` - Error message if deletion failed
#[tauri::command]
pub async fn delete_project(project_path: String) -> Result<(), String> {
    tracing::info!("Frontend requested deleting project: {}", project_path);

    let path = PathBuf::from(&project_path);

    if !path.exists() {
        return Err(format!("Project path does not exist: {}", project_path));
    }

    tokio::task::spawn_blocking(move || {
        std::fs::remove_dir_all(&path)
            .map_err(|e| format!("Failed to delete project: {}", e))
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer creation
//
// "Add Layer" is the user-facing flow for cloning categorized assets out of an
// existing layer (typically `base`) into a new sibling layer under `content/`.
// It writes the new layer to `mod.config.json` so modpkg / fantome readers see
// it, and copies only the files matching the requested categories.
// ─────────────────────────────────────────────────────────────────────────────

/// File categories the layer modal exposes. The frontend sends these as
/// lower-case strings; unknown values are ignored.
///
/// `Model` is the only category that needs context from the file walk:
/// when the user picks "Models", they expect the meshes to keep working,
/// which means pulling in the textures sitting next to them. Standalone
/// "all textures" copying isn't a useful primitive — the user has to know
/// *which* textures they want — so it's been folded into Model. If a future
/// power-user flow needs raw texture cloning, it can land as its own action.
///
/// `Particle` sweeps related `.bin` files in the same `particles/` folder,
/// since VFX work is split between the texture/anim files and the BIN that
/// binds them together.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LayerCategory {
    Animation,
    Model,
    Particle,
    Audio,
}

impl LayerCategory {
    fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "animation" | "animations" | "anim" => Some(Self::Animation),
            "model" | "models" | "mesh" => Some(Self::Model),
            "particle" | "particles" | "vfx" => Some(Self::Particle),
            "audio" | "sound" | "sounds" | "sfx" => Some(Self::Audio),
            _ => None,
        }
    }
}

const MODEL_EXTS: &[&str] = &["skn", "scb", "sco", "skl"];
const TEXTURE_EXTS: &[&str] = &["tex", "dds"];

/// Returns true if `rel_path` (forward-slashed, layer-relative) belongs to any
/// of the selected categories. `model_dirs` is a pre-computed set of layer-
/// relative directories that contain at least one model file — when Model is
/// selected, textures inside any of those dirs (or their subdirs) come along
/// for the ride so the model isn't dead on arrival in the new layer.
fn matches_categories(
    rel_path: &str,
    cats: &[LayerCategory],
    model_dirs: &std::collections::HashSet<String>,
) -> bool {
    let lower = rel_path.to_ascii_lowercase();
    let ext = Path::new(&lower)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    for cat in cats {
        let hit = match cat {
            LayerCategory::Animation => {
                ext == "anm" || lower.contains("/animations/")
            }
            LayerCategory::Model => {
                if MODEL_EXTS.contains(&ext) {
                    true
                } else if TEXTURE_EXTS.contains(&ext) {
                    // Texture only counts when it sits in (or under) a folder
                    // that holds a mesh. League's per-skin layout is shallow
                    // enough that this catches the relevant SkinXX/textures/
                    // and same-folder lookups without dragging in unrelated
                    // HUD/UI textures.
                    is_under_any(&lower, model_dirs)
                } else {
                    false
                }
            }
            LayerCategory::Particle => {
                // VFX assets live under particles/, plus the BINs that wire
                // them together. Match anything inside a particles/ folder
                // (covers *.troybin, *.tex used for vfx, and the bin glue).
                lower.contains("/particles/")
                    || lower.contains("/vfx/")
                    || (ext == "bin" && (lower.contains("vfx") || lower.contains("particle")))
            }
            LayerCategory::Audio => {
                matches!(ext, "bnk" | "wpk" | "wem")
                    || lower.contains("/sounds/")
                    || lower.contains("/sfx/")
                    || lower.contains("/vo/")
            }
        };
        if hit {
            return true;
        }
    }
    false
}

/// True if `path_lower` lives inside any of the directories in `dirs`
/// (which are themselves stored lower-cased and forward-slashed).
fn is_under_any(path_lower: &str, dirs: &std::collections::HashSet<String>) -> bool {
    for d in dirs {
        if d.is_empty() {
            // Model file at the layer root → all textures at the root match.
            // Wouldn't happen in normal projects, but guard against it.
            return true;
        }
        if path_lower.starts_with(d) {
            // Make sure we matched a directory boundary, not a prefix like
            // "skin1" matching "skin10".
            let rest = &path_lower[d.len()..];
            if rest.starts_with('/') {
                return true;
            }
        }
    }
    false
}

#[derive(Debug, Serialize)]
pub struct CreateLayerResult {
    pub layer_name: String,
    pub layer_path: String,
    pub files_copied: usize,
    pub bytes_copied: u64,
}

/// Create a new mod-project layer under `content/<layer_name>/` by copying
/// categorized files out of `source_layer` and registering the layer in
/// `mod.config.json`.
///
/// # Arguments
/// * `project_path` — absolute path to the project root.
/// * `layer_name` — new layer slug (lower-case letters, digits, `_`/`-`).
/// * `source_layer` — name of an existing layer to seed from (e.g. `"base"`).
/// * `categories` — file categories to copy. Empty vec creates an empty layer.
/// * `description` — optional description recorded in `mod.config.json`.
/// * `priority` — optional explicit priority. When `None`, picks
///   `max(existing) + 1` so the new layer overrides everything.
#[tauri::command]
pub async fn create_project_layer(
    project_path: String,
    layer_name: String,
    source_layer: String,
    categories: Vec<String>,
    description: Option<String>,
    priority: Option<i32>,
) -> Result<CreateLayerResult, String> {
    let _t = ipc_trace::enter("create_project_layer");

    // Validate the slug up front — modpkg readers reject anything else.
    let slug = layer_name.trim().to_string();
    if slug.is_empty() {
        return Err("Layer name cannot be empty".to_string());
    }
    if !slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(
            "Layer name may only contain letters, digits, underscores, and hyphens"
                .to_string(),
        );
    }

    let project_root = PathBuf::from(&project_path);
    if !project_root.exists() {
        return Err(format!("Project path does not exist: {}", project_path));
    }

    let source_root = project_root.join("content").join(&source_layer);
    if !source_root.is_dir() {
        return Err(format!(
            "Source layer not found: content/{}",
            source_layer
        ));
    }

    let dest_root = project_root.join("content").join(&slug);
    if dest_root.exists() {
        return Err(format!("Layer already exists: content/{}", slug));
    }

    let parsed_cats: Vec<LayerCategory> = categories
        .iter()
        .filter_map(|c| LayerCategory::parse(c))
        .collect();

    // Heavy work (filesystem walk + copy + JSON rewrite) goes onto the blocking
    // pool so we don't park the tauri runtime for what may be 100s of MB.
    let dest_root_for_task = dest_root.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<CreateLayerResult, String> {
        std::fs::create_dir_all(&dest_root_for_task)
            .map_err(|e| format!("Failed to create layer directory: {}", e))?;

        // Pass 1 — collect directories that hold model files. Skipped when
        // the user didn't tick the Model category, since the set isn't used.
        let mut model_dirs: std::collections::HashSet<String> = std::collections::HashSet::new();
        if parsed_cats.contains(&LayerCategory::Model) {
            for entry in walkdir::WalkDir::new(&source_root).min_depth(1) {
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                if !entry.file_type().is_file() {
                    continue;
                }
                let abs = entry.path();
                let ext = abs
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.to_ascii_lowercase())
                    .unwrap_or_default();
                if !MODEL_EXTS.contains(&ext.as_str()) {
                    continue;
                }
                let rel = match abs.strip_prefix(&source_root) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                if let Some(parent) = rel.parent() {
                    let dir = parent.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
                    model_dirs.insert(dir);
                }
            }
        }

        let mut files_copied = 0usize;
        let mut bytes_copied = 0u64;

        // Pass 2 — categorize and copy.
        for entry in walkdir::WalkDir::new(&source_root).min_depth(1) {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let abs = entry.path();
            let rel = match abs.strip_prefix(&source_root) {
                Ok(r) => r,
                Err(_) => continue,
            };
            // .ritobin is a generated cache file — never duplicate it into a
            // sibling layer; the user re-converts on demand.
            if abs.extension().and_then(|e| e.to_str()) == Some("ritobin") {
                continue;
            }
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if !parsed_cats.is_empty()
                && !matches_categories(&rel_str, &parsed_cats, &model_dirs)
            {
                continue;
            }
            let target = dest_root_for_task.join(rel);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create directory: {}", e))?;
            }
            let copied = std::fs::copy(abs, &target)
                .map_err(|e| format!("Failed to copy {}: {}", rel_str, e))?;
            files_copied += 1;
            bytes_copied += copied;
        }

        Ok(CreateLayerResult {
            layer_name: String::new(), // filled in below
            layer_path: String::new(),
            files_copied,
            bytes_copied,
        })
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))??;

    // Update mod.config.json — load → push layer → save. We avoid the full
    // `Project` round-trip because that also rewrites flint.json, which has
    // nothing to do with layers.
    let config_path = project_root.join("mod.config.json");
    if config_path.is_file() {
        let raw = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read mod.config.json: {}", e))?;
        let mut config: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| format!("mod.config.json is not valid JSON: {}", e))?;

        let layers = config
            .as_object_mut()
            .ok_or_else(|| "mod.config.json root must be an object".to_string())?
            .entry("layers")
            .or_insert_with(|| serde_json::Value::Array(Vec::new()));
        let layers_arr = layers
            .as_array_mut()
            .ok_or_else(|| "mod.config.json `layers` is not an array".to_string())?;

        // Refuse to register a duplicate name — the on-disk check above
        // catches the folder, but the JSON could have a stale entry.
        if layers_arr.iter().any(|l| {
            l.get("name").and_then(|n| n.as_str()) == Some(slug.as_str())
        }) {
            return Err(format!(
                "Layer '{}' already exists in mod.config.json",
                slug
            ));
        }

        let resolved_priority = priority.unwrap_or_else(|| {
            let max = layers_arr
                .iter()
                .filter_map(|l| l.get("priority").and_then(|p| p.as_i64()))
                .max()
                .unwrap_or(0);
            (max as i32) + 1
        });

        let mut entry = serde_json::Map::new();
        entry.insert("name".into(), serde_json::Value::String(slug.clone()));
        entry.insert(
            "priority".into(),
            serde_json::Value::Number(resolved_priority.into()),
        );
        if let Some(desc) = description.as_ref().filter(|d| !d.trim().is_empty()) {
            entry.insert("description".into(), serde_json::Value::String(desc.clone()));
        }
        layers_arr.push(serde_json::Value::Object(entry));

        let pretty = serde_json::to_string_pretty(&config)
            .map_err(|e| format!("Failed to serialize mod.config.json: {}", e))?;
        std::fs::write(&config_path, pretty)
            .map_err(|e| format!("Failed to write mod.config.json: {}", e))?;
    }

    Ok(CreateLayerResult {
        layer_name: slug,
        layer_path: format!("content/{}", layer_name),
        files_copied: result.files_copied,
        bytes_copied: result.bytes_copied,
    })
}

/// List the layer names currently registered in `mod.config.json`. The
/// frontend uses this to populate the "source layer" dropdown in the
/// add-layer modal without round-tripping `list_project_files`.
#[tauri::command]
pub async fn list_project_layers(project_path: String) -> Result<Vec<String>, String> {
    let _t = ipc_trace::enter("list_project_layers");
    let config_path = PathBuf::from(&project_path).join("mod.config.json");
    if !config_path.is_file() {
        // Brand-new projects always have at least the base layer on disk.
        return Ok(vec!["base".to_string()]);
    }
    let raw = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read mod.config.json: {}", e))?;
    let config: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("mod.config.json is not valid JSON: {}", e))?;
    let mut names: Vec<String> = config
        .get("layers")
        .and_then(|l| l.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|l| l.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if names.is_empty() {
        names.push("base".to_string());
    }
    Ok(names)
}

