/*!
Audits an unpacked `.wad.client` folder against the asset paths its BINs reference.

Two questions, one walk: which referenced assets are absent from the folder ("missing" —
the mod will show a magenta texture or fail to load), and which present files nothing
references ("bloat" — dead weight shipped to every user).

Matching is by 64-bit WAD path hash rather than string equality, so a file extracted
under its unresolved `{16hex}.ext` name still matches a BIN that names its real path.
*/

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::checks::{
    check_animation_graph, check_bin_hazards, check_texture, CheckIssue, MigrationTally,
};
use crate::codec::{read_bin, tree_to_text_cached, MAX_BIN_SIZE};
use ritoshark::bin::{Bin, BinValue};

/// Folder segments whose contents are never reported as bloat. Champion icons are
/// referenced almost entirely through hash-valued BIN fields that CommunityDragon
/// often can't resolve, so they read as unreferenced and would dominate the report
/// while being exactly the files a skin must keep.
const BLOAT_EXEMPT_DIRS: &[&str] = &["icons2d"];

/// A file present on disk that nothing references.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BloatFile {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct AuditReport {
    /// Referenced `assets/`|`data/` paths with no matching file in the folder.
    pub missing: Vec<String>,
    /// Present files no BIN references, minus the exemptions.
    pub bloat: Vec<BloatFile>,
    pub files_scanned: usize,
    pub bins_scanned: usize,
    pub bins_failed: usize,
    /// Total bytes of `bloat` — what deleting them would save.
    pub bloat_bytes: u64,
    /// Crash-risk findings from [`crate::checks`], newest rule set first.
    pub issues: Vec<CheckIssue>,
}

/// `\` → `/`, no leading slash, lowercased — the form every comparison uses.
fn normalize_rel(path: &str) -> String {
    path.replace('\\', "/")
        .trim_start_matches('/')
        .to_ascii_lowercase()
}

/** The hash a path is matched by. A file whose stem is exactly 16 hex digits was
extracted from a chunk whose real path never resolved, so the stem IS its path hash;
anything else hashes normally. This is what lets a `{16hex}.dds` on disk satisfy a BIN
that references the resolved path. */
fn unified_hash(rel: &str) -> u64 {
    let stem = Path::new(rel)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    if stem.len() == 16 && stem.chars().all(|c| c.is_ascii_hexdigit()) {
        if let Ok(h) = u64::from_str_radix(&stem, 16) {
            return h;
        }
    }
    flint_hash::hash::wad_chunk_hash(rel)
}

/// Only game asset paths are worth tracking; BIN text is full of class and field names.
fn is_game_path(rel: &str) -> bool {
    rel.starts_with("assets/") || rel.starts_with("data/")
}

fn is_missing_exempt(rel: &str) -> bool {
    if rel.contains("/sounds/wwise2016/vo/") {
        return true;
    }

    let parts: Vec<&str> = rel.split('/').collect();
    parts.len() == 4
        && parts[0] == "data"
        && parts[1] == "characters"
        && parts[3]
            .strip_suffix(".bin")
            .is_some_and(|stem| stem == parts[2])
}

fn is_bloat_exempt(rel: &str) -> bool {
    rel.split('/').any(|seg| {
        BLOAT_EXEMPT_DIRS
            .iter()
            .any(|d| seg.eq_ignore_ascii_case(d))
    })
}

/** Records a mention, plus the `2x_`/`4x_` HD siblings League ships alongside a texture.
Those variants are loaded by the engine deriving the name, never by an explicit BIN
reference, so without this they'd every one read as bloat. */
fn add_mention(raw: &str, out: &mut HashSet<String>) {
    let rel = normalize_rel(raw);
    if !is_game_path(&rel) {
        return;
    }

    if rel.ends_with(".dds") || rel.ends_with(".tex") {
        if let Some(slash) = rel.rfind('/') {
            let (dir, file) = rel.split_at(slash + 1);
            for prefix in ["2x_", "4x_"] {
                out.insert(format!("{}{}{}", dir, prefix, file));
            }
        }
    }
    out.insert(rel);
}

/// Harvests string leaves. Hash/link/file values carry no text here — they come back
/// through the resolved-text pass instead.
fn collect_from_value(value: &BinValue, out: &mut HashSet<String>) {
    match value {
        BinValue::String(s) => add_mention(s, out),
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            for v in fields.values() {
                collect_from_value(v, out);
            }
        }
        BinValue::List { items, .. } => {
            for item in items {
                collect_from_value(item, out);
            }
        }
        BinValue::Map { entries, .. } => {
            for (k, v) in entries {
                collect_from_value(k, out);
                collect_from_value(v, out);
            }
        }
        BinValue::Option {
            value: Some(inner), ..
        } => collect_from_value(inner, out),
        _ => {}
    }
}

