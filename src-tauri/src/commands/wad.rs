use crate::core::wad::extractor::{extract_all, extract_chunk};
use crate::core::wad::reader::WadReader;
use crate::state::HashtableState;
use serde::{Deserialize, Serialize};
use tauri::State;

/// Information about a WAD archive
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WadInfo {
    pub path: String,
    pub chunk_count: usize,
}

/// Information about a chunk within a WAD archive
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkInfo {
    pub path_hash: String,
    pub resolved_path: Option<String>,
    pub compressed_size: u32,
    pub uncompressed_size: u32,
}

/// Result of a WAD extraction operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractionResult {
    pub extracted_count: usize,
    pub failed_count: usize,
}

/// Opens a WAD file and returns metadata about it
/// 
/// # Arguments
/// * `path` - Path to the WAD file
/// 
/// # Returns
/// * `Result<WadInfo, String>` - WAD metadata or error message
/// 
/// # Requirements
/// Validates: Requirements 3.1
#[tauri::command]
pub async fn read_wad(path: String) -> Result<WadInfo, String> {
    let reader = WadReader::open(&path)?;
    
    Ok(WadInfo {
        path,
        chunk_count: reader.chunk_count(),
    })
}

/// Returns a list of all chunks in a WAD archive with resolved paths
/// 
/// # Arguments
/// * `path` - Path to the WAD file
/// * `state` - Hashtable state for path resolution
/// 
/// # Returns
/// * `Result<Vec<ChunkInfo>, String>` - List of chunk information or error message
/// 
/// # Requirements
/// Validates: Requirements 3.2, 3.3, 3.4
#[tauri::command]
pub async fn get_wad_chunks(
    path: String,
    state: State<'_, HashtableState>,
) -> Result<Vec<ChunkInfo>, String> {
    let reader = WadReader::open(&path)?;
    let chunks = reader.chunks();
    
    // Get hashtable for path resolution (lazy loaded on first use)
    let hashtable = state.get_hashtable();
    
    let mut chunk_infos = Vec::new();
    
    for (path_hash, chunk) in chunks.iter() {
        let resolved_path = if let Some(ref ht) = hashtable {
            let resolved = ht.resolve(*path_hash);
            // Only include as resolved if it's not a hex fallback
            if !resolved.starts_with(|c: char| c.is_ascii_hexdigit()) || resolved.len() != 16 {
                Some(resolved.to_string())
            } else {
                None
            }
        } else {
            None
        };
        
        chunk_infos.push(ChunkInfo {
            path_hash: format!("{:016x}", path_hash),
            resolved_path,
            compressed_size: chunk.compressed_size() as u32,
            uncompressed_size: chunk.uncompressed_size() as u32,
        });
    }
    
    Ok(chunk_infos)
}

/// Extracts chunks from a WAD archive to the specified output directory
/// 
/// # Arguments
/// * `wad_path` - Path to the WAD file
/// * `output_dir` - Directory where chunks should be extracted
/// * `chunk_hashes` - Optional list of chunk hashes to extract (None = extract all)
/// * `state` - Hashtable state for path resolution
/// 
/// # Returns
/// * `Result<ExtractionResult, String>` - Extraction statistics or error message
/// 
/// # Requirements
/// Validates: Requirements 4.1, 4.2, 4.3, 4.4
#[tauri::command]
pub async fn extract_wad(
    wad_path: String,
    output_dir: String,
    chunk_hashes: Option<Vec<String>>,
    state: State<'_, HashtableState>,
) -> Result<ExtractionResult, String> {
    let mut reader = WadReader::open(&wad_path)?;
    
    // Get hashtable for path resolution (lazy loaded on first use)
    let hashtable = state.get_hashtable();
    let hashtable_ref = hashtable.as_ref().map(|h| h.as_ref());
    
    let mut extracted_count = 0;
    let mut failed_count = 0;
    
    if let Some(hashes) = chunk_hashes {
        // Extract specific chunks
        for hash_str in hashes {
            // Parse the hash string
            let path_hash = u64::from_str_radix(&hash_str, 16)
                .map_err(|e| format!("Invalid hash format '{}': {}", hash_str, e))?;
            
            // Check if the chunk exists and get its data
            let chunk_exists = reader.get_chunk(path_hash).is_some();
            
            if chunk_exists {
                // Get the chunk again (we need to release the previous borrow)
                let chunk = reader.get_chunk(path_hash).unwrap();
                
                // Resolve the path
                let resolved_path = if let Some(ht) = hashtable_ref {
                    ht.resolve(path_hash).to_string()
                } else {
                    format!("{:016x}", path_hash)
                };
                
                // Determine output path
                let output_path = std::path::Path::new(&output_dir).join(&resolved_path);

                // Copy the chunk data we need before borrowing mutably
                let chunk_copy = *chunk;

                // Extract the chunk
                match extract_chunk(reader.wad_mut(), &chunk_copy, &output_path, hashtable_ref) {
                    Ok(_) => extracted_count += 1,
                    Err(_) => failed_count += 1,
                }
            } else {
                failed_count += 1;
            }
        }
    } else {
        // Extract all chunks
        match extract_all(reader.wad_mut(), &output_dir, hashtable_ref) {
            Ok(count) => extracted_count = count,
            Err(e) => return Err(e.into()),
        }
    }
    
    Ok(ExtractionResult {
        extracted_count,
        failed_count,
    })
}
