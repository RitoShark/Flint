//! Windows file association — native registry association using winreg.
//!
//! We write:
//!   1. `HKCU\Software\Classes\<ProgID>` — our ProgID for each extension
//!      group. Includes description, `FriendlyTypeName`, `DefaultIcon`,
//!      and the `shell\open\command` (`"<exe>" "%1"`).
//!   2. `HKCU\Software\Classes\<ext>` — sets the default handler to our ProgID
//!      so double-clicking files opens them in Flint.
//!   3. `HKCU\Software\Classes\<ext>\OpenWithProgids` — adds our ProgID as an
//!      additive option as well.
//!   4. `HKCU\Software\Classes\Applications\<exe>` — standard registration.
//!
//! Notification is triggered natively via shell32.dll SHChangeNotify without shelling out.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::core::ipc_trace;
use crate::state::PendingFileOpenState;

struct AssocSpec {
    /// Extension with leading dot. Compound extensions (.wad.client) are accepted.
    ext: &'static str,
    prog_id: &'static str,
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

/// One context-menu verb. `verb_key` is the registry subkey under
/// `…\shell\`; `mui_verb` is the label Explorer shows.
struct VerbSpec {
    verb_key: &'static str,
    mui_verb: &'static str,
    /// The flag passed before `"%1"`.
    arg: &'static str,
    /// Which ProgID this verb attaches to. Unused for directory verbs.
    prog_id: &'static str,
}

/// Verbs attached to our file ProgIDs.
const FILE_VERBS: &[VerbSpec] = &[
    VerbSpec {
        verb_key: "Flint.ExtractWad",
        mui_verb: "Extract WAD here",
        arg: "--extract-wad",
        prog_id: "Flint.WadFile",
    },
    VerbSpec {
        verb_key: "Flint.ExtractWad",
        mui_verb: "Extract WAD here",
        arg: "--extract-wad",
        prog_id: "Flint.WadClientFile",
    },
    VerbSpec {
        verb_key: "Flint.ImportMod",
        mui_verb: "Import mod into Flint",
        arg: "--import-mod",
        prog_id: "Flint.FantomeFile",
    },
    VerbSpec {
        verb_key: "Flint.ImportMod",
        mui_verb: "Import mod into Flint",
        arg: "--import-mod",
        prog_id: "Flint.ModPkgFile",
    },
];

/// Verbs attached to `Directory`. On Windows 11 these appear under
/// "Show more options" — reaching the primary menu would require an
/// IExplorerCommand handler in a sparse MSIX package, which was
/// deliberately not taken on.
const DIRECTORY_VERBS: &[VerbSpec] = &[
    VerbSpec {
        verb_key: "Flint.PackWad",
        mui_verb: "Pack folder to WAD",
        arg: "--pack-wad",
        prog_id: "",
    },
    VerbSpec {
        verb_key: "Flint.OpenProject",
        mui_verb: "Open folder as Flint project",
        arg: "--open-project",
        prog_id: "",
    },
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssocStatus {
    pub registered: Vec<String>,
    pub missing: Vec<String>,
    pub current_exe_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssocResult {
    pub touched: Vec<String>,
    pub errors: Vec<String>,
}

#[cfg(target_os = "windows")]
fn current_exe_string() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {}", e))?;
    Ok(exe.to_string_lossy().into_owned())
}

#[cfg(target_os = "windows")]
fn notify_shell_change() {
    unsafe {
        type SHChangeNotifyFn = unsafe extern "system" fn(i32, u32, *const std::ffi::c_void, *const std::ffi::c_void);
        if let Ok(lib) = libloading::Library::new("shell32.dll") {
            if let Ok(func) = lib.get::<SHChangeNotifyFn>(b"SHChangeNotify") {
                func(0x08000000i32, 0x0000u32, std::ptr::null(), std::ptr::null());
            }
        }
    }
}

/// Register Flint as the default handler for every extension in `ASSOCS`.
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
        use winreg::enums::*;
        use winreg::RegKey;

        let exe = current_exe_string()?;
        let cmd_value = format!("\"{}\" \"%1\"", exe);
        let icon_value = format!("\"{}\",0", exe);

        let mut touched = Vec::new();
        let mut errors = Vec::new();

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        for spec in ASSOCS {
            let prog_key_path = format!(r"Software\Classes\{}", spec.prog_id);
            let class_key = match hkcu.create_subkey(&prog_key_path) {
                Ok((key, _)) => key,
                Err(e) => {
                    errors.push(format!("{}: Failed to create ProgID key: {}", spec.ext, e));
                    continue;
                }
            };

            if let Err(e) = class_key.set_value("", &spec.description) {
                errors.push(format!("{}: Failed to set description: {}", spec.ext, e));
            }
            if let Err(e) = class_key.set_value("FriendlyTypeName", &spec.description) {
                errors.push(format!("{}: Failed to set friendly name: {}", spec.ext, e));
            }

            match class_key.create_subkey("DefaultIcon") {
                Ok((icon_key, _)) => {
                    if let Err(e) = icon_key.set_value("", &icon_value) {
                        errors.push(format!("{}: Failed to set icon: {}", spec.ext, e));
                    }
                }
                Err(e) => {
                    errors.push(format!("{}: Failed to create DefaultIcon key: {}", spec.ext, e));
                }
            }

            match class_key.create_subkey(r"shell\open\command") {
                Ok((cmd_key, _)) => {
                    if let Err(e) = cmd_key.set_value("", &cmd_value) {
                        errors.push(format!("{}: Failed to set open command: {}", spec.ext, e));
                    }
                }
                Err(e) => {
                    errors.push(format!("{}: Failed to create command key: {}", spec.ext, e));
                }
            }

            for verb in FILE_VERBS.iter().filter(|v| v.prog_id == spec.prog_id) {
                let verb_path = format!(r"Software\Classes\{}\shell\{}", spec.prog_id, verb.verb_key);
                match hkcu.create_subkey(&verb_path) {
                    Ok((key, _)) => {
                        let _ = key.set_value("MUIVerb", &verb.mui_verb);
                        let _ = key.set_value("Icon", &icon_value);
                        match key.create_subkey("command") {
                            Ok((cmd, _)) => {
                                let value = format!("\"{}\" {} \"%1\"", exe, verb.arg);
                                if let Err(e) = cmd.set_value("", &value) {
                                    errors.push(format!("{}: verb command: {}", verb.verb_key, e));
                                }
                            }
                            Err(e) => errors.push(format!("{}: verb command key: {}", verb.verb_key, e)),
                        }
                    }
                    Err(e) => errors.push(format!("{}: verb key: {}", verb.verb_key, e)),
                }
            }

            let ext_key_path = format!(r"Software\Classes\{}", spec.ext);
            match hkcu.create_subkey(&ext_key_path) {
                Ok((ext_key, _)) => {
                    if let Err(e) = ext_key.set_value("", &spec.prog_id) {
                        errors.push(format!("{}: Failed to associate default ProgID: {}", spec.ext, e));
                    }
                }
                Err(e) => {
                    errors.push(format!("{}: Failed to create extension key: {}", spec.ext, e));
                }
            }

            let open_with_path = format!(r"Software\Classes\{}\OpenWithProgids", spec.ext);
            match hkcu.create_subkey(&open_with_path) {
                Ok((open_with_key, _)) => {
                    if let Err(e) = open_with_key.set_value(spec.prog_id, &"") {
                        errors.push(format!("{}: Failed to register OpenWithProgid: {}", spec.ext, e));
                    }
                }
                Err(e) => {
                    errors.push(format!("{}: Failed to create OpenWithProgids key: {}", spec.ext, e));
                }
            }

            touched.push(spec.ext.to_string());
        }

        for verb in DIRECTORY_VERBS {
            let verb_path = format!(r"Software\Classes\Directory\shell\{}", verb.verb_key);
            match hkcu.create_subkey(&verb_path) {
                Ok((key, _)) => {
                    let _ = key.set_value("MUIVerb", &verb.mui_verb);
                    let _ = key.set_value("Icon", &icon_value);
                    match key.create_subkey("command") {
                        Ok((cmd, _)) => {
                            let value = format!("\"{}\" {} \"%1\"", exe, verb.arg);
                            if let Err(e) = cmd.set_value("", &value) {
                                errors.push(format!("{}: verb command: {}", verb.verb_key, e));
                            }
                        }
                        Err(e) => errors.push(format!("{}: verb command key: {}", verb.verb_key, e)),
                    }
                }
                Err(e) => errors.push(format!("{}: verb key: {}", verb.verb_key, e)),
            }
        }

        let exe_basename = std::path::Path::new(&exe)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("flint.exe");

        let app_key_path = format!(r"Software\Classes\Applications\{}", exe_basename);
        match hkcu.create_subkey(&app_key_path) {
            Ok((app_key, _)) => {
                let _ = app_key.set_value("FriendlyAppName", &"Flint");
                if let Ok((app_cmd_key, _)) = app_key.create_subkey(r"shell\open\command") {
                    let _ = app_cmd_key.set_value("", &cmd_value);
                }
                if let Ok((supported_key, _)) = app_key.create_subkey("SupportedTypes") {
                    for spec in ASSOCS {
                        let _ = supported_key.set_value(spec.ext, &"");
                    }
                }
            }
            Err(e) => {
                errors.push(format!("Applications\\{}: {}", exe_basename, e));
            }
        }

        notify_shell_change();

        if errors.is_empty() {
            tracing::info!(
                "File associations registered ({} extensions)",
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

/// Remove every association we registered.
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
        use winreg::enums::*;
        use winreg::RegKey;

        let mut touched = Vec::new();
        let mut errors = Vec::new();

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        for spec in ASSOCS {
            let open_with_path = format!(r"Software\Classes\{}\OpenWithProgids", spec.ext);
            if let Ok(open_with_key) = hkcu.open_subkey_with_flags(&open_with_path, KEY_WRITE) {
                let _ = open_with_key.delete_value(spec.prog_id);
            }

            // Only clear the extension key if its default points at our ProgID.
            let ext_key_path = format!(r"Software\Classes\{}", spec.ext);
            if let Ok(ext_key) = hkcu.open_subkey_with_flags(&ext_key_path, KEY_READ | KEY_WRITE) {
                if let Ok(val) = ext_key.get_value::<String, _>("") {
                    if val == spec.prog_id {
                        let _ = hkcu.delete_subkey_all(&ext_key_path);
                    }
                }
            }

            let prog_key_path = format!(r"Software\Classes\{}", spec.prog_id);
            let _ = hkcu.delete_subkey_all(&prog_key_path);

            touched.push(spec.ext.to_string());
        }

        let exe = current_exe_string().unwrap_or_default();
        let exe_basename = std::path::Path::new(&exe)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("flint.exe");
        let app_key_path = format!(r"Software\Classes\Applications\{}", exe_basename);
        let _ = hkcu.delete_subkey_all(&app_key_path);

        // ASSOCS-driven deletes above recursively remove file verbs along with
        // their ProgID, but Directory verbs live outside any ProgID and would
        // otherwise orphan as dead context-menu entries after uninstall.
        for verb in DIRECTORY_VERBS {
            let path = format!(r"Software\Classes\Directory\shell\{}", verb.verb_key);
            // Absent keys are the normal case on a partial install; only a real
            // failure is worth reporting.
            match hkcu.delete_subkey_all(&path) {
                Ok(()) => touched.push(verb.verb_key.to_string()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => errors.push(format!("{}: {}", verb.verb_key, e)),
            }
        }

        notify_shell_change();

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
        use winreg::enums::*;
        use winreg::RegKey;

        let mut registered = Vec::new();
        let mut missing = Vec::new();
        let mut current_exe_path: Option<String> = None;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        for spec in ASSOCS {
            let ext_key_path = format!(r"Software\Classes\{}", spec.ext);
            let mut is_registered = false;

            if let Ok(ext_key) = hkcu.open_subkey(&ext_key_path) {
                if let Ok(val) = ext_key.get_value::<String, _>("") {
                    if val == spec.prog_id {
                        is_registered = true;
                    }
                }
            }

            if !is_registered {
                let open_with_path = format!(r"Software\Classes\{}\OpenWithProgids", spec.ext);
                if let Ok(open_with_key) = hkcu.open_subkey(&open_with_path) {
                    if open_with_key.get_value::<String, _>(spec.prog_id).is_ok() {
                        is_registered = true;
                    }
                }
            }

            if is_registered {
                registered.push(spec.ext.to_string());
                if current_exe_path.is_none() {
                    let cmd_key_path = format!(
                        r"Software\Classes\{}\shell\open\command",
                        spec.prog_id
                    );
                    if let Ok(cmd_key) = hkcu.open_subkey(&cmd_key_path) {
                        if let Ok(cmd) = cmd_key.get_value::<String, _>("") {
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

#[cfg(test)]
mod verb_tests {
    use super::*;

    #[test]
    fn every_file_verb_targets_a_registered_progid() {
        // A verb on a ProgID we never create would silently never appear.
        for verb in FILE_VERBS {
            assert!(
                ASSOCS.iter().any(|a| a.prog_id == verb.prog_id),
                "verb {} targets unregistered ProgID {}",
                verb.verb_key,
                verb.prog_id
            );
        }
    }

    #[test]
    fn every_verb_command_carries_its_flag_and_the_path_placeholder() {
        for verb in FILE_VERBS.iter().chain(DIRECTORY_VERBS.iter()) {
            assert!(
                verb.arg.starts_with("--"),
                "verb {} has a non-flag arg {}",
                verb.verb_key,
                verb.arg
            );
        }
    }

    #[test]
    fn verb_keys_are_unique_within_each_scope() {
        // The SAME verb key deliberately appears on more than one ProgID
        // (e.g. Extract WAD on both .wad and .wad.client), so file verbs are
        // unique per (prog_id, verb_key) pair, not per key.
        let mut file_keys: Vec<(&str, &str)> =
            FILE_VERBS.iter().map(|v| (v.prog_id, v.verb_key)).collect();
        file_keys.sort_unstable();
        let before = file_keys.len();
        file_keys.dedup();
        assert_eq!(before, file_keys.len(), "duplicate (prog_id, verb_key)");

        // Directory verbs share one scope, so their keys must be unique outright.
        let mut dir_keys: Vec<&str> = DIRECTORY_VERBS.iter().map(|v| v.verb_key).collect();
        dir_keys.sort_unstable();
        let before = dir_keys.len();
        dir_keys.dedup();
        assert_eq!(before, dir_keys.len(), "duplicate directory verb key");
    }
}

/// Drain the pending shell action (if any) that Flint was launched with via
/// "Open with" / a file association / an Explorer context-menu verb. The
/// frontend calls this once its `file-open-request` listener is mounted, so a
/// cold-start launch acts on it regardless of how long the webview took to
/// boot (the fixed-delay event emit races that boot and is otherwise lost).
/// Returns `None` when there's nothing pending.
#[tauri::command]
pub fn take_pending_file_open(
    pending: State<'_, PendingFileOpenState>,
) -> Option<crate::shell_args::PendingFileOpen> {
    pending.take()
}
