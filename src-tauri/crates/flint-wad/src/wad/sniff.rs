//! Fallback format detection for chunks `ritoshark::file::detect` returns
//! `Unknown` for.
//!
//! Deliberately generic formats only — fonts, images, web assets. League
//! formats belong upstream in `rs_file`, not here.

/// A recognised generic format's extension, or `None`.
///
/// Signature order matters: specific magic first, `json` last, because `{`/`[`
/// is broad enough to claim arbitrary text if it runs early.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    const SIGNATURES: &[(&[u8], &str)] = &[
        (b"OggS", "ogg"),
        (b"OTTO\0", "otf"),
        (&[0x00, 0x01, 0x00, 0x00], "ttf"),
        (b"true", "ttf"),
        (&[0x1a, 0x45, 0xdf, 0xa3], "webm"),
        (b"<svg", "svg"),
        (b"\"use strict\";", "min.js"),
        (b"<template ", "template.html"),
        (b"<!-- Elements -->", "template.html"),
        (&[0x89, b'P', b'N', b'G'], "png"),
        (&[0xff, 0xd8, 0xff], "jpg"),
        (&[0x1f, 0x8b], "gz"),
        (&[0x28, 0xb5, 0x2f, 0xfd], "zst"),
    ];

    for (magic, ext) in SIGNATURES {
        if bytes.starts_with(magic) {
            return Some(ext);
        }
    }

    // RIFF fronts WAV and AVI too, so the WEBP tag at offset 8 is what
    // actually identifies it.
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }

    if looks_like_json(bytes) {
        return Some("json");
    }

    None
}

/// `{`/`[` after optional whitespace, and the whole slice is valid UTF-8.
///
/// The UTF-8 requirement is what stops a binary chunk that happens to begin
/// with `{` from being claimed.
fn looks_like_json(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    matches!(text.trim_start().as_bytes().first(), Some(b'{') | Some(b'['))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_each_generic_format() {
        let cases: &[(&[u8], &str)] = &[
            (b"OggS\x00\x02", "ogg"),
            (&[0x00, 0x01, 0x00, 0x00, 0x00, 0x0c], "ttf"),
            (b"true\x00\x09", "ttf"),
            (b"OTTO\x00\x0a\x00\x80", "otf"),
            (&[0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00], "webm"),
            (b"<svg xmlns=\"http://www.w3.org/2000/svg\">", "svg"),
            (b"\"use strict\";var a=1", "min.js"),
            (b"<template id=\"x\">", "template.html"),
            (b"<!-- Elements -->\n<div>", "template.html"),
            (&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a], "png"),
            (&[0xff, 0xd8, 0xff, 0xe0], "jpg"),
            (b"RIFF\x24\x00\x00\x00WEBPVP8 ", "webp"),
            (&[0x1f, 0x8b, 0x08, 0x00], "gz"),
            (&[0x28, 0xb5, 0x2f, 0xfd, 0x00], "zst"),
        ];

        for (bytes, expected) in cases {
            assert_eq!(sniff(bytes), Some(*expected), "failed on {:?}", expected);
        }
    }

    #[test]
    fn recognises_json_objects_and_arrays() {
        assert_eq!(sniff(b"{\"a\":1}"), Some("json"));
        assert_eq!(sniff(b"[1,2,3]"), Some("json"));
        // Leading whitespace is normal in pretty-printed JSON.
        assert_eq!(sniff(b"\n  {\"a\":1}"), Some("json"));
    }

    #[test]
    fn json_does_not_swallow_other_text() {
        // `{`/`[` is the broadest signature here, so it must be tested last
        // and must not claim arbitrary text. A wrong extension is worse than
        // `.ltk` — it routes the file into an editor that cannot parse it.
        assert_eq!(sniff(b"PreLoadBuildingBlocks = {"), None);
        assert_eq!(sniff(b"hello world"), None);
        assert_eq!(sniff(b"<html><body>"), None);
    }

    #[test]
    fn json_rejects_invalid_utf8() {
        // A binary blob that happens to start with `{`.
        assert_eq!(sniff(&[b'{', 0xff, 0xfe, 0x00]), None);
    }

    #[test]
    fn a_riff_that_is_not_webp_is_not_claimed() {
        // RIFF also fronts WAV and AVI; only WEBP at offset 8 is ours.
        assert_eq!(sniff(b"RIFF\x24\x00\x00\x00WAVEfmt "), None);
    }

    #[test]
    fn short_and_empty_slices_are_none_not_panics() {
        assert_eq!(sniff(&[]), None);
        assert_eq!(sniff(b"O"), None);
        assert_eq!(sniff(b"RIFF"), None);
        assert_eq!(sniff(&[0x89, b'P']), None);
    }
}
