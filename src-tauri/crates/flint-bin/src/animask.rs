//! Read and write `mMaskDataMap` — per-joint animation blend weights.
//!
//! ```text
//! AnimationGraphData (0xf5fb07c7)
//!   └─ mMaskDataMap (0xde04746e) : map[hash -> MaskData]
//!        └─ MaskData (0x2b3c2139)
//!             ├─ mId          (0xc38f3be5) : u32
//!             └─ mWeightList  (0xa3c80380) : list[f32]
//! ```
//!
//! `mWeightList` is positional: entry `i` is joint `i` in SKL order.

use ritoshark::bin::{Bin, BinValue};

/// `FNV1a("animationgraphdata")`.
pub const ANIMATION_GRAPH_DATA_CLASS: u32 = 0xf5fb_07c7;
/// `FNV1a("maskdata")`.
pub const MASKDATA_CLASS: u32 = 0x2b3c_2139;
/// `FNV1a("mmaskdatamap")`.
pub const MMASKDATAMAP: u32 = 0xde04_746e;
/// `FNV1a("mweightlist")`.
pub const MWEIGHTLIST: u32 = 0xa3c8_0380;
/// `FNV1a("mid")`.
pub const MID: u32 = 0xc38f_3be5;

/// One mask: its map key, its optional `mId`, and its per-joint weights.
#[derive(Debug, Clone, PartialEq)]
pub struct MaskEntry {
    /// The `mMaskDataMap` key. Masks are keyed by hash; the readable name
    /// exists only in the global BIN hash database, not in the file.
    pub key: u32,
    pub id: Option<u32>,
    /// Blend weight per joint, in SKL joint order.
    pub weights: Vec<f32>,
}

/// Find the `mMaskDataMap` entries in `bin`, if it is an animation graph.
fn mask_map(bin: &Bin) -> Option<&Vec<(BinValue, BinValue)>> {
    let graph = bin
        .entries
        .iter()
        .find(|e| e.class_hash == ANIMATION_GRAPH_DATA_CLASS)?;
    match graph.fields.get(&MMASKDATAMAP)? {
        BinValue::Map { entries, .. } => Some(entries),
        _ => None,
    }
}

fn mask_map_mut(bin: &mut Bin) -> Option<&mut Vec<(BinValue, BinValue)>> {
    let graph = bin
        .entries
        .iter_mut()
        .find(|e| e.class_hash == ANIMATION_GRAPH_DATA_CLASS)?;
    match graph.fields.get_mut(&MMASKDATAMAP)? {
        BinValue::Map { entries, .. } => Some(entries),
        _ => None,
    }
}

fn key_of(value: &BinValue) -> Option<u32> {
    match value {
        BinValue::Hash(h) | BinValue::U32(h) | BinValue::Link(h) => Some(*h),
        _ => None,
    }
}

/// Read every mask in `bin`. Returns empty for a BIN with no mask map — that
/// is the normal case for any BIN that is not an animation graph, not an error.
pub fn read_masks(bin: &Bin) -> Vec<MaskEntry> {
    let Some(entries) = mask_map(bin) else {
        return Vec::new();
    };

    entries
        .iter()
        .filter_map(|(k, v)| {
            let key = key_of(k)?;
            let (BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. }) = v else {
                return None;
            };
            let weights = match fields.get(&MWEIGHTLIST) {
                Some(BinValue::List { items, .. }) => items
                    .iter()
                    .map(|i| match i {
                        BinValue::F32(f) => *f,
                        _ => 0.0,
                    })
                    .collect(),
                _ => Vec::new(),
            };
            let id = match fields.get(&MID) {
                Some(BinValue::U32(v)) => Some(*v),
                Some(BinValue::Hash(v)) => Some(*v),
                _ => None,
            };
            Some(MaskEntry { key, id, weights })
        })
        .collect()
}

