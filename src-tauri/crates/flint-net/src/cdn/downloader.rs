use std::path::{Path, PathBuf};
use super::cancellation::DownloadCancellation;
use futures_util::{stream, StreamExt};

use ritoshark::rman::{ChunkHashType, ChunkRange};

use flint_hash::error::{Error, Result};

const BUNDLE_BASE: &str = "https://lol.dyn.riotcdn.net/channels/public/bundles";
const DOWNLOAD_CONCURRENCY: usize = 8;

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
    format!("{BUNDLE_BASE}/{bundle_id:016X}.bundle")
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
                size: entry.size,
                chunks: manifest.file_chunks(index),
                hash_type: manifest.rman.file_hash_type(entry),
            })
        })
        .collect();
    DownloadPlan { files }
}

/// Fetch ONE manifest chunk in its own small HTTP range request and return its
/// decompressed bytes. Riot's CDN truncates large multi-MB range spans (returns
/// a short body), so each chunk must be fetched individually — never grouped.
pub(crate) async fn fetch_chunk_decompressed(
    client: &reqwest::Client,
    chunk: &ChunkRange,
    label: &str,
) -> Result<Vec<u8>> {
    let url = bundle_url(chunk.bundle_id);
    fetch_chunk_from_url(client, chunk, label, &url).await
}

async fn fetch_chunk_from_url(
    client: &reqwest::Client,
    chunk: &ChunkRange,
    label: &str,
    url: &str,
) -> Result<Vec<u8>> {
    let end = chunk.offset_in_bundle.checked_add(chunk.compressed_size)
        .and_then(|n| n.checked_sub(1))
        .filter(|_| chunk.compressed_size > 0)
        .ok_or_else(|| Error::Cdn("invalid manifest chunk range".to_string()))?;
    let range = format!(
        "bytes={}-{}",
        chunk.offset_in_bundle,
        end
    );
    let resp = client
        .get(url)
        .header(reqwest::header::RANGE, range)
        .send()
        .await
        .map_err(|e| {
            tracing::warn!("[cdn] {label}: range request to {url} errored: {e}");
            Error::Cdn(format!("range request: {e}"))
        })?;
    if resp.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        tracing::warn!("[cdn] {label}: range request to {url} failed: HTTP {}", resp.status());
        return Err(Error::Cdn(format!(
            "range request to {url} failed: HTTP {}",
            resp.status()
        )));
    }
    let expected_range = format!("bytes {}-{end}/", chunk.offset_in_bundle);
    if !resp.headers().get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok()).is_some_and(|v| v.starts_with(&expected_range)) {
        return Err(Error::Cdn(format!("incorrect Content-Range for chunk {:#x}", chunk.chunk_id)));
    }
    let body = resp.bytes().await.map_err(|e| {
        tracing::warn!("[cdn] {label}: reading range body from {url} errored: {e}");
        Error::Cdn(format!("range body: {e}"))
    })?;
    if body.len() != chunk.compressed_size as usize {
        tracing::warn!(
            "[cdn] {label}: chunk {:#x} short body: got {} bytes, expected {}",
            chunk.chunk_id, body.len(), chunk.compressed_size
        );
        return Err(Error::Cdn(format!(
            "chunk {:#x} short body: got {} bytes, expected {}",
            chunk.chunk_id, body.len(), chunk.compressed_size
        )));
    }
    let decompressed = zstd::stream::decode_all(body.as_ref()).map_err(|e| {
        tracing::warn!("[cdn] {label}: zstd decode of chunk {:#x} failed: {e}", chunk.chunk_id);
        Error::Cdn(format!("zstd decode of chunk {:#x}: {e}", chunk.chunk_id))
    })?;
    if decompressed.len() != chunk.uncompressed_size as usize {
        tracing::warn!(
            "[cdn] {label}: chunk {:#x} decompressed to {} bytes, expected {}",
            chunk.chunk_id, decompressed.len(), chunk.uncompressed_size
        );
        return Err(Error::Cdn(format!(
            "chunk {:#x} decompressed to {} bytes, expected {}",
            chunk.chunk_id, decompressed.len(), chunk.uncompressed_size
        )));
    }
    Ok(decompressed)
}

async fn stream_file_to_dest(
    client: &reqwest::Client,
    file: &FilePlan,
    dest: &Path,
) -> Result<u64> {
    stream_file_from(client, file, dest, BUNDLE_BASE).await
}

