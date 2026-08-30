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
    check_animation_assets, check_animation_graph, check_bin_hazards, check_texture, CheckIssue,
    MigrationTally,
};
use crate::codec::{read_bin, MAX_BIN_SIZE};
use flint_hash::hash::HashMapper;
use rayon::prelude::*;
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

/// Records about the folder rather than content shipped in it. Nothing references
/// them by design — `files.txt` is the name table the whole ecosystem reads back.
fn is_folder_metadata(rel: &str) -> bool {
    matches!(
        rel,
        "files.txt" | "hashed_files.json" | "hashes.txt" | ".gitkeep"
    )
}

fn is_bloat_exempt(rel: &str) -> bool {
    rel.split('/').any(|seg| {
        BLOAT_EXEMPT_DIRS
            .iter()
            .any(|d| seg.eq_ignore_ascii_case(d))
    })
}

/// Records a referenced path, if it is one worth tracking.
fn add_mention(raw: &str, out: &mut HashSet<String>) {
    let rel = normalize_rel(raw);
    if is_game_path(&rel) {
        out.insert(rel);
    }
}

/** The `2x_`/`4x_` HD siblings League ships alongside a texture.

The engine derives those names rather than referencing them, so a shipped one would read as
bloat without this. **They are NOT missing-check material**: nothing referenced them, so
reporting the ones a mod does not ship invents a reference the author never made — on a
skin bin that is hundreds of phantom rows burying the real findings. */
fn add_derived_variants(mentions: &HashSet<String>, out: &mut HashSet<String>) {
    for rel in mentions {
        if !rel.ends_with(".dds") && !rel.ends_with(".tex") {
            continue;
        }
        let Some(slash) = rel.rfind('/') else { continue };
        let (dir, file) = rel.split_at(slash + 1);
        for prefix in ["2x_", "4x_"] {
            out.insert(format!("{dir}{prefix}{file}"));
        }
    }
}

/// What one BIN references: paths it names outright, and `file` values, which are an
/// xxh64 and nothing else until something can name them.
#[derive(Debug, Clone, Default)]
struct Mentions {
    paths: HashSet<String>,
    /// `file` hashes no record could name. Still checkable — the hash IS the path hash
    /// the folder index is keyed by.
    unnamed_files: HashSet<u64>,
    /// HD twins derived from the paths above. They keep a shipped `2x_`/`4x_` file out of
    /// the bloat report and are never reported as missing.
    derived: HashSet<String>,
}

