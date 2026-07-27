//! League of Legends installation detection, via `ltk_mod_core`.

use crate::error::{Error, Result};
use ltk_mod_core::{auto_detect_league_path, is_valid_league_path};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const REQUIRED_FILES: &[&str] = &[
    "LeagueClient.exe",
];

const REQUIRED_DIRS: &[&str] = &[
    "Game",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeagueInstallation {
    pub path: PathBuf,
    pub game_path: PathBuf,
    pub auto_detected: bool,
}

impl LeagueInstallation {
    pub fn new(path: PathBuf, auto_detected: bool) -> Self {
        let game_path = path.join("Game");
        Self {
            path,
            game_path,
            auto_detected,
        }
    }

}

/// Detects a League installation via `ltk_mod_core`, which checks (in order):
/// RiotClientInstalls.json, running League processes, common paths, the registry.
pub fn detect_league_installation() -> Result<LeagueInstallation> {
    tracing::info!("Attempting to detect League of Legends installation via ltk_mod_core");

    if let Some(exe_path) = auto_detect_league_path() {
        tracing::info!("ltk_mod_core found League at: {}", exe_path);

        // ltk_mod_core returns Game/League of Legends.exe; go up to the root.
        if let Some(game_path) = exe_path.parent() {
            if let Some(root_path) = game_path.parent() {
                let root_buf = PathBuf::from(root_path.as_str());
                tracing::info!("League installation root: {}", root_buf.display());
                return Ok(LeagueInstallation::new(root_buf, true));
            }
        }
    }

    tracing::warn!("No League of Legends installation found via ltk_mod_core");
    Err(Error::InvalidInput(
        "Could not detect League of Legends installation. Please specify the path manually.".to_string()
    ))
}

pub fn validate_league_path(path: impl AsRef<Path>) -> Result<LeagueInstallation> {
    let path = path.as_ref();
    tracing::debug!("Validating League path: {}", path.display());
    validate_and_create(path, false)
}

fn validate_and_create(path: &Path, auto_detected: bool) -> Result<LeagueInstallation> {
    if !path.exists() {
        return Err(Error::InvalidInput(format!(
            "Path does not exist: {}",
            path.display()
        )));
    }

    for file in REQUIRED_FILES {
        let file_path = path.join(file);
        if !file_path.exists() {
            return Err(Error::InvalidInput(format!(
                "Required file not found: {} (expected at {})",
                file,
                file_path.display()
            )));
        }
    }

    for dir in REQUIRED_DIRS {
        let dir_path = path.join(dir);
        if !dir_path.is_dir() {
            return Err(Error::InvalidInput(format!(
                "Required directory not found: {} (expected at {})",
                dir,
                dir_path.display()
            )));
        }
    }

    let exe_path = path.join("Game").join("League of Legends.exe");
    if exe_path.exists() {
        if let Ok(utf8_path) = camino::Utf8PathBuf::from_path_buf(exe_path) {
            if is_valid_league_path(&utf8_path) {
                tracing::debug!("ltk_mod_core validation passed");
            }
        }
    }

    tracing::debug!("League path validated successfully: {}", path.display());
    Ok(LeagueInstallation::new(path.to_path_buf(), auto_detected))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_league_installation_new() {
        let path = PathBuf::from("C:\\Riot Games\\League of Legends");
        let installation = LeagueInstallation::new(path.clone(), true);
        
        assert_eq!(installation.path, path);
        assert_eq!(installation.game_path, path.join("Game"));
        assert!(installation.auto_detected);
    }

    #[test]
    fn test_league_installation_paths() {
        let path = PathBuf::from("C:\\Riot Games\\League of Legends");
        let installation = LeagueInstallation::new(path.clone(), false);

        assert_eq!(installation.game_path, path.join("Game"));
        assert!(!installation.auto_detected);
    }

    #[test]
    fn test_validate_nonexistent_path() {
        let result = validate_league_path("/nonexistent/path/to/league");
        assert!(result.is_err());
        
        if let Err(Error::InvalidInput(msg)) = result {
            assert!(msg.contains("does not exist"));
        } else {
            panic!("Expected InvalidInput error");
        }
    }

    #[test]
    fn test_required_files_not_empty() {
        assert!(!REQUIRED_FILES.is_empty());
        assert!(REQUIRED_FILES.contains(&"LeagueClient.exe"));
    }
}
