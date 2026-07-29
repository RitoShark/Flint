//! `Inibin` <-> INI-style text, grouped by storage bucket. The bucket name on
//! each `[Section]` determines the value type, so the text round-trips exactly:
//! `text_to_inibin(inibin_to_text(f)) == f` for any v2 file.
//!
//! Values are rendered in their **stored** form. Fixed-point buckets hold one
//! raw byte per component on disk, so they show as `0..=255` rather than the
//! tenths a display layer would derive from them — editing the stored byte is
//! what lets a save stay byte-identical to what was read.

use ritoshark::troybin::{Inibin, InibinFlags, ScalarValue, TroybinBody, TroybinV2};

fn section_name(flags: InibinFlags) -> &'static str {
    flags.as_str()
}

fn section_flags(name: &str) -> Option<InibinFlags> {
    InibinFlags::from_str_name(name)
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
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
    out
}

fn unescape(s: &str) -> Result<String, String> {
    let inner = s.strip_prefix('"').and_then(|x| x.strip_suffix('"'))
        .ok_or_else(|| format!("string value not quoted: {s}"))?;
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => return Err("trailing backslash in string".into()),
            }
        } else {
            out.push(c);
        }
    }
    Ok(out)
}

fn fmt_list<T: ToString>(vals: &[T]) -> String {
    let parts: Vec<String> = vals.iter().map(|v| v.to_string()).collect();
    format!("{{ {} }}", parts.join(", "))
}

fn value_to_text(v: &ScalarValue) -> String {
    match v {
        ScalarValue::I32(x) => x.to_string(),
        ScalarValue::F32(x) => x.to_string(),
        ScalarValue::U8(x) => x.to_string(),
        ScalarValue::I16(x) => x.to_string(),
        ScalarValue::U16(x) => x.to_string(),
        ScalarValue::Bool(x) => x.to_string(),
        ScalarValue::U8x3(a) => fmt_list(a),
        ScalarValue::F32x3(a) => fmt_list(a),
        ScalarValue::U8x2(a) => fmt_list(a),
        ScalarValue::F32x2(a) => fmt_list(a),
        ScalarValue::U8x4(a) => fmt_list(a),
        ScalarValue::F32x4(a) => fmt_list(a),
        // Stored as raw bytes; the editor shows the decoded text.
        ScalarValue::String(bytes) => escape(&String::from_utf8_lossy(bytes)),
    }
}

/// Split `{ a, b, c }` into exactly `n` components.
fn parse_components(s: &str, n: usize) -> Result<Vec<&str>, String> {
    let inner = s.trim().strip_prefix('{').and_then(|x| x.strip_suffix('}'))
        .ok_or_else(|| format!("vector value not braced: {s}"))?;
    let parts: Vec<&str> = inner.split(',').map(|p| p.trim()).filter(|p| !p.is_empty()).collect();
    if parts.len() != n {
        return Err(format!("expected {n} components, got {}: {s}", parts.len()));
    }
    Ok(parts)
}

fn parse_u8s<const N: usize>(s: &str) -> Result<[u8; N], String> {
    let parts = parse_components(s, N)?;
    let mut out = [0u8; N];
    for (slot, p) in out.iter_mut().zip(parts) {
        *slot = p.parse().map_err(|e| format!("bad u8 '{p}': {e}"))?;
    }
    Ok(out)
}

fn parse_f32s<const N: usize>(s: &str) -> Result<[f32; N], String> {
    let parts = parse_components(s, N)?;
    let mut out = [0f32; N];
    for (slot, p) in out.iter_mut().zip(parts) {
        *slot = p.parse().map_err(|e| format!("bad f32 '{p}': {e}"))?;
    }
    Ok(out)
}

