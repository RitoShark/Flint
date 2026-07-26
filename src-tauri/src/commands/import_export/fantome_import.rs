use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::fs::File;
use std::io::BufReader;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use zip::ZipArchive;

use flint_ltk::hash::{HashResolver, ProjectHashOverlay};
use flint_ltk::wad_jade::adapter::WadHandle as WadReader;
use flint_ltk::project::Project;
use crate::state::{HashOverlayState, LmdbCacheState};

// =============================================================================
// Types
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FantomeMetadata {
    #[serde(
        alias = "Author",
        alias = "author",
        alias = "AUTHOR",
        default
    )]
    pub author: Option<String>,
    #[serde(
        alias = "Name",
        alias = "name",
        alias = "NAME",
        default
    )]
    pub name: Option<String>,
    #[serde(
        alias = "Description",
        alias = "description",
        alias = "DESCRIPTION",
        default
    )]
    pub description: Option<String>,
    #[serde(
        alias = "Version",
        alias = "version",
        alias = "VERSION",
        default
    )]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FantomeAnalysis {
    pub champion: Option<String>,
    pub skin_ids: Vec<u32>,
    pub is_champion_mod: bool,
    pub file_count: usize,
    pub file_paths: Vec<String>,
    pub metadata: Option<FantomeMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportOptions {
    pub refather: bool,
    pub creator_name: Option<String>,
    pub project_name: Option<String>,
    pub champion: Option<String>,
    pub target_skin_id: Option<u32>,
    pub cleanup_unused: bool,
    pub match_from_league: bool,
    pub league_path: Option<String>,
}

// =============================================================================
// Extraction & Analysis
// =============================================================================

pub(crate) fn guess_extension(data: &[u8]) -> &'static str {
    use ritoshark::file::{FileKind, detect};
    match detect(data) {
        FileKind::PropBin | FileKind::PatchBin => "bin",
        FileKind::Tex => "tex",
        FileKind::Dds => "dds",
        FileKind::SkinnedMesh => "skn",
        FileKind::Skeleton => "skl",
        FileKind::AnimUncompressed | FileKind::AnimCompressed => "anm",
        FileKind::Bnk => "bnk",
        FileKind::Wpk => "wpk",
        FileKind::MapGeo => "mapgeo",
        FileKind::StaticMeshText => "sco",
        FileKind::StaticMeshBinary => "scb",
        FileKind::Rst => "stringtable",
        FileKind::Wad | FileKind::Rman | FileKind::Unknown => {
            if data.len() >= 4 {
                let head = &data[..4];
                if head == b"OggS" { return "ogg"; }
                if head == b"\x89PNG" { return "png"; }
                if head == b"RIFF" { return "wem"; }
                if data.starts_with(b"\xff\xd8\xff") { return "jpg"; }
                if data.starts_with(b"{") { return "json"; }
            }
            "dat"
        }
    }
}

