//! Champion and skin discovery.

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChampionInfo {
    pub name: String,
    /// Internal name used in file paths (e.g. "Ahri").
    pub internal_name: String,
    pub skins: Vec<SkinInfo>,
    pub wad_path: Option<String>,
}

impl ChampionInfo {
    pub fn new(internal_name: impl Into<String>) -> Self {
        let internal = internal_name.into();
        Self {
            name: format_champion_name(&internal),
            internal_name: internal,
            skins: Vec::new(),
            wad_path: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkinInfo {
    /// 0 = base skin.
    pub id: u32,
    /// May be resolved from hash or generated.
    pub name: String,
    /// e.g. "Skin0", "Skin1".
    pub folder_name: String,
}

impl SkinInfo {
    pub fn new(id: u32) -> Self {
        Self {
            id,
            name: if id == 0 {
                "Base".to_string()
            } else {
                format!("Skin {}", id)
            },
            folder_name: format!("Skin{}", id),
        }
    }
}

pub fn discover_champions(league_path: &Path) -> Result<Vec<ChampionInfo>> {
    tracing::info!("Discovering champions in: {}", league_path.display());

    let champions_dir = league_path
        .join("Game")
        .join("DATA")
        .join("FINAL")
        .join("Champions");

    if !champions_dir.exists() {
        tracing::debug!("Champions directory not found, trying alternative structure");
        let alt_champions = league_path.join("DATA").join("FINAL").join("Champions");
        if alt_champions.exists() {
            return discover_from_directory(&alt_champions);
        }

        return discover_from_wad_files(league_path);
    }

    discover_from_directory(&champions_dir)
}

fn discover_from_directory(champions_dir: &Path) -> Result<Vec<ChampionInfo>> {
    tracing::debug!("Scanning directory: {}", champions_dir.display());

    let mut champions: HashMap<String, ChampionInfo> = HashMap::new();

    let entries = fs::read_dir(champions_dir)
        .map_err(|e| Error::io_with_path(e, champions_dir))?;

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let file_name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");

        if file_name.to_lowercase().ends_with(".wad.client") {
            if let Some(champion_name) = extract_champion_from_wad_name(file_name) {
                let champion = champions
                    .entry(champion_name.clone())
                    .or_insert_with(|| ChampionInfo::new(&champion_name));
                champion.wad_path = Some(path.to_string_lossy().to_string());
            }
        }

        if path.is_dir() && !file_name.starts_with('.') {
            let champion_name = file_name.to_string();
            champions
                .entry(champion_name.clone())
                .or_insert_with(|| ChampionInfo::new(&champion_name));
        }
    }

    let mut result: Vec<ChampionInfo> = champions.into_values().collect();
    result.sort_by(|a, b| a.name.cmp(&b.name));

    tracing::info!("Discovered {} champions", result.len());
    Ok(result)
}

fn discover_from_wad_files(league_path: &Path) -> Result<Vec<ChampionInfo>> {
    tracing::debug!("Scanning for WAD files in: {}", league_path.display());

    let game_dir = league_path.join("Game");
    if !game_dir.exists() {
        return Err(Error::InvalidInput(format!(
            "Game directory not found at: {}",
            game_dir.display()
        )));
    }

    let mut champions: HashMap<String, ChampionInfo> = HashMap::new();

    scan_for_champion_wads(&game_dir, &mut champions)?;

    let mut result: Vec<ChampionInfo> = champions.into_values().collect();
    result.sort_by(|a, b| a.name.cmp(&b.name));

    tracing::info!("Discovered {} champions from WAD files", result.len());
    Ok(result)
}

fn scan_for_champion_wads(dir: &Path, champions: &mut HashMap<String, ChampionInfo>) -> Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();

        if path.is_dir() {
            let dir_name = path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            if dir_name.eq_ignore_ascii_case("Champions") {
                discover_from_directory(&path)?
                    .into_iter()
                    .for_each(|c| { champions.insert(c.internal_name.clone(), c); });
            }
            else if !dir_name.starts_with('.') && path.components().count() < 10 {
                scan_for_champion_wads(&path, champions)?;
            }
        } else {
            let file_name = path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            if file_name.to_lowercase().ends_with(".wad.client") {
                if let Some(champion_name) = extract_champion_from_wad_name(file_name) {
                    let champion = champions
                        .entry(champion_name.clone())
                        .or_insert_with(|| ChampionInfo::new(&champion_name));
                    champion.wad_path = Some(path.to_string_lossy().to_string());
                }
            }
        }
    }

    Ok(())
}

/// Examples:
/// - "Ahri.wad.client" -> Some("Ahri")
/// - "Ahri_Base.wad.client" -> Some("Ahri")
/// - "random.wad.client" -> None (not in Champions folder pattern)
fn extract_champion_from_wad_name(filename: &str) -> Option<String> {
    let name = filename
        .strip_suffix(".wad.client")
        .or_else(|| filename.strip_suffix(".wad"))
        .unwrap_or(filename);

    let base_name = name.split('_').next().unwrap_or(name);

    if base_name.is_empty() || !base_name.chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false) {
        return None;
    }

    Some(base_name.to_string())
}

