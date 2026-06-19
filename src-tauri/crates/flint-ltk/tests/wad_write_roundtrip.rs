//! Round-trip test for the WAD writer: write_wad → write to disk → parse TOC →
//! read+decompress each chunk → compare to the original bytes. This is the exact
//! real save/read path; guards against the offset/size/compression-flag
//! corruption seen after the save parallelization.

use flint_ltk::wad_jade::reader::read_wad_toc;
use flint_ltk::wad_jade::read_chunk_decompressed_bytes;
use flint_ltk::wad_jade::writer::{write_wad, EntryToWrite};

fn make_entries() -> Vec<(u64, Vec<u8>)> {
    let mut v = Vec::new();
    // Small (< 512) → stored uncompressed.
    v.push((0x10u64, vec![1u8, 2, 3, 4, 5]));
    // Highly compressible large blob → zstd.
    v.push((0x20u64, vec![0xABu8; 50_000]));
    // Incompressible-ish large blob (pseudo-random) → likely stored raw.
    let mut prng = 0x1234_5678u32;
    let rnd: Vec<u8> = (0..40_000)
        .map(|_| {
            prng = prng.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            (prng >> 16) as u8
        })
        .collect();
    v.push((0x30u64, rnd));
    // A medium text-like blob → zstd.
    v.push((0x40u64, b"hello world ".iter().cloned().cycle().take(20_000).collect()));
    // Out-of-order hash to exercise the sort.
    v.push((0x05u64, vec![9u8; 1000]));
    v
}

#[test]
fn write_wad_roundtrips_every_chunk() {
    let originals = make_entries();
    let entries: Vec<EntryToWrite> = originals
        .iter()
        .map(|(h, b)| EntryToWrite::new(*h, b.clone()))
        .collect();

    let (bytes, stats) = write_wad(entries).expect("write_wad");
    assert_eq!(stats.chunk_count, originals.len());

    let dir = std::env::temp_dir();
    let path = dir.join(format!("flint_wad_rt_{}.wad", std::process::id()));
    std::fs::write(&path, &bytes).expect("write tmp wad");

    let toc = read_wad_toc(&path).expect("parse toc");
    assert_eq!(toc.chunks.len(), originals.len());

    for chunk in &toc.chunks {
        let decoded = read_chunk_decompressed_bytes(&path, chunk)
            .unwrap_or_else(|e| panic!("read+decompress hash {:016x}: {e}", chunk.path_hash));

        let expected = originals
            .iter()
            .find(|(h, _)| *h == chunk.path_hash)
            .map(|(_, b)| b)
            .expect("hash present in originals");
        assert_eq!(
            &decoded, expected,
            "chunk {:016x} round-trip mismatch (compression {:?})",
            chunk.path_hash, chunk.compression
        );
    }

    let _ = std::fs::remove_file(&path);
}

/// Repeat many times — a data race or order-instability in the parallel encode
/// would make the output non-deterministic.
#[test]
fn write_wad_is_deterministic_across_runs() {
    let originals = make_entries();
    let build = || {
        let entries: Vec<EntryToWrite> = originals
            .iter()
            .map(|(h, b)| EntryToWrite::new(*h, b.clone()))
            .collect();
        write_wad(entries).expect("write_wad").0
    };
    let first = build();
    for _ in 0..20 {
        assert_eq!(build(), first, "write_wad output not deterministic");
    }
}
