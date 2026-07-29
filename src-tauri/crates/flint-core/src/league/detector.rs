//! League of Legends installation detection.
//!
//! Detection runs in priority order:
//!  1. `RiotClientInstalls.json` (ProgramData) — authoritative when present
//!  2. Common install paths across drives
//!  3. Windows registry (`winreg`, no `reg.exe` shell-out)
//!
//! All the Riot names and paths below are inherently hardcoded — they are
//! Riot's install layout, and there is nothing we can do about that.

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const GAME_EXE: &str = "League of Legends.exe";
const GAME_DIR: &str = "Game";

const REQUIRED_FILES: &[&str] = &[
    "LeagueClient.exe",
];

const REQUIRED_DIRS: &[&str] = &[
    GAME_DIR,
];

const FALLBACK_DRIVES: &[&str] = &["C:", "D:", "E:", "F:", "G:", "H:"];

const COMMON_SUBPATHS: &[&str] = &[
    "Riot Games\\League of Legends",
    "Program Files\\Riot Games\\League of Legends",
    "Program Files (x86)\\Riot Games\\League of Legends",
];

#[cfg(windows)]
const REGISTRY_SUBKEY: &str = r"SOFTWARE\WOW6432Node\Riot Games, Inc\League of Legends";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeagueInstallation {
    pub path: PathBuf,
    pub game_path: PathBuf,
    pub auto_detected: bool,
}

impl LeagueInstallation {
    pub fn new(path: PathBuf, auto_detected: bool) -> Self {
        let game_path = path.join(GAME_DIR);
        Self {
            path,
            game_path,
            auto_detected,
        }
    }

    /// Accept a candidate install root only if it really holds the game exe.
    /// Every detection stage funnels through here, so a stale registry entry or
    /// a leftover `RiotClientInstalls.json` row can't yield a bogus install.
    fn from_root_detected(root: PathBuf) -> Option<Self> {
        root.join(GAME_DIR)
            .join(GAME_EXE)
            .is_file()
            .then(|| Self::new(root, true))
    }
}

/// Parse League install roots out of `RiotClientInstalls.json` content.
/// PBE installs are excluded — the folder must be exactly "League of Legends",
/// otherwise a PBE row would win over the live client it sits beside.
pub(crate) fn league_paths_from_riot_installs_json(content: &str) -> Vec<PathBuf> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(content) else {
        return Vec::new();
    };
    let Some(map) = v.get("associated_client").and_then(|c| c.as_object()) else {
        return Vec::new();
    };
    map.keys()
        .filter(|k| k.trim_end_matches(['/', '\\']).ends_with("League of Legends"))
        .map(PathBuf::from)
        .collect()
}

fn detect_from_riot_client_installs() -> Option<LeagueInstallation> {
    let system_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    let json_path =
        PathBuf::from(format!("{system_drive}\\ProgramData\\Riot Games\\RiotClientInstalls.json"));
    let content = std::fs::read_to_string(json_path).ok()?;
    league_paths_from_riot_installs_json(&content)
        .into_iter()
        .find_map(LeagueInstallation::from_root_detected)
}

fn detect_from_common_paths() -> Option<LeagueInstallation> {
    FALLBACK_DRIVES.iter().find_map(|drive| {
        COMMON_SUBPATHS.iter().find_map(|sub| {
            LeagueInstallation::from_root_detected(PathBuf::from(format!("{drive}\\{sub}")))
        })
    })
}

/// Read the install location straight out of the registry. Uses `winreg`
/// rather than shelling out to `reg.exe` — no child process, no output parsing.
#[cfg(windows)]
fn detect_from_registry() -> Option<LeagueInstallation> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(REGISTRY_SUBKEY)
        .ok()?;
    let location: String = key.get_value("Location").ok()?;
    LeagueInstallation::from_root_detected(PathBuf::from(location))
}

#[cfg(not(windows))]
fn detect_from_registry() -> Option<LeagueInstallation> {
    None
}

