//! Manifest catalog backed by the Morilli/riot-manifests GitHub repo, which
//! archives every League release manifest organized as
//! `LoL/<REGION>/<platform>/<artifact-type>/<patch>.<build>.txt`, each file
//! containing the manifest's CDN URL.
//!
//! Old manifests are immutable checkpoints, so both the directory tree and the
//! resolved per-file URLs are cached to disk permanently; we only re-fetch the
//! tree when explicitly refreshing to discover newly-shipped patches.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use flint_hash::error::{Error, Result};

const TREE_URL: &str =
    "https://api.github.com/repos/Morilli/riot-manifests/git/trees/master?recursive=1";
const RAW_BASE: &str = "https://raw.githubusercontent.com/Morilli/riot-manifests/master";

/// One catalogued manifest version for a (region, platform, kind) triple.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CatalogEntry {
    /// Repo path, e.g. `LoL/EUW1/windows/lol-game-client/15.24.7347485.txt`.
    pub path: String,
    /// Artifact kind tag: "game" | "client" | "other".
    pub kind: String,
    /// Patch label, e.g. `15.24`.
    pub patch: String,
    /// Build number, e.g. `7347485`.
    pub build: String,
    /// Display version, e.g. `15.24.7347485`.
    pub version: String,
}

#[derive(Deserialize)]
struct GitTree {
    tree: Vec<GitTreeNode>,
    #[serde(default)]
    truncated: bool,
}

#[derive(Deserialize)]
struct GitTreeNode {
    path: String,
    #[serde(rename = "type")]
    node_type: String,
}

fn kind_tag(artifact_type: &str) -> &'static str {
    match artifact_type {
        "lol-game-client" => "game",
        "lol-standalone-client-content" => "client",
        _ => "other",
    }
}

/// Parse `<patch>.<build>.txt` (or `<patch>.<build>` for hotfix-style names) into
/// `(patch, build, version)`. The version is the filename without `.txt`.
fn parse_filename(file_name: &str) -> (String, String, String) {
    let stem = file_name.strip_suffix(".txt").unwrap_or(file_name);
    // Build is the last dotted segment if it is all digits; patch is the rest.
    if let Some(idx) = stem.rfind('.') {
        let (patch, build) = stem.split_at(idx);
        let build = &build[1..];
        if !build.is_empty() && build.chars().all(|c| c.is_ascii_digit()) {
            return (patch.to_string(), build.to_string(), stem.to_string());
        }
    }
    (stem.to_string(), String::new(), stem.to_string())
}

/// Turn the full repo tree into catalog entries for one region+platform, across
/// all artifact kinds. Entries are filtered to `LoL/<region>/<platform>/<type>/*.txt`.
fn entries_from_tree(tree: &GitTree, region: &str, platform: &str) -> Vec<CatalogEntry> {
    let mut out = Vec::new();
    for node in &tree.tree {
        if node.node_type != "blob" || !node.path.ends_with(".txt") {
            continue;
        }
        if !node.path.starts_with("LoL/") {
            continue;
        }
        // LoL / <REGION> / <platform> / <artifact-type> / <file>.txt
        let parts: Vec<&str> = node.path.split('/').collect();
        if parts.len() != 5 {
            continue;
        }
        if !parts[1].eq_ignore_ascii_case(region) || !parts[2].eq_ignore_ascii_case(platform) {
            continue;
        }
        let artifact_type = parts[3];
        let (patch, build, version) = parse_filename(parts[4]);
        out.push(CatalogEntry {
            path: node.path.clone(),
            kind: kind_tag(artifact_type).to_string(),
            patch,
            build,
            version,
        });
    }
    // Newest first: sort by numeric build descending (fallback lexical version).
    out.sort_by(|a, b| {
        let ab = a.build.parse::<u64>().unwrap_or(0);
        let bb = b.build.parse::<u64>().unwrap_or(0);
        bb.cmp(&ab).then_with(|| b.version.cmp(&a.version))
    });
    out
}

fn tree_cache_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join("riot-manifests-tree.json")
}

async fn http_get_text(client: &reqwest::Client, url: &str) -> Result<String> {
    let resp = client
        .get(url)
        .header(reqwest::header::USER_AGENT, "flint")
        .send()
        .await
        .map_err(|e| Error::Cdn(format!("github request: {e}")))?;
    if !resp.status().is_success() {
        return Err(Error::Cdn(format!(
            "github request to {url} failed: HTTP {}",
            resp.status()
        )));
    }
    resp.text()
        .await
        .map_err(|e| Error::Cdn(format!("github body: {e}")))
}

/// Fetch the repo tree JSON (cached to `cache_dir`). When `refresh` is false and a
/// cached copy exists, it is used verbatim (old manifests never change).
async fn load_tree(client: &reqwest::Client, cache_dir: &Path, refresh: bool) -> Result<GitTree> {
    let cache_path = tree_cache_path(cache_dir);
    if !refresh {
        if let Ok(bytes) = tokio::fs::read(&cache_path).await {
            if let Ok(tree) = serde_json::from_slice::<GitTree>(&bytes) {
                return Ok(tree);
            }
        }
    }
    let body = http_get_text(client, TREE_URL).await?;
    let tree: GitTree =
        serde_json::from_str(&body).map_err(|e| Error::Cdn(format!("github tree json: {e}")))?;
    if tree.truncated {
        tracing::warn!("riot-manifests git tree was truncated by GitHub; some entries may be missing");
    }
    if let Some(parent) = cache_path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let _ = tokio::fs::write(&cache_path, body.as_bytes()).await;
    Ok(tree)
}

