use std::fs;
use std::path::{Path, PathBuf};

static TOON_SHADING_TEX: &[u8] = include_bytes!("../../../resources/toon/ToonShading.tex");
static OUTLINE_TONE_MAP_TEX: &[u8] = include_bytes!("../../../resources/toon/OutlineToneMap.tex");

/// In-WAD folder the ramps live under. Shared with Jade's material library so a
/// project touched by both tools carries one copy, not two.
const TOON_ASSET_DIR: &str = "assets/jadelib/toon-shading";

const RAMPS: [(&str, &[u8]); 2] = [
    ("ToonShading.tex", TOON_SHADING_TEX),
    ("OutlineToneMap.tex", OUTLINE_TONE_MAP_TEX),
];

#[derive(serde::Serialize)]
pub struct ToonRampInstall {
    pub texture_paths: Vec<String>,
    pub written: Vec<String>,
}

fn wad_folder_of(bin_path: &Path) -> Option<PathBuf> {
    let mut dir = bin_path.parent();
    while let Some(current) = dir {
        let name = current.file_name()?.to_string_lossy().to_ascii_lowercase();
        if name.ends_with(".wad.client") || name.ends_with(".wad") {
            return Some(current.to_path_buf());
        }
        dir = current.parent();
    }
    None
}

#[tauri::command]
pub async fn install_toon_ramps(bin_path: String) -> Result<ToonRampInstall, String> {
    let bin = PathBuf::from(&bin_path);
    let wad = wad_folder_of(&bin).ok_or_else(|| {
        format!("{bin_path} is not inside a WAD folder — open the bin from a project to add toon shading")
    })?;

    let target = wad.join(TOON_ASSET_DIR.replace('/', std::path::MAIN_SEPARATOR_STR));
    fs::create_dir_all(&target).map_err(|e| format!("create {}: {e}", target.display()))?;

    let mut written = Vec::new();
    for (name, bytes) in RAMPS {
        let dest = target.join(name);
        if fs::metadata(&dest).is_ok_and(|m| m.len() as usize == bytes.len()) {
            continue;
        }
        fs::write(&dest, bytes).map_err(|e| format!("write {}: {e}", dest.display()))?;
        written.push(name.to_string());
    }

    Ok(ToonRampInstall {
        texture_paths: RAMPS
            .iter()
            .map(|(name, _)| format!("{TOON_ASSET_DIR}/{name}"))
            .collect(),
        written,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_wad_folder_above_a_bin() {
        let bin = Path::new("C:/proj/content/base/aurora.wad.client/data/characters/aurora/skins/skin0.bin");
        assert_eq!(
            wad_folder_of(bin).unwrap(),
            Path::new("C:/proj/content/base/aurora.wad.client"),
        );
    }

    #[test]
    fn a_bin_outside_a_wad_folder_has_none() {
        assert!(wad_folder_of(Path::new("C:/somewhere/skin0.bin")).is_none());
    }

    #[test]
    fn the_bundled_ramps_are_tex_files() {
        for (_, bytes) in RAMPS {
            assert_eq!(&bytes[0..4], b"TEX\0");
        }
    }
}
