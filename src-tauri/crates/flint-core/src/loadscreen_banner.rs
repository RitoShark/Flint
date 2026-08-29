//! Animated Loadscreen Banner — preset injection engine.
//!
//! Turns a skin's static loadscreen image into an animated VFX banner by
//! injecting a `StaticMaterialDef` (the "UI BaseShader" animated-banner material)
//! into the project's main skin BIN and linking it to the loadscreen via the
//! `SkinCharacterDataProperties` field `0xeda7817e`.
//!
//! The painted **blue channel** of an accompanying mask `.tex` drives the
//! secondary-VFX mask (`UI_SECONDARY_B_MASK` family) — where blue > 0, the VFX
//! shows.
//!
//! The material entry is built directly as a `BinEntry` tree (mirroring the
//! existing `inject_animation_block` pattern in `commands/project/project.rs`),
//! which avoids fragile ritobin text round-tripping and makes the tunable
//! slider params trivial to set as `BinValue::Vec4`.

use indexmap::IndexMap;
use ritoshark::bin::{Bin, BinEntry, BinValue};

/// FNV-1a 32-bit hash of the **lowercased** input. This is the hashing League
/// BIN files use for class names, field names, and object-path link targets.
pub fn fnv1a_32(s: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in s.to_lowercase().bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// The `SkinCharacterDataProperties` field that points the loadscreen at a
/// material override. Not present in Flint's hash dictionary, so we use the
/// literal hash (matches the user's reference BIN).
pub const LOADSCREEN_MATERIAL_FIELD: u32 = 0xeda7_817e;

/// Build a `(field_hash, value)` pair from a field name. rs_bin stores fields as
/// `IndexMap<u32, BinValue>` keyed by FNV1a-32 of the lowercased field name.
fn prop(name: &str, value: BinValue) -> (u32, BinValue) {
    (fnv1a_32(name), value)
}

/// The handful of shader params exposed as sliders in the editor. Everything
/// else in the preset is fixed. `Default` reproduces the reference banner.
#[derive(Debug, Clone, Copy)]
pub struct BannerParams {
    /// `Shine_Strength.x` — intensity of the moving shine highlight (0..~0.2).
    pub shine_strength: f32,
    /// `Shine_FrequencySpeed` — `{ x: frequency, y: speed }` of the shine sweep.
    pub shine_frequency: f32,
    pub shine_speed: f32,
    /// `UI_Secondary_R_ScrollSpeed` — `{ x, y }` scroll of the secondary VFX.
    pub scroll_speed_x: f32,
    pub scroll_speed_y: f32,
    /// `TintColor` — overall RGB tint (0..1 each), alpha fixed at 1.
    pub tint: [f32; 3],
    /// `GlowPulseFrequency.x` — pulse rate of the glow.
    pub glow_pulse: f32,
}

impl Default for BannerParams {
    fn default() -> Self {
        Self {
            shine_strength: 0.02,
            shine_frequency: 10.0,
            shine_speed: 8.0,
            scroll_speed_x: 0.5,
            scroll_speed_y: -0.25,
            tint: [1.0, 1.0, 1.0],
            glow_pulse: 2.0,
        }
    }
}

/// One `StaticMaterialShaderParamDef { name, value }` embed.
fn param(name: &str, value: [f32; 4]) -> BinValue {
    BinValue::Embed {
        class: fnv1a_32("StaticMaterialShaderParamDef"),
        fields: vec![
            prop("name", BinValue::String(name.to_string())),
            prop("value", BinValue::Vec4(value)),
        ]
        .into_iter()
        .collect(),
    }
}

/// A `StaticMaterialShaderParamDef` with no `value` (engine default of zeros).
fn param_default(name: &str) -> BinValue {
    BinValue::Embed {
        class: fnv1a_32("StaticMaterialShaderParamDef"),
        fields: vec![prop("name", BinValue::String(name.to_string()))]
            .into_iter()
            .collect(),
    }
}

fn switch_off(name: &str) -> BinValue {
    BinValue::Embed {
        class: fnv1a_32("StaticMaterialSwitchDef"),
        fields: vec![
            prop("name", BinValue::String(name.to_string())),
            prop("on", BinValue::Bool(false)),
        ]
        .into_iter()
        .collect(),
    }
}

// `on` defaults to TRUE: an enabled switch OMITS the field. Writing `on = true` is wrong.
fn switch_on(name: &str) -> BinValue {
    BinValue::Embed {
        class: fnv1a_32("StaticMaterialSwitchDef"),
        fields: vec![prop("name", BinValue::String(name.to_string()))]
            .into_iter()
            .collect(),
    }
}

/// The single sampler entry — points at the painted mask `.tex`.
///
/// LANDMINE: `texturePath` is `file` (xxh64 of the path), NOT `string`. Riot
/// retyped the asset-reference fields; a string here is a texture the current
/// client silently never loads.
fn sampler(mask_asset_path: &str) -> BinValue {
    BinValue::Embed {
        class: fnv1a_32("StaticMaterialShaderSamplerDef"),
        fields: vec![
            prop("TextureName", BinValue::String("UI_Secondary_Texture".to_string())),
            prop(
                "texturePath",
                BinValue::File(ritoshark::hash::xxh64(mask_asset_path)),
            ),
            prop("addressW", BinValue::U32(1)),
        ]
        .into_iter()
        .collect(),
    }
}

/// Build the full `paramValues` list, applying the tunable `BannerParams`.
fn param_values(p: &BannerParams) -> Vec<BinValue> {
    vec![
        param_default("UI_ShapeMaskColor_SliceUV_Offset"),
        param("UI_ShapeMaskColor_Tile", [1.0, 1.0, 0.0, 0.0]),
        param("UI_ShapeMaskColor_SliceUV", [1.0, 1.0, 0.0, 0.0]),
        param("UI_ShapeMaskColor_SmoothMinMax", [1.0, 0.1, 0.0, 0.0]),
        param("UI_ShapeMaskColor_Sides_Rotation", [16.0, 0.0, 0.0, 0.0]),
        param("UI_ShapeMask_Tile", [1.0, 1.0, 0.0, 0.0]),
        param("UI_ShapeMask_Sides_Rotation", [16.0, 0.0, 0.0, 0.0]),
        param("UI_ShapeMask_Color", [1.0, 1.0, 1.0, 1.0]),
        param_default("UI_ShapeMask_SliceUV_Offset"),
        param("UI_ShapeMask_SliceUV", [1.0, 1.0, 0.0, 0.0]),
        param("UI_ShapeMask_SmoothMinMax", [1.0, 0.1, 0.0, 0.0]),
        param_default("UI_Secondary_G_RotationAngle"),
        param_default("UI_Secondary_B_RotationAngle"),
        param_default("UI_Primary_RotationAngle"),
        param_default("UI_Secondary_R_RotationAngle"),
        param("UI_Primary_UVRotation_Offset", [0.5, 0.5, 0.0, 0.0]),
        param("UI_Primary_UVRorationSpeed", [1.0, 0.0, 0.0, 0.0]),
        param_default("Flipbook_Frame"),
        param("UI_Primary_Tile", [1.0, 1.0, 0.0, 0.0]),
        param("Flibook_TileSize", [1.0, 1.0, 0.0, 0.0]),
        param_default("Flipbook_Speed"),
        param("UI_Secondary_DistortionControl", [0.05, 0.005, 0.0, 0.0]),
        param_default("UI_Secondary_R_UVRorationSpeed"),
        param("UI_Secondary_R_Tint", [1.0, 0.0, 0.0, 1.0]),
        param("UI_Secondary_UVRotation_Offset", [0.5, 0.5, 0.0, 0.0]),
        param("UI_Secondary_R_Tile", [1.0, 1.0, 0.0, 0.0]),
        param(
            "UI_Secondary_R_ScrollSpeed",
            [p.scroll_speed_x, p.scroll_speed_y, 0.0, 0.0],
        ),
        param_default("UI_Secondary_G_UVRorationSpeed"),
        param_default("UI_Secondary_B_UVRorationSpeed"),
        param("UI_Secondary_G_Tint", [0.0, 1.0, 0.0, 1.0]),
        param("UI_Secondary_G_Tile", [1.0, 1.0, 0.0, 0.0]),
        param_default("UI_Secondary_G_ScrollSpeed"),
        param("UI_Secondady_B_MaskStrength", [1.0, 0.0, 0.0, 0.0]),
        param("UI_Secondary_Tex_TintColor", [1.0, 1.0, 1.0, 1.0]),
        param_default("DesaturationValue"),
        param("GlowPulseFrequency", [p.glow_pulse, 0.0, 0.0, 0.0]),
        param("TintColor", [p.tint[0], p.tint[1], p.tint[2], 1.0]),
        param("RGBGlowMinMaxValue", [0.85, 1.15, 0.0, 0.0]),
        param("AlphaGlowMinMaxValue", [1.0, 1.0, 0.0, 0.0]),
        param("UI_Secondary_B_Tile", [1.0, 1.0, 0.0, 0.0]),
        param_default("UI_Secondary_B_ScrollSpeed"),
        param("UI_Secondary_B_Mask_Tile", [1.0, 1.0, 0.0, 0.0]),
        param_default("UI_Secondary_B_Mask_ScrollSpeed"),
        param_default("UI_Secondary_B_Mask_UVRorationSpeed"),
        param(
            "Shine_FrequencySpeed",
            [p.shine_frequency, p.shine_speed, 0.0, 0.0],
        ),
        param("Shine_Direction", [0.5, -0.7, 0.0, 0.0]),
        param("Shine_Strength", [p.shine_strength, 0.0, 0.0, 0.0]),
        param("Shine_Color", [1.0, 1.0, 1.0, 1.0]),
    ]
}

fn switch_values() -> Vec<BinValue> {
    vec![
        switch_off("UI_SHAPESMASK_ALPHA_ON"),
        switch_off("UI_SHAPESMASK_COLOR_ON"),
        switch_on("UI_SECONDARY_RGB_ROTATION_ANIMATION"),
        switch_on("UI_PRIMARY_ROTATION_ANIMATION"),
        switch_off("SHINE_ADDITIVE_ON"),
        switch_off("DESATURATION_ON"),
        switch_on("GLOW_PULSE_ON"),
        switch_off("UI_SECONDARY_BLEND_ON"),
        switch_on("UI_SECONDARY_ON"),
        switch_off("UI_SECONDAY_G_DISTORTION_ON"),
        switch_off("UI_SECONDAY_R_DISTORTION_ON"),
        switch_off("UI_PRIMARY_FLIPBOOKANIM_ON"),
        switch_on("UI_SECONDARY_B_MASK_ON"),
        switch_off("UI_SECONDARY_B_MASK_ROTATION_ON"),
        switch_on("UI_SECONDARY_RGB_SCROLL_ON"),
        switch_off("UI_PRIMARY_ROTATION_ON"),
        switch_on("UI_SECONDARY_B_MASK_ON_UI_PRIMARY"),
        switch_off("UI_SECONDARY_B_MASK_SCROLL_ON"),
        switch_off("UI_SECONDARY_RGB_ROTATION_ON"),
        switch_off("UI_PRIMARY_FLIPBOOK_ON"),
        switch_on("SHINE_ON"),
        switch_on("DISTORTION_ON_PRIMARY"),
    ]
}

/// Build the `techniques` list (single "normal" technique, one pass).
fn techniques() -> Vec<BinValue> {
    let pass = BinValue::Embed {
        class: fnv1a_32("StaticMaterialPassDef"),
        fields: vec![
            prop("shader", BinValue::Link(fnv1a_32("Shaders/UI/UI_BaseShader"))),
            prop("depthEnable", BinValue::Bool(false)),
            prop("blendEnable", BinValue::Bool(true)),
            prop("cullEnable", BinValue::Bool(false)),
            prop("dstColorBlendFactor", BinValue::U32(7)),
            prop("dstAlphaBlendFactor", BinValue::U32(7)),
        ]
        .into_iter()
        .collect(),
    };

    let technique = BinValue::Embed {
        class: fnv1a_32("StaticMaterialTechniqueDef"),
        fields: vec![
            prop("name", BinValue::String("normal".to_string())),
            prop(
                "passes",
                BinValue::List {
                    is_list2: false,
                    item: ritoshark::bin::BinType::Embed,
                    items: vec![pass],
                },
            ),
        ]
        .into_iter()
        .collect(),
    };

    vec![technique]
}

/// Build the complete `StaticMaterialDef` root entry.
///
/// * `material_name` — the human material name, e.g.
///   `"Evelynn/EvelynniPort/Materials/EvelynniPort_Animated_Banner"`. Its
///   FNV1a-32 is the entry's `path_hash` and the link target on the skin entry.
/// * `mask_asset_path` — the BIN asset path of the mask `.tex`, e.g.
///   `"ASSETS/SirDexal/evelynni-port/evelynnLoadScreen-mask.tex"`.
pub fn build_material_entry(
    material_name: &str,
    mask_asset_path: &str,
    params: &BannerParams,
) -> BinEntry {
    let fields: IndexMap<u32, BinValue> = vec![
        prop("name", BinValue::String(material_name.to_string())),
        prop("type", BinValue::U32(3)),
        prop(
            "samplerValues",
            BinValue::List {
                is_list2: true,
                item: ritoshark::bin::BinType::Embed,
                items: vec![sampler(mask_asset_path)],
            },
        ),
        prop(
            "paramValues",
            BinValue::List {
                is_list2: true,
                item: ritoshark::bin::BinType::Embed,
                items: param_values(params),
            },
        ),
        prop(
            "switches",
            BinValue::List {
                is_list2: true,
                item: ritoshark::bin::BinType::Embed,
                items: switch_values(),
            },
        ),
        prop(
            "techniques",
            BinValue::List {
                is_list2: false,
                item: ritoshark::bin::BinType::Embed,
                items: techniques(),
            },
        ),
    ]
    .into_iter()
    .collect();

    BinEntry {
        path_hash: fnv1a_32(material_name),
        class_hash: fnv1a_32("StaticMaterialDef"),
        fields,
    }
}

/// Class hash of `SkinCharacterDataProperties` — the root entry that owns the
/// loadscreen and the material link.
pub fn skin_character_class_hash() -> u32 {
    fnv1a_32("SkinCharacterDataProperties")
}

/// Outcome of an apply: whether the BIN was changed and the material hash used.
#[derive(Debug, Clone, Copy)]
pub struct ApplyOutcome {
    pub material_hash: u32,
    pub changed: bool,
}

/// Result of inspecting a BIN for an already-applied banner.
#[derive(Debug, Clone)]
pub struct BannerStatus {
    pub applied: bool,
    /// The material link hash on the skin entry (if any).
    pub material_hash: Option<u32>,
    /// The mask asset path read back from the material's sampler (if any).
    pub mask_asset_path: Option<String>,
}

/// Find the index of the `SkinCharacterDataProperties` root entry in `bin`.
fn find_skin_entry_index(bin: &Bin) -> Option<usize> {
    let class = skin_character_class_hash();
    bin.entries.iter().position(|e| e.class_hash == class)
}

/// Read the `loadScreen.image` path from the skin entry, if present.
///
/// Layout: `loadScreen: embed = CensoredImage { image: file = "..." }`. Older
/// bins carry it as a `string`; a `file` is resolved back to its path through
/// the bin's own record plus the files on disk beside it.
pub fn read_loadscreen_image(bin: &Bin, bin_path: &std::path::Path) -> Option<String> {
    let idx = find_skin_entry_index(bin)?;
    let entry = &bin.entries[idx];
    let ls = entry.fields.get(&fnv1a_32("loadScreen"))?;
    let fields = match ls {
        BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. } => fields,
        _ => return None,
    };
    match fields.get(&fnv1a_32("image")) {
        Some(BinValue::String(s)) => Some(s.clone()),
        Some(BinValue::File(h)) => name_of_file(bin, bin_path, *h),
        _ => None,
    }
}

