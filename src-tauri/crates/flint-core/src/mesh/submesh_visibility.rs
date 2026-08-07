//! Submesh-visibility parsing for the SKN preview.
//!
//! Two kinds of data drive which submeshes a champion shows:
//!
//! 1. **Static baseline** — `SkinCharacterDataProperties.initialSubmeshToHide` (a space-
//!    separated string of submesh names) and `initialSubmeshShadowsToHide` (comma-separated).
//!    Applied at load, before any animation plays.
//! 2. **Per-clip events** — `AtomicClipData` (and Blendable/Sequencer clips) carry an
//!    `mEventDataMap` of `SubmeshVisibilityEventData` events, each with an `mStartFrame` and
//!    hide/show submesh hash lists. As a clip plays, these events toggle submeshes at their
//!    frame.
//!
//! Submeshes in the event lists are stored as `list[hash]` = FNV1a-32 (lowercased) of the
//! submesh name. The SKN preview hashes each submesh's own name the same way and matches
//! numerically, so no hash dictionary is needed. See `ritoshark::hash::fnv1a`.

use std::collections::HashMap;
use std::path::Path;

use ritoshark::bin::{Bin, BinType, BinValue};
use ritoshark::hash::fnv1a;
use serde::Serialize;

use crate::bin::codec;

// Class hashes (FNV1a-32, lowercased). `fnv1a` is a const fn, so these fold at compile time.
const CLASS_SUBMESH_VIS_EVENT: u32 = fnv1a("SubmeshVisibilityEventData");
const CLASS_SKIN_CHAR: u32 = fnv1a("SkinCharacterDataProperties");
const CLASS_GEAR_SKIN_UPGRADE: u32 = fnv1a("GearSkinUpgrade");

// Field hashes.
const F_EVENT_DATA_MAP: u32 = fnv1a("mEventDataMap");
const F_START_FRAME: u32 = fnv1a("mStartFrame");
const F_HIDE_SUBMESH_HASH: u32 = fnv1a("mHideSubmeshHash");
const F_HIDE_SUBMESH_LIST: u32 = fnv1a("mHideSubmeshList");
const F_SHOW_SUBMESH_HASH: u32 = fnv1a("mShowSubmeshHash");
const F_SHOW_SUBMESH_LIST: u32 = fnv1a("mShowSubmeshList");
const F_INITIAL_HIDE: u32 = fnv1a("initialSubmeshToHide");
const F_INITIAL_SHADOW_HIDE: u32 = fnv1a("initialSubmeshShadowsToHide");
const F_ANIMATION_FILE_PATH: u32 = fnv1a("mAnimationFilePath");
const F_GEAR_SKIN_UPGRADES: u32 = fnv1a("mGearSkinUpgrades");
const F_CHAR_SUBMESHES_HIDE: u32 = fnv1a("mCharacterSubmeshesToHide");
const F_CHAR_SUBMESHES_SHOW: u32 = fnv1a("mCharacterSubmeshesToShow");

/// One submesh-visibility event within an animation clip.
///
/// `hide_hashes` / `show_hashes` are FNV1a-32 (lowercased) submesh-name hashes. `start_frame`
/// is a frame index (convert to seconds via the clip's `.anm` fps).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SubmeshVisEvent {
    pub start_frame: f32,
    pub hide_hashes: Vec<u32>,
    pub show_hashes: Vec<u32>,
}

/// The load-time submesh baseline read from the skin BIN.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct InitialHidden {
    /// Submesh names hidden in the world pass at load (before any animation).
    pub hide: Vec<String>,
    /// Submesh names excluded from the shadow pass (still rendered in the world pass).
    pub shadow_hide: Vec<String>,
}

/// One gear "form" of a skin (`GearSkinUpgrade`, e.g. Kayn's Assassin/Slayer upgrades).
///
/// `hide_hashes` / `show_hashes` are FNV1a-32 (lowercased) submesh-name hashes from the
/// gear's `mCharacterSubmeshesToHide` / `mCharacterSubmeshesToShow`. A form is a DELTA over
/// the `initialSubmeshToHide` baseline, not a full visibility state — the base BIN already
/// hides every form's meshes at load, which is why the gears don't hide each other.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SkinForm {
    pub name: String,
    pub hide_hashes: Vec<u32>,
    pub show_hashes: Vec<u32>,
}

