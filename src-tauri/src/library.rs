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

/// 参与文本提取与全文索引的格式（Office/PDF 提取引擎在后续迭代接入）。
pub const TEXT_FORMATS: &[&str] = &["markdown", "text", "code", "json", "yaml", "xml", "config", "csv"];

/// 文本提取大小上限：超过则记录 too_large，不做正文索引。
pub const MAX_EXTRACT_BYTES: u64 = 2 * 1024 * 1024;

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
            ON files(library_id, parent_path);
        CREATE TABLE IF NOT EXISTS extracted_content (
            file_id           INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
            extractor_version TEXT NOT NULL,
            status            TEXT NOT NULL,
            text              TEXT
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
            file_id UNINDEXED, name, body, tokenize='trigram'
        );
        CREATE TABLE IF NOT EXISTS file_versions (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            library_id    TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            size          INTEGER NOT NULL,
            content       TEXT NOT NULL,
            created_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_versions_lib_path_time
            ON file_versions(library_id, relative_path, created_at DESC);
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS export_jobs (
            id            TEXT PRIMARY KEY,
            library_id    TEXT NOT NULL,
            sources_json  TEXT NOT NULL,
            formats_json  TEXT NOT NULL,
            target_dir    TEXT NOT NULL,
            output_dir    TEXT,
            status        TEXT NOT NULL,
            error         TEXT,
            outputs_json  TEXT NOT NULL DEFAULT '[]',
            created_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_export_jobs_lib
            ON export_jobs(library_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS annotations (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            library_id    TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            quote         TEXT NOT NULL,
            body          TEXT NOT NULL,
            resolved      INTEGER NOT NULL DEFAULT 0,
            created_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_annotations_lib_path
            ON annotations(library_id, relative_path, created_at DESC);",
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
        .prepare("SELECT * FROM libraries WHERE COALESCE(json_extract(settings_json, '$.adhoc'), 0) != 1
             ORDER BY last_opened_at DESC")
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
    conn.execute(
        "DELETE FROM search_fts WHERE file_id IN (SELECT id FROM files WHERE library_id = ?1)",
        [id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM files WHERE library_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM libraries WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 重命名 / 移动后迁移以相对路径为键的元数据（历史快照、批注），使其跟随文件。
/// 目录会连带迁移其下所有子路径。
pub fn migrate_path_refs(conn: &Connection, library_id: &str, old_rel: &str, new_rel: &str) -> Result<(), String> {
    if old_rel == new_rel || old_rel.is_empty() {
        return Ok(());
    }
    // 以 '!' 作为 LIKE 转义符，避免反斜杠转义歧义
    let escaped = old_rel.replace('!', "!!").replace('%', "!%").replace('_', "!_");
    let like = format!("{escaped}/%");
    let old_len = old_rel.chars().count() as i64;
    for table in ["file_versions", "annotations"] {
        let sql = format!(
            "UPDATE {table} SET relative_path = ?1 || substr(relative_path, ?2)
             WHERE library_id = ?3 AND (relative_path = ?4 OR relative_path LIKE ?5 ESCAPE '!')"
        );
        conn.execute(&sql, params![new_rel, old_len + 1, library_id, old_rel, like])
            .map_err(|e| format!("迁移元数据失败: {e}"))?;
    }
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

/// 从库设置 JSON 提取用户自定义排除目录。
pub fn excludes_from(settings: &serde_json::Value) -> Vec<String> {
    settings
        .get("excludeDirs")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// 轻量扫描：只统计数量与总大小，供建库向导第一步展示。
/// 被锁定/无权限的条目计入 skipped，不中断扫描。
pub fn quick_scan(root: &Path, exclude: &[String]) -> Result<QuickScanResult, String> {
    if !root.is_dir() {
        return Err(format!("文件夹不存在或不可访问: {}", root.display()));
    }
    let mut result = QuickScanResult { file_count: 0, dir_count: 0, total_size: 0 };
    for entry in WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| !is_excluded(e, exclude))
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // 被占用或无权限的条目跳过
        };
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

fn collect_scan_rows(
    root: &Path,
    exclude: &[String],
    cancel: Option<&std::sync::atomic::AtomicBool>,
    on_progress: Option<&dyn Fn(u64)>,
) -> Result<(Vec<ScanRow>, usize), String> {
    use std::sync::atomic::Ordering;
    let mut rows = Vec::new();
    let mut skipped = 0usize;
    for entry in WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| !is_excluded(e, exclude))
    {
        if let Some(flag) = cancel {
            if flag.load(Ordering::Relaxed) {
                return Err(ERR_CANCELED.into());
            }
        }
        if let Some(report) = on_progress {
            if rows.len() % 256 == 0 {
                report(rows.len() as u64);
            }
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                skipped += 1; // 被占用或无权限的条目跳过，不中断扫描
                continue;
            }
        };
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
    Ok((rows, skipped))
}

/// 单文件模式：只登记用户明确打开过的文件（不遍历整个文件夹）。
fn collect_adhoc_rows(root: &Path, names: &[String]) -> Vec<ScanRow> {
    names
        .iter()
        .filter_map(|name| {
            let meta = std::fs::metadata(root.join(name)).ok()?;
            if !meta.is_file() {
                return None;
            }
            Some(ScanRow {
                relative_path: name.clone(),
                name: name.clone(),
                parent_path: String::new(),
                is_dir: false,
                format: detect_format(name).into(),
                size: meta.len() as i64,
                mtime: mtime_ms(&meta),
            })
        })
        .collect()
}

/// 计算单个文件的提取结果（不访问数据库，可在无锁状态下执行）。
/// 文本格式按检测到的编码解码；Office 格式走 OOXML 安全解析（office.rs）。
pub(crate) fn extract_for_index(file_path: &Path, name: &str) -> (String, Option<String>) {
    let format = detect_format(name);
    if matches!(format, "word" | "excel" | "powerpoint") {
        match std::fs::metadata(file_path) {
            Ok(m) if m.len() <= crate::office::MAX_OFFICE_BYTES => {
                match crate::office::extract_text(file_path, format) {
                    Ok(t) if !t.trim().is_empty() => ("ok".to_string(), Some(t)),
                    Ok(_) => ("parse_error".to_string(), None),
                    Err(_) => ("parse_error".to_string(), None),
                }
            }
            Ok(_) => ("too_large".to_string(), None),
            Err(_) => ("read_error".to_string(), None),
        }
    } else {
        match std::fs::read(file_path) {
            Ok(bytes) if bytes.len() as u64 > MAX_EXTRACT_BYTES => ("too_large".to_string(), None),
            Ok(bytes) => ("ok".to_string(), Some(crate::textenc::decode_lossy_for_index(&bytes))),
            Err(_) => ("read_error".to_string(), None),
        }
    }
}

fn store_extraction(conn: &Connection, file_id: i64, name: &str, status: &str, text: Option<String>) {
    let _ = conn.execute(
        "INSERT INTO extracted_content (file_id, extractor_version, status, text) VALUES (?1, 'v1', ?2, ?3)",
        params![file_id, status, text],
    );
    if let Some(body) = text {
        let _ = conn.execute(
            "INSERT INTO search_fts (file_id, name, body) VALUES (?1, ?2, ?3)",
            params![file_id, name, body],
        );
    }
}

/// 按磁盘当前内容重建单个文件的提取记录与 FTS 行。
pub(crate) fn index_file_content(conn: &Connection, file_path: &Path, file_id: i64, name: &str) {
    let _ = clear_extraction(conn, file_id);
    let (status, text) = extract_for_index(file_path, name);
    store_extraction(conn, file_id, name, &status, text);
}

pub(crate) fn clear_extraction(conn: &Connection, file_id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM extracted_content WHERE file_id = ?1", params![file_id])?;
    conn.execute("DELETE FROM search_fts WHERE file_id = ?1", params![file_id])?;
    Ok(())
}

pub(crate) fn file_mtime(path: &Path) -> i64 {
    std::fs::metadata(path).ok().map(|m| mtime_ms(&m)).unwrap_or(0)
}

pub(crate) fn now_millis() -> i64 {
    now_ms()
}

/// 库内已登记文件的快照，用于增量比对（未变化的文件不重复提取，保持文件 id 稳定）。
pub struct ExistingRow {
    id: i64,
    size: i64,
    mtime: i64,
    format: String,
}

pub type ExistingMap = std::collections::HashMap<String, ExistingRow>;

pub fn load_existing(conn: &Connection, library_id: &str) -> Result<ExistingMap, String> {
    let mut stmt = conn
        .prepare("SELECT relative_path, id, size, mtime, format FROM files WHERE library_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([library_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                ExistingRow { id: row.get(1)?, size: row.get(2)?, mtime: row.get(3)?, format: row.get(4)? },
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<ExistingMap>>().map_err(|e| e.to_string())
}

fn is_unchanged(existing: &ExistingMap, row: &ScanRow) -> bool {
    existing
        .get(&row.relative_path)
        .map(|ex| ex.size == row.size && ex.mtime == row.mtime && ex.format == row.format)
        .unwrap_or(false)
}

/// 扫描准备阶段的产物：目录遍历结果 + 变更文件的提取结果（均不需要数据库锁）。
pub struct Prepared {
    root: PathBuf,
    rows: Vec<ScanRow>,
    skipped: usize,
    extracted: std::collections::HashMap<usize, (String, Option<String>)>,
}

/// 阶段一（无锁）：遍历目录，仅对新增/变更的文本文件读取并提取正文。
pub fn scan_prepare(
    root: &Path,
    exclude: &[String],
    existing: &ExistingMap,
    opts: &ScanOptions<'_>,
    only_files: Option<&[String]>,
) -> Result<Prepared, String> {
    let (rows, skipped) = match only_files {
        Some(names) => (collect_adhoc_rows(root, names), 0),
        None => collect_scan_rows(root, exclude, opts.cancel, opts.on_progress)?,
    };
    let mut extracted = std::collections::HashMap::new();
    for (i, row) in rows.iter().enumerate() {
        if let Some(flag) = opts.cancel {
            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(ERR_CANCELED.into());
            }
        }
        if !row.is_dir && TEXT_FORMATS.contains(&row.format.as_str()) && !is_unchanged(existing, row) {
            extracted.insert(i, extract_for_index(&root.join(&row.relative_path), &row.name));
        }
    }
    Ok(Prepared { root: root.to_path_buf(), rows, skipped, extracted })
}

/// 阶段二（持锁，仅数据库写入）：增量更新 files / 提取表 / FTS，单事务，失败可回滚。
pub fn scan_apply(conn: &Connection, library_id: &str, prepared: Prepared) -> Result<ScanOutcome, String> {
    let Prepared { root, rows, skipped, extracted } = prepared;
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开启索引事务失败: {e}"))?;
    let existing = load_existing(&tx, library_id)?;

    // 已从磁盘消失的条目
    let live: std::collections::HashSet<&str> = rows.iter().map(|r| r.relative_path.as_str()).collect();
    for (path, ex) in &existing {
        if !live.contains(path.as_str()) {
            clear_extraction(&tx, ex.id).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM files WHERE id = ?1", [ex.id]).map_err(|e| e.to_string())?;
        }
    }

    for (i, row) in rows.iter().enumerate() {
        let is_text = !row.is_dir && TEXT_FORMATS.contains(&row.format.as_str());
        match existing.get(&row.relative_path) {
            Some(ex) => {
                let unchanged = ex.size == row.size && ex.mtime == row.mtime && ex.format == row.format;
                if unchanged && !extracted.contains_key(&i) {
                    continue;
                }
                tx.execute(
                    "UPDATE files SET name = ?1, parent_path = ?2, is_dir = ?3, format = ?4, size = ?5, mtime = ?6
                     WHERE id = ?7",
                    params![row.name, row.parent_path, row.is_dir, row.format, row.size, row.mtime, ex.id],
                )
                .map_err(|e| format!("更新索引失败: {e}"))?;
                if is_text {
                    clear_extraction(&tx, ex.id).map_err(|e| e.to_string())?;
                    let (status, text) = extracted
                        .get(&i)
                        .cloned()
                        .unwrap_or_else(|| extract_for_index(&root.join(&row.relative_path), &row.name));
                    store_extraction(&tx, ex.id, &row.name, &status, text);
                }
            }
            None => {
                tx.execute(
                    "INSERT INTO files (library_id, relative_path, name, parent_path, is_dir, format, size, mtime)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        library_id,
                        row.relative_path,
                        row.name,
                        row.parent_path,
                        row.is_dir,
                        row.format,
                        row.size,
                        row.mtime
                    ],
                )
                .map_err(|e| format!("写入索引失败: {e}"))?;
                let id = tx.last_insert_rowid();
                if is_text {
                    let (status, text) = extracted
                        .get(&i)
                        .cloned()
                        .unwrap_or_else(|| extract_for_index(&root.join(&row.relative_path), &row.name));
                    store_extraction(&tx, id, &row.name, &status, text);
                }
            }
        }
    }
    tx.commit().map_err(|e| format!("提交索引事务失败: {e}"))?;
    let file_count = rows.iter().filter(|r| !r.is_dir).count();
    conn.execute(
        "UPDATE libraries SET file_count = ?1 WHERE id = ?2",
        params![file_count as i64, library_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(ScanOutcome { file_count, skipped })
}

/// 完整扫描结果：入库文件数与被跳过（被占用/无权限）的条目数。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOutcome {
    pub file_count: usize,
    pub skipped: usize,
}

/// 取消哨兵：collect_scan_rows / scan_library_with 以该错误串表示任务被取消。
pub const ERR_CANCELED: &str = "SCAN_CANCELED";

/// 扫描可选行为：取消旗标与进度回调。
#[derive(Default)]
pub struct ScanOptions<'a> {
    pub cancel: Option<&'a std::sync::atomic::AtomicBool>,
    pub on_progress: Option<&'a dyn Fn(u64)>,
}

/// 完整扫描（单连接同步版，供测试与已持锁的调用方使用）：增量更新该库索引。
#[cfg(test)]
pub fn scan_library_with(conn: &Connection, library_id: &str, root: &Path, exclude: &[String], opts: ScanOptions<'_>) -> Result<ScanOutcome, String> {
    let existing = load_existing(conn, library_id)?;
    let prepared = scan_prepare(root, exclude, &existing, &opts, None)?;
    scan_apply(conn, library_id, prepared)
}

/// 完整扫描（不长期持锁版）：目录遍历与正文提取在无锁状态执行，仅写库时短暂持锁，
/// 扫描期间其他命令（列目录、搜索、保存）不被阻塞。
pub fn scan_library_locked(state: &AppState, library_id: &str, root: &Path, exclude: &[String], opts: ScanOptions<'_>) -> Result<ScanOutcome, String> {
    let (existing, only) = {
        let conn = state.0.lock().unwrap();
        let meta = get_library(&conn, library_id)?;
        let only = if meta.settings.get("adhoc").and_then(|v| v.as_bool()).unwrap_or(false) {
            Some(
                meta.settings
                    .get("files")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>())
                    .unwrap_or_default(),
            )
        } else {
            None
        };
        (load_existing(&conn, library_id)?, only)
    };
    let prepared = scan_prepare(root, exclude, &existing, &opts, only.as_deref())?;
    let conn = state.0.lock().unwrap();
    scan_apply(&conn, library_id, prepared)
}

/// 完整扫描（后台线程版，纳入任务中心）：扫描 → 提取 → 重建索引，
/// 全程通过 `tasks:updated` 上报进度，结束后发送 `scan:completed` / `scan:failed` / `scan:canceled`。
pub fn spawn_full_scan(
    app: AppHandle,
    state: AppState,
    tasks: crate::tasks::TaskManager,
    library_id: String,
    library_name: String,
    root: PathBuf,
    exclude: Vec<String>,
) {
    std::thread::spawn(move || {
        let started = Instant::now();
        let task_id = tasks.begin(crate::tasks::TaskKind::Scan, &format!("扫描索引 · {library_name}"));
        let cancel = tasks.attach_cancel(&task_id);
        crate::tasks::emit_tasks(&app, &tasks);

        let mgr_for_progress = tasks.clone();
        let progress = |processed: u64| {
            mgr_for_progress.progress(&task_id, processed);
        };
        let result = scan_library_locked(
            &state,
            &library_id,
            &root,
            &exclude,
            ScanOptions { cancel: Some(&cancel), on_progress: Some(&progress) },
        );

        match &result {
            Ok(outcome) => {
                tasks.finish(
                    &task_id,
                    crate::tasks::TaskStatus::Completed,
                    Some(format!("{} 个文件 · {} 项跳过", outcome.file_count, outcome.skipped)),
                    None,
                );
                let _ = app.emit(
                    "scan:completed",
                    json!({
                        "libraryId": library_id,
                        "fileCount": outcome.file_count,
                        "skipped": outcome.skipped,
                        "durationMs": started.elapsed().as_millis() as u64,
                    }),
                );
            }
            Err(err) if err == ERR_CANCELED => {
                tasks.finish(&task_id, crate::tasks::TaskStatus::Canceled, None, None);
                let _ = app.emit("scan:canceled", json!({ "libraryId": library_id }));
            }
            Err(err) => {
                tasks.finish(
                    &task_id,
                    crate::tasks::TaskStatus::Failed,
                    None,
                    Some(err.clone()),
                );
                let _ = app.emit("scan:failed", json!({ "libraryId": library_id, "error": err }));
            }
        }
        crate::tasks::emit_tasks(&app, &tasks);
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

/// 列出库内全部文件（不含目录），供 AI 上下文选择等使用。
pub fn list_all_files(conn: &Connection, library_id: &str, limit: i64) -> Result<Vec<FileEntryDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT * FROM files WHERE library_id = ?1 AND is_dir = 0
             ORDER BY relative_path COLLATE NOCASE LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![library_id, limit], row_to_file_entry)
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

// ---------------------------------------------------------------------------
// 全文检索
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHitDto {
    #[serde(flatten)]
    pub entry: FileEntryDto,
    /// 命中片段（命中位置以【】标注）；文件名命中时为空
    pub snippet: String,
    /// name = 文件名命中；body = 正文命中
    pub matched_in: String,
}

fn hit_from_row(row: &rusqlite::Row<'_>, query: &str, snippet: Option<String>) -> rusqlite::Result<SearchHitDto> {
    let entry = row_to_file_entry(row)?;
    let matched_in = if entry.name.to_lowercase().contains(&query.to_lowercase()) {
        "name"
    } else {
        "body"
    };
    Ok(SearchHitDto {
        entry,
        snippet: snippet.unwrap_or_default(),
        matched_in: matched_in.to_string(),
    })
}

/// 在单个文档库内搜索：≥3 字符走 FTS5 trigram（文件名 + 正文），不足 3 字符仅按文件名匹配。
pub fn search_library(conn: &Connection, library_id: &str, query: &str, limit: i64) -> Result<Vec<SearchHitDto>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    if q.chars().count() >= 3 {
        let match_q = format!("\"{}\"", q.replace('"', "\"\""));
        let mut stmt = conn
            .prepare(
                "SELECT f.*, snippet(search_fts, 2, '【', '】', '…', 16) AS snip
                 FROM search_fts JOIN files f ON f.id = search_fts.file_id
                 WHERE search_fts MATCH ?1 AND f.library_id = ?2 AND f.is_dir = 0
                 LIMIT ?3",
            )
            .map_err(|e| format!("搜索失败: {e}"))?;
        let rows = stmt
            .query_map(params![match_q, library_id, limit], |row| {
                let snip: String = row.get("snip")?;
                hit_from_row(row, q, Some(snip))
            })
            .map_err(|e| format!("搜索失败: {e}"))?;
        return rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string());
    }

    // 短查询（FTS5 trigram 至少需 3 个字符）回退：文件名 + 正文 LIKE（转义通配符）
    let mut escaped = String::new();
    for ch in q.chars() {
        match ch {
            '\\' | '%' | '_' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }
    let mut stmt = conn
        .prepare(
            "SELECT f.* FROM files f
             LEFT JOIN extracted_content e ON e.file_id = f.id
             WHERE f.library_id = ?1 AND f.is_dir = 0
               AND (f.name LIKE '%' || ?2 || '%' ESCAPE '\\' OR e.text LIKE '%' || ?2 || '%' ESCAPE '\\')
             ORDER BY f.name COLLATE NOCASE
             LIMIT ?3",
        )
        .map_err(|e| format!("搜索失败: {e}"))?;
    let rows = stmt
        .query_map(params![library_id, escaped, limit], |row| hit_from_row(row, q, None))
        .map_err(|e| format!("搜索失败: {e}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
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

        let outcome = scan_library_with(&conn, &lib.id, &root, &[], ScanOptions::default()).unwrap();
        assert_eq!(outcome.file_count, 3);
        assert_eq!(outcome.skipped, 0);

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

    /// 技术验证 Spike（设计文档 §17.1）：5 万混合文件库的扫描、提取、FTS5 索引与检索性能。
    /// 默认忽略，手动运行：
    ///   cargo test --profile spike spike_50k -- --ignored --nocapture
    /// 参考目标（设计文档 §13.1，10 万文件规模）：文件名搜索首屏 ≤ 200ms，全文搜索首屏 ≤ 500ms。
    #[test]
    #[ignore = "性能 Spike：生成 5 万文件需要较长时间，按上述命令手动运行"]
    fn spike_50k_files_scan_and_search() {
        let conn = memory_db();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let dirs = 100;
        let files_per_dir = 500;
        let total = dirs * files_per_dir;

        let t_gen = Instant::now();
        for d in 0..dirs {
            let dir_path = root.join(format!("{d:03}_分类目录"));
            std::fs::create_dir_all(&dir_path).unwrap();
            for f in 0..files_per_dir {
                let keyword = if f % 10 == 0 { "本方案采用负载均衡实现流量分发与高可用部署。" } else { "系统采用分层架构设计，保障可用性、可扩展性与安全性。" };
                let body = format!(
                    "# 技术文档 {d}-{f}\n\n{keyword}\n\n## 要点\n\n- 配置项 config-{d}-{f} 已按规范填写\n- 数据校验与日志记录遵循运维手册要求\n"
                );
                let name = match f % 3 {
                    0 => format!("技术方案-{d}-{f}.md"),
                    1 => format!("服务器清单-{d}-{f}.csv"),
                    _ => format!("系统配置-{d}-{f}.json"),
                };
                std::fs::write(dir_path.join(name), body).unwrap();
            }
        }
        println!("[Spike] 生成 {} 个文件: {:?}", total, t_gen.elapsed());

        let lib = create_library(
            &conn,
            CreateLibraryRequest {
                root_path: root.to_string_lossy().to_string(),
                name: Some("Spike 库".into()),
                exclude_dirs: vec![],
                full_text_index: true,
                ocr_enabled: false,
                portable_meta: false,
            },
        )
        .unwrap();

        // 首次全量扫描 + 文本提取 + FTS5 索引
        let t_scan = Instant::now();
        let outcome = scan_library_with(&conn, &lib.id, &root, &[], ScanOptions::default()).unwrap();
        let scan_elapsed = t_scan.elapsed();
        assert_eq!(outcome.file_count, total);
        assert_eq!(outcome.skipped, 0);
        println!("[Spike] 首次扫描+提取+索引: {:?}（{} 文件/秒）", scan_elapsed, total as u128 * 1000 / scan_elapsed.as_millis().max(1));

        let fts_count: i64 = conn.query_row("SELECT COUNT(*) FROM search_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(fts_count, total as i64);

        // 正文关键词检索（命中 1/10 的文件）
        let t_search = Instant::now();
        let hits = search_library(&conn, &lib.id, "负载均衡", 10_000).unwrap();
        let search_elapsed = t_search.elapsed();
        assert_eq!(hits.len(), total / 10);
        println!("[Spike] 全文搜索「负载均衡」（命中 {}）: {:?}", hits.len(), search_elapsed);

        // 文件名检索
        let t_name = Instant::now();
        let hits = search_library(&conn, &lib.id, "技术方案-42-117", 100).unwrap();
        println!("[Spike] 文件名搜索: {:?}（命中 {}）", t_name.elapsed(), hits.len());
        assert_eq!(hits.len(), 1);

        // 重建索引（模拟文件监听触发的全量重扫）
        let t_rescan = Instant::now();
        let outcome = scan_library_with(&conn, &lib.id, &root, &[], ScanOptions::default()).unwrap();
        println!("[Spike] 全量重建索引: {:?}（{} 个文件）", t_rescan.elapsed(), outcome.file_count);
        assert_eq!(outcome.file_count, total);

        // 重建后 FTS 无重复
        let fts_after: i64 = conn.query_row("SELECT COUNT(*) FROM search_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(fts_after, total as i64);

        println!("[Spike] 完成。扫描 {:?} | 搜索 {:?} | 重建 {:?}",
            scan_elapsed, search_elapsed, t_rescan.elapsed());
    }

    #[test]
    fn extraction_and_search_roundtrip() {
        let conn = memory_db();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join("架构")).unwrap();
        std::fs::write(
            root.join("架构").join("负载均衡架构设计.md"),
            "# 接入层设计\n\n为应对高并发访问，引入负载均衡（SLB）实现流量分发，\n支持多可用区部署，提升服务的高可用性。\n",
        )
        .unwrap();
        std::fs::write(root.join("系统配置.json"), "{\"engine\": \"sqlite-fts5\"}").unwrap();

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
        let outcome = scan_library_with(&conn, &lib.id, &root, &[], ScanOptions::default()).unwrap();
        assert_eq!(outcome.file_count, 2);
        assert_eq!(outcome.skipped, 0);

        // 长查询：FTS 命中；文件名与正文均含关键词时优先标记为文件名命中
        let hits = search_library(&conn, &lib.id, "负载均衡", 50).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].matched_in, "name");
        assert!(hits[0].snippet.contains("负载均衡"));
        assert_eq!(hits[0].entry.format, "markdown");

        // 正文独有关键词（不在文件名中）→ 正文命中
        let hits = search_library(&conn, &lib.id, "多可用区", 50).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].matched_in, "body");
        assert!(hits[0].snippet.contains("多可用区"));

        // JSON 正文也可命中
        let hits = search_library(&conn, &lib.id, "sqlite-fts5", 50).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entry.format, "json");

        // 短查询（<3 字符）回退文件名匹配
        let hits = search_library(&conn, &lib.id, "配置", 50).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].matched_in, "name");
        assert_eq!(hits[0].entry.name, "系统配置.json");

        // 重复扫描不产生重复 FTS 记录
        scan_library_with(&conn, &lib.id, &root, &[], ScanOptions::default()).unwrap();
        let fts_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM search_fts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(fts_count, 2);

        // 提取状态记录完整
        let extracted: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM extracted_content WHERE status = 'ok'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(extracted, 2);
    }
}
