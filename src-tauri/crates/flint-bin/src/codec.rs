//! Compatibility bridge to RitoShark's `rs_bin` for BIN file handling.
//!
//! This module provides a simplified interface to RitoShark's BIN reader/writer
//! and ritobin text printer/parser, wrapping their APIs for use throughout the
//! application. Hash-name resolution for the text form goes through a globally
//! cached `HashMapper` populated from the `hashes-bin.lmdb` dictionary.

use flint_hash::hash::bin_dict::get_cached_bin_hashes;
use ritoshark::bin::Bin;
use ritoshark::hash::HashMapper;
use ritoshark::prelude::{Parse as _, Serialize as _};

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
    Ok(ritoshark::bin::to_text(tree, Some(hashes)))
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
