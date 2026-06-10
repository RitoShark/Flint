//! Minimal Adobe PSD writer: 8-bit RGBA layers organised into groups, RAW
//! (uncompressed) channel data. Ported from ag-psd's write path (see the
//! ground-tile stitcher plan / spec). Big-endian throughout. Only what we emit
//! is implemented — no masks, effects, text, RLE.

use image::RgbaImage;

/// A single image layer placed at (x, y) on the canvas.
pub struct PsdLayer {
    pub name: String,
    pub x: u32,
    pub y: u32,
    pub image: RgbaImage,
    pub visible: bool,
}

/// A group (folder) of layers. Groups are not nested in this writer.
pub struct PsdGroup {
    pub name: String,
    pub visible: bool,
    pub layers: Vec<PsdLayer>,
}

/// The document: canvas size + a flat list of top-level groups.
pub struct PsdDoc {
    pub width: u32,
    pub height: u32,
    pub groups: Vec<PsdGroup>,
}

fn w_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_be_bytes());
}
fn w_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}
fn w_i16(out: &mut Vec<u8>, v: i16) {
    out.extend_from_slice(&v.to_be_bytes());
}
fn w_i32(out: &mut Vec<u8>, v: i32) {
    out.extend_from_slice(&v.to_be_bytes());
}
fn w_sig(out: &mut Vec<u8>, s: &[u8; 4]) {
    out.extend_from_slice(s);
}

/// Pascal string: 1-byte len + ASCII bytes, then zero-pad so total len
/// (including the length byte) is a multiple of `pad_to`.
fn w_pascal(out: &mut Vec<u8>, s: &str, pad_to: usize) {
    let bytes: Vec<u8> = s
        .bytes()
        .take(255)
        .map(|b| if b < 128 { b } else { b'?' })
        .collect();
    out.push(bytes.len() as u8);
    out.extend_from_slice(&bytes);
    let mut total = 1 + bytes.len();
    while !total.is_multiple_of(pad_to) {
        out.push(0);
        total += 1;
    }
}

/// UTF-16 BE string with a u32 char-count prefix, no null terminator.
fn w_unicode(out: &mut Vec<u8>, s: &str) {
    let units: Vec<u16> = s.encode_utf16().collect();
    w_u32(out, units.len() as u32);
    for u in units {
        w_u16(out, u);
    }
}

/// Write a length-prefixed section: reserve u32, run `body`, pad the body to
/// `round`, then back-patch. `len_incl_pad` controls whether the patched length
/// counts the padding (matches ag-psd's writeTotalLength).
fn w_section(out: &mut Vec<u8>, round: usize, len_incl_pad: bool, body: impl FnOnce(&mut Vec<u8>)) {
    let len_pos = out.len();
    w_u32(out, 0);
    let start = out.len();
    body(out);
    let unpadded = out.len() - start;
    let mut padded = unpadded;
    while !padded.is_multiple_of(round) {
        out.push(0);
        padded += 1;
    }
    let patched = if len_incl_pad { padded } else { unpadded } as u32;
    out[len_pos..len_pos + 4].copy_from_slice(&patched.to_be_bytes());
}

// ============================================================================
// Document assembly
// ============================================================================

/// One layer as it appears in the file (groups are flattened into divider
/// markers). `img` is None for divider/marker layers.
struct FileLayer<'a> {
    name: String,
    x: u32,
    y: u32,
    img: Option<&'a RgbaImage>,
    visible: bool,
    lsct: Option<u32>, // section divider type: 1 open, 2 closed, 3 bounding
    lsct_has_key: bool, // folder markers carry 8BIM+'pass'+subType
}

/// Extract one 8-bit plane (offset 0=R,1=G,2=B,3=A) from an RGBA image, row-major.
fn plane(img: &RgbaImage, offset: usize) -> Vec<u8> {
    let raw = img.as_raw(); // RGBA8 interleaved
    let mut out = Vec::with_capacity((img.width() * img.height()) as usize);
    let mut i = offset;
    while i < raw.len() {
        out.push(raw[i]);
        i += 4;
    }
    out
}

