/*!
The BNK/WPK container layer, backed by `ritoshark::audio`.

Every edit modifies the parsed container instead of rebuilding it, so a bank keeps its header
revision, its bank id, its object hierarchy and every section this app does not model, and a
package keeps its entry names, its slot order and its dead slots. Rebuilding on each edit is what
produces a file the engine cannot load even though the audio inside it is fine.

Replacement audio arrives from the UI as a PCM WAV, which Wwise cannot play. It is encoded to a
real `.wem` here; a file that already parses as one is embedded verbatim instead.
*/

use ritoshark::audio::{
    AudioFormat, Bnk, PcmAudio, Wem, WemCodec, Wpk, encode_vorbis, encode_vorbis_like,
};
use ritoshark::prelude::{Parse, Serialize};
use serde::{Deserialize, Serialize as SerdeSerialize};

const HIRC: [u8; 4] = *b"HIRC";

/// Vorbis convention: -0.2 worst, 1.0 best. 0.5 is the crate's documented default.
const VORBIS_QUALITY: f32 = 0.5;

#[derive(Debug, Clone, SerdeSerialize, Deserialize)]
pub struct AudioEntryInfo {
    pub id: u32,
    pub size: u32,
}

#[derive(Debug, Clone, SerdeSerialize, Deserialize)]
pub struct AudioBankInfo {
    pub format: String,
    pub version: u32,
    pub entry_count: usize,
    pub entries: Vec<AudioEntryInfo>,
    pub has_hirc: bool,
}

/// A decoded `.wem` as bytes the browser can play, plus the rate needed to interpret them.
#[derive(Debug, Clone, SerdeSerialize, Deserialize)]
pub struct DecodedAudio {
    pub data: Vec<u8>,
    /// `"ogg"` or `"wav"`.
    pub format: String,
    pub sample_rate: Option<u32>,
}

/// Either Wwise container, parsed. Both hold `.wem` payloads addressed by a numeric id.
pub enum Bank {
    Bnk(Bnk),
    Wpk(Wpk),
}

impl Bank {
    pub fn parse(data: &[u8]) -> Result<Self, String> {
        match data.get(..4) {
            Some(b"BKHD") => Bnk::from_bytes(data)
                .map(Self::Bnk)
                .map_err(|e| format!("Failed to parse BNK: {e}")),
            Some(b"r3d2") => Wpk::from_bytes(data)
                .map(Self::Wpk)
                .map_err(|e| format!("Failed to parse WPK: {e}")),
            Some(magic) => Err(format!(
                "Unknown audio format (magic: {:02X}{:02X}{:02X}{:02X})",
                magic[0], magic[1], magic[2], magic[3]
            )),
            None => Err("File too small to detect format".into()),
        }
    }

    /** The entry list the editor shows.

    A WPK entry whose name is not `"<id>.wem"` has no id to address it by, so it is left out
    rather than listed under a placeholder the edit commands could never resolve. */
    pub fn info(&self) -> AudioBankInfo {
        let (format, version, entries, has_hirc) = match self {
            Self::Bnk(bnk) => (
                "bnk",
                bnk.version().unwrap_or(0),
                bnk.wems()
                    .into_iter()
                    .map(|(id, data)| AudioEntryInfo {
                        id,
                        size: data.len() as u32,
                    })
                    .collect::<Vec<_>>(),
                bnk.sections.iter().any(|s| s.tag == HIRC),
            ),
            Self::Wpk(wpk) => (
                "wpk",
                wpk.version,
                wpk.wems()
                    .into_iter()
                    .filter_map(|(id, _, data)| {
                        Some(AudioEntryInfo {
                            id: id?,
                            size: data.len() as u32,
                        })
                    })
                    .collect::<Vec<_>>(),
                false,
            ),
        };

        AudioBankInfo {
            format: format.into(),
            version,
            entry_count: entries.len(),
            entries,
            has_hirc,
        }
    }

