//! 文档库服务（设计文档 §6 文档库模型、§11 数据设计）：
//! 库 = 用户选择的普通本地文件夹；SQLite 只存索引与元数据，绝不作为正文唯一副本。

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::format::detect_format;

/// 扫描默认排除的目录名（设计文档 §6.2 / 向导默认勾选项）。
pub const DEFAULT_EXCLUDE_DIRS: &[&str] = &[
    ".git",
    ".markflow",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
];

/// 单库扫描文件数上限（防御性保护：网络盘 / 误选根目录时避免失控）。
pub const MAX_SCAN_ENTRIES: usize = 200_000;

// ---------------------------------------------------------------------------
// 数据模型（serde 输出 camelCase，与前端 TS 类型对应）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMeta {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub file_count: i64,
    pub created_at: i64,
    pub last_opened_at: i64,
    pub settings: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntryDto {
    pub id: i64,
    pub name: String,
    pub relative_path: String,
    pub parent_path: String,
    pub is_dir: bool,
    pub format: String,
    /// 格式显示名（来自格式注册表；目录固定为「文件夹」）
    pub format_label: String,
    pub size: i64,
    pub mtime: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickScanResult {
    pub file_count: i64,
    pub dir_count: i64,
    pub total_size: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLibraryRequest {
    pub root_path: String,
    pub name: Option<String>,
    #[serde(default)]
    pub exclude_dirs: Vec<String>,
    #[serde(default)]
    pub full_text_index: bool,
    #[serde(default)]
    pub ocr_enabled: bool,
    #[serde(default)]
    pub portable_meta: bool,
}

// ---------------------------------------------------------------------------
// 共享状态
// ---------------------------------------------------------------------------

/// 全局应用状态：SQLite 连接（Mutex 保护，可克隆进扫描线程）。
#[derive(Clone)]
pub struct AppState(pub Arc<Mutex<Connection>>);

// ---------------------------------------------------------------------------
// 数据库初始化与迁移
// ---------------------------------------------------------------------------

/// 建表语句，独立出来便于单元测试在内存库上执行。
pub fn run_migrations(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS libraries (
            id             TEXT PRIMARY KEY,
            root_path      TEXT NOT NULL UNIQUE,
            name           TEXT NOT NULL,
            file_count     INTEGER NOT NULL DEFAULT 0,
            created_at     INTEGER NOT NULL,
            last_opened_at INTEGER NOT NULL,
            settings_json  TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS files (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            library_id    TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
            relative_path TEXT NOT NULL,
            name          TEXT NOT NULL,
            parent_path   TEXT NOT NULL,
            is_dir        INTEGER NOT NULL DEFAULT 0,
            format        TEXT NOT NULL DEFAULT 'other',
            size          INTEGER NOT NULL DEFAULT 0,
            mtime         INTEGER NOT NULL DEFAULT 0,
            UNIQUE(library_id, relative_path)
        );
        CREATE INDEX IF NOT EXISTS idx_files_library_parent
            ON files(library_id, parent_path);",
    )
}

/// 打开（或创建）应用数据目录下的索引库。
pub fn init_db(app: &AppHandle) -> Result<Connection, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建应用数据目录: {e}"))?;
    let conn = Connection::open(dir.join("markflow.db"))
        .map_err(|e| format!("无法打开索引数据库: {e}"))?;
    run_migrations(&conn).map_err(|e| format!("数据库初始化失败: {e}"))?;
    Ok(conn)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 库 CRUD
// ---------------------------------------------------------------------------

fn row_to_library(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryMeta> {
    let settings_json: String = row.get("settings_json")?;
    Ok(LibraryMeta {
        id: row.get("id")?,
        name: row.get("name")?,
        root_path: row.get("root_path")?,
        file_count: row.get("file_count")?,
        created_at: row.get("created_at")?,
        last_opened_at: row.get("last_opened_at")?,
        settings: serde_json::from_str(&settings_json).unwrap_or(serde_json::Value::Null),
    })
}

pub fn list_libraries(conn: &Connection) -> Result<Vec<LibraryMeta>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM libraries ORDER BY last_opened_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_library)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

pub fn create_library(
    conn: &Connection,
    req: CreateLibraryRequest,
) -> Result<LibraryMeta, String> {
    let root = PathBuf::from(&req.root_path);
    if !root.is_dir() {
        return Err(format!("文件夹不存在或不可访问: {}", req.root_path));
    }
    let existing: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM libraries WHERE root_path = ?1)",
            [&req.root_path],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if existing {
        return Err("该文件夹已被创建为文档库，请直接打开。".into());
    }

    let name = req
        .name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| {
            root.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "未命名文档库".into())
        });
    let settings = json!({
        "excludeDirs": req.exclude_dirs,
        "fullTextIndex": req.full_text_index,
        "ocrEnabled": req.ocr_enabled,
        "portableMeta": req.portable_meta,
    });
    let now = now_ms();
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO libraries (id, root_path, name, file_count, created_at, last_opened_at, settings_json)
         VALUES (?1, ?2, ?3, 0, ?4, ?4, ?5)",
        params![id, req.root_path, name, now, settings.to_string()],
    )
    .map_err(|e| format!("创建文档库失败: {e}"))?;

    get_library(conn, &id)
}