fn parse_value(flags: InibinFlags, raw: &str) -> Result<ScalarValue, String> {
    let r = raw.trim();
    Ok(match flags {
        InibinFlags::Int32List | InibinFlags::Int32LongList =>
            ScalarValue::I32(r.parse().map_err(|e| format!("bad i32 '{r}': {e}"))?),
        InibinFlags::Float32List =>
            ScalarValue::F32(r.parse().map_err(|e| format!("bad f32 '{r}': {e}"))?),
        // Both of these buckets are a single raw byte on disk.
        InibinFlags::FixedPointFloatList | InibinFlags::Int8List =>
            ScalarValue::U8(r.parse().map_err(|e| format!("bad u8 '{r}': {e}"))?),
        InibinFlags::Int16List =>
            ScalarValue::I16(r.parse().map_err(|e| format!("bad i16 '{r}': {e}"))?),
        InibinFlags::BitList =>
            ScalarValue::Bool(r.parse().map_err(|e| format!("bad bool '{r}': {e}"))?),
        InibinFlags::FixedPointFloatListVec3 => ScalarValue::U8x3(parse_u8s::<3>(r)?),
        InibinFlags::Float32ListVec3 => ScalarValue::F32x3(parse_f32s::<3>(r)?),
        InibinFlags::FixedPointFloatListVec2 => ScalarValue::U8x2(parse_u8s::<2>(r)?),
        InibinFlags::Float32ListVec2 => ScalarValue::F32x2(parse_f32s::<2>(r)?),
        InibinFlags::FixedPointFloatListVec4 => ScalarValue::U8x4(parse_u8s::<4>(r)?),
        InibinFlags::Float32ListVec4 => ScalarValue::F32x4(parse_f32s::<4>(r)?),
        InibinFlags::StringList | InibinFlags::OldFormat =>
            ScalarValue::String(unescape(r)?.into_bytes()),
    })
}

/// Render an `Inibin` as INI-style text. The first line records the version.
///
/// A version-1 body carries no value typing, so there is nothing to render past
/// the header — such a file is read-only and preserved verbatim by the format
/// layer rather than round-tripped through this text form.
pub fn inibin_to_text(file: &Inibin) -> String {
    let mut out = String::new();
    out.push_str(&format!("# inibin v{}\n", file.version));
    let TroybinBody::V2(body) = &file.body else {
        return out;
    };
    for bucket in &body.buckets {
        let Ok(flags) = bucket.flags() else { continue };
        out.push_str(&format!("\n[{}]\n", section_name(flags)));
        for (hash, value) in bucket.entries() {
            out.push_str(&format!("0x{:08x} = {}\n", hash, value_to_text(&value)));
        }
    }
    out
}

