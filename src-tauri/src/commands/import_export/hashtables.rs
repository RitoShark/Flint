/*!
Embedded Hashtables — the LeagueToolkit standard for a mod package that carries the
names of its own files (wiki: reference/mod-packages/hashtables).

A `.fantome` declares a `Hashtables` array in `META/info.json` and stores name-only
table files (one name per line, printable ASCII, LF, forward slashes) under
`META/hashes/{category}.hashes.txt`. A mod project declares the same entries as a
`hashtables` array in `mod.config.json` with files under `hashes/` at the project
root. Categories: `game` (xxh64/64 — WAD chunk paths and `file` values),
`binentries` and `binhashes` (fnv1a_32/32). Unknown categories or algorithms are
never merged, only preserved verbatim — unknown is not the same as disposable.
*/

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufReader, Read};
use std::path::Path;

use flint_core::project::Project;
use ritoshark::hash::fnv1a;

const CATEGORY_SPECS: &[(&str, &str, u64)] = &[
    ("game", "xxh64", 64),
    ("binentries", "fnv1a_32", 32),
    ("binhashes", "fnv1a_32", 32),
];

fn spec(category: &str) -> Option<(&'static str, u64)> {
    CATEGORY_SPECS
        .iter()
        .find(|(c, _, _)| *c == category)
        .map(|(_, alg, bits)| (*alg, *bits))
}

fn is_valid_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('\\') && name.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

fn valid_lines(contents: &str) -> impl Iterator<Item = &str> {
    contents.lines().map(str::trim).filter(|l| is_valid_name(l))
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit())
}

// ─── Export side ─────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct ProjectTables {
    pub game: BTreeSet<String>,
    pub binentries: BTreeSet<String>,
    pub binhashes: BTreeSet<String>,
    /// Declared tables this build cannot merge (unknown category or algorithm),
    /// carried verbatim: (fantome manifest entry, file contents).
    pub passthrough: Vec<(serde_json::Value, String)>,
}

/// Everything the project knows about its invented names, categorized: the
/// project's own declared `hashes/` tables, every WAD folder's `files.txt`
/// (16-hex = game path, 8-hex = bin object name), and every bin's `ritobinmap`
/// record (which keeps the bin categories separate).
pub fn collect_project_tables(project_path: &Path) -> ProjectTables {
    let mut out = ProjectTables::default();

    if let Ok(text) = std::fs::read_to_string(project_path.join("mod.config.json")) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            let entries = value.get("hashtables").and_then(|h| h.as_array());
            for entry in entries.into_iter().flatten() {
                let Some(rel) = entry.get("path").and_then(|p| p.as_str()) else {
                    continue;
                };
                let Ok(contents) = std::fs::read_to_string(project_path.join(rel)) else {
                    continue;
                };
                let category = entry.get("category").and_then(|c| c.as_str()).unwrap_or_default();
                let algorithm = entry.get("algorithm").and_then(|a| a.as_str()).unwrap_or_default();
                let mergeable = spec(category).is_some_and(|(alg, _)| alg == algorithm);
                if mergeable {
                    let set = match category {
                        "game" => &mut out.game,
                        "binentries" => &mut out.binentries,
                        _ => &mut out.binhashes,
                    };
                    set.extend(valid_lines(&contents).map(str::to_string));
                } else {
                    let file_name = Path::new(rel)
                        .file_name()
                        .and_then(|f| f.to_str())
                        .unwrap_or("table.hashes.txt");
                    out.passthrough.push((
                        serde_json::json!({
                            "Path": format!("META/hashes/{file_name}"),
                            "Category": category,
                            "Algorithm": algorithm,
                            "Bits": entry.get("bits").cloned().unwrap_or(serde_json::json!(64)),
                        }),
                        contents,
                    ));
                }
            }
        }
    }

    let Ok(folders) = flint_core::export::project_wad_folders(project_path) else {
        return out;
    };
    for wad_dir in folders {
        if let Ok(text) = std::fs::read_to_string(wad_dir.join("files.txt")) {
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match line.split_once(char::is_whitespace) {
                    Some((hex, name)) if is_hex(hex, 16) => {
                        let name = name.trim();
                        if is_valid_name(name) {
                            out.game.insert(name.to_string());
                        }
                    }
                    Some((hex, name)) if is_hex(hex, 8) => {
                        let name = name.trim();
                        if is_valid_name(name) {
                            out.binentries.insert(name.to_string());
                        }
                    }
                    _ => {
                        if is_valid_name(line) {
                            out.game.insert(line.to_string());
                        }
                    }
                }
            }
        }

        let mut stack = vec![wad_dir];
        while let Some(dir) = stack.pop() {
            let Ok(read) = std::fs::read_dir(&dir) else { continue };
            for entry in read.flatten() {
                let path = entry.path();
                match entry.file_type() {
                    Ok(t) if t.is_dir() => stack.push(path),
                    Ok(t) if t.is_file() => {
                        if path.extension().is_none_or(|e| !e.eq_ignore_ascii_case("bin")) {
                            continue;
                        }
                        let Ok(bytes) = std::fs::read(&path) else { continue };
                        let Ok(bin) = flint_core::bin::read_bin(&bytes) else { continue };
                        let map = flint_core::bin::read_path_map(&bin);
                        out.game.extend(map.game.iter().filter(|n| is_valid_name(n)).cloned());
                        out.binentries
                            .extend(map.bin_entries.iter().filter(|n| is_valid_name(n)).cloned());
                        out.binhashes
                            .extend(map.bin_hashes.iter().filter(|n| is_valid_name(n)).cloned());
                    }
                    _ => {}
                }
            }
        }
    }

    out
}

