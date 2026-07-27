//! Import a raw extracted WAD folder as a Flint project.
//!
//! An extracted `<champion>.wad.client` looks like this on disk:
//!
//! ```text
//! smolder_skin0_extracted_clean/
//!   assets/<creator>/Characters/Smolder/...
//!   data/characters/smolder/skins/skin0.bin
//! ```
//!
//! which is exactly the layout Flint keeps under `content/base/<champion>.wad.client/`.
//! Importing is therefore a detect-then-copy: work out the champion and skin from
//! the `data/characters/...` paths, scaffold `mod.config.json` + `flint.json`
//! around the tree, and drop the files in place. Unlike the Fantome/ModPkg
//! importers there is no WAD to unpack and no hash table to resolve, so this
//! never needs League installed.

use flint_ltk::project::{
    register_in_index, save_project as core_save_project, Project,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

use super::fantome_import::ImportOptions;

/// Mirrors the `fantome-import-progress` / `modpkg-import-progress` channels the
/// project modal already subscribes to.
const PROGRESS_EVENT: &str = "folder-import-progress";

/// Top-level directories that make up WAD content. Anything else in a dropped
/// folder is ignored rather than copied.
const CONTENT_DIRS: [&str; 2] = ["assets", "data"];

#[derive(Debug, Serialize)]
pub struct ExtractedFolderAnalysis {
    /// Already a Flint project — the caller should open it, not import it.
    pub is_flint_project: bool,
    /// Contains `assets/` and/or `data/`, so it is importable.
    pub is_valid: bool,
    pub champion: Option<String>,
    pub skin_id: u32,
    /// Project name suggestion, derived from the folder name.
    pub suggested_name: String,
    pub file_count: usize,
}

// ─────────────────────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────────────────────

/// Champion + skin id from WAD-relative paths.
///
/// Kept pure (operating on strings rather than the filesystem) so the parsing
/// rules can be unit-tested against real-world layouts without fixtures on disk.
/// Paths are expected forward-slashed; matching is case-insensitive because
/// extracted trees mix `Characters/Smolder` with `characters/smolder`.
///
/// A mod may touch several champions (a turret, a ward, a bundled extra), so
/// each candidate is scored rather than taking the first hit: a champion
/// carrying a `skins/skin<N>.bin` outranks one merely present under
/// `data/characters/`, and among equals the one with the most files wins. Only
/// once a champion is chosen does its own lowest skin id decide the skin —
/// comparing skin ids across different champions would let an incidental
/// `skin0.bin` outvote the champion the mod is actually for.
fn detect_from_paths(paths: &[String]) -> (Option<String>, u32) {
    use std::collections::HashMap;

    // champion -> (file hits, lowest skin id seen)
    let mut stats: HashMap<String, (usize, Option<u32>)> = HashMap::new();
    let mut asset_fallback: Option<String> = None;

    for raw in paths {
        let lower = raw.replace('\\', "/").to_lowercase();
        let segs: Vec<&str> = lower.split('/').filter(|s| !s.is_empty()).collect();

        let Some(i) = segs.iter().position(|s| *s == "characters") else { continue };
        let Some(champ) = segs.get(i + 1) else { continue };
        // `assets/<creator>/shared/...` is common; it names no champion.
        if *champ == "shared" { continue; }

        match segs.first() {
            // data/characters/<champ>/skins/skin<N>.bin
            Some(&"data") => {
                let entry = stats.entry((*champ).to_string()).or_insert((0, None));
                entry.0 += 1;
                if segs.get(i + 2) == Some(&"skins") {
                    if let Some(n) = segs.get(i + 3).and_then(|f| parse_skin_bin(f)) {
                        entry.1 = Some(entry.1.map_or(n, |cur| cur.min(n)));
                    }
                }
            }
            // assets/<creator>/Characters/<Champ>/... — weaker signal, used only
            // when there is no `data/` tree at all.
            Some(&"assets") => {
                if asset_fallback.is_none() {
                    asset_fallback = Some((*champ).to_string());
                }
            }
            _ => {}
        }
    }

    let mut ranked: Vec<(String, (usize, Option<u32>))> = stats.into_iter().collect();
    ranked.sort_by(|a, b| {
        let key_a = (a.1 .1.is_some(), a.1 .0);
        let key_b = (b.1 .1.is_some(), b.1 .0);
        // Best first; champion name breaks ties so the result is deterministic.
        key_b.cmp(&key_a).then_with(|| a.0.cmp(&b.0))
    });

    match ranked.into_iter().next() {
        Some((champ, (_, skin))) => (Some(champ), skin.unwrap_or(0)),
        None => (asset_fallback, 0),
    }
}

/// `skin12.bin` → `Some(12)`. Rejects `root.bin` and other non-skin bins.
fn parse_skin_bin(file: &str) -> Option<u32> {
    let stem = file.strip_suffix(".bin")?;
    let digits = stem.strip_prefix("skin")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Collect WAD-relative paths under the content directories, capped so a huge
/// drop can't stall the UI while analysing.
fn collect_relative_paths(root: &Path, limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    for dir in CONTENT_DIRS {
        let start = root.join(dir);
        if start.is_dir() {
            walk_relative(&start, root, &mut out, limit);
        }
    }
    out
}

fn walk_relative(dir: &Path, root: &Path, out: &mut Vec<String>, limit: usize) {
    if out.len() >= limit {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() >= limit {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            walk_relative(&path, root, out, limit);
        } else if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
}

fn count_files(root: &Path) -> usize {
    let mut n = 0;
    for dir in CONTENT_DIRS {
        let start = root.join(dir);
        if start.is_dir() {
            n += count_files_in(&start);
        }
    }
    n
}

fn count_files_in(dir: &Path) -> usize {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    entries
        .flatten()
        .map(|e| {
            let p = e.path();
            if p.is_dir() { count_files_in(&p) } else { 1 }
        })
        .sum()
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/// Classify a dropped/selected folder so the caller can decide between opening
/// it as a project and importing it as raw content.
#[tauri::command]
pub async fn analyze_extracted_folder(folder_path: String) -> Result<ExtractedFolderAnalysis, String> {
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&folder_path);
        if !root.is_dir() {
            return Err(format!("Not a folder: {}", folder_path));
        }

        let is_flint_project = root.join("mod.config.json").is_file();
        let has_content = CONTENT_DIRS.iter().any(|d| root.join(d).is_dir());

        let suggested_name = root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Imported Folder")
            .to_string();

        if !has_content {
            return Ok(ExtractedFolderAnalysis {
                is_flint_project,
                is_valid: false,
                champion: None,
                skin_id: 0,
                suggested_name,
                file_count: 0,
            });
        }

        let paths = collect_relative_paths(&root, 20_000);
        let (champion, skin_id) = detect_from_paths(&paths);

        Ok(ExtractedFolderAnalysis {
            is_flint_project,
            is_valid: true,
            champion,
            skin_id,
            suggested_name,
            file_count: count_files(&root),
        })
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Copy an extracted folder into a fresh project at `project_dir`.
///
/// `project_dir` is a requested location: if it is already taken, a numeric
/// suffix is appended rather than merging into someone else's project, so
/// dropping the same folder twice yields two projects instead of a silent
/// overwrite. The project's real path is on the returned `Project`.
#[tauri::command]
pub async fn import_extracted_folder(
    app: AppHandle,
    folder_path: String,
    project_dir: String,
    options: ImportOptions,
) -> Result<Project, String> {
    tokio::task::spawn_blocking(move || {
        let report = |status: &str, message: &str| emit(&app, status, message);
        let result = perform_import(&folder_path, &project_dir, &options, &report);
        if let Err(e) = &result {
            report("error", e);
        }
        result
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// The import itself, decoupled from Tauri so it can be tested directly.
/// `report(status, message)` receives the same progress beats the command emits.
fn perform_import(
    folder_path: &str,
    project_dir: &str,
    options: &ImportOptions,
    report: &dyn Fn(&str, &str),
) -> Result<Project, String> {
    let source = PathBuf::from(folder_path);
    if !source.is_dir() {
        return Err(format!("Not a folder: {}", folder_path));
    }
    if !CONTENT_DIRS.iter().any(|d| source.join(d).is_dir()) {
        return Err(
            "This folder has no 'assets' or 'data' directory, so it isn't an extracted WAD."
                .to_string(),
        );
    }

    report("progress", "Analyzing folder…");

    let paths = collect_relative_paths(&source, 20_000);
    let (detected_champion, detected_skin) = detect_from_paths(&paths);

    let champion = options
        .champion
        .clone()
        .filter(|c| !c.is_empty())
        .or(detected_champion)
        .ok_or("Could not detect a champion — expected data/characters/<champion>/ in the folder")?;
    let skin_id = options.target_skin_id.unwrap_or(detected_skin);

    let project_path = unique_dir(&PathBuf::from(project_dir));
    std::fs::create_dir_all(&project_path)
        .map_err(|e| format!("Failed to create project folder: {}", e))?;

    let champion_lower = champion.to_lowercase();
    // `base` is the layer every consumer expects — `Project::assets_path()` is
    // `content_path("base")`, and export, LTK sync, the loadscreen banner and
    // mesh lookup all resolve `content/base`. Writing the WAD folder directly
    // under `content/` produces a project that cannot be exported.
    let wad_dir = project_path
        .join("content")
        .join("base")
        .join(format!("{}.wad.client", champion_lower));
    std::fs::create_dir_all(&wad_dir)
        .map_err(|e| format!("Failed to create content folder: {}", e))?;

    report("progress", "Copying files…");

    let mut copied = 0usize;
    for dir in CONTENT_DIRS {
        let from = source.join(dir);
        if from.is_dir() {
            copy_dir_all(&from, &wad_dir.join(dir), &mut copied)
                .map_err(|e| format!("Failed to copy {}: {}", dir, e))?;
        }
    }
    if copied == 0 {
        return Err("No files were copied — the folder appears to be empty.".to_string());
    }
    tracing::info!("Copied {} files from {} into {}", copied, folder_path, wad_dir.display());

    report("progress", "Writing project metadata…");

    let project_name = options
        .project_name
        .clone()
        .filter(|n| !n.is_empty())
        .or_else(|| {
            project_path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| format!("{} Skin{}", champion, skin_id));

    let creator = options
        .creator_name
        .clone()
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "Unknown".to_string());

    let project = Project::new(
        project_name,
        &champion,
        skin_id,
        options.league_path.clone().map(PathBuf::from).unwrap_or_default(),
        &project_path,
        Some(creator),
    );

    core_save_project(&project).map_err(|e| format!("Failed to save project: {}", e))?;

    // Register so the project survives a reinstall even before the next scan.
    if let Some(root) = project_path.parent() {
        if let Err(e) = register_in_index(root, &project) {
            tracing::warn!("Failed to register imported project in index: {}", e);
        }
    }

    report("complete", &format!("Imported {} files", copied));
    Ok(project)
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

fn emit(app: &AppHandle, status: &str, message: &str) {
    let _ = app.emit(
        PROGRESS_EVENT,
        serde_json::json!({ "status": status, "message": message }),
    );
}

/// `Foo` → `Foo` if free, else `Foo_2`, `Foo_3`, … Gives up after 1000 tries and
/// returns the last candidate rather than looping forever.
fn unique_dir(desired: &Path) -> PathBuf {
    if !desired.exists() {
        return desired.to_path_buf();
    }
    let parent = desired.parent().unwrap_or(Path::new("."));
    let base = desired
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Imported");
    let mut candidate = desired.to_path_buf();
    for n in 2..1000 {
        candidate = parent.join(format!("{}_{}", base, n));
        if !candidate.exists() {
            return candidate;
        }
    }
    candidate
}

fn copy_dir_all(from: &Path, to: &Path, copied: &mut usize) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            copy_dir_all(&src, &dst, copied)?;
        } else {
            std::fs::copy(&src, &dst)?;
            *copied += 1;
        }
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn detects_champion_and_skin_from_a_real_extract() {
        // Shape of smolder_skin0_extracted_clean.
        let p = paths(&[
            "assets/yveltal/Characters/Smolder/HUD/icons2d/dragon.dds",
            "assets/yveltal/Characters/Smolder/Skins/Base/Animations/attack1_M_to_Idle.anm",
            "data/characters/smolder/animations/skin0.bin",
            "data/characters/smolder/skins/skin0.bin",
        ]);
        assert_eq!(detect_from_paths(&p), (Some("smolder".into()), 0));
    }

    #[test]
    fn prefers_the_champion_that_has_a_skin_bin() {
        let p = paths(&[
            "data/characters/sru_orderturret/hud/icon.bin",
            "data/characters/sru_orderturret/mesh.bin",
            "data/characters/sru_orderturret/extra.bin",
            "data/characters/ahri/skins/skin7.bin",
        ]);
        // The turret has more files, but only Ahri has a skin bin.
        assert_eq!(detect_from_paths(&p), (Some("ahri".into()), 7));
    }

    #[test]
    fn breaks_ties_on_file_count_when_both_have_skin_bins() {
        let p = paths(&[
            "data/characters/sru_orderturret/skins/skin0.bin",
            "data/characters/smolder/skins/skin0.bin",
            "data/characters/smolder/animations/skin0.bin",
            "data/characters/smolder/hud/icon.bin",
        ]);
        // A stray turret skin0 must not outrank the mod's actual subject.
        assert_eq!(detect_from_paths(&p), (Some("smolder".into()), 0));
    }

    #[test]
    fn skin_id_is_the_lowest_belonging_to_the_chosen_champion() {
        let p = paths(&[
            "data/characters/ahri/skins/skin14.bin",
            "data/characters/ahri/skins/skin3.bin",
            "data/characters/ahri/skins/skin7.bin",
        ]);
        assert_eq!(detect_from_paths(&p), (Some("ahri".into()), 3));
    }

    #[test]
    fn shared_asset_folders_are_never_read_as_a_champion() {
        let p = paths(&["assets/yveltal/shared/particles/glow.dds"]);
        assert_eq!(detect_from_paths(&p), (None, 0));
    }

    #[test]
    fn falls_back_to_assets_layout_when_data_is_absent() {
        let p = paths(&["assets/yveltal/Characters/Smolder/HUD/icons2d/dragon.dds"]);
        assert_eq!(detect_from_paths(&p), (Some("smolder".into()), 0));
    }

    #[test]
    fn is_case_and_separator_insensitive() {
        let p = paths(&["DATA\\Characters\\Smolder\\Skins\\Skin4.bin"]);
        assert_eq!(detect_from_paths(&p), (Some("smolder".into()), 4));
    }

    #[test]
    fn returns_no_champion_for_unrelated_content() {
        let p = paths(&["data/items/item1001.bin", "assets/maps/kav/floor.dds"]);
        assert_eq!(detect_from_paths(&p), (None, 0));
    }

    #[test]
    fn parse_skin_bin_rejects_non_skin_bins() {
        assert_eq!(parse_skin_bin("skin0.bin"), Some(0));
        assert_eq!(parse_skin_bin("skin27.bin"), Some(27));
        assert_eq!(parse_skin_bin("root.bin"), None);
        assert_eq!(parse_skin_bin("skin.bin"), None);
        assert_eq!(parse_skin_bin("skinbad.bin"), None);
        assert_eq!(parse_skin_bin("skin0.txt"), None);
    }

    #[test]
    fn unique_dir_suffixes_an_existing_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let wanted = tmp.path().join("Smolder_Skin0");

        assert_eq!(unique_dir(&wanted), wanted, "free name should be used as-is");

        std::fs::create_dir_all(&wanted).unwrap();
        assert_eq!(unique_dir(&wanted), tmp.path().join("Smolder_Skin0_2"));

        std::fs::create_dir_all(tmp.path().join("Smolder_Skin0_2")).unwrap();
        assert_eq!(unique_dir(&wanted), tmp.path().join("Smolder_Skin0_3"));
    }

    /// Build a tempdir shaped like a real extracted `<champion>.wad.client`.
    fn fake_extract(root: &Path) {
        let files = [
            "assets/yveltal/Characters/Smolder/HUD/icons2d/dragon.dds",
            "assets/yveltal/Characters/Smolder/Skins/Base/Animations/attack1.anm",
            "assets/yveltal/shared/particles/glow.dds",
            "data/characters/smolder/animations/skin0.bin",
            "data/characters/smolder/skins/skin0.bin",
        ];
        for f in files {
            let p = root.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, f.as_bytes()).unwrap();
        }
    }

    fn silent(_status: &str, _message: &str) {}

    #[test]
    fn imports_an_extract_into_a_playable_project_layout() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("smolder_skin0_extracted_clean");
        fake_extract(&source);

        let dest = tmp.path().join("Projects").join("Smolder_Skin0_test");
        let options = ImportOptions {
            refather: false,
            creator_name: Some("tester".into()),
            project_name: None,
            champion: None,
            target_skin_id: None,
            cleanup_unused: false,
            match_from_league: false,
            league_path: None,
        };

        let project = perform_import(
            source.to_str().unwrap(),
            dest.to_str().unwrap(),
            &options,
            &silent,
        )
        .unwrap();

        assert_eq!(project.champion, "smolder");
        assert_eq!(project.skin_id, 0);

        // Content must land under content/base/<champion>.wad.client/ — the
        // `base` layer is what `Project::assets_path()` resolves and what
        // export reads. Without it the project imports but cannot be exported.
        let wad = dest.join("content/base/smolder.wad.client");
        assert!(wad.join("data/characters/smolder/skins/skin0.bin").is_file());
        assert!(wad.join("assets/yveltal/Characters/Smolder/HUD/icons2d/dragon.dds").is_file());

        // And it must be a real project, not just a pile of files.
        assert!(dest.join("mod.config.json").is_file());
        assert!(dest.join("flint.json").is_file());
    }

    #[test]
    fn importing_the_same_folder_twice_makes_two_projects() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("extract");
        fake_extract(&source);

        let dest = tmp.path().join("Projects").join("Smolder_Skin0");
        let options = ImportOptions {
            refather: false,
            creator_name: None,
            project_name: None,
            champion: None,
            target_skin_id: None,
            cleanup_unused: false,
            match_from_league: false,
            league_path: None,
        };

        let first = perform_import(source.to_str().unwrap(), dest.to_str().unwrap(), &options, &silent).unwrap();
        let second = perform_import(source.to_str().unwrap(), dest.to_str().unwrap(), &options, &silent).unwrap();

        assert_ne!(first.project_path, second.project_path, "must not overwrite the first import");
        assert!(second.project_path.ends_with("Smolder_Skin0_2"));
    }

    #[test]
    fn rejects_a_folder_that_is_not_an_extract() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("random");
        std::fs::create_dir_all(source.join("docs")).unwrap();
        std::fs::write(source.join("docs/readme.txt"), b"hi").unwrap();

        let options = ImportOptions {
            refather: false,
            creator_name: None,
            project_name: None,
            champion: None,
            target_skin_id: None,
            cleanup_unused: false,
            match_from_league: false,
            league_path: None,
        };

        let err = perform_import(
            source.to_str().unwrap(),
            tmp.path().join("out").to_str().unwrap(),
            &options,
            &silent,
        )
        .unwrap_err();
        assert!(err.contains("assets"), "error should name what was missing, got: {err}");
    }

    #[test]
    fn copy_dir_all_copies_nested_trees_and_counts_files() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        std::fs::create_dir_all(src.join("a/b")).unwrap();
        std::fs::write(src.join("top.txt"), b"1").unwrap();
        std::fs::write(src.join("a/mid.txt"), b"2").unwrap();
        std::fs::write(src.join("a/b/deep.txt"), b"3").unwrap();

        let dst = tmp.path().join("dst");
        let mut copied = 0;
        copy_dir_all(&src, &dst, &mut copied).unwrap();

        assert_eq!(copied, 3);
        assert!(dst.join("a/b/deep.txt").is_file());
        assert_eq!(std::fs::read(dst.join("a/b/deep.txt")).unwrap(), b"3");
    }
}