/// Harvests string leaves and `file` references. Hash/link values carry no text here —
/// they come back through the resolved-text pass instead.
fn collect_from_value(value: &BinValue, out: &mut Mentions) {
    match value {
        BinValue::String(s) => add_mention(s, &mut out.paths),
        BinValue::File(hash) if *hash != 0 => {
            out.unnamed_files.insert(*hash);
        }
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

fn collect_mentions(bin: &Bin, names: &HashMapper, text: Option<&str>, out: &mut Mentions) {
    for dep in &bin.linked {
        add_mention(dep, &mut out.paths);
    }
    for entry in &bin.entries {
        for value in entry.fields.values() {
            collect_from_value(value, out);
        }
    }
    if let Some(text) = text {
        collect_from_text(text, &mut out.paths);
    }
    name_file_mentions(bin, names, out);
    add_derived_variants(&out.paths, &mut out.derived);
}

/// Everything one BIN contributes to a folder audit. `present` is the folder's file
/// index — a check that asks "does the mod ship this?" needs it.
fn scan_bin(
    bin: &Bin,
    rel: &str,
    names: &HashMapper,
    present: &HashSet<u64>,
) -> (Vec<CheckIssue>, Mentions, MigrationTally) {
    // LANDMINE: render through the guard the caller already holds. `tree_to_text_cached`
    // takes the hash-mapper read lock itself, and a second read while one is held
    // deadlocks the moment another thread queues a write — parking_lot's RwLock is not
    // reentrant, and the audit fans this out across rayon.
    let text = crate::codec::tree_to_text_with_hashes(bin, names).ok();
    let mut mentions = Mentions::default();
    collect_mentions(bin, names, text.as_deref(), &mut mentions);

    let mut issues = check_animation_graph(bin, rel, names);
    issues.extend(check_animation_assets(bin, rel, names, present));
    issues.extend(check_bin_hazards(bin, rel, text.as_deref()));

    let mut tally = MigrationTally::default();
    tally.add_bin(bin, rel, text.as_deref());

    (issues, mentions, tally)
}

/** Give every `file` hash a path if anything can.
Any side table the bin carries comes first: a repathed asset's path was invented by a
tool and is in no global dictionary. The printer never sees that record — it resolves
against the global table only — which is why these references were invisible to the audit
before, and they are exactly the mod's OWN assets. Whatever stays unnamed is still
checked, just by hash. */
fn name_file_mentions(bin: &Bin, names: &HashMapper, out: &mut Mentions) {
    let own = ritoshark::bin::read_trailer(&bin.trailing).files;
    let hashes = std::mem::take(&mut out.unnamed_files);
    for hash in hashes {
        match own
            .get(&hash)
            .map(String::as_str)
            .or_else(|| names.get(hash))
        {
            Some(name) => add_mention(name, &mut out.paths),
            None => {
                out.unnamed_files.insert(hash);
            }
        }
    }
}

/// The animation checks that already name a `.anm` — NOT `animation.dangling-clip`, which
/// is about a clip name with no entry in the map and says nothing about a file.
fn names_a_clip_file(code: &str) -> bool {
    matches!(code, "animation.missing-clip-file" | "animation.clip-from-game")
}

fn missing_ref_issue(rel: &str, absent: &[String]) -> CheckIssue {
    let shown = absent[..absent.len().min(3)].join(", ");
    let rest = absent.len().saturating_sub(3);
    CheckIssue {
        severity: crate::checks::Severity::Warning,
        code: "bin.missing-ref",
        file: rel.to_string(),
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
        line: None,
        expected: None,
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

/**
Re-checks ONE file in a WAD folder, for after the user edits it.

The full folder audit is the source of truth; this answers the narrower question "is this
file still a problem?" so a fix clears its tag immediately instead of at the next sweep.
Bloat is deliberately not reported — whether a file is referenced is a property of the
folder, not of the file, and answering it needs every other BIN parsed.
*/
pub fn check_one_file(dir: &Path, rel: &str) -> Result<Vec<CheckIssue>, String> {
    let rel = normalize_rel(rel);
    let disk = dir.join(&rel);
    if !disk.is_file() {
        return Ok(Vec::new());
    }

    if rel.ends_with(".tex") || rel.ends_with(".dds") {
        let data = std::fs::read(&disk).map_err(|e| format!("read {}: {e}", disk.display()))?;
        return Ok(check_texture(&rel, &data));
    }
    if !rel.ends_with(".bin") {
        return Ok(Vec::new());
    }

    let data = std::fs::read(&disk).map_err(|e| format!("read {}: {e}", disk.display()))?;
    if data.len() < 4 || data.len() > MAX_BIN_SIZE {
        return Ok(Vec::new());
    }
    let Ok(bin) = read_bin(&data) else {
        return Ok(Vec::new());
    };

    let present: HashSet<u64> = walk_files(dir)
        .iter()
        .map(|(rel, _)| unified_hash(rel))
        .collect();

    let bin_names = flint_hash::hash::bin_dict::get_cached_bin_hashes().read();
    let (mut issues, mentions, tally) = scan_bin(&bin, &rel, &bin_names, &present);
    drop(bin_names);
    issues.extend(tally.into_issues());

    let clips_reported = issues.iter().any(|i| names_a_clip_file(i.code));
    let mut absent: Vec<String> = mentions
        .paths
        .iter()
        .filter(|m| !present.contains(&unified_hash(m)) && !is_missing_exempt(m))
        .filter(|m| !(clips_reported && m.ends_with(".anm")))
        .cloned()
        .collect();
    absent.extend(
        mentions
            .unnamed_files
            .iter()
            .filter(|h| !present.contains(*h))
            .map(|h| format!("0x{h:016x}")),
    );
    if !absent.is_empty() {
        absent.sort_unstable();
        issues.push(missing_ref_issue(&rel, &absent));
    }

    issues.sort_by(|a, b| {
        a.severity
            .cmp(&b.severity)
            .then_with(|| a.code.cmp(b.code))
    });
    Ok(issues)
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
    let present: HashSet<u64> = by_hash.keys().copied().collect();

    enum FileScan {
        Skip,
        Texture(Vec<CheckIssue>),
        BinOk {
            issues: Vec<CheckIssue>,
            mentions: Mentions,
            tally: MigrationTally,
        },
        BinFailed,
    }

    let bin_names = flint_hash::hash::bin_dict::get_cached_bin_hashes().read();
    let names_ref = &*bin_names;
    let scans: Vec<(usize, FileScan)> = files
        .par_iter()
        .enumerate()
        .map(|(idx, (rel, disk))| {
            let scan = if rel.ends_with(".tex") || rel.ends_with(".dds") {
                match std::fs::read(disk) {
                    Ok(data) => FileScan::Texture(check_texture(rel, &data)),
                    Err(_) => FileScan::Skip,
                }
            } else if !rel.ends_with(".bin") {
                FileScan::Skip
            } else {
                match std::fs::read(disk) {
                    Ok(data) if data.len() >= 4 && data.len() <= MAX_BIN_SIZE => {
                        match read_bin(&data) {
                            Ok(bin) => {
                                let (issues, mentions, tally) =
                                    scan_bin(&bin, rel, names_ref, &present);
                                FileScan::BinOk { issues, mentions, tally }
                            }
                            Err(_) => FileScan::BinFailed,
                        }
                    }
                    _ => FileScan::BinFailed,
                }
            };
            (idx, scan)
        })
        .collect();
    drop(bin_names);

    let mut mentions: HashSet<String> = HashSet::new();
    let mut derived: HashSet<String> = HashSet::new();
    let mut unnamed_files: HashSet<u64> = HashSet::new();
    let mut bin_mentions: Vec<(String, Mentions)> = Vec::new();
    let mut migration = MigrationTally::default();
    for (idx, scan) in scans {
        match scan {
            FileScan::Skip => {}
            FileScan::Texture(issues) => report.issues.extend(issues),
            FileScan::BinFailed => report.bins_failed += 1,
            FileScan::BinOk {
                issues,
                mentions: own,
                tally,
            } => {
                mentions.extend(own.paths.iter().cloned());
                derived.extend(own.derived.iter().cloned());
                unnamed_files.extend(own.unnamed_files.iter().copied());
                bin_mentions.push((files[idx].0.clone(), own));
                report.issues.extend(issues);
                migration.merge(tally);
                report.bins_scanned += 1;
            }
        }
    }
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

    // A `file` value nothing could name is still a reference: its hash is the same
    // xxh64 the folder index is keyed by, so it either lands on a file or it dangles.
    let mut missing_hashes: BTreeSet<u64> = BTreeSet::new();
    for hash in &unnamed_files {
        match by_hash.get(hash) {
            Some(indices) => referenced.extend(indices.iter().copied()),
            None => {
                missing_hashes.insert(*hash);
            }
        }
    }

    // A derived twin only ever marks a shipped file as referenced; one that is absent was
    // never referenced by anything, so it is not missing.
    for twin in &derived {
        if let Some(indices) = by_hash.get(&unified_hash(twin)) {
            referenced.extend(indices.iter().copied());
        }
    }

    missing.retain(|m| !is_missing_exempt(m));

    for (rel, own) in &bin_mentions {
        // The animation check names the clip as well as the file, so letting the generic
        // list repeat those paths just says the same thing twice about one bin.
        let clips_reported = report
            .issues
            .iter()
            .any(|i| names_a_clip_file(i.code) && i.file == *rel);
        let mut absent: Vec<String> = own
            .paths
            .iter()
            .filter(|m| missing.contains(*m))
            .filter(|m| !(clips_reported && m.ends_with(".anm")))
            .cloned()
            .collect();
        absent.extend(
            own.unnamed_files
                .iter()
                .filter(|h| missing_hashes.contains(*h))
                .map(|h| format!("0x{h:016x}")),
        );
        if absent.is_empty() {
            continue;
        }
        absent.sort_unstable();
        report.issues.push(missing_ref_issue(rel, &absent));
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
        if is_folder_metadata(rel) || is_bloat_exempt(rel) {
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

    report.missing = missing
        .into_iter()
        .chain(missing_hashes.iter().map(|h| format!("0x{h:016x}")))
        .collect();
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
    fn textures_derive_their_hd_twins_separately() {
        let mut mentions = HashSet::new();
        add_mention("ASSETS/Characters/Foo/skin.dds", &mut mentions);
        assert_eq!(mentions.len(), 1, "a twin is not a mention");

        let mut derived = HashSet::new();
        add_derived_variants(&mentions, &mut derived);
        assert!(derived.contains("assets/characters/foo/2x_skin.dds"));
        assert!(derived.contains("assets/characters/foo/4x_skin.dds"));
    }

    #[test]
    fn non_textures_get_no_twins() {
        let mut mentions = HashSet::new();
        add_mention("assets/characters/foo/anim.anm", &mut mentions);
        let mut derived = HashSet::new();
        add_derived_variants(&mentions, &mut derived);
        assert!(derived.is_empty());
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
        // The unresolved `0xdeadbeef` is unquoted, so it contributes nothing.
        assert_eq!(out.len(), 2);
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
    fn folder_records_are_never_bloat() {
        let dir = std::env::temp_dir().join(format!("flint-audit-meta-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("files.txt"), b"assets/foo.tex\n").unwrap();
        std::fs::write(dir.join("hashed_files.json"), b"{}").unwrap();

        let report = audit_wad_folder(&dir).unwrap();
        assert!(report.bloat.is_empty(), "{:?}", report.bloat);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_reference_counts_even_when_nothing_can_name_it() {
        use ritoshark::bin::{BinEntry, BinValue};

        let dir = std::env::temp_dir().join(format!("flint-audit-file-{}", std::process::id()));
        let assets = dir.join("assets").join("modders").join("flint7d9f");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(assets.join("invented_7d9f.tex"), b"xxxx").unwrap();
        std::fs::create_dir_all(dir.join("data")).unwrap();

        let shipped = "assets/modders/flint7d9f/invented_7d9f.tex";
        let gone = "assets/modders/flint7d9f/deleted_7d9f.tex";
        let mut fields = indexmap::IndexMap::new();
        fields.insert(
            ritoshark::hash::fnv1a("texturePath"),
            BinValue::File(ritoshark::hash::xxh64(shipped)),
        );
        fields.insert(
            ritoshark::hash::fnv1a("otherTexture"),
            BinValue::File(ritoshark::hash::xxh64(gone)),
        );
        let bin = Bin {
            entries: vec![BinEntry {
                path_hash: 1,
                class_hash: 2,
                fields,
            }],
            ..Bin::new()
        };
        std::fs::write(
            dir.join("data").join("skin0.bin"),
            crate::codec::write_bin(&bin).unwrap(),
        )
        .unwrap();

        let report = audit_wad_folder(&dir).unwrap();
        // The shipped one is referenced by hash alone — not bloat.
        assert!(
            !report.bloat.iter().any(|b| b.path == shipped),
            "a file-typed reference must count as a reference: {:?}",
            report.bloat
        );
        // The other one dangles, and says so by hash since no name exists.
        let hex = format!("0x{:016x}", ritoshark::hash::xxh64(gone));
        assert!(report.missing.contains(&hex), "{:?}", report.missing);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_hd_twin_the_mod_does_not_ship_is_not_missing() {
        use ritoshark::bin::{BinEntry, BinValue};

        let dir = std::env::temp_dir().join(format!("flint-audit-twin-{}", std::process::id()));
        let assets = dir.join("assets").join("characters").join("foo");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(assets.join("skin.dds"), b"xxxx").unwrap();
        // One real 2x_ file present, which used to switch every synthesised twin on.
        std::fs::write(assets.join("2x_other.dds"), b"xxxx").unwrap();
        std::fs::create_dir_all(dir.join("data")).unwrap();

        let mut fields = indexmap::IndexMap::new();
        fields.insert(
            ritoshark::hash::fnv1a("texture"),
            BinValue::String("assets/characters/foo/skin.dds".into()),
        );
        let bin = Bin {
            entries: vec![BinEntry { path_hash: 1, class_hash: 2, fields }],
            ..Bin::new()
        };
        std::fs::write(
            dir.join("data").join("skin0.bin"),
            crate::codec::write_bin(&bin).unwrap(),
        )
        .unwrap();

        let report = audit_wad_folder(&dir).unwrap();
        assert!(
            report.missing.is_empty(),
            "nothing references a twin, so an absent one is not missing: {:?}",
            report.missing,
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_side_table_names_the_bins_file_references() {
        use ritoshark::bin::{BinEntry, BinValue};

        let dir = std::env::temp_dir().join(format!("flint-audit-record-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("data")).unwrap();

        let gone = "assets/modders/flint7d9f/named_7d9f.tex";
        let mut fields = indexmap::IndexMap::new();
        fields.insert(
            ritoshark::hash::fnv1a("texturePath"),
            BinValue::File(ritoshark::hash::xxh64(gone)),
        );
        let mut bin = Bin {
            entries: vec![BinEntry {
                path_hash: 1,
                class_hash: 2,
                fields,
            }],
            ..Bin::new()
        };
        let mut trailer = crate::Trailer::new();
        trailer.files.insert(ritoshark::hash::xxh64(gone), gone.to_string());
        bin.trailing = ritoshark::bin::append_trailer(&bin.trailing, &trailer);
        std::fs::write(
            dir.join("data").join("skin0.bin"),
            crate::codec::write_bin(&bin).unwrap(),
        )
        .unwrap();

        let report = audit_wad_folder(&dir).unwrap();
        assert!(
            report.missing.contains(&gone.to_string()),
            "the record is the only thing that knows this path: {:?}",
            report.missing
        );

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