pub struct FantomeTable {
    pub zip_path: String,
    pub contents: String,
    pub manifest: serde_json::Value,
}

/// The table files a fantome export ships, plus their `Hashtables` manifest
/// entries. Names deduped by their canonical (ASCII-lowercased) form, first
/// spelling kept; BTreeSet order is already the byte-lexicographic sort the
/// standard recommends.
pub fn fantome_tables(tables: &ProjectTables) -> Vec<FantomeTable> {
    let mut out = Vec::new();
    let categories: [(&str, &BTreeSet<String>); 3] = [
        ("game", &tables.game),
        ("binentries", &tables.binentries),
        ("binhashes", &tables.binhashes),
    ];
    for (category, names) in categories {
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut lines: Vec<&str> = Vec::new();
        for name in names {
            if seen.insert(name.to_ascii_lowercase()) {
                lines.push(name);
            }
        }
        if lines.is_empty() {
            continue;
        }
        let (algorithm, bits) = spec(category).unwrap();
        let zip_path = format!("META/hashes/{category}.hashes.txt");
        out.push(FantomeTable {
            manifest: serde_json::json!({
                "Path": zip_path,
                "Category": category,
                "Algorithm": algorithm,
                "Bits": bits,
            }),
            contents: lines.join("\n") + "\n",
            zip_path,
        });
    }
    for (manifest, contents) in &tables.passthrough {
        let Some(zip_path) = manifest.get("Path").and_then(|p| p.as_str()) else {
            continue;
        };
        if out.iter().any(|t| t.zip_path == zip_path) {
            continue;
        }
        out.push(FantomeTable {
            zip_path: zip_path.to_string(),
            contents: contents.clone(),
            manifest: manifest.clone(),
        });
    }
    out
}

// ─── Import side ─────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct ImportedHashtables {
    pub game: BTreeSet<String>,
    pub bin: BTreeSet<String>,
    /// Every declared table, known and unknown, in project-manifest form:
    /// (entry whose `path` is `hashes/<file>`, file contents).
    pub tables: Vec<(serde_json::Value, String)>,
}

fn read_zip_entry(
    zip: &mut zip::ZipArchive<BufReader<std::fs::File>>,
    wanted: &str,
) -> Option<String> {
    let index = (0..zip.len()).find(|i| {
        zip.name_for_index(*i)
            .is_some_and(|n| n.eq_ignore_ascii_case(wanted))
    })?;
    let mut entry = zip.by_index(index).ok()?;
    let mut contents = String::new();
    entry.read_to_string(&mut contents).ok()?;
    Some(contents)
}

/// Reads the standard's tables out of a `.fantome`, plus Flint's own
/// `META/files.txt` record. Never fails — a package without tables is normal.
pub fn read_fantome_hashtables(fantome_path: &str) -> ImportedHashtables {
    let mut out = ImportedHashtables::default();
    let Ok(file) = std::fs::File::open(fantome_path) else { return out };
    let Ok(mut zip) = zip::ZipArchive::new(BufReader::new(file)) else { return out };

    let manifest: Vec<serde_json::Value> = read_zip_entry(&mut zip, "META/info.json")
        .and_then(|info| serde_json::from_str::<serde_json::Value>(&info).ok())
        .and_then(|v| v.get("Hashtables").and_then(|h| h.as_array()).cloned())
        .unwrap_or_default();

    let mut used_names: BTreeSet<String> = BTreeSet::new();
    for entry in manifest {
        let Some(path) = entry.get("Path").and_then(|p| p.as_str()) else { continue };
        let Some(contents) = read_zip_entry(&mut zip, path) else { continue };
        let category = entry.get("Category").and_then(|c| c.as_str()).unwrap_or_default();
        let algorithm = entry.get("Algorithm").and_then(|a| a.as_str()).unwrap_or_default();

        if spec(category).is_some_and(|(alg, _)| alg == algorithm) {
            let set = if category == "game" { &mut out.game } else { &mut out.bin };
            set.extend(valid_lines(&contents).map(str::to_string));
        }

        let base = Path::new(path)
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or("table.hashes.txt");
        let mut file_name = base.to_string();
        let mut counter = 1;
        while !used_names.insert(file_name.clone()) {
            file_name = format!("{counter}.{base}");
            counter += 1;
        }
        out.tables.push((
            serde_json::json!({
                "path": format!("hashes/{file_name}"),
                "category": category,
                "algorithm": algorithm,
                "bits": entry.get("Bits").cloned().unwrap_or(serde_json::json!(64)),
            }),
            contents,
        ));
    }

    if let Some(text) = read_zip_entry(&mut zip, "META/files.txt") {
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match line.split_once(char::is_whitespace) {
                Some((hex, name)) if is_hex(hex, 16) => {
                    let name = name.trim();
                    if is_valid_name(name) {
                        out.game.insert(name.to_string());
                    }
                }
                Some((hex, name)) if is_hex(hex, 8) => {
                    let name = name.trim();
                    if is_valid_name(name) {
                        out.bin.insert(name.to_string());
                    }
                }
                _ => {
                    if is_valid_name(line) {
                        out.game.insert(line.to_string());
                    }
                }
            }
        }
    }

    out
}

