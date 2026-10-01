//! 打开任意文件（菜单「打开文件」、文件关联双击、拖入）：
//! - 文件位于已有文档库内 → 直接在该库中定位；
//! - 否则进入「单文件模式」：以其所在文件夹建立一个不出现在库列表中的隐式文档库，
//!   仅索引用户明确打开过的文件，复用编辑 / 预览 / 历史 / 批注全部能力，不扫描整个文件夹。

use crate::format::detect_format;
use crate::library::{self, LibraryMeta, TEXT_FORMATS};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 启动参数 / 二次启动传来、前端尚未取走的待打开路径。
#[derive(Default)]
pub struct PendingOpen(pub Mutex<Vec<String>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTarget {
    pub library_id: String,
    pub relative_path: String,
    pub format: String,
    /// 单文件模式（文件不在任何文档库内）
    pub adhoc: bool,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub path: String,
    pub opened_at: i64,
}

const MAX_RECENT_FILES: usize = 15;

/// 规范化为「正斜杠、无 \\?\ 前缀」的绝对路径（保留大小写）。
pub fn normalize(path: &Path) -> String {
    let canon = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let s = canon.to_string_lossy().to_string();
    s.strip_prefix(r"\\?\").unwrap_or(&s).replace('\\', "/")
}

/// 从命令行参数中筛选出存在的文件路径（跳过以 - 开头的选项）。
pub fn paths_from_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .filter(|a| Path::new(a).is_file())
        .collect()
}

fn is_adhoc(meta: &LibraryMeta) -> bool {
    meta.settings.get("adhoc").and_then(|v| v.as_bool()).unwrap_or(false)
}

/// 文件路径相对库根的位置（不在库内返回 None）。
fn relative_in(root: &str, file_norm: &str) -> Option<String> {
    let root_norm = normalize(Path::new(root));
    let root_norm = root_norm.trim_end_matches('/');
    let lower_file = file_norm.to_lowercase();
    let prefix = format!("{}/", root_norm.to_lowercase());
    if lower_file.starts_with(&prefix) {
        Some(file_norm.chars().skip(prefix.chars().count()).collect())
    } else {
        None
    }
}

fn is_hidden_or_excluded(rel: &str, exclude: &[String]) -> bool {
    let comps: Vec<&str> = rel.split('/').collect();
    let dirs = &comps[..comps.len().saturating_sub(1)];
    comps.iter().any(|c| c.starts_with('.'))
        || dirs.iter().any(|d| {
            library::DEFAULT_EXCLUDE_DIRS.iter().any(|x| x.eq_ignore_ascii_case(d))
                || exclude.iter().any(|x| x.eq_ignore_ascii_case(d))
        })
}

/// 解析要打开的文件：优先归属已有文档库，否则单文件模式。
pub fn resolve(conn: &Connection, path: &str) -> Result<OpenTarget, String> {
    let p = Path::new(path);
    if !p.is_file() {
        return Err(format!("文件不存在或不是文件：{path}"));
    }
    let file_norm = normalize(p);
    let file_name = file_norm.rsplit('/').next().unwrap_or(&file_norm).to_string();
    let format = detect_format(&file_name).to_string();

    // 1. 已有（非单文件）文档库中最深的匹配
    let mut best: Option<(usize, LibraryMeta, String)> = None;
    for meta in library::list_libraries(conn)? {
        if let Some(rel) = relative_in(&meta.root_path, &file_norm) {
            if is_hidden_or_excluded(&rel, &library::excludes_from(&meta.settings)) {
                continue;
            }
            let depth = meta.root_path.len();
            if best.as_ref().map(|(d, _, _)| depth > *d).unwrap_or(true) {
                best = Some((depth, meta, rel));
            }
        }
    }
    if let Some((_, meta, rel)) = best {
        ensure_indexed(conn, &meta, &rel)?;
        return Ok(OpenTarget { library_id: meta.id, relative_path: rel, format, adhoc: false });
    }

    // 2. 单文件模式：该文件夹的隐式库
    let parent = p
        .parent()
        .map(|d| d.to_path_buf())
        .ok_or("无法确定文件所在文件夹")?;
    let parent_str = parent.to_string_lossy().to_string();
    let meta = find_or_create_adhoc(conn, &parent_str, &file_name)?;
    ensure_indexed(conn, &meta, &file_name)?;
    Ok(OpenTarget { library_id: meta.id, relative_path: file_name, format, adhoc: true })
}

fn find_or_create_adhoc(conn: &Connection, parent: &str, file_name: &str) -> Result<LibraryMeta, String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM libraries WHERE root_path = ?1 AND json_extract(settings_json, '$.adhoc') = 1",
            [parent],
            |row| row.get(0),
        )
        .ok();
    let id = match existing {
        Some(id) => id,
        None => {
            let conflict: bool = conn
                .query_row("SELECT EXISTS(SELECT 1 FROM libraries WHERE root_path = ?1)", [parent], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if conflict {
                return Err("该文件夹已是文档库，但此文件被其排除规则排除，请调整库的排除规则后再打开。".into());
            }
            let now = library::now_millis();
            let id = uuid::Uuid::new_v4().to_string();
            let name = Path::new(parent)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "单文件".into());
            let settings = json!({ "adhoc": true, "files": [file_name] });
            conn.execute(
                "INSERT INTO libraries (id, root_path, name, file_count, created_at, last_opened_at, settings_json)
                 VALUES (?1, ?2, ?3, 0, ?4, ?4, ?5)",
                params![id, parent, name, now, settings.to_string()],
            )
            .map_err(|e| format!("创建单文件会话失败: {e}"))?;
            id
        }
    };
    register_adhoc_file(conn, &id, file_name)?;
    library::get_library(conn, &id)
}

