use flint_ltk::repath::{organize_project, OrganizerConfig};
use flint_ltk::ltk_types::{ModProject, ModProjectAuthor};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportMetadata {
    pub name: String,
    pub author: String,
    pub version: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportResult {
    pub success: bool,
    pub output_path: String,
    pub file_count: usize,
    pub total_size: u64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepathResultDto {
    pub success: bool,
    pub bins_processed: usize,
    pub paths_modified: usize,
    pub files_relocated: usize,
    pub missing_paths: Vec<String>,
    pub message: String,
}

#[tauri::command]
pub async fn repath_project_cmd(
    project_path: String,
    creator_name: Option<String>,
    project_name: Option<String>,
    app: tauri::AppHandle,
) -> Result<RepathResultDto, String> {
    tracing::info!("Frontend requested repathing for: {}", project_path);

    let path = PathBuf::from(&project_path);
    let content_base = path.join("content").join("base");
    
    let creator = creator_name.unwrap_or_else(|| "bum".to_string());
    let project = project_name.unwrap_or_else(|| "mod".to_string());

    let _ = app.emit("repath-progress", serde_json::json!({
        "status": "starting",
        "message": "Starting repathing..."
    }));

    let config = OrganizerConfig {
        enable_concat: true,
        enable_repath: true,
        creator_name: creator.clone(),
        project_name: project.clone(),
        champion: String::new(),
        target_skin_id: 0,
        cleanup_unused: true,
        wad_folder_override: None,
        skip_bin_cleanup: false,
        delete_sources: true,
    };

    let result = tokio::task::spawn_blocking(move || {
        let path_mappings: HashMap<String, String> = HashMap::new();
        organize_project(&content_base, &config, &path_mappings)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    match result {
        Ok(result) => {
            let repath_res = result.repath_result.as_ref();
            let bins_processed = repath_res.map(|r| r.bins_processed).unwrap_or(0);
            let paths_modified = repath_res.map(|r| r.paths_modified).unwrap_or(0);
            let files_relocated = repath_res.map(|r| r.files_relocated).unwrap_or(0);
            let missing_paths = repath_res.map(|r| r.missing_paths.clone()).unwrap_or_default();

            let _ = app.emit("repath-progress", serde_json::json!({
                "status": "complete",
                "message": format!("Repathed {} paths in {} BIN files", paths_modified, bins_processed)
            }));

            Ok(RepathResultDto {
                success: true,
                bins_processed,
                paths_modified,
                files_relocated,
                missing_paths,
                message: format!(
                    "Successfully repathed {} paths in {} BIN files",
                    paths_modified, bins_processed
                ),
            })
        }
        Err(e) => {
            let _ = app.emit("repath-progress", serde_json::json!({
                "status": "error",
                "message": format!("Repathing failed: {}", e)
            }));

            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub async fn export_fantome(
    project_path: String,
    output_path: String,
    _champion: String,
    metadata: ExportMetadata,
    _auto_repath: Option<bool>,
    app: tauri::AppHandle,
) -> Result<ExportResult, String> {
    tracing::info!(
        "Frontend requested fantome export: {} -> {}",
        project_path,
        output_path
    );

    let path = PathBuf::from(&project_path);
    let output = PathBuf::from(&output_path);

    let _ = app.emit("export-progress", serde_json::json!({
        "status": "exporting",
        "progress": 0.3,
        "message": "Creating fantome package..."
    }));

    let mod_config_path = path.join("mod.config.json");
    let mod_project = if mod_config_path.exists() {
        let config_data = std::fs::read_to_string(&mod_config_path)
            .map_err(|e| format!("Failed to read mod.config.json: {}", e))?;
        serde_json::from_str::<ModProject>(&config_data)
            .map_err(|e| format!("Failed to parse mod.config.json: {}", e))?
    } else {
        ModProject {
            name: slugify(&metadata.name),
            display_name: metadata.name.clone(),
            version: metadata.version.clone(),
            description: metadata.description.clone(),
            authors: vec![ModProjectAuthor::Name(metadata.author.clone())],
            license: None,
            transformers: vec![],
            layers: flint_ltk::ltk_types::default_layers(),
            thumbnail: None,
        }
    };

    let export_path = path.clone();
    let export_output = output.clone();

    let result = tokio::task::spawn_blocking(move || {
        export_with_ltk_fantome(&export_path, &export_output, &mod_project)
    })
    .await
    .map_err(|e| format!("Export task failed: {}", e))?;

    match result {
        Ok((file_count, total_size)) => {
            let _ = app.emit("export-progress", serde_json::json!({
                "status": "complete",
                "progress": 1.0,
                "message": format!("Export complete: {}", output.display())
            }));

            Ok(ExportResult {
                success: true,
                output_path: output.to_string_lossy().to_string(),
                file_count,
                total_size,
                message: format!(
                    "Successfully exported {} files ({} bytes)",
                    file_count, total_size
                ),
            })
        }
        Err(e) => {
            let _ = app.emit("export-progress", serde_json::json!({
                "status": "error",
                "progress": 0.0,
                "message": format!("Export failed: {}", e)
            }));

            Err(e)
        }
    }
}

fn export_with_ltk_fantome(
    project_path: &Path,
    output_path: &Path,
    mod_project: &ModProject,
) -> Result<(usize, u64), String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    let file = File::create(output_path)
        .map_err(|e| format!("Failed to create output file: {}", e))?;

    let mut zip = ZipWriter::new(file);
    let content_base = project_path.join("content").join("base");
    let mut total_files = 0;

    for entry in std::fs::read_dir(&content_base)
        .map_err(|e| format!("Failed to read content/base: {}", e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.is_dir()
            && path
                .file_name()
                .map(|n| n.to_string_lossy().ends_with(".wad.client"))
                .unwrap_or(false)
        {
            let wad_name = path.file_name().unwrap().to_string_lossy().to_string();

            let file_count = walkdir::WalkDir::new(&path)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| {
                    let p = e.path().to_string_lossy().to_lowercase();
                    !p.contains("testcuberenderer")
                        && !p.ends_with(".ritobin")
                        && e.path().is_file()
                })
                .count();
            total_files += file_count;

            let wad_bytes = flint_ltk::export::build_wad_from_directory(&path)?;

            let options = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file(format!("WAD/{}", wad_name), options)
                .map_err(|e| format!("Failed to create WAD entry in ZIP: {}", e))?;
            zip.write_all(&wad_bytes)
                .map_err(|e| format!("Failed to write WAD to ZIP: {}", e))?;

            tracing::info!("Packed WAD/{} ({} files, {} bytes)", wad_name, file_count, wad_bytes.len());
        }
    }

    let info = serde_json::json!({
        "Name": mod_project.display_name,
        "Author": format_authors(&mod_project.authors),
        "Version": mod_project.version,
        "Description": mod_project.description,
    });

    let meta_options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("META/info.json", meta_options)
        .map_err(|e| format!("Failed to create info.json entry: {}", e))?;
    zip.write_all(
        serde_json::to_string_pretty(&info)
            .map_err(|e| format!("Failed to serialize info.json: {}", e))?
            .as_bytes(),
    )
    .map_err(|e| format!("Failed to write info.json: {}", e))?;

    let thumbnail_path = project_path.join("thumbnail.webp");
    if thumbnail_path.exists() {
        if let Ok(thumb_bytes) = std::fs::read(&thumbnail_path) {
            match image::load_from_memory(&thumb_bytes) {
                Ok(img) => {
                    let mut png_buf = Vec::new();
                    let mut cursor = std::io::Cursor::new(&mut png_buf);
                    if img.write_to(&mut cursor, image::ImageFormat::Png).is_ok() {
                        let img_options = SimpleFileOptions::default()
                            .compression_method(zip::CompressionMethod::Deflated);
                        if zip.start_file("META/image.png", img_options).is_ok() {
                            let _ = zip.write_all(&png_buf);
                            tracing::info!("Embedded thumbnail as META/image.png ({} bytes)", png_buf.len());
                        }
                    }
                }
                Err(_) => {
                    let img_options = SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Deflated);
                    if zip.start_file("META/image.png", img_options).is_ok() {
                        let _ = zip.write_all(&thumb_bytes);
                    }
                }
            }
        }
    }

    zip.finish()
        .map_err(|e| format!("Failed to finalize ZIP: {}", e))?;

    let total_size = std::fs::metadata(output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    tracing::info!("Fantome export complete: {} files, {} bytes", total_files, total_size);
    Ok((total_files, total_size))
}

fn format_authors(authors: &[ModProjectAuthor]) -> String {
    if authors.is_empty() {
        return "Unknown".to_string();
    }
    authors
        .iter()
        .map(|a| match a {
            ModProjectAuthor::Name(name) => name.clone(),
            ModProjectAuthor::Role { name, .. } => name.clone(),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[tauri::command]
pub async fn get_export_preview(project_path: String) -> Result<Vec<String>, String> {
    let path = PathBuf::from(&project_path);
    let content_base = path.join("content").join("base");

    if !content_base.exists() {
        return Err(format!("Content directory not found: {}", content_base.display()));
    }

    let files: Vec<String> = walkdir::WalkDir::new(&content_base)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let path_str = e.path().to_string_lossy().to_lowercase();
            !path_str.contains("testcuberenderer") && e.path().is_file()
        })
        .filter_map(|e| {
            e.path()
                .strip_prefix(&content_base)
                .ok()
                .map(|p| p.to_string_lossy().to_string())
        })
        .collect();

    Ok(files)
}

#[tauri::command]
pub async fn export_modpkg(
    project_path: String,
    output_path: String,
    app: tauri::AppHandle,
) -> Result<ExportResult, String> {
    tracing::info!(
        "Frontend requested modpkg export: {} -> {}",
        project_path,
        output_path
    );

    let path = PathBuf::from(&project_path);
    let output = PathBuf::from(&output_path);

    let _ = app.emit("export-progress", serde_json::json!({
        "status": "exporting",
        "progress": 0.3,
        "message": "Creating modpkg package..."
    }));

    let mod_config_path = path.join("mod.config.json");
    let mod_project = if mod_config_path.exists() {
        let config_data = std::fs::read_to_string(&mod_config_path)
            .map_err(|e| format!("Failed to read mod.config.json: {}", e))?;
        serde_json::from_str::<ModProject>(&config_data)
            .map_err(|e| format!("Failed to parse mod.config.json: {}", e))?
    } else {
        return Err("mod.config.json not found - cannot export modpkg without project metadata".to_string());
    };

    let export_path = path.clone();
    let export_output = output.clone();

    let result = tokio::task::spawn_blocking(move || {
        export_with_ltk_modpkg(&export_path, &export_output, &mod_project)
    })
    .await
    .map_err(|e| format!("Export task failed: {}", e))?;

    match result {
        Ok((file_count, total_size)) => {
            let _ = app.emit("export-progress", serde_json::json!({
                "status": "complete",
                "progress": 1.0,
                "message": format!("Export complete: {}", output.display())
            }));

            Ok(ExportResult {
                success: true,
                output_path: output.to_string_lossy().to_string(),
                file_count,
                total_size,
                message: format!(
                    "Successfully exported {} files ({} bytes)",
                    file_count, total_size
                ),
            })
        }
        Err(e) => {
            let _ = app.emit("export-progress", serde_json::json!({
                "status": "error",
                "progress": 0.0,
                "message": format!("Export failed: {}", e)
            }));

            Err(e)
        }
    }
}

fn export_with_ltk_modpkg(
    project_path: &Path,
    output_path: &Path,
    mod_project: &ModProject,
) -> Result<(usize, u64), String> {
    use flint_ltk::ltk_types::{ModpkgBuilder, ModpkgChunkBuilder, ModpkgLayerBuilder};
    use flint_ltk::ltk_types::{ModpkgMetadata, ModpkgAuthor};
    use std::io::Write;

    let content_base = project_path.join("content").join("base");

    let mut file_paths: HashMap<String, PathBuf> = HashMap::new();

    for entry in walkdir::WalkDir::new(&content_base)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let p = e.path().to_string_lossy().to_lowercase();
            !p.contains("testcuberenderer")
                && !p.ends_with(".ritobin")
                && e.path().is_file()
        })
    {
        let file_path = entry.path();
        let relative_path = file_path
            .strip_prefix(&content_base)
            .map_err(|e| format!("Failed to get relative path: {}", e))?;

        let normalized_path = relative_path.to_string_lossy().replace('\\', "/").to_lowercase();
        file_paths.insert(normalized_path, file_path.to_path_buf());
    }

    let file_count = file_paths.len();

    let version = semver::Version::parse(&mod_project.version)
        .unwrap_or_else(|_| semver::Version::new(1, 0, 0));

    let metadata = ModpkgMetadata {
        name: mod_project.name.clone(),
        display_name: mod_project.display_name.clone(),
        version,
        description: if mod_project.description.is_empty() {
            None
        } else {
            Some(mod_project.description.clone())
        },
        authors: mod_project.authors.iter().map(|author| {
            match author {
                flint_ltk::ltk_types::ModProjectAuthor::Name(name) => ModpkgAuthor::new(name.clone(), None),
                flint_ltk::ltk_types::ModProjectAuthor::Role { name, role } => ModpkgAuthor::new(name.clone(), Some(role.clone())),
            }
        }).collect(),
        ..Default::default()
    };

    let mut builder = ModpkgBuilder::default()
        .with_metadata(metadata)
        .map_err(|e| format!("Failed to set metadata: {}", e))?
        .with_layer(ModpkgLayerBuilder::base());

    let thumbnail_path = project_path.join("thumbnail.webp");
    if thumbnail_path.exists() {
        if let Ok(thumb_bytes) = std::fs::read(&thumbnail_path) {
            builder = builder
                .with_thumbnail(thumb_bytes)
                .map_err(|e| format!("Failed to set thumbnail: {}", e))?;
            tracing::info!("Embedded thumbnail ({} bytes)", thumbnail_path.metadata().map(|m| m.len()).unwrap_or(0));
        }
    }

    for path in file_paths.keys() {
        let chunk = ModpkgChunkBuilder::new()
            .with_path(path)
            .map_err(|e| format!("Failed to set chunk path: {}", e))?
            .with_layer("base");
        builder = builder.with_chunk(chunk);
    }

    let mut output_file = File::create(output_path)
        .map_err(|e| format!("Failed to create output file: {}", e))?;

    builder.build_to_writer(&mut output_file, |chunk_builder, cursor| {
        if let Some(file_path) = file_paths.get(&chunk_builder.path) {
            let data = std::fs::read(file_path).map_err(|e| {
                std::io::Error::other(format!("Failed to read {}: {}", file_path.display(), e))
            })?;
            cursor.write_all(&data)?;
        }
        Ok(())
    })
    .map_err(|e| format!("Failed to build modpkg: {}", e))?;

    let total_size = std::fs::metadata(output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    tracing::info!("Modpkg export complete: {} files, {} bytes", file_count, total_size);
    Ok((file_count, total_size))
}

fn slugify(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}