/// Every quoted run in ritobin text. The printer renders a resolved `hash`/`link`/`file`
/// value as a quoted name, so this recovers references that exist only as hashes in the
/// binary tree; unresolvable ones are simply invisible and can't be checked.
fn collect_from_text(text: &str, out: &mut HashSet<String>) {
    let mut rest = text;
    while let Some(open) = rest.find('"') {
        let after = &rest[open + 1..];
        match after.find('"') {
            Some(close) => {
                add_mention(&after[..close], out);
                rest = &after[close + 1..];
            }
            None => break,
        }
    }
}

fn collect_mentions(bin: &Bin, out: &mut HashSet<String>) {
    for dep in &bin.linked {
        add_mention(dep, out);
    }
    for entry in &bin.entries {
        for value in entry.fields.values() {
            collect_from_value(value, out);
        }
    }
    if let Ok(text) = tree_to_text_cached(bin) {
        collect_from_text(&text, out);
    }
}

/// Every regular file under `dir`, as normalized relative paths → absolute paths.
fn walk_files(dir: &Path) -> Vec<(String, PathBuf)> {
    walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .filter_map(|e| {
            let rel = e.path().strip_prefix(dir).ok()?;
            Some((
                normalize_rel(&rel.to_string_lossy()),
                e.path().to_path_buf(),
            ))
        })
        .collect()
}

