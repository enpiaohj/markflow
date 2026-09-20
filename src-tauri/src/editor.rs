//! 原生编辑核心（设计文档 §8.2 保存闭环、§8.14 历史与恢复）：
//! 读取 → 编辑 → 保存（冲突检测 → 自动快照 → 原子写入 → 索引更新）→ 可恢复。
//! v0.2 范围：文本类格式（与 TEXT_FORMATS 一致）；Office/PDF 编辑按能力分级另行交付。

use crate::library::{
    file_mtime, get_library, index_file_content, now_millis, MAX_EXTRACT_BYTES, TEXT_FORMATS,
};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// 冲突哨兵：磁盘文件已被外部程序修改且未选择强制覆盖。
pub const ERR_CONFLICT: &str = "FILE_CONFLICT";

/// 每个文件保留的历史快照上限（超出裁剪最旧）。
const MAX_VERSIONS_PER_FILE: i64 = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFileContent {
    pub content: String,
    /// 读取时的磁盘 mtime，作为保存时的冲突检测基线
    pub base_mtime: i64,
    pub size: i64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    pub mtime: i64,
    pub size: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub id: i64,
    /// 库级版本列表使用；单文件列表为 None
    pub relative_path: Option<String>,
    pub size: i64,
    pub created_at: i64,
}

fn file_name_of(relative_path: &str) -> String {
    relative_path
        .rsplit('/')
        .next()
        .unwrap_or(relative_path)
        .to_string()
}

