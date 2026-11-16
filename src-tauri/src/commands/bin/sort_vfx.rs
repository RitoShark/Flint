use flint_core::bin::split::collect_folder_bins;
use flint_core::bin::{read_bin, sort_vfx_systems, write_bin, SortVfxReport};
use flint_core::path_slash::to_slash;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize)]
pub struct SortVfxFolderResult {
    pub files_scanned: usize,
    pub files_with_vfx: usize,
    pub files_changed: Vec<String>,
    pub failed: Vec<String>,
    pub totals: SortVfxReport,
}

fn add_report(totals: &mut SortVfxReport, report: &SortVfxReport) {
    totals.systems += report.systems;
    totals.moved += report.moved;
    totals.passive += report.passive;
    totals.basic_attack += report.basic_attack;
    totals.q += report.q;
    totals.w += report.w;
    totals.e += report.e;
    totals.r += report.r;
    totals.miscellaneous += report.miscellaneous;
}

fn sort_one(path: &Path) -> Result<SortVfxReport, String> {
    let data = std::fs::read(path).map_err(|e| format!("read failed: {e}"))?;
    let mut bin = read_bin(&data).map_err(|e| format!("parse failed: {e}"))?;
    let report = sort_vfx_systems(&mut bin);
    if report.moved > 0 {
        let bytes = write_bin(&bin).map_err(|e| format!("encode failed: {e}"))?;
        let sidecar = path.with_extension("bin.ritobin");
        match std::fs::remove_file(&sidecar) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("cache invalidation failed: {e}")),
        }
        std::fs::write(path, bytes).map_err(|e| format!("write failed: {e}"))?;
    }
    Ok(report)
}

#[tauri::command]
pub async fn sort_bins_vfx_by_skill(path: String) -> Result<SortVfxFolderResult, String> {
    tracing::info!("sort_bins_vfx_by_skill: {}", path);
    let target = PathBuf::from(&path);
    let bins = if target.is_dir() {
        collect_folder_bins(&target)
            .into_iter()
            .filter(|path| {
                !path
                    .strip_prefix(&target)
                    .unwrap_or(path)
                    .components()
                    .any(|part| {
                        part.as_os_str().eq_ignore_ascii_case(".flint")
                            || part.as_os_str().eq_ignore_ascii_case(".git")
                    })
            })
            .collect()
    } else if target.is_file()
        && target
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("bin"))
    {
        vec![target]
    } else {
        return Err(format!("Expected a BIN file or folder: {}", path));
    };
    if bins.is_empty() {
        return Err(format!("No .bin files found under {}", path));
    }

    tokio::task::spawn_blocking(move || {
        let mut result = SortVfxFolderResult {
            files_scanned: bins.len(),
            ..Default::default()
        };
        for bin_path in &bins {
            match sort_one(bin_path) {
                Ok(report) => {
                    if report.systems > 0 {
                        result.files_with_vfx += 1;
                    }
                    if report.moved > 0 {
                        result.files_changed.push(to_slash(bin_path));
                    }
                    add_report(&mut result.totals, &report);
                }
                Err(e) => {
                    tracing::warn!("sort_bins_vfx_by_skill: {}: {}", bin_path.display(), e);
                    result.failed.push(to_slash(bin_path));
                }
            }
        }
        result
    })
    .await
    .map_err(|e| format!("Task panicked: {}", e))
}
