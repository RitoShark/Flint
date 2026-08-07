//! Project-wide impact scan and propagation for `.skl` joint renames.
//!
//! A joint rename changes the `.skl`'s joint name + `elf_lower` hash, but two
//! other file kinds key off the OLD identity and go stale unless they're kept
//! in sync:
//!
//! * `.anm` v3 tracks are keyed by the same `elf_lower` joint hash (see
//!   `rs_anim`'s `AnimTrack::joint_hash`).
//! * BIN bone-reference fields (`mBoneName`, `mTargetBoneName`,
//!   `mJointNameToOverride`, `mJointNameToSnapTo`, `SpringToAffect`) carry
//!   FNV1a-32 of the LOWERCASED joint name, stored as either `BinValue::Hash`
//!   (the common case) or `BinValue::String` (when the original author wrote
//!   it by name).
//!
//! Both scan (impact preview) and propagate (on save) walk the whole Flint
//! project tree the `.skn` lives in — never above it, per
//! `texture::is_flint_project_root`.

use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use ritoshark::anim::Animation;
use ritoshark::bin::BinValue;
use ritoshark::hash::fnv1a;
use ritoshark::prelude::{Parse, Serialize as RsSerialize};
use serde::Serialize;

use crate::bin::codec;

/// Safety caps mirroring `texture::find_bin_referencing_mesh` — a project tree
/// can be large, and this scan is not the primary asset index.
const MAX_FILES: usize = 8000;
const MAX_FILE_SIZE: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinBoneRef {
    pub file: String,
    pub field: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JointRenameImpact {
    pub anm_files: Vec<String>,
    pub bin_refs: Vec<BinBoneRef>,
}

/// Result of rewriting every impacted file after a joint rename was saved.
#[derive(Debug, Clone, Default)]
pub struct RenamePropagation {
    pub anm_files_updated: Vec<String>,
    pub bin_files_updated: Vec<String>,
    /// `"{path}: {reason}"` for every file that should have been updated but wasn't.
    pub errors: Vec<String>,
}

/// One BIN field known to carry a bone reference, paired with a human label
/// for the impact report.
struct BoneField {
    hash: u32,
    label: &'static str,
}

fn bone_fields() -> [BoneField; 5] {
    [
        BoneField { hash: fnv1a("mBoneName"), label: "mBoneName" },
        BoneField { hash: fnv1a("mTargetBoneName"), label: "mTargetBoneName" },
        BoneField { hash: fnv1a("mJointNameToOverride"), label: "mJointNameToOverride" },
        BoneField { hash: fnv1a("mJointNameToSnapTo"), label: "mJointNameToSnapTo" },
        BoneField { hash: fnv1a("SpringToAffect"), label: "SpringToAffect" },
    ]
}

/// The Flint project root that owns `skn_path`, or `None` if it isn't inside
/// one. Delegates to `texture`'s existing project-boundary walk — never
/// re-derive this independently, or a future fix there silently stops
/// applying here.
pub fn find_project_root(skn_path: &Path) -> Option<PathBuf> {
    super::texture::find_project_root_from_path(skn_path)
}

/// Every `.anm` and `.bin` file under `root`, bounded by `MAX_FILES`.
fn collect_candidate_files(root: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut anm = Vec::new();
    let mut bin = Vec::new();
    for entry in walkdir::WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if anm.len() + bin.len() >= MAX_FILES {
            tracing::debug!("[joint-rename] hit MAX_FILES ({MAX_FILES}) scanning {}", root.display());
            break;
        }
        let path = entry.path();
        if !entry.file_type().is_file() {
            continue;
        }
        match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()) {
            Some(ext) if ext == "anm" => anm.push(path.to_path_buf()),
            Some(ext) if ext == "bin" => bin.push(path.to_path_buf()),
            _ => {}
        }
    }
    (anm, bin)
}

fn oversized(path: &Path) -> bool {
    std::fs::metadata(path).map(|m| m.len() > MAX_FILE_SIZE).unwrap_or(true)
}

fn value_matches_name(value: &BinValue, hash: u32, name: &str) -> bool {
    match value {
        BinValue::Hash(h) => *h == hash,
        BinValue::String(s) => s.eq_ignore_ascii_case(name),
        _ => false,
    }
}

