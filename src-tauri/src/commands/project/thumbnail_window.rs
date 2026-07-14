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
// White line-art corner-bracket frame (the Divine style's `frame` layer). RGBA
// WebP, tinted toward the theme hue on the frontend.
static STROKE_WEBP: &[u8] = include_bytes!("../../../resources/thumbnail/stroke.webp");

// Bundled 3D map-environment assets: the Dexal map chunk (GLB, geometry +
// material slots only, textures external) and its 5 default ground/periph
// WebPs. Same `include_bytes!` ship-with-binary pattern as the disc assets.
static DEXAL_GLB: &[u8] = include_bytes!("../../../resources/thumbnail-map/dexal.glb");
static MAP_GROUND_B1: &[u8] =
    include_bytes!("../../../resources/thumbnail-map/Ground_B1_ChaosTop_A.webp");
static MAP_GROUND_C1: &[u8] =
    include_bytes!("../../../resources/thumbnail-map/Ground_C1_ChaosTop_A.webp");
static MAP_PERIPH_G: &[u8] =
    include_bytes!("../../../resources/thumbnail-map/Periph_Top_G_1bitalpha.webp");
static MAP_PERIPH_H: &[u8] =
    include_bytes!("../../../resources/thumbnail-map/Periph_Top_H_1bitalpha.webp");
static MAP_PERIPH_I: &[u8] =
    include_bytes!("../../../resources/thumbnail-map/Periph_Top_I_1bitalpha.webp");

/// Serve a bundled thumbnail asset as raw bytes. Covers the disc composites
/// (`ring`/`glow`, WebP), the Dexal map geometry (`dexal.glb`, GLB) and its
/// default ground/periph textures (WebP). Raw-bytes IPC per CLAUDE.md —
/// frontend decodes via `invokeCommand<ArrayBuffer>`.
#[tauri::command]
pub fn load_thumbnail_asset(name: String) -> Result<tauri::ipc::Response, String> {
    let bytes: &[u8] = match name.as_str() {
        "ring" => RING_WEBP,
        "glow" => GLOW_WEBP,
        "stroke" => STROKE_WEBP,
        "dexal.glb" => DEXAL_GLB,
        "Ground_B1_ChaosTop_A.webp" => MAP_GROUND_B1,
        "Ground_C1_ChaosTop_A.webp" => MAP_GROUND_C1,
        "Periph_Top_G_1bitalpha.webp" => MAP_PERIPH_G,
        "Periph_Top_H_1bitalpha.webp" => MAP_PERIPH_H,
        "Periph_Top_I_1bitalpha.webp" => MAP_PERIPH_I,
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
        // `Response` isn't Debug, so match rather than unwrap_err.
        match load_thumbnail_asset("evil".to_string()) {
            Err(e) => assert!(e.contains("Unknown thumbnail asset")),
            Ok(_) => panic!("expected an error for an unknown asset name"),
        }
    }

    #[test]
    fn serves_known_assets() {
        assert!(load_thumbnail_asset("ring".to_string()).is_ok());
        assert!(load_thumbnail_asset("glow".to_string()).is_ok());
        assert!(load_thumbnail_asset("stroke".to_string()).is_ok());
    }

    #[test]
    fn serves_map_assets() {
        assert!(load_thumbnail_asset("dexal.glb".to_string()).is_ok());
        assert!(load_thumbnail_asset("Ground_B1_ChaosTop_A.webp".to_string()).is_ok());
        assert!(load_thumbnail_asset("Periph_Top_G_1bitalpha.webp".to_string()).is_ok());
    }
}
