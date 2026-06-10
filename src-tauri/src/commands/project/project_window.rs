//! Separate-OS-window project view.
//!
//! Mirrors `commands::editor_window::open_editor_window`: opens (or focuses) a
//! standalone WebView2 window that re-derives everything from a single URL
//! param (the project path) + disk, so no zustand state is shared across
//! windows. Used by the titlebar tab tear-off gesture — physically dragging a
//! project tab out of the main window pops the whole project (file tree +
//! preview) into its own OS window.

/// Percent-encode a path for embedding in a URL hash query. Dependency-free
/// (mirrors `editor_window::encode_query_component`); forward slashes are
/// encoded too so the query is unambiguous.
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

/// FNV1a-32 over the project path, used to derive a stable, unique window label.
fn fnv1a32(s: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for b in s.bytes() {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Open (or focus) a separate OS window hosting the project at `project_path`.
#[tauri::command]
pub async fn open_project_window(
    app: tauri::AppHandle,
    project_path: String,
) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    let label = format!("project-{:08x}", fnv1a32(&project_path));

    // Already open for this exact project: just focus it.
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_focus();
        return Ok(());
    }

    let url = format!(
        "index.html#project?path={}",
        encode_query_component(&project_path),
    );

    // See `open_editor_window` for the full rationale: a SECOND WebView2 window
    // created while the main window uses custom `additionalBrowserArgs` throws
    // 0x8007139F unless it gets its OWN data_directory AND the SAME browser
    // args. These must match `additionalBrowserArgs` in tauri.conf.json.
    const MAIN_BROWSER_ARGS: &str =
        "--disable-features=msSmartScreenProtection --disable-background-networking --disable-translate";
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
        .join(format!("webview-{label}"));
    let _ = std::fs::create_dir_all(&data_dir);

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Flint")
        .inner_size(1280.0, 820.0)
        .resizable(true)
        .decorations(true)
        .additional_browser_args(MAIN_BROWSER_ARGS)
        .data_directory(data_dir)
        .build()
        .map_err(|e| format!("Failed to open project window: {e}"))?;

    Ok(())
}