fn name_of_file(bin: &Bin, bin_path: &std::path::Path, hash: u64) -> Option<String> {
    flint_bin::name_table(bin, bin_path).files.get(&hash).cloned()
}

/// Re-file the bin's `ritobinmap` record against what the bin now references,
/// plus `extra`. The mask path is stored as an xxh64 and no dictionary anywhere
/// knows a path this tool invented, so it has to be captured here; re-filing
/// (rather than merging) is also what drops it again when the banner is removed.
fn reindex_path_map(bin: &mut Bin, extra: &[&str]) {
    let existing = ritoshark::bin::read_path_map(bin);
    let names: Vec<&str> = existing
        .bin_entries
        .iter()
        .chain(existing.bin_types.iter())
        .chain(existing.bin_fields.iter())
        .chain(existing.bin_hashes.iter())
        .chain(existing.game.iter())
        .map(String::as_str)
        .chain(extra.iter().copied())
        .collect();
    let map = ritoshark::bin::capture(bin, &names);
    ritoshark::bin::write_path_map(bin, &map);
}

/// Inspect a BIN for an already-applied banner.
pub fn banner_status(bin: &Bin, bin_path: &std::path::Path) -> BannerStatus {
    let material_hash = find_skin_entry_index(bin)
        .and_then(|idx| bin.entries[idx].fields.get(&LOADSCREEN_MATERIAL_FIELD))
        .and_then(|v| match v {
            BinValue::Link(h) => Some(*h),
            _ => None,
        });

    let mask_asset_path = material_hash.and_then(|h| {
        bin.entries
            .iter()
            .find(|e| e.path_hash == h && e.class_hash == fnv1a_32("StaticMaterialDef"))
            .and_then(|entry| read_sampler_mask_path(bin, bin_path, entry))
    });

    BannerStatus {
        applied: material_hash.is_some(),
        material_hash,
        mask_asset_path,
    }
}

