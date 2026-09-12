use std::path::Path;

pub fn to_slash(path: &Path) -> String {
    slash_str(&path.to_string_lossy())
}

pub fn slash_str(path: &str) -> String {
    if path.contains('\\') {
        path.replace('\\', "/")
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn converts_windows_separators() {
        assert_eq!(
            to_slash(&PathBuf::from(r"E:\proj\content\base\yasuo.skn")),
            "E:/proj/content/base/yasuo.skn"
        );
    }

    #[test]
    fn leaves_posix_paths_untouched() {
        assert_eq!(
            to_slash(&PathBuf::from("E:/proj/yasuo.skn")),
            "E:/proj/yasuo.skn"
        );
    }

    #[test]
    fn is_idempotent() {
        let once = slash_str(r"E:\proj\yasuo.skn");
        assert_eq!(slash_str(&once), once);
    }

    #[test]
    fn normalizes_mixed_separators() {
        assert_eq!(slash_str(r"E:\proj/content\base"), "E:/proj/content/base");
    }

    #[test]
    fn keeps_unc_and_verbatim_prefixes_parseable() {
        assert_eq!(slash_str(r"\\server\share\mod.wad"), "//server/share/mod.wad");
        assert_eq!(slash_str(r"\\?\E:\proj"), "//?/E:/proj");
    }

    #[test]
    fn handles_empty_and_relative() {
        assert_eq!(slash_str(""), "");
        assert_eq!(slash_str(r"content\base\x.bin"), "content/base/x.bin");
        assert_eq!(slash_str(r"..\sibling\x.bin"), "../sibling/x.bin");
    }

    #[test]
    fn preserves_trailing_separator() {
        assert_eq!(slash_str(r"E:\proj\"), "E:/proj/");
    }
}
