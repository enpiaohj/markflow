//! 文档库服务（设计文档 §6 文档库模型、§11 数据设计）：
//! 库 = 用户选择的普通本地文件夹；SQLite 只存索引与元数据，绝不作为正文唯一副本。

use crate::lockext::LockExt;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
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

/// 扫描时提取正文、写入全文索引的格式：文本类 + Office（Word / Excel / PowerPoint 走 OOXML 安全解析）。
/// 与 TEXT_FORMATS（可在应用内编辑的文本格式）区分。
pub const INDEX_FORMATS: &[&str] = &["markdown", "text", "code", "json", "yaml", "xml", "config", "csv", "word", "excel", "powerpoint"];

fn is_indexable(format: &str) -> bool {
    INDEX_FORMATS.contains(&format)
}

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

/// 只读连接池大小：够覆盖「列表 / 搜索 / 预览 / AI 上下文」并发读取，又不占过多文件句柄。
const READ_POOL_SIZE: usize = 4;

/// 只读连接池：WAL 模式下读连接不被写事务阻塞（读到的是上一次提交的快照）。
pub struct ReadPool {
    conns: Vec<Mutex<Connection>>,
    next: AtomicUsize,
}

/// 全局应用状态（可克隆进扫描线程）：
/// - `.0` 写连接（唯一）：所有写入、事务、扫描落库都走它；长事务只会让「其他写入」排队；
/// - `.1` 只读连接池：纯读取命令走 [`AppState::read`]，不再被扫描 / 保存等写事务挡住。
///
/// 读到的数据是「最近一次已提交」的快照；写命令返回前已提交，随后发起的读一定能看到。
#[derive(Clone)]
pub struct AppState(pub Arc<Mutex<Connection>>, pub Arc<ReadPool>);

impl AppState {
    /// 无独立读连接的状态（内存库测试用）：`read()` 退化为共用写连接。
    #[cfg(test)]
    pub fn single(conn: Connection) -> Self {
        AppState(
            Arc::new(Mutex::new(conn)),
            Arc::new(ReadPool { conns: Vec::new(), next: AtomicUsize::new(0) }),
        )
    }

    /// 取一条只读连接：优先取空闲的，全忙时在轮转到的那条上等待。
    pub fn read(&self) -> MutexGuard<'_, Connection> {
        let pool = &self.1;
        let n = pool.conns.len();
        if n == 0 {
            return self.0.lock_safe();
        }
        let start = pool.next.fetch_add(1, Ordering::Relaxed) % n;
        for k in 0..n {
            match pool.conns[(start + k) % n].try_lock() {
                Ok(guard) => return guard,
                Err(TryLockError::Poisoned(p)) => return p.into_inner(),
                Err(TryLockError::WouldBlock) => {}
            }
        }
        pool.conns[start].lock_safe()
    }
}

/// 连接通用设置：等待锁的上限，避免偶发的 SQLITE_BUSY（如 WAL 检查点）直接报错。
fn tune_connection(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(std::time::Duration::from_secs(5))
}

/// 打开索引库：一条写连接（负责建表 / 迁移）+ 只读连接池（`query_only`，从根本上杜绝误写）。
pub fn open_state(db_path: &Path) -> Result<AppState, String> {
    let writer = Connection::open(db_path).map_err(|e| format!("无法打开索引数据库: {e}"))?;
    tune_connection(&writer).map_err(|e| format!("数据库初始化失败: {e}"))?;
    run_migrations(&writer).map_err(|e| format!("数据库初始化失败: {e}"))?;
    let mut readers = Vec::with_capacity(READ_POOL_SIZE);
    for _ in 0..READ_POOL_SIZE {
        let conn = Connection::open(db_path).map_err(|e| format!("无法打开索引数据库（只读连接）: {e}"))?;
        tune_connection(&conn).map_err(|e| format!("数据库初始化失败: {e}"))?;
        conn.pragma_update(None, "query_only", true)
            .map_err(|e| format!("数据库初始化失败: {e}"))?;
        readers.push(Mutex::new(conn));
    }
    Ok(AppState(
        Arc::new(Mutex::new(writer)),
        Arc::new(ReadPool { conns: readers, next: AtomicUsize::new(0) }),
    ))
}

// ---------------------------------------------------------------------------
// 数据库初始化与迁移
// ---------------------------------------------------------------------------

