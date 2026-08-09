use flint_core::skin_port::{jade_character_name, port_skin_bin, PortOutcome};
use std::path::{Path, PathBuf};

fn find_character_skin_bin(project: &Path, character: &str, skin_id: u32) -> Option<PathBuf> {
    let needle = format!(
        "data/characters/{}/skins/skin{}.bin",
        character.to_ascii_lowercase(),
        skin_id
    );
    walkdir::WalkDir::new(project)
        .into_iter()
        .filter_map(|e| e.ok())
        .map(|e| e.into_path())
        .find(|p| {
            p.to_string_lossy()
                .replace('\\', "/")
                .to_ascii_lowercase()
                .ends_with(&needle)
        })
}

fn characters_dir(skin_bin: &Path) -> Option<&Path> {
    skin_bin.parent()?.parent()?.parent()
}

fn run_port(
    project_path: &str,
    source_character: &str,
    source_skin_id: u32,
    dest_character: &str,
    targets: &[u32],
) -> Result<PortOutcome, String> {
    let project = Path::new(project_path);
    let source = find_character_skin_bin(project, source_character, source_skin_id).ok_or_else(
        || {
            format!(
                "No data/characters/{}/skins/skin{}.bin in this project",
                source_character.to_ascii_lowercase(),
                source_skin_id
            )
        },
    )?;

    let dest_skins_dir = characters_dir(&source)
        .ok_or_else(|| format!("Unexpected skin BIN location: {}", source.display()))?
        .join(dest_character.to_ascii_lowercase())
        .join("skins");

    for &skin_id in targets {
        crate::core::write_echo::mark(dest_skins_dir.join(format!("skin{skin_id}.bin")));
        crate::core::write_echo::mark(dest_skins_dir.join(format!("skin{skin_id}.bin.ritobin")));
    }

    let outcome = port_skin_bin(&source, &dest_skins_dir, dest_character, targets)?;

    for skin_id in &outcome.written {
        let sidecar = dest_skins_dir.join(format!("skin{skin_id}.bin.ritobin"));
        if sidecar.exists() {
            let _ = std::fs::remove_file(&sidecar);
        }
    }

    tracing::info!(
        "[skin-port] {} -> {}: {} written, {} skipped",
        source.display(),
        dest_skins_dir.display(),
        outcome.written.len(),
        outcome.skipped.len()
    );
    Ok(outcome)
}

#[tauri::command]
pub async fn port_project_to_jade(
    project_path: String,
    champion: String,
    source_skin_id: u32,
    targets: Vec<u32>,
) -> Result<PortOutcome, String> {
    let dest_character = jade_character_name(&champion);
    run_port(
        &project_path,
        &champion,
        source_skin_id,
        &dest_character,
        &targets,
    )
}

#[tauri::command]
pub async fn port_project_no_skin_lite(
    project_path: String,
    champion: String,
    source_skin_id: u32,
    targets: Vec<u32>,
) -> Result<PortOutcome, String> {
    run_port(
        &project_path,
        &champion,
        source_skin_id,
        &champion,
        &targets,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn project_with_skin(root: &Path, character: &str, skin_id: u32) -> PathBuf {
        let dir = root
            .join("content/base/ahri.wad.client/data/characters")
            .join(character)
            .join("skins");
        fs::create_dir_all(&dir).unwrap();
        let bin = dir.join(format!("skin{skin_id}.bin"));
        fs::write(&bin, b"placeholder").unwrap();
        bin
    }

    #[test]
    fn the_skin_bin_is_found_by_its_character_folder() {
        let tmp = std::env::temp_dir().join(format!("flint-skinport-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let expected = project_with_skin(&tmp, "ahri", 1);
        project_with_skin(&tmp, "annietibbers", 1);

        let found = find_character_skin_bin(&tmp, "Ahri", 1).unwrap();
        assert_eq!(found, expected);
        assert!(find_character_skin_bin(&tmp, "Ahri", 7).is_none());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn the_jade_destination_is_a_sibling_character_folder() {
        let tmp = std::env::temp_dir().join(format!("flint-skinport-dest-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let source = project_with_skin(&tmp, "ahri", 1);

        let dest = characters_dir(&source)
            .unwrap()
            .join(jade_character_name("Ahri").to_ascii_lowercase())
            .join("skins");
        assert!(dest.ends_with("characters/jade_ahri/skins"));

        let _ = fs::remove_dir_all(&tmp);
    }
}