/// Audits an unpacked `.wad.client` folder.
pub fn audit_wad_folder(dir: &Path) -> Result<AuditReport, String> {
    if !dir.is_dir() {
        return Err(format!("Not a folder: {}", dir.display()));
    }

    let files = walk_files(dir);
    let mut report = AuditReport {
        files_scanned: files.len(),
        ..Default::default()
    };

    // Several on-disk files can share a hash (a path and its {16hex} twin), so the
    // index maps one hash to every file that satisfies it.
    let mut by_hash: HashMap<u64, Vec<usize>> = HashMap::new();
    for (idx, (rel, _)) in files.iter().enumerate() {
        by_hash.entry(unified_hash(rel)).or_default().push(idx);
    }

    let mut mentions: HashSet<String> = HashSet::new();
    let mut bin_mentions: Vec<(String, HashSet<String>)> = Vec::new();
    let mut migration = MigrationTally::default();
    let bin_names = flint_hash::hash::bin_dict::get_cached_bin_hashes().read();
    for (rel, disk) in &files {
        if rel.ends_with(".tex") || rel.ends_with(".dds") {
            if let Ok(data) = std::fs::read(disk) {
                report.issues.extend(check_texture(rel, &data));
            }
            continue;
        }
        if !rel.ends_with(".bin") {
            continue;
        }
        let data = match std::fs::read(disk) {
            Ok(d) => d,
            Err(_) => {
                report.bins_failed += 1;
                continue;
            }
        };
        if data.len() < 4 || data.len() > MAX_BIN_SIZE {
            report.bins_failed += 1;
            continue;
        }
        match read_bin(&data) {
            Ok(bin) => {
                let mut own = HashSet::new();
                collect_mentions(&bin, &mut own);
                mentions.extend(own.iter().cloned());
                bin_mentions.push((rel.clone(), own));
                report.issues.extend(check_animation_graph(&bin, rel, &bin_names));
                report.issues.extend(check_bin_hazards(&bin, rel));
                migration.add_bin(&bin, rel);
                report.bins_scanned += 1;
            }
            Err(_) => report.bins_failed += 1,
        }
    }
    drop(bin_names);
    report.issues.extend(migration.into_issues());

    let mut referenced: HashSet<usize> = HashSet::new();
    let mut missing: BTreeSet<String> = BTreeSet::new();
    for mention in &mentions {
        match by_hash.get(&unified_hash(mention)) {
            Some(indices) => referenced.extend(indices.iter().copied()),
            None => {
                missing.insert(mention.clone());
            }
        }
    }

    // An HD twin is synthesised for every texture mention, so a mod that simply
    // doesn't ship one would drown the report. Only flag a 2x_/4x_ path as missing
    // when a sibling variant IS present — that's a genuinely incomplete set.
    let present_variants: HashSet<&String> = files
        .iter()
        .map(|(rel, _)| rel)
        .filter(|rel| {
            let base = rel.rsplit('/').next().unwrap_or(rel);
            base.starts_with("2x_") || base.starts_with("4x_")
        })
        .collect();
    let has_any_variant = !present_variants.is_empty();
    missing.retain(|m| {
        if is_missing_exempt(m) {
            return false;
        }
        let base = m.rsplit('/').next().unwrap_or(m);
        if base.starts_with("2x_") || base.starts_with("4x_") {
            return has_any_variant;
        }
        true
    });

    for (rel, own) in &bin_mentions {
        let mut absent: Vec<&str> = own
            .iter()
            .filter(|m| missing.contains(*m))
            .map(String::as_str)
            .collect();
        if absent.is_empty() {
            continue;
        }
        absent.sort_unstable();
        let shown = absent[..absent.len().min(3)].join(", ");
        let rest = absent.len().saturating_sub(3);
        report.issues.push(CheckIssue {
            severity: crate::checks::Severity::Warning,
            code: "bin.missing-ref",
            file: rel.clone(),
            message: format!(
                "References {} file{} the folder does not ship ({shown}{}). Unless the game itself provides them, they load magenta or not at all.",
                absent.len(),
                if absent.len() == 1 { "" } else { "s" },
                if rest > 0 {
                    format!(", and {rest} more")
                } else {
                    String::new()
                },
            ),
        });
    }
    report.issues.sort_by(|a, b| {
        a.severity
            .cmp(&b.severity)
            .then_with(|| a.file.cmp(&b.file))
            .then_with(|| a.code.cmp(b.code))
    });

    let mut bloat: Vec<BloatFile> = Vec::new();
    for (idx, (rel, disk)) in files.iter().enumerate() {
        if referenced.contains(&idx) {
            continue;
        }
        // A BIN is a source, not an asset: nothing references the skin BIN itself.
        if rel.ends_with(".bin") || rel.ends_with(".ritobin") {
            continue;
        }
        if rel == "hashed_files.json" || is_bloat_exempt(rel) {
            continue;
        }
        let size = std::fs::metadata(disk).map(|m| m.len()).unwrap_or(0);
        report.bloat_bytes += size;
        bloat.push(BloatFile {
            path: rel.clone(),
            size,
        });
    }
    bloat.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));

    report.missing = missing.into_iter().collect();
    report.bloat = bloat;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_separators_and_case() {
        assert_eq!(normalize_rel("\\Assets\\Foo.TEX"), "assets/foo.tex");
    }

    #[test]
    fn hash_named_files_hash_to_their_own_stem() {
        assert_eq!(unified_hash("0123456789abcdef.dds"), 0x0123456789abcdef);
        // Nested too — an extractor can place an unresolved chunk anywhere.
        assert_eq!(
            unified_hash("assets/0123456789abcdef.dds"),
            0x0123456789abcdef
        );
    }

    #[test]
    fn ordinary_paths_use_the_wad_chunk_hash() {
        assert_eq!(
            unified_hash("assets/characters/foo.tex"),
            flint_hash::hash::wad_chunk_hash("assets/characters/foo.tex")
        );
    }

    #[test]
    fn only_game_paths_are_mentioned() {
        let mut out = HashSet::new();
        add_mention("assets/foo.tex", &mut out);
        add_mention("data/bar.bin", &mut out);
        add_mention("VfxSystemDefinitionData", &mut out);
        add_mention("", &mut out);
        assert!(out.contains("assets/foo.tex"));
        assert!(out.contains("data/bar.bin"));
        assert!(!out.contains("vfxsystemdefinitiondata"));
    }

    #[test]
    fn textures_pull_in_their_hd_twins() {
        let mut out = HashSet::new();
        add_mention("ASSETS/Characters/Foo/skin.dds", &mut out);
        assert!(out.contains("assets/characters/foo/skin.dds"));
        assert!(out.contains("assets/characters/foo/2x_skin.dds"));
        assert!(out.contains("assets/characters/foo/4x_skin.dds"));
    }

    #[test]
    fn non_textures_get_no_twins() {
        let mut out = HashSet::new();
        add_mention("assets/characters/foo/anim.anm", &mut out);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn missing_check_ignores_voiceover_files() {
        assert!(is_missing_exempt(
            "assets/sounds/wwise2016/vo/en_us/characters/ahri/ahri_vo_audio.wpk"
        ));
        assert!(!is_missing_exempt(
            "assets/sounds/wwise2016/sfx/characters/ahri/ahri_sfx_audio.bnk"
        ));
    }

    #[test]
    fn missing_check_ignores_the_base_champion_bin() {
        assert!(is_missing_exempt("data/characters/ahri/ahri.bin"));
        assert!(is_missing_exempt("data/characters/jade_ahri/jade_ahri.bin"));
        assert!(!is_missing_exempt("data/characters/ahri/skins/skin0.bin"));
        assert!(!is_missing_exempt("data/characters/ahri/animations.bin"));
    }

    #[test]
    fn icons2d_is_exempt_from_bloat() {
        assert!(is_bloat_exempt(
            "assets/characters/foo/hud/icons2d/passive.dds"
        ));
        assert!(is_bloat_exempt("assets/ICONS2D/x.dds"));
        assert!(!is_bloat_exempt(
            "assets/characters/foo/skins/base/body.tex"
        ));
        // Only a whole segment counts, not a substring.
        assert!(!is_bloat_exempt("assets/icons2different/x.dds"));
    }

    #[test]
    fn quoted_runs_are_pulled_out_of_ritobin_text() {
        let text = r#"
            mAnimationFilePath: string = "ASSETS/Characters/Foo/anim.anm"
            mTexture: hash = "assets/characters/foo/tex.tex"
            mUnresolved: hash = 0xdeadbeef
        "#;
        let mut out = HashSet::new();
        collect_from_text(text, &mut out);
        assert!(out.contains("assets/characters/foo/anim.anm"));
        assert!(out.contains("assets/characters/foo/tex.tex"));
        // The unresolved `0xdeadbeef` is unquoted, so it contributes nothing —
        // the only extra entries are the texture's synthesised HD twins.
        assert!(out.contains("assets/characters/foo/2x_tex.tex"));
        assert!(out.contains("assets/characters/foo/4x_tex.tex"));
        assert_eq!(out.len(), 4);
    }

    #[test]
    fn empty_folder_audits_clean() {
        let dir = std::env::temp_dir().join(format!("flint-audit-empty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let report = audit_wad_folder(&dir).unwrap();
        assert_eq!(report.files_scanned, 0);
        assert!(report.missing.is_empty());
        assert!(report.bloat.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_no_bin_references_is_bloat_and_a_bin_is_never_bloat() {
        let dir = std::env::temp_dir().join(format!("flint-audit-bloat-{}", std::process::id()));
        let assets = dir.join("assets").join("characters").join("foo");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(assets.join("orphan.tex"), b"xxxx").unwrap();
        std::fs::create_dir_all(assets.join("hud").join("icons2d")).unwrap();
        std::fs::write(assets.join("hud").join("icons2d").join("p.dds"), b"yy").unwrap();
        std::fs::write(dir.join("data.bin"), b"PROPxx").unwrap();

        let report = audit_wad_folder(&dir).unwrap();
        let bloat: Vec<&str> = report.bloat.iter().map(|b| b.path.as_str()).collect();
        assert!(bloat.contains(&"assets/characters/foo/orphan.tex"));
        assert!(!bloat.iter().any(|p| p.contains("icons2d")));
        assert!(!bloat.iter().any(|p| p.ends_with(".bin")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_reference_is_pinned_on_the_bin_that_makes_it() {
        use ritoshark::bin::{BinEntry, BinValue};

        let dir = std::env::temp_dir().join(format!("flint-audit-refs-{}", std::process::id()));
        let data_dir = dir.join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        let mut fields = indexmap::IndexMap::new();
        fields.insert(
            ritoshark::hash::fnv1a("someField"),
            BinValue::String("assets/characters/foo/gone.skn".into()),
        );
        let bin = Bin {
            entries: vec![BinEntry {
                path_hash: 1,
                class_hash: 2,
                fields,
            }],
            ..Bin::new()
        };
        std::fs::write(data_dir.join("skin0.bin"), crate::codec::write_bin(&bin).unwrap()).unwrap();

        let report = audit_wad_folder(&dir).unwrap();
        assert!(report.missing.contains(&"assets/characters/foo/gone.skn".to_string()));
        let issue = report
            .issues
            .iter()
            .find(|i| i.code == "bin.missing-ref")
            .expect("a missing-ref issue");
        assert_eq!(issue.file, "data/skin0.bin");
        assert!(issue.message.contains("gone.skn"), "{}", issue.message);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_a_file_path() {
        let f = std::env::temp_dir().join(format!("flint-audit-file-{}.txt", std::process::id()));
        std::fs::write(&f, b"x").unwrap();
        assert!(audit_wad_folder(&f).is_err());
        let _ = std::fs::remove_file(&f);
    }
}
