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
    /// 检测到的磁盘编码（保存时按原编码写回）
    pub encoding: String,
    /// 磁盘文件带只读属性：前端只读展示并提示，不允许保存
    pub read_only: bool,
    /// 磁盘文件以 CRLF 为主（状态栏显示 CRLF / LF，保存时按它写回）
    pub crlf: bool,
}

/// 编辑大小的硬上限（防御：前端可在设置里调整上限，但不得超过它）。
pub const HARD_MAX_EDIT_BYTES: u64 = 256 * 1024 * 1024;
/// 默认编辑上限：超过则拒绝在应用内编辑（引导用外部工具）。
pub const DEFAULT_MAX_EDIT_BYTES: u64 = 50 * 1024 * 1024;

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
#[cfg(test)]
pub fn read_text_file(conn: &Connection, library_id: &str, relative_path: &str) -> Result<TextFileContent, String> {
    read_text_file_with(conn, library_id, relative_path, DEFAULT_MAX_EDIT_BYTES)
}

/// 读取可编辑文本文件；`max_bytes` 为本次允许的最大字节数（由前端设置传入，受硬上限约束）。
pub fn read_text_file_with(
    conn: &Connection,
    library_id: &str,
    relative_path: &str,
    max_bytes: u64,
) -> Result<TextFileContent, String> {
    let max_bytes = max_bytes.clamp(1024 * 1024, HARD_MAX_EDIT_BYTES);
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
    if size as u64 > max_bytes {
        return Err(format!(
            "文件（{:.1} MB）超过应用内编辑上限（{:.0} MB）。可在「设置 → 编辑器」调高上限，或用 VS Code 等外部工具打开。",
            size as f64 / 1024.0 / 1024.0,
            max_bytes as f64 / 1024.0 / 1024.0
        ));
    }
    let path = content_file_path(conn, library_id, relative_path)?;
    let read_only = std::fs::metadata(&path).map(|m| m.permissions().readonly()).unwrap_or(false);
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    let decoded = crate::textenc::decode(&bytes)?;
    let crlf = crate::textenc::uses_crlf(&decoded.text);
    Ok(TextFileContent {
        content: decoded.text,
        base_mtime: file_mtime(&path),
        size: bytes.len() as i64,
        encoding: decoded.encoding.label().to_string(),
        read_only,
        crlf,
    })
}

/// 原子保存：冲突检测 → 快照旧版本 → 临时文件 + fsync → 原子替换 → 更新索引与全文检索。
#[cfg(test)]
pub fn save_text_file(
    conn: &Connection,
    library_id: &str,
    relative_path: &str,
    content: &str,
    base_mtime: i64,
    force: bool,
) -> Result<SaveOutcome, String> {
    save_text_file_as(conn, library_id, relative_path, content, base_mtime, force, None, None)
}

