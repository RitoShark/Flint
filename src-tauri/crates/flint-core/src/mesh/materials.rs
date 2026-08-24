/*!
Texture mapping read from the parsed BIN tree.

The tree is what a bin already IS: `rs_bin` parses one into typed values before anything
else happens. The older path in [`crate::mesh::texture`] then printed that tree to ritobin
text — 9.5 MB for a real skin — substituted every hash name across it, and parsed it back
with regexes. This walks the tree instead.

Two things follow from that, and the second matters more:

- The print, the substitution and the scan all disappear. Only the parse remains.
- A field's TYPE is a variant, not a token in a string. When Riot retyped asset paths from
  `string` to `file`, every `texturePath:\s*string` pattern silently stopped matching and
  skins resolved no textures at all. `BinValue::String` and `BinValue::File` are two arms of
  one match here; a retype cannot go unnoticed the same way.

Names are still needed for the leaves — a `File(u64)` has to become a path on disk, and a
material entry is found by name — but that is a lookup per value reached, not a substitution
across megabytes.
*/

use std::collections::HashMap;

use ritoshark::bin::{Bin, BinEntry, BinValue};
use ritoshark::hash::fnv1a;

use crate::bin::Trailer;
use crate::mesh::texture::{MaterialProperties, TextureMapping};

macro_rules! field {
    ($name:ident, $text:literal) => {
        const $name: u32 = fnv1a($text);
    };
}

field!(SKIN_MESH_PROPERTIES, "skinMeshProperties");
field!(TEXTURE, "texture");
field!(MATERIAL, "material");
field!(MATERIAL_OVERRIDE, "materialOverride");
field!(SUBMESH, "submesh");
field!(SAMPLER_VALUES, "samplerValues");
field!(SAMPLER_NAME, "samplerName");
field!(TEXTURE_NAME, "textureName");
field!(TEXTURE_PATH, "texturePath");
field!(PARAM_VALUES, "paramValues");
field!(NAME, "name");
field!(VALUE, "value");

const SKIN_CHARACTER_DATA_PROPERTIES: u32 = fnv1a("SkinCharacterDataProperties");
const STATIC_MATERIAL_DEF: u32 = fnv1a("StaticMaterialDef");

/// Substrings that mark a texture as a support map rather than the surface's colour.
const NON_DIFFUSE: &[&str] = &[
    "normal", "_nm", "mask", "noise", "ramp", "matcap", "outline", "fresnel",
];

/// Every entry the mesh can reach, addressable the way a BIN addresses them.
pub struct BinIndex<'a> {
    by_hash: HashMap<u32, &'a BinEntry>,
    /// Entry path hash → its readable name, where one is known.
    entry_names: HashMap<u32, String>,
    names: Trailer,
}

impl<'a> BinIndex<'a> {
    /// `bins` is every bin the mesh reaches — its skin bin, the concat, the linked ones —
    /// each with the name table its own location supplies.
    pub fn new(bins: impl IntoIterator<Item = (&'a Bin, Trailer)>) -> Self {
        let mut by_hash = HashMap::new();
        let mut names = Trailer::new();

        for (bin, table) in bins {
            for entry in &bin.entries {
                by_hash.entry(entry.path_hash).or_insert(entry);
            }
            for (hash, name) in table.names {
                names.names.entry(hash).or_insert(name);
            }
            for (hash, name) in table.files {
                names.files.entry(hash).or_insert(name);
            }
        }

        let dictionary = crate::bin::get_cached_bin_hashes().read();
        let entry_names = by_hash
            .keys()
            .filter_map(|hash| {
                let name = names
                    .names
                    .get(hash)
                    .cloned()
                    .or_else(|| dictionary.get(*hash as u64).map(str::to_string))?;
                Some((*hash, name))
            })
            .collect();

        Self {
            by_hash,
            entry_names,
            names,
        }
    }

    fn entry(&self, hash: u32) -> Option<&'a BinEntry> {
        self.by_hash.get(&hash).copied()
    }

