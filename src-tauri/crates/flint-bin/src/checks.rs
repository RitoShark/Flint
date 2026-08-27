/*!
Crash-risk checks over the files an export would ship.

Separate from [`crate::audit`], which answers "is anything referenced but absent". These
answer "is anything present but shaped in a way the client cannot load" — the failures that
take the game down rather than showing a magenta texture.

Every rule here is a condition the client genuinely rejects, not a style preference: a
false CRITICAL stops an author shipping, so anything uncertain is a WARNING and anything
unverified is left out.
*/

use std::collections::{BTreeMap, HashSet};

use indexmap::IndexMap;
use ritoshark::bin::{Bin, BinType, BinValue};
use ritoshark::hash::fnv1a;

use crate::migration::{table as migration_table, table_key, Conversion, Migration};
use crate::texture_header::{read_texture_header, TextureContainer};

use flint_hash::hash::HashMapper;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// The client cannot load this. Shipping it breaks the mod for everyone.
    Critical,
    /// Loads, but under conditions the author probably did not intend.
    Warning,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CheckIssue {
    pub severity: Severity,
    /// Stable machine-readable rule id, e.g. `texture.block-misaligned`.
    pub code: &'static str,
    /// Folder-relative path of the offending file.
    pub file: String,
    pub message: String,
}

impl CheckIssue {
    fn new(severity: Severity, code: &'static str, file: &str, message: String) -> Self {
        Self {
            severity,
            code,
            file: file.to_string(),
            message,
        }
    }
}

// ─── Textures ─────────────────────────────────────────────────────────────────────

fn is_power_of_two(value: u32) -> bool {
    value != 0 && value & (value - 1) == 0
}

/**
Checks one `.tex` / `.dds` file.

`rel` is the folder-relative path — the extension comes from it, and it identifies the file
in the report. Only the header is inspected; see [`crate::texture_header`] for why.
*/
pub fn check_texture(rel: &str, data: &[u8]) -> Vec<CheckIssue> {
    let mut out = Vec::new();

    let header = match read_texture_header(data) {
        Ok(h) => h,
        Err(err) => {
            out.push(CheckIssue::new(
                Severity::Critical,
                "texture.unreadable",
                rel,
                format!("{err}. The client will not load this."),
            ));
            return out;
        }
    };

    /* League picks its loader from the extension, so a renamed file never loads no matter how
    valid its contents are — one of the most common ways a hand-assembled mod dies. */
    let declared = match rel.rsplit('.').next().unwrap_or_default().to_ascii_lowercase().as_str() {
        "tex" => Some(TextureContainer::Tex),
        "dds" => Some(TextureContainer::Dds),
        _ => None,
    };
    if declared.is_some_and(|d| d != header.container) {
        let (found, remedy) = match header.container {
            TextureContainer::Dds => (
                "DDS data in a .tex file",
                "convert it to TEX rather than renaming it",
            ),
            TextureContainer::Tex => (
                "TEX data in a .dds file",
                "give it a .tex extension and repoint the BIN references",
            ),
        };
        out.push(CheckIssue::new(
            Severity::Critical,
            "texture.extension-mismatch",
            rel,
            format!(
                "{found}. The client picks its loader from the extension, so this never loads — {remedy}."
            ),
        ));
    }

    if header.unknown_format {
        out.push(CheckIssue::new(
            Severity::Critical,
            "texture.unknown-format",
            rel,
            format!(
                "Declares an unrecognised {}. The client has no decoder for it.",
                header.format
            ),
        ));
    }

    let (w, h) = (header.width, header.height);
    if w == 0 || h == 0 {
        out.push(CheckIssue::new(
            Severity::Critical,
            "texture.zero-size",
            rel,
            format!("Header declares {w}×{h}."),
        ));
        return out;
    }

    /* Hematite's `fix_tex_dimensions` rounds these down for exactly this reason: a
    block-compressed payload stores 4×4 blocks, so an unaligned edge leaves a partial block
    the client reads as noise or walks off the end of. */
    if header.block_compressed && (w % 4 != 0 || h % 4 != 0) {
        out.push(CheckIssue::new(
            Severity::Critical,
            "texture.block-misaligned",
            rel,
            format!(
                "{w}×{h} is not a multiple of 4, but {} is block-compressed. Expect noise or a crash — resize to {}×{}.",
                header.format,
                (w / 4).max(1) * 4,
                (h / 4).max(1) * 4,
            ),
        ));
    }

    /* The mip chain is addressed by halving, so a non-power-of-two texture's lower levels do
    not land where the reader expects them. */
    if header.has_mipmaps && (!is_power_of_two(w) || !is_power_of_two(h)) {
        out.push(CheckIssue::new(
            Severity::Warning,
            "texture.npot-mipmaps",
            rel,
            format!(
                "{w}×{h} is not a power of two but the file ships a mip chain. Drop the mips or resize to power-of-two dimensions."
            ),
        ));
    }

    if header.container == TextureContainer::Tex
        && matches!(header.format.as_str(), "Etc1" | "Etc2" | "Etc2Eac")
    {
        out.push(CheckIssue::new(
            Severity::Warning,
            "texture.mobile-format",
            rel,
            format!(
                "Encoded as {}, a mobile (Wild Rift) block format. PC clients expect BC1/BC3/BC7.",
                header.format
            ),
        ));
    }

    out
}

