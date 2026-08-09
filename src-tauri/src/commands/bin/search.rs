use flint_core::bin::{read_bin, text_to_bin, write_bin};
use flint_core::mesh::ritobin::{create_ritobin_cache, resolve_linked_bin_path};
use rayon::prelude::*;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MAX_MATCHES_PER_FILE: usize = 200;
const MAX_TOTAL_MATCHES: usize = 5_000;
const PREVIEW_MAX_CHARS: usize = 200;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct SearchMatch {
    pub line: u32,
    pub column: u32,
    pub length: u32,
    pub preview: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct FileMatches {
    pub path: String,
    pub rel_path: String,
    pub matches: Vec<SearchMatch>,
    /// Matches beyond `MAX_MATCHES_PER_FILE` that were not returned.
    pub extra: usize,
}

#[derive(Serialize, Default, Debug)]
pub struct SearchResult {
    pub files: Vec<FileMatches>,
    pub scanned: usize,
    /// Set when the total cap cut the result short — the UI must say so rather
    /// than presenting a partial sweep as complete.
    pub truncated: bool,
}

#[derive(Serialize, Default, Debug)]
pub struct ReplaceResult {
    pub files_changed: usize,
    pub replacements: usize,
    pub failed: Vec<String>,
}

fn build_regex(query: &str, options: &SearchOptions) -> Result<Regex, String> {
    let body = if options.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    RegexBuilder::new(&body)
        .case_insensitive(!options.case_sensitive)
        .build()
        .map_err(|e| format!("Invalid search pattern: {e}"))
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// The `regex` crate has no lookarounds, so whole-word is a post-filter on the
/// bytes either side of the match. That also bounds a query starting or ending
/// with a non-word character, which `\b` would place wrongly — BIN text is full
/// of `0x…` and `"path/like/this"`.
fn word_bounded(line: &str, start: usize, end: usize) -> bool {
    let bytes = line.as_bytes();
    let before_ok = start == 0 || !is_word_byte(bytes[start - 1]);
    let after_ok = end >= bytes.len() || !is_word_byte(bytes[end]);
    before_ok && after_ok
}

fn search_in_text(text: &str, pattern: &Regex, whole_word: bool) -> (Vec<SearchMatch>, usize) {
    let mut matches = Vec::new();
    let mut extra = 0usize;

    for (index, line) in text.lines().enumerate() {
        for found in pattern.find_iter(line) {
            if whole_word && !word_bounded(line, found.start(), found.end()) {
                continue;
            }
            if matches.len() >= MAX_MATCHES_PER_FILE {
                extra += 1;
                continue;
            }
            let trimmed = line.trim();
            let preview = if trimmed.chars().count() > PREVIEW_MAX_CHARS {
                trimmed.chars().take(PREVIEW_MAX_CHARS).collect()
            } else {
                trimmed.to_string()
            };
            matches.push(SearchMatch {
                line: index as u32 + 1,
                column: line[..found.start()].chars().count() as u32 + 1,
                length: found.as_str().chars().count() as u32,
                preview,
            });
        }
    }

    (matches, extra)
}

/// Replace every match, line by line so whole-word can veto one.
///
/// `expand` is used rather than a literal push so `$1`-style backreferences work
/// in regex mode, matching what the find half of the pattern captured.
fn replace_in_text(
    text: &str,
    pattern: &Regex,
    replacement: &str,
    whole_word: bool,
) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let mut count = 0usize;

    for (index, line) in text.split('\n').enumerate() {
        if index > 0 {
            out.push('\n');
        }
        let mut cursor = 0usize;
        for caps in pattern.captures_iter(line) {
            let found = caps.get(0).expect("group 0 always exists");
            if whole_word && !word_bounded(line, found.start(), found.end()) {
                continue;
            }
            out.push_str(&line[cursor..found.start()]);
            caps.expand(replacement, &mut out);
            cursor = found.end();
            count += 1;
        }
        out.push_str(&line[cursor..]);
    }

    (out, count)
}

/// Ritobin text for a BIN, preferring an existing `.ritobin` sidecar.
///
/// A search must not litter the project with sidecars it was never asked to
/// create, so a missing one is converted IN MEMORY and not written.
fn ritobin_text(bin_path: &Path) -> Option<String> {
    let sidecar = PathBuf::from(format!("{}.ritobin", bin_path.display()));
    if sidecar.exists() {
        if let Ok(text) = std::fs::read_to_string(&sidecar) {
            return Some(text);
        }
    }
    let bytes = std::fs::read(bin_path).ok()?;
    let tree = read_bin(&bytes).ok()?;
    flint_core::bin::bin_to_text(&tree).ok()
}

fn is_bin(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("bin")) == Some(true)
}

