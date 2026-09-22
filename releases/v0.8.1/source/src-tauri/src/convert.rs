//! 格式转换（设计文档 §5.3 DOCX 转换编辑闭环、§8.12 交付中心基础、§8.13 导入）：
//! Pandoc sidecar 负责 DOCX/HTML → Markdown；LibreOffice headless 负责 Office → PDF 高保真预览。
//! 原文件永不修改；转换产物以新文件写入文档库，由文件监听纳入索引。

use crate::component_manager::run_with_timeout;
use serde::Serialize;
use std::path::Path;
use std::time::Duration;

/// Pandoc 单次转换超时。
const PANDOC_TIMEOUT: Duration = Duration::from_secs(60);
/// LibreOffice 转换超时（首启较慢）。
const SOFFICE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionPrecheck {
    pub ok: bool,
    /// 阻断项（存在则不能转换）
    pub blocked: Option<String>,
    /// 风险提示（可继续，但需用户知情）
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertResult {
    /// 转换出的 Markdown 文件相对路径
    pub md_relative_path: String,
    /// 附件目录（相对路径；无附件为空串）
    pub media_relative_dir: String,
    pub media_count: usize,
}

// ---------------------------------------------------------------------------
// 转换预检（§5.3：密码保护、修订、批注、宏等风险）
// ---------------------------------------------------------------------------

/// DOCX 转换前检查：加密/损坏直接阻断；宏、修订、批注给出风险提示。
pub fn precheck_docx(path: &Path) -> ConversionPrecheck {
    let mut warnings = Vec::new();

    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) => return blocked(format!("无法读取文件: {e}")),
    };
    if meta.len() > 100 * 1024 * 1024 {
        return blocked("文件超过 100 MB，暂不支持转换".to_string());
    }

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => return blocked(format!("无法打开文件: {e}")),
    };
    let archive = match zip::ZipArchive::new(file) {
        Ok(a) => a,
        Err(_) => return blocked("文件已加密或不是有效的 DOCX（OOXML）文档".to_string()),
    };

    if archive.file_names().any(|n| n.contains("vbaProject.bin")) {
        warnings.push("检测到 VBA 宏。MarkFlow 与 Pandoc 均不会执行宏，宏逻辑不会随副本保留。".into());
    }
    let has_revisions = archive
        .file_names()
        .any(|n| n == "word/document.xml")
        && std::fs::File::open(path)
            .ok()
            .and_then(|f| {
                let mut a = zip::ZipArchive::new(f).ok()?;
                let mut s = String::new();
                use std::io::Read;
                a.by_name("word/document.xml").ok()?.read_to_string(&mut s).ok()?;
                Some(s.contains("<w:ins ") || s.contains("<w:del "))
            })
            .unwrap_or(false);
    if has_revisions {
        warnings.push("检测到修订记录。转换副本为「接受所有修订后」的文本，原文档修订状态保持不变。".into());
    }
    if archive.file_names().any(|n| n.starts_with("word/comments")) {
        warnings.push("检测到批注。批注内容不会写入 Markdown 副本（原文件保持不变）。".into());
    }

    ConversionPrecheck { ok: true, blocked: None, warnings }
}

fn blocked(reason: String) -> ConversionPrecheck {
    ConversionPrecheck { ok: false, blocked: Some(reason), warnings: Vec::new() }
}

// ---------------------------------------------------------------------------
// Pandoc：DOCX / HTML → Markdown
// ---------------------------------------------------------------------------

/// 用 Pandoc 把源文档转换为 Markdown，写入 `dest_dir`（通常是源文件所在目录）。
/// 附件（图片等）输出到 `<stem>.media/`，Markdown 内为相对引用。
/// 调用方负责把进程工作目录切到 dest_dir，保证相对链接成立。
pub fn convert_to_markdown(
    pandoc: &Path,
    src: &Path,
    dest_dir: &Path,
    input_format: &str,
) -> Result<ConvertResult, String> {
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or("源文件路径无效")?;
    let md_name = format!("{stem}.md");
    let media_dir_name = format!("{stem}.media");

    let mut cmd = std::process::Command::new(pandoc);
    cmd.current_dir(dest_dir)
        .args([
            "-f",
            input_format,
            "-t",
            "gfm",
            "--wrap=none",
            &format!("--extract-media={media_dir_name}"),
            "-o",
            &md_name,
        ])
        .arg(src); // 源文件用绝对路径放在最后

    run_with_timeout(&mut cmd, PANDOC_TIMEOUT).map_err(|e| format!("Pandoc 转换失败: {e}"))?;

    let md_path = dest_dir.join(&md_name);
    if !md_path.is_file() {
        return Err("Pandoc 未生成输出文件".into());
    }

    let mut media_count = 0usize;
    let media_abs = dest_dir.join(&media_dir_name);
    if media_abs.is_dir() {
        media_count = count_files_recursive(&media_abs);
    }

    Ok(ConvertResult {
        md_relative_path: md_name,
        media_relative_dir: if media_count > 0 { media_dir_name } else { String::new() },
        media_count,
    })
}

