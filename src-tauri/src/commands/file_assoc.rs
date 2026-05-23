//! Windows file association — "Open with" registration that coexists
//! with whatever default handler the user already has (e.g. Fantome).
//!
//! We deliberately DO NOT touch:
//!   - `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\<ext>\UserChoice`
//!     (this is the user's chosen default — overwriting it hijacks the
//!     extension. Fantome users would lose their double-click behavior.)
//!   - `HKCR\<ext>\(Default)`
//!     (legacy default-handler key — same problem at the system level.)
//!
//! We only write:
//!   1. `HKCU\Software\Classes\Flint.<Kind>` — our ProgID for each extension
//!      group. Includes `FriendlyAppName`, `DefaultIcon`, and the
//!      `shell\open\command` (`"<exe>" "%1"`).
//!   2. `HKCU\Software\Classes\<ext>\OpenWithProgids` — adds our ProgID as an
//!      *additive* "Open with" option. Explorer aggregates entries from
//!      this key across all installed apps; we don't displace anyone.
//!   3. `HKCU\Software\Classes\Applications\Flint.exe\SupportedTypes` — so
//!      "Choose another app" surfaces Flint for these extensions even when
//!      the user hasn't right-clicked one yet.
//!
//! The uninstall path mirrors these three exactly — and only deletes
//! entries we wrote. Verified by leaving `UserChoice\ProgId` intact on
//! every uninstall path.
//!
//! Implementation: pure registry I/O via the `windows` crate would add a
//! dependency; instead we shell out to `reg.exe`. It's a built-in, no
//! admin needed for HKCU, and one-shot — invocations are bounded.

use serde::{Deserialize, Serialize};
#[cfg(target_os = "windows")]
use std::process::Command;

use crate::core::ipc_trace;

/// One row in the canonical extension → ProgID map. Kept in code (not a
/// config file) so the uninstall path is guaranteed to clean up exactly
/// what install wrote — and no more.
struct AssocSpec {
    /// Extension with leading dot, e.g. ".wad". Compound extensions
    /// (.wad.client) work fine here — Windows accepts them.
    ext: &'static str,
    /// Our ProgID under HKCU\Software\Classes. Stable across versions.
    prog_id: &'static str,
    /// Friendly description shown in Explorer's Type column.
    description: &'static str,
}