/// 建表语句，独立出来便于单元测试在内存库上执行。
pub fn run_migrations(conn: &Connection) -> rusqlite::Result<()> {
    // WAL：写入不独占整库、不需要为每个事务重写回滚日志；对内存库无意义（sqlite 会忽略），忽略其错误。
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
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
            name, body, tokenize='trigram'
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
    )?;
    migrate_search_fts_to_rowid(conn)
}

/// 修复早期版本的 `search_fts` schema：`file_id` 曾是 UNINDEXED 列，按它做 `DELETE`（每次保存 /
/// 重扫 / 外部文件被删除时都会触发）等价于全表扫描——库积累到几十万条正文记录后，
/// 删除几百个文件就可能卡住数十秒甚至更久，界面因此被系统判定为「未响应」。
/// 修复方式：把 `file_id` 改为 FTS5 表本身的 `rowid`（天然有索引，删除是 O(log n) 查找），
/// `CREATE VIRTUAL TABLE IF NOT EXISTS` 对已存在的旧表是空操作，所以这里检测旧 schema 并按
/// `extracted_content`（唯一可信来源）整体重建一次；只在检测到旧 schema 时执行，重建后不会再触发。
fn migrate_search_fts_to_rowid(conn: &Connection) -> rusqlite::Result<()> {
    let has_old_schema: bool = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type IN ('table', 'view') AND name = 'search_fts'",
            [],
            |r| r.get::<_, String>(0),
        )
        .map(|sql| sql.contains("file_id"))
        .unwrap_or(false);
    if !has_old_schema {
        return Ok(());
    }
    conn.execute_batch(
        "DROP TABLE search_fts;
         CREATE VIRTUAL TABLE search_fts USING fts5(name, body, tokenize='trigram');",
    )?;
    conn.execute(
        "INSERT INTO search_fts (rowid, name, body)
         SELECT ec.file_id, f.name, ec.text
         FROM extracted_content ec
         JOIN files f ON f.id = ec.file_id
         WHERE ec.text IS NOT NULL",
        [],
    )?;
    Ok(())
}

/// 打开（或创建）应用数据目录下的索引库（写连接 + 只读连接池）。
pub fn init_db(app: &AppHandle) -> Result<AppState, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建应用数据目录: {e}"))?;
    open_state(&dir.join("markflow.db"))
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
    let dup: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM libraries WHERE lower(name) = lower(?1))",
            [name.trim()],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if dup {
        return Err(format!("已有名为「{}」的文档库，请换一个名称。", name.trim()));
    }
    let settings = json!({
        "excludeDirs": req.exclude_dirs,
        "fullTextIndex": req.full_text_index,
        "ocrEnabled": req.ocr_enabled,
        "portableMeta": req.portable_meta,
    });
    let now = now_ms();
    let reuse_key = format!("removed_library:{}", req.root_path);
    let reused: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [&reuse_key], |r| r.get(0))
        .ok();
    let id = reused.unwrap_or_else(|| Uuid::new_v4().to_string());
    let _ = conn.execute("DELETE FROM settings WHERE key = ?1", [&reuse_key]);
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
        // 不透出底层数据库错误原文；该库可能已被移除或从未创建
        .map_err(|_| "文档库不存在，可能已被移除，请重新打开或创建".to_string())
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
    // 索引可重建，但历史版本 / 批注 / 交付记录按 library_id 存放：记住「文件夹 → 库 ID」，
    // 之后重新添加同一文件夹时沿用旧 ID，这些数据即可恢复
    if let Ok(root) = conn.query_row("SELECT root_path FROM libraries WHERE id = ?1", [id], |r| r.get::<_, String>(0)) {
        let _ = conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![format!("removed_library:{root}"), id],
        );
    }
    conn.execute(
        "DELETE FROM search_fts WHERE rowid IN (SELECT id FROM files WHERE library_id = ?1)",
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

/// 系统 / 办公软件生成的临时文件（资源管理器默认隐藏，不是用户内容）：
/// Office 打开文档时的锁文件 `~$*`、Word 自动保存临时文件 `~*.tmp`、缩略图缓存与文件夹配置。
/// 这类文件在用户打开 / 关闭文档时频繁创建删除，既不应入库，也不应触发文件监听重扫。
pub fn is_system_temp_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("~$")
        || (lower.starts_with('~') && lower.ends_with(".tmp"))
        || matches!(lower.as_str(), "thumbs.db" | "ehthumbs.db" | "desktop.ini")
}

