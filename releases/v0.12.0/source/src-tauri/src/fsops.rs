//! 文件系统操作（设计文档 §6.3 文件操作闭环）：
//! 新建目录 / 重命名 / 移动 / 删除（进系统回收站）。
//! 统一校验：名称合法、同名冲突、目录不可移动进自身、占用报错；
//! 仅做文件系统操作并返回结果，索引由调用方触发全量重扫重建（保证一致性）。

use std::path::PathBuf;

/// 名称合法性（Windows 规则）：非空、首尾无空白、无路径分隔符与非法字符、无连续点号、
/// 不以点号开头/结尾（点号开头的隐藏项不会纳入索引）、非保留设备名（含带扩展名形式）。
pub fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("名称不能为空".into());
    }
    if name != name.trim() {
        return Err("名称首尾不能包含空白字符".into());
    }
    if name.chars().count() > 200 {
        return Err("名称过长（上限 200 个字符）".into());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("名称不能包含路径分隔符 / 或 \\".into());
    }
    if let Some(c) = name.chars().find(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || c.is_control()) {
        return Err(format!("名称不能包含字符「{c}」（Windows 不允许 < > : \" | ? * 与控制字符）"));
    }
    if name.contains("..") {
        return Err("名称不能包含连续点号".into());
    }
    if name.starts_with('.') {
        return Err("名称不能以点号开头（点号开头的隐藏项不会纳入索引）".into());
    }
    if name.ends_with('.') {
        return Err("名称不能以点号结尾（Windows 会自动去掉结尾点号）".into());
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_lowercase();
    let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || ((stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved {
        return Err(format!("「{name}」使用了 Windows 保留设备名"));
    }
    Ok(())
}

fn join_relative(root: &str, rel: &str) -> Result<PathBuf, String> {
    crate::pathguard::join_in_root(root, rel)
}

fn parent_of(rel: &str) -> String {
    rel.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default()
}

fn base_name_of(rel: &str) -> String {
    rel.rsplit('/').next().unwrap_or(rel).to_string()
}

/// 在指定父目录下新建文件夹（不递归；父目录必须已存在）。
pub fn create_directory(root: &str, parent_dir: &str, name: &str) -> Result<(), String> {
    validate_name(name)?;
    let rel = if parent_dir.is_empty() { name.to_string() } else { format!("{parent_dir}/{name}") };
    let path = join_relative(root, &rel)?;
    if path.exists() {
        return Err(format!("同名文件或文件夹已存在：{rel}"));
    }
    std::fs::create_dir(&path).map_err(|e| format!("新建文件夹失败: {e}"))
}

/// 重命名（文件或文件夹）。
pub fn rename_entry(root: &str, relative_path: &str, new_name: &str) -> Result<String, String> {
    validate_name(new_name)?;
    if relative_path.is_empty() {
        return Err("不能重命名库根目录".into());
    }
    let old_path = join_relative(root, relative_path)?;
    if !old_path.exists() {
        return Err(format!("目标不存在：{relative_path}"));
    }
    let parent = parent_of(relative_path);
    let new_rel = if parent.is_empty() { new_name.to_string() } else { format!("{parent}/{new_name}") };
    if new_rel == relative_path {
        return Ok(new_rel);
    }
    let new_path = join_relative(root, &new_rel)?;
    if new_path.exists() {
        return Err(format!("同名文件或文件夹已存在：{new_rel}"));
    }
    std::fs::rename(&old_path, &new_path).map_err(|e| format!("重命名失败（文件可能被其他程序占用）: {e}"))?;
    Ok(new_rel)
}

/// 移动（文件或文件夹）到目标目录（目标目录必须已存在且不能是自身或其子目录）。
pub fn move_entry(root: &str, relative_path: &str, target_dir: &str) -> Result<String, String> {
    if relative_path.is_empty() {
        return Err("不能移动库根目录".into());
    }
    if !target_dir.is_empty() {
        let target_path = join_relative(root, target_dir)?;
        if !target_path.is_dir() {
            return Err(format!("目标目录不存在：{target_dir}"));
        }
    }
    let name = base_name_of(relative_path);
    let new_rel = if target_dir.is_empty() { name } else { format!("{target_dir}/{name}") };
    if new_rel == relative_path {
        return Ok(new_rel); // 移动到原位置，视为成功无操作
    }
    // 不能移动进自身或其子目录
    if target_dir == relative_path || target_dir.starts_with(&format!("{relative_path}/")) {
        return Err("不能将文件夹移动到其自身内部".into());
    }
    let new_path = join_relative(root, &new_rel)?;
    if new_path.exists() {
        return Err(format!("目标位置已存在同名文件或文件夹：{new_rel}"));
    }
    let old_path = join_relative(root, relative_path)?;
    std::fs::rename(&old_path, &new_path).map_err(|e| format!("移动失败（文件可能被其他程序占用）: {e}"))?;
    Ok(new_rel)
}

/// 删除（进系统回收站，可从回收站还原）。文件被占用时报错不强制删除。
pub fn delete_entry(root: &str, relative_path: &str) -> Result<(), String> {
    if relative_path.is_empty() {
        return Err("不能删除库根目录".into());
    }
    let path = join_relative(root, relative_path)?;
    if !path.exists() {
        return Err(format!("目标不存在：{relative_path}"));
    }
    trash::delete(&path).map_err(|e| format!("删除到回收站失败（文件可能被其他程序占用）: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn setup() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        std::fs::create_dir_all(Path::new(&root).join("a").join("inner")).unwrap();
        std::fs::write(Path::new(&root).join("a").join("文档.md"), "# test").unwrap();
        std::fs::write(Path::new(&root).join("根文档.md"), "root").unwrap();
        (dir, root)
    }

    #[test]
    fn name_validation() {
        assert!(validate_name("方案.md").is_ok());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("a\\b").is_err());
        assert!(validate_name("..x").is_err());
        assert!(validate_name(".git").is_err());
        assert!(validate_name("  ").is_err());
        assert!(validate_name("con").is_err());
        assert!(validate_name("con.txt").is_err());
        assert!(validate_name("COM1.md").is_err());
        assert!(validate_name("com0.md").is_ok());
        assert!(validate_name("a?.md").is_err());
        assert!(validate_name("a:b").is_err());
        assert!(validate_name("尾部点.").is_err());
        assert!(validate_name(" 前导空格.md").is_err());
    }

    #[test]
    fn rejects_paths_escaping_the_library_root() {
        let (guard, root) = setup();
        // 库根之外放一个「受害」文件，越界操作不得触及它
        let victim = guard.path().parent().unwrap().join("markflow-victim-check.txt");
        std::fs::write(&victim, "keep").unwrap();
        let abs = victim.to_string_lossy().to_string();
        let escape = "../markflow-victim-check.txt";

        assert!(delete_entry(&root, &abs).is_err());
        assert!(delete_entry(&root, escape).is_err());
        assert!(rename_entry(&root, &abs, "x.md").is_err());
        assert!(rename_entry(&root, escape, "x.md").is_err());
        assert!(move_entry(&root, "根文档.md", "../").is_err());
        assert!(move_entry(&root, escape, "a").is_err());
        assert!(create_directory(&root, "..", "越界").is_err());
        assert!(victim.is_file(), "库外文件必须保持原样");
        std::fs::remove_file(&victim).unwrap();
    }

    #[test]
    fn create_rename_move_delete_roundtrip() {
        let (_guard, root) = setup();

        // 新建目录
        create_directory(&root, "a", "子目录").unwrap();
        assert!(Path::new(&root).join("a/子目录").is_dir());
        // 同名冲突
        assert!(create_directory(&root, "a", "子目录").is_err());

        // 重命名文件
        let new_rel = rename_entry(&root, "根文档.md", "根文档2.md").unwrap();
        assert_eq!(new_rel, "根文档2.md");
        assert!(!Path::new(&root).join("根文档.md").exists());
        assert!(Path::new(&root).join("根文档2.md").is_file());

        // 移动文件到子目录
        let moved = move_entry(&root, "根文档2.md", "a/inner").unwrap();
        assert_eq!(moved, "a/inner/根文档2.md");
        assert!(Path::new(&root).join("a/inner/根文档2.md").is_file());

        // 不能把目录移动进自身
        assert!(move_entry(&root, "a", "a/inner").is_err());

        // 删除文件（进回收站）
        delete_entry(&root, "a/inner/根文档2.md").unwrap();
        assert!(!Path::new(&root).join("a/inner/根文档2.md").exists());

        // 删除目录
        delete_entry(&root, "a/inner").unwrap();
        assert!(!Path::new(&root).join("a/inner").exists());
    }

    #[test]
    fn rename_rejects_conflict_and_missing() {
        let (_guard, root) = setup();
        std::fs::write(Path::new(&root).join("副本.md"), "x").unwrap();
        // 同级重名冲突
        assert!(rename_entry(&root, "根文档.md", "副本.md").is_err());
        // 不同目录同名不属于冲突（可成功）
        assert!(rename_entry(&root, "根文档.md", "文档.md").is_ok());
        // 不存在
        assert!(rename_entry(&root, "不存在.md", "x.md").is_err());
        // 重命名根目录被拒绝
        assert!(rename_entry(&root, "", "root").is_err());
        // 移动到不存在的目录
        assert!(move_entry(&root, "文档.md", "没有的目录").is_err());
    }
}
