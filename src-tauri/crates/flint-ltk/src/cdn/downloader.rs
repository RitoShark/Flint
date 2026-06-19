use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use ritoshark::rman::{ChunkHashType, ChunkRange};

use crate::error::{Error, Result};

/// A run of consecutive chunks in the same bundle, fetchable in one HTTP range request.
#[derive(Clone, Debug)]
pub struct BundleGroup {
    pub bundle_id: u64,
    pub chunks: Vec<ChunkRange>,
}

impl BundleGroup {
    pub fn start_offset(&self) -> u32 {
        self.chunks.first().map(|c| c.offset_in_bundle).unwrap_or(0)
    }
    pub fn end_offset(&self) -> u32 {
        match self.chunks.last() {
            Some(c) => c.offset_in_bundle + c.compressed_size - 1,
            None => 0,
        }
    }
    pub fn byte_len(&self) -> u32 {
        self.end_offset() - self.start_offset() + 1
    }
}

/// Group an ordered chunk list into runs of consecutive same-bundle chunks.
pub fn group_chunks(chunks: &[ChunkRange]) -> Vec<BundleGroup> {
    let mut groups: Vec<BundleGroup> = Vec::new();
    for chunk in chunks {
        match groups.last_mut() {
            Some(g) if g.bundle_id == chunk.bundle_id => g.chunks.push(chunk.clone()),
            _ => groups.push(BundleGroup {
                bundle_id: chunk.bundle_id,
                chunks: vec![chunk.clone()],
            }),
        }
    }
    groups
}

/// The CDN URL for a bundle (uppercase, zero-padded 16-hex id).
pub fn bundle_url(bundle_id: u64) -> String {
    format!("https://lol.dyn.riotcdn.net/channels/public/bundles/{bundle_id:016X}.bundle")
}

/// The HTTP `Range` header value covering a whole group.
pub fn range_header(group: &BundleGroup) -> String {
    format!("bytes={}-{}", group.start_offset(), group.end_offset())
}

/// Progress events emitted during an extraction.
#[derive(Clone, Debug)]
pub enum DownloadProgress {
    FileStart { path: String, size: u64 },
    FileDone { path: String, verified: bool },
    Note(String),
    FileError { path: String, error: String },
    AllDone { files: usize, errors: usize },
}

/// Everything needed to download one file, owned (no manifest borrow).
#[derive(Clone, Debug)]
pub struct FilePlan {
    pub rel_path: String,
    pub size: u64,
    pub chunks: Vec<ChunkRange>,
    pub hash_type: Option<ChunkHashType>,
}

#[derive(Clone, Debug, Default)]
pub struct DownloadPlan {
    pub files: Vec<FilePlan>,
}

impl DownloadPlan {
    pub fn total_size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

/// Build an owned [`DownloadPlan`] for `indices` from `manifest`. Missing indices skipped.
pub fn plan_download(manifest: &crate::cdn::manifest::Manifest, indices: &[usize]) -> DownloadPlan {
    let paths = manifest.paths();
    let files = indices
        .iter()
        .filter_map(|&index| {
            let entry = manifest.file(index)?;
            Some(FilePlan {
                rel_path: paths.get(index).map(|(p, _)| p.clone()).unwrap_or_default(),
                size: entry.size as u64,
                chunks: manifest.file_chunks(index),
                hash_type: manifest.rman.file_hash_type(entry),
            })
        })
        .collect();
    DownloadPlan { files }
}

async fn fetch_and_write(client: &reqwest::Client, file: &FilePlan, out_dir: &Path) -> Result<u64> {
    let groups = group_chunks(&file.chunks);
    let mut file_bytes: Vec<u8> = Vec::with_capacity(file.size as usize);

    for group in &groups {
        let url = bundle_url(group.bundle_id);
        let resp = client
            .get(&url)
            .header(reqwest::header::RANGE, range_header(group))
            .send()
            .await
            .map_err(|e| Error::Cdn(format!("range request: {e}")))?;
        if !resp.status().is_success() {
            return Err(Error::Cdn(format!(
                "range request to {url} failed: HTTP {}",
                resp.status()
            )));
        }
        let body = resp
            .bytes()
            .await
            .map_err(|e| Error::Cdn(format!("range body: {e}")))?;
        let base = group.start_offset();

        for chunk in &group.chunks {
            let start = (chunk.offset_in_bundle - base) as usize;
            let end = start + chunk.compressed_size as usize;
            let compressed = body.get(start..end).ok_or_else(|| {
                Error::Cdn(format!("short bundle body for chunk {:#x}", chunk.chunk_id))
            })?;
            let decompressed = zstd::stream::decode_all(compressed).map_err(|e| {
                Error::Cdn(format!("zstd decode of chunk {:#x}: {e}", chunk.chunk_id))
            })?;
            if decompressed.len() != chunk.uncompressed_size as usize {
                return Err(Error::Cdn(format!(
                    "chunk {:#x} decompressed to {} bytes, expected {}",
                    chunk.chunk_id,
                    decompressed.len(),
                    chunk.uncompressed_size
                )));
            }
            if let Some(ht) = file.hash_type {
                let ok = ritoshark::rman::validate_chunk(&decompressed, chunk.chunk_id, ht)
                    .map_err(|e| {
                        Error::Cdn(format!("validation error on chunk {:#x}: {e}", chunk.chunk_id))
                    })?;
                if !ok {
                    return Err(Error::Cdn(format!(
                        "chunk {:#x} failed {ht:?} validation",
                        chunk.chunk_id
                    )));
                }
            }
            file_bytes.extend_from_slice(&decompressed);
        }
    }

    let dest = out_dir.join(&file.rel_path);
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| Error::Cdn(format!("create dir {}: {e}", parent.display())))?;
    }
    tokio::fs::write(&dest, &file_bytes)
        .await
        .map_err(|e| Error::Cdn(format!("write {}: {e}", dest.display())))?;
    Ok(file_bytes.len() as u64)
}