/// Known `SkinCharacterDataProperties` loadscreen-variant field names, in the
/// order League declares them. The material link goes right after whichever of
/// these is LAST present, so it sits before `skinAudioProperties`.
const LOADSCREEN_FIELD_NAMES: &[&str] = &[
    "loadScreen",
    "loadScreenVintage",
    "loadScreenShade",
    "loadScreenExalted",
];

/// Index (in the entry's field order) of the LAST loadscreen-variant field that
/// is present, if any.
fn last_loadscreen_field_index(fields: &IndexMap<u32, BinValue>) -> Option<usize> {
    LOADSCREEN_FIELD_NAMES
        .iter()
        .filter_map(|name| fields.get_index_of(&fnv1a_32(name)))
        .max()
}

/// Read `samplerValues[0].texturePath` out of a `StaticMaterialDef` entry.
fn read_sampler_mask_path(
    bin: &Bin,
    bin_path: &std::path::Path,
    entry: &BinEntry,
) -> Option<String> {
    let samplers = entry.fields.get(&fnv1a_32("samplerValues"))?;
    let items = match samplers {
        BinValue::List { items, .. } => items,
        _ => return None,
    };
    for item in items {
        if let BinValue::Embed { fields, .. } = item {
            match fields.get(&fnv1a_32("texturePath")) {
                Some(BinValue::String(s)) => return Some(s.clone()),
                Some(BinValue::File(h)) => return name_of_file(bin, bin_path, *h),
                _ => {}
            }
        }
    }
    None
}

