//! Compatibility bridge to RitoShark's `rs_bin` for BIN file handling.
//!
//! This module provides a simplified interface to RitoShark's BIN reader/writer
//! and ritobin text printer/parser, wrapping their APIs for use throughout the
//! application. Hash-name resolution for the text form goes through a globally
//! cached `HashMapper` populated from the `hashes-bin.lmdb` dictionary.

use flint_hash::hash::bin_dict::get_cached_bin_hashes;
use ritoshark::bin::{Bin, PathMap, Trailer};
use ritoshark::hash::HashMapper;
use ritoshark::prelude::{Parse as _, Serialize as _};
use std::collections::BTreeMap;

/// Maximum allowed BIN file size (50MB - no legitimate BIN should be larger)
pub const MAX_BIN_SIZE: usize = 50 * 1024 * 1024;

#[derive(Debug)]
pub struct BinError(pub String);

impl std::fmt::Display for BinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for BinError {}

pub type Result<T> = std::result::Result<T, BinError>;

/// # Safety
/// This function validates file size and magic bytes to prevent memory issues
/// from corrupt files. Files larger than 50MB are rejected.
pub fn read_bin(data: &[u8]) -> Result<Bin> {
    tracing::debug!(
        "read_bin: size={} bytes, magic={:02x?}",
        data.len(),
        &data[..std::cmp::min(8, data.len())]
    );

    if data.len() > MAX_BIN_SIZE {
        tracing::error!(
            "BIN file rejected: {} bytes exceeds max size of {} bytes",
            data.len(),
            MAX_BIN_SIZE
        );
        return Err(BinError(format!(
            "BIN file too large ({} bytes, max {} bytes) - likely corrupt",
            data.len(),
            MAX_BIN_SIZE
        )));
    }

    if data.len() >= 4 {
        let magic = &data[0..4];
        if magic != b"PROP" && magic != b"PTCH" {
            tracing::error!(
                "Invalid BIN magic bytes: {:02x?} (expected PROP or PTCH)",
                magic
            );
            return Err(BinError(format!(
                "Invalid BIN magic bytes: {:02x?} (expected PROP or PTCH)",
                magic
            )));
        }
    } else {
        tracing::error!("BIN file too small: {} bytes (minimum 4 bytes for magic)", data.len());
        return Err(BinError(format!(
            "BIN file too small ({} bytes, minimum 4 bytes for magic)",
            data.len()
        )));
    }

    // catch_unwind to handle OOM panics from the parser
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        Bin::from_bytes(data)
    }));

    match result {
        Ok(Ok(tree)) => {
            tracing::debug!(
                "Successfully parsed BIN: {} entries, {} linked",
                tree.entries.len(),
                tree.linked.len()
            );
            Ok(tree)
        }
        Ok(Err(e)) => {
            tracing::error!("BIN parse failed: {} (file was {} bytes)", e, data.len());
            Err(BinError(format!("Failed to parse bin: {}", e)))
        }
        Err(panic_info) => {
            let panic_msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = panic_info.downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown panic".to_string()
            };
            tracing::error!(
                "CRITICAL: Parser panicked on {} byte file: {}",
                data.len(),
                panic_msg
            );
            Err(BinError(format!(
                "Parser panicked (likely OOM or stack overflow): {}",
                panic_msg
            )))
        }
    }
}

pub fn write_bin(tree: &Bin) -> Result<Vec<u8>> {
    tree.to_bytes()
        .map_err(|e| BinError(format!("Failed to write bin: {}", e)))
}

pub fn tree_to_text_with_hashes(tree: &Bin, hashes: &HashMapper) -> Result<String> {
    // Blend-transition keys: `AnimationGraphData.mBlendDataTable`'s packed u64
    // keys print as `"FromClip" -> "ToClip"` pairs instead of 19-digit
    // integers. `from_text` accepts the readable form (and the plain u64)
    // unconditionally, so every text→bin path in the app round-trips no matter
    // which form the text carries.
    let opts = ritoshark::bin::TextOptions { blend_keys: true };
    Ok(ritoshark::bin::to_text_with(tree, Some(hashes), &opts))
}


pub fn tree_to_text_cached(tree: &Bin) -> Result<String> {
    let hashes = get_cached_bin_hashes().read();
    tree_to_text_with_hashes(tree, &hashes)
}

