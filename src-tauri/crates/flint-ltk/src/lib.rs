pub mod error;
pub mod audio;
pub mod bin;
pub mod wad;
pub mod wad_jade;
pub mod hash;
pub mod mesh;
pub mod champion;
pub mod league;
pub mod repath;
pub mod project;
pub mod map;
pub mod export;
pub mod checkpoint;
pub mod hud;
pub mod luabin;
pub mod troybin;
pub mod loadscreen_banner;
pub mod inibin_text;
pub mod stringtable;
pub mod manifest;
pub mod cdn;

// =============================================================================
// Re-exports for types the binary crate imports from LTK crates.
// =============================================================================

pub mod ltk_types {
    pub use ritoshark::bin::{Bin, BinEntry, BinType, BinValue};

    pub use ritoshark::hash::HashMapper;

    pub use ltk_mod_project::{ModProject, ModProjectAuthor, default_layers};

    pub use ltk_modpkg::Modpkg;
    pub use ltk_modpkg::builder::{ModpkgBuilder, ModpkgChunkBuilder, ModpkgLayerBuilder};
    pub use ltk_modpkg::{ModpkgMetadata, ModpkgAuthor};
}

pub use heed;

/// Install the rustls `ring` crypto provider as the process default.
///
/// reqwest is built with `rustls-no-provider` (avoids the heavy aws-lc-sys
/// default), so rustls has NO process-default `CryptoProvider` until one is
/// installed. Without this, the first HTTPS request (CDN manifest fetch, the
/// updater, any `reqwest::Client`) panics with `No provider set`. Call this
/// ONCE at startup before any networking. Idempotent — a second call is a no-op.
pub fn install_tls_provider() {
    // `install_default` returns Err if a provider is already installed; ignore it.
    let _ = rustls::crypto::ring::default_provider().install_default();
}