/// Parse the skin's gear forms from an already-read skin BIN tree.
///
/// Order follows `SkinCharacterDataProperties.skinUpgradeData.mGearSkinUpgrades`. A link that
/// doesn't resolve inside the skin BIN is looked up in the BINs of its `linked` header:
/// Riot's build hoists entries shared between skins into `<Champ>_Skins_*.bin` and leaves only
/// the link behind, so a gear shared by several skins is reachable ONLY through that list.
/// `load_linked` supplies those trees and is called lazily — skins whose gears all resolve
/// locally (and the overwhelming majority, which have no gears at all) never pay the reads.
///
/// Any `GearSkinUpgrade` the link list missed (repathed mods relink freely) is appended in file
/// order, but ONLY from the skin BIN — a shared linked BIN carries other skins' gears too, and
/// adopting those would invent forms this skin doesn't have. Gears with no submesh changes are
/// dropped — they only swap VFX/icons, which the preview doesn't render.
pub fn parse_skin_forms(bin: &Bin, load_linked: impl FnOnce() -> Vec<Bin>) -> Vec<SkinForm> {
    let links = gear_links(bin);

    // Only touch the disk when a link is actually missing from the skin BIN.
    let linked: Vec<Bin> = if links.iter().all(|h| find_gear(bin, *h).is_some()) {
        Vec::new()
    } else {
        load_linked()
    };

    let mut gears: Vec<&ritoshark::bin::BinEntry> = Vec::new();
    for link in &links {
        if let Some(gear) = find_gear(bin, *link).or_else(|| linked.iter().find_map(|t| find_gear(t, *link))) {
            gears.push(gear);
        }
    }
    for entry in bin.entries.iter().filter(|e| e.class_hash == CLASS_GEAR_SKIN_UPGRADE) {
        if !gears.iter().any(|g| g.path_hash == entry.path_hash) {
            gears.push(entry);
        }
    }

    let mut forms = Vec::new();
    for gear in gears {
        // The lists live inside `mGearData` (a pointer), so deep-search the field tree.
        let hide_hashes = find_field(&gear.fields, F_CHAR_SUBMESHES_HIDE)
            .map(hash_list_items)
            .unwrap_or_default();
        let show_hashes = find_field(&gear.fields, F_CHAR_SUBMESHES_SHOW)
            .map(hash_list_items)
            .unwrap_or_default();
        if hide_hashes.is_empty() && show_hashes.is_empty() {
            continue;
        }
        forms.push(SkinForm {
            name: format!("Form {}", forms.len() + 1),
            hide_hashes,
            show_hashes,
        });
    }
    forms
}

/// The skin's `mGearSkinUpgrades` link targets, in declaration order (zeros dropped).
fn gear_links(bin: &Bin) -> Vec<u32> {
    let Some(entry) = bin.entries.iter().find(|e| e.class_hash == CLASS_SKIN_CHAR) else {
        return Vec::new();
    };
    let Some(BinValue::List { items, .. }) = find_field(&entry.fields, F_GEAR_SKIN_UPGRADES) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| match item {
            BinValue::Link(h) | BinValue::Hash(h) if *h != 0 => Some(*h),
            _ => None,
        })
        .collect()
}

/// The `GearSkinUpgrade` entry a link points at, if this tree holds it.
fn find_gear(bin: &Bin, link: u32) -> Option<&ritoshark::bin::BinEntry> {
    bin.entries
        .iter()
        .find(|e| e.path_hash == link && e.class_hash == CLASS_GEAR_SKIN_UPGRADE)
}

/// The non-zero hashes of a `list[hash]` value (empty for anything else).
fn hash_list_items(value: &BinValue) -> Vec<u32> {
    let BinValue::List { items, .. } = value else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| match item {
            BinValue::Hash(h) if *h != 0 => Some(*h),
            _ => None,
        })
        .collect()
}

// ── Gear form editing (assign_submesh_to_form) ──────────────────────────────
//
// `parse_skin_forms` above is read-only and numbers forms by skipping any
// `GearSkinUpgrade` with empty hide/show lists. Editing needs the SAME
// numbering (so a form index the frontend got from `parse_skin_forms` still
// means the same gear here) plus the entry's `path_hash` to find it again for
// mutation — and it must refuse to touch a gear hoisted into a shared linked
// BIN, since that file is reused by other skins and mutating it would
// reassign the gear for all of them, not just this one.

/// The `path_hash` of the `GearSkinUpgrade` backing `parse_skin_forms`'s
/// `form_index`-th form, IF that gear lives in `bin` itself. Errors when the
/// form's gear was hoisted into a shared linked BIN (mutating it would affect
/// every other skin that also links it) or when `form_index` doesn't exist.
pub fn local_gear_path_hash_for_form_index(
    bin: &Bin,
    load_linked: impl FnOnce() -> Vec<Bin>,
    form_index: usize,
) -> Result<u32, String> {
    let links = gear_links(bin);
    let linked: Vec<Bin> = if links.iter().all(|h| find_gear(bin, *h).is_some()) {
        Vec::new()
    } else {
        load_linked()
    };

    // (path_hash, is_local), in the same order `parse_skin_forms` builds `gears`.
    let mut gears: Vec<(u32, bool)> = Vec::new();
    for link in &links {
        if find_gear(bin, *link).is_some() {
            gears.push((*link, true));
        } else if linked.iter().any(|t| find_gear(t, *link).is_some()) {
            gears.push((*link, false));
        }
    }
    for entry in bin.entries.iter().filter(|e| e.class_hash == CLASS_GEAR_SKIN_UPGRADE) {
        if !gears.iter().any(|(h, _)| *h == entry.path_hash) {
            gears.push((entry.path_hash, true));
        }
    }

    let mut form_idx = 0usize;
    for (path_hash, is_local) in gears {
        let fields = if is_local {
            find_gear(bin, path_hash).map(|g| &g.fields)
        } else {
            linked.iter().find_map(|t| find_gear(t, path_hash)).map(|g| &g.fields)
        };
        let Some(fields) = fields else { continue };

        let hide = find_field(fields, F_CHAR_SUBMESHES_HIDE).map(hash_list_items).unwrap_or_default();
        let show = find_field(fields, F_CHAR_SUBMESHES_SHOW).map(hash_list_items).unwrap_or_default();
        if hide.is_empty() && show.is_empty() {
            continue;
        }

        if form_idx == form_index {
            return if is_local {
                Ok(path_hash)
            } else {
                Err("this form's gear data is shared with other skins (hoisted into a linked BIN) and cannot be edited here".to_string())
            };
        }
        form_idx += 1;
    }

    Err(format!("form index {form_index} does not exist"))
}

