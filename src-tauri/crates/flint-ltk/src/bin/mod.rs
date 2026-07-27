pub mod ltk_bridge;
pub mod converter;
pub mod bin_json;
pub mod concat;
pub mod split;
pub mod animask;

pub use ltk_bridge::{
    read_bin as read_bin_ltk,
    write_bin as write_bin_ltk,
    tree_to_text_cached,
    get_cached_bin_hashes,
    reload_bin_hash_cache,
    text_to_tree,
    unhash_text_cached,
    MAX_BIN_SIZE,
};

pub use ritoshark::bin::{Bin, BinEntry, BinType, BinValue};

pub use ltk_bridge::read_bin;
pub use ltk_bridge::write_bin;

pub use converter::{bin_to_text, text_to_bin, bin_to_json, json_to_bin};

pub use concat::{classify_bin, concat_linked_bins_with, update_main_bin_links, BinCategory};

pub use split::{
    analyze_multi, classify_vfx_objects, group_by_class, organize_vfx_in_folder, split_bin,
    split_bin_multi, MultiAnalysis, MultiSourceInfo, OrganizeResult, SplitResult, VFX_CLASS_NAMES,
};

pub use animask::{read_masks, write_masks, MaskEntry};
