//! Shared creation of the project's private metadata directory.
use std::{fs, io, path::{Path, PathBuf}};

pub fn ensure_metadata_dir(project_path: &Path) -> io::Result<PathBuf> {
    let path = project_path.join(".flint");
    fs::create_dir_all(&path)?;
    hide_directory(&path)?;
    Ok(path)
}

/// Dot-prefixed directories are hidden by convention on Unix. Windows needs
/// the hidden attribute, including for directories created by older versions.
pub fn hide_directory(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::{ffi::OsStrExt, fs::MetadataExt};
        #[link(name = "kernel32")]
        extern "system" {
            fn SetFileAttributesW(path: *const u16, attributes: u32) -> i32;
        }
        const HIDDEN: u32 = 0x2;
        let attributes = fs::metadata(path)?.file_attributes();
        if attributes & HIDDEN == 0 {
            // Canonicalization also gives Win32 an absolute, long-path-safe name.
            let wide: Vec<u16> = fs::canonicalize(path)?.as_os_str().encode_wide().chain(Some(0)).collect();
            // SAFETY: wide is a live, NUL-terminated UTF-16 path for this call.
            if unsafe { SetFileAttributesW(wide.as_ptr(), attributes | HIDDEN) } == 0 {
                return Err(io::Error::last_os_error());
            }
        }
    }
    #[cfg(not(windows))]
    let _ = path;
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::fs::MetadataExt;

    #[test]
    fn new_and_existing_metadata_directories_are_hidden() {
        let project = tempfile::tempdir().unwrap();
        let path = ensure_metadata_dir(project.path()).unwrap();
        assert_ne!(fs::metadata(&path).unwrap().file_attributes() & 0x2, 0);
        fs::remove_dir(&path).unwrap();
        fs::create_dir(&path).unwrap();
        let before = fs::metadata(&path).unwrap().file_attributes();
        assert_eq!(before & 0x2, 0);
        ensure_metadata_dir(project.path()).unwrap();
        let after = fs::metadata(&path).unwrap().file_attributes();
        assert_eq!(after, before | 0x2);
        ensure_metadata_dir(project.path()).unwrap();
    }
}