/// Recursively find the fields map owning `mCharacterSubmeshesToHide` /
/// `mCharacterSubmeshesToShow` under a `GearSkinUpgrade` entry's fields and
/// add/remove `hash` there per `mode`. Both lists live as siblings on the same
/// struct (`GearData`, reached through `mGearData`), so finding either one is
/// enough to anchor the edit. Returns whether a home was found and edited.
fn apply_submesh_visibility(fields: &mut indexmap::IndexMap<u32, BinValue>, hash: u32, mode: &SubmeshVisMode) -> bool {
    if fields.contains_key(&F_CHAR_SUBMESHES_HIDE) || fields.contains_key(&F_CHAR_SUBMESHES_SHOW) {
        match mode {
            SubmeshVisMode::Show => {
                remove_hash_from_list(fields, F_CHAR_SUBMESHES_HIDE, hash);
                add_hash_to_list(fields, F_CHAR_SUBMESHES_SHOW, hash);
            }
            SubmeshVisMode::Hide => {
                remove_hash_from_list(fields, F_CHAR_SUBMESHES_SHOW, hash);
                add_hash_to_list(fields, F_CHAR_SUBMESHES_HIDE, hash);
            }
            SubmeshVisMode::Clear => {
                remove_hash_from_list(fields, F_CHAR_SUBMESHES_HIDE, hash);
                remove_hash_from_list(fields, F_CHAR_SUBMESHES_SHOW, hash);
            }
        }
        return true;
    }

    for val in fields.values_mut() {
        let found = match val {
            BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
                apply_submesh_visibility(fields, hash, mode)
            }
            BinValue::Option { value: Some(inner), .. } => match &mut **inner {
                BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
                    apply_submesh_visibility(fields, hash, mode)
                }
                _ => false,
            },
            _ => false,
        };
        if found {
            return true;
        }
    }
    false
}

fn add_hash_to_list(fields: &mut indexmap::IndexMap<u32, BinValue>, field: u32, hash: u32) {
    let list = fields.entry(field).or_insert_with(|| BinValue::List {
        is_list2: false,
        item: BinType::Hash,
        items: Vec::new(),
    });
    if let BinValue::List { items, .. } = list {
        if !items.iter().any(|v| matches!(v, BinValue::Hash(h) if *h == hash)) {
            items.push(BinValue::Hash(hash));
        }
    }
}

fn remove_hash_from_list(fields: &mut indexmap::IndexMap<u32, BinValue>, field: u32, hash: u32) {
    if let Some(BinValue::List { items, .. }) = fields.get_mut(&field) {
        items.retain(|v| !matches!(v, BinValue::Hash(h) if *h == hash));
    }
}

enum SubmeshVisMode {
    Show,
    Hide,
    Clear,
}

impl SubmeshVisMode {
    fn parse(s: &str) -> Result<Self, String> {
        match s {
            "show" => Ok(Self::Show),
            "hide" => Ok(Self::Hide),
            "clear" => Ok(Self::Clear),
            other => Err(format!("unknown mode \"{other}\" (expected show, hide, or clear)")),
        }
    }
}

/// Add or remove `submesh`'s FNV1a-32 (lowercased) hash in the `form_index`-th
/// gear form's hide/show submesh lists, per `mode` (`"show"` / `"hide"` /
/// `"clear"`). `"clear"` removes it from both lists. Refuses forms whose gear
/// is hoisted into a shared linked BIN — see
/// `local_gear_path_hash_for_form_index`.
///
/// Only usable when `load_linked` does not itself need to borrow `bin` (e.g.
/// `Vec::new`, or a fixed set of already-loaded trees) — a closure that reads
/// `bin` cannot be combined with the `&mut Bin` this needs in one call. A
/// caller whose linked-BIN lookup does borrow the tree (as
/// `read_linked_bin_trees` does) must instead call
/// `local_gear_path_hash_for_form_index` and `apply_submesh_visibility_to_gear`
/// as two separate steps, so the immutable borrow the lookup needs is fully
/// released before the mutable borrow the edit needs begins.
pub fn set_form_submesh_visibility(
    bin: &mut Bin,
    load_linked: impl FnOnce() -> Vec<Bin>,
    form_index: usize,
    submesh: &str,
    mode: &str,
) -> Result<(), String> {
    let gear_path_hash = local_gear_path_hash_for_form_index(bin, load_linked, form_index)?;
    apply_submesh_visibility_to_gear(bin, gear_path_hash, submesh, mode)
}

/// Mutate the already-resolved `gear_path_hash` entry directly. Split out from
/// `set_form_submesh_visibility` so callers whose `load_linked` closure
/// borrows the same `Bin` can resolve the index first (immutable borrow) and
/// mutate second (mutable borrow) — combining both borrows in one call would
/// not compile.
pub fn apply_submesh_visibility_to_gear(
    bin: &mut Bin,
    gear_path_hash: u32,
    submesh: &str,
    mode: &str,
) -> Result<(), String> {
    let mode = SubmeshVisMode::parse(mode)?;
    let hash = fnv1a(&submesh.to_lowercase());
    let entry = bin
        .entries
        .iter_mut()
        .find(|e| e.path_hash == gear_path_hash && e.class_hash == CLASS_GEAR_SKIN_UPGRADE)
        .ok_or_else(|| "gear entry not found".to_string())?;

    if !apply_submesh_visibility(&mut entry.fields, hash, &mode) {
        return Err("could not locate this gear's submesh visibility lists".to_string());
    }
    Ok(())
}