/// Open a `.fantome` (zip) with actionable diagnostics. A plain
/// `ZipArchive::new` failure surfaces as a bare "invalid Zip archive" — this
/// sniffs the header so the error says what the file ACTUALLY is (RAR/7z/
/// modpkg/HTML error page/bare WAD/empty download), and recovers zips whose
/// central directory is broken (truncated downloads) by streaming the intact
/// local entries into a rebuilt temp zip.
pub(crate) fn open_fantome_zip(fantome_path: &str) -> Result<ZipArchive<BufReader<File>>, String> {
    let file = File::open(fantome_path)
        .map_err(|e| format!("Failed to open fantome file: {}", e))?;
    if file.metadata().map(|m| m.len()).unwrap_or(0) == 0 {
        return Err("The .fantome file is empty (0 bytes) — the download likely failed. Re-download the mod.".into());
    }

    let zip_err = match ZipArchive::new(BufReader::new(file)) {
        Ok(archive) => return Ok(archive),
        Err(e) => e,
    };

    let mut head = [0u8; 8];
    let n = File::open(fantome_path)
        .and_then(|mut f| std::io::Read::read(&mut f, &mut head))
        .unwrap_or(0);
    let head = &head[..n];

    if head.starts_with(b"Rar!") {
        return Err("This file is a RAR archive renamed to .fantome. Extract it and re-zip the contents (META/ + WAD/) as a normal zip, or ask the mod author for a real .fantome.".into());
    }
    if head.starts_with(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) {
        return Err("This file is a 7-Zip archive renamed to .fantome. Extract it and re-zip the contents (META/ + WAD/) as a normal zip.".into());
    }
    if head.starts_with(b"_modpkg_") {
        return Err("This file is a .modpkg renamed to .fantome. Rename it back to .modpkg and import it again.".into());
    }
    if head.starts_with(b"RW") {
        return Err("This file is a bare .wad.client renamed to .fantome. Rename it back to .wad.client and import that directly.".into());
    }
    if head.starts_with(b"<") {
        return Err("This file is an HTML page, not a mod — the site returned an error page instead of the download. Re-download the mod.".into());
    }
    if !head.starts_with(b"PK") {
        return Err(format!(
            "Not a zip archive (file starts with {:02X?}) — the file is corrupt or not a .fantome. Zip error: {}",
            head, zip_err
        ));
    }

    // It IS a zip (local-header magic present) but the central directory is
    // unreadable — the classic symptom of a truncated/incomplete download.
    // Recover whatever entries are intact.
    match recover_truncated_zip(fantome_path) {
        Ok((recovered_path, count)) => {
            tracing::warn!(
                "Fantome '{}' has a broken central directory ({}); recovered {} entries via streaming read -> {:?}",
                fantome_path, zip_err, count, recovered_path
            );
            let f = File::open(&recovered_path)
                .map_err(|e| format!("Failed to reopen recovered zip: {}", e))?;
            ZipArchive::new(BufReader::new(f))
                .map_err(|e| format!("Recovered zip is unreadable: {}", e))
        }
        Err(recover_err) => Err(format!(
            "The .fantome zip is corrupt ({}) and no entries could be recovered ({}). The download is likely incomplete — re-download the mod.",
            zip_err, recover_err
        )),
    }
}

/// Rebuild a valid zip from the readable local file entries of a zip whose
/// central directory is broken. Returns the rebuilt path and entry count.
/// The output name is derived from (path, size, mtime) so repeated opens of
/// the same broken file reuse one recovery instead of re-streaming it.
fn recover_truncated_zip(fantome_path: &str) -> Result<(PathBuf, usize), String> {
    use std::hash::{Hash, Hasher};
    use std::io::{Read, Write};

    let src_meta = std::fs::metadata(fantome_path).map_err(|e| format!("stat: {}", e))?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    fantome_path.hash(&mut h);
    src_meta.len().hash(&mut h);
    if let Ok(m) = src_meta.modified() {
        if let Ok(d) = m.duration_since(std::time::UNIX_EPOCH) {
            d.as_secs().hash(&mut h);
        }
    }

    let temp_dir = std::env::temp_dir().join("flint_fantome_import");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp directory: {}", e))?;
    let out_path = temp_dir.join(format!("recovered_{:016x}.fantome", h.finish()));

    if out_path.exists() {
        if let Ok(f) = File::open(&out_path) {
            if let Ok(z) = ZipArchive::new(BufReader::new(f)) {
                return Ok((out_path, z.len()));
            }
        }
    }

    let mut reader = BufReader::new(
        File::open(fantome_path).map_err(|e| format!("open: {}", e))?,
    );
    let out = File::create(&out_path).map_err(|e| format!("create: {}", e))?;
    let mut writer = zip::ZipWriter::new(out);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true);

    let mut count = 0usize;
    loop {
        match zip::read::read_zipfile_from_stream(&mut reader) {
            Ok(Some(mut entry)) => {
                if entry.is_dir() {
                    continue;
                }
                let name = entry.name().to_string();
                // Buffer first: a truncated final entry fails mid-read and must
                // not leave a half-written entry in the rebuilt zip.
                let mut data = Vec::new();
                if let Err(e) = entry.read_to_end(&mut data) {
                    tracing::warn!("Zip recovery: entry '{}' is truncated ({}); stopping", name, e);
                    break;
                }
                writer.start_file(name, opts).map_err(|e| format!("write entry: {}", e))?;
                writer.write_all(&data).map_err(|e| format!("write entry data: {}", e))?;
                count += 1;
            }
            Ok(None) => break,
            Err(e) => {
                // First unreadable local header — everything before it is saved.
                tracing::warn!("Zip recovery stopped at a broken entry: {}", e);
                break;
            }
        }
    }
    writer.finish().map_err(|e| format!("finalize recovered zip: {}", e))?;

    if count == 0 {
        let _ = std::fs::remove_file(&out_path);
        return Err("no entries were readable".into());
    }
    Ok((out_path, count))
}