/// Detects a League installation, trying each mechanism in priority order.
pub fn detect_league_installation() -> Result<LeagueInstallation> {
    tracing::info!("Attempting to detect League of Legends installation");

    let found = detect_from_riot_client_installs()
        .or_else(detect_from_common_paths)
        .or_else(detect_from_registry);

    if let Some(installation) = found {
        tracing::info!("League installation root: {}", installation.path.display());
        return Ok(installation);
    }

    tracing::warn!("No League of Legends installation found");
    Err(Error::InvalidInput(
        "Could not detect League of Legends installation. Please specify the path manually."
            .to_string(),
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

    tracing::debug!("League path validated successfully: {}", path.display());
    Ok(LeagueInstallation::new(path.to_path_buf(), auto_detected))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal on-disk shape the detector treats as a real install.
    fn fake_install(root: &Path) {
        let game = root.join(GAME_DIR);
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(game.join(GAME_EXE), b"").unwrap();
    }

    #[test]
    fn test_league_installation_new() {
        let path = PathBuf::from("C:\\Riot Games\\League of Legends");
        let installation = LeagueInstallation::new(path.clone(), true);

        assert_eq!(installation.path, path);
        assert_eq!(installation.game_path, path.join(GAME_DIR));
        assert!(installation.auto_detected);
    }

    #[test]
    fn test_league_installation_paths() {
        let path = PathBuf::from("C:\\Riot Games\\League of Legends");
        let installation = LeagueInstallation::new(path.clone(), false);

        assert_eq!(installation.game_path, path.join(GAME_DIR));
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

    #[test]
    fn from_root_detected_accepts_a_real_install() {
        let dir = tempfile::tempdir().unwrap();
        fake_install(dir.path());

        let installation =
            LeagueInstallation::from_root_detected(dir.path().to_path_buf()).unwrap();
        assert_eq!(installation.game_path, dir.path().join(GAME_DIR));
        assert!(installation.auto_detected);
    }

    #[test]
    fn from_root_detected_rejects_a_dir_without_the_game_exe() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(GAME_DIR)).unwrap();

        assert!(LeagueInstallation::from_root_detected(dir.path().to_path_buf()).is_none());
    }

    #[test]
    fn riot_installs_json_parses_associated_client() {
        let json = r#"{
            "associated_client": {
                "C:/Riot Games/League of Legends/": "C:/Riot Games/Riot Client/x.exe",
                "C:/Riot Games/League of Legends (PBE)/": "C:/Riot Games/Riot Client/x.exe"
            }
        }"#;

        let paths = league_paths_from_riot_installs_json(json);
        // The PBE row must not be picked up — only the live install.
        assert_eq!(paths.len(), 1);
        assert!(paths[0].to_string_lossy().contains("League of Legends"));
        assert!(!paths[0].to_string_lossy().contains("PBE"));
    }

    #[test]
    fn riot_installs_json_survives_garbage() {
        assert!(league_paths_from_riot_installs_json("not json").is_empty());
        assert!(league_paths_from_riot_installs_json("{}").is_empty());
        assert!(league_paths_from_riot_installs_json(r#"{"associated_client": 5}"#).is_empty());
    }

    // Install roots are routinely non-ASCII and space-laden — localized Windows
    // ("Program Files" is translated on some locales), non-Latin usernames, and
    // custom game folders. Every stage works on `PathBuf`/`OsString`, so nothing
    // here is lossy; these lock that in.
    #[test]
    fn detects_installs_under_spaced_and_non_ascii_paths() {
        for name in [
            "Riot Games",                 // plain spaces
            "Oyunlar",                    // the owner's own layout
            "Игры",                       // Cyrillic
            "游戏",                        // CJK
            "Oyunlar (Yedek) — 2026",     // spaces + parens + em dash
            "Jogos ção",                  // accented Latin
            "게임 폴더",                    // Hangul + space
        ] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join(name).join("League of Legends");
            fake_install(&root);

            let installation = LeagueInstallation::from_root_detected(root.clone())
                .unwrap_or_else(|| panic!("failed to detect install under {name:?}"));
            assert_eq!(installation.path, root);
            assert_eq!(installation.game_path, root.join(GAME_DIR));

            // The manual-path route must accept the same folder.
            std::fs::write(root.join("LeagueClient.exe"), b"").unwrap();
            let validated = validate_league_path(&root)
                .unwrap_or_else(|e| panic!("validate failed for {name:?}: {e:?}"));
            assert_eq!(validated.path, root);
        }
    }

    #[test]
    fn riot_installs_json_handles_spaced_and_non_ascii_roots() {
        // Real-world shapes: a drive with spaces, and a non-ASCII parent folder.
        let json = r#"{
            "associated_client": {
                "D:/Oyunlar (Yedek)/Riot Games/League of Legends/": "x.exe",
                "C:/Игры/Riot Games/League of Legends/": "x.exe",
                "C:/Riot Games/League of Legends (PBE)/": "x.exe"
            }
        }"#;

        let paths = league_paths_from_riot_installs_json(json);
        assert_eq!(paths.len(), 2, "both live installs should survive, PBE should not");
        assert!(paths.iter().any(|p| p.to_string_lossy().contains("Oyunlar (Yedek)")));
        assert!(paths.iter().any(|p| p.to_string_lossy().contains("Игры")));
        assert!(!paths.iter().any(|p| p.to_string_lossy().contains("PBE")));
    }
}
