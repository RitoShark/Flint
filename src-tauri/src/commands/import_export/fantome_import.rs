//! Tauri commands for importing Fantome WAD mods into Flint projects
//!
//! Provides analysis and import of Fantome-packaged mods, with automatic
//! champion/skin detection, refathering, and missing file matching from
//! the live League installation.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::fs::File;
use std::io::BufReader;
use tauri::{AppHandle, Emitter, State};
use zip::ZipArchive;

use flint_ltk::hash::lmdb_cache::{get_or_open_env, resolve_hashes_lmdb};
use flint_ltk::wad_jade::adapter::WadHandle as WadReader;
use flint_ltk::project::Project;
use crate::state::LmdbCacheState;

// =============================================================================
// Types
// =============================================================================

/// Metadata from Fantome package META/info.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FantomeMetadata {
    #[serde(
        rename = "Author",
        alias = "author",
        alias = "AUTHOR",
        default
    )]
    pub author: Option<String>,
    #[serde(
        rename = "Name",
        alias = "name",
        alias = "NAME",
        default
    )]
    pub name: Option<String>,
    #[serde(
        rename = "Description",
        alias = "description",
        alias = "DESCRIPTION",
        default
    )]
    pub description: Option<String>,
    #[serde(
        rename = "Version",
        alias = "version",
        alias = "VERSION",
        default
    )]
    pub version: Option<String>,
}

/// Analysis result of a Fantome WAD file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FantomeAnalysis {
    /// Detected champion name (if any)
    pub champion: Option<String>,
    /// Detected skin IDs from BIN files
    pub skin_ids: Vec<u32>,
    /// Whether this appears to be a champion mod
    pub is_champion_mod: bool,
    /// Total number of files in the WAD
    pub file_count: usize,
    /// Sample of file paths (first 50)
    pub file_paths: Vec<String>,
    /// Metadata from META/info.json (if available)
    pub metadata: Option<FantomeMetadata>,
}

/// Options for importing a Fantome WAD
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportOptions {
    /// Whether to perform refathering (path prefixing)
    pub refather: bool,
    /// Creator name for refathering
    pub creator_name: Option<String>,
    /// Project name for refathering
    pub project_name: Option<String>,
    /// Target skin ID for refathering (if remapping)
    pub target_skin_id: Option<u32>,
    /// Whether to clean up unused files after refathering
    pub cleanup_unused: bool,
    /// Whether to match missing files from live League
    pub match_from_league: bool,
    /// Path to League installation (for file matching)
    pub league_path: Option<String>,
    /// Use Jade engine for BIN parsing (instead of LTK)
    pub use_jade: Option<bool>,
}

// =============================================================================
// Fantome Package Handling
// =============================================================================