fn read_fantome_metadata(fantome_path: &str) -> Option<FantomeMetadata> {
    let mut archive = open_fantome_zip(fantome_path).ok()?;

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

/// If a zip entry belongs to a WAD stored as a FOLDER (`.../<name>.wad.client/…`),
/// return the WAD folder's basename. Some fantomes ship the WAD unpacked as a
/// directory tree; launchers pack it on import, and so do we.
fn fantome_folder_wad_name(entry_name: &str) -> Option<String> {
    let lower = entry_name.to_lowercase();
    for marker in [".wad.client/", ".wad/"] {
        if let Some(pos) = lower.find(marker) {
            let dir_end = pos + marker.len() - 1;
            let base = entry_name[..dir_end].rsplit('/').next().unwrap_or_default().to_string();
            if !base.is_empty() {
                return Some(base);
            }
        }
    }
    None
}

fn extract_fantome_wad(fantome_path: &str) -> Result<PathBuf, String> {
    let mut archive = open_fantome_zip(fantome_path)?;

    let mut packed_wad_name: Option<String> = None;
    let mut folder_wad_name: Option<String> = None;
    for i in 0..archive.len() {
        let file_entry = archive.by_index(i)
            .map_err(|e| format!("Failed to read archive entry: {}", e))?;
        let name = file_entry.name().to_string();

        if !file_entry.is_dir() && (name.ends_with(".wad.client") || name.ends_with(".wad")) {
            packed_wad_name = Some(name.clone());
            break;
        }
        if folder_wad_name.is_none() {
            folder_wad_name = fantome_folder_wad_name(&name);
        }
    }

    let temp_dir = std::env::temp_dir().join("flint_fantome_import");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp directory: {}", e))?;

    // Packed-file WAD: copy the single entry out.
    if let Some(wad_name) = packed_wad_name {
        let wad_path = temp_dir.join(wad_name.replace('/', "_"));
        let mut zip_file = archive.by_name(&wad_name)
            .map_err(|e| format!("Failed to find WAD in archive: {}", e))?;
        let mut wad_file = File::create(&wad_path)
            .map_err(|e| format!("Failed to create temp WAD file: {}", e))?;
        std::io::copy(&mut zip_file, &mut wad_file)
            .map_err(|e| format!("Failed to extract WAD file: {}", e))?;
        tracing::info!("Extracted WAD from fantome: {} -> {:?}", wad_name, wad_path);
        return Ok(wad_path);
    }

    // Folder-form WAD: extract the sub-tree and PACK it into a real WAD (what
    // launchers do on import) so the rest of the pipeline sees a valid WAD.
    let wad_name = folder_wad_name
        .ok_or("No .wad.client file or folder found in fantome package")?;
    let scratch = temp_dir.join(format!("{}.waddir", wad_name.replace('/', "_")));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch)
        .map_err(|e| format!("Failed to create scratch directory: {}", e))?;

    let marker_dir = format!("{}/", wad_name.to_lowercase());
    let mut extracted = 0usize;
    for i in 0..archive.len() {
        let mut e = archive.by_index(i)
            .map_err(|err| format!("Failed to read archive entry: {}", err))?;
        let name = e.name().to_string();
        if e.is_dir() || fantome_folder_wad_name(&name).as_deref() != Some(wad_name.as_str()) {
            continue;
        }
        let lower = name.to_lowercase();
        let Some(pos) = lower.find(&marker_dir) else { continue };
        let rel = &name[pos + marker_dir.len()..];
        if rel.is_empty() {
            continue;
        }
        let dest = scratch.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|err| format!("mkdir: {}", err))?;
        }
        let mut f = File::create(&dest).map_err(|err| format!("create: {}", err))?;
        std::io::copy(&mut e, &mut f).map_err(|err| format!("extract: {}", err))?;
        extracted += 1;
    }
    if extracted == 0 {
        let _ = std::fs::remove_dir_all(&scratch);
        return Err("No .wad.client file or folder found in fantome package".into());
    }

    let wad_bytes = flint_ltk::export::build_wad_from_directory(&scratch)?;
    let wad_path = temp_dir.join(wad_name.replace('/', "_"));
    std::fs::write(&wad_path, &wad_bytes)
        .map_err(|e| format!("Failed to write packed WAD: {}", e))?;
    let _ = std::fs::remove_dir_all(&scratch);
    tracing::info!(
        "Packed folder-form WAD '{}' ({} files) from fantome -> {:?}",
        wad_name, extracted, wad_path
    );
    Ok(wad_path)
}

