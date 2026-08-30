/*!
Riot's asset-reference retype migration, table-driven.

One JSONL row per `(class, field)` Riot retyped — mostly `string` → `file` (xxh64 of the
lowercased path), plus a handful of `hash` → `file` rehashes and embed retags. The table is
LeagueToolkit's published list for game build 16.17.8087655 (395 rows), shipped verbatim in
`tables/`; a class or field token is either a name (FNV1a-32 of the lowercase) or `0x` hex.
*/

use std::collections::HashMap;
use std::sync::OnceLock;

use ritoshark::hash::fnv1a;

const TABLE_16_17: &str = include_str!("tables/binfile_migration_16.17.8087655.jsonl");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Conversion {
    HashValue,
    Rehash,
    HashKey,
    Retag,
}

#[derive(Debug, Clone)]
pub struct Migration {
    /// `Class.field` as the table spells it — names where it has them, `0x` hex otherwise.
    pub label: String,
    /// Just the field half of `label`, for finding the line that declares it.
    pub field: String,
    pub conversion: Conversion,
    /// The retired class an embed retag matches on.
    pub from_class: Option<u32>,
    /// Ritobin spelling of the type the field carried before, e.g. `string`.
    pub from_type: String,
    /// Ritobin spelling of the type the client reads now, e.g. `file`.
    pub to_type: String,
}

#[derive(serde::Deserialize)]
struct Row {
    class: String,
    field: String,
    from: RowType,
    to: RowType,
    conversion: String,
}

#[derive(serde::Deserialize)]
struct RowType {
    #[serde(rename = "type")]
    kind: Option<String>,
    class: Option<String>,
    key: Option<String>,
    value: Option<String>,
}

/// The table names types in Rust-ish PascalCase (`String`, `File`, `Map`); ritobin
/// prints them lowercase, which is what the editor shows and what a search matches.
fn ritobin_type(t: &RowType) -> String {
    let base = t.kind.as_deref().unwrap_or_default().to_ascii_lowercase();
    match (base.as_str(), t.key.as_deref(), t.value.as_deref()) {
        ("map", Some(k), Some(v)) => {
            format!("map[{},{}]", k.to_ascii_lowercase(), v.to_ascii_lowercase())
        }
        ("list" | "list2" | "option", _, Some(v)) => {
            format!("{base}[{}]", v.to_ascii_lowercase())
        }
        _ => base,
    }
}

fn token(written: &str) -> Option<u32> {
    match written.strip_prefix("0x") {
        Some(digits) => u32::from_str_radix(digits, 16).ok(),
        None => Some(fnv1a(written)),
    }
}

pub fn table_key(class: u32, field: u32) -> u64 {
    ((class as u64) << 32) | field as u64
}

fn parse() -> HashMap<u64, Migration> {
    let mut rows = HashMap::new();
    for line in TABLE_16_17.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Row>(line) else {
            tracing::warn!("migration table: unreadable row: {line}");
            continue;
        };
        let (Some(class), Some(field)) = (token(&row.class), token(&row.field)) else {
            tracing::warn!("migration table: unreadable token: {line}");
            continue;
        };
        let conversion = match row.conversion.as_str() {
            "hash_value" => Conversion::HashValue,
            "rehash" => Conversion::Rehash,
            "hash_key" => Conversion::HashKey,
            "none" => Conversion::Retag,
            other => {
                tracing::warn!("migration table: unknown conversion {other}");
                continue;
            }
        };
        rows.insert(
            table_key(class, field),
            Migration {
                label: format!("{}.{}", row.class, row.field),
                field: row.field.clone(),
                conversion,
                from_class: row.from.class.as_deref().and_then(token),
                from_type: ritobin_type(&row.from),
                to_type: ritobin_type(&row.to),
            },
        );
    }
    rows
}

pub fn table() -> &'static HashMap<u64, Migration> {
    static TABLE: OnceLock<HashMap<u64, Migration>> = OnceLock::new();
    TABLE.get_or_init(parse)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_table_holds_every_row() {
        assert_eq!(table().len(), 395);
    }

    #[test]
    fn named_tokens_hash_the_way_the_format_does() {
        let m = &table()[&table_key(fnv1a("AnimationResourceData"), fnv1a("mAnimationFilePath"))];
        assert_eq!(m.conversion, Conversion::HashValue);
        assert_eq!(m.label, "AnimationResourceData.mAnimationFilePath");
    }

    #[test]
    fn unpadded_hex_tokens_parse() {
        let m = &table()[&table_key(fnv1a("TFTLobbyViewController"), 0x0e31300f)];
        assert_eq!(m.conversion, Conversion::Rehash);
    }

    #[test]
    fn a_retag_row_carries_its_retired_class() {
        let m = &table()[&table_key(0x3b09052f, fnv1a("value"))];
        assert_eq!(m.conversion, Conversion::Retag);
        assert_eq!(m.from_class, Some(0x73b4a2eb));
    }

    #[test]
    fn conversion_counts_match_the_published_table() {
        let count = |wanted: Conversion| {
            table()
                .values()
                .filter(|m| m.conversion == wanted)
                .count()
        };
        assert_eq!(count(Conversion::HashValue), 385);
        assert_eq!(count(Conversion::Rehash), 7);
        assert_eq!(count(Conversion::HashKey), 1);
        assert_eq!(count(Conversion::Retag), 2);
    }
}