/// 判断条目是否应被排除（隐藏项、系统临时文件、默认排除目录、用户自定义排除目录）。
fn is_excluded(entry: &walkdir::DirEntry, exclude: &[String]) -> bool {
    if entry.depth() == 0 {
        return false; // 根目录本身不排除
    }
    let name = entry.file_name().to_string_lossy();
    if name.starts_with('.') {
        return true;
    }
    if !entry.file_type().is_dir() && is_system_temp_file(&name) {
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
    if let Some(report) = on_progress {
        report(rows.len() as u64); // 遍历结束：上报准确总数（过程中按每 256 项上报）
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
                    Ok(t) if !t.trim().is_empty() => ("ok".to_string(), Some(truncate_utf8(t, MAX_EXTRACT_BYTES as usize))),
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

/// 按字节上限截断字符串（落在 UTF-8 字符边界上）。
fn truncate_utf8(mut s: String, max: usize) -> String {
    if s.len() > max {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
    s
}

fn store_extraction(conn: &Connection, file_id: i64, name: &str, status: &str, text: Option<String>) {
    let _ = conn.execute(
        "INSERT INTO extracted_content (file_id, extractor_version, status, text) VALUES (?1, 'v1', ?2, ?3)",
        params![file_id, status, text],
    );
    if let Some(body) = text {
        // rowid 就是 file_id：删除按 rowid 走索引，避免早期 `file_id UNINDEXED` 列的全表扫描
        let _ = conn.execute(
            "INSERT INTO search_fts (rowid, name, body) VALUES (?1, ?2, ?3)",
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
    conn.execute("DELETE FROM search_fts WHERE rowid = ?1", params![file_id])?;
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
    /// 是否已有正文提取记录（旧版本扫描不提取 Office 正文，这类文件需补提一次）
    has_extract: bool,
}

pub type ExistingMap = std::collections::HashMap<String, ExistingRow>;

pub fn load_existing(conn: &Connection, library_id: &str) -> Result<ExistingMap, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.relative_path, f.id, f.size, f.mtime, f.format,
                    EXISTS(SELECT 1 FROM extracted_content e WHERE e.file_id = f.id)
             FROM files f WHERE f.library_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([library_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                ExistingRow {
                    id: row.get(1)?,
                    size: row.get(2)?,
                    mtime: row.get(3)?,
                    format: row.get(4)?,
                    has_extract: row.get(5)?,
                },
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

/// 需要（重新）提取正文：新增 / 变更的可索引文件，或从未提取过（旧版本未索引的 Office 文件）。
fn needs_extract(existing: &ExistingMap, row: &ScanRow) -> bool {
    !row.is_dir
        && is_indexable(&row.format)
        && (!is_unchanged(existing, row) || existing.get(&row.relative_path).is_some_and(|ex| !ex.has_extract))
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
    let walked = rows.len() as u64;
    for (i, row) in rows.iter().enumerate() {
        if let Some(flag) = opts.cancel {
            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(ERR_CANCELED.into());
            }
        }
        if needs_extract(existing, row) {
            extracted.insert(i, extract_for_index(&root.join(&row.relative_path), &row.name));
            // 提取阶段继续上报进度（首次索引大量 Office 文件时可能耗时较长，避免进度停住像卡死）
            if let Some(report) = opts.on_progress {
                if extracted.len() % 16 == 0 {
                    report(walked + extracted.len() as u64);
                }
            }
        }
    }
    Ok(Prepared { root: root.to_path_buf(), rows, skipped, extracted })
}

/// 待写入全文索引的正文：阶段二之后分批写入（每批单独短暂持锁）。
pub struct PendingExtract {
    file_id: i64,
    name: String,
    path: PathBuf,
    /// 阶段一已提取的结果；None 表示需在写入前（无锁）补做提取
    result: Option<(String, Option<String>)>,
}

/// 阶段二（持锁，仅元数据）：增量更新 files 表（新增 / 变更 / 删除），单事务，失败可回滚；
/// 已变更文件的旧正文在同一事务内清除。耗时的正文写入（FTS 建索引）不在此处，见 `store_pending`。
pub fn scan_apply(conn: &Connection, library_id: &str, prepared: Prepared) -> Result<(ScanOutcome, Vec<PendingExtract>), String> {
    let Prepared { root, rows, skipped, mut extracted } = prepared;
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

    let mut pending = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let is_text = !row.is_dir && is_indexable(&row.format);
        let file_id = match existing.get(&row.relative_path) {
            Some(ex) => {
                let unchanged = ex.size == row.size && ex.mtime == row.mtime && ex.format == row.format;
                // 未变化且已有正文：跳过；未变化但从未提取（旧版本未索引的 Office）：只补正文
                if unchanged && (ex.has_extract || !is_text) && !extracted.contains_key(&i) {
                    continue;
                }
                if !unchanged {
                    tx.execute(
                        "UPDATE files SET name = ?1, parent_path = ?2, is_dir = ?3, format = ?4, size = ?5, mtime = ?6
                         WHERE id = ?7",
                        params![row.name, row.parent_path, row.is_dir, row.format, row.size, row.mtime, ex.id],
                    )
                    .map_err(|e| format!("更新索引失败: {e}"))?;
                }
                clear_extraction(&tx, ex.id).map_err(|e| e.to_string())?;
                ex.id
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
                tx.last_insert_rowid()
            }
        };
        if is_text {
            pending.push(PendingExtract {
                file_id,
                name: row.name.clone(),
                path: root.join(&row.relative_path),
                result: extracted.remove(&i),
            });
        }
    }
    tx.commit().map_err(|e| format!("提交索引事务失败: {e}"))?;
    let file_count = rows.iter().filter(|r| !r.is_dir).count();
    conn.execute(
        "UPDATE libraries SET file_count = ?1 WHERE id = ?2",
        params![file_count as i64, library_id],
    )
    .map_err(|e| e.to_string())?;
    Ok((ScanOutcome { file_count, skipped }, pending))
}

/// 单批正文写入的大致文本量：FTS trigram 建索引约 1MB/300ms，每批持锁控制在 ~150ms 以内
const PENDING_BATCH_BYTES: usize = 512 * 1024;

/// 把 pending 按文本量切成若干批（每批至少 1 条）。
fn split_pending(mut pending: Vec<PendingExtract>) -> Vec<Vec<PendingExtract>> {
    let mut batches = Vec::new();
    let mut cur = Vec::new();
    let mut bytes = 0usize;
    for p in pending.drain(..) {
        let len = p.result.as_ref().and_then(|(_, t)| t.as_ref()).map(|t| t.len()).unwrap_or(0);
        if !cur.is_empty() && bytes + len > PENDING_BATCH_BYTES {
            batches.push(std::mem::take(&mut cur));
            bytes = 0;
        }
        bytes += len;
        cur.push(p);
    }
    if !cur.is_empty() {
        batches.push(cur);
    }
    batches
}

/// 写入一批正文（调用方持锁）：单事务；文件行已被并发删除或已有正文（被保存等操作更新过）时跳过。
fn store_pending(conn: &Connection, batch: Vec<PendingExtract>) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| format!("开启索引事务失败: {e}"))?;
    for p in batch {
        let (status, text) = match p.result {
            Some(r) => r,
            None => extract_for_index(&p.path, &p.name),
        };
        let fresh: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM files WHERE id = ?1)
                    AND NOT EXISTS(SELECT 1 FROM extracted_content WHERE file_id = ?1)",
                [p.file_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if fresh {
            store_extraction(&tx, p.file_id, &p.name, &status, text);
        }
    }
    tx.commit().map_err(|e| format!("提交索引事务失败: {e}"))
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
    let (outcome, pending) = scan_apply(conn, library_id, prepared)?;
    for batch in split_pending(pending) {
        store_pending(conn, batch)?;
    }
    Ok(outcome)
}

/// 完整扫描（不长期持锁版）：目录遍历与正文提取在无锁状态执行，仅写库时短暂持锁，
/// 扫描期间其他命令（列目录、搜索、保存）不被阻塞。
pub fn scan_library_locked(state: &AppState, library_id: &str, root: &Path, exclude: &[String], opts: ScanOptions<'_>) -> Result<ScanOutcome, String> {
    let (existing, only) = {
        let conn = state.0.lock_safe();
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
    let (outcome, pending) = {
        let conn = state.0.lock_safe();
        scan_apply(&conn, library_id, prepared)?
    };
    // 正文分批写入全文索引：每批单独短暂持锁，批次之间其他命令（列目录、搜索、保存）可以插队，
    // 首次索引大量 Office 文件时界面不再被长时间阻塞
    for mut batch in split_pending(pending) {
        if let Some(flag) = opts.cancel {
            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(ERR_CANCELED.into());
            }
        }
        // 阶段一未提取的（竞态补漏）先在锁外提取
        for p in batch.iter_mut().filter(|p| p.result.is_none()) {
            p.result = Some(extract_for_index(&p.path, &p.name));
        }
        store_pending(&state.0.lock_safe(), batch)?;
    }
    Ok(outcome)
}

/// 全量扫描合并表：库 ID → 扫描进行期间是否又收到了扫描请求。
/// 同一文档库同一时刻只跑一个全量扫描；进行中再来的请求不并行重复扫描，而是结束后补跑一次，
/// 保证请求发出后的磁盘变化一定会被下一轮扫描看到。
static SCAN_RUNS: std::sync::Mutex<Option<std::collections::HashMap<String, bool>>> = std::sync::Mutex::new(None);

/// 各文档库最近一次成功完成全量扫描（含文件监听触发的自动重扫）的时间。
static LAST_FULL_SCAN: std::sync::Mutex<Option<std::collections::HashMap<String, Instant>>> = std::sync::Mutex::new(None);

/// 登记一次扫描请求：返回 true 表示应立即开始扫描；false 表示该库已在扫描中（已标记结束后补跑）。
fn scan_run_begin(library_id: &str) -> bool {
    let mut g = SCAN_RUNS.lock_safe();
    let runs = g.get_or_insert_with(std::collections::HashMap::new);
    match runs.get_mut(library_id) {
        Some(again) => {
            *again = true;
            false
        }
        None => {
            runs.insert(library_id.to_string(), false);
            true
        }
    }
}

/// 一轮扫描结束：返回 true 表示期间又有请求、需要再扫一轮；false 表示该库扫描结束（已注销）。
fn scan_run_end(library_id: &str) -> bool {
    let mut g = SCAN_RUNS.lock_safe();
    let runs = g.get_or_insert_with(std::collections::HashMap::new);
    match runs.get_mut(library_id) {
        Some(again) if *again => {
            *again = false;
            true
        }
        _ => {
            runs.remove(library_id);
            false
        }
    }
}

/// 记录某库完成了一次成功的全量扫描。
pub fn mark_full_scan(library_id: &str) {
    LAST_FULL_SCAN
        .lock_safe()
        .get_or_insert_with(std::collections::HashMap::new)
        .insert(library_id.to_string(), Instant::now());
}

/// 某库最近一次成功全量扫描的时间（本次运行期间）。
pub fn last_full_scan(library_id: &str) -> Option<Instant> {
    LAST_FULL_SCAN.lock_safe().as_ref().and_then(|m| m.get(library_id).copied())
}

/// 完整扫描（后台线程版，纳入任务中心）：扫描 → 提取 → 重建索引，
/// 全程通过 `tasks:updated` 上报进度，结束后发送 `scan:completed` / `scan:failed` / `scan:canceled`。
/// 同一文档库的并发请求会被合并（见 SCAN_RUNS）。
pub fn spawn_full_scan(
    app: AppHandle,
    state: AppState,
    tasks: crate::tasks::TaskManager,
    library_id: String,
    library_name: String,
    root: PathBuf,
    exclude: Vec<String>,
) {
    if !scan_run_begin(&library_id) {
        return; // 该库正在扫描：结束后会自动补跑一轮
    }
    std::thread::spawn(move || loop {
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
                mark_full_scan(&library_id);
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
        if !scan_run_end(&library_id) {
            break;
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
    // 不透出底层数据库错误原文（如 "Query returned no rows"），统一给出用户可理解的原因与下一步动作
    .map_err(|_| "文件不存在于文档库索引，请刷新文档库后重试".to_string())
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
                "SELECT f.*, snippet(search_fts, 1, '【', '】', '…', 16) AS snip
                 FROM search_fts JOIN files f ON f.id = search_fts.rowid
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

    #[test]
    fn office_lock_and_system_files_are_temp() {
        for n in ["~$蓝图设计阶段交付物.xlsx", "~$报告.docx", "~WRL0005.tmp", "Thumbs.db", "desktop.ini", "DESKTOP.INI"] {
            assert!(is_system_temp_file(n), "{n}");
        }
        for n in ["报告.docx", "~备注.md", "data.tmp", "thumbs.db.md", "蓝图~$.xlsx"] {
            assert!(!is_system_temp_file(n), "{n}");
        }
    }

    fn write_docx(path: &Path, body: &str) {
        use std::io::Write;
        let f = std::fs::File::create(path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        let opt = zip::write::SimpleFileOptions::default();
        z.start_file("[Content_Types].xml", opt).unwrap();
        z.write_all(br#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#).unwrap();
        z.start_file("word/document.xml", opt).unwrap();
        let xml = format!(r#"<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{body}</w:t></w:r></w:p></w:body></w:document>"#);
        z.write_all(xml.as_bytes()).unwrap();
        z.finish().unwrap();
    }

    /// Office 正文应进入全文索引：此前扫描只提取文本类格式，Word / Excel / PPT 内容搜不到
    #[test]
    fn office_body_text_is_indexed_and_backfilled_for_existing_rows() {
        let dir = tempfile::tempdir().unwrap();
        write_docx(&dir.path().join("方案.docx"), "域控制器迁移与站点复制拓扑");
        let conn = memory_db();
        let meta = create_library(&conn, CreateLibraryRequest {
            root_path: dir.path().to_string_lossy().into(),
            name: Some("Office 索引".into()),
            exclude_dirs: vec![],
            full_text_index: true,
            ocr_enabled: false,
            portable_meta: false,
        }).unwrap();
        scan_library_with(&conn, &meta.id, dir.path(), &[], ScanOptions::default()).unwrap();
        let hits = search_library(&conn, &meta.id, "域控制器", 10).unwrap();
        assert!(hits.iter().any(|h| h.entry.name == "方案.docx"), "Word 正文应可被搜索命中");

        // 模拟旧版本留下的库：文件行在、但没有提取记录（旧扫描不提取 Office）；文件本身未变化
        conn.execute("DELETE FROM search_fts", []).unwrap();
        conn.execute("DELETE FROM extracted_content", []).unwrap();
        assert!(search_library(&conn, &meta.id, "域控制器", 10).unwrap().iter().all(|h| h.entry.name != "方案.docx"));
        scan_library_with(&conn, &meta.id, dir.path(), &[], ScanOptions::default()).unwrap();
        let hits = search_library(&conn, &meta.id, "站点复制", 10).unwrap();
        assert!(hits.iter().any(|h| h.entry.name == "方案.docx"), "未提取过的 Office 文件应在下次扫描时补提");

        // 已有提取记录且未变化：再次扫描不重复提取（提取记录保持不变）
        let before: String = conn.query_row("SELECT extractor_version || status FROM extracted_content", [], |r| r.get(0)).unwrap();
        scan_library_with(&conn, &meta.id, dir.path(), &[], ScanOptions::default()).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM extracted_content", [], |r| r.get(0)).unwrap();
        let after: String = conn.query_row("SELECT extractor_version || status FROM extracted_content", [], |r| r.get(0)).unwrap();
        assert_eq!((n, before), (1, after));
    }

    #[test]
    fn truncate_utf8_respects_char_boundaries() {
        assert_eq!(truncate_utf8("域控制器".to_string(), 7), "域控"); // 每字 3 字节
        assert_eq!(truncate_utf8("abc".to_string(), 10), "abc");
    }

    /// 同一文档库的并发扫描请求被合并：进行中的请求只标记补跑，结束时补跑一轮后才注销
    #[test]
    fn concurrent_scan_requests_are_coalesced_with_one_rerun() {
        let id = "coalesce-test-library";
        assert!(scan_run_begin(id), "首个请求立即扫描");
        assert!(!scan_run_begin(id), "扫描中的请求不并行启动");
        assert!(!scan_run_begin(id), "多个请求合并为一次补跑");
        assert!(scan_run_end(id), "第一轮结束：因期间有请求，再扫一轮");
        assert!(!scan_run_end(id), "补跑结束：无新请求，注销");
        assert!(scan_run_begin(id), "注销后新的请求重新立即扫描");
        assert!(!scan_run_end(id));
    }

    #[test]
    fn last_full_scan_is_recorded_per_library() {
        assert!(last_full_scan("never-scanned-library").is_none());
        let before = Instant::now();
        mark_full_scan("scanned-library");
        assert!(last_full_scan("scanned-library").is_some_and(|t| t >= before));
    }

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
    fn removed_library_readded_keeps_id() {
        let conn = memory_db();
        let (_dir, root) = make_temp_library();
        let req = |name: &str| CreateLibraryRequest {
            root_path: root.to_string_lossy().to_string(),
            name: Some(name.into()),
            exclude_dirs: vec![],
            full_text_index: true,
            ocr_enabled: false,
            portable_meta: false,
        };
        let first = create_library(&conn, req("库A")).unwrap();
        // 库名唯一（不区分大小写）
        let other = tempfile::tempdir().unwrap();
        let dup = create_library(
            &conn,
            CreateLibraryRequest { root_path: other.path().to_string_lossy().to_string(), ..req("库a") },
        );
        assert!(dup.is_err());
        remove_library(&conn, &first.id).unwrap();
        // 重新添加同一文件夹：沿用旧 ID，历史版本 / 批注按 library_id 关联可恢复
        let again = create_library(&conn, req("库A")).unwrap();
        assert_eq!(again.id, first.id);
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

    /// 回归：早期 schema 用 `file_id UNINDEXED` 列，`DELETE ... WHERE file_id = ?` 等价于全表扫描；
    /// 库大到几十万条正文记录时，删除几百个文件（如整个二级子目录被外部删除后重扫）会卡住数十秒甚至
    /// 被系统判定为界面未响应。现在 `file_id` 即 `search_fts` 的 `rowid`（天然索引），删除应保持毫秒级，
    /// 不随索引总量增长而变慢。
    #[test]
    fn deleting_files_stays_fast_regardless_of_total_index_size() {
        let conn = memory_db();
        // 直接灌入一个「空壳」库与十万条正文记录（不经过真实文件 I/O，只验证数据库层面的删除成本）
        conn.execute(
            "INSERT INTO libraries (id, root_path, name, file_count, created_at, last_opened_at, settings_json)
             VALUES ('lib', 'C:/lib', '压力测试', 0, 0, 0, '{}')",
            [],
        )
        .unwrap();
        const TOTAL: i64 = 100_000;
        const TO_DELETE: i64 = 500;
        let tx = conn.unchecked_transaction().unwrap();
        {
            let mut ins_file = tx
                .prepare("INSERT INTO files (id, library_id, relative_path, name, parent_path, is_dir, format, size, mtime) VALUES (?1, 'lib', ?2, ?2, '', 0, 'markdown', 10, 0)")
                .unwrap();
            for i in 0..TOTAL {
                ins_file.execute(params![i, format!("f{i}.md")]).unwrap();
            }
        }
        for i in 0..TOTAL {
            store_extraction(&tx, i, &format!("f{i}.md"), "ok", Some(format!("正文内容 {i} 用于撑大索引占位占位占位")));
        }
        tx.commit().unwrap();
        let total_before: i64 = conn.query_row("SELECT COUNT(*) FROM search_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(total_before, TOTAL);

        let started = Instant::now();
        for i in 0..TO_DELETE {
            clear_extraction(&conn, i).unwrap();
        }
        let elapsed = started.elapsed();
        println!("[Regression] 在 {TOTAL} 条索引中删除 {TO_DELETE} 个文件: {elapsed:?}");
        assert!(
            elapsed.as_millis() < 1000,
            "删除耗时 {elapsed:?}，疑似又回退成了全表扫描（file_id 未走 rowid 索引）"
        );

        let total_after: i64 = conn.query_row("SELECT COUNT(*) FROM search_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(total_after, TOTAL - TO_DELETE);
        // 未删除的记录仍可正常检索
        let hits = search_library(&conn, "lib", "内容 99999", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entry.name, "f99999.md");
    }

    /// 回归：修复前的库文件里，`search_fts` 仍带独立的 `file_id UNINDEXED` 列；打开这样的旧库时
    /// `run_migrations` 必须检测到旧 schema 并按 `extracted_content` 整体重建，重建后 rowid 与
    /// file_id 一致、检索结果不变、不再需要迁移第二次。
    #[test]
    fn old_schema_database_is_migrated_and_search_still_works() {
        let conn = Connection::open_in_memory().unwrap();
        // 手工建出「修复前」的最小 schema + 一条数据，模拟已经在用的旧库文件
        conn.execute_batch(
            "CREATE TABLE libraries (id TEXT PRIMARY KEY, root_path TEXT, name TEXT, file_count INTEGER,
                created_at INTEGER, last_opened_at INTEGER, settings_json TEXT DEFAULT '{}');
             CREATE TABLE files (id INTEGER PRIMARY KEY, library_id TEXT, relative_path TEXT, name TEXT,
                parent_path TEXT, is_dir INTEGER DEFAULT 0, format TEXT, size INTEGER, mtime INTEGER);
             CREATE TABLE extracted_content (file_id INTEGER PRIMARY KEY, extractor_version TEXT, status TEXT, text TEXT);
             CREATE VIRTUAL TABLE search_fts USING fts5(file_id UNINDEXED, name, body, tokenize='trigram');
             INSERT INTO libraries VALUES ('lib', 'C:/lib', '旧库', 1, 0, 0, '{}');
             INSERT INTO files VALUES (1, 'lib', '笔记.md', '笔记.md', '', 0, 'markdown', 10, 0);
             INSERT INTO extracted_content VALUES (1, 'v1', 'ok', '旧版正文关键词迁移验证');
             INSERT INTO search_fts (file_id, name, body) VALUES (1, '笔记.md', '旧版正文关键词迁移验证');",
        )
        .unwrap();

        // 打开时执行的迁移应检测旧 schema 并重建（不是简单地新增表结构）
        run_migrations(&conn).unwrap();

        let sql: String = conn
            .query_row("SELECT sql FROM sqlite_master WHERE name = 'search_fts'", [], |r| r.get(0))
            .unwrap();
        assert!(!sql.contains("file_id"), "迁移后不应再有独立的 file_id 列: {sql}");

        let rowid: i64 = conn.query_row("SELECT rowid FROM search_fts LIMIT 1", [], |r| r.get(0)).unwrap();
        assert_eq!(rowid, 1, "rowid 应等于原 file_id");

        let hits = search_library(&conn, "lib", "迁移验证", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entry.name, "笔记.md");

        // 删除应该走 rowid（新库正常写入路径）
        clear_extraction(&conn, 1).unwrap();
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM search_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);

        // 再跑一次迁移是幂等的（不会因为「表已是新 schema」而出错或重复重建）
        run_migrations(&conn).unwrap();
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

    #[test]
    fn read_pool_is_not_blocked_by_a_long_write_transaction() {
        let dir = tempfile::tempdir().unwrap();
        let state = open_state(&dir.path().join("markflow.db")).unwrap();
        state
            .0
            .lock_safe()
            .execute(
                "INSERT INTO libraries (id, root_path, name, created_at, last_opened_at) VALUES ('L1', 'D:/x', 'x', 1, 1)",
                [],
            )
            .unwrap();

        // 写连接开一个长事务并保持不提交（模拟大库扫描落库）
        let writer = state.0.lock_safe();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        writer
            .execute(
                "INSERT INTO libraries (id, root_path, name, created_at, last_opened_at) VALUES ('L2', 'D:/y', 'y', 1, 1)",
                [],
            )
            .unwrap();

        // 另一线程读取：必须立即返回（不等写事务），且只看到已提交的数据
        let reader_state = state.clone();
        let t0 = Instant::now();
        let count = std::thread::spawn(move || {
            let conn = reader_state.read();
            conn.query_row("SELECT COUNT(*) FROM libraries", [], |r| r.get::<_, i64>(0)).unwrap()
        })
        .join()
        .unwrap();
        assert!(t0.elapsed().as_millis() < 1000, "读取被写事务阻塞了");
        assert_eq!(count, 1, "未提交的写入不应被读到");

        writer.execute_batch("COMMIT").unwrap();
        drop(writer);
        let after: i64 = state.read().query_row("SELECT COUNT(*) FROM libraries", [], |r| r.get(0)).unwrap();
        assert_eq!(after, 2, "提交之后的读必须能看到新数据");
    }

    #[test]
    fn read_pool_connections_reject_writes() {
        let dir = tempfile::tempdir().unwrap();
        let state = open_state(&dir.path().join("markflow.db")).unwrap();
        let err = state
            .read()
            .execute(
                "INSERT INTO libraries (id, root_path, name, created_at, last_opened_at) VALUES ('L9', 'D:/z', 'z', 1, 1)",
                [],
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("readonly"), "只读连接应拒绝写入，实际：{err}");
    }
}


