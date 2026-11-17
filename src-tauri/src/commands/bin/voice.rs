use flint_core::bin::{read_bin, write_bin, Bin, BinValue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Serialize)]
pub struct VoiceField {
    id: usize,
    label: String,
    kind: String,
    value: Value,
}
#[derive(Serialize)]
pub struct VoiceDocument {
    version: String,
    fields: Vec<VoiceField>,
}
#[derive(Deserialize)]
pub struct VoiceEdit {
    id: usize,
    value: Value,
}

fn scalar(value: &BinValue) -> Option<(&'static str, Value)> {
    Some(match value {
        BinValue::String(v) => ("string", json!(v)),
        BinValue::Bool(v) => ("bool", json!(v)),
        BinValue::F32(v) => ("float", json!(v)),
        BinValue::U8(v) => ("integer", json!(v)),
        BinValue::U16(v) => ("integer", json!(v)),
        BinValue::U32(v) => ("integer", json!(v)),
        BinValue::I32(v) => ("integer", json!(v)),
        _ => return None,
    })
}
fn assign(value: &mut BinValue, new: &Value) -> Result<(), String> {
    match value {
        BinValue::String(v) => *v = new.as_str().ok_or("Expected text")?.to_owned(),
        BinValue::Bool(v) => *v = new.as_bool().ok_or("Expected boolean")?,
        BinValue::F32(v) => {
            let n = new.as_f64().ok_or("Expected number")? as f32;
            if !n.is_finite() {
                return Err("Number is out of range".into());
            }
            *v = n;
        }
        BinValue::U8(v) => {
            *v = new
                .as_u64()
                .and_then(|v| v.try_into().ok())
                .ok_or("Expected u8")?
        }
        BinValue::U16(v) => {
            *v = new
                .as_u64()
                .and_then(|v| v.try_into().ok())
                .ok_or("Expected u16")?
        }
        BinValue::U32(v) => {
            *v = new
                .as_u64()
                .and_then(|v| v.try_into().ok())
                .ok_or("Expected u32")?
        }
        BinValue::I32(v) => {
            *v = new
                .as_i64()
                .and_then(|v| v.try_into().ok())
                .ok_or("Expected i32")?
        }
        _ => return Err("Unsupported voice field".into()),
    }
    Ok(())
}
fn fields(bin: &mut Bin, edits: &mut HashMap<usize, Value>) -> Result<Vec<VoiceField>, String> {
    let names = flint_core::bin::get_cached_bin_hashes().read();
    let name = |hash: u32| {
        names
            .get(hash as u64)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("0x{hash:08x}"))
    };
    fn walk(
        value: &mut BinValue,
        label: String,
        out: &mut Vec<VoiceField>,
        edits: &mut HashMap<usize, Value>,
        name: &impl Fn(u32) -> String,
    ) -> Result<(), String> {
        if let Some((kind, _)) = scalar(value) {
            let id = out.len();
            if let Some(new) = edits.remove(&id) {
                assign(value, &new)?;
            }
            out.push(VoiceField {
                id,
                label,
                kind: kind.into(),
                value: scalar(value).unwrap().1,
            });
            return Ok(());
        }
        match value {
            BinValue::Embed { class, fields } | BinValue::Pointer { class, fields } => {
                for (key, child) in fields {
                    walk(
                        child,
                        format!("{label} / {} / {}", name(*class), name(*key)),
                        out,
                        edits,
                        name,
                    )?;
                }
            }
            BinValue::List { items, .. } => {
                for (i, child) in items.iter_mut().enumerate() {
                    walk(child, format!("{label} [{i}]"), out, edits, name)?;
                }
            }
            BinValue::Map { entries, .. } => {
                for (i, (key, child)) in entries.iter_mut().enumerate() {
                    let key_name = match key {
                        BinValue::Hash(h) | BinValue::Link(h) => name(*h),
                        BinValue::String(s) => s.clone(),
                        _ => i.to_string(),
                    };
                    walk(child, format!("{label} [{key_name}]"), out, edits, name)?;
                }
            }
            BinValue::Option {
                value: Some(child), ..
            } => walk(child, label, out, edits, name)?,
            _ => {}
        }
        Ok(())
    }
    let mut out = Vec::new();
    for entry in &mut bin.entries {
        if entry.class_hash != 0xcf313c24 {
            continue;
        }
        for (key, value) in &mut entry.fields {
            walk(
                value,
                format!("{} / {}", name(entry.path_hash), name(*key)),
                &mut out,
                edits,
                &name,
            )?;
        }
    }
    if !edits.is_empty() {
        return Err("Voice fields changed; reload before saving".into());
    }
    Ok(out)
}
fn version(bytes: &[u8]) -> String {
    format!("{:016x}", xxhash_rust::xxh64::xxh64(bytes, 0))
}
#[tauri::command]
pub async fn read_voice_document(path: String) -> Result<VoiceDocument, String> {
    tokio::task::spawn_blocking(move || {
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        let mut bin = read_bin(&bytes).map_err(|e| e.to_string())?;
        Ok(VoiceDocument {
            version: version(&bytes),
            fields: fields(&mut bin, &mut HashMap::new())?,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn save_voice_document(
    app: tauri::AppHandle,
    path: String,
    expected_version: String,
    edits: Vec<VoiceEdit>,
) -> Result<VoiceDocument, String> {
    if let Some(root) = flint_core::mesh::discovery::find_project_root(std::path::Path::new(&path))
    {
        crate::commands::checkpoint::create_checkpoint(
            app,
            root.to_string_lossy().into_owned(),
            "Edit voice rules".into(),
            vec!["audio".into()],
        )
        .await?;
    }
    tokio::task::spawn_blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        if version(&bytes) != expected_version {
            return Err("The BIN changed on disk. Reload before saving voice rules.".into());
        }
        let mut bin = read_bin(&bytes).map_err(|e| e.to_string())?;
        let fields = fields(
            &mut bin,
            &mut edits.into_iter().map(|e| (e.id, e.value)).collect(),
        )?;
        let output = write_bin(&bin).map_err(|e| e.to_string())?;
        super::persist::replace_if_unchanged(std::path::Path::new(&path), &bytes, &output)?;
        let _ = std::fs::remove_file(format!("{path}.ritobin"));
        Ok(VoiceDocument {
            version: version(&output),
            fields,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn voice_edits_reject_narrowing_and_unknown_ids() {
        let mut value = BinValue::U8(7);
        assert!(assign(&mut value, &json!(256)).is_err());
        assert_eq!(value, BinValue::U8(7));
        assert!(assign(&mut value, &json!(-1)).is_err());
        assign(&mut value, &json!(42)).unwrap();
        assert_eq!(value, BinValue::U8(42));
        assert!(fields(
            &mut Bin::new(),
            &mut [(5, json!("wrong"))].into_iter().collect()
        )
        .is_err());
    }
}