fn resolve_wad_path(input_path: &str) -> Result<(PathBuf, bool), String> {
    let path = Path::new(input_path);
    let is_fantome = input_path.ends_with(".fantome") ||
                     input_path.ends_with(".zip");

    if is_fantome {
        let wad_path = extract_fantome_wad(input_path)?;
        Ok((wad_path, true))
    } else {
        Ok((path.to_path_buf(), false))
    }
}

// =============================================================================
// Champion/Skin Detection
// =============================================================================

pub(crate) fn extract_champion_from_path(path: &str) -> Option<String> {
    let lower = path.to_lowercase();

    if let Some(start_idx) = lower.find("characters/") {
        let after_characters = &path[start_idx + 11..];
        if let Some(end_idx) = after_characters.find('/') {
            let champion = &after_characters[..end_idx];
            if !champion.is_empty() {
                return Some(champion.to_string());
            }
        }
    }

    if let Some(start_idx) = lower.find("assets/characters/") {
        let after_characters = &path[start_idx + 18..];
        if let Some(end_idx) = after_characters.find('/') {
            let champion = &after_characters[..end_idx];
            if !champion.is_empty() {
                return Some(champion.to_string());
            }
        }
    }

    None
}

pub(crate) fn extract_skin_id_from_path(path: &str) -> Option<u32> {
    let lower = path.to_lowercase();

    if let Some(start_idx) = lower.find("skin") {
        let after_skin = &lower[start_idx + 4..];
        let digits: String = after_skin.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if !digits.is_empty() {
            return digits.parse::<u32>().ok();
        }
    }

    None
}

pub(crate) fn extract_champion_from_paths(paths: &[String]) -> Option<String> {
    let mut champion_counts: HashMap<String, usize> = HashMap::new();

    for path in paths {
        if let Some(champ) = extract_champion_from_path(path) {
            *champion_counts.entry(champ).or_insert(0) += 1;
        }
    }

    champion_counts.into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(champ, _)| champ)
}

pub(crate) fn is_unresolved_hash(path: &str) -> bool {
    let filename = path.rsplit('/').next().unwrap_or(path);
    filename.len() == 16 && filename.chars().all(|c| c.is_ascii_hexdigit())
}

fn apply_refathering(
    content_path: &Path,
    creator_name: &str,
    project_name: &str,
    champion: &str,
    target_skin_id: u32,
    path_mappings: &HashMap<String, String>,
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
        cleanup_unused: false,
        wad_folder_override: None,
        skip_bin_cleanup: true,
        delete_sources: false,
        consolidate_vfx: true,
        cleanup_pipeline: true,
    };

    organize_project(content_path, &config, path_mappings)
        .map_err(|e| e.to_string())?;

    tracing::info!("Refathering completed successfully");
    Ok(())
}

// =============================================================================
// Commands
// =============================================================================

