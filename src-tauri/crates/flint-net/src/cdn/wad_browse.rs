use super::cancellation::DownloadCancellation;
use std::io::Cursor;

use ritoshark::rman::ChunkRange;
use ritoshark::wad::{Wad, WadChunk};

use futures_util::StreamExt;
use flint_hash::error::{Error, Result};

/// One inner file inside a WAD, from its TOC.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WadEntry {
    pub path_hash: u64,
    pub data_offset: u32,
    pub compressed_size: u32,
    pub uncompressed_size: u32,
    pub compression: ritoshark::wad::WadCompression,
    pub subchunk_start: u32,
    pub subchunk_count: u8,
}

impl WadEntry {
    fn from_chunk(c: &WadChunk) -> Self {
        Self {
            path_hash: c.path_hash,
            data_offset: c.data_offset,
            compressed_size: c.compressed_size,
            uncompressed_size: c.uncompressed_size,
            compression: c.compression,
            subchunk_start: c.subchunk_start,
            subchunk_count: c.subchunk_count,
        }
    }
}

/// The inner-file listing of a WAD.
#[derive(Clone, Debug, Default)]
pub struct WadListing {
    pub version: (u8, u8),
    pub entries: Vec<WadEntry>,
    /// Resolved inner-file names by `path_hash` (filled by the caller via LMDB).
    pub names: std::collections::HashMap<u64, String>,
}

pub fn entries_from_wad(wad: &Wad) -> Vec<WadEntry> {
    wad.chunks.iter().map(WadEntry::from_chunk).collect()
}

pub async fn list_wad_entries_from_chunks(
    client: &reqwest::Client,
    chunks: &[ChunkRange],
) -> Result<WadListing> {
    list_wad_with(chunks, |chunk| async move {
        crate::cdn::downloader::fetch_chunk_decompressed(client, &chunk, "WAD TOC").await
    }).await
}

async fn list_wad_with<F, Fut>(chunks: &[ChunkRange], mut fetch: F) -> Result<WadListing>
where
    F: FnMut(ChunkRange) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<u8>>>,
{
    if chunks.is_empty() {
        return Err(Error::Cdn("file has no chunks".to_string()));
    }
    let mut prefix = Vec::new();
    for chunk in chunks {
        prefix.extend_from_slice(&fetch(chunk.clone()).await?);
        match Wad::from_reader_toc(&mut Cursor::new(&prefix)) {
            Ok(wad) => return Ok(WadListing {
                version: wad.version,
                entries: entries_from_wad(&wad),
                names: Default::default(),
            }),
            Err(ritoshark::wad::Error::Io(ritoshark::io::Error::Io(e)))
                if e.kind() == std::io::ErrorKind::UnexpectedEof => {},
            Err(ritoshark::wad::Error::Io(ritoshark::io::Error::UnexpectedEof { .. })) => {},
            Err(e) => return Err(Error::Cdn(format!("invalid WAD TOC: {e}"))),
        }
    }
    Err(Error::Cdn(format!("truncated WAD TOC after {} chunks ({} bytes)", chunks.len(), prefix.len())))
}

/// Whether a manifest file path looks like a WAD archive.
pub fn is_wad_path(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    p.ends_with(".wad") || p.ends_with(".wad.client")
}

/// Find the manifest-chunk indices whose decompressed WAD-byte ranges overlap
/// `[offset, offset+len)`, and the WAD-byte offset where the first covered chunk begins.
pub fn chunks_covering(chunks: &[ChunkRange], offset: u32, len: u32) -> (Vec<usize>, u32) {
    let end = offset.saturating_add(len);
    let mut run: u32 = 0;
    let mut idxs = Vec::new();
    let mut base: u32 = 0;
    for (i, c) in chunks.iter().enumerate() {
        let chunk_start = run;
        let chunk_end = run.saturating_add(c.uncompressed_size);
        if chunk_start < end && offset < chunk_end {
            if idxs.is_empty() {
                base = chunk_start;
            }
            idxs.push(i);
        }
        run = chunk_end;
    }
    (idxs, base)
}

async fn fetch_entry_raw(
    client: &reqwest::Client,
    chunks: &[ChunkRange],
    data_offset: u32,
    compressed_size: u32,
) -> Result<Vec<u8>> {
    if compressed_size == 0 {
        return Ok(Vec::new());
    }
    let (idxs, base) = chunks_covering(chunks, data_offset, compressed_size);
    if idxs.is_empty() {
        return Err(Error::Cdn(format!(
            "no manifest chunks cover entry at WAD offset {data_offset}"
        )));
    }
    let mut wad_slice: Vec<u8> = Vec::new();
    let mut pending = futures_util::stream::iter(idxs).map(|i| async move {
        crate::cdn::downloader::fetch_chunk_decompressed(client, &chunks[i], "WAD entry").await
    }).buffered(4);
    while let Some(result) = pending.next().await {
        wad_slice.extend_from_slice(&result?);
    }
    let start = (data_offset - base) as usize;
    let end = start + compressed_size as usize;
    wad_slice.get(start..end).map(|s| s.to_vec()).ok_or_else(|| {
        Error::Cdn(format!(
            "entry slice {start}..{end} exceeds fetched {} bytes",
            wad_slice.len()
        ))
    })
}