    /// An asset path from whichever way the field carries one.
    ///
    /// `String` is the pre-migration form and `File` the current one; a `Link`/`Hash` in a
    /// path position is a name that was hashed. All three end at the same place.
    fn path(&self, value: &BinValue) -> Option<String> {
        match value {
            BinValue::String(s) if !s.is_empty() => Some(s.clone()),
            BinValue::File(hash) if *hash != 0 => self.name_of_file(*hash),
            BinValue::Hash(hash) | BinValue::Link(hash) if *hash != 0 => {
                self.names.names.get(hash).cloned().or_else(|| {
                    crate::bin::get_cached_bin_hashes()
                        .read()
                        .get(*hash as u64)
                        .map(str::to_string)
                })
            }
            _ => None,
        }
    }

    fn name_of_file(&self, hash: u64) -> Option<String> {
        self.names.files.get(&hash).cloned().or_else(|| {
            crate::bin::get_cached_bin_hashes()
                .read()
                .get(hash)
                .map(str::to_string)
        })
    }

    /// The entry a `material` field points at, whether it stores a link or a name.
    fn material_entry(&self, value: &BinValue) -> Option<&'a BinEntry> {
        match value {
            BinValue::Link(hash) | BinValue::Hash(hash) if *hash != 0 => self.entry(*hash),
            BinValue::String(name) => self.entry(fnv1a(name)),
            _ => None,
        }
    }
}

fn fields_of(value: &BinValue) -> Option<&indexmap::IndexMap<u32, BinValue>> {
    match value {
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => Some(fields),
        _ => None,
    }
}

fn items_of(value: &BinValue) -> &[BinValue] {
    match value {
        BinValue::List { items, .. } => items,
        _ => &[],
    }
}

fn as_str(value: &BinValue) -> Option<&str> {
    match value {
        BinValue::String(s) => Some(s.as_str()),
        _ => None,
    }
}

fn as_vec4(value: &BinValue) -> Option<[f32; 4]> {
    match value {
        BinValue::Vec4(v) => Some(*v),
        _ => None,
    }
}

struct Sampler {
    name: String,
    path: String,
}

fn is_project_specific(path: &str) -> bool {
    crate::mesh::texture::is_project_specific_texture(path)
}

fn looks_like_support_map(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    NON_DIFFUSE.iter().any(|m| lower.contains(m))
}

/**
The surface texture of a `StaticMaterialDef`.

The ladder is the one the text path established, kept exactly: a project-specific
`Main_Texture` beats a project-specific `Diffuse_Texture` beats any project-specific
non-support map, and only then does a shared/generic path get considered. A material
usually declares several samplers and only one of them is the colour.
*/
fn diffuse_of(index: &BinIndex, material: &BinEntry) -> Option<String> {
    let samplers: Vec<Sampler> = material
        .fields
        .get(&SAMPLER_VALUES)
        .map(items_of)
        .unwrap_or_default()
        .iter()
        .filter_map(|item| {
            let fields = fields_of(item)?;
            let name = fields
                .get(&TEXTURE_NAME)
                .or_else(|| fields.get(&SAMPLER_NAME))
                .and_then(as_str)
                .unwrap_or_default()
                .to_ascii_lowercase();
            let path = index.path(fields.get(&TEXTURE_PATH)?)?;
            Some(Sampler { name, path })
        })
        .collect();

    let pick = |want: Option<&str>, project_only: bool, skip_support: bool| {
        samplers
            .iter()
            .find(|s| {
                want.is_none_or(|w| s.name.contains(w))
                    && (!project_only || is_project_specific(&s.path))
                    && (!skip_support || !looks_like_support_map(&s.path))
            })
            .map(|s| s.path.clone())
    };

    pick(Some("main_texture"), true, false)
        .or_else(|| pick(Some("diffuse"), true, false))
        .or_else(|| pick(None, true, true))
        .or_else(|| pick(Some("main_texture"), false, false))
        .or_else(|| pick(Some("diffuse"), false, false))
        .or_else(|| pick(None, false, true))
}

