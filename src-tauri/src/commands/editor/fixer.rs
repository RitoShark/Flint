//! Tauri commands for Hematite fixer integration (v2).
//!
//! Provides project analysis and fixing using the Hematite fix engine.
//! Scans BIN files for known issues (broken health bars, deprecated fields, etc.)
//! and applies config-driven fixes.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::Emitter;
use walkdir::WalkDir;

use flint_ltk::hematite::FixContext;
use flint_ltk::hematite::detect_issue;
use flint_ltk::hematite::ShaderValidator;
use flint_ltk::hematite::apply_fixes;
use flint_ltk::hematite::BinProvider;
use flint_ltk::hematite::LtkBinProvider;
use flint_ltk::hematite::LmdbHashProvider;
use flint_ltk::hematite::LtkWadProvider;
use flint_ltk::hematite::{CharacterRelations, ChampionList};
use flint_ltk::hematite::FixConfig;

// =============================================================================
// Config fetching (replicated from hematite-cli/src/remote.rs)
// =============================================================================

const FIX_CONFIG_URL: &str =
    "https://raw.githubusercontent.com/LeagueToolkit/Hematite/v2/config/fix_config.json";
const CHAMPION_LIST_URL: &str =
    "https://raw.githubusercontent.com/LeagueToolkit/Hematite/v2/config/champion_list.json";
const CACHE_TTL: Duration = Duration::from_secs(3600);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

fn get_cache_dir() -> Result<PathBuf, String> {
    let appdata =
        std::env::var("APPDATA").map_err(|_| "APPDATA environment variable not set".to_string())?;
    Ok(PathBuf::from(appdata).join("Hematite").join("cache"))
}

fn is_cache_valid(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(modified) = metadata.modified() else {
        return false;
    };
    let Ok(elapsed) = SystemTime::now().duration_since(modified) else {
        return false;
    };
    elapsed < CACHE_TTL
}

/// Fetch a JSON resource with cache → GitHub → stale cache fallback.
async fn fetch_or_cached<T: serde::de::DeserializeOwned>(
    url: &str,
    cache_name: &str,
) -> Result<T, String> {
    let cache_dir = get_cache_dir()?;
    let cache_file = cache_dir.join(cache_name);

    // 1. Valid cache (< 1 hour)
    if is_cache_valid(&cache_file) {
        if let Ok(json) = std::fs::read_to_string(&cache_file) {
            if let Ok(val) = serde_json::from_str::<T>(&json) {
                tracing::debug!("Using cached {}", cache_name);
                return Ok(val);
            }
        }
    }

    // 2. Fetch from GitHub
    tracing::info!("Fetching {} from GitHub...", cache_name);
    let client = reqwest::Client::new();
    match client
        .get(url)
        .timeout(REQUEST_TIMEOUT)
        .header("User-Agent", "Flint/1.0")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(text) = resp.text().await {
                if let Ok(val) = serde_json::from_str::<T>(&text) {
                    let _ = std::fs::create_dir_all(&cache_dir);
                    let _ = std::fs::write(&cache_file, &text);
                    tracing::info!("Fetched and cached {}", cache_name);
                    return Ok(val);
                }
            }
        }
        Ok(resp) => {
            tracing::warn!("GitHub returned {} for {}", resp.status(), cache_name);
        }
        Err(e) => {
            tracing::warn!("Failed to fetch {} from GitHub: {}", cache_name, e);
        }
    }

    // 3. Stale cache fallback
    if cache_file.exists() {
        if let Ok(json) = std::fs::read_to_string(&cache_file) {
            if let Ok(val) = serde_json::from_str::<T>(&json) {
                tracing::info!("Using stale cached {}", cache_name);
                return Ok(val);
            }
        }
    }

    Err(format!(
        "Failed to load {} (no cache and GitHub unreachable)",
        cache_name
    ))
}

async fn load_fix_config() -> Result<FixConfig, String> {
    fetch_or_cached::<FixConfig>(FIX_CONFIG_URL, "fix_config.json").await
}