pub fn text_to_tree(text: &str) -> Result<Bin> {
    ritoshark::bin::from_text(text, None)
        .map_err(|e| BinError(format!("Failed to parse text: {}", e)))
}

// ── Unhash-in-place for the editor ─────────────────────────────────────────────

fn text_name_candidates(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut names = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'#' || (bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'/')) {
            i = text[i..]
                .find('\n')
                .map(|offset| i + offset + 1)
                .unwrap_or(bytes.len());
            continue;
        }
        if bytes[i] == b'"' {
            i += 1;
            let mut value = String::new();
            while i < bytes.len() {
                if bytes[i] == b'"' {
                    i += 1;
                    break;
                }
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    i += 1;
                    value.push(match bytes[i] {
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        other => other as char,
                    });
                    i += 1;
                    continue;
                }
                let len = utf8_len(bytes[i]);
                value.push_str(&text[i..i + len]);
                i += len;
            }
            if !value.is_empty() {
                names.push(value);
            }
            continue;
        }
        if bytes[i] == b'_' || bytes[i].is_ascii_alphabetic() {
            let start = i;
            i += 1;
            while i < bytes.len() && (bytes[i] == b'_' || bytes[i].is_ascii_alphanumeric()) {
                i += 1;
            }
            names.push(text[start..i].to_string());
            continue;
        }
        i += utf8_len(bytes[i]);
    }
    names
}

fn custom_names(tree: &Bin, candidates: Vec<String>) -> PathMap {
    let mut map = ritoshark::bin::capture(tree, candidates);
    let known = get_cached_bin_hashes().read();
    let local = flint_hash::hash::local_custom_hashes().read();
    // A name this machine invented earlier is in the cache but in no dictionary
    // anyone else has, so it still counts as custom — otherwise the second bin to
    // use a repath would record nothing and lose it the moment the file travels.
    let shared_knows = |hash: u64, name: &str| {
        !local.contains(&hash) && known.get(hash).is_some_and(|known_name| known_name == name)
    };
    for set in [
        &mut map.bin_entries,
        &mut map.bin_types,
        &mut map.bin_fields,
        &mut map.bin_hashes,
    ] {
        set.retain(|name| !shared_knows(ritoshark::hash::fnv1a(name) as u64, name));
    }
    map.game
        .retain(|name| !shared_knows(ritoshark::hash::xxh64(name), name));
    map
}

/// Every category flattened into one lookup, for naming the `0x…` tokens in
/// rendered text — which carries no position to resolve against.
pub fn name_lookup(map: &PathMap) -> Trailer {
    let tables = map.tables();
    let mut lookup = Trailer::new();
    for names in [
        tables.bin_entries,
        tables.bin_types,
        tables.bin_fields,
        tables.bin_hashes,
    ] {
        lookup.names.extend(names);
    }
    lookup.files = tables.game;
    lookup
}

/// The names a bin is its own record of: the `ritobinmap` entry, plus the legacy
/// `CELMAP` footer for a bin written before the record moved into the body.
pub fn embedded_names(bin: &Bin) -> Trailer {
    let mut lookup = name_lookup(&ritoshark::bin::read_path_map(bin));
    let legacy = ritoshark::bin::read_trailer(&bin.trailing);
    for (hash, name) in legacy.names {
        lookup.names.entry(hash).or_insert(name);
    }
    for (hash, name) in legacy.files {
        lookup.files.entry(hash).or_insert(name);
    }
    lookup
}

pub fn custom_hash_names_from_text(text: &str, tree: &Bin) -> BTreeMap<u32, String> {
    name_lookup(&custom_names(tree, text_name_candidates(text))).names
}

pub fn custom_file_names_from_text(text: &str, tree: &Bin) -> BTreeMap<u64, String> {
    name_lookup(&custom_names(tree, text_name_candidates(text))).files
}

/// Writes the `ritobinmap` record into `tree` and hands back what it names.
///
/// Captured while both halves are still on the page: once the value is a bare
/// hash the name is gone, and a repath exists in no dictionary to look up. What
/// the bin already carried is offered back as a candidate, so a name the edited
/// text no longer spells out survives as long as the tree still uses its hash.
pub fn embed_names(tree: &mut Bin, text: &str) -> Trailer {
    let mut candidates = text_name_candidates(text);
    candidates.extend(embedded_names(tree).all_names().map(str::to_string));
    let map = custom_names(tree, candidates);
    ritoshark::bin::write_path_map(tree, &map);
    name_lookup(&map)
}