async fn stream_file_from(
    client: &reqwest::Client,
    file: &FilePlan,
    dest: &Path,
    bundle_base: &str,
) -> Result<u64> {
    use tokio::io::AsyncWriteExt;

    tracing::debug!(
        "[cdn] {}: streaming {} chunk(s), {} bytes -> {}",
        file.rel_path, file.chunks.len(), file.size, dest.display()
    );

    if let Some(parent) = dest.parent().filter(|p| !p.as_os_str().is_empty()) {
        tokio::fs::create_dir_all(parent).await.map_err(|e| {
            tracing::warn!("[cdn] {}: create dir {} failed: {e}", file.rel_path, parent.display());
            Error::Cdn(format!("create dir {}: {e}", parent.display()))
        })?;
    }
    let parent = dest.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| Error::Cdn(format!("create download temporary file: {e}")))?;
    let mut out = tokio::fs::File::from_std(temp.reopen()
        .map_err(|e| Error::Cdn(format!("open download temporary file: {e}")))?);

    let mut written: u64 = 0;
    let mut pending = stream::iter(file.chunks.clone()).map(|chunk| async move {
        let url = format!("{bundle_base}/{:016X}.bundle", chunk.bundle_id);
        let decompressed = fetch_chunk_from_url(client, &chunk, &file.rel_path, &url).await?;
        if let Some(ht) = file.hash_type {
            let ok = ritoshark::rman::validate_chunk(&decompressed, chunk.chunk_id, ht)
                .map_err(|e| {
                    tracing::warn!("[cdn] {}: validation error on chunk {:#x}: {e}", file.rel_path, chunk.chunk_id);
                    Error::Cdn(format!("validation error on chunk {:#x}: {e}", chunk.chunk_id))
                })?;
            if !ok {
                tracing::warn!("[cdn] {}: chunk {:#x} failed {ht:?} validation", file.rel_path, chunk.chunk_id);
                return Err(Error::Cdn(format!(
                    "chunk {:#x} failed {ht:?} validation",
                    chunk.chunk_id
                )));
            }
        }
        Ok::<_, Error>(decompressed)
    }).buffered(DOWNLOAD_CONCURRENCY);
    while let Some(result) = pending.next().await {
        let decompressed = result?;
        out.write_all(&decompressed).await.map_err(|e| {
            tracing::warn!("[cdn] {}: write to {} failed: {e}", file.rel_path, dest.display());
            Error::Cdn(format!("write {}: {e}", dest.display()))
        })?;
        written += decompressed.len() as u64;
    }
    if written != file.size {
        return Err(Error::Cdn(format!("file size mismatch: downloaded {written} bytes, expected {}", file.size)));
    }
    out.flush().await.map_err(|e| Error::Cdn(format!("flush {}: {e}", dest.display())))?;
    drop(out);
    temp.persist(dest).map_err(|e| Error::Cdn(format!("save {}: {e}", dest.display())))?;
    tracing::info!("[cdn] downloaded {} ({} bytes) -> {}", file.rel_path, written, dest.display());
    Ok(written)
}

/// Stream a manifest file to `out_dir/<rel_path>` (recreating its folder tree).
async fn fetch_and_write(client: &reqwest::Client, file: &FilePlan, out_dir: &Path) -> Result<u64> {
    let dest = out_dir.join(&file.rel_path);
    stream_file_to_dest(client, file, &dest).await
}

/// Stream a single file's raw bytes to an exact output path, emitting the same
/// FileStart/FileDone/FileError progress events as a full plan. Used by the
/// "Download WAD" action to save one raw `.wad.client`.
pub async fn stream_file_to_path<F: Fn(DownloadProgress)>(
    client: &reqwest::Client,
    file: &FilePlan,
    dest: &Path,
    report: F,
) -> Result<u64> {
    report(DownloadProgress::FileStart {
        path: file.rel_path.clone(),
        size: file.size,
    });
    match stream_file_to_dest(client, file, dest).await {
        Ok(written) => {
            report(DownloadProgress::FileDone {
                path: file.rel_path.clone(),
                verified: file.hash_type.is_some(),
            });
            Ok(written)
        }
        Err(e) => {
            report(DownloadProgress::FileError {
                path: file.rel_path.clone(),
                error: e.to_string(),
            });
            Err(e)
        }
    }
}

