//! Paint — native in-memory VFX bin editing.
//!
//! A `.bin` is parsed once into a resident `ritoshark::bin::Bin` tree held in
//! [`session`]'s registry. The tree is the single source of truth: [`model`]
//! projects it into the VFX view the Paint panel consumes (systems → emitters →
//! colors, plus static materials), and [`recolor`] mutates color/blend nodes in
//! place. Saving serializes the tree straight back to the file — no
//! `.bin → text → .bin` round-trip.
//!
//! Ported from Quartz's paint engine, reduced to a single resident bin (Flint's
//! editor operates on one file, so there is no linked-bin resolution here).

pub mod model;
pub mod recolor;
pub mod session;
pub mod undo;

/// FNV-1a 32-bit over the lowercased input — the BIN hash convention for both
/// class names and field names.
pub(crate) fn fnv1a_lower(s: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in s.to_lowercase().bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// Does this tree hold anything the Paint panel can edit? Cheap: a scan of
/// top-level entry class hashes, no projection. Backs the editor's toggle
/// visibility probe.
pub fn has_vfx_content(bin: &ritoshark::bin::Bin) -> bool {
    let vfx = fnv1a_lower("VfxSystemDefinitionData");
    let material = fnv1a_lower("StaticMaterialDef");
    bin.entries
        .iter()
        .any(|e| e.class_hash == vfx || e.class_hash == material)
}
