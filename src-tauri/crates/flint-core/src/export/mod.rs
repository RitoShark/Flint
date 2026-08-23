use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Mod-package container types, re-exported so callers build archives through
/// this module rather than depending on the packaging crate directly.
pub use ltk_modpkg::builder::{ModpkgBuilder, ModpkgChunkBuilder, ModpkgLayerBuilder};
pub use ltk_modpkg::{Modpkg, ModpkgAuthor, ModpkgMetadata};

fn is_unresolved_hash(path: &str) -> bool {
    let p = path.to_lowercase();
    let name = Path::new(&p).file_stem().unwrap_or_default().to_string_lossy();
    name.len() == 16 && name.chars().all(|c| c.is_ascii_hexdigit())
}

use crate::hash::wad_chunk_hash;

/// Extensions that are authoring input or tooling output, never game content.
///
/// League loads textures as `.tex` / `.dds` only, so an image in any editable format is a
/// source file someone left in the folder. Everything else here is a DCC scene, an archive,
/// or an editor's own text form of a bin.
const UNSHIPPABLE_EXTENSIONS: &[&str] = &[
    // Editor text forms of a bin.
    "ritobin", "rito", "py",
    // Image sources. The game reads none of these.
    "psd", "psb", "xcf", "kra", "clip", "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif",
    "tiff", "svg", "ai", "tga",
    // DCC scenes and interchange.
    "ma", "mb", "fbx", "obj", "blend", "blend1", "dae", "3ds", "max", "ztl", "spp", "sbs",
    "sbsar",
    // Archives, packaged mods, and scratch.
    "zip", "rar", "7z", "tar", "gz", "fantome", "modpkg", "wad", "bak", "tmp", "log", "md",
    "lnk", "url",
];

/// Files that are Flint's or the OS's own bookkeeping, matched by name.
///
/// `files.txt` is the hash→path record kept beside a mod; it travels as `META/files.txt`
/// in a fantome, so packing it as a WAD chunk as well would put a loose text file in the
/// game's WAD.
const UNSHIPPABLE_NAMES: &[&str] = &[
    "files.txt",
    "hashed_files.json",
    "thumbs.db",
    "desktop.ini",
    ".ds_store",
];

/** Whether a file inside a project's content tree belongs in a distributed mod.

Extension-only, deliberately: a `.png` a BIN somehow referenced still would not load, so
there is nothing to be gained by checking references, and plenty to lose in a rule nobody
can predict. Anything the game actually reads keeps its own extension (`.tex`, `.dds`,
`.bin`, `.anm`, `.skn`, `.skl`, `.scb`, `.sco`, `.bnk`, `.wpk`), and a chunk whose path
never resolved keeps its `{16hex}.dat` name — none of which appear here.

LANDMINE: do not add `.txt` or `.json` wholesale. Riot ships both inside WADs; only the
specific bookkeeping names in [`UNSHIPPABLE_NAMES`] are excluded. */
pub fn is_shippable(path: &Path) -> bool {
    if path
        .components()
        .any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case("testcuberenderer"))
    {
        return false;
    }

    let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_lowercase()) else {
        return false;
    };

    // A dotfile is a tool's, never the game's.
    if name.starts_with('.') && !UNSHIPPABLE_NAMES.contains(&name.as_str()) {
        return false;
    }
    if UNSHIPPABLE_NAMES.contains(&name.as_str()) {
        return false;
    }

    match path.extension().map(|e| e.to_string_lossy().to_lowercase()) {
        Some(ext) => !UNSHIPPABLE_EXTENSIONS.contains(&ext.as_str()),
        None => true,
    }
}


