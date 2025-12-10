use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use rayon::prelude::*;
use crate::error::{Error, Result};

#[derive(Clone)]
pub struct Hashtable {
    mappings: HashMap<u64, String>,
    source_dir: PathBuf,
}

impl Hashtable {
    /// Creates a new Hashtable by loading all .txt files from the specified directory
    /// 
    /// # Arguments
    /// * `dir` - Directory containing hash files in the format `<hash> <path>`
    /// 
    /// # Returns
    /// * `Result<Self>` - A new Hashtable with all mappings loaded
    /// 
    /// # Performance
    /// Uses parallel file loading with rayon for faster initialization.
    /// Pre-allocates HashMap capacity for ~4 million entries (typical hash file size).
    pub fn from_directory(dir: impl AsRef<Path>) -> Result<Self> {
        let dir_path = dir.as_ref().to_path_buf();
        
        // Check if directory exists
        if !dir_path.exists() {
            return Err(Error::Hash(format!(
                "Hash directory does not exist: {}",
                dir_path.display()
            )));
        }
        
        if !dir_path.is_dir() {
            return Err(Error::Hash(format!(
                "Path is not a directory: {}",
                dir_path.display()
            )));
        }
        
        // Collect all .txt file paths first
        let txt_files: Vec<PathBuf> = fs::read_dir(&dir_path)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().and_then(|s| s.to_str()) == Some("txt"))
            .collect();
        
        tracing::debug!("Loading {} hash files in parallel", txt_files.len());
        
        // Load files in parallel using rayon
        let partial_maps: Vec<HashMap<u64, String>> = txt_files
            .par_iter()
            .filter_map(|path| {
                match Self::load_hash_file_to_map(path) {
                    Ok(map) => {
                        tracing::trace!("Loaded {} hashes from {:?}", map.len(), path.file_name());
                        Some(map)
                    }
                    Err(e) => {
                        tracing::warn!("Failed to load hash file {:?}: {}", path, e);
                        None
                    }
                }
            })
            .collect();
        
        // Pre-allocate HashMap with estimated capacity (~4 million entries typical)
        let total_estimate: usize = partial_maps.iter().map(|m| m.len()).sum();
        let mut mappings = HashMap::with_capacity(total_estimate);
        
        // Merge all partial maps
        for partial in partial_maps {
            mappings.extend(partial);
        }
        
        tracing::info!("Hashtable loaded: {} total hashes", mappings.len());
        
