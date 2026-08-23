//! Tauri commands for project management.

use flint_core::project::{
    create_project as core_create_project,
    open_project as core_open_project,
    register_in_index as core_register_in_index,
    save_project as core_save_project,
    Project,
};
use flint_core::repath::{organize_project, rename_project_asset_prefix, OrganizerConfig, RenameResult};
use flint_core::wad::extractor::{
    find_champion_wad, extract_skin_assets, extract_skin_assets_selective, wad_contains_skin_bin,
};
use flint_core::hash::{resolve_hashes_lmdb_bulk, ResolvedHashes};
use crate::state::LmdbCacheState;
use crate::core::ipc_trace;
use super::tree::purge_from_index;
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

/// Create a new project.
/// Write `files.txt` beside a project's WAD folders, from the bins' trailers.
///
/// Called once after a project is created and repathed — the moment custom
/// paths come into existence. Every bin the repath touched carries a trailer
/// naming what it invented; this collects those into the plain-text record that
/// survives a reserialize and travels in `META/files.txt` on export.
///
/// `<hex> <name>` per line: 8 hex digits is an fnv1a32 object name, 16 is an
/// xxh64 asset path, and a name alone cannot say which. Returns how many names
/// were written. Best-effort — a project with nothing custom writes no file.
fn write_project_files_txt(assets_root: &Path) -> Result<usize, String> {
    use std::collections::BTreeMap;

    let mut per_wad: BTreeMap<PathBuf, BTreeMap<String, String>> = BTreeMap::new();

    for wad_dir in flint_core::export::project_wad_folders(
        assets_root.parent().unwrap_or(assets_root),
    )
    .unwrap_or_default()
    {
        let entries = per_wad.entry(wad_dir.clone()).or_default();
        let mut stack = vec![wad_dir];
        while let Some(dir) = stack.pop() {
            let Ok(read) = std::fs::read_dir(&dir) else { continue };
            for entry in read.flatten() {
                let path = entry.path();
                match entry.file_type() {
                    Ok(t) if t.is_dir() => stack.push(path),
                    Ok(t) if t.is_file() => {
                        if path.extension().is_none_or(|e| !e.eq_ignore_ascii_case("bin")) {
                            continue;
                        }
                        let Ok(bytes) = std::fs::read(&path) else { continue };
                        let Ok(bin) = flint_core::bin::read_bin(&bytes) else { continue };
                        let trailer = flint_core::bin::read_trailer(&bin.trailing);
                        for (hash, name) in &trailer.names {
                            entries.entry(name.clone()).or_insert_with(|| format!("{hash:08x}"));
                        }
                        for (hash, name) in &trailer.files {
                            entries.entry(name.clone()).or_insert_with(|| format!("{hash:016x}"));
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    let mut written = 0usize;
    for (wad_dir, entries) in per_wad {
        if entries.is_empty() {
            continue;
        }
        let contents = entries
            .iter()
            .map(|(name, hex)| format!("{hex} {name}"))
            .collect::<Vec<_>>()
            .join("\n");
        let target = wad_dir.join("files.txt");
        match std::fs::write(&target, contents) {
            Ok(()) => written += entries.len(),
            Err(e) => tracing::warn!("Could not write {}: {e}", target.display()),
        }
    }
    Ok(written)
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_project(
    name: String,
    champion: String,
    skin_id: u32,
    league_path: String,
    output_path: String,
    creator_name: Option<String>,
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

    let _ = app.emit("project-create-progress", serde_json::json!({
        "phase": "init",
        "message": "Initializing..."
    }));

    let hash_dir = flint_core::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let t = Instant::now();
    let env_arc = lmdb.prime(&hash_dir).ok_or_else(||
        "Hash databases not found. Run hash download first.".to_string()
    )?;
    let d = t.elapsed();
    tracing::debug!("[TIMING] LMDB prime: {:?}", d);
    phase_timings.push(("lmdb_prime", d));

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
    tracing::debug!("[TIMING] find_champion_wad: {:?}", d);
    phase_timings.push(("find_champion_wad", d));

    // Verify the requested skin's main BIN is actually inside the WAD (a PBE
    // client may not ship it until the launcher applies the patch).
    let t = Instant::now();
    let skin_bin_present = wad_contains_skin_bin(&wad_path, &champion, skin_id)
        .map_err(|e| format!(
            "Failed to inspect WAD '{}': {}",
            wad_path.display(), e
        ))?;
    let d = t.elapsed();
    tracing::debug!("[TIMING] wad_contains_skin_bin: {:?}", d);
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
    tracing::debug!("[TIMING] core_create_project (mkdir + manifest): {:?}", d);
    phase_timings.push(("core_create_project", d));

    let _ = app.emit("project-create-progress", serde_json::json!({
        "phase": "extract",
        "message": format!("Extracting {} skin {} assets...", champion, skin_id)
    }));

    tracing::info!("Extracting assets for {} skin {}...", champion, skin_id);

    let assets_path = project.assets_path();
    let champion_for_extract = champion.clone();

    let t = Instant::now();
    let extraction_result = tokio::task::spawn_blocking(move || {
        let env = env_arc;
        let resolve = move |hashes: &[u64]| -> ResolvedHashes {
            resolve_hashes_lmdb_bulk(hashes, &env)
        };

        // Selective extraction walks the seed BIN's reference graph and pulls
        // only the chunks the skin needs; falls back to whole-WAD extraction
        // if the seed BIN can't be located or its graph fails to parse.
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
    tracing::debug!("[TIMING] extract_skin_assets: {:?}", extract_elapsed);
    phase_timings.push(("extract_skin_assets", extract_elapsed));

    let extraction_result = match extraction_result {
        Ok(Ok(result)) => {
            tracing::info!("Extracted {} assets to project", result.extracted_count);
            result
        }
        Ok(Err(e)) => {
            tracing::error!("Asset extraction failed: {}", e);
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

    // TFT skips repath but still needs concat.
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
            wad_folder_override: Some("Companions.wad.client".to_string()),
            skip_bin_cleanup: false,
            delete_sources: true,
            consolidate_vfx: false,
            cleanup_pipeline: false,
        };

        let assets_path_for_concat = project.assets_path();
        let path_mappings = extraction_result.path_mappings.clone();
        let t = Instant::now();
        let concat_result = tokio::task::spawn_blocking(move || {
            organize_project(&assets_path_for_concat, &concat_config, &path_mappings)
        })
        .await;
        let d = t.elapsed();
        tracing::debug!("[TIMING] organize_project (concat only, TFT): {:?}", d);
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
                wad_folder_override: None,
                skip_bin_cleanup: false,
                delete_sources: true,
                consolidate_vfx: false,
                cleanup_pipeline: false,
            };

            let assets_path_for_repath = project.assets_path();
            let path_mappings = extraction_result.path_mappings.clone();
            let t = Instant::now();
            let repath_result = tokio::task::spawn_blocking(move || {
                organize_project(&assets_path_for_repath, &repath_config, &path_mappings)
            })
            .await;
            let d = t.elapsed();
            tracing::debug!("[TIMING] organize_project (repath + concat): {:?}", d);
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

                    /* Record the names the repath just invented.
                       Repathing rewrites asset paths to `assets/<creator>/<project>/…`,
                       which exists in no hash dictionary — so the moment a bin holds
                       only the hash, the path is unrecoverable. The bins carry a
                       trailer, but that dies with any reserialize; this writes the
                       same names beside the mod, where they survive it and where
                       export picks them up for `META/files.txt`.

                       A fresh project therefore ships a complete record without the
                       user having to open a single bin in the editor. */
                    let assets_root = project.assets_path();
                    match write_project_files_txt(&assets_root) {
                        Ok(0) => {}
                        Ok(n) => tracing::info!("Recorded {n} custom name(s) in files.txt"),
                        Err(e) => tracing::warn!("Could not write files.txt: {e}"),
                    }
                }
                Ok(Err(e)) => {
                    tracing::warn!("Repathing failed (project still usable): {}", e);
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
    tracing::debug!("[TIMING] === Project creation total: {:?} ===", total);
    for (label, dur) in &phase_timings {
        let pct = (dur.as_secs_f64() / total.as_secs_f64()) * 100.0;
        tracing::debug!("[TIMING]   {:>22}: {:>10?}  ({:>5.1}%)", label, dur, pct);
    }

    Ok(project)
}


/// Create a new animated loading screen project.
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
            flint_core::project::register_in_index(&parent, &project_clone)
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
) -> Result<Vec<flint_core::project::ProjectListing>, String> {
    let root = PathBuf::from(projects_root);
    tokio::task::spawn_blocking(move || flint_core::project::discover_projects(&root))
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
    tokio::task::spawn_blocking(move || flint_core::project::remove_from_index(&root, &pid))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
        .map_err(|e| e.to_string())
}

/// Save project state.
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

    // Rename the project DIRECTORY first, so a failure (e.g. a Windows handle
    // still held on the folder) leaves the project untouched rather than
    // half-renamed.
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

    // Rewrite asset prefix in BINs + rename on-disk asset folders.
    let content_base = work_root.join("content");
    let rename_result: RenameResult = if content_base.is_dir() {
        rename_project_asset_prefix(&content_base, &old_name, &new_slug)
            .map_err(|e| format!("Failed to rewrite asset paths: {}", e))?
    } else {
        RenameResult::default()
    };

    // Update name + display_name and persist config at the new path.
    project.name = new_slug.clone();
    project.display_name = new_name.clone();
    project.project_path = work_root;
    core_save_project(&project).map_err(|e| format!("Failed to save project config: {}", e))?;

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

/// List files in a project directory as a nested file tree.
#[tauri::command]
pub async fn delete_project(
    project_path: String,
    projects_root: Option<String>,
) -> Result<(), String> {
    tracing::info!("Frontend requested deleting project: {}", project_path);

    let path = PathBuf::from(&project_path);
    let root = projects_root.map(PathBuf::from);

    // Read the pid before the folder goes away — afterwards it is unrecoverable.
    let pid = core_open_project(&path).ok().map(|p| p.pid);

    if !path.exists() {
        // Already deleted on disk (e.g. by the user in Explorer). Deletion is
        // idempotent — report success so the caller still drops it from the
        // saved/recents list. Still purge the index: this is what clears rows
        // stranded by a delete that predates index cleanup.
        tracing::info!("Project path already gone, treating delete as success: {}", project_path);
        purge_from_index(&path, root.as_deref(), pid.as_deref());
        return Ok(());
    }

    tokio::task::spawn_blocking(move || {
        match std::fs::remove_dir_all(&path) {
            Ok(()) => {
                purge_from_index(&path, root.as_deref(), pid.as_deref());
                Ok(())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                purge_from_index(&path, root.as_deref(), pid.as_deref());
                Ok(())
            }
            // Folder still on disk (locked file, permissions) — leave the index
            // row alone so the project stays recoverable.
            Err(e) => Err(format!("Failed to delete project: {}", e)),
        }
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


#[cfg(test)]
mod delete_project_tests {
    use super::*;
    use flint_core::project::{read_index, save_project as core_save_project, Project};

    /// Write a real project (mod.config.json + flint.json) and index it.
    fn scaffold(root: &Path, dir_name: &str) -> (PathBuf, String) {
        let project_path = root.join(dir_name);
        std::fs::create_dir_all(&project_path).unwrap();
        let project = Project::new(dir_name, "smolder", 0, PathBuf::new(), &project_path, Some("tester".into()));
        core_save_project(&project).unwrap();
        core_register_in_index(root, &project).unwrap();
        (project_path, project.pid)
    }

    #[tokio::test]
    async fn delete_drops_the_folder_and_its_index_row() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (project_path, _pid) = scaffold(root, "Smolder_Skin0");
        let (keep_path, keep_pid) = scaffold(root, "Ahri_Skin1");

        assert_eq!(read_index(root).entries.len(), 2);

        delete_project(
            project_path.to_string_lossy().into_owned(),
            Some(root.to_string_lossy().into_owned()),
        )
        .await
        .unwrap();

        assert!(!project_path.exists(), "project folder should be gone");
        assert!(keep_path.exists(), "unrelated project must survive");

        // The regression: leaving this row behind is what let discover_projects
        // resurrect the project on the next scan.
        let index = read_index(root);
        assert_eq!(index.entries.len(), 1, "deleted project must leave no index row");
        assert_eq!(index.entries[0].pid, keep_pid);
    }

    #[tokio::test]
    async fn delete_purges_a_row_whose_folder_is_already_gone() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (project_path, _pid) = scaffold(root, "Ghost_Skin0");

        // Simulate the pre-fix state: folder removed, index row stranded.
        std::fs::remove_dir_all(&project_path).unwrap();
        assert_eq!(read_index(root).entries.len(), 1);

        delete_project(
            project_path.to_string_lossy().into_owned(),
            Some(root.to_string_lossy().into_owned()),
        )
        .await
        .unwrap();

        assert!(read_index(root).entries.is_empty(), "stranded ghost row must be purged");
    }

    #[tokio::test]
    async fn delete_without_a_projects_root_still_purges_via_the_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (project_path, _pid) = scaffold(root, "NoRoot_Skin0");

        delete_project(project_path.to_string_lossy().into_owned(), None)
            .await
            .unwrap();

        assert!(read_index(root).entries.is_empty());
    }
}
