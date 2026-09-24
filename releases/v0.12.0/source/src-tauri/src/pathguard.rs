//! 库内相对路径 → 磁盘绝对路径的统一边界校验。
//!
//! 前端传来的 `relative_path` 一律以 `/` 分隔、相对于库根。`Path::join` 遇到绝对路径（`C:\…`、`\\server\…`）
//! 会整个替换掉库根，遇到 `..` 会越出库根，因此所有「库根 + 相对路径」的拼接都必须经过这里。

use std::path::{Path, PathBuf};

/// 校验相对路径的形态：不得为绝对路径 / 盘符 / UNC，不得含反斜杠、`..` 段或控制字符。空串表示库根本身。
pub fn check_relative(rel: &str) -> Result<(), String> {
    if rel.starts_with('/')
        || rel.contains('\\')
        || rel.contains(':')
        || rel.chars().any(|c| c.is_control())
        || rel.split('/').any(|s| s == "..")
    {
        return Err("路径无效：必须是文档库内的相对路径".into());
    }
    Ok(())
}

/// 库根 + 相对路径 → 绝对路径（逐段拼接，不要求目标存在）；越界时报错。
pub fn join_in_root(root: impl AsRef<Path>, rel: &str) -> Result<PathBuf, String> {
    check_relative(rel)?;
    let mut p = root.as_ref().to_path_buf();
    for part in rel.split('/').filter(|s| !s.is_empty() && *s != ".") {
        p.push(part);
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_normal_relative_paths() {
        let root = Path::new(r"D:\库");
        assert_eq!(join_in_root(root, "").unwrap(), PathBuf::from(r"D:\库"));
        assert_eq!(join_in_root(root, "a/b 文档.md").unwrap(), PathBuf::from(r"D:\库\a\b 文档.md"));
        assert_eq!(join_in_root(root, "./a//b.md").unwrap(), PathBuf::from(r"D:\库\a\b.md"));
        // 文件名里带连续点号但不是 `..` 段，属于合法名称
        assert!(join_in_root(root, "a/v1..2.md").is_ok());
    }

    #[test]
    fn rejects_escaping_paths() {
        let root = Path::new(r"D:\库");
        for bad in [
            "../x.md",
            "a/../../x.md",
            "..",
            r"C:\Windows\notepad.exe",
            "C:/Windows/notepad.exe",
            r"\\server\share\x",
            "/etc/passwd",
            r"a\..\..\x",
            "a/\u{0}b",
        ] {
            assert!(join_in_root(root, bad).is_err(), "应拒绝：{bad:?}");
        }
    }
}
