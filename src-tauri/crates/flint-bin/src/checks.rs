/*!
Crash-risk checks over the files an export would ship.

Separate from [`crate::audit`], which answers "is anything referenced but absent". These
answer "is anything present but shaped in a way the client cannot load" — the failures that
take the game down rather than showing a magenta texture.

Every rule here is a condition the client genuinely rejects, not a style preference: a
false CRITICAL stops an author shipping, so anything uncertain is a WARNING and anything
unverified is left out.
*/

use std::collections::HashSet;

use ritoshark::bin::{Bin, BinValue};
use ritoshark::hash::fnv1a;

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