/// Feeds the imported names into the global and custom dictionaries. The custom
/// LMDB write is what marks them machine-invented, so a later bin save re-captures
/// them into the `ritobinmap` record and they keep travelling.
pub fn register_names(hash_dir: &Path, imported: &ImportedHashtables) {
    let game: BTreeMap<u64, String> = imported
        .game
        .iter()
        .map(|n| (flint_core::hash::wad_chunk_hash(n), n.clone()))
        .collect();
    let bin: BTreeMap<u32, String> = imported.bin.iter().map(|n| (fnv1a(n), n.clone())).collect();
    if game.is_empty() && bin.is_empty() {
        return;
    }
    tracing::info!(
        "Registering {} game + {} bin name(s) from embedded hashtables",
        game.len(),
        bin.len()
    );
    if let Err(e) =
        crate::commands::wad::extract_hashes::extract_and_merge_hashes(hash_dir, game.clone(), bin.clone())
    {
        tracing::warn!("Failed to merge embedded hashtable names: {e}");
    }
    if let Err(e) = flint_core::hash::bin_dict::save_custom_file_hashes(&game) {
        tracing::warn!("Failed to save custom file hashes: {e}");
    }
    if let Err(e) = flint_core::hash::bin_dict::save_custom_bin_hashes(&bin) {
        tracing::warn!("Failed to save custom bin hashes: {e}");
    }
}

/// Recovers the declared tables into the project's `hashes/` folder and its
/// `hashtables` manifest, so a re-export ships them onward.
pub fn recover_into_project(project_path: &Path, project: &mut Project, imported: &ImportedHashtables) {
    if imported.tables.is_empty() {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(project_path.join("hashes")) {
        tracing::warn!("Failed to create hashes/: {e}");
        return;
    }
    let mut manifest = Vec::new();
    for (entry, contents) in &imported.tables {
        let Some(rel) = entry.get("path").and_then(|p| p.as_str()) else { continue };
        if std::fs::write(project_path.join(rel), contents).is_ok() {
            manifest.push(entry.clone());
        }
    }
    if !manifest.is_empty() {
        tracing::info!("Recovered {} hashtable(s) into hashes/", manifest.len());
        project
            .extra
            .insert("hashtables".to_string(), serde_json::Value::Array(manifest));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_validated_against_the_grammar() {
        assert!(is_valid_name("assets/characters/aurora/skins/skin42/trail.tex"));
        assert!(!is_valid_name(""));
        assert!(!is_valid_name("assets\\characters\\x.tex"));
        assert!(!is_valid_name("assets/ürsül.tex"));
    }

    #[test]
    fn fantome_tables_dedupe_canonical_names_and_declare_specs() {
        let mut tables = ProjectTables::default();
        tables.game.insert("Assets/X.tex".to_string());
        tables.game.insert("assets/x.tex".to_string());
        tables.binentries.insert("Characters/Foo/Skins/Skin99".to_string());

        let out = fantome_tables(&tables);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].zip_path, "META/hashes/game.hashes.txt");
        assert_eq!(out[0].manifest["Algorithm"], "xxh64");
        assert_eq!(out[0].manifest["Bits"], 64);
        assert_eq!(out[0].contents.lines().count(), 1);
        assert!(out[0].contents.ends_with('\n'));
        assert_eq!(out[1].zip_path, "META/hashes/binentries.hashes.txt");
        assert_eq!(out[1].manifest["Algorithm"], "fnv1a_32");
        assert_eq!(out[1].manifest["Bits"], 32);
    }

    #[test]
    fn unknown_categories_pass_through_verbatim() {
        let mut tables = ProjectTables::default();
        tables.passthrough.push((
            serde_json::json!({
                "Path": "META/hashes/future.hashes.txt",
                "Category": "future",
                "Algorithm": "xxh3_128",
                "Bits": 128,
            }),
            "some/name\n".to_string(),
        ));
        let out = fantome_tables(&tables);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].manifest["Category"], "future");
        assert_eq!(out[0].contents, "some/name\n");
    }
}