/// 保存；`encoding` / `eol` 仅在用户显式选择「转换编码 / 换行符」时传入，默认按磁盘原样写回。
pub fn save_text_file_as(
    conn: &Connection,
    library_id: &str,
    relative_path: &str,
    content: &str,
    base_mtime: i64,
    force: bool,
    encoding: Option<&str>,
    eol: Option<&str>,
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
    if std::fs::metadata(&path).map(|m| m.permissions().readonly()).unwrap_or(false) {
        return Err("文件带有只读属性，无法保存。请先在系统中取消只读，或使用「另存为」。".into());
    }

    // 1. 外部修改冲突检测（三方比较中的「另一方」当前为磁盘 mtime）
    let current_mtime = file_mtime(&path);
    if !force && current_mtime != base_mtime {
        return Err(format!(
            "{ERR_CONFLICT}:文件已被外部程序修改。可选择覆盖保存、重新载入外部版本，或取消。"
        ));
    }

    // 2. 按磁盘原编码 / 原换行符编码内容（无法无损编码则中止，不损坏文件）
    let bytes = encode_like_disk(&path, content, encoding, eol)?;

    // 3. 保存前自动快照当前磁盘版本（§8.14），再原子写入：同目录临时文件 → fsync → 原子替换
    snapshot_current(conn, library_id, relative_path, &path)?;
    atomic_write(&path, &bytes)?;

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
    let bytes = encode_like_disk(&path, &content, None, None)?;
    snapshot_current(conn, library_id, relative_path, &path)?;
    atomic_write(&path, &bytes)?;
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

/// 在库内新建文本文件（AI 结果保存、新建文档等）。
/// 不覆盖已有文件；写入后登记 files 行并建立提取/FTS（无需等待重扫即可编辑与检索）。
pub fn create_text_file(
    conn: &Connection,
    library_id: &str,
    parent_dir: &str,
    file_name: &str,
    content: &str,
) -> Result<SaveOutcome, String> {
    if file_name.contains("..") || file_name.contains('\\') || file_name.contains('/') {
        return Err("文件名不能包含路径分隔符".into());
    }
    let format = crate::format::detect_format(file_name);
    if !TEXT_FORMATS.contains(&format) {
        return Err(format!("「{}」不支持直接创建，仅支持文本类格式", crate::format::format_label(&format)));
    }
    let root = get_library(conn, library_id)?.root_path;
    let relative_path = if parent_dir.is_empty() {
        file_name.to_string()
    } else {
        format!("{parent_dir}/{file_name}")
    };
    let path = Path::new(&root).join(&relative_path);
    if path.exists() {
        return Err(format!("文件已存在: {relative_path}"));
    }
    atomic_write(&path, content.as_bytes())?;

    let meta = std::fs::metadata(&path).map_err(|e| format!("读取文件状态失败: {e}"))?;
    let mtime = file_mtime(&path);
    let parent = if parent_dir.is_empty() { String::new() } else { parent_dir.to_string() };
    conn.execute(
        "INSERT OR REPLACE INTO files
         (library_id, relative_path, name, parent_path, is_dir, format, size, mtime)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7)",
        params![library_id, relative_path, file_name, parent, format, meta.len() as i64, mtime],
    )
    .map_err(|e| format!("登记索引失败: {e}"))?;
    let file_id = conn.last_insert_rowid();
    index_file_content(conn, &path, file_id, file_name);
    conn.execute(
        "UPDATE libraries SET file_count = file_count + 1 WHERE id = ?1",
        params![library_id],
    )
    .ok();
    Ok(SaveOutcome { mtime, size: meta.len() as i64 })
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
    // 快照存解码后的文本；无法无损解码的文件不做快照（同时也不会被保存覆盖）
    let content = match crate::textenc::decode(&bytes) {
        Ok(d) => d.text,
        Err(_) => return Ok(()),
    };
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

/// 依据磁盘现有文件的编码与换行符编码新内容；文件尚不存在时使用 UTF-8 + LF。
/// 默认按磁盘原编码 / 原换行符编码；`encoding_override` / `eol_override` 为用户显式转换。
fn encode_like_disk(
    path: &Path,
    content: &str,
    encoding_override: Option<&str>,
    eol_override: Option<&str>,
) -> Result<Vec<u8>, String> {
    let (mut encoding, mut crlf) = match std::fs::read(path) {
        Ok(bytes) => {
            let d = crate::textenc::decode(&bytes)?;
            let crlf = crate::textenc::uses_crlf(&d.text);
            (d.encoding, crlf)
        }
        Err(_) => (crate::textenc::Encoding::Utf8, false),
    };
    if let Some(label) = encoding_override {
        encoding = crate::textenc::Encoding::from_label(label).ok_or_else(|| format!("不支持的目标编码「{label}」"))?;
    }
    match eol_override {
        Some("crlf") => crlf = true,
        Some("lf") => crlf = false,
        Some(other) => return Err(format!("不支持的换行符「{other}」")),
        None => {}
    }
    let text = crate::textenc::apply_line_ending(content, crlf);
    crate::textenc::encode(&text, encoding)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_file_name(format!(
        "{}{}{}",
        path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        crate::selfwrite::TEMP_MARKER,
        uuid::Uuid::new_v4()
    ));
    crate::selfwrite::mark(path);
    crate::selfwrite::mark(&tmp);
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

    #[test]
    fn explicit_encoding_and_eol_conversion_only_when_requested() {
        let (conn, dir, lib_id) = setup_library();
        let rel = "docs/编码.txt";
        std::fs::write(dir.path().join("docs").join("编码.txt"), b"a\r\nb\r\n").unwrap();
        scan_library_with(&conn, &lib_id, dir.path(), &[], ScanOptions::default()).unwrap();
        let base = read_text_file(&conn, &lib_id, rel).unwrap();
        assert!(base.crlf && !base.read_only);
        // 默认：原样（CRLF、UTF-8）
        save_text_file(&conn, &lib_id, rel, "a\nb\nc\n", base.base_mtime, false).unwrap();
        assert_eq!(std::fs::read(dir.path().join("docs").join("编码.txt")).unwrap(), b"a\r\nb\r\nc\r\n");
        // 显式转换：LF + UTF-8 BOM
        let base = read_text_file(&conn, &lib_id, rel).unwrap();
        save_text_file_as(&conn, &lib_id, rel, "中文\nx\n", base.base_mtime, false, Some("utf-8 bom"), Some("lf")).unwrap();
        let bytes = std::fs::read(dir.path().join("docs").join("编码.txt")).unwrap();
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF]);
        assert!(!bytes.windows(2).any(|w| w == b"\r\n"));
        // 不支持的目标编码 → 报错且文件不变
        let base = read_text_file(&conn, &lib_id, rel).unwrap();
        assert!(save_text_file_as(&conn, &lib_id, rel, "x", base.base_mtime, false, Some("latin9"), None).is_err());
        assert_eq!(std::fs::read(dir.path().join("docs").join("编码.txt")).unwrap(), bytes);
    }

    #[test]
    fn read_only_file_is_flagged_and_not_saved() {
        let (conn, dir, lib_id) = setup_library();
        let rel = "docs/只读.txt";
        let p = dir.path().join("docs").join("只读.txt");
        std::fs::write(&p, "锁定").unwrap();
        scan_library_with(&conn, &lib_id, dir.path(), &[], ScanOptions::default()).unwrap();
        let mut perm = std::fs::metadata(&p).unwrap().permissions();
        perm.set_readonly(true);
        std::fs::set_permissions(&p, perm).unwrap();
        let read = read_text_file(&conn, &lib_id, rel).unwrap();
        assert!(read.read_only);
        assert!(save_text_file(&conn, &lib_id, rel, "改动", read.base_mtime, false).is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "锁定");
        let mut perm = std::fs::metadata(&p).unwrap().permissions();
        perm.set_readonly(false);
        std::fs::set_permissions(&p, perm).unwrap();
    }

    #[test]
    fn edit_size_limit_is_configurable() {
        let (conn, dir, lib_id) = setup_library();
        let p = dir.path().join("docs").join("大.txt");
        std::fs::write(&p, vec![b'a'; 3 * 1024 * 1024]).unwrap();
        scan_library_with(&conn, &lib_id, dir.path(), &[], ScanOptions::default()).unwrap();
        // 上限 2MB：拒绝并给出可操作提示；上限 4MB：可读
        let err = read_text_file_with(&conn, &lib_id, "docs/大.txt", 2 * 1024 * 1024).unwrap_err();
        assert!(err.contains("设置") && err.contains("外部工具"));
        assert!(read_text_file_with(&conn, &lib_id, "docs/大.txt", 4 * 1024 * 1024).is_ok());
    }

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

    #[test]
    fn gbk_file_survives_save_and_crlf_preserved() {
        let (conn, dir, lib_id) = setup_library();
        let rel = "docs/日志.txt";
        let path = dir.path().join("docs").join("日志.txt");
        let (gbk, _, _) = encoding_rs::GBK.encode("第一行\r\n第二行\r\n");
        std::fs::write(&path, gbk.as_ref()).unwrap();
        scan_library_with(&conn, &lib_id, dir.path(), &[], ScanOptions::default()).unwrap();

        let read = read_text_file(&conn, &lib_id, rel).unwrap();
        assert_eq!(read.encoding, "GBK");
        assert!(read.content.contains("第二行"));
        // 编辑器内部使用 LF；保存后按磁盘原风格写回 CRLF + GBK
        save_text_file(&conn, &lib_id, rel, "第一行\n第二行\n第三行\n", read.base_mtime, false).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let (expect, _, _) = encoding_rs::GBK.encode("第一行\r\n第二行\r\n第三行\r\n");
        assert_eq!(bytes, expect.as_ref());
        // GBK 无法表示的字符 → 拒绝保存，磁盘内容不变
        let base = read_text_file(&conn, &lib_id, rel).unwrap().base_mtime;
        assert!(save_text_file(&conn, &lib_id, rel, "😀", base, false).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), expect.as_ref());
    }

    #[test]
    fn history_follows_rename() {
        let (conn, _dir, lib_id) = setup_library();
        let rel = "docs/方案.md";
        let base = read_text_file(&conn, &lib_id, rel).unwrap().base_mtime;
        save_text_file(&conn, &lib_id, rel, "# 新版", base, false).unwrap();
        assert_eq!(list_file_versions(&conn, &lib_id, rel).unwrap().len(), 1);

        crate::library::migrate_path_refs(&conn, &lib_id, "docs", "文档").unwrap();
        assert_eq!(list_file_versions(&conn, &lib_id, rel).unwrap().len(), 0);
        assert_eq!(list_file_versions(&conn, &lib_id, "文档/方案.md").unwrap().len(), 1);
    }
}