/// Rewrites the `0x…` tokens `lookup` can name, so a repath reads back as the
/// path the author typed rather than a hash.
pub fn apply_names(text: String, lookup: &Trailer) -> String {
    if lookup.is_empty() {
        return text;
    }
    let mut hashes = HashMapper::new();
    for (hash, name) in &lookup.names {
        hashes.insert(*hash as u64, name.clone());
    }
    for (hash, name) in &lookup.files {
        hashes.insert(*hash, name.clone());
    }
    unhash_text(&text, &hashes).0
}

pub fn remember_custom_hash_names(text: &str, tree: &Bin) -> Result<usize> {
    let lookup = name_lookup(&custom_names(tree, text_name_candidates(text)));
    let (names, files) = (lookup.names, lookup.files);
    let saved_names = flint_hash::hash::save_custom_bin_hashes(&names)
        .map_err(|e| BinError(format!("Failed to save custom hashes: {e}")))?;
    let saved_files = flint_hash::hash::save_custom_file_hashes(&files)
        .map_err(|e| BinError(format!("Failed to save custom file hashes: {e}")))?;
    Ok(saved_names + saved_files)
}

#[cfg(test)]
mod custom_hash_tests {
    use super::*;
    use indexmap::IndexMap;
    use ritoshark::bin::{BinEntry, BinValue};
    use ritoshark::hash::fnv1a;

    #[test]
    fn finds_only_names_that_were_hashed_into_the_tree() {
        let entry_name = "FlintCustomEntry_7d9f";
        let class_name = "FlintCustomClass_7d9f";
        let field_name = "flintCustomField_7d9f";
        let value_name = "FlintCustomValue_7d9f";
        let mut fields = IndexMap::new();
        fields.insert(fnv1a(field_name), BinValue::Hash(fnv1a(value_name)));
        fields.insert(
            fnv1a("ordinaryString"),
            BinValue::String("NotHashed_7d9f".into()),
        );
        let mut tree = Bin::new();
        tree.entries.push(BinEntry {
            path_hash: fnv1a(entry_name),
            class_hash: fnv1a(class_name),
            fields,
        });
        let text = format!(
            "\"{entry_name}\" = {class_name} {{\n    {field_name}: hash = \"{value_name}\"\n    ordinaryString: string = \"NotHashed_7d9f\"\n}}"
        );
        let names = custom_hash_names_from_text(&text, &tree);
        assert_eq!(
            names.get(&fnv1a(entry_name)),
            Some(&entry_name.to_string())
        );
        assert_eq!(
            names.get(&fnv1a(class_name)),
            Some(&class_name.to_string())
        );
        assert_eq!(
            names.get(&fnv1a(field_name)),
            Some(&field_name.to_string())
        );
        assert_eq!(
            names.get(&fnv1a(value_name)),
            Some(&value_name.to_string())
        );
        assert!(!names.values().any(|name| name == "NotHashed_7d9f"));
    }

