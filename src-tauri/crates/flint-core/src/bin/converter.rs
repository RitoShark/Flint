//! Bin converter for converting between binary, text, and JSON formats
//!
//! This module provides functionality to convert League of Legends .bin files
//! between different formats. Text conversion delegates to the `rs_bin` ritobin
//! printer/parser via `codec`; JSON conversion uses the local `bin_json`
//! mapping (`rs_bin::BinValue` is not serde-derived).

use crate::bin::bin_json;
use crate::bin::codec::{tree_to_text_cached, text_to_tree};
use crate::error::{Error, Result};
use ritoshark::bin::Bin;

fn bin_error(message: impl Into<String>) -> Error {
    Error::BinConversion {
        message: message.into(),
        path: None,
    }
}

pub fn bin_to_text(tree: &Bin) -> Result<String> {
    tree_to_text_cached(tree)
        .map_err(|e| bin_error(format!("Failed to convert to text: {}", e)))
}

pub fn text_to_bin(text: &str) -> Result<Bin> {
    text_to_tree(text)
        .map_err(|e| bin_error(format!("Failed to parse text: {}", e)))
}

pub fn bin_to_json(tree: &Bin) -> Result<String> {
    bin_json::to_json(tree).map_err(|e| bin_error(format!("JSON serialization failed: {}", e)))
}

pub fn json_to_bin(json: &str) -> Result<Bin> {
    bin_json::from_json(json).map_err(|e| bin_error(format!("JSON parse error: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_json_roundtrip() {
        let tree = Bin::new();
        let json = bin_to_json(&tree).unwrap();
        let tree2 = json_to_bin(&json).unwrap();
        assert_eq!(tree.entries.len(), tree2.entries.len());
    }
}