/// List every catalogued manifest for a region+platform (all kinds), newest first.
/// Uses the disk-cached tree unless `refresh` is set.
pub async fn list_versions(
    client: &reqwest::Client,
    cache_dir: &Path,
    region: &str,
    platform: &str,
    refresh: bool,
) -> Result<Vec<CatalogEntry>> {
    let tree = load_tree(client, cache_dir, refresh).await?;
    Ok(entries_from_tree(&tree, region, platform))
}

fn url_cache_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join("resolved-urls.json")
}

/// Resolve a catalog entry's repo `path` to its manifest CDN URL. Resolved URLs are
/// cached permanently in a single JSON map (filename→URL never changes).
pub async fn resolve_manifest_url(
    client: &reqwest::Client,
    cache_dir: &Path,
    repo_path: &str,
) -> Result<String> {
    let cache_path = url_cache_path(cache_dir);

    // Read the existing map (best-effort).
    let mut map: BTreeMap<String, String> = match tokio::fs::read(&cache_path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => BTreeMap::new(),
    };
    if let Some(url) = map.get(repo_path) {
        return Ok(url.clone());
    }

    // Fetch the .txt (raw) and take its first non-empty line.
    let raw_url = format!("{RAW_BASE}/{}", encode_repo_path(repo_path));
    let body = http_get_text(client, &raw_url).await?;
    let url = body
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .ok_or_else(|| Error::Cdn(format!("empty manifest file at {repo_path}")))?
        .to_string();

    map.insert(repo_path.to_string(), url.clone());
    if let Some(parent) = cache_path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    if let Ok(json) = serde_json::to_vec_pretty(&map) {
        let _ = tokio::fs::write(&cache_path, json).await;
    }
    Ok(url)
}

/// Return the manifest CDN URL for a repo `path` **only if it is already in the
/// resolved-URL cache** — never performs a network request. Used by the
/// downloaded-badge check, which must stay offline and instant.
pub fn resolve_manifest_url_cached(cache_dir: &Path, repo_path: &str) -> Option<String> {
    let bytes = std::fs::read(url_cache_path(cache_dir)).ok()?;
    let map: BTreeMap<String, String> = serde_json::from_slice(&bytes).ok()?;
    map.get(repo_path).cloned()
}

/// Given a set of catalog entry repo `path`s, return the subset whose manifest
/// has already been downloaded to `manifest_dir` (keyed by the URL basename, the
/// same name `load_manifest_from_url` writes). Cache-only + filesystem checks;
/// no network. Entries whose URL isn't cached yet are simply treated as not
/// downloaded (they can't have been fetched without first resolving the URL).
pub fn cached_versions(cache_dir: &Path, manifest_dir: &Path, repo_paths: &[String]) -> Vec<String> {
    repo_paths
        .iter()
        .filter(|p| {
            resolve_manifest_url_cached(cache_dir, p)
                .and_then(|url| url.rsplit('/').next().map(str::to_string))
                .map(|file_name| manifest_dir.join(file_name).exists())
                .unwrap_or(false)
        })
        .cloned()
        .collect()
}

/// Percent-encode path segments (spaces etc.) while keeping `/` separators, so
/// repo paths like `Riot Client/...` resolve on raw.githubusercontent.com.
fn encode_repo_path(path: &str) -> String {
    path.split('/')
        .map(|seg| {
            seg.chars()
                .map(|c| match c {
                    'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
                    _ => format!("%{:02X}", c as u32),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_patch_build_filename() {
        let (patch, build, version) = parse_filename("15.24.7347485.txt");
        assert_eq!(patch, "15.24");
        assert_eq!(build, "7347485");
        assert_eq!(version, "15.24.7347485");
    }

    #[test]
    fn parses_hotfix_style_name() {
        let (patch, build, version) = parse_filename("rls-patch-1-0-3_4095008.txt");
        // No trailing dotted-numeric build → whole stem is the patch.
        assert_eq!(build, "");
        assert_eq!(version, "rls-patch-1-0-3_4095008");
        assert_eq!(patch, "rls-patch-1-0-3_4095008");
    }

    #[test]
    fn filters_and_sorts_tree_entries_newest_first() {
        let json = r#"{
            "truncated": false,
            "tree": [
                {"type":"blob","path":"LoL/EUW1/windows/lol-game-client/15.24.7300505.txt"},
                {"type":"blob","path":"LoL/EUW1/windows/lol-game-client/15.24.7347485.txt"},
                {"type":"blob","path":"LoL/EUW1/windows/lol-standalone-client-content/15.24.7347485.txt"},
                {"type":"blob","path":"LoL/NA1/windows/lol-game-client/15.24.7347485.txt"},
                {"type":"tree","path":"LoL/EUW1/windows/lol-game-client"}
            ]
        }"#;
        let tree: GitTree = serde_json::from_str(json).unwrap();
        let entries = entries_from_tree(&tree, "EUW1", "windows");
        // 2 game + 1 client for EUW1/windows (NA1 excluded).
        assert_eq!(entries.len(), 3);
        // Newest build first.
        assert_eq!(entries[0].build, "7347485");
        assert!(entries.iter().any(|e| e.kind == "client"));
        assert!(entries.iter().all(|e| e.path.starts_with("LoL/EUW1/windows/")));
    }

    #[test]
    fn encodes_spaces_in_repo_path() {
        assert_eq!(
            encode_repo_path("Riot Client/KeystoneFoundationLiveWin/x.txt"),
            "Riot%20Client/KeystoneFoundationLiveWin/x.txt"
        );
    }
}