    #[test]
    fn remembers_a_file_path_typed_for_a_file_value() {
        let path = "ASSETS/Characters/Flint7d9f/Skins/Skin0/Custom_7d9f.dds";
        let mut fields = IndexMap::new();
        fields.insert(fnv1a("mFileRef"), BinValue::File(ritoshark::hash::xxh64(path)));
        fields.insert(fnv1a("mOther"), BinValue::File(0));
        let mut tree = Bin::new();
        tree.entries.push(BinEntry {
            path_hash: fnv1a("FlintFileEntry_7d9f"),
            class_hash: fnv1a("FlintFileClass_7d9f"),
            fields,
        });
        let text = format!(
            "\"FlintFileEntry_7d9f\" = FlintFileClass_7d9f {{
    mFileRef: file = \"{path}\"
    mOther: file = 0x0000000000000000
    ordinaryString: string = \"assets/not/referenced_7d9f.dds\"
}}"
        );
        let files = custom_file_names_from_text(&text, &tree);
        assert_eq!(files.get(&ritoshark::hash::xxh64(path)), Some(&path.to_string()));
        assert_eq!(files.len(), 1);
    }

    #[test]
    fn a_repathed_asset_survives_the_trip_to_a_machine_without_the_name() {
        let path = "ASSETS/Modders/Flint7d9f/Skins/Skin0/Invented_7d9f.dds";
        let emitter = "InventedEmitter_7d9f";
        let mut fields = IndexMap::new();
        fields.insert(fnv1a("mTextureRef"), BinValue::File(ritoshark::hash::xxh64(path)));
        fields.insert(fnv1a("mEmitterName"), BinValue::Hash(fnv1a(emitter)));
        let mut tree = Bin::new();
        tree.entries.push(BinEntry {
            path_hash: fnv1a("FlintTrailerEntry_7d9f"),
            class_hash: fnv1a("VfxSystemDefinitionData"),
            fields,
        });
        let text = format!(
            "\"FlintTrailerEntry_7d9f\" = VfxSystemDefinitionData {{
    mTextureRef: file = \"{path}\"
    mEmitterName: hash = \"{emitter}\"
}}"
        );

        let mut written = tree.clone();
        let recorded = embed_names(&mut written, &text);
        assert_eq!(recorded.files.get(&ritoshark::hash::xxh64(path)), Some(&path.to_string()));
        assert_eq!(recorded.names.get(&fnv1a(emitter)), Some(&emitter.to_string()));

        let bytes = write_bin(&written).expect("write");
        let reread = read_bin(&bytes).expect("read");
        assert!(reread.trailing.is_empty(), "the record belongs inside the body");
        let mut carried = reread.clone();
        assert_eq!(
            ritoshark::bin::strip_path_map(&mut carried),
            ritoshark::bin::read_path_map(&written)
        );
        assert_eq!(carried.entries, tree.entries);

        // Another machine: nothing in its dictionary names either hash.
        let bare = tree_to_text_with_hashes(&reread, &HashMapper::new()).expect("text");
        assert!(!bare.contains(path));
        let recovered = apply_names(bare, &embedded_names(&reread));
        assert!(recovered.contains(path), "{recovered}");
        assert!(recovered.contains(emitter), "{recovered}");
    }

    #[test]
    fn a_name_this_machine_already_invented_is_still_captured() {
        let path = "ASSETS/Modders/Flint7d9f/Skins/Skin0/Second_7d9f.dds";
        let hash = ritoshark::hash::xxh64(path);
        let mut fields = IndexMap::new();
        fields.insert(fnv1a("mTextureRef"), BinValue::File(hash));
        let mut tree = Bin::new();
        tree.entries.push(BinEntry {
            path_hash: fnv1a("FlintSecondEntry_7d9f"),
            class_hash: fnv1a("VfxSystemDefinitionData"),
            fields,
        });
        let text = format!(
            "\"FlintSecondEntry_7d9f\" = VfxSystemDefinitionData {{
    mTextureRef: file = \"{path}\"
}}"
        );

        get_cached_bin_hashes().write().insert(hash, path.to_string());
        flint_hash::hash::local_custom_hashes().write().insert(hash);

        let mut written = tree.clone();
        let recorded = embed_names(&mut written, &text);
        assert_eq!(recorded.files.get(&hash), Some(&path.to_string()));
    }

    #[test]
    fn ignores_names_that_exist_only_in_comments() {
        let names = text_name_candidates("# HiddenName_7d9f\n// OtherHidden_7d9f\nvisibleName");
        assert_eq!(names, vec!["visibleName"]);
    }
}

/// Whether `s` is a valid ritobin bareword identifier (`^[A-Za-z_][A-Za-z0-9_]*$`),
/// so a resolved field/class name can be written unquoted. Mirrors rs_bin's
/// `is_bareword`, which decides quoting in the text printer.
fn is_bareword(s: &str) -> bool {
    let mut bytes = s.bytes();
    match bytes.next() {
        Some(b) if b == b'_' || b.is_ascii_alphabetic() => {}
        _ => return false,
    }
    bytes.all(|b| b == b'_' || b.is_ascii_alphanumeric())
}

