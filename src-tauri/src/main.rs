// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod core;
mod shell_args;
mod startup;
mod state;

use commands::project_watcher::WatcherState;
use commands::settings::{initialize_app_home, get_flint_home};
use flint_core::hash::get_hash_dir;
use core::frontend_log::{FrontendLogLayer, set_app_handle};
use shell_args::PendingFileOpen;
use state::{CdnSessionState, HashOverlayState, LmdbCacheState, PendingFileOpenState, WadCacheState, WadEditState};
use tauri::{Emitter, Manager};
use tracing_subscriber::{fmt, prelude::*, reload, EnvFilter};

fn main() {
    // reqwest uses `rustls-no-provider`; install the ring crypto provider as the
    // process default before any HTTPS request, or the first fetch panics with
    // "No provider set" (CDN manifest browse, updater, …).
    flint_core::net::install_tls_provider();

    let log_dir = get_flint_home()
        .map(|h| h.join("logs"))
        .unwrap_or_else(|_| std::path::PathBuf::from("./logs"));
    std::fs::create_dir_all(&log_dir).ok();

    let file_appender = tracing_appender::rolling::daily(&log_dir, "flint.log");
    let (file_writer, _guard) = tracing_appender::non_blocking(file_appender);

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| {
            EnvFilter::new("info")
                .add_directive("tauri=warn".parse().unwrap())
                .add_directive("tao=error".parse().unwrap())
                .add_directive("mio=warn".parse().unwrap())
        });

    let (filter_layer, reload_handle) = reload::Layer::new(filter);

    commands::logging::set_reload_fn(Box::new(move |filter_str: &str| {
        let directive = if filter_str == "debug" {
            EnvFilter::new("debug")
                .add_directive("tauri=warn".parse().unwrap())
                .add_directive("tao=error".parse().unwrap())
                .add_directive("mio=warn".parse().unwrap())
        } else {
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

    let t_start = std::time::Instant::now();
    tracing::info!("[startup] tauri::Builder constructed +{}ms", t_start.elapsed().as_millis());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let startup_pending = app
                .try_state::<startup::StartupGate>()
                .map(|gate| !gate.is_resolved())
                .unwrap_or(false);
            if startup_pending {
                if let Some(window) = app.get_webview_window("updater") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
            }
            if let Some(pending) = crate::shell_args::parse_shell_args(&args) {
                let target = std::path::Path::new(&pending.path);
                let valid = if pending.action.targets_directory() {
                    target.is_dir()
                } else {
                    target.is_file()
                };
                if valid {
                    let clean = std::fs::canonicalize(target)
                        .map(|p| {
                            let s = p.to_string_lossy().into_owned();
                            s.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(s)
                        })
                        .unwrap_or_else(|_| pending.path.clone());
                    let pending = PendingFileOpen { path: clean, ..pending };
                    // Stash for pull-on-mount AND emit for an already-running frontend.
                    app.state::<PendingFileOpenState>().set(pending.clone());
                    let _ = app.emit("file-open-request", pending);
                }
            }
        }))
        .manage(startup::StartupGate::default())
        .manage(WadCacheState::new())
        .manage(LmdbCacheState::new())
        .manage(WatcherState::new())
        .manage(WadEditState::new())
        .manage(CdnSessionState::new())
        .manage(PendingFileOpenState::new())
        .manage(HashOverlayState::new())
        .on_page_load(move |_webview, payload| {
            tracing::info!(
                "[startup] webview page_load (event={:?}, url={}) +{}ms",
                payload.event(),
                payload.url(),
                t_start.elapsed().as_millis(),
            );
        })
        .setup(move |app| {
            tracing::info!("[startup] setup() running +{}ms", t_start.elapsed().as_millis());
            set_app_handle(app.handle().clone());

            if let Err(e) = initialize_app_home() {
                tracing::error!("Failed to initialize app home: {}", e);
            }

            if let Some(updater) = app.get_webview_window("updater") {
                let handle = app.handle().clone();
                updater.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        let resolved = handle
                            .try_state::<startup::StartupGate>()
                            .map(|gate| gate.is_resolved())
                            .unwrap_or(false);
                        if !resolved {
                            api.prevent_close();
                            handle.exit(0);
                        }
                    }
                });
            }

            let hash_dir = get_hash_dir().unwrap_or_else(|e| {
                tracing::warn!("Failed to get hash directory: {}", e);
                app.path().app_data_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("./hashes"))
                    .join("hashes")
            });

            tracing::info!("Hash directory: {}", hash_dir.display());

            let hash_dir_str = hash_dir.to_string_lossy().into_owned();
            let lmdb_state = app.state::<LmdbCacheState>().inner().clone();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tracing::info!("Checking for hash updates...");
                match flint_core::hash::download_hashes(&hash_dir, false).await {
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

                let _ = app_handle.emit("hashes-ready", ready);
            });

            // CLI arg passthrough: when Windows hands us a file via "Open with"
            // or a context-menu verb, the action arrives as argv. Emit a
            // `file-open-request` event (on a short delay so the webview is
            // mounted) for the frontend to act on.
            let cli_args: Vec<String> = std::env::args().collect();
            let pending_shell_open: Option<PendingFileOpen> =
                crate::shell_args::parse_shell_args(&cli_args).and_then(|pending| {
                    let target = std::path::Path::new(&pending.path);
                    let valid = if pending.action.targets_directory() {
                        target.is_dir()
                    } else {
                        target.is_file()
                    };
                    if !valid {
                        return None;
                    }
                    let clean = std::fs::canonicalize(target)
                        .map(|p| {
                            let s = p.to_string_lossy().into_owned();
                            s.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(s)
                        })
                        .unwrap_or_else(|_| pending.path.clone());
                    Some(PendingFileOpen { path: clean, ..pending })
                });
            if let Some(pending) = pending_shell_open {
                tracing::info!("CLI arg: {:?} {}", pending.action, pending.path);
                // Stash so the frontend can pull it once its listener mounts —
                // on a cold start the webview boot far outlasts any fixed delay,
                // so the event alone races the listener and is lost.
                app.state::<PendingFileOpenState>().set(pending.clone());
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    let _ = h.emit("file-open-request", &pending);
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup::startup_window_ready,
            startup::startup_main_ready,
            startup::startup_continue,
            startup::startup_take_installed_update,
            commands::hash::download_hashes,
            commands::hash::get_hash_status,
            commands::hash::reload_hashes,
            commands::hash::force_rebuild_hashes,
            commands::wad::read_wad,
            commands::wad::get_wad_chunks,
            commands::wad::load_all_wad_chunks,
            commands::wad::extract_wad,
            commands::wad::read_wad_chunk_data,
            commands::wad::concat_wad_skin_bin,
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
            commands::bin::unhash_bin_text,
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
            commands::project::rebuild_loading_screen_bin,
            commands::project::open_project,
            commands::project::open_project_with_tree,
            commands::project::discover_projects,
            commands::project::forget_project,
            commands::project::save_project,
            commands::project::hard_rename_project,
            commands::project::delete_project,
            commands::project::list_project_files,
            commands::project::projects_path_valid,
            commands::project::preconvert_project_bins,
            commands::project::create_project_layer,
            commands::project::list_project_layers,
            commands::hash_overlay::build_project_hash_overlay,
            commands::hash_overlay::clear_project_hash_overlay,
            // Map project commands
            commands::map_project::list_available_maps,
            commands::map_project::list_map_variants,
            commands::map_project::create_map_project,
            // Map preview commands (separate-window 3D map preview)
            commands::map_preview::load_map_preview,
            commands::map_preview::load_map_texture,
            commands::map_preview::open_map_preview_window,
            commands::map_preview::resolve_map_texture_path,
            commands::thumbnail_window::open_thumbnail_window,
            commands::thumbnail_window::load_thumbnail_asset,
            commands::map_tiles::combine_ground_to_psd,
            commands::map_tiles::apply_psd_to_textures,
            commands::map_tiles::ground_psd_exists,
            commands::map_tiles::combine_category_to_psd,
            commands::map_tiles::apply_category_psd,
            commands::map_tiles::category_psd_exists,
            commands::map_tiles::list_map_texture_sections,
            commands::map_tiles::save_painted_texture,
            // Champion discovery commands
            commands::champion::discover_champions,
            commands::champion::get_champion_skins,
            // File commands (preview system)
            commands::file::read_file_bytes,
            commands::file::read_file_info,
            commands::file::inspect_path,
            commands::file::decode_dds_to_png,
            commands::file::decode_bytes_to_png,
            commands::file::decode_bytes_to_rgba,
            commands::file::get_bundled_floor_png,
            commands::file::get_bundled_skybox_face,
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
            commands::file::copy_between_projects,
            commands::file::move_between_projects,
            commands::file::check_transfer_conflicts,
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
            commands::mesh::resolve_anm_skin,
            commands::animask::read_animation_masks,
            commands::animask::save_animation_masks,
            commands::animask::bin_has_animation_masks,
            // CDN manifest browser commands
            commands::cdn::cdn_list_manifests,
            commands::cdn::cdn_list_versions,
            commands::cdn::cdn_cached_versions,
            commands::cdn::cdn_load_manifest,
            commands::cdn::cdn_load_manifest_by_path,
            commands::cdn::cdn_list_wad,
            commands::cdn::cdn_read_inner,
            commands::cdn::cdn_extract,
            commands::cdn::cdn_extract_wad_unpacked,
            commands::cdn::cdn_download_wad_raw,
            commands::cdn::cdn_close_session,
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
            // Windows taskbar progress indicator
            commands::taskbar::set_taskbar_progress,
            // Logging commands
            commands::logging::set_log_level,
            commands::logging::test_logging,
            // LTK Manager integration commands
            commands::ltk_manager::get_ltk_manager_mod_path,
            commands::ltk_manager::get_celestial_mod_path,
            commands::ltk_manager::sync_project_to_launcher,
            commands::ltk_manager::sync_project_to_celestial,
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
            // Extracted-folder import commands
            commands::folder_import::analyze_extracted_folder,
            commands::folder_import::import_extracted_folder,
            // ModPkg edit (minimal metadata editor) commands
            commands::modpkg_edit::open_modpkg_session,
            commands::modpkg_edit::save_modpkg_session,
            commands::modpkg_edit::close_modpkg_session,
            // Fantome/ModPkg archive editor commands
            commands::archive_edit::open_archive_session,
            commands::archive_edit::write_archive_meta,
            commands::archive_edit::close_archive_session,
            commands::archive_edit::open_inner_wad,
            commands::archive_edit::save_archive_session,
            // HUD Editor commands
            commands::hud::parse_hud_ritobin_file,
            commands::hud::save_hud_ritobin_file,
            commands::hud::create_hud_project,
            commands::hud::get_hud_file_stats,
            // Animated loadscreen banner
            commands::loadscreen_banner::get_loadscreen_banner_info,
            commands::loadscreen_banner::apply_loadscreen_banner,
            commands::loadscreen_banner::save_banner_mask,
            // Skin fixer (Hematite integration)
            commands::skin_fixer::hematite_list_fixes,
            commands::skin_fixer::hematite_scan_projects,
            commands::skin_fixer::hematite_run_fixes,
            // Format converter commands (luabin, troybin)
            commands::format_converters::convert_luabin_to_text,
            commands::format_converters::read_luabin_text,
            commands::format_converters::convert_troybin_to_text,
            commands::format_converters::read_troybin_text,
            commands::format_converters::read_wad_luabin,
            commands::format_converters::read_wad_troybin,
            commands::format_converters::read_wad_inibin,
            commands::format_converters::read_wad_rst,
            commands::format_converters::read_inibin_text,
            commands::format_converters::save_inibin_text,
            commands::format_converters::read_stringtable_json,
            commands::format_converters::save_stringtable_json,
            commands::format_converters::read_manifest_json,
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
            commands::wad_edit::rename_session_chunk,
            commands::wad_edit::session_dirty_chunks,
            commands::wad_edit::discard_session_changes,
            commands::wad_edit::save_session_to_path,
            commands::wad_edit::folder_wad_chunks,
            // Pack an extracted WAD folder back into a .wad.client
            commands::wad_pack::pack_folder_to_wad,
            // Windows file association (per-user, OpenWithProgids — non-default)
            commands::file_assoc::register_file_associations,
            commands::file_assoc::unregister_file_associations,
            commands::file_assoc::get_file_association_status,
            commands::file_assoc::take_pending_file_open,
            // Dev commands (schema aggregation)
            commands::dev::aggregate_bin_schema,
            commands::champion_schema::aggregate_champion_bin_schema,
            commands::tft_schema::aggregate_tft_bin_schema,
            commands::troybin_schema::aggregate_troybin_schema,
            commands::luabin_extract::extract_all_luabins,
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
