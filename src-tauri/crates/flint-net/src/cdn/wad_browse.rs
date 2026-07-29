use std::io::Cursor;

use ritoshark::rman::ChunkRange;
use ritoshark::wad::{Wad, WadChunk};

use crate::cdn::downloader::bundle_url;
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

/// In practice 1-3 chunks suffice; cap the prefix growth.
const MAX_TOC_CHUNKS: usize = 8;

/// Range-fetch the WAD's leading chunks and parse its inner-file listing, without
/// downloading the whole file.
pub async fn list_wad_entries_from_chunks(
    client: &reqwest::Client,
    chunks: &[ChunkRange],
) -> Result<WadListing> {
    if chunks.is_empty() {
        return Err(Error::Cdn("file has no chunks".to_string()));
    }
    let mut prefix: Vec<u8> = Vec::new();
    let mut last_err: Option<String> = None;
    for chunk in chunks.iter().take(MAX_TOC_CHUNKS) {
        let url = bundle_url(chunk.bundle_id);
        let resp = client
            .get(&url)
            .header(
                reqwest::header::RANGE,
                format!(
                    "bytes={}-{}",
                    chunk.offset_in_bundle,
                    chunk.offset_in_bundle + chunk.compressed_size - 1
                ),
            )
            .send()
            .await
            .map_err(|e| Error::Cdn(format!("range fetch: {e}")))?;
        if !resp.status().is_success() {
            return Err(Error::Cdn(format!(
                "range fetch failed: HTTP {}",
                resp.status()
            )));
        }
        let body = resp
            .bytes()
            .await
            .map_err(|e| Error::Cdn(format!("range body: {e}")))?;
        let decompressed = zstd::stream::decode_all(body.as_ref())
            .map_err(|e| Error::Cdn(format!("zstd decode: {e}")))?;
        prefix.extend_from_slice(&decompressed);
        match Wad::from_reader(&mut Cursor::new(&prefix)) {
            Ok(wad) => {
                return Ok(WadListing {
                    version: wad.version,
                    entries: entries_from_wad(&wad),
                    names: Default::default(),
                })
            }
            Err(e) => last_err = Some(format!("{e:?}")),
        }
    }
    Err(Error::Cdn(format!(
        "could not parse WAD TOC within {MAX_TOC_CHUNKS} chunks: {}",
        last_err.unwrap_or_default()
    )))
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
    let (idxs, base) = chunks_covering(chunks, data_offset, compressed_size);
    if idxs.is_empty() {
        return Err(Error::Cdn(format!(
            "no manifest chunks cover entry at WAD offset {data_offset}"
        )));
    }
    let mut wad_slice: Vec<u8> = Vec::new();
    for &i in &idxs {
        let chunk = &chunks[i];
        let url = bundle_url(chunk.bundle_id);
        let resp = client
            .get(&url)
            .header(
                reqwest::header::RANGE,
                format!(
                    "bytes={}-{}",
                    chunk.offset_in_bundle,
                    chunk.offset_in_bundle + chunk.compressed_size - 1
                ),
            )
            .send()
            .await
            .map_err(|e| Error::Cdn(format!("range fetch: {e}")))?;
        if !resp.status().is_success() {
            return Err(Error::Cdn(format!(
                "range fetch failed: HTTP {}",
                resp.status()
            )));
        }
        let body = resp
            .bytes()
            .await
            .map_err(|e| Error::Cdn(format!("range body: {e}")))?;
        let dec = zstd::stream::decode_all(body.as_ref())
            .map_err(|e| Error::Cdn(format!("zstd decode of wad chunk: {e}")))?;
        wad_slice.extend_from_slice(&dec);
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

/// Unpack EVERY inner file of a CDN WAD into `out_dir`, resolving names via
/// `names` (path_hash -> relative path; unresolved entries fall back to their
/// hex hash). Each inner entry is fetched with per-chunk range requests (the
/// only reliable path against Riot's CDN) and written to disk as it decodes, so
/// memory stays flat. One entry's failure doesn't abort the rest.
pub async fn unpack_wad_to_dir<F: Fn(UnpackProgress)>(
    client: &reqwest::Client,
    chunks: &[ChunkRange],
    names: &std::collections::HashMap<u64, String>,
    out_dir: &std::path::Path,
    report: F,
) -> Result<(usize, usize)> {
    let mut listing = list_wad_entries_from_chunks(client, chunks).await?;
    listing.names = names.clone();

    let total = listing.entries.len();
    report(UnpackProgress::Start { total });
    let mut ok = 0usize;
    let mut errors = 0usize;

    for (i, entry) in listing.entries.iter().enumerate() {
        let rel = listing
            .names
            .get(&entry.path_hash)
            .cloned()
            .unwrap_or_else(|| format!("{:016x}", entry.path_hash));
        report(UnpackProgress::Entry {
            done: i,
            total,
            name: rel.clone(),
        });
        match decode_inner_entry(client, chunks, &listing, entry).await {
            Ok(bytes) => {
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
                let write = async {
                    if let Some(parent) = dest.parent() {
                        tokio::fs::create_dir_all(parent).await.map_err(|e| {
                            Error::Cdn(format!("create dir {}: {e}", parent.display()))
                        })?;
                    }
                    tokio::fs::write(&dest, &bytes)
                        .await
                        .map_err(|e| Error::Cdn(format!("write {}: {e}", dest.display())))
                };
                match write.await {
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
}