/// Replace resolvable `0x…` hash tokens in ritobin text with their names, using
/// the process-wide BIN hash cache. Purely lexical — it does not parse the tree,
/// so it works on partially-edited text and only ever touches hash tokens.
///
/// Formatting matches rs_bin's own printer so the result stays parseable:
/// * a token in NAME position (immediately followed, ignoring spaces, by `:` or
///   `{`) becomes a bareword when the name is a valid identifier, else a quoted
///   string (mirrors `push_name`);
/// * a token in any other (value / key) position is always quoted (mirrors
///   `push_hash32` / `push_hash64`).
///
/// A `0x…` token is only rewritten when it is a *whole* token — bounded by a
/// non-hex, non-identifier char on both sides — and only when it resolves.
/// Returns `(new_text, replaced_count)`.
pub fn unhash_text(text: &str, hashes: &HashMapper) -> (String, usize) {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut replaced = 0usize;
    let mut i = 0usize;

    while i < bytes.len() {
        // Look for a `0x` that starts a token (preceded by a non-identifier char).
        let prev = if i == 0 { None } else { Some(bytes[i - 1]) };
        let at_token_start = prev.is_none_or(|b| !is_ident_byte(b));
        if at_token_start
            && bytes[i] == b'0'
            && i + 1 < bytes.len()
            && (bytes[i + 1] == b'x' || bytes[i + 1] == b'X')
        {
            let hex_start = i + 2;
            let mut j = hex_start;
            while j < bytes.len() && bytes[j].is_ascii_hexdigit() {
                j += 1;
            }
            let hex_len = j - hex_start;
            // Token must end cleanly (not run into another identifier char), and
            // be a plausible 32- or 64-bit hash width.
            let ends_clean = j >= bytes.len() || !is_ident_byte(bytes[j]);
            if ends_clean && (hex_len == 8 || hex_len == 16) {
                let hex = &text[hex_start..j];
                let hash = u64::from_str_radix(hex, 16).ok();
                if let Some(name) = hash.and_then(|h| hashes.get(h)) {
                    // Already-quoted token, e.g. an entry key `"0x…"`: the printer
                    // wrote the surrounding quotes, so replace the WHOLE `"0x…"`
                    // (both quotes included) with a freshly-quoted name — never
                    // emit quotes inside the existing ones.
                    let quoted = prev == Some(b'"') && j < bytes.len() && bytes[j] == b'"';
                    if quoted {
                        out.pop(); // drop the opening quote we already copied
                        push_quoted(&mut out, name);
                        replaced += 1;
                        i = j + 1; // skip the closing quote too
                        continue;
                    }

                    // NAME position: next non-space char is `:` or `{`.
                    let mut k = j;
                    while k < bytes.len() && (bytes[k] == b' ' || bytes[k] == b'\t') {
                        k += 1;
                    }
                    let name_position = k < bytes.len() && (bytes[k] == b':' || bytes[k] == b'{');
                    if name_position && is_bareword(name) {
                        out.push_str(name);
                    } else {
                        push_quoted(&mut out, name);
                    }
                    replaced += 1;
                    i = j;
                    continue;
                }
            }
        }
        // Not a rewritable token — copy this byte through. (ASCII-safe: we only
        // ever branch on ASCII bytes; multi-byte UTF-8 is copied verbatim.)
        let ch_len = utf8_len(bytes[i]);
        out.push_str(&text[i..i + ch_len]);
        i += ch_len;
    }

    (out, replaced)
}

fn is_ident_byte(b: u8) -> bool {
    b == b'_' || b.is_ascii_alphanumeric()
}

fn utf8_len(first: u8) -> usize {
    match first {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        _ => 4,
    }
}

/// Write `name` as a quoted ritobin string with the same escapes rs_bin uses.
fn push_quoted(out: &mut String, name: &str) {
    out.push('"');
    for c in name.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
}

/// Unhash resolvable `0x…` tokens using the cached BIN hash dictionary.
pub fn unhash_text_cached(text: &str) -> (String, usize) {
    let hashes = get_cached_bin_hashes().read();
    unhash_text(text, &hashes)
}

#[cfg(test)]
mod blend_text_tests {
    use super::*;
    use ritoshark::bin::{BinEntry, BinType, BinValue, BlendKey, BLEND_DATA_TABLE};
    use ritoshark::hash::fnv1a;