pub fn get_library(conn: &Connection, id: &str) -> Result<LibraryMeta, String> {
    conn.query_row("SELECT * FROM libraries WHERE id = ?1", [id], row_to_library)
        .map_err(|e| format!("文档库不存在: {e}"))
}

pub fn open_library(conn: &Connection, id: &str) -> Result<LibraryMeta, String> {
    conn.execute(
        "UPDATE libraries SET last_opened_at = ?1 WHERE id = ?2",
        params![now_ms(), id],
    )
    .map_err(|e| e.to_string())?;
    get_library(conn, id)
}

/// 仅从 MarkFlow 移除索引记录，绝不删除磁盘上的原文件。
pub fn remove_library(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM files WHERE library_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM libraries WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 目录扫描
// ---------------------------------------------------------------------------

/// 判断条目是否应被排除（隐藏项、默认排除目录、用户自定义排除目录）。
fn is_excluded(entry: &walkdir::DirEntry, exclude: &[String]) -> bool {
    if entry.depth() == 0 {
        return false; // 根目录本身不排除
    }
    let name = entry.file_name().to_string_lossy();
    if name.starts_with('.') {
        return true;
    }
    if entry.file_type().is_dir() {
        if DEFAULT_EXCLUDE_DIRS.iter().any(|d| d.eq_ignore_ascii_case(&name)) {
            return true;
        }
        if exclude.iter().any(|d| d.eq_ignore_ascii_case(&name)) {
            return true;
        }
    }
    false
}

fn mtime_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 轻量扫描：只统计数量与总大小，供建库向导第一步展示。
pub fn quick_scan(root: &Path, exclude: &[String]) -> Result<QuickScanResult, String> {
    if !root.is_dir() {
        return Err(format!("文件夹不存在或不可访问: {}", root.display()));
    }
    let mut result = QuickScanResult { file_count: 0, dir_count: 0, total_size: 0 };
    for entry in WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| !is_excluded(e, exclude))
    {
        let entry = entry.map_err(|e| format!("扫描失败: {e}"))?;
        if entry.depth() == 0 {
            continue;
        }
        if entry.file_type().is_dir() {
            result.dir_count += 1;
        } else {
            result.file_count += 1;
            if let Ok(meta) = entry.metadata() {
                result.total_size += meta.len() as i64;
            }
        }
    }
    Ok(result)
}

/// 待写入的文件记录（不含 library_id）。
struct ScanRow {
    relative_path: String,
    name: String,
    parent_path: String,
    is_dir: bool,
    format: String,
    size: i64,
    mtime: i64,
}