/// Flatten the document's groups into the bottom-to-top file order ag-psd uses:
/// for each group -> [bounding divider (lsct 3)] ++ children ++ [folder marker].
fn flatten(doc: &PsdDoc) -> Vec<FileLayer<'_>> {
    let mut out = Vec::new();
    for g in &doc.groups {
        out.push(FileLayer {
            name: "</Layer group>".into(),
            x: 0,
            y: 0,
            img: None,
            visible: true,
            lsct: Some(3),
            lsct_has_key: false,
        });
        for l in &g.layers {
            out.push(FileLayer {
                name: l.name.clone(),
                x: l.x,
                y: l.y,
                img: Some(&l.image),
                visible: l.visible,
                lsct: None,
                lsct_has_key: false,
            });
        }
        out.push(FileLayer {
            name: g.name.clone(),
            x: 0,
            y: 0,
            img: None,
            visible: g.visible,
            lsct: Some(1),
            lsct_has_key: true,
        });
    }
    out
}

/// Channels for a layer in (id, data) order: A,R,G,B = -1,0,1,2.
/// Divider/marker layers (img None) emit 4 empty channels (length 2 each).
fn layer_channels(fl: &FileLayer) -> Vec<(i16, Option<Vec<u8>>)> {
    match fl.img {
        Some(img) => vec![
            (-1, Some(plane(img, 3))),
            (0, Some(plane(img, 0))),
            (1, Some(plane(img, 1))),
            (2, Some(plane(img, 2))),
        ],
        None => vec![(-1, None), (0, None), (1, None), (2, None)],
    }
}

fn w_additional_info(out: &mut Vec<u8>, fl: &FileLayer) {
    // luni (round 4, length incl pad): unicode name
    w_sig(out, b"8BIM");
    w_sig(out, b"luni");
    w_section(out, 4, true, |o| w_unicode(o, &fl.name));
    // lsct (round 2) for divider/marker layers
    if let Some(t) = fl.lsct {
        w_sig(out, b"8BIM");
        w_sig(out, b"lsct");
        let has_key = fl.lsct_has_key;
        w_section(out, 2, true, |o| {
            w_u32(o, t);
            if has_key {
                w_sig(o, b"8BIM");
                w_sig(o, b"pass"); // pass-through blend for the folder
                w_u32(o, 0); // subType
            }
        });
    }
}

fn w_layer_record(out: &mut Vec<u8>, fl: &FileLayer, chans: &[(i16, Option<Vec<u8>>)]) {
    let (top, left, bottom, right) = match fl.img {
        Some(img) => (
            fl.y as i32,
            fl.x as i32,
            (fl.y + img.height()) as i32,
            (fl.x + img.width()) as i32,
        ),
        None => (0, 0, 0, 0),
    };
    w_i32(out, top);
    w_i32(out, left);
    w_i32(out, bottom);
    w_i32(out, right);
    w_u16(out, chans.len() as u16);
    for (id, data) in chans {
        w_i16(out, *id);
        let len = 2 + data.as_ref().map(|d| d.len()).unwrap_or(0);
        w_u32(out, len as u32);
    }
    w_sig(out, b"8BIM");
    w_sig(out, b"norm");
    out.push(255); // opacity
    out.push(0); // clipping
    let mut flags = 0x08u8; // bit3 mandatory
    if !fl.visible {
        flags |= 0x02; // hidden
    }
    if fl.lsct.is_some() {
        flags |= 0x10; // divider/marker: pixel data irrelevant
    }
    out.push(flags);
    out.push(0); // filler
    // extra-data section (round 1)
    w_section(out, 1, true, |o| {
        w_u32(o, 0); // layer mask data: none
        w_u32(o, 0); // blending ranges: none
        w_pascal(o, &fl.name, 4);
        w_additional_info(o, fl);
    });
}

