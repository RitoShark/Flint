//! BIN container codec: binary read/write, the ritobin text form, JSON,
//! and the split/concat passes built on top of them.

pub mod animask;
pub mod audit;
pub mod bin_json;
pub mod checks;
pub mod codec;
pub mod concat;
pub mod names;
pub mod converter;
pub mod paint;
pub mod preloads;
pub mod split;
pub mod texture_header;

pub use codec::{
    apply_names, custom_file_names_from_text, custom_hash_names_from_text, embed_names,
    embedded_names, name_lookup, read_bin, remember_custom_hash_names, text_to_tree,
    tree_to_text_cached, unhash_text_cached, write_bin, MAX_BIN_SIZE,
};
pub use ritoshark::bin::{Bin, BinEntry, BinType, BinValue};

/// The `ritobinmap` record: the names a bin is its own dictionary for, kept as a
/// normal entry. Owned by the library so every tool reads the same layout, with
/// `Trailer` left as the flattened lookup and the reader for the legacy footer.
pub use ritoshark::bin::{read_path_map, read_trailer, write_path_map, PathMap, Trailer};

/// `mBlendDataTable`'s `u64` keys pack two FNV1a clip hashes; the library owns
/// that layout, re-exported here so callers reach it alongside the value model.
pub use ritoshark::bin::{is_blend_key_field, BlendKey, BLEND_DATA_TABLE};

/// Hash dictionary the text form resolves names through. Owned by the hash
/// crate, re-exported here so callers reach it alongside the codec that uses it.
pub use flint_hash::hash::bin_dict::{get_cached_bin_hashes, reload_bin_hash_cache};

pub use converter::{bin_to_json, bin_to_text, json_to_bin, text_to_bin};
pub use concat::{classify_bin, concat_linked_bins_with, update_main_bin_links, BinCategory};
pub use split::{
    analyze_multi, classify_vfx_objects, group_by_class, organize_vfx_in_folder, split_bin,
    split_bin_multi, MultiAnalysis, MultiSourceInfo, OrganizeResult, SplitResult, VFX_CLASS_NAMES,
};
pub use animask::{read_masks, write_masks, MaskEntry};
pub use audit::{audit_wad_folder, AuditReport, BloatFile};
pub use checks::{check_animation_graph, check_texture, CheckIssue, MigrationTally, Severity};
pub use names::{
    apply_mod_root_names, apply_own_names, forget_mod_root, is_hash_hex, mod_root, name_table,
    render_bin_text,
};
pub use texture_header::{read_texture_header, TextureContainer, TextureHeader};
pub use preloads::extra_character_preloads;
pub use paint::has_vfx_content;