/// `UVScaleAndOffset`, `FlipbookSize` and `FrameIndex` out of a material's `paramValues`.
fn params_of(material: &BinEntry, props: &mut MaterialProperties) {
    for item in material
        .fields
        .get(&PARAM_VALUES)
        .map(items_of)
        .unwrap_or_default()
    {
        let Some(fields) = fields_of(item) else { continue };
        let Some(name) = fields.get(&NAME).and_then(as_str) else { continue };
        let Some(v) = fields.get(&VALUE).and_then(as_vec4) else { continue };

        match name {
            "UVScaleAndOffset" => {
                props.uv_scale = Some([v[0], v[1]]);
                props.uv_offset = Some([v[2], v[3]]);
            }
            "FlipbookSize" => props.flipbook_size = Some([v[0] as u32, v[1] as u32]),
            "FrameIndex" => props.flipbook_frame = Some(v[0]),
            _ => {}
        }
    }
}

fn material_props(index: &BinIndex, material: &BinEntry) -> Option<MaterialProperties> {
    let mut props = MaterialProperties {
        texture_path: diffuse_of(index, material)?,
        ..Default::default()
    };
    params_of(material, &mut props);
    Some(props)
}

/// The texture behind a `texture` field, or behind the `material` link beside it.
fn props_from_slot(
    index: &BinIndex,
    fields: &indexmap::IndexMap<u32, BinValue>,
) -> Option<MaterialProperties> {
    if let Some(path) = fields.get(&TEXTURE).and_then(|v| index.path(v)) {
        return Some(MaterialProperties {
            texture_path: path,
            ..Default::default()
        });
    }
    let material = index.material_entry(fields.get(&MATERIAL)?)?;
    material_props(index, material)
}

/// Every submesh's texture, plus the mesh-wide default, from the parsed tree.
pub fn extract_texture_mapping(index: &BinIndex) -> TextureMapping {
    let mut mapping = TextureMapping::default();

    for entry in index.by_hash.values() {
        if entry.class_hash != SKIN_CHARACTER_DATA_PROPERTIES {
            continue;
        }
        let Some(mesh_props) = entry.fields.get(&SKIN_MESH_PROPERTIES).and_then(fields_of) else {
            continue;
        };

        if mapping.default_texture.is_none() {
            mapping.default_texture = props_from_slot(index, mesh_props).map(|p| p.texture_path);
        }

        for over in mesh_props
            .get(&MATERIAL_OVERRIDE)
            .map(items_of)
            .unwrap_or_default()
        {
            let Some(fields) = fields_of(over) else { continue };
            let Some(submesh) = fields.get(&SUBMESH).and_then(as_str) else { continue };
            if let Some(props) = props_from_slot(index, fields) {
                mapping
                    .material_properties
                    .insert(submesh.to_string(), props);
            }
        }
    }

    mapping
}

