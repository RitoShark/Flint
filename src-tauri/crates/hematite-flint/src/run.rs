//! Scan (detect-only) and run (apply) a project's fixes via `fix_folder`.

use crate::report::{FixOutcome, ProjectFixReport};
use hematite_orchestrate::{fix_folder, FixOptions, LiveGameProvider, NoopSink, ProgressSink};
use hematite_types::config::FixConfig;
use hematite_types::champion::CharacterRelations;
use hematite_types::result::ProcessResult;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The WAD-folder root of a Flint project. Projects store WADs unpacked under
/// `content/<layer>/*.wad.client/`; `fix_folder` walks a directory and finds
/// every `.wad.client` folder inside it, so one call over `content/` covers all
/// layers. Falls back to the project dir itself when there's no `content/`.
fn fix_root(project_dir: &Path) -> PathBuf {
    let content = project_dir.join("content");
    if content.is_dir() {
        content
    } else {
        project_dir.to_path_buf()
    }
}

fn to_report(project: &str, result: ProcessResult) -> ProjectFixReport {
    let (champion, skin_number) = result
        .check_info
        .as_ref()
        .map(|c| (c.champion.clone(), c.skin_number))
        .unwrap_or((None, None));

    ProjectFixReport {
        project: project.to_string(),
        outcomes: result
            .applied_fixes
            .into_iter()
            .map(|a| FixOutcome {
                fix_id: a.fix_id,
                fix_name: a.fix_name,
                changes: a.changes_count,
                file_path: a.file_path,
            })
            .collect(),
        fixes_applied: result.fixes_applied,
        fixes_failed: result.fixes_failed,
        files_removed: result.files_removed,
        errors: result.errors,
        champion,
        skin_number,
        error: None,
    }
}

/// Build the `FixOptions` for a run. `relocate_combo_bins` is derived from the
/// selected id set (mirrors the CLI); `restore_anm` / `repath` are off for v1.
fn options<'a>(
    selected: &[String],
    detect_only: bool,
    live: Option<&'a LiveGameProvider>,
) -> FixOptions<'a> {
    FixOptions {
        dry_run: false,
        detect_only,
        repath: None,
        restore_anm: false,
        relocate_combo_bins: selected.iter().any(|f| f == "combo_bin_relocate"),
        game_wad: None,
        live,
        // Fix the project's OWN WADs in place, not a `.fixed.wad.client` sibling
        // copy. Irrelevant on a scan (detect_only writes nothing regardless).
        in_place: !detect_only,
    }
}

/// Detect-only pass — reports which selected fixes fire, writes nothing.
pub fn scan_project(
    project_dir: &Path,
    project_label: &str,
    fix_ids: &[String],
    config: &FixConfig,
    champions: &CharacterRelations,
    hash_provider: &Arc<dyn hematite_core::traits::HashProvider>,
) -> ProjectFixReport {
    let root = fix_root(project_dir);
    let opts = options(fix_ids, true, None);
    match fix_folder(&root, config, fix_ids, champions, hash_provider, &opts, &NoopSink) {
        Ok(result) => to_report(project_label, result),
        Err(e) => ProjectFixReport::failed(project_label, e.to_string()),
    }
}

/// Apply pass — runs the real extract→fix→rebuild, streaming progress.
#[allow(clippy::too_many_arguments)]
pub fn run_fixes(
    project_dir: &Path,
    project_label: &str,
    fix_ids: &[String],
    config: &FixConfig,
    champions: &CharacterRelations,
    hash_provider: &Arc<dyn hematite_core::traits::HashProvider>,
    live: Option<&LiveGameProvider>,
    progress: &dyn ProgressSink,
) -> ProjectFixReport {
    let root = fix_root(project_dir);
    let opts = options(fix_ids, false, live);
    match fix_folder(&root, config, fix_ids, champions, hash_provider, &opts, progress) {
        Ok(result) => to_report(project_label, result),
        Err(e) => ProjectFixReport::failed(project_label, e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fix_root_prefers_content() {
        let tmp = std::env::temp_dir().join("hf_test_proj_root");
        let _ = std::fs::create_dir_all(tmp.join("content"));
        assert_eq!(fix_root(&tmp), tmp.join("content"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn fix_root_falls_back_to_project_dir() {
        let tmp = std::env::temp_dir().join("hf_test_proj_nocontent");
        let _ = std::fs::create_dir_all(&tmp);
        assert_eq!(fix_root(&tmp), tmp);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn combo_relocate_flag_derived_from_ids() {
        let with = vec!["combo_bin_relocate".to_string(), "healthbar_fix".to_string()];
        let without = vec!["healthbar_fix".to_string()];
        assert!(options(&with, false, None).relocate_combo_bins);
        assert!(!options(&without, false, None).relocate_combo_bins);
    }
}
