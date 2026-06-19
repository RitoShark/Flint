#[allow(clippy::module_inception)]
pub mod league;
pub mod champion;
pub mod champion_schema;
pub mod tft_schema;
pub mod troybin_schema;
pub mod luabin_extract;
pub mod hash;

pub use league::*;