/// Apply (or re-apply) the banner to a skin BIN in place.
///
/// * Adds/updates the `0xeda7817e: link = <material_hash>` field on the
///   `SkinCharacterDataProperties` entry.
/// * Adds/replaces the `StaticMaterialDef` root entry.
///
/// Idempotent: applying twice does not duplicate the entry or the field. When
/// `params_only` is true the existing material's `paramValues` are refreshed but
/// the sampler (mask path) and everything else stay as they were if already
/// present — used for "tweak sliders without touching the mask".
///
/// Returns `Err` if there is no `SkinCharacterDataProperties` entry to attach to.
pub fn apply_banner_to_bin(
    bin: &mut Bin,
    material_name: &str,
    mask_asset_path: &str,
    params: &BannerParams,
) -> Result<ApplyOutcome, String> {
    let material_hash = fnv1a_32(material_name);

    let skin_idx = find_skin_entry_index(bin).ok_or_else(|| {
        "No SkinCharacterDataProperties entry found in the main skin BIN — cannot attach a loadscreen banner.".to_string()
    })?;

    // Link the loadscreen field right after the LAST loadscreen-variant block,
    // so it lands before skinAudioProperties.
    {
        let fields = &mut bin.entries[skin_idx].fields;
        let link = BinValue::Link(material_hash);
        if let Some(existing) = fields.get_mut(&LOADSCREEN_MATERIAL_FIELD) {
            *existing = link;
        } else if let Some(last_ls_idx) = last_loadscreen_field_index(fields) {
            fields.shift_insert(last_ls_idx + 1, LOADSCREEN_MATERIAL_FIELD, link);
        } else {
            fields.insert(LOADSCREEN_MATERIAL_FIELD, link);
        }
    }

    let new_entry = build_material_entry(material_name, mask_asset_path, params);
    if let Some(existing) = bin
        .entries
        .iter_mut()
        .find(|e| e.path_hash == material_hash && e.class_hash == new_entry.class_hash)
    {
        *existing = new_entry;
    } else {
        bin.entries.push(new_entry);
    }

    reindex_path_map(bin, &[mask_asset_path, material_name]);

    Ok(ApplyOutcome {
        material_hash,
        changed: true,
    })
}

