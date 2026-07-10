//! Opens the separate Thumbnail Creator window. Mirrors the map-preview window
//! pattern: reuse-by-label, unique WebView2 data dir + matching browser args on
//! Windows (the 0x8007139F guard). See CLAUDE.md "Multi-window pattern".

/// Percent-encode a path for a URL hash query (dependency-free).
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
pub async fn open_thumbnail_window(
    app: tauri::AppHandle,
    project_path: String,
    skn_path: String,
) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    const LABEL: &str = "thumbnail";

    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.set_focus();
        return Ok(());
    }

    let url = format!(
        "index.html#thumbnail?project={}&skn={}",
        encode_query_component(&project_path),
        encode_query_component(&skn_path),
    );

    // MUST match `additionalBrowserArgs` in tauri.conf.json.
    const MAIN_BROWSER_ARGS: &str =
        "--disable-features=msSmartScreenProtection --disable-background-networking --disable-translate";
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
        .join("webview-thumbnail");
    let _ = std::fs::create_dir_all(&data_dir);

    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App(url.into()))
        .title("Flint — Thumbnail Creator")
        .inner_size(1280.0, 800.0)
        .resizable(true)
        .additional_browser_args(MAIN_BROWSER_ARGS)
        .data_directory(data_dir)
        .build()
        .map_err(|e| format!("Failed to open thumbnail window: {e}"))?;
    Ok(())
}

// Bundled disc composite assets (lossless WebP, RGBA). Same `include_bytes!`
// pattern as `FLOOR_PNG` / `BASE_MASK_TEX` — small, fixed, ship-with-binary
// assets don't need the `resource_dir()` external-file indirection.
static RING_WEBP: &[u8] = include_bytes!("../../../resources/thumbnail/ring.webp");
static GLOW_WEBP: &[u8] = include_bytes!("../../../resources/thumbnail/glow.webp");

/// Serve a bundled thumbnail disc-composite asset (`ring` or `glow`) as raw
/// WebP bytes. Raw-bytes IPC per CLAUDE.md — frontend decodes via
/// `invokeCommand<ArrayBuffer>`.
#[tauri::command]
pub fn load_thumbnail_asset(name: String) -> Result<tauri::ipc::Response, String> {
    let bytes: &[u8] = match name.as_str() {
        "ring" => RING_WEBP,
        "glow" => GLOW_WEBP,
        other => return Err(format!("Unknown thumbnail asset \"{other}\"")),
    };
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encodes_reserved_chars() {
        assert_eq!(encode_query_component("a/b c"), "a%2Fb%20c");
        assert_eq!(encode_query_component("Skin.skn"), "Skin.skn");
    }

    #[test]
    fn rejects_unknown_asset_name() {
        let err = load_thumbnail_asset("evil".to_string()).unwrap_err();
        assert!(err.contains("Unknown thumbnail asset"));
    }

    #[test]
    fn serves_known_assets() {
        assert!(load_thumbnail_asset("ring".to_string()).is_ok());
        assert!(load_thumbnail_asset("glow".to_string()).is_ok());
    }
}
