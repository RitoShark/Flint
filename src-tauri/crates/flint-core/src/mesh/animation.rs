//! Animation BIN parsing and ANM file loading

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::bin::codec;
use indexmap::IndexMap;
use ritoshark::anim::Animation;
use ritoshark::bin::{Bin, BinValue};
use ritoshark::hash::fnv1a;
use ritoshark::prelude::Parse;
use serde::Serialize;

use crate::mesh::materials::{self, BinIndex};
use crate::mesh::submesh_visibility::SubmeshVisEvent;

const ANIMATION_FILE_PATH: u32 = fnv1a("mAnimationFilePath");
const ANIMATION_GRAPH_DATA: u32 = fnv1a("animationGraphData");
const SKIN_MESH_PROPERTIES: u32 = fnv1a("skinMeshProperties");
const SIMPLE_SKIN: u32 = fnv1a("simpleSkin");
const SKELETON: u32 = fnv1a("skeleton");

/// The first value under `field`, anywhere in the tree, that `pick` accepts.
///
/// Depth-first because these fields nest: `skinMeshProperties` sits on the skin entry,
/// `animationGraphData` inside `skinAnimationProperties`, and a repathed bin is free to
/// wrap either in something else again.
fn find_field<T>(tree: &Bin, field: u32, pick: &dyn Fn(&BinValue) -> Option<T>) -> Option<T> {
    tree.entries
        .iter()
        .find_map(|entry| find_field_in(&entry.fields, field, pick))
}

fn find_field_in<T>(
    fields: &IndexMap<u32, BinValue>,
    field: u32,
    pick: &dyn Fn(&BinValue) -> Option<T>,
) -> Option<T> {
    if let Some(found) = fields.get(&field).and_then(pick) {
        return Some(found);
    }
    fields
        .values()
        .find_map(|value| find_field_in_value(value, field, pick))
}

