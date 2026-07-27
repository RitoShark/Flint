//! Hash resolution with a fixed fallback chain: project overlay → global LMDB
//! → hex. Game-file call sites construct a resolver with no overlay; only
//! project-aware call sites attach one.

use crate::hash::lmdb_cache::{get_wad_env, resolve_hashes_lmdb, resolve_hashes_lmdb_bulk, ResolvedHashes};
use crate::overlay::overlay::ProjectHashOverlay;
use std::sync::Arc;

/// Owns the global hash environment plus an optional project overlay.
///
/// The global LMDB stays read-only; the overlay is an in-memory table built
/// from the project itself.
pub struct HashResolver {
    pub(crate) wad_env: Option<Arc<heed::Env>>,
    pub(crate) overlay: Option<Arc<ProjectHashOverlay>>,
}

impl HashResolver {
    /// Global database only. Use this for game files — a project overlay must
    /// never influence how a Riot-shipped WAD resolves.
    pub fn global(hash_dir: &str) -> Self {
        Self {
            wad_env: get_wad_env(hash_dir),
            overlay: None,
        }
    }

    /// Global database with a project overlay consulted first.
    pub fn with_overlay(hash_dir: &str, overlay: Arc<ProjectHashOverlay>) -> Self {
        Self {
            wad_env: get_wad_env(hash_dir),
            overlay: Some(overlay),
        }
    }

    /// Global database, with the project overlay attached when one is active.
    pub fn new(hash_dir: &str, overlay: Option<&Arc<ProjectHashOverlay>>) -> Self {
        Self {
            wad_env: get_wad_env(hash_dir),
            overlay: overlay.cloned(),
        }
    }

    pub fn has_overlay(&self) -> bool {
        self.overlay.is_some()
    }

    /// Whether the global WAD hash database is available.
    ///
    /// `resolve_wad` degrades to hex when it is not, which is indistinguishable
    /// from "every hash missed" — callers that must not proceed on an unusable
    /// database check this first.
    pub fn has_global_wad(&self) -> bool {
        self.wad_env.is_some()
    }

    /// Resolve WAD path hashes: overlay → global LMDB → 16-hex fallback.
    pub fn resolve_wad(&self, hashes: &[u64]) -> Vec<String> {
        // Resolve through LMDB once, then let overlay hits override. This keeps
        // the single bulk LMDB call rather than querying per hash.
        let mut out: Vec<String> = match &self.wad_env {
            Some(env) => resolve_hashes_lmdb(hashes, env),
            None => hashes.iter().map(|h| format!("{:016x}", h)).collect(),
        };

        if let Some(overlay) = &self.overlay {
            for (i, hash) in hashes.iter().enumerate() {
                if let Some(path) = overlay.wad_get(*hash) {
                    out[i] = path.to_string();
                }
            }
        }

        out
    }

