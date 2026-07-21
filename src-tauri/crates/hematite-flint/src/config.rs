//! Fix-config + champion-list loading: remote fetch → cache → embedded fallback.
//!
//! Ported from Hematite's `hematite-cli/src/remote.rs` so Flint gets live config
//! updates, with the same "prefer embedded when newer" version gate that stops a
//! stale remote from dropping a fix id the bundled engine expects. Cache lives
//! under Flint's appdata so it never collides with a CLI install.

use hematite_types::champion::{CharacterRelations, ChampionList};
use hematite_types::config::FixConfig;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const GITHUB_RAW_BASE: &str =
    "https://raw.githubusercontent.com/RitoShark/Hematite/main/config";
const CACHE_TTL: Duration = Duration::from_secs(3600);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

const EMBEDDED_FIX_CONFIG: &str = include_str!("../config/fix_config.json");
const EMBEDDED_CHAMPION_LIST: &str = include_str!("../config/champion_list.json");

/// The fully-resolved config Flint hands to the fix engine.
pub struct LoadedConfig {
    pub fix_config: FixConfig,
    pub champions: CharacterRelations,
}

/// Load the fix config + champion relations (remote → cache → embedded).
pub fn load_config() -> LoadedConfig {
    LoadedConfig {
        fix_config: load_fix_config(),
        champions: CharacterRelations::from_champion_list(&load_champion_list()),
    }
}

fn cache_dir() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    Some(PathBuf::from(appdata).join("Flint").join("hematite-cache"))
}

fn is_cache_valid(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return false;
    };
    let Ok(elapsed) = SystemTime::now().duration_since(modified) else {
        return false;
    };
    elapsed < CACHE_TTL
}

fn fetch_json(url: &str) -> anyhow::Result<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent("Flint-SkinFixer")
        .build()?;
    let resp = client.get(url).send()?;
    if !resp.status().is_success() {
        anyhow::bail!("HTTP {} from {}", resp.status(), url);
    }
    Ok(resp.text()?)
}

/// Generic cache/fetch/stale/embedded chain for one config file.
fn load_json<T: serde::de::DeserializeOwned>(file_name: &str, embedded: &str) -> T {
    let parse_embedded = || {
        serde_json::from_str::<T>(embedded)
            .expect("embedded config JSON is invalid — this is a build error")
    };

    let Some(dir) = cache_dir() else {
        return parse_embedded();
    };
    let cache_file = dir.join(file_name);

    // 1. Fresh cache.
    if is_cache_valid(&cache_file) {
        if let Ok(content) = std::fs::read_to_string(&cache_file) {
            if let Ok(parsed) = serde_json::from_str::<T>(&content) {
                return parsed;
            }
        }
    }

    // 2. Remote fetch → update cache.
    let url = format!("{GITHUB_RAW_BASE}/{file_name}");
    match fetch_json(&url) {
        Ok(content) => {
            if let Ok(parsed) = serde_json::from_str::<T>(&content) {
                let _ = std::fs::create_dir_all(&dir);
                let _ = std::fs::write(&cache_file, &content);
                return parsed;
            }
            tracing::warn!("fetched {file_name} failed to parse; falling back");
        }
        Err(e) => tracing::warn!("fetch {file_name} failed: {e}; falling back"),
    }

    // 3. Stale cache.
    if let Ok(content) = std::fs::read_to_string(&cache_file) {
        if let Ok(parsed) = serde_json::from_str::<T>(&content) {
            return parsed;
        }
    }

    // 4. Embedded.
    parse_embedded()
}

fn load_fix_config() -> FixConfig {
    let config: FixConfig = load_json("fix_config.json", EMBEDDED_FIX_CONFIG);
    // Never run a config older than the one bundled with this engine — the
    // bundled fix ids are guaranteed present in the embedded config.
    let embedded: FixConfig = serde_json::from_str(EMBEDDED_FIX_CONFIG)
        .expect("embedded fix_config.json is invalid — build error");
    if version_newer(&embedded.version, &config.version) {
        tracing::info!(
            "remote fix config {} older than embedded {} — using embedded",
            config.version,
            embedded.version
        );
        return embedded;
    }
    config
}

fn load_champion_list() -> ChampionList {
    load_json("champion_list.json", EMBEDDED_CHAMPION_LIST)
}

/// Dotted-numeric compare: true when `a` is strictly newer than `b`.
/// Non-numeric / missing segments compare as 0.
fn version_newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|s| s.trim().parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parse(a), parse(b));
    let len = a.len().max(b.len());
    for i in 0..len {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_newer_orders_correctly() {
        assert!(version_newer("2.2.0", "2.1.0"));
        assert!(!version_newer("2.1.0", "2.2.0"));
        assert!(!version_newer("2.2.0", "2.2.0"));
        assert!(version_newer("10.0.0", "9.9.9"));
        assert!(version_newer("2.2.0.1", "2.2.0"));
        assert!(version_newer("2.2.0", "2.x.9")); // garbage → 0
    }

    #[test]
    fn embedded_configs_parse() {
        let cfg: FixConfig = serde_json::from_str(EMBEDDED_FIX_CONFIG).unwrap();
        assert!(!cfg.fixes.is_empty() || !cfg.wad_fixes.is_empty());
        let list: ChampionList = serde_json::from_str(EMBEDDED_CHAMPION_LIST).unwrap();
        let _ = CharacterRelations::from_champion_list(&list);
    }
}
