/*!
Exercises the editor path against real shipped banks and packages, which is the only place the
things that actually broke show up: a header revision that must survive, a HIRC section that must
come back byte for byte, and a package whose entry names and dead slots have to be reproduced.

Real game audio is copyrighted and never committed, so every test skips when its fixture is
absent. Drop `.bnk` / `.wpk` samples in the path below to run them.
*/

use flint_formats::audio::bank::{self, Bank};
use ritoshark::audio::Wem;
use std::path::PathBuf;

fn fixture(name: &str) -> Option<Vec<u8>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../RitoShark-Crates/Sample-Files")
        .join(name);
    std::fs::read(path).ok()
}

const BANKS: &[&str] = &[
    "aatrox_base_sfx_audio.bnk",
    "aatrox_base_sfx_events.bnk",
    "bank_v134_audio.bnk",
    "bank_v134_bare.bnk",
    "bank_v134_events.bnk",
    "bank_v145_audio.bnk",
    "bank_v145_bare.bnk",
    "bank_v145_events.bnk",
    "audio_package_4.wpk",
    "audio_package_37.wpk",
];

#[test]
fn reading_and_writing_a_real_bank_is_byte_exact() {
    let mut checked = 0;
    for name in BANKS {
        let Some(original) = fixture(name) else {
            continue;
        };
        let parsed = Bank::parse(&original).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            parsed.to_bytes().unwrap(),
            original,
            "{name} must re-serialize byte for byte"
        );
        checked += 1;
    }
    eprintln!("round-tripped {checked} real banks");
}

#[test]
fn replacing_a_payload_with_itself_changes_nothing() {
    for name in BANKS {
        let Some(original) = fixture(name) else {
            continue;
        };
        let info = bank::info(&original).unwrap();
        let Some(entry) = info.entries.first() else {
            continue;
        };

        let payload = bank::read_entry(&original, entry.id).unwrap();
        let edited = bank::replace_entry(&original, entry.id, &payload).unwrap();

        assert_eq!(
            edited, original,
            "{name}: a no-op edit must not rewrite the file"
        );
    }
}

#[test]
fn an_edit_keeps_the_header_and_every_section_we_do_not_model() {
    for name in BANKS {
        let Some(original) = fixture(name) else {
            continue;
        };
        let before = bank::info(&original).unwrap();
        let Some(entry) = before.entries.first() else {
            continue;
        };

        let edited = bank::silence_entry(&original, entry.id).unwrap();
        let after = bank::info(&edited).unwrap();

        assert_eq!(after.version, before.version, "{name}: header revision");
        assert_eq!(after.has_hirc, before.has_hirc, "{name}: hierarchy");
        assert_eq!(
            after.entry_count, before.entry_count,
            "{name}: silencing must not drop entries"
        );

        if let (Bank::Bnk(a), Bank::Bnk(b)) =
            (Bank::parse(&edited).unwrap(), Bank::parse(&original).unwrap())
        {
            assert_eq!(a.bank_id(), b.bank_id(), "{name}: bank id");
            let untouched: Vec<_> = b
                .sections
                .iter()
                .filter(|s| s.tag != *b"DIDX" && s.tag != *b"DATA")
                .collect();
            for section in untouched {
                let same = a.sections.iter().find(|s| s.tag == section.tag);
                assert_eq!(
                    same.map(|s| &s.data),
                    Some(&section.data),
                    "{name}: section {} must survive verbatim",
                    String::from_utf8_lossy(&section.tag)
                );
            }
        }
    }
}

#[test]
fn every_embedded_payload_decodes() {
    for name in BANKS {
        let Some(original) = fixture(name) else {
            continue;
        };
        for entry in bank::info(&original).unwrap().entries {
            let payload = bank::read_entry(&original, entry.id).unwrap();
            bank::decode_wem(&payload)
                .unwrap_or_else(|e| panic!("{name}: entry {} did not decode: {e}", entry.id));
        }
    }
}

#[test]
fn a_replacement_lands_as_a_playable_wem() {
    let Some(original) = fixture("bank_v145_audio.bnk").or_else(|| fixture("bank_v134_audio.bnk"))
    else {
        return;
    };
    let entry = bank::info(&original).unwrap().entries[0].id;

    /* What the cutter and the volume dialog hand the backend: a 16-bit PCM WAV. */
    let mut wav = Vec::new();
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36u32 + 2048).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&44100u32.to_le_bytes());
    wav.extend_from_slice(&88200u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&2048u32.to_le_bytes());
    wav.extend_from_slice(&vec![0u8; 2048]);

    let edited = bank::replace_entry(&original, entry, &wav).unwrap();
    let stored = bank::read_entry(&edited, entry).unwrap();

    let wem = Wem::new(&stored).expect("a wav must be encoded into a real wem");
    assert_eq!(wem.format().sample_rate, 44100);
    bank::decode_wem(&stored).expect("and it must decode back");
}