/// Parse a skin BIN's `initialSubmeshToHide` / `initialSubmeshShadowsToHide` from disk.
///
/// Returns an empty `InitialHidden` (never an error) if the file is unreadable, unparseable,
/// or has no `SkinCharacterDataProperties` entry — the baseline is purely additive polish.
pub fn parse_initial_hidden_file(skin_bin_path: &Path) -> InitialHidden {
    let Ok(data) = std::fs::read(skin_bin_path) else {
        return InitialHidden::default();
    };
    let Ok(tree) = codec::read_bin(&data) else {
        return InitialHidden::default();
    };
    parse_initial_hidden(&tree)
}

/// Parse the static submesh baseline from an already-read skin BIN tree.
pub fn parse_initial_hidden(bin: &Bin) -> InitialHidden {
    let Some(entry) = bin.entries.iter().find(|e| e.class_hash == CLASS_SKIN_CHAR) else {
        return InitialHidden::default();
    };

    // The fields may sit directly on the entry or nested inside a `skinMeshProperties` embed.
    // Search the entry's field tree for the two strings by their field hash. League is
    // inconsistent about the delimiter here — some skins use commas, some use spaces (real
    // Kayn data is comma-separated) — so split on BOTH.
    let hide = find_string_field(&entry.fields, F_INITIAL_HIDE)
        .map(split_names)
        .unwrap_or_default();
    let shadow_hide = find_string_field(&entry.fields, F_INITIAL_SHADOW_HIDE)
        .map(split_names)
        .unwrap_or_default();

    InitialHidden { hide, shadow_hide }
}

/// Parse every clip's submesh-visibility events out of an animation BIN on disk, keyed by
/// clip name (the `.anm` file stem, matching how the animation list names clips).
///
/// Returns an empty map (never an error) when the file can't be read/parsed.
pub fn parse_clip_visibility_events_file(anim_bin_path: &Path) -> HashMap<String, Vec<SubmeshVisEvent>> {
    let Ok(data) = std::fs::read(anim_bin_path) else {
        return HashMap::new();
    };
    let Ok(tree) = codec::read_bin(&data) else {
        return HashMap::new();
    };
    parse_clip_visibility_events(&tree)
}

/// Parse per-clip submesh-visibility events from an already-read animation BIN tree.
///
/// Walks the whole tree looking for clip structures (any embed/pointer that carries both an
/// `mAnimationFilePath` and an `mEventDataMap`). The clip name is the `.anm` stem, so the
/// events line up with the animation-list rows the frontend already renders.
pub fn parse_clip_visibility_events(bin: &Bin) -> HashMap<String, Vec<SubmeshVisEvent>> {
    let mut out: HashMap<String, Vec<SubmeshVisEvent>> = HashMap::new();
    for entry in &bin.entries {
        for value in entry.fields.values() {
            walk_for_clips(value, &mut out);
        }
    }
    out
}

/// Recurse looking for clip structs. A clip is any struct that has an `mAnimationFilePath`
/// somewhere in its own fields (via `mAnimationResourceData`) and an `mEventDataMap`.
fn walk_for_clips(value: &BinValue, out: &mut HashMap<String, Vec<SubmeshVisEvent>>) {
    match value {
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            if let Some(name) = clip_name_from_fields(fields) {
                let events = events_from_clip(fields);
                if !events.is_empty() {
                    // A given clip name can appear once; keep the richer event list if it
                    // somehow recurs.
                    out.entry(name).or_insert(events);
                }
            }
            for val in fields.values() {
                walk_for_clips(val, out);
            }
        }
        BinValue::List { items, .. } => {
            for item in items {
                walk_for_clips(item, out);
            }
        }
        BinValue::Option { value: Some(inner), .. } => walk_for_clips(inner, out),
        BinValue::Map { entries, .. } => {
            for (_key, val) in entries {
                walk_for_clips(val, out);
            }
        }
        _ => {}
    }
}

/// The clip name (`.anm` file stem) if this clip's fields reference an animation file.
fn clip_name_from_fields(fields: &indexmap::IndexMap<u32, BinValue>) -> Option<String> {
    // Only treat this struct as a clip if it also carries an event map — otherwise a plain
    // AnimationResourceData embed would match. The event map is what we attach events to.
    fields.get(&F_EVENT_DATA_MAP)?;
    let path = find_string_field(fields, F_ANIMATION_FILE_PATH)?;
    Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
}