fn scan_value(value: &BinValue, lookup: &[BoneField], hash: u32, name: &str, file: &str, out: &mut Vec<BinBoneRef>) {
    match value {
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            scan_fields(fields, lookup, hash, name, file, out)
        }
        BinValue::List { items, .. } => {
            for item in items {
                scan_value(item, lookup, hash, name, file, out);
            }
        }
        BinValue::Option { value: Some(inner), .. } => scan_value(inner, lookup, hash, name, file, out),
        BinValue::Map { entries, .. } => {
            for (k, v) in entries {
                scan_value(k, lookup, hash, name, file, out);
                scan_value(v, lookup, hash, name, file, out);
            }
        }
        _ => {}
    }
}

fn scan_fields(fields: &IndexMap<u32, BinValue>, lookup: &[BoneField], hash: u32, name: &str, file: &str, out: &mut Vec<BinBoneRef>) {
    for (k, v) in fields {
        if let Some(bf) = lookup.iter().find(|f| f.hash == *k) {
            if value_matches_name(v, hash, name) {
                out.push(BinBoneRef { file: file.to_string(), field: bf.label.to_string() });
            }
        }
        scan_value(v, lookup, hash, name, file, out);
    }
}

/// Scan the project owning `skn_path` for every `.anm` track keyed to the
/// joint's current `elf_lower` hash and every BIN bone-reference field naming
/// it (by hash or by string). Returns an empty impact (never an error) when
/// the file isn't inside a Flint project — a rename can still proceed, it
/// just has nothing to propagate to.
pub fn scan_impact(skn_path: &Path, joint_name: &str, joint_hash: u32) -> JointRenameImpact {
    let Some(root) = find_project_root(skn_path) else {
        tracing::debug!("[joint-rename] {} is not inside a Flint project; skipping impact scan", skn_path.display());
        return JointRenameImpact::default();
    };
    scan_impact_in(&root, joint_name, joint_hash)
}

fn scan_impact_in(root: &Path, joint_name: &str, joint_hash: u32) -> JointRenameImpact {
    let (anm_paths, bin_paths) = collect_candidate_files(root);
    let name_hash = fnv1a(&joint_name.to_lowercase());
    let lookup = bone_fields();

    let mut anm_files = Vec::new();
    for path in &anm_paths {
        if oversized(path) {
            continue;
        }
        let Ok(data) = std::fs::read(path) else { continue };
        let Ok(anim) = Animation::from_bytes(&data) else { continue };
        if anim.tracks().iter().any(|t| t.joint_hash == joint_hash) {
            anm_files.push(path.to_string_lossy().to_string());
        }
    }

    let mut bin_refs: Vec<BinBoneRef> = Vec::new();
    for path in &bin_paths {
        if oversized(path) {
            continue;
        }
        let Ok(data) = std::fs::read(path) else { continue };
        let Ok(tree) = codec::read_bin(&data) else { continue };
        let file = path.to_string_lossy().to_string();
        for entry in &tree.entries {
            scan_fields(&entry.fields, &lookup, name_hash, joint_name, &file, &mut bin_refs);
        }
    }
    bin_refs.sort_by(|a, b| (&a.file, &a.field).cmp(&(&b.file, &b.field)));
    bin_refs.dedup_by(|a, b| a.file == b.file && a.field == b.field);

    anm_files.sort();
    JointRenameImpact { anm_files, bin_refs }
}

fn rewrite_value(value: &mut BinValue, lookup: &[BoneField], old_hash: u32, old_name: &str, new_hash: u32, new_name: &str) -> bool {
    match value {
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            rewrite_fields(fields, lookup, old_hash, old_name, new_hash, new_name)
        }
        BinValue::List { items, .. } => {
            let mut touched = false;
            for item in items.iter_mut() {
                touched |= rewrite_value(item, lookup, old_hash, old_name, new_hash, new_name);
            }
            touched
        }
        BinValue::Option { value: Some(inner), .. } => {
            rewrite_value(inner, lookup, old_hash, old_name, new_hash, new_name)
        }
        BinValue::Map { entries, .. } => {
            let mut touched = false;
            for (k, v) in entries.iter_mut() {
                touched |= rewrite_value(k, lookup, old_hash, old_name, new_hash, new_name);
                touched |= rewrite_value(v, lookup, old_hash, old_name, new_hash, new_name);
            }
            touched
        }
        _ => false,
    }
}