// ─── Animation graphs ────────────────────────────────────────────────────────

const CLIP_DATA_MAP: u32 = fnv1a("mClipDataMap");

/// Fields whose `hash` value names another clip in the same `mClipDataMap`.
const CLIP_NAME_FIELDS: &[u32] = &[
    fnv1a("mClipName"),
    fnv1a("mClipNameList"),
    fnv1a("mTrueConditionClipName"),
    fnv1a("mFalseConditionClipName"),
];

fn is_clip_name_field(field: u32) -> bool {
    CLIP_NAME_FIELDS.contains(&field)
}

fn collect_clip_refs(value: &BinValue, out: &mut Vec<u32>) {
    match value {
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            for (&field, inner) in fields {
                if is_clip_name_field(field) {
                    match inner {
                        BinValue::Hash(h) => out.push(*h),
                        BinValue::List { items, .. } => {
                            for item in items {
                                if let BinValue::Hash(h) = item {
                                    out.push(*h);
                                }
                            }
                        }
                        _ => {}
                    }
                }
                collect_clip_refs(inner, out);
            }
        }
        BinValue::List { items, .. } => {
            for item in items {
                collect_clip_refs(item, out);
            }
        }
        BinValue::Map { entries, .. } => {
            for (k, v) in entries {
                collect_clip_refs(k, out);
                collect_clip_refs(v, out);
            }
        }
        BinValue::Option {
            value: Some(inner), ..
        } => collect_clip_refs(inner, out),
        _ => {}
    }
}

fn clip_label(hash: u32, names: &HashMapper) -> String {
    match names.get(hash as u64) {
        Some(name) => format!("\"{name}\""),
        None => format!("0x{hash:08x}"),
    }
}