fn parse_subchunk_toc(bytes: &[u8]) -> Result<Vec<ritoshark::wad::WadSubchunk>> {
    if !bytes.len().is_multiple_of(16) {
        return Err(Error::Cdn(
            "subchunktoc length is not a multiple of 16".to_string(),
        ));
    }
    Ok(bytes
        .chunks_exact(16)
        .map(|e| ritoshark::wad::WadSubchunk {
            compressed_size: u32::from_le_bytes([e[0], e[1], e[2], e[3]]),
            uncompressed_size: u32::from_le_bytes([e[4], e[5], e[6], e[7]]),
            checksum: u64::from_le_bytes([e[8], e[9], e[10], e[11], e[12], e[13], e[14], e[15]]),
        })
        .collect())
}

/// Decode one inner entry's bytes. `ZstdMulti` needs the WAD's `.subchunktoc` (located via
/// `listing.names`); other compressions decode directly.
pub async fn decode_inner_entry(
    client: &reqwest::Client,
    chunks: &[ChunkRange],
    listing: &WadListing,
    entry: &WadEntry,
) -> Result<Vec<u8>> {
    use ritoshark::wad::WadCompression;

    let raw = fetch_entry_raw(client, chunks, entry.data_offset, entry.compressed_size).await?;
    if entry.compression != WadCompression::ZstdMulti {
        return ritoshark::wad::decompress(&raw, entry.compression, entry.uncompressed_size as usize)
            .map_err(|e| Error::Cdn(format!("inner decode: {e:?}")));
    }

    let toc_entry = listing
        .entries
        .iter()
        .find(|e| {
            listing
                .names
                .get(&e.path_hash)
                .is_some_and(|n| n.ends_with(".subchunktoc"))
        })
        .ok_or_else(|| {
            Error::Cdn(
                "ZstdMulti entry but no .subchunktoc found (need hash dictionary)".to_string(),
            )
        })?;
    let toc_raw =
        fetch_entry_raw(client, chunks, toc_entry.data_offset, toc_entry.compressed_size).await?;
    let toc_bytes = ritoshark::wad::decompress(
        &toc_raw,
        toc_entry.compression,
        toc_entry.uncompressed_size as usize,
    )
    .map_err(|e| Error::Cdn(format!("subchunktoc decode: {e:?}")))?;
    let toc = parse_subchunk_toc(&toc_bytes)?;
    let start = entry.subchunk_start as usize;
    let end = start
        .checked_add(entry.subchunk_count as usize)
        .filter(|&end| end <= toc.len())
        .ok_or_else(|| Error::Cdn("subchunk range exceeds the subchunktoc".to_string()))?;
    ritoshark::wad::decompress_zstd_multi_with_toc(
        &raw,
        entry.uncompressed_size as usize,
        &toc[start..end],
    )
    .map_err(|e| Error::Cdn(format!("zstdmulti decode: {e:?}")))
}

/// Progress while unpacking a WAD's inner files to disk.
#[derive(Clone, Debug)]
pub enum UnpackProgress {
    Start { total: usize },
    Entry { done: usize, total: usize, name: String },
    EntryError { name: String, error: String },
}

pub async fn unpack_wad_to_dir<F: Fn(UnpackProgress) + Send + 'static>(
    client: &reqwest::Client,
    file: &crate::cdn::downloader::FilePlan,
    listing: WadListing,
    out_dir: &std::path::Path,
    report: F,
    cancel: DownloadCancellation,
) -> Result<(usize, usize)> {
    let total = listing.entries.len();
    report(UnpackProgress::Start { total });
    report(UnpackProgress::Entry { done: 0, total, name: "Downloading WAD archive".to_string() });
    tokio::fs::create_dir_all(out_dir).await
        .map_err(|e| Error::Cdn(format!("create extraction directory: {e}")))?;
    let temp = tempfile::tempdir_in(out_dir)
        .map_err(|e| Error::Cdn(format!("create WAD temporary directory: {e}")))?;
    let path = temp.path().join("archive.wad");
    cancel.run(crate::cdn::downloader::stream_file_to_path(client, file, &path, |_| {})).await??;
    let out_dir = out_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let _temp = temp;
        unpack_local_wad(&path, &listing.names, &out_dir, report, cancel)
    }).await.map_err(|e| Error::Cdn(format!("WAD extraction task failed: {e}")))?
}

