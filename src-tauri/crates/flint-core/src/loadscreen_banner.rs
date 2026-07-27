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

/// One `StaticMaterialSwitchDef { name, on }` embed.
fn switch(name: &str, on: bool) -> BinValue {
    BinValue::Embed {
        class: fnv1a_32("StaticMaterialSwitchDef"),
        fields: vec![
            prop("name", BinValue::String(name.to_string())),
            prop("on", BinValue::Bool(on)),
        ]
        .into_iter()
        .collect(),
    }
}

/// The single sampler entry — points at the painted mask `.tex`.
fn sampler(mask_asset_path: &str) -> BinValue {
    BinValue::Embed {
        class: fnv1a_32("StaticMaterialShaderSamplerDef"),
        fields: vec![
            prop("TextureName", BinValue::String("UI_Secondary_Texture".to_string())),
            prop("texturePath", BinValue::String(mask_asset_path.to_string())),
            prop("addressW", BinValue::U32(1)),
        ]
        .into_iter()
        .collect(),
    }
}

/// Build the full `paramValues` list, applying the tunable `BannerParams`.
fn param_values(p: &BannerParams) -> Vec<BinValue> {
    vec![
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

/// Build the `switches` list (all off by default — matches the reference).
fn switch_values() -> Vec<BinValue> {
    vec![
        switch("SHINE_ADDITIVE_ON", false),
        switch("DESATURATION_ON", false),
        switch("GLOW_PULSE_ON", false),
        switch("UI_SECONDARY_BLEND_ON", false),
        switch("UI_SECONDARY_ON", false),
        switch("UI_SECONDAY_G_DISTORTION_ON", false),
        switch("UI_SECONDAY_R_DISTORTION_ON", false),
        switch("UI_PRIMARY_FLIPBOOKANIM_ON", false),
        switch("UI_SECONDARY_B_MASK_ON", false),
        switch("UI_SECONDARY_B_MASK_ROTATION_ON", false),
        switch("UI_SECONDARY_RGB_SCROLL_ON", false),
        switch("UI_PRIMARY_ROTATION_ON", false),
        switch("UI_SECONDARY_B_MASK_ON_UI_PRIMARY", false),
        switch("UI_SECONDARY_B_MASK_SCROLL_ON", false),
        switch("UI_SECONDARY_RGB_ROTATION_ON", false),
        switch("UI_PRIMARY_FLIPBOOK_ON", false),
        switch("SHINE_ON", false),
        switch("DISTORTION_ON_PRIMARY", false),
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

/// Read the `loadScreen.image` string from the skin entry, if present.
///
/// Layout: `loadScreen: embed = CensoredImage { image: string = "..." }`.
pub fn read_loadscreen_image(bin: &Bin) -> Option<String> {
    let idx = find_skin_entry_index(bin)?;
    let entry = &bin.entries[idx];
    let ls = entry.fields.get(&fnv1a_32("loadScreen"))?;
    let fields = match ls {
        BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. } => fields,
        _ => return None,
    };
    match fields.get(&fnv1a_32("image")) {
        Some(BinValue::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// Inspect a BIN for an already-applied banner.
pub fn banner_status(bin: &Bin) -> BannerStatus {
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
            .and_then(read_sampler_mask_path)
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
fn read_sampler_mask_path(entry: &BinEntry) -> Option<String> {
    let samplers = entry.fields.get(&fnv1a_32("samplerValues"))?;
    let items = match samplers {
        BinValue::List { items, .. } => items,
        _ => return None,
    };
    for item in items {
        if let BinValue::Embed { fields, .. } = item {
            if let Some(BinValue::String(s)) = fields.get(&fnv1a_32("texturePath")) {
                return Some(s.clone());
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

    Ok(ApplyOutcome {
        material_hash,
        changed: true,
    })
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
            read_loadscreen_image(&bin).as_deref(),
            Some("ASSETS/X/p/load.tex")
        );
    }

    #[test]
    fn apply_is_idempotent_and_detectable() {
        let mut bin = skin_bin_with_loadscreen("ASSETS/X/p/load.tex");
        let name = material_name("Test", "Proj");
        let mask = mask_path_from_loadscreen("ASSETS/X/p/load.tex");
        let params = BannerParams::default();

        assert!(!banner_status(&bin).applied);

        let out1 = apply_banner_to_bin(&mut bin, &name, &mask, &params).unwrap();
        let entries_after_first = bin.entries.len();

        // Skin entry + one material entry.
        assert_eq!(entries_after_first, 2);

        let status = banner_status(&bin);
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

        let status = banner_status(&reparsed);
        assert!(status.applied);
        assert_eq!(status.mask_asset_path.as_deref(), Some(mask.as_str()));
    }
}