/**
Checks every animation graph in one BIN.

A `SelectorClipData`, `SequencerClipData` or `ConditionBool`/`ConditionFloatClipData` names the
clips it plays by hash, and the client resolves those against the graph's own `mClipDataMap`.
A name that isn't in the map has nothing to resolve to, which is a crash the moment the clip
is triggered rather than a visible glitch — so a mod that renames or drops a clip without
updating the clips that call it looks fine right up until someone dances.

Only graphs that actually carry a populated `mClipDataMap` are checked, and only the direct
clip-name fields are followed, so a bin that merely mentions a clip elsewhere is never flagged.
*/
pub fn check_animation_graph(bin: &Bin, rel: &str, names: &HashMapper) -> Vec<CheckIssue> {
    let mut out = Vec::new();

    for entry in &bin.entries {
        let Some(BinValue::Map { entries, .. }) = entry.fields.get(&CLIP_DATA_MAP) else {
            continue;
        };

        let defined: HashSet<u32> = entries
            .iter()
            .filter_map(|(k, _)| match k {
                BinValue::Hash(h) => Some(*h),
                _ => None,
            })
            .collect();
        if defined.is_empty() {
            continue;
        }

        let mut referenced = Vec::new();
        for (_, clip) in entries {
            collect_clip_refs(clip, &mut referenced);
        }

        let mut dangling: Vec<u32> = referenced
            .into_iter()
            .filter(|h| *h != 0 && !defined.contains(h))
            .collect();
        dangling.sort_unstable();
        dangling.dedup();

        for hash in dangling {
            out.push(CheckIssue::new(
                Severity::Critical,
                "animation.dangling-clip",
                rel,
                format!(
                    "Animation graph {} plays clip {}, which is not in its own clip map. The client crashes when that clip is triggered.",
                    clip_label(entry.path_hash, names),
                    clip_label(hash, names),
                ),
            ));
        }
    }

    out
}

// ─── Asset-reference type migration ──────────────────────────────────────────

/// Whether `value` still declares the type the table's row migrated away from.
///
/// Matching is on the DECLARED type, not the held value — an empty `list[string]` or an
/// unset `option[string]` is rejected by the client exactly like a populated one.
fn declares_old_type(m: &Migration, value: &BinValue) -> bool {
    match m.conversion {
        Conversion::HashValue => matches!(
            value,
            BinValue::String(_)
                | BinValue::List {
                    item: BinType::String,
                    ..
                }
                | BinValue::Option {
                    item: BinType::String,
                    ..
                }
                | BinValue::Map {
                    value: BinType::String,
                    ..
                }
        ),
        Conversion::Rehash => matches!(value, BinValue::Hash(_)),
        Conversion::HashKey => matches!(
            value,
            BinValue::Map {
                key: BinType::Hash,
                ..
            }
        ),
        Conversion::Retag => match value {
            BinValue::Embed { class, .. } => Some(*class) == m.from_class,
            BinValue::List { items, .. } => items
                .iter()
                .any(|it| matches!(it, BinValue::Embed { class, .. } if Some(*class) == m.from_class)),
            _ => false,
        },
    }
}

fn migration_issue(m: &Migration, file: &str, count: usize) -> CheckIssue {
    let plural = if count == 1 { "" } else { "s" };
    let (code, message) = match m.conversion {
        Conversion::HashValue => (
            "bin.string-ref-not-migrated",
            format!(
                "{count} {} value{plural} still typed as `string`. Riot retyped this field to `file`, so the client no longer reads the path and the asset silently does not load. Hematite's Skin Fixer converts them (`file_ref_migration`).",
                m.label,
            ),
        ),
        Conversion::Rehash => (
            "bin.hash-ref-not-migrated",
            format!(
                "{count} {} value{plural} still typed as `hash`. The client reads a `file` (xxh64 of the path) here now, and an fnv1a `hash` cannot be converted mechanically — repoint the field at its path.",
                m.label,
            ),
        ),
        Conversion::HashKey => (
            "bin.hash-ref-not-migrated",
            format!(
                "{count} {} map{plural} still keyed by `hash`. The client keys this map by `file` (xxh64 of the path) now, and an fnv1a `hash` key cannot be converted mechanically — re-key the map by path.",
                m.label,
            ),
        ),
        Conversion::Retag => (
            "bin.embed-retagged",
            format!(
                "{count} {} value{plural} still carry the retired embed layout. Riot changed this type's tag/class, so the client no longer reads it.",
                m.label,
            ),
        ),
    };
    CheckIssue::new(Severity::Critical, code, file, message)
}