    pub fn entry(&self, id: u32) -> Result<&[u8], String> {
        match self {
            Self::Bnk(bnk) => bnk.wem(id),
            Self::Wpk(wpk) => wpk.wem(id),
        }
        .ok_or_else(|| format!("Audio entry {id} not found"))
    }

    pub fn replace(&mut self, id: u32, payload: Vec<u8>) -> Result<(), String> {
        match self {
            Self::Bnk(bnk) => bnk.replace_wem(id, payload),
            Self::Wpk(wpk) => wpk.replace_wem(id, payload),
        }
        .map_err(|e| format!("Failed to replace entry {id}: {e}"))
    }

    /** Mutes an entry while keeping its id, its sample rate and its channel count, so every
    event, action and container still resolves to something the engine can mix. */
    pub fn silence(&mut self, id: u32) -> Result<(), String> {
        match self {
            Self::Bnk(bnk) => bnk.silence_wem(id),
            Self::Wpk(wpk) => wpk.silence_wem(id),
        }
        .map_err(|e| format!("Failed to silence entry {id}: {e}"))
    }

    pub fn remove(&mut self, id: u32) -> Result<(), String> {
        match self {
            Self::Bnk(bnk) => bnk.remove_wem(id),
            Self::Wpk(wpk) => wpk.remove_wem(id),
        }
        .map_err(|e| format!("Failed to remove entry {id}: {e}"))
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, String> {
        match self {
            Self::Bnk(bnk) => bnk.to_bytes(),
            Self::Wpk(wpk) => wpk.to_bytes(),
        }
        .map_err(|e| format!("Failed to serialize audio bank: {e}"))
    }
}

pub fn info(data: &[u8]) -> Result<AudioBankInfo, String> {
    Ok(Bank::parse(data)?.info())
}

pub fn read_entry(data: &[u8], id: u32) -> Result<Vec<u8>, String> {
    Ok(Bank::parse(data)?.entry(id)?.to_vec())
}

pub fn replace_entry(data: &[u8], id: u32, payload: &[u8]) -> Result<Vec<u8>, String> {
    let mut bank = Bank::parse(data)?;
    // The sound being replaced is the encoder's header template, so the new one
    // matches a file the engine already loads.
    let encoded = to_wem(payload, Some(bank.entry(id)?))?;
    bank.replace(id, encoded)?;
    bank.to_bytes()
}

pub fn silence_entry(data: &[u8], id: u32) -> Result<Vec<u8>, String> {
    let mut bank = Bank::parse(data)?;
    bank.silence(id)?;
    bank.to_bytes()
}

pub fn remove_entry(data: &[u8], id: u32) -> Result<Vec<u8>, String> {
    let mut bank = Bank::parse(data)?;
    bank.remove(id)?;
    bank.to_bytes()
}

/// Decodes a `.wem` to a playable stream — Ogg for Wwise Vorbis, WAV for PCM.
pub fn decode_wem(data: &[u8]) -> Result<DecodedAudio, String> {
    let decoded = Wem::new(data)
        .and_then(|wem| wem.decode())
        .map_err(|e| format!("Failed to decode WEM: {e}"))?;

    Ok(DecodedAudio {
        data: decoded.data,
        format: match decoded.format {
            AudioFormat::Ogg => "ogg",
            AudioFormat::Wav => "wav",
        }
        .into(),
        sample_rate: Some(decoded.sample_rate),
    })
}

/** Turns whatever the user picked into an embeddable `.wem`.

Anything that already parses as one is embedded verbatim, which keeps a `.wem` taken out of
another bank bit-identical. Everything else has to be a PCM WAV and is encoded to Wwise Vorbis —
the one codec the game demonstrably plays, and comparable in size to what it replaces.

`reference` is the payload being replaced, when there is one. Its header supplies the fields the
encoder cannot derive, so the result matches a file the engine already loads. */
pub fn to_wem(data: &[u8], reference: Option<&[u8]>) -> Result<Vec<u8>, String> {
    if Wem::new(data).is_ok() {
        return Ok(data.to_vec());
    }

    let pcm = read_pcm_wav(data)?;

    // A template is only usable if the reference really is Wwise Vorbis; League
    // ships nothing else, but a bank holding PCM would otherwise fail outright.
    let template = reference.filter(|bytes| {
        Wem::new(bytes).is_ok_and(|wem| wem.format().codec == WemCodec::Vorbis)
    });

    match template {
        Some(bytes) => encode_vorbis_like(bytes, &pcm, VORBIS_QUALITY),
        None => encode_vorbis(&pcm, VORBIS_QUALITY),
    }
    .map_err(|e| format!("Failed to encode WEM: {e}"))
}

fn le_u16(data: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([data[at], data[at + 1]])
}

fn le_u32(data: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]])
}