/// 登记文件名到单文件模式隐式库的白名单（`settings.files`）：只有在此白名单里的文件名，
/// 后台全量重扫才会当作「仍然存在」保留在索引里，否则下一次重扫会把它当成「已消失」删掉
/// （即使刚被 `ensure_indexed` 插入）。转换 / 导入等在单文件模式下新生成副本文件时必须一并登记。
pub fn register_adhoc_file(conn: &Connection, library_id: &str, file_name: &str) -> Result<(), String> {
    let meta = library::get_library(conn, library_id)?;
    let mut files: Vec<String> = meta
        .settings
        .get("files")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if files.iter().any(|f| f.eq_ignore_ascii_case(file_name)) {
        return Ok(());
    }
    files.push(file_name.to_string());
    let mut settings = meta.settings.clone();
    settings["files"] = json!(files);
    conn.execute(
        "UPDATE libraries SET settings_json = ?1 WHERE id = ?2",
        params![settings.to_string(), library_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 确保该文件在库索引中有记录（新建 / 刚被外部程序写入、尚未被监听重扫收录的文件）。
pub fn ensure_indexed(conn: &Connection, meta: &LibraryMeta, rel: &str) -> Result<(), String> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM files WHERE library_id = ?1 AND relative_path = ?2 AND is_dir = 0)",
            params![meta.id, rel],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists {
        return Ok(());
    }
    let path: PathBuf = crate::pathguard::join_in_root(&meta.root_path, rel)?;
    let md = std::fs::metadata(&path).map_err(|e| format!("读取文件状态失败: {e}"))?;
    let name = rel.rsplit('/').next().unwrap_or(rel).to_string();
    let parent = rel.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default();
    let format = detect_format(&name);
    conn.execute(
        "INSERT OR REPLACE INTO files (library_id, relative_path, name, parent_path, is_dir, format, size, mtime)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7)",
        params![meta.id, rel, name, parent, format, md.len() as i64, library::file_mtime(&path)],
    )
    .map_err(|e| format!("登记索引失败: {e}"))?;
    let file_id = conn.last_insert_rowid();
    if TEXT_FORMATS.contains(&format) {
        library::index_file_content(conn, &path, file_id, &name);
    }
    conn.execute(
        "UPDATE libraries SET file_count = (SELECT COUNT(*) FROM files WHERE library_id = ?1 AND is_dir = 0) WHERE id = ?1",
        params![meta.id],
    )
    .ok();
    Ok(())
}

pub fn is_adhoc_library(meta: &LibraryMeta) -> bool {
    is_adhoc(meta)
}

// ---------------------------------------------------------------------------
// 最近打开的文件
// ---------------------------------------------------------------------------

pub fn read_recent(conn: &Connection) -> Vec<RecentFile> {
    conn.query_row("SELECT value FROM settings WHERE key = 'recent_files'", [], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default()
}

pub fn push_recent(conn: &Connection, path: &str) {
    let mut list = read_recent(conn);
    list.retain(|r| !r.path.eq_ignore_ascii_case(path));
    list.insert(0, RecentFile { path: path.to_string(), opened_at: library::now_millis() });
    list.truncate(MAX_RECENT_FILES);
    if let Ok(json) = serde_json::to_string(&list) {
        let _ = conn.execute(
            "INSERT INTO settings (key, value) VALUES ('recent_files', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [json],
        );
    }
}

#[cfg(test)]
mod tests {
    use crate::lockext::LockExt;
    use super::*;
    use crate::library::{create_library, run_migrations, CreateLibraryRequest};

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        conn
    }

    #[test]
    fn file_in_library_resolves_to_that_library() {
        let conn = db();
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("a")).unwrap();
        std::fs::write(dir.path().join("a").join("x.md"), "# x").unwrap();
        let lib = create_library(
            &conn,
            CreateLibraryRequest {
                root_path: dir.path().to_string_lossy().to_string(),
                name: None,
                exclude_dirs: vec![],
                full_text_index: true,
                ocr_enabled: false,
                portable_meta: false,
            },
        )
        .unwrap();
        let target = resolve(&conn, &dir.path().join("a").join("x.md").to_string_lossy()).unwrap();
        assert_eq!(target.library_id, lib.id);
        assert_eq!(target.relative_path, "a/x.md");
        assert!(!target.adhoc);
    }

    #[test]
    fn converted_copy_is_readable_right_after_ensure_indexed() {
        // 回归：Word 转 Markdown 后立刻打开副本，副本尚未被后台重扫收录 → 曾报「文件不存在于文档库索引」
        let conn = db();
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("docs")).unwrap();
        let lib = create_library(
            &conn,
            CreateLibraryRequest {
                root_path: dir.path().to_string_lossy().to_string(),
                name: Some("转换测试".into()),
                exclude_dirs: vec![],
                full_text_index: true,
                ocr_enabled: false,
                portable_meta: false,
            },
        )
        .unwrap();
        std::fs::write(dir.path().join("docs").join("样例.md"), "# 样例
正文").unwrap();
        assert!(crate::editor::read_text_file(&conn, &lib.id, "docs/样例.md").is_err());
        ensure_indexed(&conn, &lib, "docs/样例.md").unwrap();
        let file = crate::editor::read_text_file(&conn, &lib.id, "docs/样例.md").unwrap();
        assert!(file.content.contains("样例"));
    }

    #[test]
    fn outside_file_uses_adhoc_library_and_is_reused() {
        let conn = db();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("note.md"), "# n").unwrap();
        std::fs::write(dir.path().join("other.md"), "# o").unwrap();
        let t1 = resolve(&conn, &dir.path().join("note.md").to_string_lossy()).unwrap();
        assert!(t1.adhoc);
        assert_eq!(t1.relative_path, "note.md");
        let t2 = resolve(&conn, &dir.path().join("other.md").to_string_lossy()).unwrap();
        assert_eq!(t1.library_id, t2.library_id); // 同一文件夹复用同一隐式库
        // 隐式库不出现在库列表
        assert!(library::list_libraries(&conn).unwrap().is_empty());
        // 内容已可编辑读取
        let read = crate::editor::read_text_file(&conn, &t1.library_id, "note.md").unwrap();
        assert!(read.content.contains("# n"));
    }

    /// 回归：单文件模式下生成新文件（如「转换为可编辑文档」的 .md 副本）必须一并登记进
    /// `settings.files` 白名单，否则 `ensure_indexed` 刚插入的索引行会被随后的全量重扫
    /// （只保留白名单内文件，见 `library::scan_library_locked`）当成「已消失」删掉，
    /// 文件明明还在磁盘上却报「文件不存在: Query returned no rows」。
    #[test]
    fn adhoc_new_file_survives_subsequent_rescan_only_when_registered() {
        let state = library::AppState::single(db());
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("方案.docx"), "docx 占位").unwrap();
        let t = {
            let conn = state.0.lock_safe();
            resolve(&conn, &dir.path().join("方案.docx").to_string_lossy()).unwrap()
        };
        assert!(t.adhoc);

        // 模拟转换产物：同目录下多出一个 .md 副本（真实场景由 Pandoc 生成）
        std::fs::write(dir.path().join("方案.md"), "# 方案\n\n正文").unwrap();

        // 反例：不登记白名单，直接插入索引 —— 随后的重扫（走生产用的 scan_library_locked，
        // 会按 settings.files 白名单限制单文件库的扫描范围）会把它当「已消失」删掉
        {
            let conn = state.0.lock_safe();
            let meta = library::get_library(&conn, &t.library_id).unwrap();
            ensure_indexed(&conn, &meta, "方案.md").unwrap();
            assert!(crate::editor::read_text_file(&conn, &t.library_id, "方案.md").is_ok());
        }
        let outcome = library::scan_library_locked(&state, &t.library_id, dir.path(), &[], library::ScanOptions::default()).unwrap();
        assert_eq!(outcome.file_count, 1); // 只有原来登记过的 方案.docx
        {
            let conn = state.0.lock_safe();
            assert!(
                crate::editor::read_text_file(&conn, &t.library_id, "方案.md").is_err(),
                "复现：未登记白名单时，重扫会把刚插入的文件再次删掉"
            );
        }

        // 正例：登记白名单后，重扫应保留该文件（修复后 convert_docx_to_markdown 的实际做法）
        {
            let conn = state.0.lock_safe();
            let meta = library::get_library(&conn, &t.library_id).unwrap();
            register_adhoc_file(&conn, &t.library_id, "方案.md").unwrap();
            ensure_indexed(&conn, &meta, "方案.md").unwrap();
        }
        let outcome = library::scan_library_locked(&state, &t.library_id, dir.path(), &[], library::ScanOptions::default()).unwrap();
        assert_eq!(outcome.file_count, 2); // 方案.docx + 方案.md
        let conn = state.0.lock_safe();
        let read = crate::editor::read_text_file(&conn, &t.library_id, "方案.md").unwrap();
        assert!(read.content.contains("正文"));
    }

    #[test]
    fn recent_files_dedup_and_cap() {
        let conn = db();
        for i in 0..20 {
            push_recent(&conn, &format!("D:/f{i}.md"));
        }
        push_recent(&conn, "D:/F5.md");
        let list = read_recent(&conn);
        assert_eq!(list.len(), MAX_RECENT_FILES);
        assert_eq!(list[0].path, "D:/F5.md");
    }

    #[test]
    fn args_filter() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.md");
        std::fs::write(&f, "x").unwrap();
        let got = paths_from_args(vec!["--flag".into(), f.to_string_lossy().to_string(), "D:/不存在.md".into()]);
        assert_eq!(got.len(), 1);
    }
}
