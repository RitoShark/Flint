//! `InibinFile` <-> INI-style text, grouped by storage bucket. The bucket name on
//! each `[Section]` determines the value type, so the text round-trips exactly:
//! `text_to_inibin(inibin_to_text(f)) == f` for any v2 file.

use ltk_inibin::{InibinFile, InibinFlags, InibinValue};

fn section_name(flags: InibinFlags) -> &'static str {
    match flags {
        InibinFlags::Int32List => "Int32List",
        InibinFlags::Float32List => "Float32List",
        InibinFlags::FixedPointFloatList => "FixedPointFloatList",
        InibinFlags::Int16List => "Int16List",
        InibinFlags::Int8List => "Int8List",
        InibinFlags::BitList => "BitList",
        InibinFlags::FixedPointFloatListVec3 => "FixedPointFloatListVec3",
        InibinFlags::Float32ListVec3 => "Float32ListVec3",
        InibinFlags::FixedPointFloatListVec2 => "FixedPointFloatListVec2",
        InibinFlags::Float32ListVec2 => "Float32ListVec2",
        InibinFlags::FixedPointFloatListVec4 => "FixedPointFloatListVec4",
        InibinFlags::Float32ListVec4 => "Float32ListVec4",
        InibinFlags::StringList => "StringList",
        InibinFlags::Int32LongList => "Int32LongList",
        InibinFlags::OldFormat => "OldFormat",
    }
}