pub fn get_champion_skins(league_path: &Path, champion: &str) -> Result<Vec<SkinInfo>> {
    tracing::debug!("Getting skins for champion: {}", champion);

    let champions_dir = league_path
        .join("Game")
        .join("DATA")
        .join("FINAL")
        .join("Champions")
        .join(champion)
        .join("Skins");

    let mut skins = Vec::new();

    skins.push(SkinInfo::new(0));

    if champions_dir.exists() {
        if let Ok(entries) = fs::read_dir(&champions_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                if let Some(name) = entry.file_name().to_str() {
                    if let Some(skin_id) = parse_skin_folder_name(name) {
                        if skin_id != 0 {
                            skins.push(SkinInfo::new(skin_id));
                        }
                    }
                }
            }
        }
    } else {
        // No folder structure found — fall back to a few default skins.
        for i in 1..=5 {
            skins.push(SkinInfo::new(i));
        }
    }

    skins.sort_by_key(|s| s.id);

    tracing::debug!("Found {} skins for {}", skins.len(), champion);
    Ok(skins)
}

/// Examples:
/// - "Skin0" -> Some(0)
/// - "Skin1" -> Some(1)
/// - "Base" -> Some(0)
/// - "Invalid" -> None
fn parse_skin_folder_name(name: &str) -> Option<u32> {
    if name.eq_ignore_ascii_case("Base") {
        return Some(0);
    }

    if let Some(id_str) = name.strip_prefix("Skin").or_else(|| name.strip_prefix("skin")) {
        id_str.parse().ok()
    } else {
        None
    }
}

/// Examples:
/// - "Ahri" -> "Ahri"
/// - "AurelionSol" -> "Aurelion Sol"
/// - "MasterYi" -> "Master Yi"
fn format_champion_name(internal_name: &str) -> String {
    let mut result = String::with_capacity(internal_name.len() + 5);
    let mut prev_was_lowercase = false;

    for c in internal_name.chars() {
        if c.is_uppercase() && prev_was_lowercase {
            result.push(' ');
        }
        result.push(c);
        prev_was_lowercase = c.is_lowercase();
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_champion_info_new() {
        let champion = ChampionInfo::new("Ahri");
        assert_eq!(champion.internal_name, "Ahri");
        assert_eq!(champion.name, "Ahri");
        assert!(champion.skins.is_empty());
    }

    #[test]
    fn test_skin_info_new() {
        let base = SkinInfo::new(0);
        assert_eq!(base.id, 0);
        assert_eq!(base.name, "Base");
        assert_eq!(base.folder_name, "Skin0");

        let skin1 = SkinInfo::new(1);
        assert_eq!(skin1.id, 1);
        assert_eq!(skin1.name, "Skin 1");
        assert_eq!(skin1.folder_name, "Skin1");
    }

    #[test]
    fn test_format_champion_name() {
        assert_eq!(format_champion_name("Ahri"), "Ahri");
        assert_eq!(format_champion_name("AurelionSol"), "Aurelion Sol");
        assert_eq!(format_champion_name("MasterYi"), "Master Yi");
        assert_eq!(format_champion_name("TwistedFate"), "Twisted Fate");
        assert_eq!(format_champion_name("DrMundo"), "Dr Mundo");
    }

    #[test]
    fn test_extract_champion_from_wad_name() {
        assert_eq!(extract_champion_from_wad_name("Ahri.wad.client"), Some("Ahri".to_string()));
        assert_eq!(extract_champion_from_wad_name("Ahri_Base.wad.client"), Some("Ahri".to_string()));
        assert_eq!(extract_champion_from_wad_name("MasterYi.wad.client"), Some("MasterYi".to_string()));
        assert_eq!(extract_champion_from_wad_name("123.wad.client"), None);
    }

    #[test]
    fn test_parse_skin_folder_name() {
        assert_eq!(parse_skin_folder_name("Skin0"), Some(0));
        assert_eq!(parse_skin_folder_name("Skin1"), Some(1));
        assert_eq!(parse_skin_folder_name("Skin10"), Some(10));
        assert_eq!(parse_skin_folder_name("Base"), Some(0));
        assert_eq!(parse_skin_folder_name("skin5"), Some(5));
        assert_eq!(parse_skin_folder_name("Invalid"), None);
    }

    #[test]
    fn test_champion_skins() {
        let mut champion = ChampionInfo::new("Ahri");
        champion.skins.push(SkinInfo::new(0));
        champion.skins.push(SkinInfo::new(1));

        assert_eq!(champion.skins.len(), 2);
        assert_eq!(champion.skins[0].id, 0);
        assert_eq!(champion.skins[1].id, 1);
    }
}
