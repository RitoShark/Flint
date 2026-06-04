//! RST string table <-> editor JSON. Read produces a flat row list keyed by the
//! stored (already-masked) u64 hash as a decimal string; write rebuilds an `Rst`
//! from those rows (new rows may carry an unhashed `key` instead).
//!
//! Files containing encrypted (pre-v5) entries are surfaced read-only: the editor
//! JSON marks `readOnly: true` and lists encrypted rows with an empty value, and
//! the save path refuses such files.

use ritoshark::prelude::{Parse, Serialize};
use ritoshark::rst::{Rst, RstValue};
use serde::{Deserialize, Serialize as SerdeSerialize};
use std::io::Cursor;

#[derive(SerdeSerialize, Deserialize)]
pub struct Row {
    pub hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    pub value: String,
    pub encrypted: bool,
}

#[derive(SerdeSerialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StringTableData {
    pub version: u8,
    pub mode: u8,
    pub font_config: Option<String>,
    pub read_only: bool,
    pub rows: Vec<Row>,
}

/// Parse RST bytes into editor JSON.
pub fn rst_to_json(data: &[u8]) -> Result<String, String> {
    let mut reader = Cursor::new(data);
    let table = Rst::from_reader(&mut reader).map_err(|e| format!("Failed to parse rst: {e:?}"))?;

    let mut has_encrypted = false;
    let rows: Vec<Row> = table
        .entries
        .iter()
        .map(|(hash, value)| {
            let encrypted = value.as_str().is_none();
            if encrypted {
                has_encrypted = true;
            }
            Row {
                hash: hash.to_string(),
                key: None,
                value: value.as_str().unwrap_or("").to_string(),
                encrypted,
            }
        })
        .collect();

    let out = StringTableData {
        version: table.version,
        mode: table.mode,
        font_config: table.font_config.clone(),
        read_only: has_encrypted,
        rows,
    };
    serde_json::to_string(&out).map_err(|e| format!("Failed to serialize: {e}"))
}

/// Rebuild RST bytes from editor JSON. Rejects files that were marked read-only.
pub fn json_to_rst(json: &str) -> Result<Vec<u8>, String> {
    let data: StringTableData =
        serde_json::from_str(json).map_err(|e| format!("Bad JSON: {e}"))?;
    if data.read_only {
        return Err("This string table contains encrypted entries and is read-only".into());
    }

    let mut table = Rst::with_version(data.version);
    table.mode = data.mode;
    table.font_config = data.font_config;

    for row in &data.rows {
        let hash = match &row.key {
            Some(k) => Rst::hash_key(data.version, k).ok_or_else(|| {
                format!("Unsupported version {} for hashing key", data.version)
            })?,
            None => row
                .hash
                .parse::<u64>()
                .map_err(|e| format!("Bad hash '{}': {e}", row.hash))?,
        };
        table.entries.push((hash, RstValue::Text(row.value.clone())));
    }

    table
        .to_bytes()
        .map_err(|e| format!("Failed to write rst: {e:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_simple_table() {
        let mut t = Rst::with_version(5);
        t.add("game_name", "League");
        t.add("hello_world", "Hello");
        let bytes = t.to_bytes().expect("to_bytes");

        let json = rst_to_json(&bytes).expect("to json");
        let rebuilt = json_to_rst(&json).expect("from json");

        let mut r = Cursor::new(rebuilt);
        let back = Rst::from_reader(&mut r).expect("reparse");
        assert_eq!(back.get("game_name"), Some("League"));
        assert_eq!(back.get("hello_world"), Some("Hello"));
    }

    #[test]
    fn edit_and_add_rows() {
        let mut t = Rst::with_version(5);
        t.add("greeting", "hi");
        let bytes = t.to_bytes().unwrap();
        let json = rst_to_json(&bytes).unwrap();

        let mut data: StringTableData = serde_json::from_str(&json).unwrap();
        data.rows[0].value = "hello".into();
        data.rows.push(Row {
            hash: String::new(),
            key: Some("farewell".into()),
            value: "bye".into(),
            encrypted: false,
        });
        let edited = serde_json::to_string(&data).unwrap();

        let rebuilt = json_to_rst(&edited).unwrap();
        let mut r = Cursor::new(rebuilt);
        let back = Rst::from_reader(&mut r).unwrap();
        assert_eq!(back.get("greeting"), Some("hello"));
        assert_eq!(back.get("farewell"), Some("bye"));
    }
}
