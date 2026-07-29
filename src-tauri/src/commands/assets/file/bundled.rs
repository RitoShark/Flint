
static FLOOR_PNG: &[u8] = include_bytes!("../../../../resources/floor.png");
// Skybox cubemap faces (WebP). Order matches +X,-X,+Y,-Y,+Z,-Z.
static SKYBOX_PX: &[u8] = include_bytes!("../../../../resources/skybox/px.webp");
static SKYBOX_NX: &[u8] = include_bytes!("../../../../resources/skybox/nx.webp");
static SKYBOX_PY: &[u8] = include_bytes!("../../../../resources/skybox/py.webp");
static SKYBOX_NY: &[u8] = include_bytes!("../../../../resources/skybox/ny.webp");
static SKYBOX_PZ: &[u8] = include_bytes!("../../../../resources/skybox/pz.webp");
static SKYBOX_NZ: &[u8] = include_bytes!("../../../../resources/skybox/nz.webp");

/// Get floor texture as PNG bytes. Checks `%APPDATA%/Flint/themes/floor.png`
/// first for user customization, falls back to the bundled default.

#[tauri::command]
pub fn get_bundled_floor_png() -> tauri::ipc::Response {
    if let Ok(home) = crate::commands::settings::get_flint_home() {
        let custom = home.join("themes").join("floor.png");
        if custom.exists() {
            if let Ok(bytes) = std::fs::read(&custom) {
                return tauri::ipc::Response::new(bytes);
            }
        }
    }
    tauri::ipc::Response::new(FLOOR_PNG.to_vec())
}

/// Get one bundled skybox cubemap face as raw WebP bytes (the model-preview
/// skybox). `face` is one of px|nx|py|ny|pz|nz; unknown names fall back to px.
#[tauri::command]
pub fn get_bundled_skybox_face(face: String) -> tauri::ipc::Response {
    let bytes: &[u8] = match face.as_str() {
        "nx" => SKYBOX_NX,
        "py" => SKYBOX_PY,
        "ny" => SKYBOX_NY,
        "pz" => SKYBOX_PZ,
        "nz" => SKYBOX_NZ,
        _ => SKYBOX_PX,
    };
    tauri::ipc::Response::new(bytes.to_vec())
}