/**
Counts values whose declared type Riot has migrated away from, per `(class, field)` and
per file — one row per pair per file, so a finding can be pinned to the BIN that carries
it without one line per value burying every other finding.

Driven by [`crate::migration`]'s 395-row table rather than a hand-kept list, so it also
covers the UI/TFT/map content the old seven-pair list missed.
*/
#[derive(Debug, Default)]
pub struct MigrationTally {
    /// (file, table key) → occurrence count
    hits: BTreeMap<(String, u64), usize>,
}

impl MigrationTally {
    pub fn add_bin(&mut self, bin: &Bin, rel: &str) {
        for entry in &bin.entries {
            self.scan(entry.class_hash, &entry.fields, rel);
        }
    }

    fn scan(&mut self, class: u32, fields: &IndexMap<u32, BinValue>, rel: &str) {
        let table = migration_table();
        for (field, value) in fields {
            if let Some(m) = table.get(&table_key(class, *field)) {
                if declares_old_type(m, value) {
                    *self
                        .hits
                        .entry((rel.to_string(), table_key(class, *field)))
                        .or_insert(0) += 1;
                }
            }
            self.walk(value, rel);
        }
    }

    fn walk(&mut self, value: &BinValue, rel: &str) {
        match value {
            BinValue::Pointer { class, fields } | BinValue::Embed { class, fields } => {
                self.scan(*class, fields, rel)
            }
            BinValue::List { items, .. } => {
                for item in items {
                    self.walk(item, rel);
                }
            }
            BinValue::Map { entries, .. } => {
                for (k, v) in entries {
                    self.walk(k, rel);
                    self.walk(v, rel);
                }
            }
            BinValue::Option {
                value: Some(inner), ..
            } => self.walk(inner, rel),
            _ => {}
        }
    }

    pub fn into_issues(self) -> Vec<CheckIssue> {
        let table = migration_table();
        self.hits
            .into_iter()
            .map(|((file, key), count)| migration_issue(&table[&key], &file, count))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;
    use ritoshark::bin::{BinEntry, BinType};

    use crate::texture_header::TEX_MAGIC;
    use ritoshark::tex::TexFormat;

    fn tex_bytes(width: u16, height: u16, format: u8, has_mipmaps: bool) -> Vec<u8> {
        let mut out = TEX_MAGIC.to_vec();
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&height.to_le_bytes());
        out.extend_from_slice(&[1, format, 0, has_mipmaps as u8]);
        out
    }

    fn codes(issues: &[CheckIssue]) -> Vec<&str> {
        issues.iter().map(|i| i.code).collect()
    }

    #[test]
    fn a_block_aligned_power_of_two_texture_is_clean() {
        let data = tex_bytes(256, 256, TexFormat::Bc3.to_u8(), true);
        assert_eq!(codes(&check_texture("assets/a.tex", &data)), Vec::<&str>::new());
    }

    #[test]
    fn an_unaligned_block_compressed_texture_is_critical() {
        let data = tex_bytes(255, 254, TexFormat::Bc3.to_u8(), false);
        let issues = check_texture("assets/a.tex", &data);
        assert_eq!(codes(&issues), vec!["texture.block-misaligned"]);
        assert_eq!(issues[0].severity, Severity::Critical);
        assert!(issues[0].message.contains("252×252"), "{}", issues[0].message);
    }

    /// BGRA8 stores one pixel per block, so odd dimensions are perfectly legal.
    #[test]
    fn an_uncompressed_texture_may_have_any_dimensions() {
        let data = tex_bytes(255, 254, TexFormat::Bgra8.to_u8(), false);
        assert_eq!(codes(&check_texture("assets/a.tex", &data)), Vec::<&str>::new());
    }