/// Serialize the document to PSD bytes.
pub fn write_psd(doc: &PsdDoc) -> Vec<u8> {
    let (w, h) = (doc.width, doc.height);
    let flat = flatten(doc);
    let all_chans: Vec<Vec<(i16, Option<Vec<u8>>)>> = flat.iter().map(layer_channels).collect();

    let mut out = Vec::new();
    // Header
    w_sig(&mut out, b"8BPS");
    w_u16(&mut out, 1); // version
    out.extend_from_slice(&[0u8; 6]);
    w_u16(&mut out, 4); // channels
    w_u32(&mut out, h);
    w_u32(&mut out, w);
    w_u16(&mut out, 8); // depth
    w_u16(&mut out, 3); // RGB
                        // Color mode data
    w_u32(&mut out, 0);
    // Image resources
    w_u32(&mut out, 0);
    // Layer and mask section (round 2)
    w_section(&mut out, 2, false, |lm| {
        // Layer info section (round 4, length incl pad)
        w_section(lm, 4, true, |li| {
            w_i16(li, -(flat.len() as i16)); // negative: has alpha
            for (fl, chans) in flat.iter().zip(all_chans.iter()) {
                w_layer_record(li, fl, chans);
            }
            // channel image data
            for chans in all_chans.iter() {
                for (_id, data) in chans {
                    w_u16(li, 0); // RAW
                    if let Some(d) = data {
                        li.extend_from_slice(d);
                    }
                }
            }
        });
        // Global layer mask info
        w_u32(lm, 0);
    });
    // Composite image data (to EOF): RAW, R,G,B,A planes. A blank composite is
    // structurally valid; editors regenerate it from the layers anyway.
    w_u16(&mut out, 0); // RAW
    let blank = vec![0u8; (w * h) as usize];
    for _ in 0..4 {
        out.extend_from_slice(&blank);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pascal_pads_to_4() {
        let mut o = Vec::new();
        w_pascal(&mut o, "ab", 4); // 1 len + 2 + pad -> 4
        assert_eq!(o.len(), 4);
        assert_eq!(o[0], 2);
    }

    #[test]
    fn unicode_be_count() {
        let mut o = Vec::new();
        w_unicode(&mut o, "Hi");
        assert_eq!(&o[0..4], &[0, 0, 0, 2]); // count = 2
        assert_eq!(&o[4..8], &[0, b'H', 0, b'i']);
    }

    #[test]
    fn roundtrip_two_layers_one_group() {
        use image::{Rgba, RgbaImage};
        let mut a = RgbaImage::new(4, 4);
        for p in a.pixels_mut() {
            *p = Rgba([10, 20, 30, 255]);
        }
        let mut b = RgbaImage::new(4, 4);
        for p in b.pixels_mut() {
            *p = Rgba([40, 50, 60, 128]);
        }
        let doc = PsdDoc {
            width: 4,
            height: 4,
            groups: vec![PsdGroup {
                name: "Base".into(),
                visible: true,
                layers: vec![
                    PsdLayer { name: "tileA".into(), x: 0, y: 0, image: a, visible: true },
                    PsdLayer { name: "tileB".into(), x: 0, y: 0, image: b, visible: false },
                ],
            }],
        };
        let bytes = write_psd(&doc);
        std::fs::write(std::env::temp_dir().join("flint_psd_rt.psd"), &bytes).unwrap();

        let parsed = psd::Psd::from_bytes(&bytes).expect("psd parses");
        assert_eq!(parsed.width(), 4);
        assert_eq!(parsed.height(), 4);
        let names: Vec<String> = parsed
            .layers()
            .iter()
            .map(|l| l.name().to_string())
            .collect();
        assert!(names.iter().any(|n| n == "tileA"), "layers: {names:?}");
        assert!(names.iter().any(|n| n == "tileB"), "layers: {names:?}");
    }
}
