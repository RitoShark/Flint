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

use ritoshark::bin::{Bin, BinValue};
use ritoshark::hash::fnv1a;
use serde::Serialize;

use crate::bin::ltk_bridge;

// Class hashes (FNV1a-32, lowercased). `fnv1a` is a const fn, so these fold at compile time.
const CLASS_SUBMESH_VIS_EVENT: u32 = fnv1a("SubmeshVisibilityEventData");
const CLASS_SKIN_CHAR: u32 = fnv1a("SkinCharacterDataProperties");

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

/// Parse a skin BIN's `initialSubmeshToHide` / `initialSubmeshShadowsToHide` from disk.
///
/// Returns an empty `InitialHidden` (never an error) if the file is unreadable, unparseable,
/// or has no `SkinCharacterDataProperties` entry — the baseline is purely additive polish.
pub fn parse_initial_hidden_file(skin_bin_path: &Path) -> InitialHidden {
    let Ok(data) = std::fs::read(skin_bin_path) else {
        return InitialHidden::default();
    };
    let Ok(tree) = ltk_bridge::read_bin(&data) else {
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
    // Search the entry's field tree for the two strings by their field hash.
    let hide = find_string_field(&entry.fields, F_INITIAL_HIDE)
        .map(|s| split_names(s, char::is_whitespace))
        .unwrap_or_default();
    let shadow_hide = find_string_field(&entry.fields, F_INITIAL_SHADOW_HIDE)
        .map(|s| split_names(s, |c| c == ','))
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
    let Ok(tree) = ltk_bridge::read_bin(&data) else {
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

/// Split a submesh-name string, trimming and dropping empties.
fn split_names(s: &str, sep: impl Fn(char) -> bool) -> Vec<String> {
    s.split(sep)
        .map(str::trim)
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
    fn initial_hide_splits_on_whitespace_shadow_on_comma() {
        let mut fields = IndexMap::new();
        fields.insert(
            F_INITIAL_HIDE,
            BinValue::String("Wings Monster_Head Sword_02".to_string()),
        );
        fields.insert(
            F_INITIAL_SHADOW_HIDE,
            BinValue::String("Sword_VFX, Cape_Shadow".to_string()),
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
        assert_eq!(hidden.hide, vec!["Wings", "Monster_Head", "Sword_02"]);
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