/// Parse INI-style text back into an `Inibin`.
pub fn text_to_inibin(text: &str) -> Result<Inibin, String> {
    let mut version = 2u8;
    // Each value is inserted under the bucket bit its section names, not the
    // one its type would pick: `Int8List` and `FixedPointFloatList` are both a
    // raw byte on disk, as are `Int32List` and `Int32LongList` as i32, so the
    // value type alone cannot decide which bucket a property belongs in.
    let mut collected: Vec<(InibinFlags, u32, ScalarValue)> = Vec::new();
    let mut current: Option<InibinFlags> = None;

    for (lineno, raw_line) in text.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            if let Some(rest) = line.strip_prefix("# inibin v") {
                if let Ok(v) = rest.trim().parse::<u8>() { version = v; }
            }
            continue;
        }
        if let Some(sec) = line.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
            current = Some(section_flags(sec.trim())
                .ok_or_else(|| format!("line {}: unknown section '{sec}'", lineno + 1))?);
            continue;
        }
        let flags = current.ok_or_else(|| format!("line {}: value before any section", lineno + 1))?;
        let (key, val) = line.split_once('=')
            .ok_or_else(|| format!("line {}: missing '='", lineno + 1))?;
        let key = key.trim();
        let hash_str = key.strip_prefix("0x").unwrap_or(key);
        let hash = u32::from_str_radix(hash_str, 16)
            .map_err(|e| format!("line {}: bad hash '{key}': {e}", lineno + 1))?;
        let value = parse_value(flags, val)
            .map_err(|e| format!("line {}: {e}", lineno + 1))?;
        collected.push((flags, hash, value));
    }

    let mut body = TroybinV2 {
        strings_length: 0,
        flags_zero_prefix: false,
        buckets: Vec::new(),
    };
    for (flags, hash, value) in collected {
        body.insert_into(flags, hash, value)
            .map_err(|e| format!("failed to insert 0x{hash:08x}: {e}"))?;
    }

    Ok(Inibin { version, body: TroybinBody::V2(body) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ritoshark::io::Serialize;

    /// One property in every bucket the text layer can render.
    fn sample() -> Inibin {
        let mut body = TroybinV2 {
            strings_length: 0,
            flags_zero_prefix: false,
            buckets: Vec::new(),
        };
        let mut put = |flags, hash, value| body.insert_into(flags, hash, value).unwrap();
        put(InibinFlags::Int32List, 0x0000_0001, ScalarValue::I32(-42));
        put(InibinFlags::Float32List, 0x0000_0002, ScalarValue::F32(3.5));
        put(InibinFlags::BitList, 0x0000_0003, ScalarValue::Bool(true));
        put(InibinFlags::StringList, 0x0000_0004, ScalarValue::String(b"a \"b\" c".to_vec()));
        put(InibinFlags::Float32ListVec3, 0x0000_0005, ScalarValue::F32x3([1.0, 2.0, 3.0]));
        // Fixed-point buckets carry the stored byte, not a derived tenth.
        put(InibinFlags::FixedPointFloatList, 0x0000_0006, ScalarValue::U8(25));
        put(InibinFlags::Int16List, 0x0000_0007, ScalarValue::I16(-300));
        put(InibinFlags::Int8List, 0x0000_0008, ScalarValue::U8(200));
        put(InibinFlags::FixedPointFloatListVec2, 0x0000_0009, ScalarValue::U8x2([15, 25]));
        put(InibinFlags::FixedPointFloatListVec3, 0x0000_000a, ScalarValue::U8x3([5, 10, 15]));
        put(InibinFlags::FixedPointFloatListVec4, 0x0000_000b, ScalarValue::U8x4([10, 20, 30, 40]));
        put(InibinFlags::Float32ListVec2, 0x0000_000c, ScalarValue::F32x2([1.25, 2.5]));
        put(InibinFlags::Float32ListVec4, 0x0000_000d, ScalarValue::F32x4([1.0, 2.0, 3.0, 4.0]));
        Inibin { version: 2, body: TroybinBody::V2(body) }
    }

    #[test]
    fn round_trips_each_type() {
        let original = sample();
        let text = inibin_to_text(&original);
        let back = text_to_inibin(&text).expect("parse");

        assert_eq!(back.version, original.version);
        assert_eq!(back.entries(), original.entries());
        // Re-rendering what we parsed must reproduce the same text.
        assert_eq!(inibin_to_text(&back), text);
    }

    #[test]
    fn binary_round_trip_via_text() {
        let original = sample();
        let bin1 = original.to_bytes().expect("write1");
        let parsed = Inibin::from_slice(&bin1).expect("read1");
        let text = inibin_to_text(&parsed);
        let reparsed = text_to_inibin(&text).expect("text parse");
        let bin2 = reparsed.to_bytes().expect("write2");
        assert_eq!(bin1, bin2, "text edit round-trip must be byte-exact");
    }

    #[test]
    fn fixed_point_is_rendered_as_the_stored_byte() {
        let text = inibin_to_text(&sample());
        assert!(text.contains("0x00000006 = 25"), "expected the raw byte, got:\n{text}");
        assert!(text.contains("0x00000009 = { 15, 25 }"), "expected raw bytes, got:\n{text}");
    }

    #[test]
    fn section_names_map_both_ways() {
        for flags in InibinFlags::ALL {
            assert_eq!(section_flags(section_name(flags)), Some(flags));
        }
    }

    #[test]
    fn strings_survive_escaping() {
        let text = inibin_to_text(&sample());
        let parsed = text_to_inibin(&text).unwrap();
        assert_eq!(
            parsed.get_hash(0x0000_0004),
            Some(ScalarValue::String(b"a \"b\" c".to_vec())),
        );
    }

    #[test]
    fn rejects_unknown_sections_and_malformed_lines() {
        assert!(text_to_inibin("[NopeList]\n0x1 = 2").is_err());
        assert!(text_to_inibin("[Int32List]\n0x1").is_err());
        assert!(text_to_inibin("0x1 = 2").is_err());
    }
}