/** The shippable files inside a `.wad.client` directory, as (WAD-internal path, disk
path) pairs. See [`is_shippable`] for what is left out.

Both export shapes go through this: packing into a WAD binary and emitting the folder
verbatim into a `.fantome`. Keeping one walk means the two can never ship different
content. */
pub fn wad_directory_files(wad_dir: &Path) -> Result<HashMap<String, PathBuf>, String> {
    let mut wad_files: HashMap<String, PathBuf> = HashMap::new();
    let mut skipped = 0usize;
    for entry in walkdir::WalkDir::new(wad_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .filter(|e| {
            let keep = is_shippable(e.path());
            if !keep {
                tracing::debug!("Not shipping {}", e.path().display());
                skipped += 1;
            }
            keep
        })
    {
        let relative = entry
            .path()
            .strip_prefix(wad_dir)
            .map_err(|e| format!("Failed to strip prefix: {}", e))?;
        let wad_path = relative.to_string_lossy().replace('\\', "/");
        wad_files.insert(wad_path, entry.path().to_path_buf());
    }
    if skipped > 0 {
        tracing::info!(
            "Left {} source/working file(s) out of {}",
            skipped,
            wad_dir.display()
        );
    }
    Ok(wad_files)
}

/** The `.wad.client` directories a project ships. `content/base` is the only layer an
exporter reads, so a pre-export check that looked anywhere else would report on files no
player ever receives. */
pub fn project_wad_folders(project_path: &Path) -> Result<Vec<PathBuf>, String> {
    let content_base = project_path.join("content").join("base");
    let entries = std::fs::read_dir(&content_base)
        .map_err(|e| format!("Failed to read content/base: {}", e))?;

    let mut folders: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|e| format!("Failed to read directory entry: {}", e))?
            .path();
        let is_wad = path
            .file_name()
            .map(|n| n.to_string_lossy().ends_with(".wad.client"))
            .unwrap_or(false);
        if path.is_dir() && is_wad {
            folders.push(path);
        }
    }
    folders.sort();
    Ok(folders)
}