fn collect_scan_rows(root: &Path, exclude: &[String]) -> Result<Vec<ScanRow>, String> {
    let mut rows = Vec::new();
    for entry in WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| !is_excluded(e, exclude))
    {
        let entry = entry.map_err(|e| format!("扫描失败: {e}"))?;
        if entry.depth() == 0 {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let parent = match rel.rsplit_once('/') {
            Some((parent, _)) => parent.to_string(),
            None => String::new(),
        };
        let is_dir = entry.file_type().is_dir();
        let (size, mtime) = if is_dir {
            (0, 0)
        } else {
            match entry.metadata() {
                Ok(meta) => (meta.len() as i64, mtime_ms(&meta)),
                Err(_) => (0, 0),
            }
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let format = if is_dir { "directory".into() } else { detect_format(&name).into() };
        rows.push(ScanRow { relative_path: rel, name, parent_path: parent, is_dir, format, size, mtime });
        if rows.len() >= MAX_SCAN_ENTRIES {
            return Err(format!(
                "文件数量超过扫描上限（{MAX_SCAN_ENTRIES}），请缩小范围或补充排除规则。"
            ));
        }
    }
    Ok(rows)
}

fn insert_rows(conn: &Connection, library_id: &str, rows: &[ScanRow]) -> Result<(), String> {
    conn.execute("DELETE FROM files WHERE library_id = ?1", [library_id])
        .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "INSERT OR REPLACE INTO files
             (library_id, relative_path, name, parent_path, is_dir, format, size, mtime)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .map_err(|e| e.to_string())?;
    for row in rows {
        stmt.execute(params![
            library_id,
            row.relative_path,
            row.name,
            row.parent_path,
            row.is_dir,
            row.format,
            row.size,
            row.mtime,
        ])
        .map_err(|e| format!("写入索引失败: {e}"))?;
    }
    let file_count: i64 = rows.iter().filter(|r| !r.is_dir).count() as i64;
    conn.execute("UPDATE libraries SET file_count = ?1 WHERE id = ?2", params![file_count, library_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 完整扫描（同步版，供测试）：扫描 → 重建该库的索引记录。
pub fn scan_library_now(conn: &Connection, library_id: &str, root: &Path, exclude: &[String]) -> Result<usize, String> {
    let rows = collect_scan_rows(root, exclude)?;
    insert_rows(conn, library_id, &rows)?;
    Ok(rows.iter().filter(|r| !r.is_dir).count())
}

/// 完整扫描（后台线程版）：分批写库并发送进度事件。
pub fn spawn_full_scan(app: AppHandle, state: AppState, library_id: String, root: PathBuf, exclude: Vec<String>) {
    std::thread::spawn(move || {
        let started = Instant::now();
        let result = scan_library_now(&state.0.lock().unwrap(), &library_id, &root, &exclude);
        let file_count = result.as_ref().copied().unwrap_or(0);
        let payload = json!({
            "libraryId": library_id,
            "fileCount": file_count,
            "durationMs": started.elapsed().as_millis() as u64,
        });
        match result {
            Ok(_) => {
                let _ = app.emit("scan:completed", payload);
            }
            Err(err) => {
                let _ = app.emit("scan:failed", json!({ "libraryId": library_id, "error": err }));
            }
        }
    });
}

// ---------------------------------------------------------------------------
// 文件查询
// ---------------------------------------------------------------------------

fn row_to_file_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<FileEntryDto> {
    let is_dir = row.get::<_, i64>("is_dir")? != 0;
    let format: String = row.get("format")?;
    let format_label = if is_dir {
        "文件夹".to_string()
    } else {
        crate::format::format_label(&format).to_string()
    };
    Ok(FileEntryDto {
        id: row.get("id")?,
        name: row.get("name")?,
        relative_path: row.get("relative_path")?,
        parent_path: row.get("parent_path")?,
        is_dir,
        format,
        format_label,
        size: row.get("size")?,
        mtime: row.get("mtime")?,
    })
}

/// 列出某目录的直接子项；`relative_path` 传 "" 表示库根目录。
pub fn list_children(conn: &Connection, library_id: &str, relative_path: &str) -> Result<Vec<FileEntryDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT * FROM files
             WHERE library_id = ?1 AND parent_path = ?2
             ORDER BY is_dir DESC, name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![library_id, relative_path], row_to_file_entry)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

pub fn get_file_detail(conn: &Connection, library_id: &str, relative_path: &str) -> Result<FileEntryDto, String> {
    conn.query_row(
        "SELECT * FROM files WHERE library_id = ?1 AND relative_path = ?2",
        params![library_id, relative_path],
        row_to_file_entry,
    )
    .map_err(|e| format!("文件不存在: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        conn
    }

    /// 构造临时库：
    /// root/
    /// ├── 技术方案.md
    /// ├── 系统配置.json
    /// ├── sub/ 子目录.md
    /// ├── node_modules/ 忽略.js
    /// └── .hidden/ 隐藏.log
    fn make_temp_library() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::write(root.join("技术方案.md"), "# hi").unwrap();
        std::fs::write(root.join("系统配置.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub").join("子目录.md"), "# sub").unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules").join("忽略.js"), "x").unwrap();
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        std::fs::write(root.join(".hidden").join("隐藏.log"), "x").unwrap();
        (dir, root)
    }

    #[test]
    fn quick_scan_respects_exclusions() {
        let (_guard, root) = make_temp_library();
        let result = quick_scan(&root, &[]).unwrap();
        assert_eq!(result.file_count, 3);
        assert_eq!(result.dir_count, 1); // 仅 sub，node_modules/.hidden 被排除
        assert!(result.total_size > 0);
    }

    #[test]
    fn quick_scan_rejects_missing_dir() {
        assert!(quick_scan(Path::new("Z:/不存在的目录/"), &[]).is_err());
    }

    #[test]
    fn scan_and_children_roundtrip() {
        let conn = memory_db();
        let (_guard, root) = make_temp_library();
        let lib = create_library(
            &conn,
            CreateLibraryRequest {
                root_path: root.to_string_lossy().to_string(),
                name: Some("测试库".into()),
                exclude_dirs: vec![],
                full_text_index: true,
                ocr_enabled: false,
                portable_meta: false,
            },
        )
        .unwrap();
        assert_eq!(lib.file_count, 0);

        let count = scan_library_now(&conn, &lib.id, &root, &[]).unwrap();
        assert_eq!(count, 3);

        let lib = get_library(&conn, &lib.id).unwrap();
        assert_eq!(lib.file_count, 3);
        assert_eq!(lib.name, "测试库");

        // 根目录子项：目录在前，隐藏/排除目录不出现（NOCASE 仅对 ASCII 生效，中文按码点排序）
        let children = list_children(&conn, &lib.id, "").unwrap();
        let names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["sub", "技术方案.md", "系统配置.json"]);
        assert!(children[0].is_dir);

        // 格式识别已入库
        let md = children.iter().find(|c| c.name == "技术方案.md").unwrap();
        assert_eq!(md.format, "markdown");

        // 子目录遍历 + 路径使用 '/' 分隔
        let sub = children.iter().find(|c| c.name == "sub").unwrap();
        assert_eq!(sub.relative_path, "sub");
        let sub_children = list_children(&conn, &lib.id, "sub").unwrap();
        assert_eq!(sub_children.len(), 1);
        assert_eq!(sub_children[0].parent_path, "sub");

        // 详情查询
        let detail = get_file_detail(&conn, &lib.id, "技术方案.md").unwrap();
        assert_eq!(detail.format, "markdown");
        assert!(detail.size > 0);

        // 重复建库被拒绝；移除后文件一并清理
        let dup = create_library(
            &conn,
            CreateLibraryRequest {
                root_path: root.to_string_lossy().to_string(),
                name: None,
                exclude_dirs: vec![],
                full_text_index: false,
                ocr_enabled: false,
                portable_meta: false,
            },
        );
        assert!(dup.is_err());
        remove_library(&conn, &lib.id).unwrap();
        assert!(list_children(&conn, &lib.id, "").unwrap().is_empty());
        assert!(list_libraries(&conn).unwrap().is_empty());
    }

    #[test]
    fn custom_exclude_dirs_take_effect() {
        let (_guard, root) = make_temp_library();
        let result = quick_scan(&root, &["sub".to_string()]).unwrap();
        assert_eq!(result.file_count, 2); // 只剩根下两个文件
        assert_eq!(result.dir_count, 0);
    }
}