#[tauri::command]
pub async fn analyze_fantome(
    wad_path: String,
    _lmdb_state: State<'_, LmdbCacheState>,
    overlay_state: State<'_, HashOverlayState>,
) -> Result<FantomeAnalysis, String> {
    let hash_dir = flint_ltk::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("Hash directory not found: {}", e))?;
    let overlay = overlay_state.get();

    tokio::task::spawn_blocking(move || {
        analyze_fantome_internal(&wad_path, &hash_dir, overlay)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

fn analyze_fantome_internal(
    wad_path: &str,
    hash_dir: &str,
    overlay: Option<Arc<ProjectHashOverlay>>,
) -> Result<FantomeAnalysis, String> {
    let metadata = if wad_path.ends_with(".fantome") || wad_path.ends_with(".zip") {
        read_fantome_metadata(wad_path)
    } else {
        None
    };

    let (resolved_wad_path, _is_temp) = resolve_wad_path(wad_path)?;

    let reader = WadReader::open(resolved_wad_path.to_str().unwrap())
        .map_err(|e| format!("Failed to open WAD file: {}", e))?;

    let chunks = reader.chunks();
    let file_count = chunks.len();

    let hashes: Vec<u64> = chunks.iter().map(|chunk| chunk.path_hash).collect();

    let resolver = match &overlay {
        Some(o) => HashResolver::with_overlay(hash_dir, Arc::clone(o)),
        None => HashResolver::global(hash_dir),
    };
    if !resolver.has_global_wad() {
        return Err("Hash databases not found. Run hash download first.".to_string());
    }

    let resolved_paths = resolver.resolve_wad(&hashes);

    let mut champion_candidates = HashSet::new();
    for path in &resolved_paths {
        if let Some(champ) = extract_champion_from_path(path) {
            champion_candidates.insert(champ);
        }
    }

    let mut skin_id_candidates = HashSet::new();
    for path in &resolved_paths {
        if let Some(skin_id) = extract_skin_id_from_path(path) {
            skin_id_candidates.insert(skin_id);
        }
    }

    let champion = champion_candidates.into_iter().next();

    let is_champion_mod = champion.is_some();

    let mut skin_ids: Vec<u32> = skin_id_candidates.into_iter().collect();
    skin_ids.sort_unstable();

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

#[tauri::command]
pub async fn import_fantome_wad(
    app: AppHandle,
    wad_path: String,
    project_dir: String,
    options: ImportOptions,
    _lmdb_state: State<'_, LmdbCacheState>,
    overlay_state: State<'_, HashOverlayState>,
) -> Result<Project, String> {
    let hash_dir = flint_ltk::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("Hash directory not found: {}", e))?;
    let overlay = overlay_state.get();

    tokio::task::spawn_blocking(move || {
        import_fantome_internal(&app, &wad_path, &project_dir, &options, &hash_dir, overlay)
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
    overlay: Option<Arc<ProjectHashOverlay>>,
) -> Result<Project, String> {
    use flint_ltk::project::save_project as core_save_project;

    let _ = app.emit("fantome-import-progress", serde_json::json!({
        "status": "starting",
        "message": "Initializing import..."
    }));

    let project_path = Path::new(project_dir);

    std::fs::create_dir_all(project_path)
        .map_err(|e| format!("Failed to create project directory: {}", e))?;

    let content_path = project_path.join("content");
    std::fs::create_dir_all(&content_path)
        .map_err(|e| format!("Failed to create content directory: {}", e))?;

    let _ = app.emit("fantome-import-progress", serde_json::json!({
        "status": "progress",
        "message": "Opening WAD archive..."
    }));

    let (resolved_wad_path, _is_temp) = resolve_wad_path(wad_path)?;

    let mut reader = WadReader::open(resolved_wad_path.to_str().unwrap())
        .map_err(|e| format!("Failed to open WAD file: {}", e))?;

    let (chunk_hashes, resolved_paths) = {
        let chunks = reader.chunks();
        let hashes: Vec<u64> = chunks.iter().map(|chunk| chunk.path_hash).collect();

        let _ = app.emit("fantome-import-progress", serde_json::json!({
            "status": "progress",
            "message": format!("Resolving {} file paths...", hashes.len())
        }));

        let resolver = match &overlay {
            Some(o) => HashResolver::with_overlay(hash_dir, Arc::clone(o)),
            None => HashResolver::global(hash_dir),
        };
        if !resolver.has_global_wad() {
            return Err("Hash databases not found. Run hash download first.".to_string());
        }

        let resolved_paths = resolver.resolve_wad(&hashes);

        (hashes, resolved_paths)
    };

    let champion = options.champion.clone().or_else(|| {
        extract_champion_from_paths(&resolved_paths)
    }).ok_or("Failed to detect champion from paths, and no champion provided")?;

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

    let mut extracted_count = 0;
    let mut path_mappings = HashMap::new();
    let mut unresolved_files = Vec::new();

    let mut unresolved_count = 0;
    let total_files = chunk_hashes.len();

    for (hash, path) in chunk_hashes.iter().zip(resolved_paths.iter()) {
        let path_lower = path.to_lowercase();
        if path_lower.contains("testcuberenderer") {
            tracing::debug!("Skipping testcuberenderer file: {}", path);
            continue;
        }

        let chunk = *reader.chunks().get(*hash)
            .ok_or_else(|| format!("Chunk not found for hash: {:x}", hash))?;

        let data = reader.wad_mut().load_chunk_decompressed(&chunk)
            .map_err(|e| format!("Failed to decompress chunk: {}", e))?;

        let mut final_path = PathBuf::from(path.clone());
        let mut is_unresolved = false;
        if is_unresolved_hash(path) {
            unresolved_count += 1;
            is_unresolved = true;
            tracing::debug!("Unresolved hash (custom path): {}", path);
            let ext = guess_extension(&data);
            final_path.set_extension(ext);
        }

        let filename_len = final_path.to_string_lossy().len();

        let out_path = if filename_len > 200 {
            let parent = final_path.parent().unwrap_or_else(|| Path::new("data"));
            let ext = final_path.extension().and_then(|e| e.to_str()).unwrap_or("bin");
            let hash_name = format!("{:016x}.{}", hash, ext);
            let hash_path = parent.join(&hash_name);

            let orig = final_path.to_string_lossy().to_lowercase().replace('\\', "/");
            let act  = hash_path.to_string_lossy().to_lowercase().replace('\\', "/");
            path_mappings.insert(orig, act);

            wad_base.join(hash_path)
        } else {
            wad_base.join(&final_path)
        };

        let file_path = out_path.clone();
        if let Some(p) = file_path.parent() {
            std::fs::create_dir_all(p).unwrap_or_default();
        }

        std::fs::write(&file_path, &data)
            .map_err(|e| format!("Failed to write extracted file: {}", e))?;

        if is_unresolved {
            let ext = final_path.extension().and_then(|e| e.to_str()).unwrap_or("dat").to_string();
            unresolved_files.push((
                *hash,
                ext,
                out_path,
                path.clone(),
            ));
        }

        extracted_count += 1;

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

    // Drop the reader before hash extraction starts so the WAD file handle is released
    drop(reader);

    // Run extract_hashes_from_wad_path after extraction finishes
    let _ = app.emit("fantome-import-progress", serde_json::json!({
        "status": "progress",
        "message": "Extracting and registering path hashes..."
    }));

    let hash_dir_path = Path::new(hash_dir);
    if let Err(e) = crate::commands::wad::extract_hashes::extract_hashes_from_wad_path(&resolved_wad_path, hash_dir_path) {
        tracing::warn!("Failed to auto-unhash WAD file during import: {}", e);
    }

    flint_ltk::hash::lmdb_cache::drop_lmdb_cache();

    // Re-resolve unresolved paths and rename files on disk
    if !unresolved_files.is_empty() {
        let hashes_to_resolve: Vec<u64> = unresolved_files.iter().map(|(h, _, _, _)| *h).collect();
        let resolver = match &overlay {
            Some(o) => HashResolver::with_overlay(hash_dir, Arc::clone(o)),
            None => HashResolver::global(hash_dir),
        };
        let newly_resolved = resolver.resolve_wad(&hashes_to_resolve);

        let mut resolved_count = 0;
        for ((hash, guessed_ext, old_path_on_disk, original_path_key), resolved_path) in unresolved_files.iter().zip(newly_resolved.iter()) {
            if !is_unresolved_hash(resolved_path) {
                // It is now resolved!
                let final_path = PathBuf::from(resolved_path.clone());
                let filename_len = final_path.to_string_lossy().len();

                if filename_len > 200 {
                    let parent = final_path.parent().unwrap_or_else(|| Path::new("data"));
                    let ext = final_path.extension().and_then(|e| e.to_str()).unwrap_or(guessed_ext.as_str());
                    let hash_name = format!("{:016x}.{}", hash, ext);
                    let hash_path = parent.join(&hash_name);

                    let orig = final_path.to_string_lossy().to_lowercase().replace('\\', "/");
                    let act  = hash_path.to_string_lossy().to_lowercase().replace('\\', "/");
                    path_mappings.insert(orig, act);

                    let new_out_path = wad_base.join(hash_path);
                    if old_path_on_disk.exists() {
                        if let Some(p) = new_out_path.parent() {
                            std::fs::create_dir_all(p).unwrap_or_default();
                        }
                        if let Err(e) = std::fs::rename(old_path_on_disk, &new_out_path) {
                            tracing::warn!("Failed to rename resolved long path file: {}", e);
                        }
                    }
                } else {
                    let new_out_path = wad_base.join(&final_path);
                    if old_path_on_disk.exists() {
                        if let Some(p) = new_out_path.parent() {
                            std::fs::create_dir_all(p).unwrap_or_default();
                        }
                        if let Err(e) = std::fs::rename(old_path_on_disk, &new_out_path) {
                            tracing::warn!("Failed to rename resolved file to {}: {}", new_out_path.display(), e);
                        } else {
                            resolved_count += 1;
                        }
                    }
                }
            } else {
                // Still unresolved. Add to path_mappings to map the extensionless path to the file with extension
                let orig = original_path_key.to_lowercase().replace('\\', "/");
                if let Ok(rel_path) = old_path_on_disk.strip_prefix(&wad_base) {
                    let act = rel_path.to_string_lossy().to_lowercase().replace('\\', "/");
                    path_mappings.insert(orig, act);
                }
            }
        }
        tracing::info!("Re-resolved and renamed {}/{} unresolved files after hash extraction", resolved_count, unresolved_files.len());
    }

    let existing_hashes: HashSet<u64> = chunk_hashes.iter().copied().collect();

    if options.match_from_league {
        if let Some(ref league_path) = options.league_path {
            let _ = app.emit("fantome-import-progress", serde_json::json!({
                "status": "progress",
                "message": "Matching missing files from League..."
            }));

            let report = super::missing_files::recover_missing_files_from_league(
                app,
                "fantome-import-progress",
                &wad_base,
                league_path,
                hash_dir,
                overlay.clone(),
                &champion,
                &existing_hashes,
            ).map_err(|e| format!("Failed to recover missing files: {}", e))?;

            tracing::info!(
                "Recovery: {} file(s) pulled from League across {} scanned BIN(s)",
                report.recovered_files,
                report.scanned_bins
            );

            if !report.still_missing.is_empty() {
                tracing::warn!(
                    "{} linked file(s) could not be recovered from League: {:?}",
                    report.still_missing.len(),
                    report.still_missing
                );
                let _ = app.emit("fantome-import-progress", serde_json::json!({
                    "status": "progress",
                    "message": format!("{} referenced file(s) could not be recovered", report.still_missing.len())
                }));
            }
        }
    }

    let fantome_metadata = if wad_path.ends_with(".fantome") || wad_path.ends_with(".zip") {
        read_fantome_metadata(wad_path)
    } else {
        None
    };

    let creator_name = options.creator_name.as_deref()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            fantome_metadata.as_ref()
                .and_then(|m| m.author.as_deref())
        })
        .unwrap_or("FlintUser");

    let project_name = options.project_name.as_deref()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            fantome_metadata.as_ref()
                .and_then(|m| m.name.as_deref())
        })
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
        ).map_err(|e| format!("Failed to apply refathering: {}", e))?;
    }

    let mut project = Project::new(
        project_name,
        &champion,
        target_skin_id,
        league_path_buf.unwrap_or_else(|| PathBuf::from("")),
        project_path,
        Some(creator_name.to_string()),
    );

    if let Some(desc) = description {
        project.description = desc;
    }
    if let Some(ver) = version {
        project.version = ver;
    }

    // Extract thumbnail from the Fantome package if it exists
    if wad_path.ends_with(".fantome") || wad_path.ends_with(".zip") {
        let _ = app.emit("fantome-import-progress", serde_json::json!({
            "status": "progress",
            "message": "Extracting thumbnail image..."
        }));

        if let Err(e) = extract_and_save_fantome_thumbnail(wad_path, project_path) {
            tracing::warn!("Failed to extract/save thumbnail from Fantome: {}", e);
        }
    }

    let _ = app.emit("fantome-import-progress", serde_json::json!({
        "status": "progress",
        "message": "Saving project metadata..."
    }));

    core_save_project(&project)
        .map_err(|e| format!("Failed to save project: {}", e))?;

    tracing::info!("Fantome import complete: {} files imported to {}", extracted_count, project_dir);

    let _ = app.emit("fantome-import-progress", serde_json::json!({
        "status": "complete",
        "message": format!("Import complete! {} files imported", extracted_count)
    }));

    Ok(project)
}

