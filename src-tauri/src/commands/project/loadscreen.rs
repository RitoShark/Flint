//! Loading-screen project creation and its BIN/spritesheet plumbing.

use flint_core::project::{
    create_project as core_create_project,
    open_project as core_open_project,
    register_in_index as core_register_in_index,
    save_project as core_save_project,
    Project,
};
use crate::core::ipc_trace;
use flint_core::loadscreen::{encode_spritesheet_to_tex, extract_animation_params_from_bin, extract_uibase_from_game, inject_animation_block, AnimationParams};
use std::path::PathBuf;
use tauri::Emitter;
#[tauri::command]
pub async fn create_loading_screen_project(
    request: tauri::ipc::Request<'_>,
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, String> {
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

    // Remaining bytes are the deflated spritesheet.
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

    // Loading-screen projects have no champion: create the standard layout,
    // then convert to the LoadingScreen shape and re-save flint.json.
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
    let anim_params = AnimationParams {
        creator_name: creator_name.clone(),
        sheet_width,
        sheet_height,
        fps,
        total_frames,
        cols,
    };

    let inject_result = tokio::task::spawn_blocking(move || {
        inject_animation_block(
            &uibase_bytes,
            &assets_base_inject,
            &anim_params,
            frame_width,
            frame_height,
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

/// Encode a deflated RGBA spritesheet to League TEX format (in parallel) and
/// write it into the project.
/// Re-extract fresh uibase from game files and re-inject the animation block
/// with the existing spritesheet params (fixing UV along the way).
#[tauri::command]
pub async fn rebuild_loading_screen_bin(
    project_path: String,
    league_path: String,
) -> Result<(), String> {
    let _t = ipc_trace::enter("rebuild_loading_screen_bin");
    tracing::info!("Rebuilding loading screen bin for: {}", project_path);

    let project_path_buf = PathBuf::from(&project_path);
    let league_path_buf = PathBuf::from(&league_path);

    // Open the project to get the assets path
    let project = tokio::task::spawn_blocking({
        let pp = project_path_buf.clone();
        move || core_open_project(&pp)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
    .map_err(|e| format!("Failed to open project: {}", e))?;

    let assets_base = project.assets_path();

    // Read the existing uibase from the project to extract animation params
    let existing_uibase_path = assets_base
        .join("UI.wad.client")
        .join("clientstates")
        .join("loadingscreen")
        .join("ux")
        .join("loadingscreenclassic")
        .join("uibase");

    if !existing_uibase_path.exists() {
        return Err(format!(
            "No existing uibase found at {}. Is this a loading-screen project?",
            existing_uibase_path.display()
        ));
    }

    let existing_uibase_bytes = std::fs::read(&existing_uibase_path)
        .map_err(|e| format!("Failed to read existing uibase: {}", e))?;

    let params = extract_animation_params_from_bin(&existing_uibase_bytes)?;

    // Compute frame dimensions from the extracted params
    let cols_u32 = params.cols as u32;
    if cols_u32 == 0 || params.total_frames < 1.0 {
        return Err(format!(
            "Invalid animation params in project uibase (cols={}, frames={})",
            params.cols, params.total_frames
        ));
    }
    let rows_u32 = (params.total_frames as u32).div_ceil(cols_u32);
    let frame_width = params.sheet_width / cols_u32;
    let frame_height = params.sheet_height / rows_u32;

    tracing::info!(
        "Computed frame dimensions: {}x{} (from {}x{} sheet, {} cols, {} rows)",
        frame_width, frame_height, params.sheet_width, params.sheet_height, cols_u32, rows_u32
    );

    // Extract fresh uibase from the game
    let fresh_uibase_bytes = tokio::task::spawn_blocking({
        let lp = league_path_buf.clone();
        move || extract_uibase_from_game(&lp)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
    .map_err(|e| format!("Failed to extract fresh uibase: {}", e))?;

    // Re-inject the animation block with the extracted params (UV is now fixed
    // in inject_animation_block)
    tokio::task::spawn_blocking({
        let ab = assets_base.clone();
        move || inject_animation_block(&fresh_uibase_bytes, &ab, &params, frame_width, frame_height)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
    .map_err(|e| format!("Failed to re-inject animation block: {}", e))?;

    tracing::info!("Successfully rebuilt loading screen bin for: {}", project_path);
    Ok(())
}