fn unpack_local_wad<F: Fn(UnpackProgress)>(
    path: &std::path::Path,
    names: &std::collections::HashMap<u64, String>,
    out_dir: &std::path::Path,
    report: F,
    cancel: DownloadCancellation,
) -> Result<(usize, usize)> {
    let file = std::fs::File::open(path).map_err(|e| Error::Cdn(format!("open downloaded WAD: {e}")))?;
    let mut reader = std::io::BufReader::new(file);
    let wad = Wad::from_reader_toc(&mut reader).map_err(|e| Error::Cdn(format!("read downloaded WAD: {e}")))?;
    let toc = wad.chunks.iter().find(|c| names.get(&c.path_hash).is_some_and(|n| n.ends_with(".subchunktoc")))
        .map(|c| wad.chunk_data_from(&mut reader, c)
            .map_err(|e| Error::Cdn(format!("read subchunktoc: {e}")))
            .and_then(|bytes| parse_subchunk_toc(&bytes)))
        .transpose()?.unwrap_or_default();
    let total = wad.chunks.len();
    let mut ok = 0usize;
    let mut errors = 0usize;

    for (i, entry) in wad.chunks.iter().enumerate() {
        cancel.check()?;
        let rel = names
            .get(&entry.path_hash)
            .cloned()
            .unwrap_or_else(|| format!("{:016x}", entry.path_hash));
        report(UnpackProgress::Entry {
            done: i,
            total,
            name: rel.clone(),
        });
        match wad.chunk_data_from_with_toc(&mut reader, entry, &toc) {
            Ok(bytes) => {
                cancel.check()?;
                let mut dest = out_dir.join(rel.replace('\\', "/"));
                // Windows rejects paths over ~260 chars (os error 123). League's
                // "multi_skins" concatenated bins have enormous names — fall back
                // to <hexhash><ext> in the root, matching the WAD extractor.
                if dest.to_string_lossy().len() > 240 {
                    let ext = std::path::Path::new(&rel)
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| format!(".{e}"))
                        .unwrap_or_default();
                    dest = out_dir.join(format!("{:016x}{ext}", entry.path_hash));
                }
                let write = (|| {
                    if let Some(parent) = dest.parent() {
                        std::fs::create_dir_all(parent).map_err(|e| {
                            Error::Cdn(format!("create dir {}: {e}", parent.display()))
                        })?;
                    }
                    std::fs::write(&dest, &bytes)
                        .map_err(|e| Error::Cdn(format!("write {}: {e}", dest.display())))
                })();
                match write {
                    Ok(_) => {
                        ok += 1;
                        tracing::debug!("[cdn] unpacked {} ({} bytes)", rel, bytes.len());
                    }
                    Err(e) => {
                        errors += 1;
                        tracing::warn!("[cdn] unpack write failed for {rel}: {e}");
                        report(UnpackProgress::EntryError { name: rel, error: e.to_string() });
                    }
                }
            }
            Err(e) => {
                errors += 1;
                tracing::warn!("[cdn] unpack decode failed for {rel}: {e}");
                report(UnpackProgress::EntryError { name: rel, error: e.to_string() });
            }
        }
    }
    cancel.check()?;
    tracing::info!("[cdn] unpack done: {}/{} ok, {} error(s)", ok, total, errors);
    Ok((ok, errors))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ritoshark::rman::ChunkRange;

    fn cr(usize_: u32) -> ChunkRange {
        ChunkRange {
            bundle_id: 1,
            chunk_id: 0,
            offset_in_bundle: 0,
            compressed_size: usize_,
            uncompressed_size: usize_,
        }
    }

    #[test]
    fn chunks_covering_selects_overlapping_run() {
        // three 100-byte chunks => wad bytes [0,100,200,300)
        let chunks = vec![cr(100), cr(100), cr(100)];
        // entry spanning wad offset 150..250 overlaps chunk 1 and 2
        let (idxs, base) = chunks_covering(&chunks, 150, 100);
        assert_eq!(idxs, vec![1, 2]);
        assert_eq!(base, 100); // first covered chunk starts at wad byte 100
    }

    #[test]
    fn detects_wad_paths() {
        assert!(is_wad_path("Foo/Bar.wad.client"));
        assert!(is_wad_path("x.WAD"));
        assert!(!is_wad_path("x.bin"));
    }

    #[tokio::test]
    async fn reads_a_toc_spanning_more_than_eight_manifest_chunks() {
        let mut builder = ritoshark::wad::WadBuilder::new();
        for hash in 0..64 { builder.add_chunk_hash(hash); }
        let mut bytes = Vec::new();
        builder.build_to_writer(&mut bytes, |_, out| {
            out.write_all(b"asset").map_err(ritoshark::io::Error::from)?;
            Ok(())
        }).unwrap();
        let chunks: Vec<_> = bytes.chunks(128).enumerate().map(|(i, b)| ChunkRange {
            chunk_id: i as u64, ..cr(b.len() as u32)
        }).collect();
        let calls = std::cell::Cell::new(0);
        let listing = list_wad_with(&chunks, |c| {
            calls.set(calls.get() + 1);
            let start = c.chunk_id as usize * 128;
            std::future::ready(Ok(bytes[start..start + c.uncompressed_size as usize].to_vec()))
        }).await.unwrap();
        assert_eq!(listing.entries.len(), 64);
        assert!(calls.get() > 8);
        assert_eq!(calls.get(), (272usize + 64 * 32).div_ceil(128));
    }

    #[tokio::test]
    async fn invalid_tocs_stop_immediately_and_short_tocs_report_truncation() {
        let calls = std::cell::Cell::new(0);
        let err = list_wad_with(&vec![cr(4); 12], |_| {
            calls.set(calls.get() + 1);
            std::future::ready(Ok(b"nope".to_vec()))
        }).await.unwrap_err();
        assert!(err.to_string().contains("invalid WAD TOC"));
        assert_eq!(calls.get(), 1);
        let err = list_wad_with(&[cr(4)], |_| std::future::ready(Ok(vec![b'R', b'W', 3, 4])))
            .await.unwrap_err();
        assert!(err.to_string().contains("truncated WAD TOC"));
    }

    #[tokio::test]
    #[ignore]
    async fn live_reported_map_manifest_lists_and_reads_target_asset() {
        crate::net::install_tls_provider();
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(60)).build().unwrap();
        let url = std::env::var("FLINT_CDN_TEST_MANIFEST").expect("FLINT_CDN_TEST_MANIFEST");
        let body = client.get(url).send().await.unwrap().error_for_status().unwrap().bytes().await.unwrap();
        let manifest = crate::cdn::manifest::Manifest::from_bytes(&body).unwrap();
        let index = manifest.paths().iter().position(|(p, _)| p.to_ascii_lowercase().ends_with("/map11.wad.client")).unwrap();
        let chunks = manifest.file_chunks(index);
        let listing = list_wad_entries_from_chunks(&client, &chunks).await.unwrap();
        let target = "assets/sounds/wwise2016/sfx/shared/mus_map11_seasonal_25s2_bloom_audio.bnk";
        let hash = ritoshark::hash::xxh64(target);
        let entry = listing.entries.iter().find(|e| e.path_hash == hash).unwrap();
        let bytes = decode_inner_entry(&client, &chunks, &listing, entry).await.unwrap();
        assert_eq!(bytes.len(), entry.uncompressed_size as usize);
        assert!(bytes.starts_with(b"BKHD"));
        eprintln!("Map11: {} entries, target BNK {} bytes", listing.entries.len(), bytes.len());
    }

    #[test]
    fn whole_wad_extraction_reads_shared_chunks_from_disk() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("map.wad");
        let mut file = std::fs::File::create(&path).unwrap();
        let mut builder = ritoshark::wad::WadBuilder::new();
        builder.add_chunk_hash(1);
        builder.add_chunk_hash(2);
        builder.build_to_writer(&mut file, |_, out| {
            out.write_all(b"shared contents").map_err(ritoshark::io::Error::from)?;
            Ok(())
        }).unwrap();
        drop(file);
        let names = [(1, "assets/a.bin".to_string()), (2, "assets/b.bin".to_string())].into_iter().collect();
        let dest = temp.path().join("extracted");
        assert_eq!(unpack_local_wad(&path, &names, &dest, |_| {}, DownloadCancellation::default()).unwrap(), (2, 0));
        assert_eq!(std::fs::read(dest.join("assets/a.bin")).unwrap(), b"shared contents");
        assert_eq!(std::fs::read(dest.join("assets/b.bin")).unwrap(), b"shared contents");
        let cancelled_dest = temp.path().join("cancelled");
        let cancel = DownloadCancellation::default();
        let trigger = cancel.clone();
        let result = unpack_local_wad(&path, &names, &cancelled_dest, |p| {
            if matches!(p, UnpackProgress::Entry { done: 1, .. }) {
                trigger.cancel();
            }
        }, cancel);
        assert!(result.unwrap_err().to_string().contains("Download aborted"));
        assert_eq!(std::fs::read_dir(cancelled_dest.join("assets")).unwrap().count(), 1);
    }
}