/// Extract and sort the `SubmeshVisibilityEventData` events from a clip's `mEventDataMap`.
fn events_from_clip(fields: &indexmap::IndexMap<u32, BinValue>) -> Vec<SubmeshVisEvent> {
    let Some(BinValue::Map { entries, .. }) = fields.get(&F_EVENT_DATA_MAP) else {
        return Vec::new();
    };

    let mut events = Vec::new();
    for (_key, val) in entries {
        let fields = match val {
            BinValue::Pointer { class, fields } | BinValue::Embed { class, fields }
                if *class == CLASS_SUBMESH_VIS_EVENT =>
            {
                fields
            }
            _ => continue,
        };

        let start_frame = match fields.get(&F_START_FRAME) {
            Some(BinValue::F32(f)) => *f,
            _ => 0.0,
        };
        let hide_hashes = collect_submesh_hashes(fields, F_HIDE_SUBMESH_HASH, F_HIDE_SUBMESH_LIST);
        let show_hashes = collect_submesh_hashes(fields, F_SHOW_SUBMESH_HASH, F_SHOW_SUBMESH_LIST);

        if hide_hashes.is_empty() && show_hashes.is_empty() {
            continue;
        }
        events.push(SubmeshVisEvent {
            start_frame,
            hide_hashes,
            show_hashes,
        });
    }

    events.sort_by(|a, b| a.start_frame.partial_cmp(&b.start_frame).unwrap_or(std::cmp::Ordering::Equal));
    events
}

/// Combine a scalar `hash` field and a `list[hash]` field into one hash vector, dropping the
/// zero sentinel ("unset").
fn collect_submesh_hashes(
    fields: &indexmap::IndexMap<u32, BinValue>,
    singular_field: u32,
    list_field: u32,
) -> Vec<u32> {
    let mut out = Vec::new();
    if let Some(BinValue::Hash(h)) = fields.get(&singular_field) {
        if *h != 0 {
            out.push(*h);
        }
    }
    if let Some(BinValue::List { items, .. }) = fields.get(&list_field) {
        for item in items {
            if let BinValue::Hash(h) = item {
                if *h != 0 {
                    out.push(*h);
                }
            }
        }
    }
    out
}

/// Depth-first search a field tree for any value under the given field hash, recursing into
/// pointers/embeds/options (not lists or maps — the fields we chase live on structs).
fn find_field(fields: &indexmap::IndexMap<u32, BinValue>, field_hash: u32) -> Option<&BinValue> {
    if let Some(v) = fields.get(&field_hash) {
        return Some(v);
    }
    for val in fields.values() {
        let found = match val {
            BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
                find_field(fields, field_hash)
            }
            BinValue::Option { value: Some(inner), .. } => match &**inner {
                BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
                    find_field(fields, field_hash)
                }
                _ => None,
            },
            _ => None,
        };
        if found.is_some() {
            return found;
        }
    }
    None
}

/// Depth-first search a field tree for a `String` value under the given field hash.
fn find_string_field(fields: &indexmap::IndexMap<u32, BinValue>, field_hash: u32) -> Option<&str> {
    if let Some(BinValue::String(s)) = fields.get(&field_hash) {
        return Some(s);
    }
    for val in fields.values() {
        if let Some(found) = find_string_in_value(val, field_hash) {
            return Some(found);
        }
    }
    None
}

fn find_string_in_value(value: &BinValue, field_hash: u32) -> Option<&str> {
    match value {
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            find_string_field(fields, field_hash)
        }
        BinValue::Option { value: Some(inner), .. } => find_string_in_value(inner, field_hash),
        _ => None,
    }
}

