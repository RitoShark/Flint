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
    /// 1-based line in the bin's ritobin text, when the finding sits on one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    /// The form the client actually reads, e.g. `texturePath: file`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
}

impl CheckIssue {
    fn new(severity: Severity, code: &'static str, file: &str, message: String) -> Self {
        Self {
            severity,
            code,
            file: file.to_string(),
            message,
            line: None,
            expected: None,
        }
    }

    fn at(mut self, line: Option<u32>) -> Self {
        self.line = line;
        self
    }

    fn expecting(mut self, expected: impl Into<String>) -> Self {
        self.expected = Some(expected.into());
        self
    }
}

/// 1-based line of the first `<field>: <ty>` declaration in rendered ritobin text.
///
/// The printer emits exactly `name: type = value`, so a plain match is enough; a field
/// whose hash no dictionary names prints as `0x…` and simply is not found.
pub(crate) fn declaration_line(text: &str, field: &str, ty: &str) -> Option<u32> {
    if field.starts_with("0x") || ty.is_empty() {
        return None;
    }
    let needle = format!("{field}: {ty}");
    text.lines()
        .position(|line| {
            let trimmed = line.trim_start();
            trimmed.len() >= needle.len()
                && trimmed[..needle.len()].eq_ignore_ascii_case(&needle)
        })
        .map(|idx| idx as u32 + 1)
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

    /* Neither BC5 nor BC7 has a legacy D3D9 pixel format, so writers emit them behind a
    DX10 extension header — 20 extra bytes League's D3D9-era .dds loader knows nothing
    about. It reads the pixels 20 bytes short and the client crashes. Every Riot-shipped
    .dds is DXT1/DXT5; BC7/BC5 belong in a .tex, which carries them natively. */
    if header.container == TextureContainer::Dds && header.dx10 {
        out.push(CheckIssue::new(
            Severity::Critical,
            "texture.dx10-dds",
            rel,
            "Uses a DX10 extension header (a BC7/BC5-class format). League's .dds loader predates DX10 and crashes on it — convert to .tex (BC7 is native there) or re-encode as DXT1/DXT5.".to_string(),
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

// ─── Animation clip files ────────────────────────────────────────────────────

const ANIMATION_FILE_PATH: u32 = fnv1a("mAnimationFilePath");

fn collect_clip_files(
    value: &BinValue,
    owner: Option<u32>,
    out: &mut Vec<(Option<u32>, String, u64)>,
) {
    match value {
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            for (field, inner) in fields {
                if *field == ANIMATION_FILE_PATH {
                    match inner {
                        BinValue::String(path) if !path.is_empty() => {
                            out.push((owner, path.clone(), flint_hash::hash::wad_chunk_hash(path)))
                        }
                        BinValue::File(hash) if *hash != 0 => {
                            out.push((owner, String::new(), *hash))
                        }
                        _ => {}
                    }
                    continue;
                }
                collect_clip_files(inner, owner, out);
            }
        }
        BinValue::List { items, .. } => {
            for item in items {
                collect_clip_files(item, owner, out);
            }
        }
        BinValue::Map { entries, .. } => {
            for (key, inner) in entries {
                let owner = match key {
                    BinValue::Hash(h) => Some(*h),
                    _ => owner,
                };
                collect_clip_files(inner, owner, out);
            }
        }
        BinValue::Option {
            value: Some(inner), ..
        } => collect_clip_files(inner, owner, out),
        _ => {}
    }
}

/**
Clips whose `.anm` the mod does not ship.

An animation bin names its clip files by path (older bins) or by xxh64 (`file`, current);
either way the client needs the file to be in the WAD. `present` is the folder's file
index, so a clip pointing at a base-game path the mod deliberately does not carry reads
the same as one pointing at a file the author deleted — hence WARNING, with the clip named
so the author can tell those apart at a glance.
*/
pub fn check_animation_assets(
    bin: &Bin,
    rel: &str,
    names: &HashMapper,
    present: &HashSet<u64>,
) -> Vec<CheckIssue> {
    let mut found = Vec::new();
    for entry in &bin.entries {
        for value in entry.fields.values() {
            collect_clip_files(value, None, &mut found);
        }
    }

    let mut missing: Vec<String> = Vec::new();
    let mut seen: HashSet<u64> = HashSet::new();
    for (clip, path, hash) in found {
        if present.contains(&hash) || !seen.insert(hash) {
            continue;
        }
        let file = if path.is_empty() {
            names.get(hash).map(str::to_string).unwrap_or_else(|| format!("0x{hash:016x}"))
        } else {
            path
        };
        missing.push(match clip {
            Some(clip) => format!("{} → {file}", clip_label(clip, names)),
            None => file,
        });
    }
    if missing.is_empty() {
        return Vec::new();
    }

    missing.sort();
    let shown = missing[..missing.len().min(3)].join(", ");
    let rest = missing.len().saturating_sub(3);
    vec![CheckIssue::new(
        Severity::Warning,
        "animation.missing-clip-file",
        rel,
        format!(
            "{} animation clip{} point at an `.anm` this mod does not ship ({shown}{}). Unless the game provides it, the animation does not play.",
            missing.len(),
            if missing.len() == 1 { "" } else { "s" },
            if rest > 0 { format!(", and {rest} more") } else { String::new() },
        ),
    )]
}

// ─── BIN content hazards ─────────────────────────────────────────────────────

/// Entry classes that belong to the champion's base gameplay data, never to a skin mod.
/// Hematite's `champion_bin_remover` deletes files carrying them: they go stale on every
/// patch and are what breaks "worked yesterday" mods after an update.
const GAMEPLAY_CLASSES: &[&str] = &[
    "SpellObject",
    "StatStoneData",
    "SkinCharacterMetaDataProperties",
    "CharacterRecord",
    "ChampionRuneRecommendationsContext",
    "RecSpellRankUpInfoList",
    "ItemRecommendationOverrideSet",
    "ItemRecommendationContextList",
    "StatStoneSet",
    "AbilityObject",
];

const GAMEPLAY_HASHES: [u32; GAMEPLAY_CLASSES.len()] = {
    let mut out = [0u32; GAMEPLAY_CLASSES.len()];
    let mut i = 0;
    while i < GAMEPLAY_CLASSES.len() {
        out[i] = fnv1a(GAMEPLAY_CLASSES[i]);
        i += 1;
    }
    out
};

const VFX_SYSTEM_CLASS: u32 = fnv1a("VfxSystemDefinitionData");
const OLD_SHAPE_FIELD: u32 = fnv1a("shape");
const OLD_SHAPE_INNER: [u32; 4] = [
    fnv1a("birthTranslation"),
    fnv1a("emitOffset"),
    fnv1a("emitRotationAngles"),
    fnv1a("emitRotationAxes"),
];

const SAMPLER_DEF_CLASS: u32 = fnv1a("StaticMaterialShaderSamplerDef");
const SAMPLER_NAME_FIELD: u32 = fnv1a("samplerName");
const TEXTURE_NAME_FIELD: u32 = fnv1a("textureName");

fn old_vfx_shape(value: &BinValue, count: &mut usize) {
    if let BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } = value {
        if let Some(BinValue::Pointer { fields: shape, .. } | BinValue::Embed { fields: shape, .. }) =
            fields.get(&OLD_SHAPE_FIELD)
        {
            if OLD_SHAPE_INNER.iter().any(|h| shape.contains_key(h)) {
                *count += 1;
            }
        }
    }
    match value {
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            for inner in fields.values() {
                old_vfx_shape(inner, count);
            }
        }
        BinValue::List { items, .. } => {
            for item in items {
                old_vfx_shape(item, count);
            }
        }
        BinValue::Map { entries, .. } => {
            for (k, v) in entries {
                old_vfx_shape(k, count);
                old_vfx_shape(v, count);
            }
        }
        BinValue::Option {
            value: Some(inner), ..
        } => old_vfx_shape(inner, count),
        _ => {}
    }
}

fn stale_samplers(value: &BinValue, count: &mut usize) {
    match value {
        BinValue::Pointer { class, fields } | BinValue::Embed { class, fields } => {
            if *class == SAMPLER_DEF_CLASS {
                if fields.contains_key(&SAMPLER_NAME_FIELD) {
                    *count += 1;
                }
                if let Some(BinValue::String(s)) = fields.get(&TEXTURE_NAME_FIELD) {
                    if s.contains('.') {
                        *count += 1;
                    }
                }
            }
            for inner in fields.values() {
                stale_samplers(inner, count);
            }
        }
        BinValue::List { items, .. } => {
            for item in items {
                stale_samplers(item, count);
            }
        }
        BinValue::Map { entries, .. } => {
            for (k, v) in entries {
                stale_samplers(k, count);
                stale_samplers(v, count);
            }
        }
        BinValue::Option {
            value: Some(inner), ..
        } => stale_samplers(inner, count),
        _ => {}
    }
}

/**
Checks one BIN for content the client rejects or misreads: shipped gameplay entries,
pre-14.1 VFX emitter shapes, and pre-rename `StaticMaterialShaderSamplerDef` fields.
All three come straight out of Hematite/Topaz's fix rules — see each message.
*/
pub fn check_bin_hazards(bin: &Bin, rel: &str, text: Option<&str>) -> Vec<CheckIssue> {
    let mut out = Vec::new();

    let mut gameplay: Vec<&str> = Vec::new();
    for entry in &bin.entries {
        if let Some(pos) = GAMEPLAY_HASHES.iter().position(|h| *h == entry.class_hash) {
            if !gameplay.contains(&GAMEPLAY_CLASSES[pos]) {
                gameplay.push(GAMEPLAY_CLASSES[pos]);
            }
        }
    }
    if !gameplay.is_empty() {
        out.push(CheckIssue::new(
            Severity::Warning,
            "bin.gameplay-entry",
            rel,
            format!(
                "Ships gameplay entries ({}). These duplicate the champion's base data and go stale on every patch — the usual cause of a mod that crashes or misbehaves right after an update. Hematite's `champion_bin_remover` deletes files like this.",
                gameplay.join(", "),
            ),
        ));
    }

    let mut old_shapes = 0usize;
    let mut samplers = 0usize;
    for entry in &bin.entries {
        if entry.class_hash == VFX_SYSTEM_CLASS {
            for value in entry.fields.values() {
                old_vfx_shape(value, &mut old_shapes);
            }
        }
        for value in entry.fields.values() {
            stale_samplers(value, &mut samplers);
        }
    }
    if old_shapes > 0 {
        out.push(CheckIssue::new(
            Severity::Warning,
            "bin.old-vfx-shape",
            rel,
            format!(
                "{old_shapes} VFX emitter{} still use the pre-14.1 shape layout (birthTranslation/emitOffset/emitRotation inside `shape`). The client ignores them, so those particles emit wrongly or not at all. Hematite's `vfx_shape_fix` converts them.",
                if old_shapes == 1 { "" } else { "s" },
            ),
        ));
    }
    if samplers > 0 {
        out.push(CheckIssue::new(
            Severity::Warning,
            "bin.stale-sampler-field",
            rel,
            format!(
                "{samplers} material sampler{} use retired field names (samplerName, or a path in textureName). The client reads texturePath now, so the model renders white/chrome. Hematite's staticmat fixes rename them.",
                if samplers == 1 { "" } else { "s" },
            ),
        )
        .at(text.and_then(|t| {
            declaration_line(t, "samplerName", "string")
                .or_else(|| declaration_line(t, "textureName", "string"))
        }))
        .expecting("texturePath: file"));
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

fn migration_issue(m: &Migration, file: &str, hit: &MigrationHit) -> CheckIssue {
    let count = hit.count;
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
        .at(hit.line)
        .expecting(format!("{}: {}", m.field, m.to_type))
}

/**
Counts values whose declared type Riot has migrated away from, per `(class, field)` and
per file — one row per pair per file, so a finding can be pinned to the BIN that carries
it without one line per value burying every other finding.

Driven by [`crate::migration`]'s 395-row table rather than a hand-kept list, so it also
covers the UI/TFT/map content the old seven-pair list missed.
*/
#[derive(Debug, Default, Clone)]
struct MigrationHit {
    count: usize,
    /// Line of the first declaration in the bin's text, when the text was available.
    line: Option<u32>,
}

#[derive(Debug, Default)]
pub struct MigrationTally {
    /// (file, table key) → what was found
    hits: BTreeMap<(String, u64), MigrationHit>,
}

impl MigrationTally {
    /// `text` is the bin's rendered ritobin, when the caller already has it — it is
    /// what turns a finding into a line number the editor can jump to.
    pub fn add_bin(&mut self, bin: &Bin, rel: &str, text: Option<&str>) {
        for entry in &bin.entries {
            self.scan(entry.class_hash, &entry.fields, rel, text);
        }
    }

    fn scan(
        &mut self,
        class: u32,
        fields: &IndexMap<u32, BinValue>,
        rel: &str,
        text: Option<&str>,
    ) {
        let table = migration_table();
        for (field, value) in fields {
            if let Some(m) = table.get(&table_key(class, *field)) {
                if declares_old_type(m, value) {
                    let hit = self
                        .hits
                        .entry((rel.to_string(), table_key(class, *field)))
                        .or_default();
                    hit.count += 1;
                    if hit.line.is_none() {
                        hit.line = text
                            .and_then(|t| declaration_line(t, &m.field, &m.from_type));
                    }
                }
            }
            self.walk(value, rel, text);
        }
    }

    fn walk(&mut self, value: &BinValue, rel: &str, text: Option<&str>) {
        match value {
            BinValue::Pointer { class, fields } | BinValue::Embed { class, fields } => {
                self.scan(*class, fields, rel, text)
            }
            BinValue::List { items, .. } => {
                for item in items {
                    self.walk(item, rel, text);
                }
            }
            BinValue::Map { entries, .. } => {
                for (k, v) in entries {
                    self.walk(k, rel, text);
                    self.walk(v, rel, text);
                }
            }
            BinValue::Option {
                value: Some(inner), ..
            } => self.walk(inner, rel, text),
            _ => {}
        }
    }

    pub fn merge(&mut self, other: MigrationTally) {
        for (key, hit) in other.hits {
            let mine = self.hits.entry(key).or_default();
            mine.count += hit.count;
            mine.line = mine.line.or(hit.line);
        }
    }

    pub fn into_issues(self) -> Vec<CheckIssue> {
        let table = migration_table();
        self.hits
            .into_iter()
            .map(|((file, key), hit)| migration_issue(&table[&key], &file, &hit))
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

    fn dds_bytes(four_cc: &[u8; 4], dxgi: Option<u32>) -> Vec<u8> {
        let mut out = vec![0u8; 128];
        out[..4].copy_from_slice(&crate::texture_header::DDS_MAGIC);
        out[12..16].copy_from_slice(&64u32.to_le_bytes());
        out[16..20].copy_from_slice(&64u32.to_le_bytes());
        out[84..88].copy_from_slice(four_cc);
        if let Some(format) = dxgi {
            out.extend_from_slice(&format.to_le_bytes());
        }
        out
    }

    #[test]
    fn a_dx10_dds_is_critical() {
        let issues = check_texture("assets/a.dds", &dds_bytes(b"DX10", Some(98)));
        assert_eq!(codes(&issues), vec!["texture.dx10-dds"]);
        assert_eq!(issues[0].severity, Severity::Critical);
    }

    #[test]
    fn a_legacy_dxt5_dds_is_clean() {
        let issues = check_texture("assets/a.dds", &dds_bytes(b"DXT5", None));
        assert_eq!(codes(&issues), Vec::<&str>::new());
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
        tally.add_bin(&skin_bin(BinValue::String("assets/x.tex".into())), "skins/skin0.bin", None);
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

    fn animation_bin(path_value: BinValue) -> Bin {
        let clip = BinValue::Pointer {
            class: fnv1a("AtomicClipData"),
            fields: [(
                fnv1a("mAnimationResourceData"),
                BinValue::Embed {
                    class: fnv1a("AnimationResourceData"),
                    fields: [(fnv1a("mAnimationFilePath"), path_value)]
                        .into_iter()
                        .collect(),
                },
            )]
            .into_iter()
            .collect(),
        };
        let map = BinValue::Map {
            key: BinType::Hash,
            value: BinType::Pointer,
            entries: vec![(BinValue::Hash(fnv1a("Dance")), clip)],
        };
        Bin {
            entries: vec![BinEntry {
                path_hash: fnv1a("Characters/Yone/Animations/Skin0"),
                class_hash: fnv1a("AnimationGraphData"),
                fields: [(fnv1a("mClipDataMap"), map)].into_iter().collect(),
            }],
            ..Bin::new()
        }
    }

    #[test]
    fn a_clip_whose_anm_is_missing_is_reported_with_its_name() {
        let anm = "assets/characters/yone/skins/skin0/animations/dance.anm";
        let bin = animation_bin(BinValue::String(anm.to_string()));
        let mut names = HashMapper::new();
        names.insert(fnv1a("Dance") as u64, "Dance".to_string());

        let issues = check_animation_assets(&bin, "anim.bin", &names, &HashSet::new());
        assert_eq!(codes(&issues), vec!["animation.missing-clip-file"]);
        assert!(issues[0].message.contains("Dance"), "{}", issues[0].message);
        assert!(issues[0].message.contains("dance.anm"), "{}", issues[0].message);
    }

    #[test]
    fn a_clip_whose_anm_is_shipped_is_clean() {
        let anm = "assets/characters/yone/skins/skin0/animations/dance.anm";
        let bin = animation_bin(BinValue::String(anm.to_string()));
        let present = HashSet::from([flint_hash::hash::wad_chunk_hash(anm)]);
        assert!(check_animation_assets(&bin, "anim.bin", &HashMapper::new(), &present).is_empty());
    }

    /// The current form: the path is only an xxh64, and the folder index is keyed by it.
    #[test]
    fn a_file_typed_clip_path_is_checked_by_hash() {
        let anm = "assets/characters/yone/skins/skin0/animations/dance.anm";
        let hash = flint_hash::hash::wad_chunk_hash(anm);
        let bin = animation_bin(BinValue::File(hash));

        assert!(check_animation_assets(&bin, "anim.bin", &HashMapper::new(), &HashSet::from([hash]))
            .is_empty());
        let missing =
            check_animation_assets(&bin, "anim.bin", &HashMapper::new(), &HashSet::new());
        assert_eq!(codes(&missing), vec!["animation.missing-clip-file"]);
    }

    #[test]
    fn a_migration_issue_points_at_the_line_and_says_what_is_expected() {
        let text = "#PROP_text
entries: map[hash,embed] = {
    \"x\" = SkinMeshDataProperties_MaterialOverride {
        texture: string = \"assets/x.tex\"
    }
}";
        let mut tally = MigrationTally::default();
        tally.add_bin(
            &skin_bin(BinValue::String("assets/x.tex".into())),
            "skins/skin0.bin",
            Some(text),
        );
        let issues = tally.into_issues();

        assert_eq!(issues[0].line, Some(4), "the line that declares the old type");
        assert_eq!(issues[0].expected.as_deref(), Some("texture: file"));
    }

    #[test]
    fn a_line_is_only_reported_when_the_text_actually_declares_it() {
        let mut tally = MigrationTally::default();
        tally.add_bin(
            &skin_bin(BinValue::String("assets/x.tex".into())),
            "skins/skin0.bin",
            Some("#PROP_text
nothing to see"),
        );
        let issues = tally.into_issues();
        assert_eq!(issues[0].line, None);
        assert_eq!(issues[0].expected.as_deref(), Some("texture: file"));
    }

    #[test]
    fn declaration_line_ignores_a_mention_that_is_not_a_declaration() {
        let text = "  someOther: string = \"texture: string\"
  texture: string = \"a\"";
        assert_eq!(declaration_line(text, "texture", "string"), Some(2));
    }

    #[test]
    fn a_file_typed_value_is_already_migrated() {
        let mut tally = MigrationTally::default();
        tally.add_bin(&skin_bin(BinValue::File(0x1234)), "skins/skin0.bin", None);
        assert!(tally.into_issues().is_empty());
    }

    /// One row per field per FILE, not per value — a pre-migration mod has thousands of
    /// values, but a finding still has to pin the exact BIN that carries it.
    #[test]
    fn occurrences_are_tallied_per_field_per_file() {
        let mut tally = MigrationTally::default();
        tally.add_bin(&skin_bin(BinValue::String("a.tex".into())), "skins/skin0.bin", None);
        tally.add_bin(&skin_bin(BinValue::String("b.tex".into())), "skins/skin1.bin", None);

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
        tally.add_bin(&bin, "skins/skin0.bin", None);
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
        tally.add_bin(&bin, "data/remap.bin", None);
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
        tally.add_bin(&bin, "skins/skin0.bin", None);
        assert!(tally.into_issues().is_empty());
    }

    /// Topaz's raw shape hashes, so a name drift in this file would be caught here.
    #[test]
    fn vfx_shape_hashes_match_topaz() {
        assert_eq!(OLD_SHAPE_FIELD, 0x9dc3d926);
        assert_eq!(OLD_SHAPE_INNER[0], 0xff7d0e41);
        assert_eq!(OLD_SHAPE_INNER[1], 0xe5f268dd);
        assert_eq!(OLD_SHAPE_INNER[2], 0x07f41838);
        assert_eq!(OLD_SHAPE_INNER[3], 0xd1789c65);
    }

    fn entry(class: &str, fields: Vec<(u32, BinValue)>) -> Bin {
        Bin {
            entries: vec![BinEntry {
                path_hash: fnv1a("Some/Path"),
                class_hash: fnv1a(class),
                fields: fields.into_iter().collect(),
            }],
            ..Bin::new()
        }
    }

    #[test]
    fn a_gameplay_entry_is_flagged_once_per_class() {
        let bin = Bin {
            entries: vec![
                BinEntry {
                    path_hash: 1,
                    class_hash: fnv1a("SpellObject"),
                    fields: IndexMap::new(),
                },
                BinEntry {
                    path_hash: 2,
                    class_hash: fnv1a("SpellObject"),
                    fields: IndexMap::new(),
                },
                BinEntry {
                    path_hash: 3,
                    class_hash: fnv1a("CharacterRecord"),
                    fields: IndexMap::new(),
                },
            ],
            ..Bin::new()
        };
        let issues = check_bin_hazards(&bin, "data/x.bin", None);
        assert_eq!(codes(&issues), vec!["bin.gameplay-entry"]);
        assert_eq!(issues[0].severity, Severity::Warning);
        assert!(
            issues[0].message.contains("SpellObject, CharacterRecord"),
            "{}",
            issues[0].message
        );
    }

    #[test]
    fn an_old_vfx_shape_is_flagged() {
        let emitter = BinValue::Embed {
            class: fnv1a("VfxEmitterDefinitionData"),
            fields: [(
                OLD_SHAPE_FIELD,
                BinValue::Embed {
                    class: 0,
                    fields: [(OLD_SHAPE_INNER[1], BinValue::Vec3([0.0, 0.0, 0.0]))]
                        .into_iter()
                        .collect(),
                },
            )]
            .into_iter()
            .collect(),
        };
        let bin = entry(
            "VfxSystemDefinitionData",
            vec![(
                fnv1a("complexEmitterDefinitionData"),
                BinValue::List {
                    is_list2: false,
                    item: BinType::Embed,
                    items: vec![emitter],
                },
            )],
        );
        assert_eq!(codes(&check_bin_hazards(&bin, "a.bin", None)), vec!["bin.old-vfx-shape"]);
    }

    #[test]
    fn a_modern_vfx_shape_is_clean() {
        let bin = entry(
            "VfxSystemDefinitionData",
            vec![(fnv1a("particleName"), BinValue::String("x".into()))],
        );
        assert!(check_bin_hazards(&bin, "a.bin", None).is_empty());
    }

    #[test]
    fn a_sampler_with_a_path_in_texture_name_is_flagged() {
        let sampler = BinValue::Embed {
            class: fnv1a("StaticMaterialShaderSamplerDef"),
            fields: [(
                TEXTURE_NAME_FIELD,
                BinValue::String("ASSETS/Characters/Foo/skin.tex".into()),
            )]
            .into_iter()
            .collect(),
        };
        let bin = entry(
            "StaticMaterialDef",
            vec![(
                fnv1a("samplerValues"),
                BinValue::List {
                    is_list2: false,
                    item: BinType::Embed,
                    items: vec![sampler],
                },
            )],
        );
        assert_eq!(
            codes(&check_bin_hazards(&bin, "a.bin", None)),
            vec!["bin.stale-sampler-field"]
        );
    }

    #[test]
    fn a_sampler_holding_a_real_sampler_name_is_clean() {
        let sampler = BinValue::Embed {
            class: fnv1a("StaticMaterialShaderSamplerDef"),
            fields: [
                (TEXTURE_NAME_FIELD, BinValue::String("Diffuse_Texture".into())),
                (
                    fnv1a("texturePath"),
                    BinValue::String("ASSETS/Characters/Foo/skin.tex".into()),
                ),
            ]
            .into_iter()
            .collect(),
        };
        let bin = entry(
            "StaticMaterialDef",
            vec![(
                fnv1a("samplerValues"),
                BinValue::List {
                    is_list2: false,
                    item: BinType::Embed,
                    items: vec![sampler],
                },
            )],
        );
        assert!(check_bin_hazards(&bin, "a.bin", None).is_empty());
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