/// Download every file in `plan` under `out_dir`, reporting progress via `report` and
/// stopping early when `cancel` is set. One file's failure does not abort the rest.
pub async fn download_plan<F: Fn(DownloadProgress)>(
    client: &reqwest::Client,
    plan: DownloadPlan,
    out_dir: PathBuf,
    report: F,
    cancel: Arc<AtomicBool>,
) -> usize {
    let mut errors = 0usize;
    let total = plan.files.len();

    for file in &plan.files {
        if cancel.load(Ordering::Relaxed) {
            report(DownloadProgress::Note("cancelled".to_string()));
            break;
        }
        report(DownloadProgress::FileStart {
            path: file.rel_path.clone(),
            size: file.size,
        });
        match fetch_and_write(client, file, &out_dir).await {
            Ok(_) => {
                let verified = file.hash_type.is_some();
                if !verified {
                    report(DownloadProgress::Note(format!(
                        "{}: downloaded unverified (no hash type)",
                        file.rel_path
                    )));
                }
                report(DownloadProgress::FileDone {
                    path: file.rel_path.clone(),
                    verified,
                });
            }
            Err(e) => {
                errors += 1;
                report(DownloadProgress::FileError {
                    path: file.rel_path.clone(),
                    error: e.to_string(),
                });
            }
        }
    }
    report(DownloadProgress::AllDone {
        files: total,
        errors,
    });
    errors
}

#[cfg(test)]
mod tests {
    use super::*;
    use ritoshark::rman::ChunkRange;

    fn cr(bundle: u64, off: u32, csize: u32) -> ChunkRange {
        ChunkRange {
            bundle_id: bundle,
            chunk_id: 0,
            offset_in_bundle: off,
            compressed_size: csize,
            uncompressed_size: csize,
        }
    }

    #[test]
    fn groups_consecutive_same_bundle_chunks() {
        let chunks = vec![cr(1, 0, 10), cr(1, 10, 10), cr(2, 0, 5), cr(1, 100, 10)];
        let groups = group_chunks(&chunks);
        assert_eq!(groups.len(), 3); // 1,1 | 2 | 1
        assert_eq!(groups[0].chunks.len(), 2);
        assert_eq!(groups[0].byte_len(), 20); // 0..=19
    }

    #[test]
    fn bundle_url_is_uppercase_padded() {
        assert_eq!(
            bundle_url(0xABC),
            "https://lol.dyn.riotcdn.net/channels/public/bundles/0000000000000ABC.bundle"
        );
    }

    #[test]
    fn range_header_spans_group() {
        let g = BundleGroup {
            bundle_id: 1,
            chunks: vec![cr(1, 5, 10), cr(1, 15, 10)],
        };
        assert_eq!(range_header(&g), "bytes=5-24");
    }
}