fn find_field_in_value<T>(
    value: &BinValue,
    field: u32,
    pick: &dyn Fn(&BinValue) -> Option<T>,
) -> Option<T> {
    match value {
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            find_field_in(fields, field, pick)
        }
        BinValue::List { items, .. } => items
            .iter()
            .find_map(|item| find_field_in_value(item, field, pick)),
        BinValue::Option { value: Some(inner), .. } => find_field_in_value(inner, field, pick),
        BinValue::Map { entries, .. } => entries
            .iter()
            .find_map(|(_, val)| find_field_in_value(val, field, pick)),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AnimationClipInfo {
    pub name: String,
    pub track_name: Option<String>,
    pub animation_path: String,
    /// Submesh-visibility events for this clip, sorted by `start_frame`. Empty when the clip
    /// has none.
    #[serde(default)]
    pub events: Vec<SubmeshVisEvent>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnimationList {
    pub clips: Vec<AnimationClipInfo>,
    /// Submesh names hidden at load (from the skin BIN's `initialSubmeshToHide`).
    #[serde(default)]
    pub initial_hide: Vec<String>,
    /// Submesh names excluded from the shadow pass at load
    /// (`initialSubmeshShadowsToHide`).
    #[serde(default)]
    pub initial_shadow_hide: Vec<String>,
    /// Gear forms (`GearSkinUpgrade`, e.g. Kayn) — submesh hide/show deltas layered over
    /// `initial_hide`.
    #[serde(default)]
    pub forms: Vec<crate::mesh::submesh_visibility::SkinForm>,
}

/// The animation graph a skin BIN points at, from whichever of the two records carries it.
///
/// The `linked` header names the graph bin by path and is checked first. It is a header,
/// not a field, so the retype left it alone — but a repathed or hand-built bin often has
/// no usable entry there, and then the reference inside `skinAnimationProperties` is all
/// there is. That one moved: it used to be a `link` to the graph entry's name and is now
/// a `file` holding the xxh64 of the graph bin's WAD path.
pub fn extract_animation_graph_path(skin_bin_path: &Path) -> Option<PathBuf> {
    let loaded = crate::mesh::ritobin::load_bin(skin_bin_path)?;
    let (tree, names) = &*loaded;

    for dep_path in &tree.linked {
        let normalized = dep_path.to_lowercase().replace(char::from(92), "/");
        if normalized.contains("/animations/") && normalized.ends_with(".bin") {
            if let Some(found) = resolve_animation_bin_from_reference(skin_bin_path, dep_path) {
                tracing::debug!("Animation BIN from the linked header: {}", found.display());
                return Some(found);
            }
        }
    }

    let index = BinIndex::new([(tree, names.clone())]);
    let reference = find_field(tree, ANIMATION_GRAPH_DATA, &|value| index.asset_path(value))?;
    tracing::debug!("animationGraphData names {reference}");
    resolve_graph_reference(skin_bin_path, &reference)
}

/// Turn an `animationGraphData` reference into a bin on disk.
///
/// A `file` resolves to the graph bin's WAD-relative path, which is what the mod folder is
/// laid out as. A `link` resolves to the graph ENTRY's name
/// (`Characters/Kayn/Animations/Skin20`) — the same path without `DATA/` and without the
/// extension — so both land in the same place once `.bin` is appended.
fn resolve_graph_reference(skin_bin_path: &Path, reference: &str) -> Option<PathBuf> {
    let mut rel = reference.replace(char::from(92), "/");
    if !rel.to_lowercase().ends_with(".bin") {
        rel.push_str(".bin");
    }

    if let Some(root) = crate::bin::names::mod_root(skin_bin_path) {
        for candidate in [root.join(&rel), root.join("data").join(&rel)] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    resolve_animation_bin_from_reference(skin_bin_path, &rel)
}

fn resolve_animation_bin_from_reference(skin_bin_path: &Path, reference_path: &str) -> Option<PathBuf> {
    tracing::debug!("Resolving animation reference: {} from {}", reference_path, skin_bin_path.display());

    let filename = Path::new(reference_path).file_name()?.to_string_lossy().to_string();

    let skins_folder = skin_bin_path.parent()?;
    let champion_folder = skins_folder.parent()?;

    let animations_folder = champion_folder.join("animations");
    let anim_bin_path = animations_folder.join(&filename);

    tracing::debug!("Looking for animation BIN at: {}", anim_bin_path.display());

    if anim_bin_path.exists() {
        tracing::debug!("Found animation BIN: {}", anim_bin_path.display());
        return Some(anim_bin_path);
    }

    let filename_lower = filename.to_lowercase();
    let anim_bin_path_lower = animations_folder.join(&filename_lower);
    if anim_bin_path_lower.exists() {
        tracing::debug!("Found animation BIN (lowercase): {}", anim_bin_path_lower.display());
        return Some(anim_bin_path_lower);
    }
    
    tracing::debug!("Animation BIN not found at expected location");
    None
}

pub fn find_animation_bin(skn_path: &Path) -> Option<PathBuf> {
    tracing::debug!("Looking for animation BIN relative to: {}", skn_path.display());

    if let Some(skin_bin_path) = crate::mesh::texture::find_skin_bin(skn_path) {
        tracing::debug!("Found skin BIN, checking for animation graph reference: {}", skin_bin_path.display());
        if let Some(anim_bin) = extract_animation_graph_path(&skin_bin_path) {
            tracing::debug!("Found animation BIN via skin BIN reference: {}", anim_bin.display());
            return Some(anim_bin);
        }
    }
    
    if let Some(skin_dir) = skn_path.parent() {
        let anim_dir = skin_dir.join("animation");
        tracing::debug!("Checking for animation dir at: {}", anim_dir.display());
        if anim_dir.exists() {
            for i in 0..20 {
                let bin_path = anim_dir.join(format!("skin{}.bin", i));
                if bin_path.exists() {
                    tracing::debug!("Found animation BIN: {}", bin_path.display());
                    return Some(bin_path);
                }
            }
            tracing::debug!("Animation dir exists but no skinX.bin found");
        }

        if let Some(parent) = skin_dir.parent() {
            let anim_dir = parent.join("animation");
            tracing::debug!("Checking parent for animation dir at: {}", anim_dir.display());
            if anim_dir.exists() {
                for i in 0..20 {
                    let bin_path = anim_dir.join(format!("skin{}.bin", i));
                    if bin_path.exists() {
                        tracing::debug!("Found animation BIN in parent: {}", bin_path.display());
                        return Some(bin_path);
                    }
                }
            }
        }
    }
    
    let path_str = skn_path.to_string_lossy().to_lowercase();
    let components: Vec<&str> = path_str.split(&['/', '\\'][..]).collect();

    let champion_name: Option<String> = {
        let mut found = None;
        for (i, part) in components.iter().enumerate() {
            if *part == "characters" && i + 1 < components.len() {
                found = Some(components[i + 1].to_string());
                break;
            }
        }
        if found.is_none() {
            for part in &components {
                if let Some(name) = part.strip_suffix(".wad.client")
                    .or_else(|| part.strip_suffix(".wad"))
                {
                    if !name.is_empty() {
                        found = Some(name.to_string());
                        break;
                    }
                }
            }
        }
        found
    };

    let skin_folder: Option<String> = {
        let mut found = None;
        for part in components.iter().rev() {
            if part.starts_with("skin") && part.len() > 4 && part[4..].chars().all(|c| c.is_ascii_digit()) {
                found = Some(part.to_string());
                break;
            }
        }
        found
    };

    if let Some(ref champion) = champion_name {
        let mut current = skn_path.parent();
        while let Some(dir) = current {
            let data_dir = dir.join("data");
            if data_dir.exists() && data_dir.is_dir() {
                // NOTE: WAD folders are checked too — in Flint projects the
                // extracted `.wad.client` folder IS where the `data/` tree
                // lives (the old skip-and-continue here meant the champion
                // loop never looked inside it and kept walking toward
                // AppData / the user's home, where a stray `data\` dir gave
                // machine-dependent misses).
                let anim_dir = data_dir
                    .join("characters")
                    .join(champion)
                    .join("animations");

                if let Some(ref skin) = skin_folder {
                    let skin_anim = anim_dir.join(format!("{}.bin", skin));
                    if skin_anim.exists() {
                        tracing::debug!("Found animation BIN for {}: {}", skin, skin_anim.display());
                        return Some(skin_anim);
                    }
                }

                let skin0_anim = anim_dir.join("skin0.bin");
                if skin0_anim.exists() {
                    tracing::debug!("Found animation BIN (skin0): {}", skin0_anim.display());
                    return Some(skin0_anim);
                }
            }
            // Stop at the Flint project boundary — never scan above it.
            if crate::mesh::texture::is_flint_project_root(dir) {
                break;
            }
            current = dir.parent();
        }
    }

    let mut current = skn_path.parent();
    while let Some(dir) = current {
        let data_path = dir.join("data");
        if data_path.exists() {
            if let Ok(entries) = std::fs::read_dir(data_path.join("characters")) {
                for entry in entries.flatten() {
                    let anim_path = entry.path().join("animations").join("skin0.bin");
                    if anim_path.exists() {
                        tracing::debug!("Found animation BIN via data search: {}", anim_path.display());
                        return Some(anim_path);
                    }
                }
            }
        }
        if crate::mesh::texture::is_flint_project_root(dir) {
            break;
        }
        current = dir.parent();
    }

    if let Some(found) = find_animation_bin_by_content(skn_path) {
        tracing::debug!("Found animation BIN by content: {}", found.display());
        return Some(found);
    }

    tracing::debug!("Animation BIN not found");
    None
}

const ATOMIC_CLIP_DATA: u32 = ritoshark::hash::fnv1a("AtomicClipData");
const CONTENT_SCAN_BIN_LIMIT: usize = 600;

/// Last-resort animation-BIN lookup: find the bin that actually HOLDS the clips
/// instead of the one whose path looks right.
///
/// Every other branch above matches on layout (`animations/skinN.bin` under the
/// champion folder). A repathed mod moves and renames its bins, so those all miss
/// and the model ends up with no selectable animations even though the clips are
/// sitting in the project. This walks the project for bins carrying
/// `AtomicClipData` entries and takes the richest one.
fn find_animation_bin_by_content(skn_path: &Path) -> Option<PathBuf> {
    let root = content_scan_root(skn_path)?;
    tracing::debug!("Scanning {} for a bin holding AtomicClipData", root.display());

    let mut best: Option<(usize, PathBuf)> = None;
    let mut scanned = 0usize;
    for entry in walkdir::WalkDir::new(&root)
        .max_depth(12)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if scanned >= CONTENT_SCAN_BIN_LIMIT {
            tracing::debug!("Content scan hit the {CONTENT_SCAN_BIN_LIMIT}-bin limit");
            break;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()).is_none_or(|e| !e.eq_ignore_ascii_case("bin")) {
            continue;
        }
        if entry.metadata().map(|m| m.len() as usize > crate::bin::MAX_BIN_SIZE).unwrap_or(true) {
            continue;
        }
        scanned += 1;
        let Ok(data) = fs::read(path) else { continue };
        let Ok(tree) = codec::read_bin(&data) else { continue };
        let clips = tree
            .entries
            .iter()
            .filter(|e| e.class_hash == ATOMIC_CLIP_DATA)
            .count();
        if clips > 0 && best.as_ref().is_none_or(|(most, _)| clips > *most) {
            best = Some((clips, path.to_path_buf()));
        }
    }

    best.map(|(clips, path)| {
        tracing::debug!("Best animation BIN by content: {} ({clips} clips)", path.display());
        path
    })
}

/// Where the content scan starts: the Flint project root when the SKN is inside
/// one, else the nearest ancestor holding a `data/` tree. Bounded on purpose —
/// walking above the project reaches the user profile and drive root.
fn content_scan_root(skn_path: &Path) -> Option<PathBuf> {
    let mut current = skn_path.parent();
    let mut data_owner = None;
    while let Some(dir) = current {
        if crate::mesh::texture::is_flint_project_root(dir) {
            return Some(dir.to_path_buf());
        }
        if data_owner.is_none() && dir.join("data").is_dir() {
            data_owner = Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    data_owner
}

/**
Every animation clip an animation-graph BIN plays, deduped.

Two things the printed-text path could not do:

- A clip path is read from the value's TYPE. `mAnimationFilePath` used to be a `string` and
  is now a `file` holding the xxh64 of the `.anm`'s WAD path; both are arms of one match
  here, so neither form can silently stop matching.
- The hash is named from the bin's own records first — its trailer, the mod root's
  `files.txt`, and the `.anm` files actually on disk — before the global dictionary. A
  repathed mod invents paths that are in no dictionary anywhere, and its clips were
  invisible until this looked there.

Deduped by path because one clip is reached from many places: an `AtomicClipData` names the
`.anm`, and every selector, sequencer and conditional that plays it names it again.
*/
pub fn extract_animation_list(bin_path: &Path) -> anyhow::Result<AnimationList> {
    let loaded = crate::mesh::ritobin::load_bin(bin_path)
        .ok_or_else(|| anyhow::anyhow!("Failed to parse animation BIN: {}", bin_path.display()))?;
    let (tree, names) = &*loaded;
    let index = BinIndex::new([(tree, names.clone())]);

    let mut found = ClipSet::default();
    for entry in &tree.entries {
        for (field, value) in &entry.fields {
            collect_clips(&index, *field, value, &mut found);
        }
    }

    if found.unresolved > 0 {
        tracing::warn!(
            "{} names {} animation file hash(es) that resolve to no path — those clips cannot be listed",
            bin_path.display(),
            found.unresolved,
        );
    }
    tracing::debug!(
        "{} yields {} clip(s) from {} reference(s)",
        bin_path.display(),
        found.clips.len(),
        found.seen.len() + found.duplicates,
    );

    let mut clips = found.clips;

    // Attach per-clip submesh-visibility events, keyed by clip name (the `.anm` stem).
    let mut events = crate::mesh::submesh_visibility::parse_clip_visibility_events(tree);
    for clip in &mut clips {
        if let Some(ev) = events.remove(&clip.name) {
            clip.events = ev;
        }
    }

    Ok(AnimationList {
        clips,
        initial_hide: Vec::new(),
        initial_shadow_hide: Vec::new(),
        forms: Vec::new(),
    })
}

/// Clips in the order first reached, with each `.anm` kept once.
#[derive(Default)]
struct ClipSet {
    clips: Vec<AnimationClipInfo>,
    seen: HashSet<String>,
    duplicates: usize,
    /// `mAnimationFilePath` hashes no record could name — a clip whose `.anm` is gone.
    unresolved: usize,
}

impl ClipSet {
    fn push(&mut self, path: String) {
        let key = path.replace(char::from(92), "/").to_ascii_lowercase();
        if !self.seen.insert(key) {
            self.duplicates += 1;
            return;
        }
        let name = Path::new(&path)
            .file_stem()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "Unknown".to_string());
        self.clips.push(AnimationClipInfo {
            name,
            track_name: None,
            animation_path: path,
            events: Vec::new(),
        });
    }
}

fn is_anm(path: &str) -> bool {
    Path::new(path)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("anm"))
}

/// Walk one value for `.anm` references, carrying the field it sits under.
///
/// The field only matters for the failure case: an unnamed hash anywhere else is ordinary
/// (a link to another entry, a colour name), but one under `mAnimationFilePath` is an
/// animation the graph plays and nothing on disk answers to.
fn collect_clips(index: &BinIndex, field: u32, value: &BinValue, out: &mut ClipSet) {
    match value {
        BinValue::String(_) | BinValue::File(_) | BinValue::Hash(_) | BinValue::Link(_) => {
            match index.asset_path(value) {
                Some(path) if is_anm(&path) => out.push(path),
                None if field == ANIMATION_FILE_PATH => out.unresolved += 1,
                _ => {}
            }
        }
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            for (f, val) in fields {
                collect_clips(index, *f, val, out);
            }
        }
        BinValue::List { items, .. } => {
            for item in items {
                collect_clips(index, field, item, out);
            }
        }
        BinValue::Option { value: Some(inner), .. } => collect_clips(index, field, inner, out),
        BinValue::Map { entries, .. } => {
            for (key, val) in entries {
                collect_clips(index, field, key, out);
                collect_clips(index, field, val, out);
            }
        }
        _ => {}
    }
}

pub fn resolve_animation_path(base_dir: &Path, anim_path: &str) -> Option<PathBuf> {
    tracing::debug!("Resolving animation path: {} from base {}", anim_path, base_dir.display());

    let normalized_path = anim_path
        .replace("ASSETS/", "assets/")
        .replace("ASSETS\\", "assets/")
        .replace('\\', "/");

    let mut current = Some(base_dir);
    while let Some(dir) = current {
        let assets_path = dir.join("assets");
        if assets_path.exists() {
            let candidate = dir.join(&normalized_path);
            tracing::debug!("Checking candidate path: {}", candidate.display());
            if candidate.exists() {
                tracing::debug!("Found animation at: {}", candidate.display());
                return Some(candidate);
            }

            let without_prefix = normalized_path.strip_prefix("assets/").unwrap_or(&normalized_path);
            let candidate2 = assets_path.join(without_prefix);
            tracing::debug!("Checking alternate path: {}", candidate2.display());
            if candidate2.exists() {
                tracing::debug!("Found animation at: {}", candidate2.display());
                return Some(candidate2);
            }
        }

        if let Some(name) = dir.file_name() {
            let name_str = name.to_string_lossy().to_lowercase();
            if name_str.contains(".wad") || name_str.contains("wad.client") {
                let candidate = dir.join(&normalized_path);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }

        current = dir.parent();
    }

    let full_path = PathBuf::from(anim_path);
    if full_path.exists() {
        return Some(full_path);
    }
    
    tracing::debug!("Animation file not found: {}", anim_path);
    None
}

/// The mesh and rig a skin BIN's `skinMeshProperties` names.
pub struct SkinMeshRefs {
    pub simple_skin: Option<String>,
    pub skeleton: Option<String>,
}

/**
`simpleSkin` and `skeleton` from the ONE `skinMeshProperties` embed that owns them both.

A skin BIN commonly embeds particle definitions that carry their own `skeleton` for a
different rig; pairing a mesh against one of those silently weights it to the wrong
skeleton. Reading both out of the same field map is what rules that out — the particle's
skeleton lives under `particleSkin`, which is a different field, so it is never reachable
from here. The embed is still required to own `simpleSkin`: if it does not, it is not the
embed this assumes, and guessing is worse than failing.
*/
pub fn skin_mesh_refs(skin_bin_path: &Path) -> anyhow::Result<SkinMeshRefs> {
    let loaded = crate::mesh::ritobin::load_bin(skin_bin_path).ok_or_else(|| {
        anyhow::anyhow!("Failed to read skin BIN {}", skin_bin_path.display())
    })?;
    let (tree, names) = &*loaded;
    let index = BinIndex::new([(tree, names.clone())]);

    let refs = find_field(tree, SKIN_MESH_PROPERTIES, &|value| {
        let fields = materials::fields_of(value)?;
        let simple_skin = index.asset_path(fields.get(&SIMPLE_SKIN)?)?;
        Some(SkinMeshRefs {
            simple_skin: Some(simple_skin),
            skeleton: fields.get(&SKELETON).and_then(|v| index.asset_path(v)),
        })
    });

    refs.ok_or_else(|| {
        anyhow::anyhow!(
            "Skin BIN {} has no skinMeshProperties embed carrying simpleSkin",
            skin_bin_path.display()
        )
    })
}

/// Given a standalone `.anm` path, find the skin BIN that references it, read its
/// `simpleSkin`, and resolve that to a `.skn` file on disk.
pub fn resolve_skn_for_anm(anm_path: &Path) -> anyhow::Result<PathBuf> {
    let bin_path = crate::mesh::texture::find_skin_bin(anm_path)
        .or_else(|| find_animation_bin(anm_path))
        .ok_or_else(|| anyhow::anyhow!("No skin BIN found near {}", anm_path.display()))?;

    let simple_skin = skin_mesh_refs(&bin_path)?
        .simple_skin
        .ok_or_else(|| anyhow::anyhow!("BIN {} has no simpleSkin field", bin_path.display()))?;

    let base_dir = anm_path.parent().unwrap_or_else(|| Path::new("."));
    resolve_animation_path(base_dir, &simple_skin)
        .filter(|p| p.exists())
        .ok_or_else(|| anyhow::anyhow!("Could not resolve simpleSkin '{}' to a file on disk", simple_skin))
}

/// Swap an animation-graph BIN's `animations` path component for `skins`,
/// keeping the filename (`skin<N>.bin`) unchanged.
///
/// Only the LAST `animations` component — the one nearest the file — is
/// swapped, so a path that happens to contain "animations" earlier (e.g. as
/// an unrelated ancestor directory name) is not rewritten there instead.
///
/// Returns `None` when `anim_bin` has no `animations` component at all: the
/// sibling-swap assumption this resolver depends on doesn't hold, and the
/// caller must fail rather than guess where a skin BIN might be.
fn skin_bin_sibling_path(anim_bin: &Path) -> Option<PathBuf> {
    let components: Vec<_> = anim_bin.components().collect();
    let anim_idx = components.iter().rposition(|c| {
        matches!(c, std::path::Component::Normal(name) if name.eq_ignore_ascii_case("animations"))
    })?;

    let mut out = PathBuf::new();
    for (i, component) in components.iter().enumerate() {
        if i == anim_idx {
            out.push("skins");
        } else {
            out.push(component.as_os_str());
        }
    }
    Some(out)
}

/// Given an animation-graph BIN (`…/animations/skin<N>.bin`), find its sibling
/// skin BIN and resolve that skin's `skeleton` to a `.skl` on disk.
///
/// The chain, verified against a real extracted project:
///
/// ```text
/// data/characters/<champ>/animations/skin<N>.bin   (the animation graph)
///         ↓ deterministic sibling swap: animations/ → skins/
/// data/characters/<champ>/skins/skin<N>.bin        (the skin BIN)
///         ↓ skinMeshProperties (same embed as simpleSkin)
/// skeleton -> "ASSETS/…/Smolder_Base.skl"
///         ↓ resolve_animation_path
/// a real .skl on disk
/// ```
pub fn resolve_skl_for_animation_bin(anim_bin: &Path) -> anyhow::Result<PathBuf> {
    let skin_bin_path = skin_bin_sibling_path(anim_bin).ok_or_else(|| {
        anyhow::anyhow!(
            "{} has no 'animations' path component; cannot locate its sibling skin BIN",
            anim_bin.display()
        )
    })?;

    if !skin_bin_path.exists() {
        return Err(anyhow::anyhow!(
            "Sibling skin BIN not found at {}",
            skin_bin_path.display()
        ));
    }

    let skeleton = skin_mesh_refs(&skin_bin_path)?.skeleton.ok_or_else(|| {
        anyhow::anyhow!(
            "Skin BIN {} has no skeleton field in its skinMeshProperties embed",
            skin_bin_path.display()
        )
    })?;

    let base_dir = skin_bin_path.parent().unwrap_or_else(|| Path::new("."));
    resolve_animation_path(base_dir, &skeleton)
        .filter(|p| p.exists())
        .ok_or_else(|| anyhow::anyhow!("Could not resolve skeleton '{}' to a file on disk", skeleton))
}

#[derive(Debug, Clone, Serialize)]
pub struct BakedFrame {
    pub translation: [f32; 3],
    pub rotation: [f32; 4], // xyzw
    pub scale: [f32; 3],
}

#[derive(Debug, Clone, Serialize)]
pub struct BakedTrack {
    pub joint_hash: u32,
    pub frames: Vec<BakedFrame>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BakedAnimation {
    pub duration: f32,
    pub fps: f32,
    pub frame_count: u32,
    pub tracks: Vec<BakedTrack>,
}

pub fn bake_animation_file<P: AsRef<Path>>(path: P) -> anyhow::Result<BakedAnimation> {
    let data = fs::read(path.as_ref())?;

    let animation = Animation::from_bytes(&data)
        .map_err(|e| anyhow::anyhow!("Failed to parse ANM file: {:?}", e))?;

    let fps = animation.fps;

    let frame_count = animation
        .tracks
        .iter()
        .map(|t| t.frames.len())
        .max()
        .unwrap_or(0)
        .max(1);

    let frame_duration = if fps > 0.0 { 1.0 / fps } else { 0.0333 };
    let duration = (frame_count.saturating_sub(1)) as f32 * frame_duration;

    let tracks = animation
        .tracks
        .iter()
        .map(|track| {
            let frames = track
                .frames
                .iter()
                .map(|frame| {
                    /* X-mirror to match skl.rs joint transforms (translation [-x,y,z],
                       rotation [x,-y,-z,w]); skeleton bind pose is in mirrored space. */
                    BakedFrame {
                        translation: [
                            -frame.translation.x,
                            frame.translation.y,
                            frame.translation.z,
                        ],
                        rotation: [
                            frame.rotation.x,
                            -frame.rotation.y,
                            -frame.rotation.z,
                            frame.rotation.w,
                        ],
                        scale: [frame.scale.x, frame.scale.y, frame.scale.z],
                    }
                })
                .collect();
            BakedTrack {
                joint_hash: track.joint_hash,
                frames,
            }
        })
        .collect();

    Ok(BakedAnimation {
        duration,
        fps,
        frame_count: frame_count as u32,
        tracks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_animation_bin() {
    }

    #[test]
    fn falls_back_to_the_bin_that_actually_holds_the_clips() {
        use indexmap::IndexMap;
        use ritoshark::bin::{Bin, BinEntry, BinValue};
        use ritoshark::hash::fnv1a;
        use ritoshark::prelude::Serialize as _;

        let root = std::env::temp_dir().join(format!(
            "flint-animfallback-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // A repathed mod: nothing sits at `data/characters/<champ>/animations/skinN.bin`,
        // so every layout heuristic misses and only the clip data itself can be found.
        let mesh_dir = root.join("assets/dexal/myproject/skins/skin0");
        let clip_dir = root.join("assets/dexal/myproject/renamed");
        std::fs::create_dir_all(&mesh_dir).unwrap();
        std::fs::create_dir_all(&clip_dir).unwrap();
        std::fs::write(root.join("flint.json"), "{}").unwrap();

        let skn = mesh_dir.join("mychamp.skn");
        std::fs::write(&skn, []).unwrap();

        let write_bin = |path: &Path, clips: &[&str]| {
            let mut bin = Bin::new();
            bin.version = 3;
            for clip in clips {
                let mut fields = IndexMap::new();
                fields.insert(
                    fnv1a("mAnimationFilePath"),
                    BinValue::String(format!("assets/dexal/myproject/animations/{clip}.anm")),
                );
                bin.entries.push(BinEntry {
                    path_hash: fnv1a(clip),
                    class_hash: fnv1a("AtomicClipData"),
                    fields,
                });
            }
            std::fs::write(path, bin.to_bytes().unwrap()).unwrap();
        };

        // A decoy with fewer clips, and the real one with more.
        write_bin(&clip_dir.join("extra.bin"), &["Idle1"]);
        write_bin(&clip_dir.join("mychamp_anims.bin"), &["Idle1", "Run", "Attack1"]);
        // A bin with no clip data at all must never win.
        let mut empty = Bin::new();
        empty.version = 3;
        empty.entries.push(BinEntry {
            path_hash: fnv1a("Something"),
            class_hash: fnv1a("SkinCharacterDataProperties"),
            fields: IndexMap::new(),
        });
        std::fs::write(clip_dir.join("skin0.bin"), empty.to_bytes().unwrap()).unwrap();

        let found = find_animation_bin(&skn).expect("content fallback should find the clip bin");
        assert_eq!(found, clip_dir.join("mychamp_anims.bin"));

        let list = extract_animation_list(&found).unwrap();
        assert_eq!(list.clips.len(), 3);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_content_scan_never_climbs_above_the_project() {
        let root = std::env::temp_dir().join(format!(
            "flint-animscope-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let project = root.join("project");
        let mesh_dir = project.join("assets/skins/skin0");
        std::fs::create_dir_all(&mesh_dir).unwrap();
        std::fs::write(project.join("flint.json"), "{}").unwrap();
        let skn = mesh_dir.join("mychamp.skn");
        std::fs::write(&skn, []).unwrap();

        assert_eq!(content_scan_root(&skn).as_deref(), Some(project.as_path()));

        std::fs::remove_dir_all(&root).ok();
    }

    // ── skin_bin_sibling_path: the animations/ -> skins/ path derivation ──────
    //
    // Pure path math, no fixtures needed — exactly where an off-by-one in the
    // sibling swap would hide.

    #[test]
    fn swaps_animations_for_skins_keeping_the_filename() {
        let anim_bin = Path::new("data/characters/Aatrox/animations/skin0.bin");
        assert_eq!(
            skin_bin_sibling_path(anim_bin),
            Some(PathBuf::from("data/characters/Aatrox/skins/skin0.bin")),
        );
    }

    #[test]
    fn swaps_only_the_last_animations_component_when_it_appears_earlier_too() {
        // "animations" also appears as an unrelated ancestor directory name
        // here (e.g. a project checked out into a folder literally called
        // "animations"). Only the LAST occurrence — the one nearest the file,
        // which is the one the game's own folder layout actually uses — must
        // be swapped.
        let anim_bin = Path::new("C:/mods/animations/data/characters/Aatrox/animations/skin0.bin");
        assert_eq!(
            skin_bin_sibling_path(anim_bin),
            Some(PathBuf::from("C:/mods/animations/data/characters/Aatrox/skins/skin0.bin")),
        );
    }

    #[test]
    fn a_path_with_no_animations_component_fails_cleanly() {
        // Not under an animations/ folder at all — the sibling-swap
        // assumption doesn't hold. Must return None, not panic or guess.
        let bin = Path::new("data/characters/Aatrox/skins/skin0.bin");
        assert_eq!(skin_bin_sibling_path(bin), None);
    }

    // ── skinMeshProperties and the clip list, read off the tree ──────────────
    //
    // Every reference below is written the way the current client stores it: `file`
    // holding an xxh64 of the asset's WAD path. Nothing in these fixtures is a string
    // path, which is exactly what the old text scans required.

    use indexmap::IndexMap;
    use ritoshark::bin::{Bin, BinEntry, BinType, BinValue};
    use ritoshark::hash::{fnv1a, xxh64};
    use ritoshark::prelude::Serialize as _;

    struct ModRoot(PathBuf);

    impl ModRoot {
        /// A mod folder with an `assets/` tree, so `mod_root` finds it from any bin inside.
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "flint-anim-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(root.join("assets")).unwrap();
            Self(root)
        }

        /// Put an empty asset at `rel`, which is also what its xxh64 is taken over.
        fn asset(&self, rel: &str) -> &Self {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, []).unwrap();
            self
        }

        fn write_bin(&self, rel: &str, bin: &Bin) -> PathBuf {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, bin.to_bytes().unwrap()).unwrap();
            crate::bin::names::forget_mod_root(&path);
            path
        }
    }

    impl Drop for ModRoot {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    fn entry(name: &str, class: &str, fields: Vec<(u32, BinValue)>) -> BinEntry {
        BinEntry {
            path_hash: fnv1a(name),
            class_hash: fnv1a(class),
            fields: fields.into_iter().collect::<IndexMap<_, _>>(),
        }
    }

    fn bin_of(entries: Vec<BinEntry>) -> Bin {
        Bin {
            version: 3,
            entries,
            ..Bin::new()
        }
    }

    fn embed(class: &str, fields: Vec<(u32, BinValue)>) -> BinValue {
        BinValue::Embed {
            class: fnv1a(class),
            fields: fields.into_iter().collect::<IndexMap<_, _>>(),
        }
    }

    fn clip(anm: BinValue) -> BinValue {
        embed(
            "AnimationResourceData",
            vec![(fnv1a("mAnimationFilePath"), anm)],
        )
    }

    #[test]
    fn reads_a_file_typed_simple_skin_and_skeleton_from_the_same_embed() {
        let root = ModRoot::new("refs");
        root.asset("assets/test/test.skn").asset("assets/test/test.skl");

        let skin = root.write_bin(
            "data/characters/test/skins/skin0.bin",
            &bin_of(vec![entry(
                "Characters/Test/Skins/Skin0",
                "SkinCharacterDataProperties",
                vec![(
                    fnv1a("skinMeshProperties"),
                    embed(
                        "SkinMeshDataProperties",
                        vec![
                            (fnv1a("simpleSkin"), BinValue::File(xxh64("assets/test/test.skn"))),
                            (fnv1a("skeleton"), BinValue::File(xxh64("assets/test/test.skl"))),
                        ],
                    ),
                )],
            )]),
        );

        let refs = skin_mesh_refs(&skin).unwrap();
        assert_eq!(refs.simple_skin.as_deref(), Some("assets/test/test.skn"));
        assert_eq!(refs.skeleton.as_deref(), Some("assets/test/test.skl"));
    }

    #[test]
    fn ignores_a_particle_skeleton_that_lives_outside_skin_mesh_properties() {
        // The particle entry comes FIRST so a "take the first skeleton anywhere" reader
        // would return its rig and fail here. BIN entries are emitted in stored hash
        // order, so particle-before-skin is a realistic layout.
        let root = ModRoot::new("particle");
        root.asset("assets/test/test.skn")
            .asset("assets/test/test.skl")
            .asset("assets/test/particle.skl");

        let skin = root.write_bin(
            "data/characters/test/skins/skin0.bin",
            &bin_of(vec![
                entry(
                    "Characters/Test/Skins/Skin0/Particles/Q",
                    "VfxSystemDefinitionData",
                    vec![(
                        fnv1a("particleSkin"),
                        embed(
                            "ParticleSkinDataProperties",
                            vec![(
                                fnv1a("skeleton"),
                                BinValue::File(xxh64("assets/test/particle.skl")),
                            )],
                        ),
                    )],
                ),
                entry(
                    "Characters/Test/Skins/Skin0",
                    "SkinCharacterDataProperties",
                    vec![(
                        fnv1a("skinMeshProperties"),
                        embed(
                            "SkinMeshDataProperties",
                            vec![
                                (fnv1a("simpleSkin"), BinValue::File(xxh64("assets/test/test.skn"))),
                                (fnv1a("skeleton"), BinValue::File(xxh64("assets/test/test.skl"))),
                            ],
                        ),
                    )],
                ),
            ]),
        );

        assert_eq!(
            skin_mesh_refs(&skin).unwrap().skeleton.as_deref(),
            Some("assets/test/test.skl"),
            "must pick the skinMeshProperties skeleton, not the particle's",
        );
    }

    #[test]
    fn an_embed_without_simple_skin_is_not_trusted() {
        let root = ModRoot::new("nosimpleskin");
        root.asset("assets/test/test.skl");

        let skin = root.write_bin(
            "data/characters/test/skins/skin0.bin",
            &bin_of(vec![entry(
                "Characters/Test/Skins/Skin0",
                "SkinCharacterDataProperties",
                vec![(
                    fnv1a("skinMeshProperties"),
                    embed(
                        "SkinMeshDataProperties",
                        vec![(fnv1a("skeleton"), BinValue::File(xxh64("assets/test/test.skl")))],
                    ),
                )],
            )]),
        );

        assert!(skin_mesh_refs(&skin).is_err());
    }

    #[test]
    fn file_typed_clip_paths_resolve_and_the_same_anm_is_listed_once() {
        let root = ModRoot::new("clips");
        root.asset("assets/test/animations/idle.anm")
            .asset("assets/test/animations/run.anm");

        let graph = root.write_bin(
            "data/characters/test/animations/skin0.bin",
            &bin_of(vec![entry(
                "Characters/Test/Animations/Skin0",
                "animationGraphData",
                vec![(
                    fnv1a("mClipDataMap"),
                    BinValue::Map {
                        key: BinType::Hash,
                        value: BinType::Pointer,
                        entries: vec![
                            (
                                BinValue::Hash(fnv1a("Idle1")),
                                clip(BinValue::File(xxh64("assets/test/animations/idle.anm"))),
                            ),
                            (
                                BinValue::Hash(fnv1a("Idle2")),
                                clip(BinValue::File(xxh64("ASSETS/Test/Animations/Idle.anm"))),
                            ),
                            (
                                BinValue::Hash(fnv1a("Run")),
                                clip(BinValue::File(xxh64("assets/test/animations/run.anm"))),
                            ),
                        ],
                    },
                )],
            )]),
        );

        let clips = extract_animation_list(&graph).unwrap().clips;
        let names: Vec<&str> = clips.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["idle", "run"]);
    }

    #[test]
    fn a_clip_whose_anm_is_gone_is_left_out_rather_than_listed_unplayable() {
        let root = ModRoot::new("missinganm");
        root.asset("assets/test/animations/idle.anm");

        let graph = root.write_bin(
            "data/characters/test/animations/skin0.bin",
            &bin_of(vec![
                entry(
                    "Idle1",
                    "AtomicClipData",
                    vec![(
                        fnv1a("mAnimationResourceData"),
                        clip(BinValue::File(xxh64("assets/test/animations/idle.anm"))),
                    )],
                ),
                entry(
                    "Deleted",
                    "AtomicClipData",
                    vec![(
                        fnv1a("mAnimationResourceData"),
                        clip(BinValue::File(xxh64("assets/test/animations/deleted.anm"))),
                    )],
                ),
            ]),
        );

        let clips = extract_animation_list(&graph).unwrap().clips;
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].animation_path, "assets/test/animations/idle.anm");
    }

    #[test]
    fn finds_the_animation_graph_bin_from_a_file_typed_reference() {
        let root = ModRoot::new("graphref");
        let graph_rel = "data/characters/test/animations/skin0.bin";
        root.write_bin(graph_rel, &bin_of(vec![]));

        let skin = root.write_bin(
            "data/characters/test/skins/skin0.bin",
            &bin_of(vec![entry(
                "Characters/Test/Skins/Skin0",
                "SkinCharacterDataProperties",
                vec![(
                    fnv1a("skinAnimationProperties"),
                    embed(
                        "SkinAnimationProperties",
                        vec![(
                            fnv1a("animationGraphData"),
                            BinValue::File(xxh64(graph_rel)),
                        )],
                    ),
                )],
            )]),
        );

        assert_eq!(
            extract_animation_graph_path(&skin),
            Some(root.0.join(graph_rel)),
        );
    }

    #[test]
    fn a_link_typed_graph_reference_still_resolves() {
        let root = ModRoot::new("graphlink");
        let graph_rel = "data/characters/test/animations/skin0.bin";
        root.write_bin(graph_rel, &bin_of(vec![]));

        let name = "Characters/Test/Animations/Skin0";
        let mut trailer = crate::bin::Trailer::new();
        trailer.names.insert(fnv1a(name), name.to_string());

        let mut bin = bin_of(vec![entry(
            "Characters/Test/Skins/Skin0",
            "SkinCharacterDataProperties",
            vec![(
                fnv1a("skinAnimationProperties"),
                embed(
                    "SkinAnimationProperties",
                    vec![(fnv1a("animationGraphData"), BinValue::Link(fnv1a(name)))],
                ),
            )],
        )]);
        bin.trailing = crate::bin::append_trailer(&bin.trailing, &trailer);

        let skin = root.write_bin("data/characters/test/skins/skin0.bin", &bin);

        let found = extract_animation_graph_path(&skin).expect("link reference should resolve");
        assert_eq!(
            std::fs::canonicalize(found).unwrap(),
            std::fs::canonicalize(root.0.join(graph_rel)).unwrap(),
        );
    }
}