    #[test]
    fn a_block_aligned_but_non_power_of_two_texture_only_warns_when_mipmapped() {
        let plain = tex_bytes(12, 20, TexFormat::Bc1.to_u8(), false);
        assert_eq!(codes(&check_texture("a.tex", &plain)), Vec::<&str>::new());

        let mipped = tex_bytes(12, 20, TexFormat::Bc1.to_u8(), true);
        let issues = check_texture("a.tex", &mipped);
        assert_eq!(codes(&issues), vec!["texture.npot-mipmaps"]);
        assert_eq!(issues[0].severity, Severity::Warning);
    }

    #[test]
    fn a_dds_renamed_to_tex_is_critical() {
        let mut data = vec![0u8; 200];
        data[..4].copy_from_slice(&crate::texture_header::DDS_MAGIC);
        data[16..20].copy_from_slice(&64u32.to_le_bytes());
        data[12..16].copy_from_slice(&64u32.to_le_bytes());
        let issues = check_texture("assets/a.tex", &data);
        assert_eq!(issues[0].code, "texture.extension-mismatch");
        assert_eq!(issues[0].severity, Severity::Critical);
    }

    #[test]
    fn a_tex_renamed_to_dds_is_critical() {
        let data = tex_bytes(64, 64, TexFormat::Bc3.to_u8(), false);
        let issues = check_texture("assets/a.dds", &data);
        assert_eq!(issues[0].code, "texture.extension-mismatch");
    }

