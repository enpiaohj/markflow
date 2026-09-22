//! 文档内图片：把粘贴 / 选择的图片保存为文档所在目录下 `assets/` 里的文件，
//! 返回相对文档目录的路径（写进 Markdown 的 `![](assets/xxx.png)`），并立即登记进索引。

use rusqlite::Connection;
use std::path::{Path, PathBuf};

use crate::library::{self, LibraryMeta};

const ASSETS_DIR: &str = "assets";
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];

fn normalize_ext(ext: &str) -> Result<String, String> {
    let e = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if IMAGE_EXTS.contains(&e.as_str()) {
        Ok(e)
    } else {
        Err(format!("不支持的图片格式「{ext}」，支持：{}", IMAGE_EXTS.join(" / ")))
    }
}

/// 校验库内相对目录：不允许绝对路径、`..`。
fn check_dir(dir: &str) -> Result<(), String> {
    if dir.starts_with('/') || dir.contains('\\') || dir.split('/').any(|s| s == "..") || dir.contains(':') {
        return Err("目录路径无效".into());
    }
    Ok(())
}

/// 取一个 `assets/` 下不重名的文件名（`stem.ext`、`stem-2.ext` …）。
fn unique_name(assets: &Path, stem: &str, ext: &str) -> String {
    let mut name = format!("{stem}.{ext}");
    let mut n = 2;
    while assets.join(&name).exists() {
        name = format!("{stem}-{n}.{ext}");
        n += 1;
    }
    name
}

fn sanitize_stem(stem: &str) -> String {
    let cleaned: String = stem
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else if c == ' ' { '-' } else { '_' })
        .collect();
    let t = cleaned.trim().trim_matches('.').to_string();
    if t.is_empty() { "image".into() } else { t }
}

/// 写入图片字节，返回相对文档目录的路径（如 `assets/image-1.png`）。
pub fn save_image(
    conn: &Connection,
    meta: &LibraryMeta,
    parent_dir: &str,
    stem: &str,
    ext: &str,
    bytes: &[u8],
) -> Result<String, String> {
    check_dir(parent_dir)?;
    let ext = normalize_ext(ext)?;
    if bytes.is_empty() {
        return Err("图片内容为空".into());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!("图片超过大小上限（{} MB）", MAX_IMAGE_BYTES / 1024 / 1024));
    }
    let root = Path::new(&meta.root_path);
    let assets: PathBuf = if parent_dir.is_empty() { root.join(ASSETS_DIR) } else { root.join(parent_dir).join(ASSETS_DIR) };
    std::fs::create_dir_all(&assets).map_err(|e| format!("创建 assets 目录失败: {e}"))?;
    let name = unique_name(&assets, &sanitize_stem(stem), &ext);
    let dest = assets.join(&name);
    std::fs::write(&dest, bytes).map_err(|e| format!("保存图片失败: {e}"))?;
    let rel_in_lib = if parent_dir.is_empty() { format!("{ASSETS_DIR}/{name}") } else { format!("{parent_dir}/{ASSETS_DIR}/{name}") };
    crate::openfile::ensure_indexed(conn, meta, &rel_in_lib)?;
    Ok(format!("{ASSETS_DIR}/{name}"))
}

/// 导入磁盘上的图片文件。
pub fn import_image(conn: &Connection, library_id: &str, parent_dir: &str, src: &str) -> Result<String, String> {
    let meta = library::get_library(conn, library_id)?;
    let src_path = Path::new(src);
    let ext = src_path.extension().and_then(|e| e.to_str()).ok_or("无法识别图片格式")?;
    let stem = src_path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let bytes = std::fs::read(src_path).map_err(|e| format!("读取图片失败: {e}"))?;
    save_image(conn, &meta, parent_dir, stem, ext, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{create_library, run_migrations, CreateLibraryRequest};

    fn lib() -> (Connection, tempfile::TempDir, LibraryMeta) {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("docs")).unwrap();
        let meta = create_library(
            &conn,
            CreateLibraryRequest {
                root_path: dir.path().to_string_lossy().to_string(),
                name: Some("图片测试".into()),
                exclude_dirs: vec![],
                full_text_index: true,
                ocr_enabled: false,
                portable_meta: false,
            },
        )
        .unwrap();
        (conn, dir, meta)
    }

    #[test]
    fn saves_into_assets_next_to_document_and_indexes() {
        let (conn, dir, meta) = lib();
        let rel = save_image(&conn, &meta, "docs", "截图 1", "PNG", &[1, 2, 3]).unwrap();
        assert_eq!(rel, "assets/截图-1.png");
        assert!(dir.path().join("docs/assets/截图-1.png").is_file());
        // 已登记进索引，前端立即可读
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM files WHERE library_id = ?1 AND relative_path = 'docs/assets/截图-1.png'",
                [&meta.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
        // 重名自动加序号
        let again = save_image(&conn, &meta, "docs", "截图 1", "png", &[4]).unwrap();
        assert_eq!(again, "assets/截图-1-2.png");
    }

    #[test]
    fn rejects_bad_input() {
        let (conn, _dir, meta) = lib();
        assert!(save_image(&conn, &meta, "../x", "a", "png", &[1]).is_err());
        assert!(save_image(&conn, &meta, "docs", "a", "exe", &[1]).is_err());
        assert!(save_image(&conn, &meta, "docs", "a", "png", &[]).is_err());
        assert_eq!(sanitize_stem("a/b:c"), "a_b_c");
        assert_eq!(sanitize_stem("..."), "image");
    }
}
