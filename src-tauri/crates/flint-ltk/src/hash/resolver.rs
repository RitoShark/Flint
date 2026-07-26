//! Hash resolution with a fixed fallback chain: project overlay → global LMDB
//! → hex. Game-file call sites construct a resolver with no overlay; only
//! project-aware call sites attach one.

use crate::hash::lmdb_cache::{
    get_bin_env, get_wad_env, resolve_bin_hashes_lmdb, resolve_hashes_lmdb,
};
use crate::hash::overlay::ProjectHashOverlay;
use std::collections::HashMap;
use std::sync::Arc;

/// Owns the global hash environments plus an optional project overlay.
///
/// The global LMDBs stay read-only; the overlay is an in-memory table built
/// from the project itself.
pub struct HashResolver {
    pub(crate) wad_env: Option<Arc<heed::Env>>,
    pub(crate) bin_env: Option<Arc<heed::Env>>,
    pub(crate) overlay: Option<Arc<ProjectHashOverlay>>,
}

impl HashResolver {
    /// Global databases only. Use this for game files — a project overlay must
    /// never influence how a Riot-shipped WAD resolves.
    pub fn global(hash_dir: &str) -> Self {
        Self {
            wad_env: get_wad_env(hash_dir),
            bin_env: get_bin_env(hash_dir),
            overlay: None,
        }
    }

    /// Global databases with a project overlay consulted first.
    pub fn with_overlay(hash_dir: &str, overlay: Arc<ProjectHashOverlay>) -> Self {
        Self {
            wad_env: get_wad_env(hash_dir),
            bin_env: get_bin_env(hash_dir),
            overlay: Some(overlay),
        }
    }

    pub fn has_overlay(&self) -> bool {
        self.overlay.is_some()
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

    /// Resolve BIN identifier hashes: overlay → global LMDB → 8-hex fallback.
    pub fn resolve_bin(&self, hashes: &[u32]) -> HashMap<u32, String> {
        let mut out: HashMap<u32, String> = match &self.bin_env {
            Some(env) => resolve_bin_hashes_lmdb(hashes, env),
            None => hashes.iter().map(|h| (*h, format!("{:08x}", h))).collect(),
        };

        if let Some(overlay) = &self.overlay {
            for hash in hashes {
                if let Some(name) = overlay.bin_get(*hash) {
                    out.insert(*hash, name.to_string());
                }
            }
        }

        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::overlay::bin_identifier_hash;

    /// A resolver with no LMDB envs at all — isolates overlay-vs-hex behavior
    /// from whatever hash databases happen to be installed on the machine.
    fn overlay_only(overlay: ProjectHashOverlay) -> HashResolver {
        HashResolver {
            wad_env: None,
            bin_env: None,
            overlay: Some(Arc::new(overlay)),
        }
    }

    #[test]
    fn overlay_hit_wins_over_hex_fallback() {
        let mut o = ProjectHashOverlay::new();
        o.insert_wad(0x2a, "assets/characters/test/x.dds");

        let r = overlay_only(o);

        assert_eq!(
            r.resolve_wad(&[0x2a]),
            vec!["assets/characters/test/x.dds".to_string()]
        );
    }

    #[test]
    fn miss_in_overlay_and_lmdb_yields_16_hex() {
        let r = overlay_only(ProjectHashOverlay::new());

        assert_eq!(r.resolve_wad(&[0x2a]), vec!["000000000000002a".to_string()]);
    }

    #[test]
    fn bin_overlay_hit_wins_over_hex_fallback() {
        let mut o = ProjectHashOverlay::new();
        let h = bin_identifier_hash("MyCustomVfxDefinition");
        o.insert_bin(h, "MyCustomVfxDefinition");

        let r = overlay_only(o);
        let resolved = r.resolve_bin(&[h]);

        assert_eq!(
            resolved.get(&h).map(String::as_str),
            Some("MyCustomVfxDefinition")
        );
    }

    #[test]
    fn bin_miss_yields_8_hex() {
        let r = overlay_only(ProjectHashOverlay::new());
        let resolved = r.resolve_bin(&[0xdead_beef]);

        assert_eq!(resolved.get(&0xdead_beef).map(String::as_str), Some("deadbeef"));
    }

    #[test]
    fn a_resolver_without_an_overlay_reports_so() {
        let r = HashResolver { wad_env: None, bin_env: None, overlay: None };
        assert!(!r.has_overlay());
    }
}