/// Split a submesh-name list on commas and/or whitespace, dropping empties. League uses either
/// delimiter depending on the skin, so accept both.
fn split_names(s: &str) -> Vec<String> {
    s.split(|c: char| c == ',' || c.is_whitespace())
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;
    use ritoshark::bin::{BinEntry, BinType};

    #[test]
    fn submesh_name_hashes_match_verified_value() {
        // Verified against the animation BIN's list[hash] value for this submesh.
        assert_eq!(fnv1a("Kayn_Skin20_Slayer_Hair_MAT"), 0xa973e905);
    }

    #[test]
    fn class_and_field_hashes_are_correct() {
        assert_eq!(CLASS_SUBMESH_VIS_EVENT, 0xbcf56e70);
        assert_eq!(CLASS_SKIN_CHAR, 0x9b67e9f6);
        assert_eq!(F_SHOW_SUBMESH_LIST, 0x6d4d42d0);
        assert_eq!(F_HIDE_SUBMESH_LIST, 0xbb41a45b);
        assert_eq!(F_EVENT_DATA_MAP, 0xf598463e);
        assert_eq!(F_INITIAL_HIDE, 0x80b7f78f);
        assert_eq!(F_INITIAL_SHADOW_HIDE, 0xf4ba5c9e);
    }

    #[test]
    fn initial_hide_splits_on_commas_and_whitespace() {
        let mut fields = IndexMap::new();
        // Real Kayn data is comma-separated (with spaces after commas).
        fields.insert(
            F_INITIAL_HIDE,
            BinValue::String(
                "Kayn_Skin20_Slayer_MAT, Kayn_Skin20_Assassin_MAT, Kayn_Skin20_Glitch_MAT"
                    .to_string(),
            ),
        );
        // Some skins space-separate instead — both must work.
        fields.insert(
            F_INITIAL_SHADOW_HIDE,
            BinValue::String("Sword_VFX Cape_Shadow".to_string()),
        );
        let bin = Bin {
            entries: vec![BinEntry {
                path_hash: 1,
                class_hash: CLASS_SKIN_CHAR,
                fields,
            }],
            ..Bin::new()
        };
        let hidden = parse_initial_hidden(&bin);
        assert_eq!(
            hidden.hide,
            vec![
                "Kayn_Skin20_Slayer_MAT",
                "Kayn_Skin20_Assassin_MAT",
                "Kayn_Skin20_Glitch_MAT"
            ]
        );
        assert_eq!(hidden.shadow_hide, vec!["Sword_VFX", "Cape_Shadow"]);
    }

    #[test]
    fn initial_hide_reads_nested_mesh_properties() {
        // Fields nested one level deep inside a skinMeshProperties embed still resolve.
        let mut inner = IndexMap::new();
        inner.insert(F_INITIAL_HIDE, BinValue::String("A B".to_string()));
        let mut outer = IndexMap::new();
        outer.insert(
            fnv1a("skinMeshProperties"),
            BinValue::Embed { class: 0, fields: inner },
        );
        let bin = Bin {
            entries: vec![BinEntry {
                path_hash: 1,
                class_hash: CLASS_SKIN_CHAR,
                fields: outer,
            }],
            ..Bin::new()
        };
        assert_eq!(parse_initial_hidden(&bin).hide, vec!["A", "B"]);
    }

    fn hash_list(hashes: &[u32]) -> BinValue {
        BinValue::List {
            is_list2: false,
            item: BinType::Hash,
            items: hashes.iter().map(|h| BinValue::Hash(*h)).collect(),
        }
    }

    fn vis_event(start: f32, hide: &[u32], show: &[u32]) -> BinValue {
        let mut fields = IndexMap::new();
        fields.insert(F_START_FRAME, BinValue::F32(start));
        fields.insert(F_HIDE_SUBMESH_LIST, hash_list(hide));
        fields.insert(F_SHOW_SUBMESH_LIST, hash_list(show));
        BinValue::Embed {
            class: CLASS_SUBMESH_VIS_EVENT,
            fields,
        }
    }

    #[test]
    fn parses_clip_events_sorted_by_frame_with_zeros_dropped() {
        // Build a clip: mAnimationResourceData.mAnimationFilePath + mEventDataMap with two events.
        let mut anim_res = IndexMap::new();
        anim_res.insert(
            F_ANIMATION_FILE_PATH,
            BinValue::String("ASSETS/Test/Idle1_Slayer.anm".to_string()),
        );

        let mut event_map = Vec::new();
        // Later event first, to prove sorting.
        event_map.push((BinValue::Hash(2), vis_event(34.0, &[0xAAAA, 0], &[])));
        event_map.push((BinValue::Hash(1), vis_event(14.0, &[0xBBBB], &[0xCCCC])));

        let mut clip_fields = IndexMap::new();
        clip_fields.insert(
            fnv1a("mAnimationResourceData"),
            BinValue::Embed { class: 0, fields: anim_res },
        );
        clip_fields.insert(
            F_EVENT_DATA_MAP,
            BinValue::Map {
                key: BinType::Hash,
                value: BinType::Pointer,
                entries: event_map,
            },
        );

        // Wrap the clip in a top-level entry's mClipDataMap.
        let mut clip_map = Vec::new();
        clip_map.push((
            BinValue::Hash(fnv1a("Idle1_Slayer")),
            BinValue::Embed { class: fnv1a("AtomicClipData"), fields: clip_fields },
        ));
        let mut entry_fields = IndexMap::new();
        entry_fields.insert(
            fnv1a("mClipDataMap"),
            BinValue::Map {
                key: BinType::Hash,
                value: BinType::Pointer,
                entries: clip_map,
            },
        );
        let bin = Bin {
            entries: vec![BinEntry {
                path_hash: 1,
                class_hash: fnv1a("AnimationGraphData"),
                fields: entry_fields,
            }],
            ..Bin::new()
        };

        let events = parse_clip_visibility_events(&bin);
        let clip = events.get("Idle1_Slayer").expect("clip present by anm stem");
        assert_eq!(clip.len(), 2);
        // Sorted by frame: 14 before 34.
        assert_eq!(clip[0].start_frame, 14.0);
        assert_eq!(clip[0].hide_hashes, vec![0xBBBB]);
        assert_eq!(clip[0].show_hashes, vec![0xCCCC]);
        assert_eq!(clip[1].start_frame, 34.0);
        // The 0 sentinel is dropped.
        assert_eq!(clip[1].hide_hashes, vec![0xAAAA]);
        assert!(clip[1].show_hashes.is_empty());
    }

    fn gear_entry(path_hash: u32, hide: &[u32], show: &[u32]) -> BinEntry {
        // GearSkinUpgrade { mGearData: pointer = GearData { mCharacterSubmeshesToHide, ... } }
        let mut gear_data = IndexMap::new();
        gear_data.insert(F_CHAR_SUBMESHES_HIDE, hash_list(hide));
        gear_data.insert(F_CHAR_SUBMESHES_SHOW, hash_list(show));
        let mut fields = IndexMap::new();
        fields.insert(
            fnv1a("mGearData"),
            BinValue::Pointer { class: fnv1a("GearData"), fields: gear_data },
        );
        BinEntry { path_hash, class_hash: CLASS_GEAR_SKIN_UPGRADE, fields }
    }

    /// SkinCharacterDataProperties { skinUpgradeData: embed { mGearSkinUpgrades: links } }
    fn skin_char_entry(links: &[u32]) -> BinEntry {
        let mut upgrade = IndexMap::new();
        upgrade.insert(
            F_GEAR_SKIN_UPGRADES,
            BinValue::List {
                is_list2: false,
                item: BinType::Link,
                items: links.iter().map(|h| BinValue::Link(*h)).collect(),
            },
        );
        let mut char_fields = IndexMap::new();
        char_fields.insert(
            fnv1a("skinUpgradeData"),
            BinValue::Embed { class: fnv1a("skinUpgradeData"), fields: upgrade },
        );
        BinEntry { path_hash: 100, class_hash: CLASS_SKIN_CHAR, fields: char_fields }
    }

    #[test]
    fn parses_gear_forms_in_link_order_with_unlinked_appended() {
        let bin = Bin {
            entries: vec![
                // The link list says gear 2 comes first, against file order 1, 2, 3.
                skin_char_entry(&[2, 1]),
                gear_entry(1, &[0xA1], &[0xA2]),
                gear_entry(2, &[0xB1], &[0xB2]),
                // Unlinked gear (repathed mod): still picked up, after the linked ones.
                gear_entry(3, &[0xC1], &[]),
                // VFX-only gear (no submesh lists): dropped.
                gear_entry(4, &[], &[]),
            ],
            ..Bin::new()
        };

        let forms = parse_skin_forms(&bin, Vec::new);
        assert_eq!(forms.len(), 3);
        assert_eq!(forms[0].hide_hashes, vec![0xB1]);
        assert_eq!(forms[0].show_hashes, vec![0xB2]);
        assert_eq!(forms[1].hide_hashes, vec![0xA1]);
        assert_eq!(forms[2].hide_hashes, vec![0xC1]);
        assert_eq!(forms[0].name, "Form 1");
        assert_eq!(forms[2].name, "Form 3");
    }

    #[test]
    fn skin_without_gears_has_no_forms() {
        let bin = Bin {
            entries: vec![BinEntry {
                path_hash: 1,
                class_hash: CLASS_SKIN_CHAR,
                fields: IndexMap::new(),
            }],
            ..Bin::new()
        };
        assert!(parse_skin_forms(&bin, Vec::new).is_empty());
    }

    #[test]
    fn gears_hoisted_into_linked_bins_still_resolve() {
        // Riot's build moves entries shared between skins into `<Champ>_Skins_*.bin`, leaving
        // the skin BIN with links and no gear entries of its own.
        let skin = Bin {
            entries: vec![skin_char_entry(&[2, 1])],
            ..Bin::new()
        };
        let shared = Bin {
            entries: vec![gear_entry(1, &[0xA1], &[0xA2]), gear_entry(2, &[0xB1], &[0xB2])],
            ..Bin::new()
        };

        let forms = parse_skin_forms(&skin, || vec![shared]);
        assert_eq!(forms.len(), 2);
        // Link order still wins over the linked BIN's file order.
        assert_eq!(forms[0].hide_hashes, vec![0xB1]);
        assert_eq!(forms[0].show_hashes, vec![0xB2]);
        assert_eq!(forms[1].hide_hashes, vec![0xA1]);
    }

    #[test]
    fn gears_split_across_skin_and_linked_bins_both_resolve() {
        let skin = Bin {
            entries: vec![skin_char_entry(&[1, 2]), gear_entry(1, &[0xA1], &[])],
            ..Bin::new()
        };
        let shared = Bin { entries: vec![gear_entry(2, &[0xB1], &[])], ..Bin::new() };

        let forms = parse_skin_forms(&skin, || vec![shared]);
        assert_eq!(forms.len(), 2);
        assert_eq!(forms[0].hide_hashes, vec![0xA1]);
        assert_eq!(forms[1].hide_hashes, vec![0xB1]);
    }

    #[test]
    fn unlinked_gears_in_a_linked_bin_are_not_adopted() {
        // A shared BIN also holds OTHER skins' gears — only this skin's link list may pull
        // from it, or the preview would offer forms this skin doesn't have.
        let skin = Bin { entries: vec![skin_char_entry(&[1])], ..Bin::new() };
        let shared = Bin {
            entries: vec![
                gear_entry(1, &[0xA1], &[]),
                // Another skin's gear, sharing the same deduplicated BIN.
                gear_entry(99, &[0xFF], &[]),
            ],
            ..Bin::new()
        };

        let forms = parse_skin_forms(&skin, || vec![shared]);
        assert_eq!(forms.len(), 1);
        assert_eq!(forms[0].hide_hashes, vec![0xA1]);
    }

    #[test]
    fn linked_bins_are_not_loaded_when_every_gear_resolves_locally() {
        // Reading a champion's linked BINs costs real I/O (a skin can link 17 of them), so the
        // common case must not pay for it.
        let bin = Bin {
            entries: vec![skin_char_entry(&[1]), gear_entry(1, &[0xA1], &[])],
            ..Bin::new()
        };

        let mut loaded = false;
        let forms = parse_skin_forms(&bin, || {
            loaded = true;
            Vec::new()
        });
        assert!(!loaded, "linked BINs were read even though the gear was in the skin BIN");
        assert_eq!(forms.len(), 1);
    }

    // ── Gear form editing ────────────────────────────────────────────────────

    #[test]
    fn local_gear_path_hash_matches_parse_skin_forms_numbering() {
        let bin = Bin {
            entries: vec![
                skin_char_entry(&[2, 1]),
                gear_entry(1, &[0xA1], &[0xA2]),
                gear_entry(2, &[0xB1], &[0xB2]),
            ],
            ..Bin::new()
        };
        // parse_skin_forms orders by the link list: gear 2 first (form 0), gear 1 second (form 1).
        let forms = parse_skin_forms(&bin, Vec::new);
        assert_eq!(forms[0].hide_hashes, vec![0xB1]);

        let hash0 = local_gear_path_hash_for_form_index(&bin, Vec::new, 0).unwrap();
        assert_eq!(hash0, 2, "form 0 must resolve to gear path_hash 2, matching parse_skin_forms order");
        let hash1 = local_gear_path_hash_for_form_index(&bin, Vec::new, 1).unwrap();
        assert_eq!(hash1, 1);

        assert!(local_gear_path_hash_for_form_index(&bin, Vec::new, 2).is_err());
    }

    #[test]
    fn local_gear_path_hash_refuses_a_hoisted_gear() {
        let skin = Bin { entries: vec![skin_char_entry(&[1])], ..Bin::new() };
        let shared = Bin { entries: vec![gear_entry(1, &[0xA1], &[])], ..Bin::new() };

        let err = local_gear_path_hash_for_form_index(&skin, || vec![shared], 0)
            .expect_err("a hoisted gear must not be reported as locally editable");
        assert!(err.to_lowercase().contains("shared"), "error explains why: {err}");
    }

    #[test]
    fn apply_submesh_visibility_moves_between_hide_and_show() {
        let mut bin = Bin {
            entries: vec![gear_entry(1, &[], &[])],
            ..Bin::new()
        };
        let hash = fnv1a("newsubmesh");

        apply_submesh_visibility_to_gear(&mut bin, 1, "NewSubmesh", "hide").unwrap();
        let gear = bin.entries.iter().find(|e| e.path_hash == 1).unwrap();
        let gear_data = match gear.fields.get(&fnv1a("mGearData")) {
            Some(BinValue::Pointer { fields, .. }) => fields,
            _ => panic!("mGearData missing"),
        };
        assert_eq!(hash_list_items(gear_data.get(&F_CHAR_SUBMESHES_HIDE).unwrap()), vec![hash]);
        assert!(hash_list_items(gear_data.get(&F_CHAR_SUBMESHES_SHOW).unwrap()).is_empty());

        // Moving to "show" must remove it from "hide" too — a submesh cannot be
        // in both lists at once.
        apply_submesh_visibility_to_gear(&mut bin, 1, "NewSubmesh", "show").unwrap();
        let gear = bin.entries.iter().find(|e| e.path_hash == 1).unwrap();
        let gear_data = match gear.fields.get(&fnv1a("mGearData")) {
            Some(BinValue::Pointer { fields, .. }) => fields,
            _ => panic!("mGearData missing"),
        };
        assert!(hash_list_items(gear_data.get(&F_CHAR_SUBMESHES_HIDE).unwrap()).is_empty());
        assert_eq!(hash_list_items(gear_data.get(&F_CHAR_SUBMESHES_SHOW).unwrap()), vec![hash]);

        apply_submesh_visibility_to_gear(&mut bin, 1, "NewSubmesh", "clear").unwrap();
        let gear = bin.entries.iter().find(|e| e.path_hash == 1).unwrap();
        let gear_data = match gear.fields.get(&fnv1a("mGearData")) {
            Some(BinValue::Pointer { fields, .. }) => fields,
            _ => panic!("mGearData missing"),
        };
        assert!(hash_list_items(gear_data.get(&F_CHAR_SUBMESHES_HIDE).unwrap()).is_empty());
        assert!(hash_list_items(gear_data.get(&F_CHAR_SUBMESHES_SHOW).unwrap()).is_empty());
    }

    #[test]
    fn apply_submesh_visibility_rejects_an_unknown_mode() {
        let mut bin = Bin { entries: vec![gear_entry(1, &[], &[])], ..Bin::new() };
        let err = apply_submesh_visibility_to_gear(&mut bin, 1, "X", "toggle")
            .expect_err("unrecognized mode must be rejected");
        assert!(err.contains("toggle"));
    }

    #[test]
    fn set_form_submesh_visibility_end_to_end() {
        let mut bin = Bin {
            entries: vec![skin_char_entry(&[1]), gear_entry(1, &[0xA1], &[])],
            ..Bin::new()
        };
        set_form_submesh_visibility(&mut bin, Vec::new, 0, "Extra", "hide").unwrap();
        let gear = bin.entries.iter().find(|e| e.path_hash == 1).unwrap();
        let gear_data = match gear.fields.get(&fnv1a("mGearData")) {
            Some(BinValue::Pointer { fields, .. }) => fields,
            _ => panic!("mGearData missing"),
        };
        let hide = hash_list_items(gear_data.get(&F_CHAR_SUBMESHES_HIDE).unwrap());
        assert!(hide.contains(&0xA1));
        assert!(hide.contains(&fnv1a("extra")));
    }

    #[test]
    fn clip_without_events_is_absent() {
        // A clip with an anm path but no mEventDataMap yields no entry.
        let mut anim_res = IndexMap::new();
        anim_res.insert(F_ANIMATION_FILE_PATH, BinValue::String("X/Run.anm".to_string()));
        let mut clip_fields = IndexMap::new();
        clip_fields.insert(
            fnv1a("mAnimationResourceData"),
            BinValue::Embed { class: 0, fields: anim_res },
        );
        let mut entry_fields = IndexMap::new();
        entry_fields.insert(fnv1a("clip"), BinValue::Embed { class: 0, fields: clip_fields });
        let bin = Bin {
            entries: vec![BinEntry { path_hash: 1, class_hash: 0, fields: entry_fields }],
            ..Bin::new()
        };
        assert!(parse_clip_visibility_events(&bin).is_empty());
    }
}