fn rewrite_bone_value(value: &mut BinValue, old_hash: u32, old_name: &str, new_hash: u32, new_name: &str) -> bool {
    match value {
        BinValue::Hash(h) if *h == old_hash => {
            *h = new_hash;
            true
        }
        BinValue::String(s) if s.eq_ignore_ascii_case(old_name) => {
            *s = new_name.to_string();
            true
        }
        _ => false,
    }
}

fn rewrite_fields(fields: &mut IndexMap<u32, BinValue>, lookup: &[BoneField], old_hash: u32, old_name: &str, new_hash: u32, new_name: &str) -> bool {
    let mut touched = false;
    for (k, v) in fields.iter_mut() {
        if lookup.iter().any(|f| f.hash == *k) {
            touched |= rewrite_bone_value(v, old_hash, old_name, new_hash, new_name);
        }
        touched |= rewrite_value(v, lookup, old_hash, old_name, new_hash, new_name);
    }
    touched
}

/// Re-key every `.anm` track pointing at `old_hash` to `new_hash`, saving the
/// files that changed. Returns `(updated, failed)`; `failed` entries are
/// `"{path}: {reason}"`.
fn propagate_anm_rename(anm_paths: &[PathBuf], old_hash: u32, new_hash: u32) -> (Vec<String>, Vec<String>) {
    let mut updated = Vec::new();
    let mut failed = Vec::new();

    for path in anm_paths {
        if oversized(path) {
            continue;
        }
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let mut anim = match Animation::from_bytes(&data) {
            Ok(a) => a,
            Err(_) => continue,
        };

        let mut touched = false;
        for track in anim.tracks.iter_mut() {
            if track.joint_hash == old_hash {
                track.joint_hash = new_hash;
                touched = true;
            }
        }
        if !touched {
            continue;
        }

        // The rekeyed track no longer matches the preserved source bytes.
        anim.make_editable();
        match anim.to_bytes() {
            Ok(bytes) => match std::fs::write(path, &bytes) {
                Ok(()) => {
                    tracing::debug!("[joint-rename] rekeyed anm track in {}", path.display());
                    updated.push(path.to_string_lossy().to_string());
                }
                Err(e) => failed.push(format!("{}: {e}", path.display())),
            },
            Err(e) => failed.push(format!("{}: {e:?}", path.display())),
        }
    }

    (updated, failed)
}

/// Rewrite every BIN bone-reference field naming `old_name` to `new_name`,
/// saving the files that changed. Returns `(updated, failed)`.
fn propagate_bin_rename(bin_paths: &[PathBuf], old_name: &str, new_name: &str) -> (Vec<String>, Vec<String>) {
    let old_hash = fnv1a(&old_name.to_lowercase());
    let new_hash = fnv1a(&new_name.to_lowercase());
    let lookup = bone_fields();

    let mut updated = Vec::new();
    let mut failed = Vec::new();

    for path in bin_paths {
        if oversized(path) {
            continue;
        }
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let mut tree = match codec::read_bin(&data) {
            Ok(t) => t,
            Err(_) => continue,
        };

        let mut touched = false;
        for entry in tree.entries.iter_mut() {
            touched |= rewrite_fields(&mut entry.fields, &lookup, old_hash, old_name, new_hash, new_name);
        }
        if !touched {
            continue;
        }

        match codec::write_bin(&tree) {
            Ok(bytes) => match std::fs::write(path, &bytes) {
                Ok(()) => {
                    tracing::debug!("[joint-rename] rewrote bone ref in {}", path.display());
                    updated.push(path.to_string_lossy().to_string());
                }
                Err(e) => failed.push(format!("{}: {e}", path.display())),
            },
            Err(e) => failed.push(format!("{}: {e}", path.display())),
        }
    }

    (updated, failed)
}

