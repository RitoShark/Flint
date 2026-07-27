//! RMAN release-manifest → viewer JSON (read-only). RMAN is produced by Riot's
//! servers and only ever consumed, so there is no writer.

use ritoshark::prelude::Parse;
use ritoshark::rman::Rman;
use serde::Serialize;

#[derive(Serialize)]
struct ManifestFile {
    path: String,
    size: u64,
    flags: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestData {
    version: (u8, u8),
    manifest_id: String,
    flags: u16,
    file_count: usize,
    total_size: u64,
    files: Vec<ManifestFile>,
}

pub fn rman_to_json(data: &[u8]) -> Result<String, String> {
    let rman = Rman::from_bytes(data).map_err(|e| format!("Failed to parse manifest: {e:?}"))?;

    let paths = rman.file_paths(); // Vec<(String, u64)> in self.files order
    let mut files = Vec::with_capacity(paths.len());
    let mut total: u64 = 0;
    for (file, (path, size)) in rman.files.iter().zip(paths.into_iter()) {
        total = total.saturating_add(size);
        let flags = rman.file_flag_names(file).into_iter().map(|s| s.to_string()).collect();
        files.push(ManifestFile { path, size, flags });
    }

    let out = ManifestData {
        version: rman.version,
        manifest_id: rman.manifest_id.to_string(),
        flags: rman.flags,
        file_count: rman.files.len(),
        total_size: total,
        files,
    };
    serde_json::to_string(&out).map_err(|e| format!("Failed to serialize manifest: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sample_manifest() {
        // Try the known sample manifests; skip gracefully if none are present.
        let candidates = [
            r"E:\RitoShark\RitoShark - Crate\RitoShark-Crates\Sample-Files\F8FBA48750270222.manifest",
            r"E:\RitoShark\RitoShark - Crate\RitoShark-Crates\Sample-Files\7D6C65378829C6AA.manifest",
            r"E:\RitoShark\RitoShark - Crate\RitoShark-Crates\Sample-Files\DAFB5FDD5647079F.manifest",
        ];
        for path in candidates {
            if let Ok(data) = std::fs::read(path) {
                let json = rman_to_json(&data).expect("parse manifest");
                assert!(json.contains("\"files\""));
                return;
            }
        }
        // No fixture available in this environment — nothing to assert.
    }
}