fn extract_and_save_fantome_thumbnail(fantome_path: &str, project_path: &Path) -> Result<(), String> {
    let mut archive = open_fantome_zip(fantome_path)?;

    let mut thumb_entry_index = None;
    for i in 0..archive.len() {
        let file_entry = match archive.by_index(i) {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let name = file_entry.name().to_lowercase();
        if name == "meta/image.png"
            || name == "meta/image.jpg"
            || name == "meta/image.jpeg"
            || name == "meta/thumbnail.png"
            || name == "meta/thumbnail.jpg"
            || name == "meta/thumbnail.jpeg"
            || name == "meta/image.webp"
            || name == "meta/thumbnail.webp"
            || name == "image.png"
            || name == "thumbnail.png"
        {
            thumb_entry_index = Some(i);
            break;
        }
    }

    if let Some(idx) = thumb_entry_index {
        let mut file_entry = archive.by_index(idx)
            .map_err(|e| format!("Failed to open zip entry: {}", e))?;
        let mut img_bytes = Vec::new();
        std::io::copy(&mut file_entry, &mut img_bytes)
            .map_err(|e| format!("Failed to read image bytes: {}", e))?;

        let thumb_path = project_path.join("thumbnail.webp");

        // Try decoding using the image crate and converting to WebP
        if let Ok(img) = image::load_from_memory(&img_bytes) {
            let webp_file = File::create(&thumb_path)
                .map_err(|e| format!("Failed to create thumbnail.webp: {}", e))?;
            let mut writer = std::io::BufWriter::new(webp_file);
            img.write_to(&mut writer, image::ImageFormat::WebP)
                .map_err(|e| format!("Failed to write WebP image: {}", e))?;
            tracing::info!("Saved converted thumbnail to {:?}", thumb_path);
        } else {
            // Fallback: write raw bytes as-is to thumbnail.webp
            std::fs::write(&thumb_path, &img_bytes)
                .map_err(|e| format!("Failed to write fallback thumbnail bytes: {}", e))?;
            tracing::warn!("Failed to decode thumbnail image, saved raw bytes to {:?}", thumb_path);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_champion_from_path() {
        assert_eq!(extract_champion_from_path("assets/characters/Yone/Yone.bin"), Some("Yone".to_string()));
        assert_eq!(extract_champion_from_path("data/characters/Evelynn/Evelynn.bin"), Some("Evelynn".to_string()));
        assert_eq!(extract_champion_from_path("characters/AurelionSol/AurelionSol.bin"), Some("AurelionSol".to_string()));
        assert_eq!(extract_champion_from_path("foo/bar/baz.txt"), None);
    }
}


