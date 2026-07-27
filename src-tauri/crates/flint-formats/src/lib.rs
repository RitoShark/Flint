//! Standalone parsers and writers for the game's asset formats.
//!
//! Every module here is pure: bytes in, data out. No filesystem walking, no
//! network, no shared caches — which is what keeps this crate cheap to compile
//! and its tests fast.

pub mod audio;
pub mod hud;
pub mod inibin_text;
pub mod luabin;
pub mod manifest;
pub mod stringtable;
pub mod troybin;