/// Overwrite the named masks' weights, leaving every other mask alone.
///
/// All-or-nothing: every mask is validated before any is mutated, so an error
/// leaves `bin` untouched. An unknown mask key is an error, not a no-op.
pub fn write_masks(bin: &mut Bin, masks: &[MaskEntry]) -> Result<usize, String> {
    let Some(entries) = mask_map_mut(bin) else {
        return Err("This BIN has no mMaskDataMap (not an animation graph).".to_string());
    };

    // ── Validate pass: resolve every target to an index, mutating nothing. ──
    let mut targets = Vec::with_capacity(masks.len());
    for mask in masks {
        let idx = entries
            .iter()
            .position(|(k, _)| key_of(k) == Some(mask.key))
            .ok_or_else(|| format!("Mask {} is not present in this BIN.", mask.key))?;

        let (BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. }) = &entries[idx].1
        else {
            return Err(format!("Mask {} is not an embedded MaskData.", mask.key));
        };
        if !matches!(fields.get(&MWEIGHTLIST), Some(BinValue::List { .. })) {
            return Err(format!("Mask {} has no mWeightList.", mask.key));
        }
        targets.push(idx);
    }

    // ── Apply pass: every target is known good, so this cannot fail. ──
    for (mask, idx) in masks.iter().zip(targets) {
        let (BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. }) =
            &mut entries[idx].1
        else {
            unreachable!("validated above")
        };
        if let Some(BinValue::List { items, .. }) = fields.get_mut(&MWEIGHTLIST) {
            *items = mask.weights.iter().map(|w| BinValue::F32(*w)).collect();
        }
    }

    Ok(masks.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;
    use ritoshark::bin::{BinEntry, BinType};

    /// Build an animation BIN holding one `mMaskDataMap` with the given masks.
    fn animation_bin(masks: &[(u32, Vec<f32>)]) -> Bin {
        let entries: Vec<(BinValue, BinValue)> = masks
            .iter()
            .map(|(key, weights)| {
                let mut fields = IndexMap::new();
                fields.insert(
                    MWEIGHTLIST,
                    BinValue::List {
                        is_list2: false,
                        item: BinType::F32,
                        items: weights.iter().map(|w| BinValue::F32(*w)).collect(),
                    },
                );
                (
                    BinValue::Hash(*key),
                    BinValue::Embed { class: MASKDATA_CLASS, fields },
                )
            })
            .collect();

        let mut graph = IndexMap::new();
        graph.insert(
            MMASKDATAMAP,
            BinValue::Map { key: BinType::Hash, value: BinType::Embed, entries },
        );

        let mut bin = Bin::new();
        bin.entries.push(BinEntry {
            path_hash: 0xdead_beef,
            class_hash: ANIMATION_GRAPH_DATA_CLASS,
            fields: graph,
        });
        bin
    }

    #[test]
    fn reads_every_mask_with_its_weights() {
        let bin = animation_bin(&[(1, vec![1.0, 0.0, 0.5]), (2, vec![0.25])]);

        let masks = read_masks(&bin);

        assert_eq!(masks.len(), 2);
        assert_eq!(masks[0].key, 1);
        assert_eq!(masks[0].weights, vec![1.0, 0.0, 0.5]);
        assert_eq!(masks[1].key, 2);
        assert_eq!(masks[1].weights, vec![0.25]);
    }

    #[test]
    fn a_bin_with_no_mask_map_reads_as_empty() {
        // A skin BIN, a VFX BIN — anything that is not an animation graph.
        let bin = Bin::new();
        assert!(read_masks(&bin).is_empty());
    }

    #[test]
    fn write_then_read_round_trips_the_weights() {
        let mut bin = animation_bin(&[(1, vec![1.0, 1.0, 1.0])]);

        let edited = vec![MaskEntry { key: 1, id: None, weights: vec![0.0, 0.5, 1.0] }];
        let written = write_masks(&mut bin, &edited).unwrap();

        assert_eq!(written, 1);
        assert_eq!(read_masks(&bin)[0].weights, vec![0.0, 0.5, 1.0]);
    }

    #[test]
    fn writing_a_mask_that_is_not_in_the_bin_is_reported_not_silently_dropped() {
        let mut bin = animation_bin(&[(1, vec![1.0])]);

        let err = write_masks(
            &mut bin,
            &[MaskEntry { key: 999, id: None, weights: vec![0.0] }],
        )
        .unwrap_err();

        assert!(err.contains("999"), "error should name the missing mask: {}", err);
    }

    #[test]
    fn writing_preserves_masks_the_caller_did_not_touch() {
        let mut bin = animation_bin(&[(1, vec![1.0]), (2, vec![0.5])]);

        write_masks(&mut bin, &[MaskEntry { key: 1, id: None, weights: vec![0.0] }]).unwrap();

        let masks = read_masks(&bin);
        assert_eq!(masks[0].weights, vec![0.0]);
        assert_eq!(masks[1].weights, vec![0.5], "untouched mask was modified");
    }

    #[test]
    fn a_failed_batch_write_leaves_the_bin_untouched() {
        // The valid mask comes FIRST, so a mutate-as-you-go implementation
        // would have already overwritten it by the time it reaches the bad key
        // — returning an error that reads like nothing happened.
        let mut bin = animation_bin(&[(1, vec![1.0])]);

        let err = write_masks(
            &mut bin,
            &[
                MaskEntry { key: 1, id: None, weights: vec![0.0] },
                MaskEntry { key: 999, id: None, weights: vec![0.0] },
            ],
        )
        .unwrap_err();

        assert!(err.contains("999"));
        assert_eq!(
            read_masks(&bin)[0].weights,
            vec![1.0],
            "a failed batch must not partially apply"
        );
    }

    #[test]
    fn reads_the_mask_id_when_present() {
        let mut bin = animation_bin(&[(1, vec![1.0])]);
        // Inject mId into the first mask's MaskData.
        if let Some(BinValue::Map { entries, .. }) = bin.entries[0].fields.get_mut(&MMASKDATAMAP) {
            if let BinValue::Embed { fields, .. } = &mut entries[0].1 {
                fields.insert(MID, BinValue::U32(7));
            }
        }

        assert_eq!(read_masks(&bin)[0].id, Some(7));
    }
}