    #[test]
    fn a_file_that_is_neither_tex_nor_dds_is_critical() {
        let issues = check_texture("assets/a.tex", &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        assert_eq!(codes(&issues), vec!["texture.unreadable"]);
    }

    fn clip(class: &str, fields: Vec<(u32, BinValue)>) -> BinValue {
        BinValue::Pointer {
            class: fnv1a(class),
            fields: fields.into_iter().collect::<IndexMap<_, _>>(),
        }
    }

    fn graph(clips: Vec<(&str, BinValue)>) -> Bin {
        let map = BinValue::Map {
            key: BinType::Hash,
            value: BinType::Pointer,
            entries: clips
                .into_iter()
                .map(|(name, v)| (BinValue::Hash(fnv1a(name)), v))
                .collect(),
        };
        let mut fields = IndexMap::new();
        fields.insert(CLIP_DATA_MAP, map);
        Bin {
            entries: vec![BinEntry {
                path_hash: fnv1a("Characters/Yone/Animations/Skin0"),
                class_hash: fnv1a("animationGraphData"),
                fields,
            }],
            ..Bin::new()
        }
    }

    fn atomic() -> BinValue {
        clip("AtomicClipData", vec![])
    }

    #[test]
    fn a_selector_pointing_at_a_live_clip_is_clean() {
        let selector = clip(
            "SelectorClipData",
            vec![(
                fnv1a("mSelectorPairDataList"),
                BinValue::List {
                    is_list2: false,
                    item: BinType::Embed,
                    items: vec![BinValue::Embed {
                        class: fnv1a("SelectorPairData"),
                        fields: [(fnv1a("mClipName"), BinValue::Hash(fnv1a("Idle1_Base")))]
                            .into_iter()
                            .collect(),
                    }],
                },
            )],
        );
        let bin = graph(vec![("Idle1", selector), ("Idle1_Base", atomic())]);
        assert!(check_animation_graph(&bin, "a.bin", &HashMapper::new()).is_empty());
    }

    #[test]
    fn a_selector_pointing_at_a_missing_clip_is_critical() {
        let selector = clip(
            "SelectorClipData",
            vec![(
                fnv1a("mSelectorPairDataList"),
                BinValue::List {
                    is_list2: false,
                    item: BinType::Embed,
                    items: vec![BinValue::Embed {
                        class: fnv1a("SelectorPairData"),
                        fields: [(fnv1a("mClipName"), BinValue::Hash(fnv1a("Idle1_Deleted")))]
                            .into_iter()
                            .collect(),
                    }],
                },
            )],
        );
        let bin = graph(vec![("Idle1", selector), ("Idle1_Base", atomic())]);

        let mut names = HashMapper::new();
        names.insert(fnv1a("Idle1_Deleted") as u64, "Idle1_Deleted");

        let issues = check_animation_graph(&bin, "a.bin", &names);
        assert_eq!(codes(&issues), vec!["animation.dangling-clip"]);
        assert!(issues[0].message.contains("Idle1_Deleted"), "{}", issues[0].message);
    }

    #[test]
    fn a_sequencer_checks_every_name_in_its_list() {
        let sequencer = clip(
            "SequencerClipData",
            vec![(
                fnv1a("mClipNameList"),
                BinValue::List {
                    is_list2: false,
                    item: BinType::Hash,
                    items: vec![
                        BinValue::Hash(fnv1a("Joke_In")),
                        BinValue::Hash(fnv1a("Joke_Gone")),
                    ],
                },
            )],
        );
        let bin = graph(vec![("Joke", sequencer), ("Joke_In", atomic())]);

        let issues = check_animation_graph(&bin, "a.bin", &HashMapper::new());
        assert_eq!(issues.len(), 1);
        assert!(
            issues[0].message.contains(&format!("0x{:08x}", fnv1a("Joke_Gone"))),
            "{}",
            issues[0].message
        );
    }

    #[test]
    fn both_branches_of_a_bool_condition_are_checked() {
        let cond = clip(
            "ConditionBoolClipData",
            vec![
                (
                    fnv1a("mTrueConditionClipName"),
                    BinValue::Hash(fnv1a("Run_Fast")),
                ),
                (
                    fnv1a("mFalseConditionClipName"),
                    BinValue::Hash(fnv1a("Run_Slow")),
                ),
            ],
        );
        let bin = graph(vec![("Run", cond), ("Run_Fast", atomic())]);
        assert_eq!(
            check_animation_graph(&bin, "a.bin", &HashMapper::new()).len(),
            1
        );
    }

    fn skin_bin(texture: BinValue) -> Bin {
        let override_struct = BinValue::Embed {
            class: fnv1a("SkinMeshDataProperties_MaterialOverride"),
            fields: [(fnv1a("texture"), texture)].into_iter().collect(),
        };
        let mut fields = IndexMap::new();
        fields.insert(
            fnv1a("skinMeshProperties"),
            BinValue::Embed {
                class: fnv1a("SkinMeshDataProperties"),
                fields: [(
                    fnv1a("materialOverride"),
                    BinValue::List {
                        is_list2: false,
                        item: BinType::Embed,
                        items: vec![override_struct],
                    },
                )]
                .into_iter()
                .collect(),
            },
        );
        Bin {
            entries: vec![BinEntry {
                path_hash: fnv1a("Characters/Yone/Skins/Skin0"),
                class_hash: fnv1a("SkinCharacterDataProperties"),
                fields,
            }],
            ..Bin::new()
        }
    }

    #[test]
    fn a_string_on_a_migrated_field_is_critical() {
        let mut tally = MigrationTally::default();
        tally.add_bin(&skin_bin(BinValue::String("assets/x.tex".into())), "skins/skin0.bin");
        let issues = tally.into_issues();

        assert_eq!(codes(&issues), vec!["bin.string-ref-not-migrated"]);
        assert_eq!(issues[0].severity, Severity::Critical);
        assert_eq!(issues[0].file, "skins/skin0.bin");
        assert!(
            issues[0].message.starts_with("1 SkinMeshDataProperties_MaterialOverride.texture value "),
            "{}",
            issues[0].message
        );
    }

    #[test]
    fn a_file_typed_value_is_already_migrated() {
        let mut tally = MigrationTally::default();
        tally.add_bin(&skin_bin(BinValue::File(0x1234)), "skins/skin0.bin");
        assert!(tally.into_issues().is_empty());
    }

    /// One row per field per FILE, not per value — a pre-migration mod has thousands of
    /// values, but a finding still has to pin the exact BIN that carries it.
    #[test]
    fn occurrences_are_tallied_per_field_per_file() {
        let mut tally = MigrationTally::default();
        tally.add_bin(&skin_bin(BinValue::String("a.tex".into())), "skins/skin0.bin");
        tally.add_bin(&skin_bin(BinValue::String("b.tex".into())), "skins/skin1.bin");

        let issues = tally.into_issues();
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].file, "skins/skin0.bin");
        assert_eq!(issues[1].file, "skins/skin1.bin");
        assert!(issues[0].message.starts_with("1 "), "{}", issues[0].message);
    }

    /// The declared type is what the client rejects — an unset `option[string]` or an
    /// empty `list[string]` is as broken as a populated one.
    #[test]
    fn a_declared_string_container_counts_even_when_empty() {
        let mut fields = IndexMap::new();
        fields.insert(
            fnv1a("iconCircle"),
            BinValue::Option {
                item: BinType::String,
                value: None,
            },
        );
        fields.insert(
            fnv1a("alternateIconsSquare"),
            BinValue::List {
                is_list2: false,
                item: BinType::String,
                items: vec![],
            },
        );
        let bin = Bin {
            entries: vec![BinEntry {
                path_hash: fnv1a("Characters/Yone/Skins/Skin0"),
                class_hash: fnv1a("SkinCharacterDataProperties"),
                fields,
            }],
            ..Bin::new()
        };
        let mut tally = MigrationTally::default();
        tally.add_bin(&bin, "skins/skin0.bin");
        assert_eq!(tally.into_issues().len(), 2);
    }

    /// A `hash` on a rehashed field has no mechanical fix, so its row must say so.
    #[test]
    fn a_hash_on_a_rehashed_field_is_reported_without_a_fix() {
        let mut fields = IndexMap::new();
        fields.insert(fnv1a("oldAsset"), BinValue::Hash(0xdeadbeef));
        let bin = Bin {
            entries: vec![BinEntry {
                path_hash: fnv1a("Whatever/Path"),
                class_hash: fnv1a("VfxAssetRemap"),
                fields,
            }],
            ..Bin::new()
        };
        let mut tally = MigrationTally::default();
        tally.add_bin(&bin, "data/remap.bin");
        let issues = tally.into_issues();
        assert_eq!(codes(&issues), vec!["bin.hash-ref-not-migrated"]);
        assert!(issues[0].message.contains("VfxAssetRemap.oldAsset"), "{}", issues[0].message);
    }

    #[test]
    fn a_field_riot_did_not_retype_is_left_alone() {
        let mut fields = IndexMap::new();
        fields.insert(fnv1a("championSkinName"), BinValue::String("Yone".into()));
        let bin = Bin {
            entries: vec![BinEntry {
                path_hash: fnv1a("Characters/Yone/Skins/Skin0"),
                class_hash: fnv1a("SkinCharacterDataProperties"),
                fields,
            }],
            ..Bin::new()
        };
        let mut tally = MigrationTally::default();
        tally.add_bin(&bin, "skins/skin0.bin");
        assert!(tally.into_issues().is_empty());
    }

    /// A bin with no clip map is not an animation graph and must never be reported on.
    #[test]
    fn a_bin_without_a_clip_map_is_ignored() {
        let mut fields = IndexMap::new();
        fields.insert(fnv1a("mClipName"), BinValue::Hash(fnv1a("Nothing")));
        let bin = Bin {
            entries: vec![BinEntry {
                path_hash: fnv1a("Characters/Yone/Skins/Skin0"),
                class_hash: fnv1a("SkinCharacterDataProperties"),
                fields,
            }],
            ..Bin::new()
        };
        assert!(check_animation_graph(&bin, "a.bin", &HashMapper::new()).is_empty());
    }
}
