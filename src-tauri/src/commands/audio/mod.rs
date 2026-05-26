//! Audio (BNK / WPK / WEM) editor commands.

#[allow(clippy::module_inception)]
pub mod audio;

// Flatten so `commands::audio::parse_audio_bank` keeps resolving as before.
pub use audio::*;
