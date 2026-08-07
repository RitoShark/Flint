fn encode_query_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[tauri::command]
pub async fn open_model_editor_window(
    app: tauri::AppHandle,
    project_path: String,
    skn_path: String,
) -> Result<(), String> {
    use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
    const LABEL: &str = "model-editor";

    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.set_focus();
        let _ = win.emit("model-editor-load", (project_path, skn_path));
        return Ok(());
    }

    let url = format!(
        "index.html#model-editor?project={}&skn={}",
        encode_query_component(&project_path),
        encode_query_component(&skn_path),
    );

    // A second WebView2 needs both additional_browser_args and a unique data_directory or it fails with 0x8007139F. MUST match additionalBrowserArgs in tauri.conf.json.
    const MAIN_BROWSER_ARGS: &str =
        "--disable-features=msSmartScreenProtection --disable-background-networking --disable-translate";
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
        .join("webview-model-editor");
    let _ = std::fs::create_dir_all(&data_dir);

    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App(url.into()))
        .title("Flint — 3D Editor")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        .additional_browser_args(MAIN_BROWSER_ARGS)
        .data_directory(data_dir)
        .build()
        .map_err(|e| format!("Failed to open 3D editor window: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_reserved_chars() {
        assert_eq!(encode_query_component("a/b c"), "a%2Fb%20c");
        assert_eq!(encode_query_component("Aatrox.skn"), "Aatrox.skn");
    }
}
