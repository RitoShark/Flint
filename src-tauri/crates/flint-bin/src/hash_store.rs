use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HashUniverse {
    Game,
    BinEntries,
    BinHashes,
    BinFields,
    BinTypes,
}

impl HashUniverse {
    pub const ALL: [Self; 5] = [
        Self::Game,
        Self::BinEntries,
        Self::BinHashes,
        Self::BinFields,
        Self::BinTypes,
    ];

    pub fn filename(self) -> &'static str {
        match self {
            Self::Game => "game.txt",
            Self::BinEntries => "binentries.txt",
            Self::BinHashes => "binhashes.txt",
            Self::BinFields => "binfields.txt",
            Self::BinTypes => "bintypes.txt",
        }
    }
}

pub fn hash_store_root(anchor: &Path) -> Option<PathBuf> {
    let mut cur = if anchor.is_file() {
        anchor.parent()
    } else {
        Some(anchor)
    };
    let mut fallback: Option<PathBuf> = None;

    for _ in 0..8 {
        let dir = cur?;
        if dir.join("mod.config.json").is_file() {
            return Some(dir.join(".hashes"));
        }
        if fallback.is_none() {
            let is_wad = dir
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.to_ascii_lowercase().ends_with(".wad.client"));
            if is_wad || dir.join("data").is_dir() || dir.join("assets").is_dir() {
                fallback = Some(dir.join(".hashes"));
            }
        }
        cur = dir.parent();
    }

    fallback
}

fn normalize_name(universe: HashUniverse, raw: &str) -> String {
    let trimmed = raw.trim();
    if universe == HashUniverse::Game {
        trimmed.replace('\\', "/").trim_start_matches('/').to_string()
    } else {
        trimmed.to_string()
    }
}

fn read_universe_set(path: &Path) -> BTreeSet<String> {
    let mut set = BTreeSet::new();
    if let Ok(content) = fs::read_to_string(path) {
        for line in content.lines() {
            let trimmed = line.trim();
            if !trimmed.is_empty() && !trimmed.starts_with('#') {
                set.insert(trimmed.to_string());
            }
        }
    }
    set
}

fn write_universe_set(path: &Path, set: &BTreeSet<String>) {
    let mut out = String::new();
    for item in set {
        out.push_str(item);
        out.push('\n');
    }
    let _ = fs::write(path, out);
}

pub fn merge_into_universe(anchor: &Path, universe: HashUniverse, names: &[String]) {
    if names.is_empty() {
        return;
    }
    let Some(dir) = hash_store_root(anchor) else {
        return;
    };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let file = dir.join(universe.filename());
    let mut set = read_universe_set(&file);
    let before = set.len();
    for raw in names {
        let norm = normalize_name(universe, raw);
        if !norm.is_empty() {
            set.insert(norm);
        }
    }
    if set.len() > before {
        write_universe_set(&file, &set);
    }
}

pub fn merge_trailer_into_dot_hashes(anchor: &Path, trailer: &crate::Trailer) {
    if trailer.is_empty() {
        return;
    }
    if !trailer.files.is_empty() {
        let game: Vec<String> = trailer.files.values().cloned().collect();
        merge_into_universe(anchor, HashUniverse::Game, &game);
    }
    if !trailer.names.is_empty() {
        let entries: Vec<String> = trailer.names.values().cloned().collect();
        merge_into_universe(anchor, HashUniverse::BinEntries, &entries);
    }
}

pub fn read_dot_hashes_into(anchor: &Path, trailer: &mut crate::Trailer) {
    let Some(dir) = hash_store_root(anchor) else {
        return;
    };
    if !dir.is_dir() {
        return;
    }

    for universe in HashUniverse::ALL {
        let file = dir.join(universe.filename());
        let Ok(content) = fs::read_to_string(&file) else {
            continue;
        };
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if universe == HashUniverse::Game {
                let norm = trimmed.replace('\\', "/").trim_start_matches('/').to_string();
                if !norm.is_empty() {
                    trailer
                        .files
                        .entry(ritoshark::hash::xxh64(&norm))
                        .or_insert(norm);
                }
            } else {
                trailer
                    .names
                    .entry(ritoshark::hash::fnv1a(trimmed))
                    .or_insert_with(|| trimmed.to_string());
            }
        }
    }
}

pub fn read_universe_lines(anchor: &Path, universe: HashUniverse) -> Vec<String> {
    let Some(dir) = hash_store_root(anchor) else {
        return Vec::new();
    };
    let file = dir.join(universe.filename());
    read_universe_set(&file).into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_and_reads_universes_under_project_root() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path();
        fs::write(project.join("mod.config.json"), "{}").unwrap();
        let wad = project.join("content").join("base").join("talon.wad.client");
        fs::create_dir_all(&wad).unwrap();

        merge_into_universe(
            &wad,
            HashUniverse::Game,
            &["assets/sirdexal/test/talon_w.tex".to_string()],
        );
        merge_into_universe(
            &wad,
            HashUniverse::BinEntries,
            &["Characters/Talon/Skins/Skin38".to_string()],
        );

        assert!(project.join(".hashes").join("game.txt").is_file());
        assert!(project.join(".hashes").join("binentries.txt").is_file());

        let mut trailer = crate::Trailer::new();
        read_dot_hashes_into(&wad, &mut trailer);

        let expected_game = ritoshark::hash::xxh64("assets/sirdexal/test/talon_w.tex");
        let expected_entry = ritoshark::hash::fnv1a("Characters/Talon/Skins/Skin38");
        assert_eq!(
            trailer.files.get(&expected_game).map(String::as_str),
            Some("assets/sirdexal/test/talon_w.tex")
        );
        assert_eq!(
            trailer.names.get(&expected_entry).map(String::as_str),
            Some("Characters/Talon/Skins/Skin38")
        );
    }
}