    #[test]
    fn blend_keys_print_readable_and_round_trip() {
        // mBlendDataTable: map[u64, f32] with one fully-resolved key and one
        // whose destination clip is unknown to the mapper.
        let resolved = BlendKey::from_names("Attack1", "Laugh").to_u64();
        let unresolved = ((fnv1a("Attack1") as u64) << 32) | 0xdead_beef;
        let mut fields = indexmap::IndexMap::new();
        fields.insert(
            BLEND_DATA_TABLE,
            BinValue::Map {
                key: BinType::U64,
                value: BinType::F32,
                entries: vec![
                    (BinValue::U64(resolved), BinValue::F32(0.1)),
                    (BinValue::U64(unresolved), BinValue::F32(0.2)),
                ],
            },
        );
        let mut bin = Bin::new();
        bin.entries.push(BinEntry { path_hash: 0x1, class_hash: 0x2, fields });

        let mut mapper = HashMapper::new();
        mapper.insert(fnv1a("Attack1") as u64, "Attack1");
        mapper.insert(fnv1a("Laugh") as u64, "Laugh");

        let text = tree_to_text_with_hashes(&bin, &mapper).unwrap();
        assert!(text.contains("\"Attack1\" -> \"Laugh\""), "resolved pair readable: {text}");
        assert!(text.contains("\"Attack1\" -> 0xdeadbeef"), "unresolved half stays hex: {text}");

        // The lenient parser repacks the readable keys byte-identically.
        let parsed = text_to_tree(&text).unwrap();
        assert_eq!(write_bin(&bin).unwrap(), write_bin(&parsed).unwrap());
    }
}

#[cfg(test)]
mod unhash_tests {
    use super::*;

    fn mapper() -> HashMapper {
        let mut m = HashMapper::new();
        // 32-bit field name (bareword-valid)
        m.insert(0xdeadbeef, "mRate");
        // 32-bit class name (bareword-valid)
        m.insert(0x0011_2233, "VfxSystemDefinitionData");
        // 32-bit value hash (still quoted in value position)
        m.insert(0x00c0_ffee, "SomeLink");
        // 64-bit entry key / link
        m.insert(0x0123_4567_89ab_cdef, "Characters/Foo/Skins/Skin0");
        m
    }

    #[test]
    fn resolves_field_name_as_bareword() {
        let (out, n) = unhash_text("    0xdeadbeef: f32 = 1.0", &mapper());
        assert_eq!(out, "    mRate: f32 = 1.0");
        assert_eq!(n, 1);
    }

    #[test]
    fn resolves_class_name_before_brace_as_bareword() {
        let (out, n) = unhash_text("0x00112233 {", &mapper());
        assert_eq!(out, "VfxSystemDefinitionData {");
        assert_eq!(n, 1);
    }

    #[test]
    fn resolves_value_hash_as_quoted() {
        let (out, n) = unhash_text("link = 0x00c0ffee", &mapper());
        assert_eq!(out, "link = \"SomeLink\"");
        assert_eq!(n, 1);
    }

    #[test]
    fn resolves_bare_entry_key_and_adds_quotes() {
        // Unresolved entry keys are printed BARE (`push_hash32` → `0x…`, no
        // quotes). Once resolved they become a quoted string, so unhashing a
        // bare key must ADD the quotes.
        let (out, n) = unhash_text("    0xdeadbeef = 0x00112233 {", &mapper());
        // key → quoted string; class name → bareword (name position, before `{`).
        assert_eq!(out, "    \"mRate\" = VfxSystemDefinitionData {");
        assert_eq!(n, 2);
    }

    #[test]
    fn already_quoted_hex_is_replaced_in_place() {
        // Defensive: if a `0x…` is already wrapped in quotes, don't nest quotes.
        let (out, n) = unhash_text("\"0x0123456789abcdef\"", &mapper());
        assert_eq!(out, "\"Characters/Foo/Skins/Skin0\"");
        assert_eq!(n, 1);
    }

    #[test]
    fn leaves_unknown_hashes_untouched() {
        let (out, n) = unhash_text("0xabcdabcd: f32 = 0.0", &mapper());
        assert_eq!(out, "0xabcdabcd: f32 = 0.0");
        assert_eq!(n, 0);
    }

    #[test]
    fn ignores_wrong_width_and_partial_tokens() {
        // 6 hex digits — not a 32/64-bit hash; and a hash glued to more ident chars.
        let (out, n) = unhash_text("0xdead 0xdeadbeefff", &mapper());
        assert_eq!(out, "0xdead 0xdeadbeefff");
        assert_eq!(n, 0);
    }
}