/// Download every file in `plan` under `out_dir`, reporting progress via `report` and
/// stopping early when `cancel` is set. One file's failure does not abort the rest.
pub async fn download_plan<F: Fn(DownloadProgress)>(
    client: &reqwest::Client,
    plan: DownloadPlan,
    out_dir: PathBuf,
    report: F,
    cancel: &DownloadCancellation,
) -> Result<usize> {
    let mut errors = 0usize;
    let total = plan.files.len();
    tracing::info!(
        "[cdn] download_plan: {} file(s), {} bytes total -> {}",
        total,
        plan.total_size(),
        out_dir.display()
    );

    for file in &plan.files {
        cancel.check()?;
        report(DownloadProgress::FileStart {
            path: file.rel_path.clone(),
            size: file.size,
        });
        match cancel.run(fetch_and_write(client, file, &out_dir)).await? {
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
    tracing::info!("[cdn] download_plan done: {}/{} ok, {} error(s)", total - errors, total, errors);
    report(DownloadProgress::AllDone {
        files: total,
        errors,
    });
    Ok(errors)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, atomic::Ordering};
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

    fn serve_chunks(count: usize, status: &'static str) -> (String, FilePlan, Arc<std::sync::atomic::AtomicUsize>, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        use std::sync::atomic::AtomicUsize;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let payloads: Vec<_> = (0..count).map(|i| zstd::stream::encode_all(&[i as u8; 32][..], 1).unwrap()).collect();
        let file = FilePlan {
            rel_path: "test.wad".to_string(), size: count as u64 * 32, hash_type: None,
            chunks: payloads.iter().enumerate().map(|(i, p)| ChunkRange {
                bundle_id: 1, chunk_id: i as u64, offset_in_bundle: i as u32 * 100,
                compressed_size: p.len() as u32, uncompressed_size: 32,
            }).collect(),
        };
        let peak = Arc::new(AtomicUsize::new(0));
        let max = peak.clone();
        let handle = std::thread::spawn(move || {
            let active = Arc::new(AtomicUsize::new(0));
            let payloads = Arc::new(payloads);
            let mut workers = Vec::new();
            for stream in listener.incoming().take(count) {
                let mut stream = stream.unwrap();
                let active = active.clone();
                let max = max.clone();
                let payloads = payloads.clone();
                workers.push(std::thread::spawn(move || {
                    stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
                    let mut request = Vec::new();
                    let mut byte = [0];
                    while !request.ends_with(b"\r\n\r\n") {
                        stream.read_exact(&mut byte).unwrap();
                        request.push(byte[0]);
                    }
                    let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
                    let range = request.lines().find_map(|l| l.strip_prefix("range: bytes=")).unwrap();
                    let offset: usize = range.split('-').next().unwrap().parse().unwrap();
                    let i = offset / 100;
                    max.fetch_max(active.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(if i == 0 { 120 } else { 20 }));
                    let body = &payloads[i];
                    let header = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Range: bytes {range}/100000\r\nConnection: close\r\n\r\n", body.len());
                    stream.write_all(header.as_bytes()).unwrap();
                    stream.write_all(body).unwrap();
                    active.fetch_sub(1, Ordering::SeqCst);
                }));
            }
            for worker in workers { worker.join().unwrap(); }
        });
        (url, file, peak, handle)
    }

    #[tokio::test]
    async fn downloads_concurrently_but_writes_in_order() {
        crate::net::install_tls_provider();
        let (url, file, peak, server) = serve_chunks(12, "206 Partial Content");
        let temp = tempfile::tempdir().unwrap();
        let dest = temp.path().join("archive.wad");
        let start = std::time::Instant::now();
        assert_eq!(stream_file_from(&reqwest::Client::new(), &file, &dest, &url).await.unwrap(), file.size);
        server.join().unwrap();
        let expected: Vec<_> = (0..12u8).flat_map(|i| [i; 32]).collect();
        assert_eq!(std::fs::read(dest).unwrap(), expected);
        let peak = peak.load(Ordering::SeqCst);
        assert!(peak > 1 && peak <= DOWNLOAD_CONCURRENCY);
        eprintln!("12 delayed chunks downloaded in {:?}; peak requests: {peak}", start.elapsed());
    }

    #[tokio::test]
    async fn abort_stalled_download_cleans_temp_and_preserves_destination() {
        use std::io::Read;
        crate::net::install_tls_provider();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (started, ready) = tokio::sync::oneshot::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            started.send(()).unwrap();
            assert_eq!(stream.read(&mut byte).unwrap(), 0);
        });
        let file = FilePlan {
            rel_path: "test.wad".into(), size: 32, hash_type: None,
            chunks: vec![ChunkRange {
                bundle_id: 1, chunk_id: 0, offset_in_bundle: 0,
                compressed_size: 32, uncompressed_size: 32,
            }],
        };
        let temp = tempfile::tempdir().unwrap();
        let dest = temp.path().join("archive.wad");
        std::fs::write(&dest, b"original").unwrap();
        let cancel = DownloadCancellation::default();
        let worker = cancel.clone();
        let output = dest.clone();
        let task = tokio::spawn(async move {
            worker.run(stream_file_from(&reqwest::Client::new(), &file, &output, &url)).await
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), ready).await.unwrap().unwrap();
        cancel.cancel();
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), task).await.unwrap().unwrap();
        assert!(result.unwrap_err().to_string().contains("Download aborted"));
        server.join().unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"original");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn failed_downloads_preserve_existing_destination() {
        crate::net::install_tls_provider();
        for failure in ["range", "size", "hash"] {
            let status = if failure == "range" { "200 OK" } else { "206 Partial Content" };
            let (url, mut file, _, server) = serve_chunks(1, status);
            if failure == "size" { file.size += 1; }
            if failure == "hash" { file.hash_type = Some(ChunkHashType::Sha256); }
            let temp = tempfile::tempdir().unwrap();
            let dest = temp.path().join("archive.wad");
            std::fs::write(&dest, b"original").unwrap();
            assert!(stream_file_from(&reqwest::Client::new(), &file, &dest, &url).await.is_err());
            server.join().unwrap();
            assert_eq!(std::fs::read(&dest).unwrap(), b"original");
            assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
        }
    }
}