/// 读取可编辑文本文件，返回内容与冲突检测基线（读取时的磁盘 mtime）。
pub fn read_text_file(conn: &Connection, library_id: &str, relative_path: &str) -> Result<TextFileContent, String> {
    let (format, size): (String, i64) = conn
        .query_row(
            "SELECT format, size FROM files WHERE library_id = ?1 AND relative_path = ?2 AND is_dir = 0",
            params![library_id, relative_path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "文件不存在于文档库索引，请刷新文档库后重试")?;
    if !TEXT_FORMATS.contains(&format.as_str()) {
        return Err(format!(
            "「{}」暂不支持在 MarkFlow 中编辑",
            crate::format::format_label(&format)
        ));
    }
    if size as u64 > MAX_EXTRACT_BYTES {
        return Err(format!("文件超过编辑大小上限（{:.0} KB）", MAX_EXTRACT_BYTES as f64 / 1024.0));
    }
    let path = content_file_path(conn, library_id, relative_path)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    Ok(TextFileContent {
        content: String::from_utf8_lossy(&bytes).to_string(),
        base_mtime: file_mtime(&path),
        size: bytes.len() as i64,
    })
}

/// 原子保存：冲突检测 → 快照旧版本 → 临时文件 + fsync → 原子替换 → 更新索引与全文检索。
pub fn save_text_file(
    conn: &Connection,
    library_id: &str,
    relative_path: &str,
    content: &str,
    base_mtime: i64,
    force: bool,
) -> Result<SaveOutcome, String> {
    let (file_id, format): (i64, String) = conn
        .query_row(
            "SELECT id, format FROM files WHERE library_id = ?1 AND relative_path = ?2 AND is_dir = 0",
            params![library_id, relative_path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "文件不存在于文档库索引，请刷新文档库后重试")?;
    if !TEXT_FORMATS.contains(&format.as_str()) {
        return Err(format!(
            "「{}」暂不支持在 MarkFlow 中编辑",
            crate::format::format_label(&format)
        ));
    }
    let path = content_file_path(conn, library_id, relative_path)?;

    // 1. 外部修改冲突检测（三方比较中的「另一方」当前为磁盘 mtime）
    let current_mtime = file_mtime(&path);
    if !force && current_mtime != base_mtime {
        return Err(format!(
            "{ERR_CONFLICT}:文件已被外部程序修改。可选择覆盖保存、重新载入外部版本，或取消。"
        ));
    }

    // 2. 保存前自动快照当前磁盘版本（§8.14）
    snapshot_current(conn, library_id, relative_path, &path)?;

    // 3. 原子写入：同目录临时文件 → fsync → 原子替换
    atomic_write(&path, content.as_bytes())?;

    // 4. 更新索引行与全文检索
    let outcome = apply_file_meta(conn, &path, file_id, relative_path)?;
    Ok(outcome)
}

/// 恢复历史版本：先把当前内容存为新快照（可回退），再原子写回版本内容并重建索引。
pub fn restore_file_version(
    conn: &Connection,
    library_id: &str,
    relative_path: &str,
    version_id: i64,
) -> Result<SaveOutcome, String> {
    let content: String = conn
        .query_row(
            "SELECT content FROM file_versions WHERE id = ?1 AND library_id = ?2 AND relative_path = ?3",
            params![version_id, library_id, relative_path],
            |row| row.get(0),
        )
        .map_err(|_| "版本不存在或已被清理")?;
    let path = content_file_path(conn, library_id, relative_path)?;
    snapshot_current(conn, library_id, relative_path, &path)?;
    atomic_write(&path, content.as_bytes())?;
    let (file_id, _): (i64, String) = conn
        .query_row(
            "SELECT id, format FROM files WHERE library_id = ?1 AND relative_path = ?2 AND is_dir = 0",
            params![library_id, relative_path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "文件不存在于文档库索引")?;
    Ok(apply_file_meta(conn, &path, file_id, relative_path)?)
}

/// 列出某文件的历史快照（新→旧）。
pub fn list_file_versions(conn: &Connection, library_id: &str, relative_path: &str) -> Result<Vec<VersionInfo>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, size, created_at FROM file_versions
             WHERE library_id = ?1 AND relative_path = ?2
             ORDER BY created_at DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![library_id, relative_path], |row| {
            Ok(VersionInfo { id: row.get(0)?, relative_path: None, size: row.get(1)?, created_at: row.get(2)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

/// 列出整个库最近的快照（恢复中心，新→旧）。
pub fn list_recent_versions(conn: &Connection, library_id: &str, limit: i64) -> Result<Vec<VersionInfo>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, relative_path, size, created_at FROM file_versions
             WHERE library_id = ?1
             ORDER BY created_at DESC, id DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![library_id, limit], |row| {
            Ok(VersionInfo {
                id: row.get(0)?,
                relative_path: Some(row.get(1)?),
                size: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

fn content_file_path(conn: &Connection, library_id: &str, relative_path: &str) -> Result<PathBuf, String> {
    let root = get_library(conn, library_id)?.root_path;
    Ok(Path::new(&root).join(relative_path))
}

fn snapshot_current(conn: &Connection, library_id: &str, relative_path: &str, path: &Path) -> Result<(), String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return Ok(()), // 磁盘文件不可读时跳过快照，不阻断保存
    };
    if bytes.len() as u64 > MAX_EXTRACT_BYTES {
        return Ok(()); // 超大文本暂不快照
    }
    let content = String::from_utf8_lossy(&bytes).to_string();
    conn.execute(
        "INSERT INTO file_versions (library_id, relative_path, size, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![library_id, relative_path, bytes.len() as i64, content, now_millis()],
    )
    .map_err(|e| format!("写入历史快照失败: {e}"))?;
    conn.execute(
        "DELETE FROM file_versions WHERE library_id = ?1 AND relative_path = ?2 AND id NOT IN (
             SELECT id FROM file_versions WHERE library_id = ?1 AND relative_path = ?2
             ORDER BY created_at DESC, id DESC LIMIT ?3
         )",
        params![library_id, relative_path, MAX_VERSIONS_PER_FILE],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_file_name(format!(
        "{}.markflow-{}",
        path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        uuid::Uuid::new_v4()
    ));
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("创建临时文件失败: {e}"))?;
        f.write_all(bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;
        f.sync_all().map_err(|e| format!("刷盘失败: {e}"))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换文件失败: {e}")
    })
}

fn apply_file_meta(conn: &Connection, path: &Path, file_id: i64, relative_path: &str) -> Result<SaveOutcome, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读取文件状态失败: {e}"))?;
    let new_mtime = file_mtime(path);
    let new_size = meta.len() as i64;
    conn.execute(
        "UPDATE files SET size = ?1, mtime = ?2 WHERE id = ?3",
        params![new_size, new_mtime, file_id],
    )
    .map_err(|e| e.to_string())?;
    index_file_content(conn, path, file_id, &file_name_of(relative_path));
    Ok(SaveOutcome { mtime: new_mtime, size: new_size })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{
        create_library, list_children, run_migrations, scan_library_with, CreateLibraryRequest, ScanOptions,
    };
    use rusqlite::Connection;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        conn
    }

    fn setup_library() -> (Connection, tempfile::TempDir, String) {
        let conn = memory_db();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs").join("方案.md"), "# 初版\n\n原始内容包含索引关键词苹果树。").unwrap();
        let lib = create_library(
            &conn,
            CreateLibraryRequest {
                root_path: root.to_string_lossy().to_string(),
                name: None,
                exclude_dirs: vec![],
                full_text_index: true,
                ocr_enabled: false,
                portable_meta: false,
            },
        )
        .unwrap();
        scan_library_with(&conn, &lib.id, &root, &[], ScanOptions::default()).unwrap();
        (conn, dir, lib.id)
    }

    #[test]
    fn save_conflict_history_roundtrip() {
        let (conn, _dir, lib_id) = setup_library();
        let rel = "docs/方案.md";

        // 读取基线
        let base = read_text_file(&conn, &lib_id, rel).unwrap();
        assert!(base.content.contains("苹果树"));

        // 正常保存 → 磁盘更新 + FTS 更新
        let out = save_text_file(&conn, &lib_id, rel, "# 第二版\n\n新增关键词菠萝蜜。", base.base_mtime, false).unwrap();
        assert!(out.size > 0);
        assert_eq!(read_text_file(&conn, &lib_id, rel).unwrap().content, "# 第二版\n\n新增关键词菠萝蜜。");
        let hits = crate::library::search_library(&conn, &lib_id, "菠萝蜜", 10).unwrap();
        assert_eq!(hits.len(), 1);
        let stale = crate::library::search_library(&conn, &lib_id, "苹果树", 10).unwrap();
        assert_eq!(stale.len(), 0);

        // 旧基线保存 → 冲突；强制覆盖 → 成功
        let conflict = save_text_file(&conn, &lib_id, rel, "# 过期内容", base.base_mtime, false);
        assert!(conflict.unwrap_err().starts_with(ERR_CONFLICT));
        let cur_base = read_text_file(&conn, &lib_id, rel).unwrap().base_mtime;
        save_text_file(&conn, &lib_id, rel, "# 第三版", cur_base, false).unwrap();

        // 历史快照：两次保存各产生一条（新→旧），且可恢复
        let versions = list_file_versions(&conn, &lib_id, rel).unwrap();
        assert!(versions.len() >= 2);
        let oldest = versions.last().unwrap();
        restore_file_version(&conn, &lib_id, rel, oldest.id).unwrap();
        let restored = read_text_file(&conn, &lib_id, rel).unwrap();
        assert!(restored.content.contains("苹果树")); // 最旧版本即初版

        // 恢复动作本身也产生了新的可回退快照
        let versions_after = list_file_versions(&conn, &lib_id, rel).unwrap();
        assert!(versions_after.len() >= 3);
        assert!(versions_after[0].created_at >= versions[0].created_at);
    }

    #[test]
    fn read_rejects_uneditable_and_missing() {
        let (conn, _dir, lib_id) = setup_library();
        assert!(read_text_file(&conn, &lib_id, "docs/不存在.md").is_err());

        // 未登记的新文件不允许通过编辑器写入
        assert!(save_text_file(&conn, &lib_id, "docs/新文件.md", "x", 0, true).is_err());
        // 目录不可编辑
        assert!(read_text_file(&conn, &lib_id, "docs").is_err());
        let _ = list_children(&conn, &lib_id, "docs").unwrap();
    }
}