        Ok(Self {
            mappings,
            source_dir: dir_path,
        })
    }
    
    /// Loads a single hash file and returns its mappings as a new HashMap
    /// This variant is used for parallel loading.
    fn load_hash_file_to_map(path: &Path) -> Result<HashMap<u64, String>> {
        let content = fs::read_to_string(path)?;
        
        // Pre-allocate based on line count estimate (average ~50 chars per line)
        let estimated_lines = content.len() / 50;
        let mut mappings = HashMap::with_capacity(estimated_lines);
        
        Self::parse_hash_content(&content, path, &mut mappings)?;
        
        Ok(mappings)
    }

    /// Loads a single hash file and adds its mappings to the provided HashMap
    /// Used for sequential reload operations.
    fn load_hash_file(path: &Path, mappings: &mut HashMap<u64, String>) -> Result<()> {
        let content = fs::read_to_string(path)?;
        Self::parse_hash_content(&content, path, mappings)
    }
    
    /// Parses hash file content and adds mappings to the provided HashMap
    /// Shared parsing logic used by both parallel and sequential loading.
    fn parse_hash_content(content: &str, path: &Path, mappings: &mut HashMap<u64, String>) -> Result<()> {
        for (line_num, line) in content.lines().enumerate() {
            let line = line.trim();
            
            // Skip empty lines and comments
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            
            // Parse format: <hash> <path>
            // Some files (like hashes.binhashes.txt) only have hashes without paths - skip those
            let parts: Vec<&str> = line.splitn(2, ' ').collect();
            
            if parts.len() != 2 {
                // Skip lines that don't have a path (hash-only format for bloom filters)
                continue;
            }
            
            // Parse the hash value
            // CDragon format uses hex hashes (e.g., "e55245ad") without 0x prefix
            // Support: 0x prefix, plain hex, or decimal
            let hash_str = parts[0];
            let hash = if hash_str.starts_with("0x") || hash_str.starts_with("0X") {
                // Explicit hex with prefix
                u64::from_str_radix(&hash_str[2..], 16)
            } else if hash_str.chars().all(|c| c.is_ascii_hexdigit()) {
                // Plain hex (CDragon format) - try hex first
                u64::from_str_radix(hash_str, 16)
            } else {
                // Fall back to decimal
                hash_str.parse::<u64>()
            }
            .map_err(|e| Error::parse_with_path(
                line_num + 1,
                format!(
                    "Invalid hash value: '{}' - {}",
                    hash_str,
                    e
                ),
                path,
            ))?;
            
            let path_str = parts[1].to_string();
            mappings.insert(hash, path_str);
        }
        
        Ok(())
    }

    /// Resolves a hash value to its corresponding path
    /// 
    /// # Arguments
    /// * `hash` - The hash value to resolve
    /// 
    /// # Returns
    /// * `Cow<str>` - The resolved path if found, or hex representation if not found
    pub fn resolve(&self, hash: u64) -> std::borrow::Cow<'_, str> {
        self.mappings
            .get(&hash)
            .map(|s| std::borrow::Cow::Borrowed(s.as_str()))
            .unwrap_or_else(|| std::borrow::Cow::Owned(format!("{:016x}", hash)))
    }

    /// Reloads all hash files from the source directory
    /// 
    /// This method clears the current mappings and reloads all .txt files
    /// from the source directory, allowing the hashtable to pick up any
    /// changes made to the hash files on disk.
    /// 
    /// # Returns
    /// * `Result<()>` - Ok if reload succeeded, Err otherwise
    pub fn reload(&mut self) -> Result<()> {
        // Clear existing mappings
        self.mappings.clear();
        
        // Read all .txt files in the directory
        let entries = fs::read_dir(&self.source_dir)?;
        
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            
            // Only process .txt files
            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("txt") {
                Self::load_hash_file(&path, &mut self.mappings)?;
            }
        }
        
        Ok(())
    }

    /// Returns the number of hash mappings currently loaded
    pub fn len(&self) -> usize {
        self.mappings.len()
    }

    /// Returns true if the hashtable contains no mappings
    pub fn is_empty(&self) -> bool {
        self.mappings.is_empty()
    }

    /// Returns an iterator over all hash mappings
    pub fn entries(&self) -> impl Iterator<Item = (u64, &String)> {
        self.mappings.iter().map(|(k, v)| (*k, v))
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use tempfile::TempDir;

    fn create_test_hash_file(dir: &Path, filename: &str, content: &str) -> Result<()> {
        let file_path = dir.join(filename);
        let mut file = fs::File::create(file_path)?;
        file.write_all(content.as_bytes())?;
        Ok(())
    }

    #[test]
    fn test_from_directory_loads_all_txt_files() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        // Create multiple hash files
        create_test_hash_file(
            dir_path,
            "hashes1.txt",
            "0x1a2b3c4d characters/aatrox/skins/base/aatrox.bin\n0x5e6f7a8b assets/test.dds\n",
        )
        .unwrap();

        create_test_hash_file(
            dir_path,
            "hashes2.txt",
            "0xabcdef12 data/menu/mainmenu.bin\n",
        )
        .unwrap();

        // Create a non-.txt file that should be ignored
        create_test_hash_file(dir_path, "readme.md", "This should be ignored\n").unwrap();

        let hashtable = Hashtable::from_directory(dir_path).unwrap();

        // Should have loaded 3 mappings from the two .txt files
        assert_eq!(hashtable.len(), 3);
    }

    #[test]
    fn test_resolve_known_hash() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        create_test_hash_file(
            dir_path,
            "hashes.txt",
            "0x1a2b3c4d characters/aatrox/skins/base/aatrox.bin\n",
        )
        .unwrap();

        let hashtable = Hashtable::from_directory(dir_path).unwrap();

        let resolved = hashtable.resolve(0x1a2b3c4d);
        assert_eq!(resolved, "characters/aatrox/skins/base/aatrox.bin");
    }

    #[test]
    fn test_resolve_unknown_hash_returns_hex() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        create_test_hash_file(dir_path, "hashes.txt", "0x1a2b3c4d test.bin\n").unwrap();

        let hashtable = Hashtable::from_directory(dir_path).unwrap();

        // Unknown hash should return hex format
        let resolved = hashtable.resolve(0x9999999999999999);
        assert_eq!(resolved, "9999999999999999");
    }

    #[test]
    fn test_reload_synchronizes_with_disk() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        // Create initial hash file
        create_test_hash_file(dir_path, "hashes.txt", "0x1a2b3c4d test1.bin\n").unwrap();

        let mut hashtable = Hashtable::from_directory(dir_path).unwrap();
        assert_eq!(hashtable.len(), 1);

        // Add another hash file
        create_test_hash_file(dir_path, "hashes2.txt", "0x5e6f7a8b test2.bin\n").unwrap();

        // Reload should pick up the new file
        hashtable.reload().unwrap();
        assert_eq!(hashtable.len(), 2);
    }

    #[test]
    fn test_parse_decimal_hash() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        // Test with decimal hash value
        create_test_hash_file(dir_path, "hashes.txt", "123456789 test.bin\n").unwrap();

        let hashtable = Hashtable::from_directory(dir_path).unwrap();
        assert_eq!(hashtable.len(), 1);

        let resolved = hashtable.resolve(123456789);
        assert_eq!(resolved, "test.bin");
    }

    #[test]
    fn test_skip_empty_lines_and_comments() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        create_test_hash_file(
            dir_path,
            "hashes.txt",
            "# This is a comment\n\n0x1a2b3c4d test.bin\n\n# Another comment\n0x5e6f7a8b test2.bin\n",
        )
        .unwrap();

        let hashtable = Hashtable::from_directory(dir_path).unwrap();
        assert_eq!(hashtable.len(), 2);
    }

    #[test]
    fn test_from_directory_nonexistent_dir() {
        let result = Hashtable::from_directory("/nonexistent/path/that/does/not/exist");
        assert!(result.is_err());
        
        if let Err(Error::Hash(msg)) = result {
            assert!(msg.contains("does not exist"));
        } else {
            panic!("Expected Hash error");
        }
    }

    #[test]
    fn test_invalid_hash_format() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        create_test_hash_file(dir_path, "hashes.txt", "invalid_hash test.bin\n").unwrap();

        let result = Hashtable::from_directory(dir_path);
        assert!(result.is_err());
        
        if let Err(Error::Parse { line, message, .. }) = result {
            assert_eq!(line, 1);
            assert!(message.contains("Invalid hash value"));
        } else {
            panic!("Expected Parse error");
        }
    }

    #[test]
    fn test_is_empty() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        let hashtable = Hashtable::from_directory(dir_path).unwrap();
        assert!(hashtable.is_empty());

        create_test_hash_file(dir_path, "hashes.txt", "0x1a2b3c4d test.bin\n").unwrap();
        let hashtable = Hashtable::from_directory(dir_path).unwrap();
        assert!(!hashtable.is_empty());
    }
}