/// Propagate every `(old_name, old_hash, new_name, new_hash)` rename to the
/// project owning `skn_path`. Called AFTER the `.skl`/`.skn` themselves are
/// already written — a propagation failure here never unwinds that write; it
/// only reports which side files could not be kept in sync.
pub fn propagate_renames(skn_path: &Path, renames: &[(String, u32, String, u32)]) -> RenamePropagation {
    let mut result = RenamePropagation::default();
    if renames.is_empty() {
        return result;
    }

    let Some(root) = find_project_root(skn_path) else {
        result.errors.push(format!(
            "could not locate the Flint project root for {} — no side files were updated",
            skn_path.display()
        ));
        return result;
    };

    let (anm_paths, bin_paths) = collect_candidate_files(&root);

    for (old_name, old_hash, new_name, new_hash) in renames {
        let (anm_updated, anm_failed) = propagate_anm_rename(&anm_paths, *old_hash, *new_hash);
        result.anm_files_updated.extend(anm_updated);
        result.errors.extend(anm_failed);

        let (bin_updated, bin_failed) = propagate_bin_rename(&bin_paths, old_name, new_name);
        result.bin_files_updated.extend(bin_updated);
        result.errors.extend(bin_failed);
    }

    result.anm_files_updated.sort();
    result.anm_files_updated.dedup();
    result.bin_files_updated.sort();
    result.bin_files_updated.dedup();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use ritoshark::anim::{AnimFrame, AnimTrack};
    use ritoshark::math::{Quat, Vec3};
    use ritoshark::bin::{Bin, BinEntry, BinType};

    fn write_anm(path: &Path, joint_hash: u32) {
        // A v4 track's joint_hash is only recoverable via its per-frame data (see
        // `animation_write`/`animation_read`'s v4 layout) — a real track can never
        // have zero frames, so the fixture needs at least one.
        let mut anim = Animation::new(30.0);
        anim.tracks.push(AnimTrack {
            joint_hash,
            frames: vec![AnimFrame::new(0.0, Quat::IDENTITY, Vec3::ZERO, Vec3::ONE)],
        });
        std::fs::write(path, anim.to_bytes().unwrap()).unwrap();
    }

    fn write_bone_ref_bin(path: &Path, field_name: &str, value: BinValue) {
        let mut fields = IndexMap::new();
        fields.insert(fnv1a(field_name), value);
        let bin = Bin {
            entries: vec![BinEntry { path_hash: 1, class_hash: 2, fields }],
            ..Bin::new()
        };
        std::fs::write(path, codec::write_bin(&bin).unwrap()).unwrap();
    }

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flint_joint_rename_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scan_finds_anm_track_by_hash_and_bin_ref_by_hash_and_string() {
        let dir = tmp_dir("scan");
        std::fs::write(dir.join("mod.config.json"), b"{}").unwrap();

        let hash = ritoshark::hash::elf_lower("Bip001 L Hand");
        write_anm(&dir.join("clip.anm"), hash);

        let name_hash = fnv1a("bip001 l hand");
        write_bone_ref_bin(&dir.join("hash_ref.bin"), "mBoneName", BinValue::Hash(name_hash));
        write_bone_ref_bin(&dir.join("string_ref.bin"), "mTargetBoneName", BinValue::String("Bip001 L Hand".into()));
        // Decoy: unrelated field name, must not match.
        write_bone_ref_bin(&dir.join("decoy.bin"), "mSomeOtherField", BinValue::Hash(name_hash));

        let impact = scan_impact_in(&dir, "Bip001 L Hand", hash);
        assert_eq!(impact.anm_files.len(), 1);
        assert!(impact.anm_files[0].ends_with("clip.anm"));

        assert_eq!(impact.bin_refs.len(), 2);
        let fields: Vec<&str> = impact.bin_refs.iter().map(|r| r.field.as_str()).collect();
        assert!(fields.contains(&"mBoneName"));
        assert!(fields.contains(&"mTargetBoneName"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_with_no_matching_references_is_empty() {
        let dir = tmp_dir("no_match");
        std::fs::write(dir.join("mod.config.json"), b"{}").unwrap();
        write_anm(&dir.join("clip.anm"), ritoshark::hash::elf_lower("SomeOtherJoint"));

        let impact = scan_impact_in(&dir, "Root", ritoshark::hash::elf_lower("Root"));
        assert!(impact.anm_files.is_empty());
        assert!(impact.bin_refs.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn propagate_rekeys_anm_and_rewrites_bin_hash_and_string_forms() {
        let dir = tmp_dir("propagate");
        std::fs::write(dir.join("mod.config.json"), b"{}").unwrap();
        // `find_project_root_from_path` (which `propagate_renames` uses) resolves
        // a root by finding a `data/` subdirectory, not just a project marker.
        std::fs::create_dir_all(dir.join("data")).unwrap();

        let old_name = "Bip001 L Hand";
        let new_name = "Bip001 L Hand2";
        let old_hash = ritoshark::hash::elf_lower(old_name);
        let new_hash = ritoshark::hash::elf_lower(new_name);

        let anm_path = dir.join("clip.anm");
        write_anm(&anm_path, old_hash);

        let hash_bin = dir.join("hash_ref.bin");
        write_bone_ref_bin(&hash_bin, "mBoneName", BinValue::Hash(fnv1a(&old_name.to_lowercase())));

        let string_bin = dir.join("string_ref.bin");
        write_bone_ref_bin(&string_bin, "mJointNameToOverride", BinValue::String(old_name.into()));

        let skn_path = dir.join("champion.skn");
        let result = propagate_renames(&skn_path, &[(old_name.to_string(), old_hash, new_name.to_string(), new_hash)]);

        assert!(result.errors.is_empty(), "unexpected errors: {:?}", result.errors);
        assert_eq!(result.anm_files_updated.len(), 1);
        assert_eq!(result.bin_files_updated.len(), 2);

        let rewritten_anim = Animation::from_bytes(&std::fs::read(&anm_path).unwrap()).unwrap();
        assert_eq!(rewritten_anim.tracks[0].joint_hash, new_hash);

        let rewritten_hash_bin = codec::read_bin(&std::fs::read(&hash_bin).unwrap()).unwrap();
        assert_eq!(
            rewritten_hash_bin.entries[0].fields.get(&fnv1a("mBoneName")),
            Some(&BinValue::Hash(fnv1a(&new_name.to_lowercase())))
        );

        let rewritten_string_bin = codec::read_bin(&std::fs::read(&string_bin).unwrap()).unwrap();
        assert_eq!(
            rewritten_string_bin.entries[0].fields.get(&fnv1a("mJointNameToOverride")),
            Some(&BinValue::String(new_name.to_string()))
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn propagate_with_no_renames_touches_nothing() {
        let result = propagate_renames(Path::new("does/not/matter.skn"), &[]);
        assert!(result.anm_files_updated.is_empty());
        assert!(result.bin_files_updated.is_empty());
        assert!(result.errors.is_empty());
    }

    #[test]
    fn bone_ref_in_a_nested_pointer_is_found_and_rewritten() {
        // Real event structs (ParticleEventDataPair, JointSnapEventData, ...) sit
        // nested inside layers of pointer/embed wrappers, not at the entry's own
        // top level — the walk must recurse to find them.
        let dir = tmp_dir("nested");
        std::fs::write(dir.join("mod.config.json"), b"{}").unwrap();
        std::fs::create_dir_all(dir.join("data")).unwrap();

        let old_name = "Weapon_Bone";
        let new_name = "Weapon_Bone_New";
        let mut inner = IndexMap::new();
        inner.insert(fnv1a("mBoneName"), BinValue::Hash(fnv1a(&old_name.to_lowercase())));
        let mut outer = IndexMap::new();
        outer.insert(
            fnv1a("mEventData"),
            BinValue::List {
                is_list2: false,
                item: BinType::Pointer,
                // A Pointer's class hash 0 means "null" in the real BIN format
                // (rs_bin drops its fields on write) — use a real class hash so
                // this fixture round-trips through an actual write/read.
                items: vec![BinValue::Pointer { class: fnv1a("ParticleEventDataPair"), fields: inner }],
            },
        );
        let bin = Bin {
            entries: vec![BinEntry { path_hash: 1, class_hash: 2, fields: outer }],
            ..Bin::new()
        };
        let bin_path = dir.join("nested.bin");
        std::fs::write(&bin_path, codec::write_bin(&bin).unwrap()).unwrap();

        let impact = scan_impact_in(&dir, old_name, ritoshark::hash::elf_lower(old_name));
        assert_eq!(impact.bin_refs.len(), 1);
        assert_eq!(impact.bin_refs[0].field, "mBoneName");

        let result = propagate_renames(
            &dir.join("x.skn"),
            &[(old_name.to_string(), ritoshark::hash::elf_lower(old_name), new_name.to_string(), ritoshark::hash::elf_lower(new_name))],
        );
        assert!(result.errors.is_empty());
        assert_eq!(result.bin_files_updated.len(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }
}
