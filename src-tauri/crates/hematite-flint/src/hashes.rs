//! Hash-provider construction.
//!
//! Flint already ships / downloads the RitoShark LMDB hash database at
//! `%APPDATA%\RitoShark\Requirements\Hashes\hashes.lmdb`, which is exactly what
//! `hematite-file`'s `LmdbHashProvider` reads. So the fixer reuses it — no new
//! download path. Falls back to the TXT dictionaries the CLI also supports.

use hematite_core::traits::HashProvider;
use hematite_file::hash_adapter::TxtHashProvider;
use hematite_file::lmdb_hash_adapter::LmdbHashProvider;
use std::sync::Arc;

/// Build a hash provider (LMDB preferred, TXT fallback).
///
/// Returns a clear error when neither is available so the UI can tell the user
/// to download the hash database.
pub fn hash_provider() -> anyhow::Result<Arc<dyn HashProvider>> {
    match LmdbHashProvider::load_from_appdata() {
        Ok(p) => Ok(Arc::new(p)),
        Err(lmdb_err) => {
            tracing::warn!("LMDB hash provider unavailable: {lmdb_err}; trying TXT");
            match TxtHashProvider::load_from_appdata() {
                Ok(p) => Ok(Arc::new(p)),
                Err(txt_err) => anyhow::bail!(
                    "No hash database found. Download hashes first (LMDB: {lmdb_err}; TXT: {txt_err})."
                ),
            }
        }
    }
}