    /// Bulk WAD resolution: the parallel LMDB path with overlay hits layered on
    /// top. Misses are omitted, matching `resolve_hashes_lmdb_bulk`.
    pub fn resolve_wad_bulk(&self, hashes: &[u64]) -> ResolvedHashes {
        let mut out = match &self.wad_env {
            Some(env) => resolve_hashes_lmdb_bulk(hashes, env),
            None => ResolvedHashes::default(),
        };
        if let Some(overlay) = &self.overlay {
            for h in hashes {
                if let Some(path) = overlay.wad_get(*h) {
                    out.insert(*h, path);
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A resolver with no LMDB envs at all — isolates overlay-vs-hex behavior
    /// from whatever hash databases happen to be installed on the machine.
    fn overlay_only(overlay: ProjectHashOverlay) -> HashResolver {
        HashResolver {
            wad_env: None,
            overlay: Some(Arc::new(overlay)),
        }
    }

    /// Build a fresh temp LMDB env with one `(hash -> path)` row in the named
    /// `"wad"` database, keyed by the 8-byte big-endian hash — the same layout
    /// `lmdb_cache.rs` reads. This is a fixture the test owns and drops; it is
    /// not the global read-only database.
    ///
    /// `map_size`/`max_dbs` mirror `lmdb_cache::open_env`; the write path
    /// mirrors `extract_hashes.rs`'s `merge_into_wad_lmdb`.
    fn write_test_wad_env(dir: &std::path::Path, hash: u64, path: &str) -> heed::Env {
        use heed::types::{Bytes, Str};
        use heed::{Database, EnvOpenOptions};

        let env = unsafe {
            EnvOpenOptions::new()
                .map_size(1024 * 1024 * 1024)
                .max_dbs(2)
                .open(dir)
                .expect("open temp lmdb env")
        };

        let mut wtxn = env.write_txn().expect("write_txn");
        let db: Database<Bytes, Str> = env
            .create_database(&mut wtxn, Some("wad"))
            .expect("create_database wad");
        db.put(&mut wtxn, &hash.to_be_bytes()[..], path).expect("put");
        wtxn.commit().expect("commit");

        env
    }

    #[test]
    fn overlay_hit_wins_over_hex_fallback() {
        let mut o = ProjectHashOverlay::new();
        let hash = crate::hash::wad_chunk_hash("assets/characters/test/x.dds");
        o.insert_wad(hash, "assets/characters/test/x.dds");

        let r = overlay_only(o);

        assert_eq!(
            r.resolve_wad(&[hash]),
            vec!["assets/characters/test/x.dds".to_string()]
        );
    }

    #[test]
    fn miss_in_overlay_and_lmdb_yields_16_hex() {
        let r = overlay_only(ProjectHashOverlay::new());

        assert_eq!(r.resolve_wad(&[0x2a]), vec!["000000000000002a".to_string()]);
    }

    #[test]
    fn a_resolver_without_an_overlay_reports_so() {
        let r = HashResolver { wad_env: None, overlay: None };
        assert!(!r.has_overlay());
    }

    #[test]
    fn a_resolver_with_no_wad_env_reports_no_global_wad() {
        let r = HashResolver { wad_env: None, overlay: None };
        assert!(!r.has_global_wad());
    }

    #[test]
    fn global_constructor_over_a_nonexistent_dir_reports_no_global_wad() {
        let r = HashResolver::global(NO_HASH_DIR);
        assert!(!r.has_global_wad());
    }

    /// A hash dir that does not exist yields no envs, which is fine — these two
    /// assert on the overlay field, and they must go through the real
    /// constructors. Setting `overlay: None` via a struct literal proves only
    /// that `has_overlay` reads the field, not that `global()` sets it.
    const NO_HASH_DIR: &str = "Z:/nonexistent-hash-dir";

    #[test]
    fn global_constructor_never_attaches_an_overlay() {
        let r = HashResolver::global(NO_HASH_DIR);
        assert!(!r.has_overlay());
    }

    #[test]
    fn with_overlay_constructor_attaches_the_overlay() {
        let mut o = ProjectHashOverlay::new();
        let hash = crate::hash::wad_chunk_hash("assets/characters/test/x.dds");
        o.insert_wad(hash, "assets/characters/test/x.dds");

        let r = HashResolver::with_overlay(NO_HASH_DIR, Arc::new(o));

        assert!(r.has_overlay());
        assert_eq!(
            r.resolve_wad(&[hash]),
            vec!["assets/characters/test/x.dds".to_string()]
        );
    }

    #[test]
    fn a_global_resolver_ignores_project_paths_entirely() {
        // A game-file resolver must not resolve a project's invented path even
        // when an overlay exists elsewhere in the process.
        let r = HashResolver { wad_env: None, overlay: None };
        let invented = xxhash_rust::xxh64::xxh64(b"assets/perso/mymod/ghost.dds", 0);

        assert_eq!(r.resolve_wad(&[invented]), vec![format!("{:016x}", invented)]);
    }

    #[test]
    fn resolve_wad_bulk_applies_overlay_and_omits_misses() {
        let mut o = ProjectHashOverlay::new();
        o.insert_wad(
            crate::hash::wad_chunk_hash("assets/mine/x.dds"),
            "assets/mine/x.dds",
        );
        let hit = crate::hash::wad_chunk_hash("assets/mine/x.dds");

        let r = overlay_only(o);
        let out = r.resolve_wad_bulk(&[hit, 0xdead_beef]);

        assert_eq!(out.get(&hit), Some("assets/mine/x.dds"));
        // Misses are omitted, not hex-filled — this is what distinguishes
        // resolve_wad_bulk from resolve_wad.
        assert_eq!(out.get(&0xdead_beef), None);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn overlay_shadows_a_real_global_lmdb_hit() {
        let dir = tempfile::tempdir().unwrap();
        let overlay_path = "assets/mine/override.dds";
        // The key is the hash of the OVERLAY's own path, satisfying
        // insert_wad's invariant. The global LMDB row is planted at that same
        // key but with a different value — proving the overlay genuinely wins
        // the collision rather than merely agreeing with the global value.
        let hash = crate::hash::wad_chunk_hash(overlay_path);
        let env = write_test_wad_env(dir.path(), hash, "assets/riot/real.dds");

        let mut o = ProjectHashOverlay::new();
        o.insert_wad(hash, overlay_path);

        let r = HashResolver {
            wad_env: Some(std::sync::Arc::new(env)),
            overlay: Some(Arc::new(o)),
        };

        assert_eq!(
            r.resolve_wad(&[hash]),
            vec![overlay_path.to_string()],
            "the project overlay must win over the global database"
        );
    }

    #[test]
    fn without_an_overlay_the_global_lmdb_value_is_returned() {
        let dir = tempfile::tempdir().unwrap();
        let hash = crate::hash::wad_chunk_hash("assets/riot/real.dds");
        let env = write_test_wad_env(dir.path(), hash, "assets/riot/real.dds");

        let r = HashResolver {
            wad_env: Some(std::sync::Arc::new(env)),
            overlay: None,
        };

        // Proves the LMDB arm executes at all — every other test in this file
        // runs with wad_env: None.
        assert_eq!(
            r.resolve_wad(&[hash]),
            vec!["assets/riot/real.dds".to_string()]
        );
    }

    #[test]
    fn resolve_wad_preserves_order_across_mixed_hits_and_misses() {
        let mut o = ProjectHashOverlay::new();
        let hit = crate::hash::wad_chunk_hash("assets/b.dds");
        o.insert_wad(hit, "assets/b.dds");

        let r = overlay_only(o);

        // Single-element inputs cannot distinguish "index i maps to input i"
        // from "there was only one index". Task 9 swaps this into call sites
        // that depend on positional correspondence.
        assert_eq!(
            r.resolve_wad(&[1, hit, 3]),
            vec![
                "0000000000000001".to_string(),
                "assets/b.dds".to_string(),
                "0000000000000003".to_string(),
            ]
        );
    }
}