fn count_files_recursive(dir: &Path) -> usize {
    let mut count = 0;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                count += count_files_recursive(&entry.path());
            } else {
                count += 1;
            }
        }
    }
    count
}

// ---------------------------------------------------------------------------
// LibreOffice：Office → PDF（高保真预览）
// ---------------------------------------------------------------------------

/// soffice headless 转 PDF，返回 PDF 字节（临时目录隔离运行，完成后清理）。
pub fn office_to_pdf_bytes(soffice: &Path, src: &Path) -> Result<Vec<u8>, String> {
    let tmp = std::env::temp_dir().join(format!("markflow-convert-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp).map_err(|e| format!("创建临时目录失败: {e}"))?;

    let mut cmd = std::process::Command::new(soffice);
    cmd.args(["--headless", "--norestore", "--invisible"])
        .arg(format!("-env:UserInstallation=file:///{}", tmp.join("profile").to_string_lossy().replace('\\', "/")))
        .args(["--convert-to", "pdf", "--outdir"])
        .arg(&tmp)
        .arg(src);

    let result = run_with_timeout(&mut cmd, SOFFICE_TIMEOUT);
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let pdf_path = tmp.join(format!("{stem}.pdf"));

    let outcome = match result {
        Ok(_) if pdf_path.is_file() => std::fs::read(&pdf_path).map_err(|e| format!("读取转换结果失败: {e}")),
        Ok(_) => Err("LibreOffice 未生成 PDF（文件可能受密码保护或格式不受支持）".into()),
        Err(e) => Err(e),
    };

    let _ = std::fs::remove_dir_all(&tmp); // 临时目录清理（含独立 Profile）
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn build_docx(path: &Path, with_macro: bool) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("[Content_Types].xml", SimpleFileOptions::default()).unwrap();
        zip.write_all(
            r#"<?xml version="1.0" encoding="UTF-8"?>
            <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
              <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
              <Default Extension="xml" ContentType="application/xml"/>
              <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
            </Types>"#.as_bytes(),
        )
        .unwrap();
        zip.start_file("_rels/.rels", SimpleFileOptions::default()).unwrap();
        zip.write_all(
            r#"<?xml version="1.0" encoding="UTF-8"?>
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
              <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
            </Relationships>"#.as_bytes(),
        )
        .unwrap();
        zip.start_file("word/document.xml", SimpleFileOptions::default()).unwrap();
        zip.write_all(
            r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Pandoc 转换测试文档</w:t></w:r></w:p></w:body></w:document>"#.as_bytes(),
        )
        .unwrap();
        if with_macro {
            zip.start_file("word/vbaProject.bin", SimpleFileOptions::default()).unwrap();
            zip.write_all("fake-vba".as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn precheck_reports_macro_and_encrypted() {
        let dir = tempfile::tempdir().unwrap();
        let ok_path = dir.path().join("普通.docx");
        build_docx(&ok_path, false);
        let precheck = precheck_docx(&ok_path);
        assert!(precheck.ok);
        assert!(precheck.warnings.is_empty());

        let macro_path = dir.path().join("宏.docx");
        build_docx(&macro_path, true);
        let precheck = precheck_docx(&macro_path);
        assert!(precheck.ok);
        assert!(precheck.warnings.iter().any(|w| w.contains("宏")));

        let bad_path = dir.path().join("损坏.docx");
        std::fs::write(&bad_path, b"definitely-not-a-zip").unwrap();
        let precheck = precheck_docx(&bad_path);
        assert!(!precheck.ok);
        assert!(precheck.blocked.unwrap().contains("加密"));
    }

    /// 真实转换测试：机器上装有 Pandoc 时运行（本机 3.11 已安装）。
    #[test]
    fn pandoc_docx_to_markdown_real() {
        let Some(pandoc) = crate::component_manager::detect_pandoc() else {
            return; // 未安装 Pandoc 的环境跳过
        };
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("样例.docx");
        build_docx(&src, false);
        let out_dir = dir.path().join("out");
        std::fs::create_dir_all(&out_dir).unwrap();

        let result = convert_to_markdown(&pandoc, &src, &out_dir, "docx").unwrap();
        assert_eq!(result.md_relative_path, "样例.md");
        let md = std::fs::read_to_string(out_dir.join("样例.md")).unwrap();
        assert!(md.contains("Pandoc 转换测试文档"));
    }

    /// LibreOffice 高保真转换：装有 LibreOffice 的环境运行（当前机器未装，自动跳过）。
    #[test]
    fn soffice_office_to_pdf_real() {
        let Some(soffice) = crate::component_manager::detect_soffice() else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("样例.docx");
        build_docx(&src, false);
        let bytes = office_to_pdf_bytes(&soffice, &src).unwrap();
        assert!(bytes.starts_with(b"%PDF"));
    }
}