fn collect_project_bins(project: &Path) -> Vec<PathBuf> {
    walkdir::WalkDir::new(project)
        .into_iter()
        .filter_map(|e| e.ok())
        .map(|e| e.into_path())
        .filter(|p| p.is_file() && is_bin(p))
        .collect()
}

/// Linked bins that resolve OUTSIDE the walked project tree.
///
/// A project's own linked bins are already covered by the walk; this only adds
/// the ones the `linked` header points at somewhere else.
fn out_of_tree_links(project: &Path, seed: &Path) -> Vec<PathBuf> {
    let Ok(bytes) = std::fs::read(seed) else { return Vec::new() };
    let Ok(tree) = read_bin(&bytes) else { return Vec::new() };
    let project_root = flint_core::mesh::discovery::find_project_root(seed);

    tree.linked
        .iter()
        .filter_map(|linked| {
            let normalized = linked.replace('\\', "/");
            if !normalized.to_lowercase().ends_with(".bin") {
                return None;
            }
            resolve_linked_bin_path(seed, project_root.as_deref(), &normalized)
        })
        .filter(|p| !p.starts_with(project))
        .collect()
}

fn relative_to(project: &Path, path: &Path) -> String {
    path.strip_prefix(project)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[tauri::command]
pub async fn search_project_bins(
    project_path: String,
    query: String,
    options: SearchOptions,
    seed_bin: Option<String>,
) -> Result<SearchResult, String> {
    if query.is_empty() {
        return Ok(SearchResult::default());
    }
    let pattern = build_regex(&query, &options)?;
    let project = PathBuf::from(&project_path);
    if !project.is_dir() {
        return Err(format!("{project_path} is not a folder"));
    }

    let mut targets = collect_project_bins(&project);
    if let Some(seed) = seed_bin.as_deref() {
        targets.extend(out_of_tree_links(&project, Path::new(seed)));
    }
    targets.sort();
    targets.dedup();
    let scanned = targets.len();

    tauri::async_runtime::spawn_blocking(move || {
        let mut files: Vec<FileMatches> = targets
            .par_iter()
            .filter_map(|path| {
                let text = ritobin_text(path)?;
                let (matches, extra) = search_in_text(&text, &pattern, options.whole_word);
                if matches.is_empty() {
                    return None;
                }
                Some(FileMatches {
                    path: path.to_string_lossy().replace('\\', "/"),
                    rel_path: relative_to(&project, path),
                    matches,
                    extra,
                })
            })
            .collect();

        files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

        let mut total = 0usize;
        let mut truncated = false;
        for file in files.iter_mut() {
            if total >= MAX_TOTAL_MATCHES {
                file.extra += file.matches.len();
                file.matches.clear();
                truncated = true;
                continue;
            }
            let room = MAX_TOTAL_MATCHES - total;
            if file.matches.len() > room {
                file.extra += file.matches.len() - room;
                file.matches.truncate(room);
                truncated = true;
            }
            total += file.matches.len();
            if file.extra > 0 {
                truncated = true;
            }
        }
        files.retain(|f| !f.matches.is_empty());

        Ok(SearchResult { files, scanned, truncated })
    })
    .await
    .map_err(|e| format!("Search task failed: {e}"))?
}

#[tauri::command]
pub async fn replace_in_bins(
    paths: Vec<String>,
    query: String,
    replacement: String,
    options: SearchOptions,
) -> Result<ReplaceResult, String> {
    if query.is_empty() {
        return Ok(ReplaceResult::default());
    }
    let pattern = build_regex(&query, &options)?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut result = ReplaceResult::default();

        for path in &paths {
            let bin_path = PathBuf::from(path);
            let Some(text) = ritobin_text(&bin_path) else {
                result.failed.push(format!("{path}: could not read as ritobin"));
                continue;
            };

            let (replaced, count) =
                replace_in_text(&text, &pattern, &replacement, options.whole_word);
            if count == 0 {
                continue;
            }

            let encoded = text_to_bin(&replaced)
                .map_err(|e| e.to_string())
                .and_then(|tree| write_bin(&tree).map_err(|e| e.to_string()));
            match encoded {
                Ok(bytes) => {
                    crate::core::write_echo::mark(&bin_path);
                    if let Err(e) = std::fs::write(&bin_path, bytes) {
                        result.failed.push(format!("{path}: {e}"));
                        continue;
                    }
                    // The sidecar is now stale; refresh it when one exists so
                    // the editor does not show pre-replace text.
                    let sidecar = PathBuf::from(format!("{}.ritobin", bin_path.display()));
                    if sidecar.exists() {
                        crate::core::write_echo::mark(&sidecar);
                        let _ = create_ritobin_cache(&bin_path, &sidecar);
                    }
                    result.files_changed += 1;
                    result.replacements += count;
                }
                Err(e) => result.failed.push(format!("{path}: {e}")),
            }
        }

        Ok(result)
    })
    .await
    .map_err(|e| format!("Replace task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(case_sensitive: bool, whole_word: bool, regex: bool) -> SearchOptions {
        SearchOptions { case_sensitive, whole_word, regex }
    }

    const TEXT: &str = "\
entries: map[hash,embed] = {
    \"Characters/Ahri/Skins/Skin0\" = SkinCharacterDataProperties {
        skinScale: f32 = 1.0
        note: string = \"skin scale is not skinScale\"
    }
}";

    #[test]
    fn a_plain_query_is_literal() {
        let re = build_regex("f32 = 1.0", &opts(false, false, false)).unwrap();
        let (hits, _) = search_in_text(TEXT, &re, false);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 3);
    }

    #[test]
    fn a_dot_matches_any_char_only_in_regex_mode() {
        let literal = build_regex("1x0", &opts(false, false, false)).unwrap();
        assert!(search_in_text(TEXT, &literal, false).0.is_empty());
        let as_regex = build_regex("1.0", &opts(false, false, true)).unwrap();
        assert!(!search_in_text(TEXT, &as_regex, false).0.is_empty());
    }

    #[test]
    fn case_sensitivity_is_off_by_default() {
        let insensitive = build_regex("skinscale", &opts(false, false, false)).unwrap();
        assert_eq!(search_in_text(TEXT, &insensitive, false).0.len(), 2);
        let sensitive = build_regex("skinscale", &opts(true, false, false)).unwrap();
        assert!(search_in_text(TEXT, &sensitive, false).0.is_empty());
    }

    #[test]
    fn whole_word_bounds_at_non_word_characters() {
        let re = build_regex("skin", &opts(false, true, false)).unwrap();
        let (hits, _) = search_in_text(TEXT, &re, true);
        assert_eq!(hits.len(), 1, "only the bare word `skin` in the note line");
        assert_eq!(hits[0].line, 4);
    }

    #[test]
    fn columns_and_previews_are_one_based_and_trimmed() {
        let re = build_regex("skinScale", &opts(true, false, false)).unwrap();
        let (hits, _) = search_in_text(TEXT, &re, false);
        assert_eq!(hits[0].column, 9);
        assert_eq!(hits[0].preview, "skinScale: f32 = 1.0");
    }

    #[test]
    fn an_invalid_regex_is_an_error_not_a_panic() {
        assert!(build_regex("[unclosed", &opts(false, false, true)).is_err());
    }

    #[test]
    fn replace_rewrites_every_match_and_counts_them() {
        let re = build_regex("Skin0", &opts(false, false, false)).unwrap();
        let (out, count) = replace_in_text(TEXT, &re, "Skin7", false);
        assert_eq!(count, 1);
        assert!(out.contains("Skins/Skin7"));
        assert!(!out.contains("Skin0"));
    }

    #[test]
    fn replace_honours_whole_word() {
        let re = build_regex("skin", &opts(false, true, false)).unwrap();
        let (out, count) = replace_in_text(TEXT, &re, "SKIN", true);
        assert_eq!(count, 1);
        assert!(out.contains("\"SKIN scale is not skinScale\""));
        assert!(out.contains("skinScale: f32 = 1.0"), "the property must be untouched");
    }

    #[test]
    fn replace_expands_backreferences_in_regex_mode() {
        let re = build_regex("Skins/(Skin\\d+)", &opts(false, false, true)).unwrap();
        let (out, count) = replace_in_text(TEXT, &re, "Chromas/$1", false);
        assert_eq!(count, 1);
        assert!(out.contains("Chromas/Skin0"));
    }

    #[test]
    fn replace_preserves_the_line_structure() {
        let re = build_regex("nothing-here", &opts(false, false, false)).unwrap();
        let (out, count) = replace_in_text(TEXT, &re, "x", false);
        assert_eq!(count, 0);
        assert_eq!(out, TEXT, "a no-op replace must round-trip byte-identically");
    }

    #[test]
    fn matches_past_the_per_file_cap_are_counted_not_returned() {
        let big = "a\n".repeat(MAX_MATCHES_PER_FILE + 25);
        let re = build_regex("a", &opts(false, false, false)).unwrap();
        let (hits, extra) = search_in_text(&big, &re, false);
        assert_eq!(hits.len(), MAX_MATCHES_PER_FILE);
        assert_eq!(extra, 25);
    }
}
