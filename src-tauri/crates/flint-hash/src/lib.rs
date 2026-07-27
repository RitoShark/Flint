//! Hash primitives and the on-disk dictionaries that resolve them to names.
//!
//! The bottom layer of the workspace: the shared error type, path hashing, and
//! the LMDB-backed dictionaries. Everything here is independent of any asset
//! format, which is what lets the format and project layers sit above it.

pub mod error;
pub mod hash;

pub use error::{Error, Result};
