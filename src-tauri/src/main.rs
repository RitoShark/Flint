// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod core;
mod state;

use commands::project_watcher::WatcherState;
use commands::settings::{initialize_app_home, get_flint_home};
use flint_ltk::hash::get_hash_dir;
use core::frontend_log::{FrontendLogLayer, set_app_handle};
use state::{LmdbCacheState, WadCacheState, WadEditState};
use tauri::{Emitter, Manager};
use tracing_subscriber::{fmt, prelude::*, reload, EnvFilter};

fn main() {
    // Create log directory early so the file appender can start writing
    let log_dir = get_flint_home()
        .map(|h| h.join("logs"))
        .unwrap_or_else(|_| std::path::PathBuf::from("./logs"));
    std::fs::create_dir_all(&log_dir).ok();

    // Daily rolling log file: flint.YYYY-MM-DD.log in %APPDATA%/Flint/logs/
    let file_appender = tracing_appender::rolling::daily(&log_dir, "flint.log");
    let (file_writer, _guard) = tracing_appender::non_blocking(file_appender);

    // Initialize tracing/logging with frontend layer
    // Use reload layer so log level can be changed at runtime via set_log_level command
    //
    // Default filter configuration:
    // - Normal mode (info): Show important app events and user-facing operations
    // - Verbose mode (debug): Show detailed internal operations and diagnostics
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| {
            // Default to info level for our app, but suppress noisy dependencies
            EnvFilter::new("info")
                .add_directive("tauri=warn".parse().unwrap())
                .add_directive("tao=error".parse().unwrap())
                .add_directive("mio=warn".parse().unwrap())
        });

    let (filter_layer, reload_handle) = reload::Layer::new(filter);

    // Store a closure that captures the reload handle — avoids spelling out the full type
    commands::logging::set_reload_fn(Box::new(move |filter_str: &str| {
        let directive = if filter_str == "debug" {
            // Verbose mode: show everything from our app, suppress deps
            EnvFilter::new("debug")
                .add_directive("tauri=warn".parse().unwrap())
                .add_directive("tao=error".parse().unwrap())
                .add_directive("mio=warn".parse().unwrap())
        } else {
            // Normal mode: info level with suppressed deps
            EnvFilter::new("info")
                .add_directive("tauri=warn".parse().unwrap())
                .add_directive("tao=error".parse().unwrap())
                .add_directive("mio=warn".parse().unwrap())
        };

        reload_handle.reload(directive)
            .map_err(|e| format!("Failed to reload filter: {}", e))
    }));

    tracing_subscriber::registry()
        .with(fmt::layer())
        .with(fmt::layer().with_ansi(false).with_writer(file_writer))
        .with(FrontendLogLayer)
        .with(filter_layer)
        .init();

    tracing::info!("Flint starting...");
    tracing::info!(
        "IPC tracing active — frontend logs `[ipc#N ▶/✓]`, Rust logs `[rs-ipc#N ▶/✓]`. \
         In DevTools, call `__FLINT_IPC_STATS()` to see per-command totals. \
         Toggle JS-side trace via `localStorage.flintIpcTrace = '0'` then reload."
    );

    // Reference timestamp for startup diagnostics — relative ms since this
    // point makes the cold-start log easy to read. The previous "Rust ready"
    // → "Log level changed" gap was 79s with no visibility into what Tauri
    // was doing in between; these marks call it out.
    let t_start = std::time::Instant::now();
    tracing::info!("[startup] tauri::Builder constructed +{}ms", t_start.elapsed().as_millis());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
            }
            let file_arg = args.iter().skip(1).find(|a| {
                !a.starts_with("--") && std::path::Path::new(a.as_str()).is_file()
            });
            if let Some(path) = file_arg {
                let clean_path = std::fs::canonicalize(path)
                    .map(|p| {
                        let s = p.to_string_lossy().into_owned();
                        if s.starts_with(r"\\?\") {
                            s[4..].to_string()
                        } else {
                            s
                        }
                    })
                    .unwrap_or_else(|_| path.clone());
                let _ = app.emit("file-open-request", clean_path);
            }
        }))
        .manage(WadCacheState::new())
        .manage(LmdbCacheState::new())
        .manage(WatcherState::new())
        .manage(WadEditState::new())
        .on_page_load(move |_webview, payload| {
            // Fires once per webview page navigation — first hit is the cold
            // start and tells us when the bundle finished loading. The gap
            // between this and "set_log_level" is React mount + first IPC.
            tracing::info!(
                "[startup] webview page_load (event={:?}, url={}) +{}ms",
                payload.event(),
                payload.url(),
                t_start.elapsed().as_millis(),
            );
        })
        .setup(move |app| {
            tracing::info!("[startup] setup() running +{}ms", t_start.elapsed().as_millis());
            // Set app handle for frontend logging
            set_app_handle(app.handle().clone());

            // Initialize Flint home directory structure + migrate old hashes
            if let Err(e) = initialize_app_home() {
                tracing::error!("Failed to initialize app home: {}", e);
            }

            // Hash directory: %APPDATA%/RitoShark/Requirements/Hashes/.
            let hash_dir = get_hash_dir().unwrap_or_else(|e| {
                tracing::warn!("Failed to get hash directory: {}", e);
                app.path().app_data_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("./hashes"))
                    .join("hashes")
            });

            tracing::info!("Hash directory: {}", hash_dir.display());

            // Download pre-built LMDBs from LeagueToolkit/lmdb-hashes releases,
            // then open them. No local build step — the .mdb files are canonical.
            //
            // Performance: BIN hash caches (HashMapProvider) used to be pre-warmed
            // here via spawn_blocking, iterating the entire BIN LMDB into memory.
            // That was ~3s of work + ~hundreds of MB resident before the user did
            // anything. Now they lazy-init on first use (first BIN open / project
            // create). LMDB point lookups for WAD hashes are still primed here —
            // those are mmap-backed and free (only touched pages page in).
            let hash_dir_str = hash_dir.to_string_lossy().into_owned();
            let lmdb_state = app.state::<LmdbCacheState>().inner().clone();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tracing::info!("Checking for hash updates...");
                match flint_ltk::hash::download_hashes(&hash_dir, false).await {
                    Ok(stats) => {
                        tracing::info!(
                            "Hash sync: {} downloaded, {} up-to-date, {} errors",
                            stats.downloaded, stats.skipped, stats.errors
                        );
                    }
                    Err(e) => {
                        tracing::warn!("Failed to sync hashes (will use existing): {}", e);
                    }
                }
                let ready = match lmdb_state.prime(&hash_dir_str) {
                    Some(_) => {
                        tracing::info!("Hash LMDBs ready — point lookups active");
                        true
                    }
                    None => {
                        tracing::warn!("Hash LMDBs not available — hashes will fall back to hex");
                        false
                    }
                };

                // Notify frontend exactly once instead of having it poll
                // get_hash_status every 1s for up to 30s (was 30 IPC round-trips
                // per cold start).
                let _ = app_handle.emit("hashes-ready", ready);
            });

            // CLI arg passthrough — when Windows hands us a file via
            // "Open with" the path arrives as `argv[1]`. We don't try to
            // route it from Rust (the frontend owns project/tab state);
            // instead we emit a `file-open-request` event after the
            // webview has loaded. The frontend listens for this and
            // decides what to do (open a project, focus a WAD, etc.).
            //
            // We deliberately spawn this on a delay so the webview is
            // mounted before we fire. A page_load listener would be more
            // precise but the 250ms timer is simpler and the cost of a
            // missed event on the very first paint is just "open the
            // file by hand once". We also emit synchronously below — the
            // page_load handler above will deliver it again on the first
            // navigation if the spawn hasn't fired yet.
            let pending_file_arg: Option<String> = std::env::args()
                .nth(1)
                .filter(|a| !a.starts_with("--") && std::path::Path::new(a).is_file())
                .map(|a| {
                    // Canonicalize so the frontend gets an absolute path
                    // regardless of how Explorer invoked us.
                    std::fs::canonicalize(&a)
                        .map(|p| {
                            let s = p.to_string_lossy().into_owned();
                            if s.starts_with(r"\\?\") {
                                s[4..].to_string()
                            } else {
                                s
                            }
                        })
                        .unwrap_or(a)
                });
            if let Some(path) = pending_file_arg {
                tracing::info!("CLI arg file: {}", path);
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    let _ = h.emit("file-open-request", &path);
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::hash::download_hashes,
            commands::hash::get_hash_status,
            commands::hash::reload_hashes,
            commands::hash::force_rebuild_hashes,
            commands::wad::read_wad,
            commands::wad::get_wad_chunks,
            commands::wad::load_all_wad_chunks,
            commands::wad::extract_wad,
            commands::wad::read_wad_chunk_data,
            commands::wad::scan_game_wads,
            commands::wad::invalidate_wad_cache,
            commands::wad::extract_wad_model_preview,
            commands::wad::cleanup_wad_model_preview,
            commands::extract_hashes::extract_hashes_from_wad,
            commands::bin::convert_bin_to_text,
            commands::bin::convert_bin_to_json,
            commands::bin::convert_text_to_bin,
            commands::bin::convert_json_to_bin,
            commands::bin::read_bin_info,
            commands::bin::convert_bin_bytes_to_text,
            commands::bin::convert_bin_bytes_to_json,
            commands::bin::parse_bin_file_to_text,
            commands::bin::read_or_convert_bin,
            commands::bin::save_ritobin_to_bin,
            commands::bin::compile_ritobin_text_to_bytes,
            // League detection commands

            commands::league::detect_league,
            commands::league::validate_league,
            // Project management commands
            commands::project::create_project,
            commands::project::create_loading_screen_project,
            commands::project::open_project,
            commands::project::open_project_with_tree,
            commands::project::discover_projects,
            commands::project::forget_project,
            commands::project::save_project,
            commands::project::delete_project,
            commands::project::list_project_files,
            commands::project::projects_path_valid,
            commands::project::preconvert_project_bins,
            commands::project::create_project_layer,
            commands::project::list_project_layers,
            // Map project commands
            commands::map_project::list_available_maps,
            commands::map_project::list_map_variants,
            commands::map_project::create_map_project,
            // Champion discovery commands
            commands::champion::discover_champions,
            commands::champion::get_champion_skins,
            // File commands (preview system)
            commands::file::read_file_bytes,
            commands::file::read_file_info,
            commands::file::inspect_path,
            commands::file::decode_dds_to_png,
            commands::file::decode_bytes_to_png,
            commands::file::get_bundled_floor_png,
            commands::file::read_text_file,
            commands::file::write_text_file,
            commands::file::save_file_bytes,
            commands::file::recolor_image,
            commands::file::recolor_folder,
            commands::file::colorize_image,
            commands::file::colorize_folder,
            // File management commands
            commands::file::rename_file,
            commands::file::delete_file,
            commands::file::open_in_explorer,
            commands::file::open_with_default_app,
            commands::file::create_directory,
            commands::file::duplicate_file,
            commands::file::move_file,
            commands::file::import_external_files,
            commands::file::is_directory,
            commands::file::list_folder_contents,
            commands::bin_split::analyze_bin_for_split,
            commands::bin_split::split_bin_entries,
            commands::bin_split::analyze_folder_for_split,
            commands::bin_split::split_folder_entries,
            commands::bin_split::preview_organize_vfx,
            commands::bin_split::organize_bins_vfx,
            commands::bin_split::get_vfx_filename_command,
            // External apps commands (Jade/Quartz integration)
            commands::external_apps::detect_jade_installation,
            commands::external_apps::detect_quartz_installation,
            commands::external_apps::launch_jade,
            commands::external_apps::launch_quartz,
            commands::external_apps::detect_external_apps,
            // Export commands
            commands::export::repath_project_cmd,
            commands::export::export_fantome,
            commands::export::export_modpkg,
            commands::export::get_export_preview,
            // Mesh commands (3D preview)
            commands::mesh::read_skn_mesh,
            commands::mesh::read_scb_mesh,
            commands::mesh::read_skl_skeleton,
            commands::mesh::read_animation_list,
            commands::mesh::read_animation,
            commands::mesh::resolve_asset_path,
            // Auto-update commands
            commands::updater::check_for_updates,
            commands::updater::download_and_install_update,
            // Checkpoint commands
            commands::checkpoint::create_checkpoint,
            commands::checkpoint::list_checkpoints,
            commands::checkpoint::restore_checkpoint,
            commands::checkpoint::compare_checkpoints,
            commands::checkpoint::delete_checkpoint,
            commands::checkpoint::read_checkpoint_file,
            commands::checkpoint::get_file_changes,
            commands::checkpoint::list_checkpoints_with_diffs,
            // Audio commands (BNK/WPK editor)
            commands::audio::parse_audio_bank,
            commands::audio::parse_audio_bank_bytes,
            commands::audio::read_audio_entry,
            commands::audio::read_audio_entry_bytes,
            commands::audio::decode_wem,
            commands::audio::parse_bnk_hirc,
            commands::audio::parse_bnk_hirc_bytes,
            commands::audio::extract_bin_audio_events,
            commands::audio::map_audio_events,
            commands::audio::replace_audio_entry,
            commands::audio::replace_audio_entries,
            commands::audio::silence_audio_entry,
            commands::audio::remove_audio_entry,
            commands::audio::write_bnk,
            commands::audio::write_wpk,
            commands::audio::save_audio_file,
            // Fixer commands (Hematite integration)
            commands::fixer::get_fixer_config,
            commands::fixer::analyze_project,
            commands::fixer::fix_project,
            commands::fixer::batch_fix_projects,
            // Logging commands
            commands::logging::set_log_level,
            commands::logging::test_logging,
            // LTK Manager integration commands
            commands::ltk_manager::get_ltk_manager_mod_path,
            commands::ltk_manager::get_celestial_mod_path,
            commands::ltk_manager::sync_project_to_launcher,
            // Project watcher commands (auto-sync + preview hot reload)
            commands::project_watcher::start_project_watcher,
            commands::project_watcher::stop_project_watcher,
            commands::project_watcher::start_preview_watcher,
            commands::project_watcher::stop_preview_watcher,
            // Fantome import commands
            commands::fantome_import::analyze_fantome,
            commands::fantome_import::import_fantome_wad,
            // ModPkg import commands
            commands::modpkg_import::analyze_modpkg,
            commands::modpkg_import::import_modpkg,
            // HUD Editor commands
            commands::hud::parse_hud_ritobin_file,
            commands::hud::save_hud_ritobin_file,
            commands::hud::create_hud_project,
            commands::hud::get_hud_file_stats,
            // Format converter commands (luabin, troybin)
            commands::format_converters::convert_luabin_to_text,
            commands::format_converters::convert_troybin_to_text,
            commands::format_converters::read_wad_luabin,
            commands::format_converters::read_wad_troybin,
            // Texture format conversion (tex<->dds, +png export)
            commands::texture_convert::convert_tex_to_dds,
            commands::texture_convert::convert_dds_to_tex,
            commands::texture_convert::convert_texture_to_png,
            commands::texture_convert::convert_tex_bytes_to_dds,
            commands::texture_convert::convert_dds_bytes_to_tex,
            // In-memory WAD edit sessions
            commands::wad_edit::open_wad_edit_session,
            commands::wad_edit::close_wad_edit_session,
            commands::wad_edit::list_wad_edit_sessions,
            commands::wad_edit::read_session_chunk,
            commands::wad_edit::write_session_chunk,
            commands::wad_edit::remove_session_chunk,
            commands::wad_edit::session_dirty_chunks,
            commands::wad_edit::discard_session_changes,
            commands::wad_edit::save_session_to_path,
            // Windows file association (per-user, OpenWithProgids — non-default)
            commands::file_assoc::register_file_associations,
            commands::file_assoc::unregister_file_associations,
            commands::file_assoc::get_file_association_status,
            // Dev commands (schema aggregation)
            commands::dev::aggregate_bin_schema,
            commands::champion_schema::aggregate_champion_bin_schema,
            // Settings commands (disk-based settings)
            commands::settings::get_app_home,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::migrate_from_localstorage,
            commands::settings::migrate_projects,
            commands::settings::list_themes,
            commands::settings::load_theme,
            commands::settings::create_default_theme,
            commands::settings::seed_builtin_themes,
            // Compare-with-original / per-file backup commands
            commands::compare::find_original_file,
            commands::compare::has_file_backup,
            commands::compare::create_file_backup,
            commands::compare::read_file_backup,
            commands::compare::delete_file_backup,
            commands::chroma::port_project_to_chromas,
            commands::chroma::sync_chroma_bins,
            commands::chroma::get_chroma_links,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