/// Undo [`apply_banner_to_bin`] in place: drop the loadscreen material link from
/// the `SkinCharacterDataProperties` entry and remove the `StaticMaterialDef`
/// entry it pointed at.
///
/// Returns `true` when the BIN actually changed. Safe to call on a BIN that
/// never had a banner — it simply reports `false`.
pub fn remove_banner_from_bin(bin: &mut Bin) -> bool {
    let Some(skin_idx) = find_skin_entry_index(bin) else {
        return false;
    };

    // Take the link first: it names the material entry to delete.
    let material_hash = match bin.entries[skin_idx]
        .fields
        .shift_remove(&LOADSCREEN_MATERIAL_FIELD)
    {
        Some(BinValue::Link(h)) => Some(h),
        // A non-link value under that key is still ours to clear, but there is
        // no entry to chase.
        Some(_) => None,
        None => return false,
    };

    let Some(hash) = material_hash else {
        return true;
    };

    let material_class = fnv1a_32("StaticMaterialDef");
    bin.entries
        .retain(|e| !(e.path_hash == hash && e.class_hash == material_class));
    reindex_path_map(bin, &[]);
    true
}

/// Derive the mask `.tex` BIN asset path from the loadscreen image asset path:
/// insert `-mask` before the extension. `foo/bar.tex` → `foo/bar-mask.tex`.
pub fn mask_path_from_loadscreen(loadscreen_asset_path: &str) -> String {
    match loadscreen_asset_path.rfind('.') {
        Some(dot) => format!(
            "{}-mask{}",
            &loadscreen_asset_path[..dot],
            &loadscreen_asset_path[dot..]
        ),
        None => format!("{}-mask.tex", loadscreen_asset_path),
    }
}