/** Reads a plain PCM WAV into interleaved 16-bit samples.

`rs_audio` deliberately stops at PCM samples rather than reading user audio files, so this is
where the app meets it. Wwise wants 16-bit, and everything a normal editor exports — 8, 24 and
32-bit integer, and 32-bit float — is narrowed to that here. */
fn read_pcm_wav(data: &[u8]) -> Result<PcmAudio, String> {
    if data.len() < 12 || &data[..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return Err(
            "Unsupported file: expected a RIFF/WAVE container. Convert MP3/OGG/FLAC to PCM WAV \
             first (Audacity, ffmpeg, or any audio editor)."
                .into(),
        );
    }

    let mut fmt: Option<&[u8]> = None;
    let mut body: Option<&[u8]> = None;
    let mut at = 12usize;

    while at + 8 <= data.len() {
        let len = le_u32(data, at + 4) as usize;
        let start = at + 8;
        let end = start
            .checked_add(len)
            .filter(|end| *end <= data.len())
            .ok_or("WAV chunk runs past the end of the file")?;

        match &data[at..at + 4] {
            b"fmt " => fmt = Some(&data[start..end]),
            b"data" => body = Some(&data[start..end]),
            _ => {}
        }

        /* RIFF pads odd-length chunks to a two-byte boundary. */
        at = end + (end & 1);
    }

    let fmt = fmt.ok_or("WAV has no fmt chunk")?;
    let body = body.ok_or("WAV has no data chunk")?;
    if fmt.len() < 16 {
        return Err("WAV fmt chunk is too short".into());
    }

    let channels = le_u16(fmt, 2);
    let sample_rate = le_u32(fmt, 4);
    let bits = le_u16(fmt, 14);

    /* WAVE_FORMAT_EXTENSIBLE hides the real codec in the first two bytes of its sub-format GUID. */
    let tag = match le_u16(fmt, 0) {
        0xFFFE if fmt.len() >= 26 => le_u16(fmt, 24),
        other => other,
    };

    if channels == 0 || sample_rate == 0 {
        return Err("WAV declares no channels or no sample rate".into());
    }

    let samples: Vec<i16> = match (tag, bits) {
        (1, 8) => body.iter().map(|&b| (b as i16 - 128) << 8).collect(),
        (1, 16) => body.chunks_exact(2).map(|s| le_u16(s, 0) as i16).collect(),
        (1, 24) => body.chunks_exact(3).map(|s| le_u16(s, 1) as i16).collect(),
        (1, 32) => body.chunks_exact(4).map(|s| le_u16(s, 2) as i16).collect(),
        (3, 32) => body
            .chunks_exact(4)
            .map(|s| {
                let v = f32::from_le_bytes([s[0], s[1], s[2], s[3]]).clamp(-1.0, 1.0);
                (v * i16::MAX as f32) as i16
            })
            .collect(),
        _ => {
            return Err(format!(
                "Unsupported WAV encoding (format {tag}, {bits}-bit). Export as 16-bit PCM WAV."
            ));
        }
    };

    if samples.is_empty() {
        return Err("WAV contains no samples".into());
    }

    Ok(PcmAudio::new(sample_rate, channels, samples))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(bits: u16, tag: u16, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + body.len() as u32).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&tag.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes()); // channels
        out.extend_from_slice(&44100u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes()); // byte rate
        out.extend_from_slice(&0u16.to_le_bytes()); // block align
        out.extend_from_slice(&bits.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(body);
        out
    }

    fn bank_with_one_wem() -> Vec<u8> {
        let mut bnk = Bnk::new();
        bnk.sections.push(ritoshark::audio::BnkSection {
            tag: *b"BKHD",
            data: vec![0x91, 0, 0, 0, 0xEF, 0xBE, 0xAD, 0xDE],
        });
        bnk.sections.push(ritoshark::audio::BnkSection {
            tag: HIRC,
            data: vec![0, 0, 0, 0],
        });
        bnk.insert_wem(100, ritoshark::audio::silence(44100, 1, 256).unwrap())
            .unwrap();
        bnk.to_bytes().unwrap()
    }

    #[test]
    fn editing_a_bank_keeps_its_header_and_hierarchy() {
        let original = bank_with_one_wem();
        let replacement = wav(16, 1, &[0u8; 512]);

        let edited = replace_entry(&original, 100, &replacement).unwrap();
        let parsed = Bank::parse(&edited).unwrap();
        let Bank::Bnk(bnk) = &parsed else {
            panic!("still a bnk");
        };

        assert_eq!(bnk.version(), Some(0x91), "header revision must survive");
        assert_eq!(bnk.bank_id(), Some(0xDEADBEEF), "bank id must survive");
        assert!(
            bnk.sections.iter().any(|s| s.tag == HIRC),
            "the object hierarchy must survive an edit"
        );
        assert!(parsed.info().has_hirc);
    }

    #[test]
    fn a_replacement_is_stored_as_a_wem_not_as_the_wav_that_came_in() {
        let original = bank_with_one_wem();
        let replacement = wav(16, 1, &[0u8; 512]);

        let edited = replace_entry(&original, 100, &replacement).unwrap();
        let stored = read_entry(&edited, 100).unwrap();

        assert_ne!(stored, replacement, "the raw WAV must not be embedded");
        Wem::new(&stored).expect("what lands in the bank must parse as a wem");
    }

    #[test]
    fn silencing_keeps_the_entry_addressable() {
        let original = bank_with_one_wem();
        let edited = silence_entry(&original, 100).unwrap();

        let info = info(&edited).unwrap();
        assert_eq!(info.entries.len(), 1);
        assert_eq!(info.entries[0].id, 100, "the id must outlive the audio");
    }

    #[test]
    fn an_existing_wem_is_embedded_verbatim() {
        let wem = ritoshark::audio::silence(32000, 2, 64).unwrap();
        assert_eq!(to_wem(&wem, None).unwrap(), wem);
    }

    #[test]
    fn float_and_integer_wavs_both_convert() {
        for candidate in [wav(16, 1, &[0u8; 512]), wav(32, 3, &[0u8; 1024])] {
            let wem = to_wem(&candidate, None).unwrap();
            let decoded = Wem::new(&wem).unwrap().to_pcm().unwrap();
            assert_eq!(decoded.sample_rate, 44100);
        }
    }

    #[test]
    fn a_replacement_is_encoded_as_wwise_vorbis_not_pcm() {
        // PCM is several times larger and League ships none of it, so encoding a
        // replacement as PCM would be both bloated and unproven in-game.
        let wem = to_wem(&wav(16, 1, &[0u8; 4096]), None).unwrap();
        assert_eq!(Wem::new(&wem).unwrap().format().codec, WemCodec::Vorbis);
    }

    #[test]
    fn a_non_wav_is_rejected_rather_than_embedded() {
        assert!(to_wem(b"ID3\x04not audio we can read", None).is_err());
    }

    #[test]
    fn editing_a_missing_id_is_an_error() {
        let original = bank_with_one_wem();
        assert!(silence_entry(&original, 999).is_err());
        assert!(remove_entry(&original, 999).is_err());
    }
}