/**
The texture of the `StaticMaterialDef` a SKN material name refers to.

A SKN names its materials `Hair`; the bin calls the same thing
`Characters/Seraphine/Skins/Skin69/Materials/Hair_diffuse`. The match walks out from exact
to "ends with the name" to "contains it", which is what the SKN's own naming leaves room
for — but over the index's entry names, not over megabytes of text.
*/
pub fn lookup_material_by_name(index: &BinIndex, material_name: &str) -> Option<MaterialProperties> {
    let wanted = material_name.to_ascii_lowercase();
    let tail = wanted.rsplit('/').next().unwrap_or(&wanted).to_string();

    let candidates: Vec<(&u32, &String)> = index
        .entry_names
        .iter()
        .filter(|(hash, _)| {
            index
                .entry(**hash)
                .is_some_and(|e| e.class_hash == STATIC_MATERIAL_DEF)
        })
        .collect();

    let by = |test: &dyn Fn(&str) -> bool| -> Option<&BinEntry> {
        candidates
            .iter()
            .find(|(_, name)| test(&name.to_ascii_lowercase()))
            .and_then(|(hash, _)| index.entry(**hash))
    };

    let material = by(&|name: &str| name == wanted)
        .or_else(|| by(&|name: &str| name.rsplit('/').next().unwrap_or(name) == tail))
        .or_else(|| by(&|name: &str| name.ends_with(&tail)))
        .or_else(|| by(&|name: &str| name.contains(&tail)))?;

    material_props(index, material)
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;
    use ritoshark::bin::BinType;

    fn embed(class: &str, fields: Vec<(u32, BinValue)>) -> BinValue {
        BinValue::Embed {
            class: fnv1a(class),
            fields: fields.into_iter().collect::<IndexMap<_, _>>(),
        }
    }

    fn list(items: Vec<BinValue>) -> BinValue {
        BinValue::List {
            is_list2: false,
            item: BinType::Embed,
            items,
        }
    }

    fn sampler(name: &str, path: BinValue) -> BinValue {
        embed(
            "StaticMaterialShaderSamplerDef",
            vec![
                (TEXTURE_NAME, BinValue::String(name.into())),
                (TEXTURE_PATH, path),
            ],
        )
    }

    fn material_entry(name: &str, samplers: Vec<BinValue>) -> BinEntry {
        let mut fields = IndexMap::new();
        fields.insert(SAMPLER_VALUES, list(samplers));
        BinEntry {
            path_hash: fnv1a(name),
            class_hash: STATIC_MATERIAL_DEF,
            fields,
        }
    }

    fn skin_entry(mesh_fields: Vec<(u32, BinValue)>) -> BinEntry {
        let mut fields = IndexMap::new();
        fields.insert(
            SKIN_MESH_PROPERTIES,
            embed("SkinMeshDataProperties", mesh_fields),
        );
        BinEntry {
            path_hash: fnv1a("Characters/Seraphine/Skins/Skin69"),
            class_hash: SKIN_CHARACTER_DATA_PROPERTIES,
            fields,
        }
    }

    fn bin(entries: Vec<BinEntry>) -> Bin {
        Bin {
            entries,
            ..Bin::new()
        }
    }

    fn index_of<'a>(bin: &'a Bin, table: Trailer) -> BinIndex<'a> {
        BinIndex::new([(bin, table)])
    }

    /// Entry names come from the trailer / files.txt for anything a repath invented, so the
    /// tests supply them the same way rather than leaning on the machine's hash dictionary.
    fn naming(entry_names: &[&str]) -> Trailer {
        let mut table = Trailer::new();
        for name in entry_names {
            table.names.insert(fnv1a(name), (*name).to_string());
        }
        table
    }

    /// The whole point: `string` and `file` are two arms of one match, so a retype cannot
    /// silently stop resolving the way it did against a `texturePath:\s*string` pattern.
    #[test]
    fn a_string_and_a_file_reference_resolve_the_same() {
        let mut table = Trailer::new();
        table
            .files
            .insert(ritoshark::hash::xxh64("assets/body.tex"), "assets/body.tex".into());

        for value in [
            BinValue::String("assets/body.tex".into()),
            BinValue::File(ritoshark::hash::xxh64("assets/body.tex")),
        ] {
            let b = bin(vec![skin_entry(vec![(TEXTURE, value)])]);
            let mapping = extract_texture_mapping(&index_of(&b, table.clone()));
            assert_eq!(mapping.default_texture.as_deref(), Some("assets/body.tex"));
        }
    }

    #[test]
    fn a_submesh_override_wins_over_the_default() {
        let b = bin(vec![skin_entry(vec![
            (TEXTURE, BinValue::String("assets/body.tex".into())),
            (
                MATERIAL_OVERRIDE,
                list(vec![embed(
                    "SkinMeshDataProperties_MaterialOverride",
                    vec![
                        (SUBMESH, BinValue::String("Hair".into())),
                        (TEXTURE, BinValue::String("assets/hair.tex".into())),
                    ],
                )]),
            ),
        ])]);

        let mapping = extract_texture_mapping(&index_of(&b, Trailer::new()));
        assert_eq!(mapping.default_texture.as_deref(), Some("assets/body.tex"));
        assert_eq!(
            mapping.material_properties["Hair"].texture_path,
            "assets/hair.tex"
        );
    }

    /// A link is an entry hash. Matching it is an integer compare, with none of the
    /// name-shaped guessing the text path needed.
    #[test]
    fn a_material_link_is_followed_to_its_sampler() {
        let material = material_entry(
            "Characters/Seraphine/Skins/Skin69/Materials/Hair_diffuse",
            vec![
                sampler(
                    "Normal_Texture",
                    BinValue::String("assets/skin69/hair_nm.tex".into()),
                ),
                sampler(
                    "Diffuse_Texture",
                    BinValue::String("assets/skin69/hair_tx_cm.tex".into()),
                ),
            ],
        );
        let skin = skin_entry(vec![(
            MATERIAL_OVERRIDE,
            list(vec![embed(
                "SkinMeshDataProperties_MaterialOverride",
                vec![
                    (SUBMESH, BinValue::String("Hair".into())),
                    (MATERIAL, BinValue::Link(material.path_hash)),
                ],
            )]),
        )]);

        let b = bin(vec![skin, material]);
        let mapping = extract_texture_mapping(&index_of(&b, Trailer::new()));
        assert_eq!(
            mapping.material_properties["Hair"].texture_path,
            "assets/skin69/hair_tx_cm.tex"
        );
    }

    #[test]
    fn a_support_map_never_wins_over_the_colour() {
        let material = material_entry(
            "Materials/Body",
            vec![
                sampler("Mask_Texture", BinValue::String("assets/skin69/mask.tex".into())),
                sampler("Whatever", BinValue::String("assets/skin69/body_tx_cm.tex".into())),
            ],
        );
        let b = bin(vec![material]);
        let index = index_of(&b, naming(&["Materials/Body"]));
        let props = lookup_material_by_name(&index, "Body").unwrap();
        assert_eq!(props.texture_path, "assets/skin69/body_tx_cm.tex");
    }

    #[test]
    fn a_skn_material_name_finds_the_bins_longer_one() {
        let material = material_entry(
            "Characters/Seraphine/Skins/Skin69/Materials/Hair_diffuse",
            vec![sampler(
                "Diffuse_Texture",
                BinValue::String("assets/skin69/hair_tx_cm.tex".into()),
            )],
        );
        let b = bin(vec![material]);
        let index = index_of(
            &b,
            naming(&["Characters/Seraphine/Skins/Skin69/Materials/Hair_diffuse"]),
        );

        assert_eq!(
            lookup_material_by_name(&index, "Hair_diffuse").unwrap().texture_path,
            "assets/skin69/hair_tx_cm.tex"
        );
        assert!(lookup_material_by_name(&index, "NothingLikeThis").is_none());
    }

    #[test]
    fn param_values_come_across() {
        let mut material = material_entry(
            "Materials/Body",
            vec![sampler("Diffuse_Texture", BinValue::String("assets/skin69/b.tex".into()))],
        );
        material.fields.insert(
            PARAM_VALUES,
            list(vec![
                embed(
                    "StaticMaterialShaderParamDef",
                    vec![
                        (NAME, BinValue::String("UVScaleAndOffset".into())),
                        (VALUE, BinValue::Vec4([2.0, 3.0, 0.5, 0.25])),
                    ],
                ),
                embed(
                    "StaticMaterialShaderParamDef",
                    vec![
                        (NAME, BinValue::String("FlipbookSize".into())),
                        (VALUE, BinValue::Vec4([4.0, 2.0, 0.0, 0.0])),
                    ],
                ),
            ]),
        );

        let b = bin(vec![material]);
        let props =
            lookup_material_by_name(&index_of(&b, naming(&["Materials/Body"])), "Body").unwrap();
        assert_eq!(props.uv_scale, Some([2.0, 3.0]));
        assert_eq!(props.uv_offset, Some([0.5, 0.25]));
        assert_eq!(props.flipbook_size, Some([4, 2]));
    }
}
