use std::collections::BTreeMap;

use ritoshark::io::Parse;
use ritoshark::rman::Rman;

use crate::error::{Error, Result};

/// One node in the virtual asset tree. Directory if `file_index` is `None`.
#[derive(Clone, Debug, Default)]
pub struct TreeNode {
    pub name: String,
    pub file_index: Option<usize>,
    pub size: u64,
    pub children: BTreeMap<String, TreeNode>,
}

impl TreeNode {
    pub fn is_dir(&self) -> bool {
        self.file_index.is_none()
    }
    pub fn child(&self, name: &str) -> Option<&TreeNode> {
        self.children.get(name)
    }
    pub fn total_size(&self) -> u64 {
        if self.is_dir() {
            self.children.values().map(TreeNode::total_size).sum()
        } else {
            self.size
        }
    }
    pub fn file_count(&self) -> usize {
        if self.is_dir() {
            self.children.values().map(TreeNode::file_count).sum()
        } else {
            1
        }
    }
}

/// Build a directory tree from `(full_path, size, file_index)` triples.
pub fn build_tree(entries: &[(String, u64, usize)]) -> TreeNode {
    let mut root = TreeNode::default();
    for (path, size, file_index) in entries {
        let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        if parts.is_empty() {
            continue;
        }
        let mut node = &mut root;
        for (depth, part) in parts.iter().enumerate() {
            let is_leaf = depth == parts.len() - 1;
            let child = node
                .children
                .entry((*part).to_string())
                .or_insert_with(|| TreeNode {
                    name: (*part).to_string(),
                    ..Default::default()
                });
            if is_leaf {
                child.file_index = Some(*file_index);
                child.size = *size;
            }
            node = child;
        }
    }
    root
}

/// A loaded release manifest: parsed `Rman`, virtual tree, and cached path + chunk index.
pub struct Manifest {
    pub rman: Rman,
    pub tree: TreeNode,
    paths: Vec<(String, u64)>,
    chunk_index: std::collections::HashMap<u64, ritoshark::rman::ChunkRange>,
}

impl Manifest {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let rman =
            Rman::from_bytes(bytes).map_err(|e| Error::Cdn(format!("parse manifest: {e:?}")))?;
        Ok(Self::build(rman))
    }
    pub fn from_path(path: impl AsRef<std::path::Path>) -> Result<Self> {
        let rman =
            Rman::from_path(path).map_err(|e| Error::Cdn(format!("parse manifest: {e:?}")))?;
        Ok(Self::build(rman))
    }
    fn build(rman: Rman) -> Self {
        let tree = tree_from_rman(&rman);
        let paths = rman.file_paths();
        let chunk_index = rman.chunk_index();
        Self {
            rman,
            tree,
            paths,
            chunk_index,
        }
    }
    pub fn paths(&self) -> &[(String, u64)] {
        &self.paths
    }
    pub fn path(&self, index: usize) -> Option<&str> {
        self.paths.get(index).map(|(p, _)| p.as_str())
    }
    pub fn file_count(&self) -> usize {
        self.rman.files.len()
    }
    pub fn file(&self, index: usize) -> Option<&ritoshark::rman::FileEntry> {
        self.rman.files.get(index)
    }
    pub fn file_chunks(&self, index: usize) -> Vec<ritoshark::rman::ChunkRange> {
        match self.rman.files.get(index) {
            Some(file) => ritoshark::rman::Rman::file_chunks_for(file, &self.chunk_index),
            None => Vec::new(),
        }
    }
}

fn tree_from_rman(rman: &Rman) -> TreeNode {
    let entries: Vec<(String, u64, usize)> = rman
        .file_paths()
        .into_iter()
        .enumerate()
        .map(|(i, (path, size))| (path, size, i))
        .collect();
    build_tree(&entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_nested_tree_with_file_leaves() {
        let entries = vec![
            ("data/a/x.bin".to_string(), 10u64, 0usize),
            ("data/a/y.bin".to_string(), 20u64, 1usize),
            ("data/b.wad".to_string(), 30u64, 2usize),
        ];
        let root = build_tree(&entries);
        assert!(root.is_dir());
        let data = root.child("data").expect("data dir");
        let a = data.child("a").expect("a dir");
        assert_eq!(a.file_count(), 2);
        assert_eq!(a.total_size(), 30);
        let x = a.child("x.bin").expect("x leaf");
        assert_eq!(x.file_index, Some(0));
        assert!(!x.is_dir());
        assert_eq!(root.total_size(), 60);
    }
}
