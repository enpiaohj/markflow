//! 批注（设计文档 §8.8 子集，Markdown/文本类文件）：
//! 引用锚点 = 选中文本（quote）；列表时检测引用是否仍能在文件中定位，
//! 找不到则标记「位置已变」，不静默丢失批注内容。PDF 批注按路线交付。

use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: i64,
    pub relative_path: String,
    pub quote: String,
    pub body: String,
    pub resolved: bool,
    pub created_at: i64,
    /// 引用文本当前是否仍存在于文件中（内容变化后为 false）
    pub quote_present: Option<bool>,
}

pub fn add(conn: &Connection, library_id: &str, relative_path: &str, quote: &str, body: &str) -> Result<Annotation, String> {
    if quote.trim().is_empty() {
        return Err("批注需要引用一段文本（请先在编辑器中选中内容）".into());
    }
    if body.trim().is_empty() {
        return Err("批注内容不能为空".into());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO annotations (library_id, relative_path, quote, body, resolved, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5)",
        params![library_id, relative_path, quote, body, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(Annotation {
        id: conn.last_insert_rowid(),
        relative_path: relative_path.to_string(),
        quote: quote.to_string(),
        body: body.to_string(),
        resolved: false,
        created_at: now,
        quote_present: Some(true),
    })
}

/// 列出某文件的批注（新→旧），并检测引用锚点是否仍可定位。
pub fn list_for_file(conn: &Connection, library_id: &str, relative_path: &str) -> Result<Vec<Annotation>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, relative_path, quote, body, resolved, created_at
             FROM annotations WHERE library_id = ?1 AND relative_path = ?2
             ORDER BY created_at DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;
    let mut annotations: Vec<Annotation> = stmt
        .query_map(params![library_id, relative_path], |row| {
            Ok(Annotation {
                id: row.get(0)?,
                relative_path: row.get(1)?,
                quote: row.get(2)?,
                body: row.get(3)?,
                resolved: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
                quote_present: None,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    // 引用重定位：当前文件文本是否仍包含引用（空白归一化比较）
    if let Ok(path) = library_file(conn, library_id, relative_path) {
        if let Ok(content) = std::fs::read_to_string(path) {
            let normalize = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
            let haystack = normalize(&content);
            for a in &mut annotations {
                let needle = normalize(&a.quote);
                a.quote_present = Some(!needle.is_empty() && haystack.contains(&needle));
            }
        }
    }
    Ok(annotations)
}

pub fn set_resolved(conn: &Connection, id: i64, resolved: bool) -> Result<(), String> {
    conn.execute(
        "UPDATE annotations SET resolved = ?1 WHERE id = ?2",
        params![resolved as i64, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM annotations WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn library_file(conn: &Connection, library_id: &str, relative_path: &str) -> Result<PathBuf, String> {
    let root = crate::library::get_library(conn, library_id)?.root_path;
    crate::pathguard::join_in_root(&root, relative_path)
}

use std::path::PathBuf;