async fn load_champion_list() -> Result<ChampionList, String> {
    fetch_or_cached::<ChampionList>(CHAMPION_LIST_URL, "champion_list.json").await
}

// =============================================================================
// Serialization types (frontend-compatible)
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedIssue {
    pub fix_id: String,
    pub fix_name: String,
    pub severity: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub file_path: String,
    pub detected_issues: Vec<DetectedIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectAnalysis {
    pub project_path: String,
    pub results: Vec<ScanResult>,
    pub files_scanned: u32,
    pub issues_found: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppliedFix {
    pub fix_id: String,
    pub description: String,
    pub changes_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailedFix {
    pub fix_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixResult {
    pub file_path: String,
    pub fixes_applied: Vec<AppliedFix>,
    pub fixes_failed: Vec<FailedFix>,
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFixResult {
    pub project_path: String,
    pub results: Vec<FixResult>,
    pub total_applied: u32,
    pub total_failed: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchFixResult {
    pub projects: Vec<ProjectFixResult>,
    pub total_projects: u32,
    pub total_applied: u32,
    pub total_failed: u32,
}

// =============================================================================
// Helpers
// =============================================================================

/// Find all .bin files under a project's content directory.
fn find_bin_files(project_path: &Path) -> Vec<PathBuf> {
    let content_dir = project_path.join("content");
    if !content_dir.exists() {
        return Vec::new();
    }

    WalkDir::new(&content_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("bin"))
                .unwrap_or(false)
        })
        .map(|e| e.path().to_path_buf())
        .collect()
}

// =============================================================================
// Commands
// =============================================================================

/// Fetch the fixer configuration (from GitHub with cache fallback).
#[tauri::command]
pub async fn get_fixer_config() -> Result<FixConfig, String> {
    load_fix_config().await
}

/// Analyze a Flint project for fixable issues.
///
/// Scans all BIN files under `{project_path}/content/` and reports detected issues.
#[tauri::command]
pub async fn analyze_project(
    project_path: String,
    app: tauri::AppHandle,
) -> Result<ProjectAnalysis, String> {
    let project_dir = PathBuf::from(&project_path);
    if !project_dir.exists() {
        return Err(format!("Project path does not exist: {}", project_path));
    }

    let _ = app.emit(
        "fixer-progress",
        serde_json::json!({
            "phase": "scan",
            "message": "Loading fix configuration..."
        }),
    );

    // Fetch config asynchronously
    let config = load_fix_config().await?;

    let _ = app.emit(
        "fixer-progress",
        serde_json::json!({
            "phase": "scan",
            "message": "Scanning project for BIN files..."
        }),
    );

    // Heavy work in blocking thread
    let analysis =
        tokio::task::spawn_blocking(move || -> Result<ProjectAnalysis, String> {
            let hash_provider = LmdbHashProvider::load_from_appdata()
                .map_err(|e| format!("Failed to load hash provider: {:#}", e))?;
            let wad_provider = LtkWadProvider::new();
            let bin_provider = LtkBinProvider::new();

            let bin_files = find_bin_files(&project_dir);
            let files_scanned = bin_files.len() as u32;

            let mut results = Vec::new();
            let mut issues_found = 0u32;

            for bin_path in &bin_files {
                let path_str = bin_path.to_string_lossy().to_string();

                // Read and parse the BIN file
                let bytes = match std::fs::read(bin_path) {
                    Ok(b) => b,
                    Err(e) => {
                        tracing::warn!("Failed to read {}: {:#}", path_str, e);
                        continue;
                    }
                };

                let tree = match bin_provider.parse_bytes(&bytes) {
                    Ok(t) => t,
                    Err(e) => {
                        tracing::warn!("Failed to parse {}: {:#}", path_str, e);
                        continue;
                    }
                };

                // Run detection for each enabled fix rule
                let mut detected_issues = Vec::new();
                for (fix_id, rule) in &config.fixes {
                    if !rule.enabled {
                        continue;
                    }
                    if detect_issue(&rule.detect, &tree, &hash_provider, &wad_provider) {
                        detected_issues.push(DetectedIssue {
                            fix_id: fix_id.clone(),
                            fix_name: rule.name.clone(),
                            severity: rule.severity.clone(),
                            description: rule.description.clone(),
                        });
                    }
                }

                if !detected_issues.is_empty() {
                    issues_found += detected_issues.len() as u32;
                    results.push(ScanResult {
                        file_path: path_str,
                        detected_issues,
                    });
                }
            }

            Ok(ProjectAnalysis {
                project_path: project_dir.to_string_lossy().to_string(),
                results,
                files_scanned,
                issues_found,
            })
        })
        .await
        .map_err(|e| format!("Task failed: {}", e))??;

    let _ = app.emit(
        "fixer-progress",
        serde_json::json!({
            "phase": "done",
            "message": format!("Found {} issues in {} files", analysis.issues_found, analysis.files_scanned)
        }),
    );

    Ok(analysis)
}

/// Fix a Flint project by applying selected fixes.
///
/// Scans BIN files, detects issues, and applies the specified fixes in-place.
/// If `selected_fix_ids` is empty, all detected fixes are applied.
#[tauri::command]
pub async fn fix_project(
    project_path: String,
    selected_fix_ids: Vec<String>,
    app: tauri::AppHandle,
) -> Result<ProjectFixResult, String> {
    let project_dir = PathBuf::from(&project_path);
    if !project_dir.exists() {
        return Err(format!("Project path does not exist: {}", project_path));
    }

    let _ = app.emit(
        "fixer-progress",
        serde_json::json!({
            "phase": "fix",
            "message": "Loading fix configuration..."
        }),
    );

    // Fetch config + champion list asynchronously
    let config = load_fix_config().await?;
    let champion_list = load_champion_list().await?;

    let _ = app.emit(
        "fixer-progress",
        serde_json::json!({
            "phase": "fix",
            "message": "Applying fixes..."
        }),
    );

    let fix_result =
        tokio::task::spawn_blocking(move || -> Result<ProjectFixResult, String> {
            let hash_provider = LmdbHashProvider::load_from_appdata()
                .map_err(|e| format!("Failed to load hash provider: {:#}", e))?;
            let wad_provider = LtkWadProvider::new();
            let bin_provider = LtkBinProvider::new();
            let champions = CharacterRelations::from_champion_list(&champion_list);
            let shader_validator = ShaderValidator::load().ok();

            let bin_files = find_bin_files(&project_dir);

            // If no specific fixes selected, use all enabled fix IDs
            let fix_ids: Vec<String> = if selected_fix_ids.is_empty() {
                config
                    .fixes
                    .iter()
                    .filter(|(_, rule)| rule.enabled)
                    .map(|(id, _)| id.clone())
                    .collect()
            } else {
                selected_fix_ids
            };

            let mut results = Vec::new();
            let mut total_applied = 0u32;
            let mut total_failed = 0u32;

            for bin_path in &bin_files {
                let path_str = bin_path.to_string_lossy().to_string();

                let bytes = match std::fs::read(bin_path) {
                    Ok(b) => b,
                    Err(e) => {
                        tracing::warn!("Failed to read {}: {:#}", path_str, e);
                        continue;
                    }
                };

                let tree = match bin_provider.parse_bytes(&bytes) {
                    Ok(t) => t,
                    Err(e) => {
                        tracing::warn!("Failed to parse {}: {:#}", path_str, e);
                        continue;
                    }
                };

                // Build fix context
                let mut ctx = FixContext {
                    tree,
                    hashes: &hash_provider,
                    wad: &wad_provider,
                    champions: &champions,
                    file_path: path_str.clone(),
                    files_to_remove: Vec::new(),
                    linked_trees: HashMap::new(),
                    shader_validator: shader_validator.as_ref(),
                };

                // Apply fixes
                let process_result = apply_fixes(&mut ctx, &config, &fix_ids, false);

                // Map to our FixResult type
                let fixes_applied: Vec<AppliedFix> = process_result
                    .applied_fixes
                    .iter()
                    .map(|f| AppliedFix {
                        fix_id: f.fix_id.clone(),
                        description: f.fix_name.clone(),
                        changes_count: f.changes_count,
                    })
                    .collect();

                let fixes_failed: Vec<FailedFix> = process_result
                    .errors
                    .iter()
                    .map(|e| FailedFix {
                        fix_id: "unknown".to_string(),
                        error: e.clone(),
                    })
                    .collect();

                // Write modified BIN back if we applied fixes
                if !fixes_applied.is_empty() {
                    match bin_provider.write_bytes(&ctx.tree) {
                        Ok(output) => {
                            if let Err(e) = std::fs::write(bin_path, output) {
                                tracing::error!(
                                    "Failed to write fixed BIN {}: {:#}",
                                    path_str,
                                    e
                                );
                                total_failed += 1;
                            } else {
                                total_applied += fixes_applied.len() as u32;
                                tracing::info!(
                                    "Applied {} fixes to {}",
                                    fixes_applied.len(),
                                    path_str
                                );
                            }
                        }
                        Err(e) => {
                            tracing::error!(
                                "Failed to serialize fixed BIN {}: {:#}",
                                path_str,
                                e
                            );
                            total_failed += 1;
                        }
                    }
                }

                total_failed += fixes_failed.len() as u32;

                let has_changes = !fixes_applied.is_empty() || !fixes_failed.is_empty();
                if has_changes {
                    results.push(FixResult {
                        file_path: path_str,
                        success: fixes_failed.is_empty(),
                        fixes_applied,
                        fixes_failed,
                    });
                }
            }

            Ok(ProjectFixResult {
                project_path: project_dir.to_string_lossy().to_string(),
                results,
                total_applied,
                total_failed,
            })
        })
        .await
        .map_err(|e| format!("Task failed: {}", e))??;

    let _ = app.emit(
        "fixer-progress",
        serde_json::json!({
            "phase": "done",
            "message": format!("Applied {} fixes ({} failed)", fix_result.total_applied, fix_result.total_failed)
        }),
    );

    Ok(fix_result)
}

/// Batch fix multiple Flint projects.
///
/// Each path in `project_paths` should be a Flint project directory.
/// Applies all enabled fixes to each project.
#[tauri::command]
pub async fn batch_fix_projects(
    project_paths: Vec<String>,
    selected_fix_ids: Vec<String>,
    app: tauri::AppHandle,
) -> Result<BatchFixResult, String> {
    let total_projects = project_paths.len() as u32;

    let _ = app.emit(
        "fixer-progress",
        serde_json::json!({
            "phase": "batch",
            "message": format!("Loading configuration for {} projects...", total_projects)
        }),
    );

    // Fetch config + champion list asynchronously
    let config = load_fix_config().await?;
    let champion_list = load_champion_list().await?;

    let _ = app.emit(
        "fixer-progress",
        serde_json::json!({
            "phase": "batch",
            "message": format!("Fixing {} projects...", total_projects)
        }),
    );

    let batch_result =
        tokio::task::spawn_blocking(move || -> Result<BatchFixResult, String> {
            let hash_provider = LmdbHashProvider::load_from_appdata()
                .map_err(|e| format!("Failed to load hash provider: {:#}", e))?;
            let wad_provider = LtkWadProvider::new();
            let bin_provider = LtkBinProvider::new();
            let champions = CharacterRelations::from_champion_list(&champion_list);
            let shader_validator = ShaderValidator::load().ok();

            let fix_ids: Vec<String> = if selected_fix_ids.is_empty() {
                config
                    .fixes
                    .iter()
                    .filter(|(_, rule)| rule.enabled)
                    .map(|(id, _)| id.clone())
                    .collect()
            } else {
                selected_fix_ids
            };

            let mut projects = Vec::new();
            let mut grand_total_applied = 0u32;
            let mut grand_total_failed = 0u32;

            for (idx, project_path) in project_paths.iter().enumerate() {
                let project_dir = PathBuf::from(project_path);
                if !project_dir.exists() {
                    tracing::warn!("Skipping non-existent project: {}", project_path);
                    continue;
                }

                tracing::info!(
                    "Fixing project {}/{}: {}",
                    idx + 1,
                    total_projects,
                    project_path
                );

                let bin_files = find_bin_files(&project_dir);
                let mut results = Vec::new();
                let mut total_applied = 0u32;
                let mut total_failed = 0u32;

                for bin_path in &bin_files {
                    let path_str = bin_path.to_string_lossy().to_string();

                    let bytes = match std::fs::read(bin_path) {
                        Ok(b) => b,
                        Err(e) => {
                            tracing::warn!("Failed to read {}: {:#}", path_str, e);
                            continue;
                        }
                    };

                    let tree = match bin_provider.parse_bytes(&bytes) {
                        Ok(t) => t,
                        Err(e) => {
                            tracing::warn!("Failed to parse {}: {:#}", path_str, e);
                            continue;
                        }
                    };

                    let mut ctx = FixContext {
                        tree,
                        hashes: &hash_provider,
                        wad: &wad_provider,
                        champions: &champions,
                        file_path: path_str.clone(),
                        files_to_remove: Vec::new(),
                        linked_trees: HashMap::new(),
                        shader_validator: shader_validator.as_ref(),
                    };

                    let process_result = apply_fixes(&mut ctx, &config, &fix_ids, false);

                    let fixes_applied: Vec<AppliedFix> = process_result
                        .applied_fixes
                        .iter()
                        .map(|f| AppliedFix {
                            fix_id: f.fix_id.clone(),
                            description: f.fix_name.clone(),
                            changes_count: f.changes_count,
                        })
                        .collect();

                    let fixes_failed: Vec<FailedFix> = process_result
                        .errors
                        .iter()
                        .map(|e| FailedFix {
                            fix_id: "unknown".to_string(),
                            error: e.clone(),
                        })
                        .collect();

                    if !fixes_applied.is_empty() {
                        match bin_provider.write_bytes(&ctx.tree) {
                            Ok(output) => {
                                if let Err(e) = std::fs::write(bin_path, output) {
                                    tracing::error!(
                                        "Failed to write fixed BIN {}: {:#}",
                                        path_str,
                                        e
                                    );
                                    total_failed += 1;
                                } else {
                                    total_applied += fixes_applied.len() as u32;
                                }
                            }
                            Err(e) => {
                                tracing::error!(
                                    "Failed to serialize fixed BIN {}: {:#}",
                                    path_str,
                                    e
                                );
                                total_failed += 1;
                            }
                        }
                    }

                    total_failed += fixes_failed.len() as u32;

                    if !fixes_applied.is_empty() || !fixes_failed.is_empty() {
                        results.push(FixResult {
                            file_path: path_str,
                            success: fixes_failed.is_empty(),
                            fixes_applied,
                            fixes_failed,
                        });
                    }
                }

                grand_total_applied += total_applied;
                grand_total_failed += total_failed;

                projects.push(ProjectFixResult {
                    project_path: project_path.clone(),
                    results,
                    total_applied,
                    total_failed,
                });
            }

            Ok(BatchFixResult {
                projects,
                total_projects,
                total_applied: grand_total_applied,
                total_failed: grand_total_failed,
            })
        })
        .await
        .map_err(|e| format!("Task failed: {}", e))??;

    let _ = app.emit(
        "fixer-progress",
        serde_json::json!({
            "phase": "done",
            "message": format!(
                "Batch complete: {} projects, {} fixes applied, {} failed",
                batch_result.total_projects, batch_result.total_applied, batch_result.total_failed
            )
        }),
    );

    Ok(batch_result)
}