const ASSOCS: &[AssocSpec] = &[
    AssocSpec { ext: ".wad",        prog_id: "Flint.WadFile",        description: "League WAD Archive" },
    AssocSpec { ext: ".wad.client", prog_id: "Flint.WadClientFile",  description: "League WAD Client Archive" },
    AssocSpec { ext: ".bin",        prog_id: "Flint.BinFile",        description: "League BIN File" },
    AssocSpec { ext: ".luabin64",   prog_id: "Flint.LuaBin64File",   description: "League Lua Bytecode (64-bit)" },
    AssocSpec { ext: ".luabin",     prog_id: "Flint.LuaBinFile",     description: "League Lua Bytecode" },
    AssocSpec { ext: ".troybin",    prog_id: "Flint.TroyBinFile",    description: "League Troy Effect" },
    AssocSpec { ext: ".tex",        prog_id: "Flint.TexFile",        description: "League TEX Texture" },
    AssocSpec { ext: ".modpkg",     prog_id: "Flint.ModPkgFile",     description: "Flint Mod Package" },
    AssocSpec { ext: ".fantome",    prog_id: "Flint.FantomeFile",    description: "Fantome Mod Package" },
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssocStatus {
    /// Extensions where Flint is listed under OpenWithProgids.
    pub registered: Vec<String>,
    /// Extensions in our spec that aren't currently registered. Useful for
    /// settings UI: "Register" button when this is non-empty.
    pub missing: Vec<String>,
    /// Path of the executable any current registration points at. None if
    /// none of our ProgIDs exist yet. If this differs from the live exe
    /// path the settings UI should prompt to re-register (post-update or
    /// install-relocation).
    pub current_exe_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssocResult {
    pub touched: Vec<String>,
    pub errors: Vec<String>,
}

/// `reg.exe add KEY /v VALUE /t TYPE /d DATA /f` — `/f` overrides without
/// prompting. We only ever write into HKCU so this never needs elevation.
#[cfg(target_os = "windows")]
fn reg_add(key: &str, value: &str, value_type: &str, data: &str) -> Result<(), String> {
    let output = Command::new("reg.exe")
        .args(["add", key, "/v", value, "/t", value_type, "/d", data, "/f"])
        .output()
        .map_err(|e| format!("Failed to launch reg.exe: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "reg.exe add {} {} failed: {}",
            key,
            value,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// `reg.exe add KEY /ve /t TYPE /d DATA /f` — sets the (Default) value
/// on a key.
#[cfg(target_os = "windows")]
fn reg_add_default(key: &str, value_type: &str, data: &str) -> Result<(), String> {
    let output = Command::new("reg.exe")
        .args(["add", key, "/ve", "/t", value_type, "/d", data, "/f"])
        .output()
        .map_err(|e| format!("Failed to launch reg.exe: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "reg.exe add {} (Default) failed: {}",
            key,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// `reg.exe add KEY /f` — create-if-missing for a key with no values.
#[cfg(target_os = "windows")]
fn reg_create_key(key: &str) -> Result<(), String> {
    let output = Command::new("reg.exe")
        .args(["add", key, "/f"])
        .output()
        .map_err(|e| format!("Failed to launch reg.exe: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "reg.exe add {} failed: {}",
            key,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn reg_delete_value(key: &str, value: &str) -> Result<(), String> {
    let output = Command::new("reg.exe")
        .args(["delete", key, "/v", value, "/f"])
        .output()
        .map_err(|e| format!("Failed to launch reg.exe: {}", e))?;
    // Missing values are not an error — they're the success case for
    // uninstall over a partial install.
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.contains("ERROR: The system was unable to find the specified registry key or value") {
            return Err(format!("reg.exe delete {} {} failed: {}", key, value, stderr));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn reg_delete_tree(key: &str) -> Result<(), String> {
    let output = Command::new("reg.exe")
        .args(["delete", key, "/f"])
        .output()
        .map_err(|e| format!("Failed to launch reg.exe: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.contains("ERROR: The system was unable to find the specified registry key or value") {
            return Err(format!("reg.exe delete {} failed: {}", key, stderr));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn reg_query_default(key: &str) -> Option<String> {
    let output = Command::new("reg.exe")
        .args(["query", key, "/ve"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    // `reg query` output: `    (Default)    REG_SZ    <value>`
    for line in stdout.lines() {
        if line.trim_start().starts_with("(Default)") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 {
                return Some(parts[2..].join(" "));
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn reg_value_exists(key: &str, value: &str) -> bool {
    let output = Command::new("reg.exe")
        .args(["query", key, "/v", value])
        .output();
    matches!(output, Ok(o) if o.status.success())
}

#[cfg(target_os = "windows")]
fn current_exe_string() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {}", e))?;
    Ok(exe.to_string_lossy().into_owned())
}

/// Register Flint as an "Open with" handler for every extension in
/// `ASSOCS`. Idempotent — re-registering after an update just refreshes
/// the exe path stored in the `shell\open\command` line. Does NOT make
/// Flint the default for any extension.
#[tauri::command]
pub async fn register_file_associations() -> Result<AssocResult, String> {
    let _t = ipc_trace::enter("register_file_associations");

    #[cfg(not(target_os = "windows"))]
    {
        return Ok(AssocResult {
            touched: vec![],
            errors: vec!["File associations are only supported on Windows".into()],
        });
    }

    #[cfg(target_os = "windows")]
    {
        let exe = current_exe_string()?;
        // `reg.exe`'s `/d` argument doesn't tolerate raw double quotes in
        // the value — we need them in the command template (`"<exe>" "%1"`),
        // so we escape them with backslash-quote per `reg.exe`'s parser.
        let cmd_template = format!("\\\"{}\\\" \\\"%1\\\"", exe);
        let icon_template = format!("\\\"{}\\\",0", exe);

        let mut touched = Vec::new();
        let mut errors = Vec::new();

        // 1. Write the per-ProgID class + shell open command.
        for spec in ASSOCS {
            let prog_key = format!("HKCU\\Software\\Classes\\{}", spec.prog_id);
            if let Err(e) = reg_add_default(&prog_key, "REG_SZ", spec.description) {
                errors.push(format!("{}: {}", spec.ext, e));
                continue;
            }
            if let Err(e) = reg_add(&prog_key, "FriendlyTypeName", "REG_SZ", spec.description) {
                errors.push(format!("{}: {}", spec.ext, e));
            }
            let icon_key = format!("{}\\DefaultIcon", prog_key);
            if let Err(e) = reg_add_default(&icon_key, "REG_SZ", &icon_template) {
                errors.push(format!("{}: {}", spec.ext, e));
            }
            let cmd_key = format!("{}\\shell\\open\\command", prog_key);
            if let Err(e) = reg_add_default(&cmd_key, "REG_SZ", &cmd_template) {
                errors.push(format!("{}: {}", spec.ext, e));
                continue;
            }

            // 2. Add ourselves to the additive `OpenWithProgids` list for
            //    the extension. We write the value name = our ProgID with
            //    REG_NONE data — that's the documented pattern for the
            //    "Open with" submenu. Critically, we do NOT touch the
            //    extension key's `(Default)` value (that would set us as
            //    default).
            let ext_key = format!("HKCU\\Software\\Classes\\{}\\OpenWithProgids", spec.ext);
            if let Err(e) = reg_create_key(&ext_key) {
                errors.push(format!("{}: {}", spec.ext, e));
                continue;
            }
            if let Err(e) = reg_add(&ext_key, spec.prog_id, "REG_NONE", "") {
                errors.push(format!("{}: {}", spec.ext, e));
                continue;
            }

            touched.push(spec.ext.to_string());
        }

        // 3. Register the app under Applications\Flint.exe so the
        //    "Choose another app" dialog can find us for these extensions
        //    even when the user hasn't right-clicked one yet.
        let exe_basename = std::path::Path::new(&exe)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("flint.exe");
        let app_key = format!("HKCU\\Software\\Classes\\Applications\\{}", exe_basename);
        if let Err(e) = reg_add(&app_key, "FriendlyAppName", "REG_SZ", "Flint") {
            errors.push(format!("Applications\\{}: {}", exe_basename, e));
        }
        let app_cmd_key = format!("{}\\shell\\open\\command", app_key);
        if let Err(e) = reg_add_default(&app_cmd_key, "REG_SZ", &cmd_template) {
            errors.push(format!("Applications\\{} cmd: {}", exe_basename, e));
        }
        let supported_key = format!("{}\\SupportedTypes", app_key);
        if let Err(e) = reg_create_key(&supported_key) {
            errors.push(format!("SupportedTypes: {}", e));
        } else {
            for spec in ASSOCS {
                let _ = reg_add(&supported_key, spec.ext, "REG_SZ", "");
            }
        }

        // Notify Explorer to refresh its icon / "Open with" caches. We
        // shell out to a tiny `rundll32` invocation rather than linking
        // shell32.dll directly — same effect, no FFI surface.
        let _ = Command::new("rundll32.exe")
            .args([
                "shell32.dll,SHChangeNotify",
                "0x08000000",
                "0x0000",
                "",
                "",
            ])
            .output();

        if errors.is_empty() {
            tracing::info!(
                "File associations registered ({} extensions, default handlers preserved)",
                touched.len()
            );
        } else {
            tracing::warn!(
                "File associations partial: {} succeeded, {} failed",
                touched.len(),
                errors.len()
            );
        }

        Ok(AssocResult { touched, errors })
    }
}

/// Remove every association we registered. Goes in the opposite order to
/// install: drop OpenWithProgids entries, drop the per-ProgID class
/// tree, drop the Applications\Flint.exe entry. `UserChoice` is never
/// touched — if Fantome (or anyone else) is the user's default, that
/// stays exactly as it was.
#[tauri::command]
pub async fn unregister_file_associations() -> Result<AssocResult, String> {
    let _t = ipc_trace::enter("unregister_file_associations");

    #[cfg(not(target_os = "windows"))]
    {
        return Ok(AssocResult {
            touched: vec![],
            errors: vec!["File associations are only supported on Windows".into()],
        });
    }

    #[cfg(target_os = "windows")]
    {
        let mut touched = Vec::new();
        let mut errors = Vec::new();

        for spec in ASSOCS {
            // Drop our entry from the additive OpenWithProgids list. If the
            // list ends up empty we leave the parent key in place — other
            // apps may still want to register against it later, and an
            // empty key has no behavior impact.
            let ext_key = format!("HKCU\\Software\\Classes\\{}\\OpenWithProgids", spec.ext);
            if let Err(e) = reg_delete_value(&ext_key, spec.prog_id) {
                errors.push(format!("{} OpenWithProgids: {}", spec.ext, e));
            }

            let prog_key = format!("HKCU\\Software\\Classes\\{}", spec.prog_id);
            if let Err(e) = reg_delete_tree(&prog_key) {
                errors.push(format!("{} class tree: {}", spec.ext, e));
            }

            touched.push(spec.ext.to_string());
        }

        let exe = current_exe_string().unwrap_or_default();
        let exe_basename = std::path::Path::new(&exe)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("flint.exe");
        let app_key = format!("HKCU\\Software\\Classes\\Applications\\{}", exe_basename);
        let _ = reg_delete_tree(&app_key);

        let _ = Command::new("rundll32.exe")
            .args([
                "shell32.dll,SHChangeNotify",
                "0x08000000",
                "0x0000",
                "",
                "",
            ])
            .output();

        Ok(AssocResult { touched, errors })
    }
}

/// Inspect which of our extensions are currently registered.
#[tauri::command]
pub async fn get_file_association_status() -> Result<AssocStatus, String> {
    let _t = ipc_trace::enter("get_file_association_status");

    #[cfg(not(target_os = "windows"))]
    {
        return Ok(AssocStatus {
            registered: vec![],
            missing: ASSOCS.iter().map(|s| s.ext.to_string()).collect(),
            current_exe_path: None,
        });
    }

    #[cfg(target_os = "windows")]
    {
        let mut registered = Vec::new();
        let mut missing = Vec::new();
        let mut current_exe_path: Option<String> = None;

        for spec in ASSOCS {
            let ext_key = format!("HKCU\\Software\\Classes\\{}\\OpenWithProgids", spec.ext);
            if reg_value_exists(&ext_key, spec.prog_id) {
                registered.push(spec.ext.to_string());
                if current_exe_path.is_none() {
                    let cmd_key = format!(
                        "HKCU\\Software\\Classes\\{}\\shell\\open\\command",
                        spec.prog_id
                    );
                    if let Some(cmd) = reg_query_default(&cmd_key) {
                        // Command is `"<exe>" "%1"` — strip the surrounding
                        // quotes and the trailing argument template.
                        let cleaned = cmd
                            .trim()
                            .trim_matches('"')
                            .split("\" \"")
                            .next()
                            .map(|s| {
                                let mut s = s.to_string();
                                if s.starts_with('"') { s.remove(0); }
                                s
                            });
                        current_exe_path = cleaned;
                    }
                }
            } else {
                missing.push(spec.ext.to_string());
            }
        }

        Ok(AssocStatus {
            registered,
            missing,
            current_exe_path,
        })
    }
}