/// Read metadata from META/info.json in a .fantome package
fn read_fantome_metadata(fantome_path: &str) -> Option<FantomeMetadata> {
    let file = File::open(fantome_path).ok()?;
    let mut archive = ZipArchive::new(BufReader::new(file)).ok()?;

    // Look for META/info.json
    for i in 0..archive.len() {
        let mut file_entry = archive.by_index(i).ok()?;
        let name = file_entry.name();

        if name.eq_ignore_ascii_case("META/info.json") || name.eq_ignore_ascii_case("info.json") {
            let mut contents = String::new();
            std::io::Read::read_to_string(&mut file_entry, &mut contents).ok()?;

            match serde_json::from_str::<FantomeMetadata>(&contents) {
                Ok(metadata) => {
                    tracing::info!("Found Fantome metadata: {:?}", metadata);
                    return Some(metadata);
                }
                Err(e) => {
                    tracing::warn!("Failed to parse info.json: {}. Contents: {}", e, contents);
                    // Try to extract fields manually as fallback
                    if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(&contents) {
                        let author = json_value.get("Author")
                            .or_else(|| json_value.get("author"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let name = json_value.get("Name")
                            .or_else(|| json_value.get("name"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let description = json_value.get("Description")
                            .or_else(|| json_value.get("description"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let version = json_value.get("Version")
                            .or_else(|| json_value.get("version"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());

                        let metadata = FantomeMetadata {
                            author,
                            name,
                            description,
                            version,
                        };
                        tracing::info!("Manually extracted Fantome metadata: {:?}", metadata);
                        return Some(metadata);
                    }
                    return None;
                }
            }
        }
    }

    None
}

/// Extract WAD file from a .fantome package (ZIP archive)
/// Returns the path to the extracted WAD file in a temp directory
fn extract_fantome_wad(fantome_path: &str) -> Result<PathBuf, String> {
    let file = File::open(fantome_path)
        .map_err(|e| format!("Failed to open fantome file: {}", e))?;

    let mut archive = ZipArchive::new(BufReader::new(file))
        .map_err(|e| format!("Failed to read fantome archive: {}", e))?;

    // Find the first .wad.client file in the archive (usually in WAD/ folder)
    let mut wad_file_name = None;
    for i in 0..archive.len() {
        let file_entry = archive.by_index(i)
            .map_err(|e| format!("Failed to read archive entry: {}", e))?;
        let name = file_entry.name().to_string();

        if name.ends_with(".wad.client") || name.ends_with(".wad") {
            wad_file_name = Some(name.clone());
            break;
        }
    }

    let wad_name = wad_file_name
        .ok_or("No .wad.client file found in fantome package")?;

    // Extract to temp directory
    let temp_dir = std::env::temp_dir().join("flint_fantome_import");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp directory: {}", e))?;

    let wad_path = temp_dir.join(wad_name.replace('/', "_"));

    // Extract the WAD file
    let mut zip_file = archive.by_name(&wad_name)
        .map_err(|e| format!("Failed to find WAD in archive: {}", e))?;

    let mut wad_file = File::create(&wad_path)
        .map_err(|e| format!("Failed to create temp WAD file: {}", e))?;

    std::io::copy(&mut zip_file, &mut wad_file)
        .map_err(|e| format!("Failed to extract WAD file: {}", e))?;

    tracing::info!("Extracted WAD from fantome: {} -> {:?}", wad_name, wad_path);

    Ok(wad_path)
}

/// Determine the actual WAD path (extract from .fantome if needed)
fn resolve_wad_path(input_path: &str) -> Result<(PathBuf, bool), String> {
    let path = Path::new(input_path);
    let is_fantome = input_path.ends_with(".fantome") ||
                     input_path.ends_with(".zip");

    if is_fantome {
        // Extract WAD from fantome package
        let wad_path = extract_fantome_wad(input_path)?;
        Ok((wad_path, true))
    } else {
        // Direct WAD file
        Ok((path.to_path_buf(), false))
    }
}

// =============================================================================
// Champion/Skin Detection
// =============================================================================

/// Extract champion name from a file path
/// E.g., "characters/aurora/..." -> "aurora"
pub(crate) fn extract_champion_from_path(path: &str) -> Option<String> {
    let lower = path.to_lowercase();

    // Try "characters/{champion}/" pattern
    if let Some(start_idx) = lower.find("characters/") {
        let after_characters = &lower[start_idx + 11..];
        if let Some(end_idx) = after_characters.find('/') {
            let champion = &after_characters[..end_idx];
            if !champion.is_empty() {
                return Some(champion.to_string());
            }
        }
    }

    // Try "assets/characters/{champion}/" pattern
    if let Some(start_idx) = lower.find("assets/characters/") {
        let after_characters = &lower[start_idx + 18..];
        if let Some(end_idx) = after_characters.find('/') {
            let champion = &after_characters[..end_idx];
            if !champion.is_empty() {
                return Some(champion.to_string());
            }
        }
    }

    None
}

/// Extract skin ID from a path
/// E.g., "skins/skin5/..." -> Some(5)
pub(crate) fn extract_skin_id_from_path(path: &str) -> Option<u32> {
    let lower = path.to_lowercase();

    // Look for "skin{N}" pattern
    if let Some(start_idx) = lower.find("skin") {
        let after_skin = &lower[start_idx + 4..];
        // Extract digits immediately after "skin"
        let digits: String = after_skin.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if !digits.is_empty() {
            return digits.parse::<u32>().ok();
        }
    }

    None
}

/// Extract the most common champion name from a list of paths
pub(crate) fn extract_champion_from_paths(paths: &[String]) -> Option<String> {
    let mut champion_counts: HashMap<String, usize> = HashMap::new();

    for path in paths {
        if let Some(champ) = extract_champion_from_path(path) {
            *champion_counts.entry(champ).or_insert(0) += 1;
        }
    }

    // Return the most common champion
    champion_counts.into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(champ, _)| champ)
}

/// Match missing files from the League installation
/// This copies linked BIN files and other missing assets from the live game
fn match_missing_files_from_league(
    output_path: &Path,
    league_path: &str,
    hash_dir: &str,
    champion: &str,
    existing_hashes: &HashSet<u64>,
) -> Result<(), String> {
    use flint_ltk::wad_jade::adapter::find_champion_wad;
    use walkdir::WalkDir;

    tracing::info!("Matching missing files from League installation for {}", champion);

    // Pass league_path directly - find_champion_wad already handles joining "Game"
    tracing::debug!("Looking for champion WAD in: {}", league_path);

    let champion_wad = find_champion_wad(league_path, champion)
        .ok_or_else(|| format!("Could not find {} WAD in League installation (league_path: {})", champion, league_path))?;

    tracing::info!("Found champion WAD: {}", champion_wad.display());

    // Open the champion WAD
    let mut wad_reader = WadReader::open(champion_wad.to_str().unwrap())
        .map_err(|e| format!("Failed to open champion WAD: {}", e))?;

    // Get LMDB environment for hash resolution
    let env = get_or_open_env(hash_dir)
        .ok_or("Failed to open LMDB environment")?;

    // Find all BIN files in the extracted mod and collect their linked BIN paths
    let mut linked_bin_paths = HashSet::new();

    for entry in WalkDir::new(output_path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("bin"))
                .unwrap_or(false)
        })
    {
        let bin_path = entry.path();

        // Read linked BIN paths from this BIN file
        if let Ok(bin_data) = std::fs::read(bin_path) {
            if let Ok(linked_paths) = extract_linked_bin_paths(&bin_data) {
                for path in linked_paths {
                    linked_bin_paths.insert(path);
                }
            }
        }
    }

    if linked_bin_paths.is_empty() {
        tracing::info!("No linked BIN paths found in extracted mod");
        return Ok(());
    }

    tracing::info!("Found {} linked BIN references", linked_bin_paths.len());

    // Collect all chunks from the champion WAD
    let all_wad_hashes: Vec<u64> = wad_reader.chunks().iter().map(|c| c.path_hash).collect();
    let all_wad_paths = resolve_hashes_lmdb(&all_wad_hashes, &env);

    // Build a map of path -> hash for quick lookup
    let mut path_to_hash: HashMap<String, u64> = HashMap::new();
    for (hash, path) in all_wad_hashes.iter().zip(all_wad_paths.iter()) {
        path_to_hash.insert(path.to_lowercase(), *hash);
    }

    // Extract missing linked BIN files
    let mut extracted_missing = 0;

    for linked_path in &linked_bin_paths {
        let linked_lower = linked_path.to_lowercase();

        // Try exact match first
        if let Some(&hash) = path_to_hash.get(&linked_lower) {
            // Check if we already have this file
            if existing_hashes.contains(&hash) {
                continue;
            }

            // Get chunk (copy it to avoid borrow checker issues)
            let chunk_copy = wad_reader.chunks().get(hash).copied();

            // Extract this file from the champion WAD
            if let Some(chunk) = chunk_copy {
                if let Ok(data) = wad_reader.wad_mut().load_chunk_decompressed(&chunk) {
                    let file_path = output_path.join(linked_path.trim_start_matches('/'));
                    if let Some(parent) = file_path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    if std::fs::write(&file_path, data).is_ok() {
                        tracing::debug!("Extracted missing file: {}", linked_path);
                        extracted_missing += 1;
                    }
                }
            }
            continue;
        }

        // Try without .bin extension (for newer skin IDs)
        // E.g., if skin42.bin isn't found, try skin42
        if linked_lower.ends_with(".bin") {
            let without_ext = linked_lower.strip_suffix(".bin").unwrap();
            if let Some(&hash) = path_to_hash.get(without_ext) {
                if existing_hashes.contains(&hash) {
                    continue;
                }

                // Get chunk (copy it to avoid borrow checker issues)
                let chunk_copy = wad_reader.chunks().get(hash).copied();

                // Extract this file
                if let Some(chunk) = chunk_copy {
                    if let Ok(data) = wad_reader.wad_mut().load_chunk_decompressed(&chunk) {
                        // Write with the original path (with .bin extension)
                        let file_path = output_path.join(linked_path.trim_start_matches('/'));
                        if let Some(parent) = file_path.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        if std::fs::write(&file_path, data).is_ok() {
                            tracing::debug!("Extracted missing file (without .bin): {}", linked_path);
                            extracted_missing += 1;
                        }
                    }
                }
            }
        }
    }

    tracing::info!("Extracted {} missing linked files from League installation", extracted_missing);
    Ok(())
}

/// Check if a path is an unresolved hash (16 hex characters)
fn is_unresolved_hash(path: &str) -> bool {
    // Get the filename without directory
    let filename = path.rsplit('/').next().unwrap_or(path);

    // Check if it's exactly 16 hex characters (no extension)
    filename.len() == 16 && filename.chars().all(|c| c.is_ascii_hexdigit())
}

/// Extract linked BIN paths from a BIN file's binary data
/// Uses simple pattern matching to find BIN path strings
fn extract_linked_bin_paths(bin_data: &[u8]) -> Result<Vec<String>, String> {
    let mut linked_paths = Vec::new();

    // Simple approach: scan for ASCII strings that look like BIN paths
    // Pattern: must contain "data/characters/" or "assets/" and end with ".bin"
    let text = String::from_utf8_lossy(bin_data);
    let mut start = 0;

    while let Some(pos) = text[start..].find("/skins/") {
        let absolute_pos = start + pos;

        // Find the start of the path (look backwards for start of string)
        let path_start = text[..absolute_pos]
            .rfind(|c: char| !c.is_ascii() && c != '/' && c != '_' && c != '.' && !c.is_alphanumeric())
            .map(|p| p + 1)
            .unwrap_or(0);

        // Find the end of the path (look forward for .bin)
        if let Some(bin_end) = text[absolute_pos..].find(".bin") {
            let path_end = absolute_pos + bin_end + 4; // +4 for ".bin"
            let potential_path = &text[path_start..path_end];

            // Validate that this looks like a real path
            if potential_path.starts_with("data/") || potential_path.starts_with("assets/") {
                let path_str = potential_path.to_string();
                if !linked_paths.contains(&path_str) {
                    linked_paths.push(path_str);
                    tracing::debug!("Found linked BIN path: {}", potential_path);
                }
            }
        }

        start = absolute_pos + 1;
    }

    Ok(linked_paths)
}

/// Apply refathering to the extracted mod files
fn apply_refathering(
    content_path: &Path,
    creator_name: &str,
    project_name: &str,
    champion: &str,
    target_skin_id: u32,
    path_mappings: &HashMap<String, String>,
    use_jade: bool,
) -> Result<(), String> {
    use flint_ltk::repath::organizer::{organize_project, OrganizerConfig};

    tracing::info!("Applying refathering to imported mod...");

    let config = OrganizerConfig {
        enable_concat: true,
        enable_repath: true,
        creator_name: creator_name.to_string(),
        project_name: project_name.to_string(),
        champion: champion.to_string(),
        target_skin_id,
        // DON'T cleanup for imports - pre-repathed VFX/particles won't be in BIN references
        cleanup_unused: false,
        use_jade_engine: use_jade,
        wad_folder_override: None,
    };

    organize_project(content_path, &config, path_mappings)
        .map_err(|e| e.to_string())?;

    tracing::info!("Refathering completed successfully");
    Ok(())
}

// =============================================================================
// Commands
// =============================================================================

/// Analyze a Fantome WAD file to detect champion, skin IDs, and mod type
#[tauri::command]
pub async fn analyze_fantome(
    wad_path: String,
    _lmdb_state: State<'_, LmdbCacheState>,
) -> Result<FantomeAnalysis, String> {
    // Get hash directory before spawning blocking task
    let hash_dir = flint_ltk::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("Hash directory not found: {}", e))?;

    tokio::task::spawn_blocking(move || {
        analyze_fantome_internal(&wad_path, &hash_dir)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

fn analyze_fantome_internal(
    wad_path: &str,
    hash_dir: &str,
) -> Result<FantomeAnalysis, String> {
    // Try to read metadata from .fantome package
    let metadata = if wad_path.ends_with(".fantome") || wad_path.ends_with(".zip") {
        read_fantome_metadata(wad_path)
    } else {
        None
    };

    // Resolve WAD path (extract from .fantome if needed)
    let (resolved_wad_path, _is_temp) = resolve_wad_path(wad_path)?;

    // Open WAD file
    let reader = WadReader::open(resolved_wad_path.to_str().unwrap())
        .map_err(|e| format!("Failed to open WAD file: {}", e))?;

    let chunks = reader.chunks();
    let file_count = chunks.len();

    // Collect all path hashes
    let hashes: Vec<u64> = chunks.iter().map(|chunk| chunk.path_hash).collect();

    // Resolve hashes using LMDB
    let env = get_or_open_env(hash_dir)
        .ok_or("Failed to open LMDB environment")?;

    let resolved_paths = resolve_hashes_lmdb(&hashes, &env);

    // Detect champion from paths
    let mut champion_candidates = HashSet::new();
    for path in &resolved_paths {
        if let Some(champ) = extract_champion_from_path(path) {
            champion_candidates.insert(champ);
        }
    }

    // Detect skin IDs from paths
    let mut skin_id_candidates = HashSet::new();
    for path in &resolved_paths {
        if let Some(skin_id) = extract_skin_id_from_path(path) {
            skin_id_candidates.insert(skin_id);
        }
    }

    // BIN-based detection disabled for now - path-based detection above should be sufficient
    // TODO: Implement proper BIN parsing for more accurate champion/skin detection

    // Determine final champion (pick most common or first)
    let champion = champion_candidates.into_iter().next();

    // Determine if this is a champion mod
    let is_champion_mod = champion.is_some();

    // Get skin IDs as sorted vec
    let mut skin_ids: Vec<u32> = skin_id_candidates.into_iter().collect();
    skin_ids.sort_unstable();

    // Get sample file paths (first 50)
    let file_paths = resolved_paths.into_iter().take(50).collect();

    Ok(FantomeAnalysis {
        champion,
        skin_ids,
        is_champion_mod,
        file_count,
        file_paths,
        metadata,
    })
}

/// Import a Fantome WAD into a Flint project
#[tauri::command]
pub async fn import_fantome_wad(
    app: AppHandle,
    wad_path: String,
    project_dir: String,
    options: ImportOptions,
    _lmdb_state: State<'_, LmdbCacheState>,
) -> Result<Project, String> {
    // Get hash directory before spawning blocking task
    let hash_dir = flint_ltk::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("Hash directory not found: {}", e))?;

    tokio::task::spawn_blocking(move || {
        import_fantome_internal(&app, &wad_path, &project_dir, &options, &hash_dir)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

fn import_fantome_internal(
    app: &AppHandle,
    wad_path: &str,
    project_dir: &str,
    options: &ImportOptions,
    hash_dir: &str,
) -> Result<Project, String> {
    use flint_ltk::project::save_project as core_save_project;

    let _ = app.emit("fantome-import-progress", serde_json::json!({
        "status": "starting",
        "message": "Initializing import..."
    }));

    let project_path = Path::new(project_dir);

    // Create project directory structure
    std::fs::create_dir_all(project_path)
        .map_err(|e| format!("Failed to create project directory: {}", e))?;

    let content_path = project_path.join("content");
    std::fs::create_dir_all(&content_path)
        .map_err(|e| format!("Failed to create content directory: {}", e))?;

    let _ = app.emit("fantome-import-progress", serde_json::json!({
        "status": "progress",
        "message": "Opening WAD archive..."
    }));

    // Resolve WAD path (extract from .fantome if needed)
    let (resolved_wad_path, _is_temp) = resolve_wad_path(wad_path)?;

    // Open WAD
    let mut reader = WadReader::open(resolved_wad_path.to_str().unwrap())
        .map_err(|e| format!("Failed to open WAD file: {}", e))?;

    // Collect chunk hashes and resolve paths before mutably borrowing reader
    let (chunk_hashes, resolved_paths) = {
        let chunks = reader.chunks();
        let hashes: Vec<u64> = chunks.iter().map(|chunk| chunk.path_hash).collect();

        let _ = app.emit("fantome-import-progress", serde_json::json!({
            "status": "progress",
            "message": format!("Resolving {} file paths...", hashes.len())
        }));

        let env = get_or_open_env(hash_dir)
            .ok_or("Failed to open LMDB environment")?;

        let resolved_paths = resolve_hashes_lmdb(&hashes, &env);

        (hashes, resolved_paths)
    };

    // Detect champion from paths to create proper WAD folder structure
    let champion = extract_champion_from_paths(&resolved_paths)
        .ok_or("Failed to detect champion from paths")?;

    // Create WAD folder structure: content/{champion}.wad.client/
    let champion_lower = champion.to_lowercase();
    let wad_folder_name = format!("{}.wad.client", champion_lower);
    let wad_base = content_path.join(&wad_folder_name);
    std::fs::create_dir_all(&wad_base)
        .map_err(|e| format!("Failed to create WAD folder: {}", e))?;

    tracing::info!("Extracting to WAD folder: {}", wad_base.display());

    let _ = app.emit("fantome-import-progress", serde_json::json!({
        "status": "progress",
        "message": format!("Extracting {} files...", chunk_hashes.len())
    }));

    // Extract all chunks by hash into WAD folder
    let mut extracted_count = 0;
    let mut path_mappings = HashMap::new();

    let mut unresolved_count = 0;
    let total_files = chunk_hashes.len();

    for (hash, path) in chunk_hashes.iter().zip(resolved_paths.iter()) {
        // SKIP testcuberenderer files - these are debug assets that shouldn't be in mods
        let path_lower = path.to_lowercase();
        if path_lower.contains("testcuberenderer") {
            tracing::debug!("Skipping testcuberenderer file: {}", path);
            continue;
        }

        // Get chunk by hash (copy it to end the immutable borrow)
        let chunk = *reader.chunks().get(*hash)
            .ok_or_else(|| format!("Chunk not found for hash: {:x}", hash))?;

        // Decompress chunk
        let data = reader.wad_mut().load_chunk_decompressed(&chunk)
            .map_err(|e| format!("Failed to decompress chunk: {}", e))?;

        // Track unresolved hashes but DON'T reorganize them - keep as-is
        // Custom repathed mods reference files by hash, moving them breaks everything
        if is_unresolved_hash(path) {
            unresolved_count += 1;
            tracing::debug!("Unresolved hash (custom path): {}", path);
        }

        let final_path = path.clone();

        // Write to WAD folder (not root content folder)
        let file_path = wad_base.join(final_path.trim_start_matches('/'));
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }

        std::fs::write(&file_path, &data)
            .map_err(|e| format!("Failed to write file: {}", e))?;

        // Track path mappings for refathering (hash -> final path used)
        path_mappings.insert(format!("{:016x}", hash), final_path);
        extracted_count += 1;

        // Emit progress every 10% or every 50 files (whichever is smaller)
        let progress_interval = (total_files / 10).max(50).min(total_files);
        if extracted_count % progress_interval == 0 || extracted_count == total_files {
            let _ = app.emit("fantome-import-progress", serde_json::json!({
                "status": "progress",
                "message": format!("Extracting files... ({}/{})", extracted_count, total_files)
            }));
        }
    }

    if unresolved_count > 0 {
        tracing::warn!(
            "Found {} unresolved hashes (custom repathed files) - preserving as-is",
            unresolved_count
        );
    }

    tracing::info!("Extracted {} files from Fantome WAD to {}", extracted_count, wad_folder_name);

    // Convert chunk_hashes to HashSet for efficient lookup
    let existing_hashes: HashSet<u64> = chunk_hashes.iter().copied().collect();

    // Match missing files from League installation if enabled
    if options.match_from_league {
        if let Some(ref league_path) = options.league_path {
            let _ = app.emit("fantome-import-progress", serde_json::json!({
                "status": "progress",
                "message": "Matching missing files from League..."
            }));

            match_missing_files_from_league(
                &wad_base,
                league_path,
                hash_dir,
                &champion,
                &existing_hashes,
            ).map_err(|e| format!("Failed to match missing files: {}", e))?;
        }
    }

    // Read Fantome metadata (author, name, description, version)
    let fantome_metadata = if wad_path.ends_with(".fantome") || wad_path.ends_with(".zip") {
        read_fantome_metadata(wad_path)
    } else {
        None
    };

    // Get project metadata - use Fantome metadata if available, otherwise use options or defaults
    let creator_name = fantome_metadata.as_ref()
        .and_then(|m| m.author.as_deref())
        .or(options.creator_name.as_deref())
        .unwrap_or("FlintUser");

    let project_name = fantome_metadata.as_ref()
        .and_then(|m| m.name.as_deref())
        .or(options.project_name.as_deref())
        .unwrap_or("ImportedMod");

    let description = fantome_metadata.as_ref()
        .and_then(|m| m.description.as_deref())
        .map(|s| s.to_string());

    let version = fantome_metadata.as_ref()
        .and_then(|m| m.version.as_deref())
        .map(|s| s.to_string());

    let target_skin_id = options.target_skin_id.unwrap_or(0);
    let league_path_buf = options.league_path.as_ref().map(PathBuf::from);

    tracing::info!(
        "Import metadata: creator='{}', project='{}', champion='{}', skin={}, version={:?}, description={:?}",
        creator_name, project_name, champion, target_skin_id, version, description
    );

    // Apply refathering if enabled
    if options.refather {
        let _ = app.emit("fantome-import-progress", serde_json::json!({
            "status": "progress",
            "message": "Applying refathering (organizing files)..."
        }));

        apply_refathering(
            &content_path,
            creator_name,
            project_name,
            &champion,
            target_skin_id,
            &path_mappings,
            options.use_jade.unwrap_or(false),
        ).map_err(|e| format!("Failed to apply refathering: {}", e))?;
    }

    // Create project metadata
    let mut project = Project::new(
        project_name,
        &champion,
        target_skin_id,
        league_path_buf.unwrap_or_else(|| PathBuf::from("")),
        project_path,
        Some(creator_name.to_string()),
    );

    // Override with Fantome metadata if available
    if let Some(desc) = description {
        project.description = desc;
    }
    if let Some(ver) = version {
        project.version = ver;
    }

    let _ = app.emit("fantome-import-progress", serde_json::json!({
        "status": "progress",
        "message": "Saving project metadata..."
    }));

    // Save project files (mod.config.json and flint.json)
    core_save_project(&project)
        .map_err(|e| format!("Failed to save project: {}", e))?;

    tracing::info!("Fantome import complete: {} files imported to {}", extracted_count, project_dir);

    let _ = app.emit("fantome-import-progress", serde_json::json!({
        "status": "complete",
        "message": format!("Import complete! {} files imported", extracted_count)
    }));

    Ok(project)
}