fn section_flags(name: &str) -> Option<InibinFlags> {
    Some(match name {
        "Int32List" => InibinFlags::Int32List,
        "Float32List" => InibinFlags::Float32List,
        "FixedPointFloatList" => InibinFlags::FixedPointFloatList,
        "Int16List" => InibinFlags::Int16List,
        "Int8List" => InibinFlags::Int8List,
        "BitList" => InibinFlags::BitList,
        "FixedPointFloatListVec3" => InibinFlags::FixedPointFloatListVec3,
        "Float32ListVec3" => InibinFlags::Float32ListVec3,
        "FixedPointFloatListVec2" => InibinFlags::FixedPointFloatListVec2,
        "Float32ListVec2" => InibinFlags::Float32ListVec2,
        "FixedPointFloatListVec4" => InibinFlags::FixedPointFloatListVec4,
        "Float32ListVec4" => InibinFlags::Float32ListVec4,
        "StringList" => InibinFlags::StringList,
        "Int32LongList" => InibinFlags::Int32LongList,
        "OldFormat" => InibinFlags::OldFormat,
        _ => return None,
    })
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

fn fmt_floats(vals: &[f64]) -> String {
    let parts: Vec<String> = vals.iter().map(|v| v.to_string()).collect();
    format!("{{ {} }}", parts.join(", "))
}

fn fmt_f32s(vals: &[f32]) -> String {
    let parts: Vec<String> = vals.iter().map(|v| v.to_string()).collect();
    format!("{{ {} }}", parts.join(", "))
}

fn value_to_text(v: &InibinValue) -> String {
    match v {
        InibinValue::I32(x) => x.to_string(),
        InibinValue::F32(x) => x.to_string(),
        InibinValue::FixedPointFloat(x) => x.to_string(),
        InibinValue::I16(x) => x.to_string(),
        InibinValue::U8(x) => x.to_string(),
        InibinValue::Bool(x) => x.to_string(),
        InibinValue::FixedPointVec3(a) => fmt_floats(a),
        InibinValue::F32Vec3(a) => fmt_f32s(a),
        InibinValue::FixedPointVec2(a) => fmt_floats(a),
        InibinValue::F32Vec2(a) => fmt_f32s(a),
        InibinValue::FixedPointVec4(a) => fmt_floats(a),
        InibinValue::F32Vec4(a) => fmt_f32s(a),
        InibinValue::String(s) => escape(s),
    }
}

fn parse_floats(s: &str, n: usize) -> Result<Vec<f64>, String> {
    let inner = s.trim().strip_prefix('{').and_then(|x| x.strip_suffix('}'))
        .ok_or_else(|| format!("vector value not braced: {s}"))?;
    let parts: Vec<&str> = inner.split(',').map(|p| p.trim()).filter(|p| !p.is_empty()).collect();
    if parts.len() != n {
        return Err(format!("expected {n} components, got {}: {s}", parts.len()));
    }
    parts.iter().map(|p| p.parse::<f64>().map_err(|e| format!("bad float '{p}': {e}"))).collect()
}

fn parse_value(flags: InibinFlags, raw: &str) -> Result<InibinValue, String> {
    let r = raw.trim();
    Ok(match flags {
        InibinFlags::Int32List | InibinFlags::Int32LongList =>
            InibinValue::I32(r.parse().map_err(|e| format!("bad i32 '{r}': {e}"))?),
        InibinFlags::Float32List =>
            InibinValue::F32(r.parse().map_err(|e| format!("bad f32 '{r}': {e}"))?),
        InibinFlags::FixedPointFloatList =>
            InibinValue::FixedPointFloat(r.parse().map_err(|e| format!("bad f64 '{r}': {e}"))?),
        InibinFlags::Int16List =>
            InibinValue::I16(r.parse().map_err(|e| format!("bad i16 '{r}': {e}"))?),
        InibinFlags::Int8List =>
            InibinValue::U8(r.parse().map_err(|e| format!("bad u8 '{r}': {e}"))?),
        InibinFlags::BitList =>
            InibinValue::Bool(r.parse().map_err(|e| format!("bad bool '{r}': {e}"))?),
        InibinFlags::FixedPointFloatListVec3 => {
            let v = parse_floats(r, 3)?; InibinValue::FixedPointVec3([v[0], v[1], v[2]])
        }
        InibinFlags::Float32ListVec3 => {
            let v = parse_floats(r, 3)?; InibinValue::F32Vec3([v[0] as f32, v[1] as f32, v[2] as f32])
        }
        InibinFlags::FixedPointFloatListVec2 => {
            let v = parse_floats(r, 2)?; InibinValue::FixedPointVec2([v[0], v[1]])
        }
        InibinFlags::Float32ListVec2 => {
            let v = parse_floats(r, 2)?; InibinValue::F32Vec2([v[0] as f32, v[1] as f32])
        }
        InibinFlags::FixedPointFloatListVec4 => {
            let v = parse_floats(r, 4)?; InibinValue::FixedPointVec4([v[0], v[1], v[2], v[3]])
        }
        InibinFlags::Float32ListVec4 => {
            let v = parse_floats(r, 4)?; InibinValue::F32Vec4([v[0] as f32, v[1] as f32, v[2] as f32, v[3] as f32])
        }
        InibinFlags::StringList | InibinFlags::OldFormat => InibinValue::String(unescape(r)?),
    })
}

/// Render an `InibinFile` as INI-style text. The first line records the version.
pub fn inibin_to_text(file: &InibinFile) -> String {
    let mut out = String::new();
    out.push_str(&format!("# inibin v{}\n", file.version()));
    for set in file.sets() {
        out.push_str(&format!("\n[{}]\n", section_name(set.flags())));
        for (hash, value) in set.iter() {
            out.push_str(&format!("0x{:08x} = {}\n", hash, value_to_text(value)));
        }
    }
    out
}

/// Parse INI-style text back into an `InibinFile`.
pub fn text_to_inibin(text: &str) -> Result<InibinFile, String> {
    let mut file = InibinFile::new();
    let mut current: Option<InibinFlags> = None;
    for (lineno, raw_line) in text.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            if let Some(rest) = line.strip_prefix("# inibin v") {
                if let Ok(v) = rest.trim().parse::<u8>() { file.set_version(v); }
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
        file.add_value(hash, value, flags);
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_each_type() {
        let mut f = InibinFile::new();
        // Already-covered variants
        f.add_value(0x0000_0001, InibinValue::I32(-42), InibinFlags::Int32List);
        f.add_value(0x0000_0002, InibinValue::F32(3.5), InibinFlags::Float32List);
        f.add_value(0x0000_0003, InibinValue::Bool(true), InibinFlags::BitList);
        f.add_value(0x0000_0004, InibinValue::String("a \"b\" c".into()), InibinFlags::StringList);
        f.add_value(0x0000_0005, InibinValue::F32Vec3([1.0, 2.0, 3.0]), InibinFlags::Float32ListVec3);
        // 8 previously-missing variants
        f.add_value(0x0000_0006, InibinValue::FixedPointFloat(2.5), InibinFlags::FixedPointFloatList);
        f.add_value(0x0000_0007, InibinValue::I16(-300), InibinFlags::Int16List);
        f.add_value(0x0000_0008, InibinValue::U8(200), InibinFlags::Int8List);
        f.add_value(0x0000_0009, InibinValue::FixedPointVec2([1.5, 2.5]), InibinFlags::FixedPointFloatListVec2);
        f.add_value(0x0000_000a, InibinValue::FixedPointVec3([0.5, 1.0, 1.5]), InibinFlags::FixedPointFloatListVec3);
        f.add_value(0x0000_000b, InibinValue::FixedPointVec4([1.0, 2.0, 3.0, 4.0]), InibinFlags::FixedPointFloatListVec4);
        f.add_value(0x0000_000c, InibinValue::F32Vec2([1.25, 2.5]), InibinFlags::Float32ListVec2);
        f.add_value(0x0000_000d, InibinValue::F32Vec4([1.0, 2.0, 3.0, 4.0]), InibinFlags::Float32ListVec4);

        let text = inibin_to_text(&f);
        let back = text_to_inibin(&text).expect("parse");
        assert_eq!(back.get(0x0000_0001), Some(&InibinValue::I32(-42)));
        assert_eq!(back.get(0x0000_0002), Some(&InibinValue::F32(3.5)));
        assert_eq!(back.get(0x0000_0003), Some(&InibinValue::Bool(true)));
        assert_eq!(back.get(0x0000_0004), Some(&InibinValue::String("a \"b\" c".into())));
        assert_eq!(back.get(0x0000_0005), Some(&InibinValue::F32Vec3([1.0, 2.0, 3.0])));
        assert_eq!(back.get(0x0000_0006), Some(&InibinValue::FixedPointFloat(2.5)));
        assert_eq!(back.get(0x0000_0007), Some(&InibinValue::I16(-300)));
        assert_eq!(back.get(0x0000_0008), Some(&InibinValue::U8(200)));
        assert_eq!(back.get(0x0000_0009), Some(&InibinValue::FixedPointVec2([1.5, 2.5])));
        assert_eq!(back.get(0x0000_000a), Some(&InibinValue::FixedPointVec3([0.5, 1.0, 1.5])));
        assert_eq!(back.get(0x0000_000b), Some(&InibinValue::FixedPointVec4([1.0, 2.0, 3.0, 4.0])));
        assert_eq!(back.get(0x0000_000c), Some(&InibinValue::F32Vec2([1.25, 2.5])));
        assert_eq!(back.get(0x0000_000d), Some(&InibinValue::F32Vec4([1.0, 2.0, 3.0, 4.0])));
    }

    #[test]
    fn binary_round_trip_via_text() {
        let mut f = InibinFile::new();
        f.add_value(0x1234_5678, InibinValue::I32(7), InibinFlags::Int32List);
        f.add_value(0x90ab_cdef, InibinValue::String("hello".into()), InibinFlags::StringList);
        f.add_value(0xaaaa_0001, InibinValue::F32(1.5), InibinFlags::Float32List);
        f.add_value(0xbbbb_0002, InibinValue::Bool(true), InibinFlags::BitList);

        let mut bin1 = Vec::new();
        ltk_inibin::write(&mut bin1, &f).expect("write1");
        let parsed = ltk_inibin::from_slice(&bin1).expect("read1");
        let text = inibin_to_text(&parsed);
        let reparsed = text_to_inibin(&text).expect("text parse");
        let mut bin2 = Vec::new();
        ltk_inibin::write(&mut bin2, &reparsed).expect("write2");
        assert_eq!(bin1, bin2);
    }
}
