//! Parsing of the command line Explorer hands us.
//!
//! Flint is launched three ways: by the user, by double-clicking an associated
//! file (a bare path), and by a context-menu verb (a flag plus a path). Both
//! launch paths in `main.rs` — the single-instance callback and cold start —
//! go through `parse_shell_args` so they cannot drift apart.

use serde::{Deserialize, Serialize};

/// What the user asked Explorer to do with the path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellAction {
    /// Double-click, or an explicit "Open in Flint" verb.
    Open,
    ExtractWad,
    PackWad,
    ImportMod,
    OpenProject,
}

impl ShellAction {
    /// The flag Explorer passes for this action, or `None` for `Open`, which
    /// is expressed as a bare path.
    fn from_flag(flag: &str) -> Option<Self> {
        Some(match flag {
            "--extract-wad" => Self::ExtractWad,
            "--pack-wad" => Self::PackWad,
            "--import-mod" => Self::ImportMod,
            "--open-project" => Self::OpenProject,
            _ => return None,
        })
    }

    /// True when this action targets a directory rather than a file.
    pub fn targets_directory(self) -> bool {
        matches!(self, Self::PackWad | Self::OpenProject)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFileOpen {
    pub action: ShellAction,
    pub path: String,
}

/// Extract the action and target from a process argv.
///
/// Returns `None` when there is nothing to act on. Unknown flags are skipped
/// rather than treated as paths — Tauri and the updater pass their own.
pub fn parse_shell_args(args: &[String]) -> Option<PendingFileOpen> {
    let mut rest = args.iter().skip(1);

    while let Some(arg) = rest.next() {
        if let Some(action) = ShellAction::from_flag(arg) {
            // A flag consumes the next argument as its target.
            return rest.next().map(|path| PendingFileOpen {
                action,
                path: path.clone(),
            });
        }
        if !arg.starts_with("--") {
            return Some(PendingFileOpen {
                action: ShellAction::Open,
                path: arg.clone(),
            });
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_bare_path_still_means_open() {
        // This is the existing double-click behavior and must never regress.
        let a = args(&["flint.exe", "C:/x/aatrox.wad.client"]);
        let p = parse_shell_args(&a).unwrap();
        assert_eq!(p.action, ShellAction::Open);
        assert_eq!(p.path, "C:/x/aatrox.wad.client");
    }

    #[test]
    fn each_flag_maps_to_its_action() {
        for (flag, expected) in [
            ("--extract-wad", ShellAction::ExtractWad),
            ("--pack-wad", ShellAction::PackWad),
            ("--import-mod", ShellAction::ImportMod),
            ("--open-project", ShellAction::OpenProject),
        ] {
            let a = args(&["flint.exe", flag, "C:/x/target"]);
            let p = parse_shell_args(&a).expect(flag);
            assert_eq!(p.action, expected, "flag {}", flag);
            assert_eq!(p.path, "C:/x/target");
        }
    }

    #[test]
    fn a_flag_with_no_path_yields_nothing() {
        let a = args(&["flint.exe", "--extract-wad"]);
        assert!(parse_shell_args(&a).is_none());
    }

    #[test]
    fn no_arguments_yields_nothing() {
        assert!(parse_shell_args(&args(&["flint.exe"])).is_none());
    }

    #[test]
    fn an_unknown_flag_is_ignored_and_a_bare_path_still_wins() {
        // Tauri and the updater pass their own flags; they must not be
        // mistaken for a path, and must not suppress a real one.
        let a = args(&["flint.exe", "--some-tauri-flag", "C:/x/file.bin"]);
        let p = parse_shell_args(&a).unwrap();
        assert_eq!(p.action, ShellAction::Open);
        assert_eq!(p.path, "C:/x/file.bin");
    }

    #[test]
    fn a_quoted_path_with_spaces_survives() {
        let a = args(&["flint.exe", "--pack-wad", "C:/My Mods/aatrox.wad.client"]);
        let p = parse_shell_args(&a).unwrap();
        assert_eq!(p.path, "C:/My Mods/aatrox.wad.client");
    }
}
