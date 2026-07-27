//! Shared HTTP/TLS setup for the networked modules (`cdn`, `hash::downloader`).

/// Install the `ring` crypto provider as the process default.
///
/// The HTTP client is built without a default provider, so rustls has none
/// until this runs and the first HTTPS request panics with `No provider set`.
/// Call once at startup, before any networking. Idempotent.
pub fn install_tls_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}