/// Builds a valid WAD v3.4 binary (zstd-compressed, deduplicated chunks) from a
/// `.wad.client` directory.
pub fn build_wad_from_directory(wad_dir: &Path) -> Result<Vec<u8>, String> {
    use crate::wad::writer::{write_wad, EntryToWrite};

    let wad_files = wad_directory_files(wad_dir)?;

    if wad_files.is_empty() {
        return Err(format!("No files found in WAD directory: {}", wad_dir.display()));
    }

    tracing::info!("Building WAD from {} files in {}", wad_files.len(), wad_dir.display());

    let mut entries = Vec::with_capacity(wad_files.len());

    for (wad_path, file_path) in &wad_files {
        let hash = if is_unresolved_hash(wad_path) {
            let name = Path::new(wad_path).file_stem().unwrap_or_default().to_string_lossy();
            u64::from_str_radix(&name, 16).unwrap_or(0)
        } else {
            wad_chunk_hash(wad_path)
        };
        
        let data = std::fs::read(file_path)
            .map_err(|e| format!("Failed to read {}: {}", file_path.display(), e))?;
            
        entries.push(EntryToWrite::new(hash, data));
    }

    let (wad_bytes, stats) = write_wad(entries)
        .map_err(|e| format!("Failed to build WAD: {}", e))?;

    tracing::info!("WAD built: {} bytes from {} chunks ({} files read)", wad_bytes.len(), stats.chunk_count, wad_files.len());
    Ok(wad_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wad_chunk_hash_is_case_insensitive() {
        // A mixed-case path must hash identically to its lowercase form — the
        // game and every unhash tool look chunks up by xxh64(lowercase).
        let mixed = "DATA/Characters/Aatrox/Skins/Skin0.bin";
        let lower = "data/characters/aatrox/skins/skin0.bin";
        assert_eq!(wad_chunk_hash(mixed), wad_chunk_hash(lower));
    }

    #[test]
    fn wad_chunk_hash_matches_canonical_xxh64_lowercase() {
        // Explicitly pin the convention: xxh64 of the LOWERCASED bytes, seed 0.
        let path = "ASSETS/Characters/Foo/Bar.tex";
        let expected = xxhash_rust::xxh64::xxh64(path.to_lowercase().as_bytes(), 0);
        assert_eq!(wad_chunk_hash(path), expected);
    }

    #[test]
    fn wad_chunk_hash_would_differ_without_lowercasing() {
        // Guards against a regression to the old bug: a mixed-case path hashed
        // verbatim produces a DIFFERENT (unresolvable) hash.
        let path = "DATA/Characters/Aatrox.bin";
        let buggy = xxhash_rust::xxh64::xxh64(path.as_bytes(), 0);
        assert_ne!(wad_chunk_hash(path), buggy);
    }

    #[test]
    fn only_wad_client_dirs_under_content_base_are_shipped() {
        let root = std::env::temp_dir().join(format!("flint-wadfolders-{}", std::process::id()));
        let base = root.join("content").join("base");
        std::fs::create_dir_all(base.join("Aatrox.wad.client")).unwrap();
        std::fs::create_dir_all(base.join("Map11.wad.client")).unwrap();
        std::fs::create_dir_all(base.join("scratch")).unwrap();
        std::fs::create_dir_all(root.join("content").join("other.wad.client")).unwrap();
        std::fs::write(base.join("packed.wad.client"), b"x").unwrap();

        let names: Vec<String> = project_wad_folders(&root)
            .unwrap()
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["Aatrox.wad.client", "Map11.wad.client"]);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_project_without_content_base_is_an_error() {
        let root = std::env::temp_dir().join(format!("flint-nowads-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        assert!(project_wad_folders(&root).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
    #[test]
    fn game_content_ships() {
        for name in [
            "assets/characters/yone/skins/base/yone_tx_cm.tex",
            "assets/characters/yone/particles/trail.dds",
            "data/characters/yone/skins/skin0.bin",
            "assets/characters/yone/animations/attack1.anm",
            "assets/characters/yone/yone.skn",
            "assets/characters/yone/yone.skl",
            "assets/shared/x.scb",
            "assets/shared/x.sco",
            "assets/sounds/x.bnk",
            "assets/sounds/x.wpk",
            // A chunk whose path never resolved keeps its hash name — real content.
            "49c1928a75b65dbf.dat",
        ] {
            assert!(is_shippable(Path::new(name)), "{name} should ship");
        }
    }

    #[test]
    fn authoring_sources_do_not_ship() {
        for name in [
            "data/characters/yone/skins/skin0.bin.ritobin",
            "data/characters/yone/skins/skin9.py",
            "assets/sirdexal/mod/source.psd",
            "assets/sirdexal/mod/steve.png",
            "assets/sirdexal/mod/ref.jpg",
            "assets/sirdexal/mod/rig.ma",
            "assets/sirdexal/mod/rig.mb",
            "assets/sirdexal/mod/model.fbx",
            "assets/sirdexal/mod/model.blend",
            "assets/sirdexal/mod/backup.zip",
            "assets/sirdexal/mod/old.fantome",
            "notes.md",
        ] {
            assert!(!is_shippable(Path::new(name)), "{name} should not ship");
        }
    }

    /// `files.txt` is the hash→path record beside a mod; a fantome carries it as
    /// META/files.txt, so packing it as a WAD chunk too would put a loose text file in the
    /// game's WAD.
    #[test]
    fn bookkeeping_files_do_not_ship_but_other_text_does() {
        assert!(!is_shippable(Path::new("files.txt")));
        assert!(!is_shippable(Path::new("hashed_files.json")));
        assert!(!is_shippable(Path::new("Thumbs.db")));
        assert!(!is_shippable(Path::new(".gitignore")));

        assert!(is_shippable(Path::new("data/menu/fontconfig_en_us.txt")));
        assert!(is_shippable(Path::new("data/x.json")));
    }

    #[test]
    fn testcuberenderer_scratch_never_ships() {
        assert!(!is_shippable(Path::new(
            "assets/maps/testcuberenderer/x.tex"
        )));
        assert!(!is_shippable(Path::new("TestCubeRenderer/x.bin")));
    }

    #[test]
    fn the_walk_leaves_sources_out() {
        let root = std::env::temp_dir().join(format!("flint-ship-{}", std::process::id()));
        let wad = root.join("Yone.wad.client");
        std::fs::create_dir_all(wad.join("assets")).unwrap();
        std::fs::write(wad.join("assets/a.tex"), b"x").unwrap();
        std::fs::write(wad.join("assets/a.psd"), b"x").unwrap();
        std::fs::write(wad.join("files.txt"), b"x").unwrap();

        let files = wad_directory_files(&wad).unwrap();
        let mut names: Vec<&String> = files.keys().collect();
        names.sort();
        assert_eq!(names, vec!["assets/a.tex"]);

        let _ = std::fs::remove_dir_all(&root);
    }
}