/// Build the material name from champion + project display name:
/// `"<Champion>/<Project>/Materials/<Project>_Animated_Banner"`. Spaces are
/// stripped from the project segment so the name stays a clean identifier.
pub fn material_name(champion: &str, project: &str) -> String {
    let proj = project.replace(' ', "");
    let champ = if champion.is_empty() { "Skin" } else { champion };
    format!("{champ}/{proj}/Materials/{proj}_Animated_Banner")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a_matches_known_values() {
        assert_eq!(fnv1a_32("StaticMaterialDef"), fnv1a_32("staticmaterialdef"));
        assert_eq!(fnv1a_32("ABC"), fnv1a_32("abc"));
        assert_ne!(fnv1a_32("a"), fnv1a_32("b"));
    }

    fn switch_states(entry: &BinEntry) -> Vec<(String, Option<bool>)> {
        let Some(BinValue::List { items, .. }) = entry.fields.get(&fnv1a_32("switches")) else {
            panic!("no switches list");
        };
        items
            .iter()
            .map(|item| {
                let BinValue::Embed { fields, .. } = item else {
                    panic!("switch is not an embed");
                };
                let Some(BinValue::String(name)) = fields.get(&fnv1a_32("name")) else {
                    panic!("switch has no name");
                };
                let on = match fields.get(&fnv1a_32("on")) {
                    Some(BinValue::Bool(b)) => Some(*b),
                    None => None,
                    Some(_) => panic!("switch `on` is not a bool"),
                };
                (name.clone(), on)
            })
            .collect()
    }

    #[test]
    fn enabled_switches_omit_the_on_field() {
        let entry = build_material_entry("X/Y/Materials/Z", "ASSETS/a-mask.tex", &BannerParams::default());
        let states = switch_states(&entry);

        for (name, on) in &states {
            assert_ne!(
                *on,
                Some(true),
                "{name}: an enabled switch must OMIT `on`, never write `on = true`"
            );
        }

        let enabled: Vec<&str> = states
            .iter()
            .filter(|(_, on)| on.is_none())
            .map(|(n, _)| n.as_str())
            .collect();
        assert_eq!(
            enabled,
            vec![
                "UI_SECONDARY_RGB_ROTATION_ANIMATION",
                "UI_PRIMARY_ROTATION_ANIMATION",
                "GLOW_PULSE_ON",
                "UI_SECONDARY_ON",
                "UI_SECONDARY_B_MASK_ON",
                "UI_SECONDARY_RGB_SCROLL_ON",
                "UI_SECONDARY_B_MASK_ON_UI_PRIMARY",
                "SHINE_ON",
                "DISTORTION_ON_PRIMARY",
            ]
        );
    }

    #[test]
    fn switch_and_param_lists_match_the_riot_reference_shape() {
        let entry = build_material_entry("X/Y/Materials/Z", "ASSETS/a-mask.tex", &BannerParams::default());
        assert_eq!(switch_states(&entry).len(), 22);

        let Some(BinValue::List { items, .. }) = entry.fields.get(&fnv1a_32("paramValues")) else {
            panic!("no paramValues list");
        };
        assert_eq!(items.len(), 48);

        let first = match &items[0] {
            BinValue::Embed { fields, .. } => match fields.get(&fnv1a_32("name")) {
                Some(BinValue::String(s)) => s.clone(),
                _ => panic!("param has no name"),
            },
            _ => panic!("param is not an embed"),
        };
        assert_eq!(first, "UI_ShapeMaskColor_SliceUV_Offset");
    }

    #[test]
    fn mask_path_inserts_before_extension() {
        assert_eq!(
            mask_path_from_loadscreen("ASSETS/X/p/load.tex"),
            "ASSETS/X/p/load-mask.tex"
        );
        assert_eq!(mask_path_from_loadscreen("noext"), "noext-mask.tex");
    }

    #[test]
    fn material_name_format() {
        assert_eq!(
            material_name("Evelynn", "evelynni port"),
            "Evelynn/evelynniport/Materials/evelynniport_Animated_Banner"
        );
        assert_eq!(
            material_name("", "Proj"),
            "Skin/Proj/Materials/Proj_Animated_Banner"
        );
    }

    /// Build a minimal skin BIN with a SkinCharacterDataProperties entry that
    /// carries a loadScreen embed, then exercise apply + status + read.
    /// No mod root on disk, so every name has to come from the bin's own record.
    fn test_bin_path() -> &'static std::path::Path {
        std::path::Path::new("skin0.bin")
    }

    fn skin_bin_with_loadscreen(image: &str) -> Bin {
        let loadscreen = BinValue::Embed {
            class: fnv1a_32("CensoredImage"),
            fields: vec![prop("image", BinValue::String(image.to_string()))]
                .into_iter()
                .collect(),
        };
        let entry = BinEntry {
            path_hash: fnv1a_32("Characters/Test/Skins/Skin0"),
            class_hash: skin_character_class_hash(),
            fields: vec![
                prop("championSkinName", BinValue::String("test".to_string())),
                prop("loadScreen", loadscreen),
            ]
            .into_iter()
            .collect(),
        };
        let mut bin = Bin::new();
        bin.entries.push(entry);
        bin
    }

    #[test]
    fn read_loadscreen_image_works() {
        let bin = skin_bin_with_loadscreen("ASSETS/X/p/load.tex");
        assert_eq!(
            read_loadscreen_image(&bin, test_bin_path()).as_deref(),
            Some("ASSETS/X/p/load.tex")
        );
    }

    #[test]
    fn apply_is_idempotent_and_detectable() {
        let mut bin = skin_bin_with_loadscreen("ASSETS/X/p/load.tex");
        let name = material_name("Test", "Proj");
        let mask = mask_path_from_loadscreen("ASSETS/X/p/load.tex");
        let params = BannerParams::default();

        assert!(!banner_status(&bin, test_bin_path()).applied);

        let out1 = apply_banner_to_bin(&mut bin, &name, &mask, &params).unwrap();
        let entries_after_first = bin.entries.len();

        // Skin entry, the material entry, and the name record naming the mask.
        assert_eq!(entries_after_first, 3);
        assert!(ritoshark::bin::read_path_map(&bin).game.contains(&mask));

        let status = banner_status(&bin, test_bin_path());
        assert!(status.applied);
        assert_eq!(status.material_hash, Some(out1.material_hash));
        assert_eq!(status.mask_asset_path.as_deref(), Some(mask.as_str()));

        apply_banner_to_bin(&mut bin, &name, &mask, &params).unwrap();
        assert_eq!(bin.entries.len(), entries_after_first);

        // The link field exists exactly once on the skin entry.
        let skin = bin
            .entries
            .iter()
            .find(|e| e.class_hash == skin_character_class_hash())
            .unwrap();
        assert!(matches!(
            skin.fields.get(&LOADSCREEN_MATERIAL_FIELD),
            Some(BinValue::Link(_))
        ));

        // ...and it sits immediately AFTER the loadScreen field (not at the end).
        let ls_idx = skin.fields.get_index_of(&fnv1a_32("loadScreen")).unwrap();
        let link_idx = skin.fields.get_index_of(&LOADSCREEN_MATERIAL_FIELD).unwrap();
        assert_eq!(
            link_idx,
            ls_idx + 1,
            "material link must be inserted right after loadScreen"
        );
    }

    #[test]
    fn remove_restores_the_bin_to_its_pre_apply_state() {
        let original = skin_bin_with_loadscreen("ASSETS/X/p/load.tex");
        let mut bin = original.clone();
        let name = material_name("Test", "Proj");
        let mask = mask_path_from_loadscreen("ASSETS/X/p/load.tex");

        apply_banner_to_bin(&mut bin, &name, &mask, &BannerParams::default()).unwrap();
        assert!(banner_status(&bin, test_bin_path()).applied);
        assert_eq!(bin.entries.len(), 3);

        assert!(remove_banner_from_bin(&mut bin));

        // Cancelling has to leave the skin exactly as it was found — the
        // material entry gone, the link field gone, everything else untouched.
        assert!(!banner_status(&bin, test_bin_path()).applied);
        assert_eq!(bin.entries.len(), original.entries.len());
        let skin = bin
            .entries
            .iter()
            .find(|e| e.class_hash == skin_character_class_hash())
            .unwrap();
        let before = original
            .entries
            .iter()
            .find(|e| e.class_hash == skin_character_class_hash())
            .unwrap();
        assert!(skin.fields.get(&LOADSCREEN_MATERIAL_FIELD).is_none());
        assert_eq!(
            skin.fields.keys().collect::<Vec<_>>(),
            before.fields.keys().collect::<Vec<_>>(),
            "field order must survive an apply/remove round-trip"
        );
    }

    #[test]
    fn remove_is_a_no_op_when_no_banner_is_applied() {
        let mut bin = skin_bin_with_loadscreen("ASSETS/X/p/load.tex");
        assert!(!remove_banner_from_bin(&mut bin));
        assert_eq!(bin.entries.len(), 1);
    }

    #[test]
    fn remove_keeps_unrelated_entries() {
        let mut bin = skin_bin_with_loadscreen("ASSETS/X/p/load.tex");
        // An unrelated StaticMaterialDef must survive — only the banner's own
        // material (matched by path hash) may be dropped.
        let other = BinEntry {
            path_hash: fnv1a_32("Some/Other/Material"),
            class_hash: fnv1a_32("StaticMaterialDef"),
            fields: Default::default(),
        };
        bin.entries.push(other);

        let name = material_name("Test", "Proj");
        let mask = mask_path_from_loadscreen("ASSETS/X/p/load.tex");
        apply_banner_to_bin(&mut bin, &name, &mask, &BannerParams::default()).unwrap();
        assert_eq!(bin.entries.len(), 4);

        assert!(remove_banner_from_bin(&mut bin));
        assert_eq!(bin.entries.len(), 2);
        assert!(bin
            .entries
            .iter()
            .any(|e| e.path_hash == fnv1a_32("Some/Other/Material")));
    }

    #[test]
    fn link_lands_after_last_loadscreen_variant() {
        // A skin with loadScreen + loadScreenVintage, then skinAudioProperties.
        // The material link must go AFTER vintage (the last loadscreen variant)
        // and BEFORE skinAudioProperties.
        let censored = |img: &str| BinValue::Embed {
            class: fnv1a_32("CensoredImage"),
            fields: vec![prop("image", BinValue::String(img.to_string()))]
                .into_iter()
                .collect(),
        };
        let entry = BinEntry {
            path_hash: fnv1a_32("Characters/Test/Skins/Skin0"),
            class_hash: skin_character_class_hash(),
            fields: vec![
                prop("championSkinName", BinValue::String("test".to_string())),
                prop("loadScreen", censored("ASSETS/X/p/load.tex")),
                prop("loadScreenVintage", censored("ASSETS/X/p/load_LE.tex")),
                prop(
                    "skinAudioProperties",
                    BinValue::Embed { class: fnv1a_32("skinAudioProperties"), fields: Default::default() },
                ),
            ]
            .into_iter()
            .collect(),
        };
        let mut bin = Bin::new();
        bin.entries.push(entry);

        let name = material_name("Test", "Proj");
        let mask = mask_path_from_loadscreen("ASSETS/X/p/load.tex");
        apply_banner_to_bin(&mut bin, &name, &mask, &BannerParams::default()).unwrap();

        let skin = &bin.entries[0];
        let vintage_idx = skin.fields.get_index_of(&fnv1a_32("loadScreenVintage")).unwrap();
        let link_idx = skin.fields.get_index_of(&LOADSCREEN_MATERIAL_FIELD).unwrap();
        let audio_idx = skin.fields.get_index_of(&fnv1a_32("skinAudioProperties")).unwrap();
        assert_eq!(link_idx, vintage_idx + 1, "link must follow the LAST loadscreen variant");
        assert!(link_idx < audio_idx, "link must come before skinAudioProperties");
    }

    #[test]
    fn apply_errors_without_skin_entry() {
        let mut bin = Bin::new();
        let err = apply_banner_to_bin(
            &mut bin,
            "X/Y/Materials/Y_Animated_Banner",
            "ASSETS/X/p/load-mask.tex",
            &BannerParams::default(),
        );
        assert!(err.is_err());
    }

    #[test]
    fn material_entry_round_trips_through_bytes() {
        let mut bin = skin_bin_with_loadscreen("ASSETS/X/p/load.tex");
        let name = material_name("Test", "Proj");
        let mask = mask_path_from_loadscreen("ASSETS/X/p/load.tex");
        apply_banner_to_bin(&mut bin, &name, &mask, &BannerParams::default()).unwrap();

        let bytes = crate::bin::write_bin(&bin).expect("write");
        let reparsed = crate::bin::read_bin(&bytes).expect("read");

        let status = banner_status(&reparsed, test_bin_path());
        assert!(status.applied);
        assert_eq!(status.mask_asset_path.as_deref(), Some(mask.as_str()));
    }
}
