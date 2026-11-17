use std::{io::Write, path::Path};

pub(super) fn replace_if_unchanged(
    path: &Path,
    expected: &[u8],
    bytes: &[u8],
) -> Result<(), String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temporary = path.with_file_name(format!(
        "{}.flint-{stamp}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        if std::fs::read(path).map_err(|e| e.to_string())? != expected {
            return Err("BIN changed on disk; reload before saving".into());
        }
        crate::core::write_echo::mark(path);
        std::fs::rename(&temporary, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_updates_preserve_the_file_and_remove_staging() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("skin.bin");
        std::fs::write(&path, b"newer").unwrap();
        assert!(replace_if_unchanged(&path, b"older", b"replacement").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"newer");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        replace_if_unchanged(&path, b"newer", b"replacement").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"replacement");
    }
}
