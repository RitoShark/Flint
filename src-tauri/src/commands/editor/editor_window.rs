//! Separate-OS-window file editor.
//!
//! Mirrors `commands::map_preview::open_map_preview_window`: opens (or focuses)
//! a standalone WebView2 window that re-derives everything from a few URL
//! params + disk, so no zustand state is shared across windows. Used by the
//! titlebar tab tear-off gesture — physically dragging the file-editor tab out
//! of the main window pops the editor into its own OS window.

/// Percent-encode a path for embedding in a URL hash query. Dependency-free
/// (mirrors `map_preview::encode_query_component`); forward slashes are encoded
/// too so the query is unambiguous.
fn encode_query_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// FNV1a-32 over the file path, used to derive a stable, unique window label.
fn fnv1a32(s: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for b in s.bytes() {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Open (or focus) a separate OS window hosting the editor for `file_path`.
///
/// `kind` is a `FileEditorKind` string from the frontend (`binText`,
/// `luaBin64`, `modConfig`, `raw`); `project_path` is optional.
#[tauri::command]
pub async fn open_editor_window(
    app: tauri::AppHandle,
    file_path: String,
    kind: String,
    project_path: Option<String>,
) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    let label = format!("editor-{:08x}", fnv1a32(&file_path));

    // Already open for this exact file: just focus it.
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_focus();
        return Ok(());
    }

    let project = project_path.unwrap_or_default();
    let url = format!(
        "index.html#editor?path={}&kind={}&project={}",
        encode_query_component(&file_path),
        encode_query_component(&kind),
        encode_query_component(&project),
    );

    // See `open_map_preview_window` for the full rationale: a SECOND WebView2
    // window created while the main window uses custom `additionalBrowserArgs`
    // throws 0x8007139F unless it gets its OWN data_directory AND the SAME
    // browser args. These must match `additionalBrowserArgs` in
    // tauri.conf.json.
    const MAIN_BROWSER_ARGS: &str =
        "--disable-features=msSmartScreenProtection --disable-background-networking --disable-translate";
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
        .join(format!("webview-{label}"));
    let _ = std::fs::create_dir_all(&data_dir);

    let filename = file_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&file_path);

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(format!("Flint — {filename}"))
        .inner_size(1000.0, 760.0)
        .resizable(true)
        .decorations(true)
        .additional_browser_args(MAIN_BROWSER_ARGS)
        .data_directory(data_dir)
        .build()
        .map_err(|e| format!("Failed to open editor window: {e}"))?;

    Ok(())
}
