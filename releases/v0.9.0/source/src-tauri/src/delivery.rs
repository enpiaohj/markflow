//! 正式交付中心（设计文档 §8.12、§8.9 交付门禁）：
//! 来源冻结（哈希）→ 质量门禁预检（错误阻止交付）→ 多格式生成（临时目录）
//! → 产物验证 → 原子落盘 → 交付记录与历史。
//! 格式管线：MD 原文复制；HTML/DOCX 经 Pandoc；PDF 经 Pandoc→HTML→Edge 打印；
//! ZIP 打包全部产物与交付清单。

use crate::component_manager::{self, run_with_timeout};
use crate::checks;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 单文件交付大小上限。
const MAX_SOURCE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFile {
    pub relative_path: String,
    pub sha256: String,
    pub size: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrecheckIssue {
    pub relative_path: String,
    pub severity: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrecheckReport {
    pub can_proceed: bool,
    pub files: Vec<SourceFile>,
    pub issues: Vec<PrecheckIssue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryRecord {
    pub id: String,
    pub library_id: String,
    pub sources: Vec<SourceFile>,
    pub formats: Vec<String>,
    pub target_dir: String,
    pub output_dir: Option<String>,
    /// "running" | "completed" | "failed"
    pub status: String,
    pub error: Option<String>,
    /// 产物文件名列表
    pub outputs: Vec<String>,
    pub created_at: i64,
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取失败: {e}"))?;
    let digest = Sha256::digest(&bytes);
    Ok(hex(&digest))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// 预检（§8.9 交付门禁：错误可阻止正式交付）
// ---------------------------------------------------------------------------

pub fn precheck(root: &Path, sources: &[String]) -> Result<PrecheckReport, String> {
    let mut files = Vec::new();
    let mut issues = Vec::new();

    for rel in sources {
        let path = root.join(rel);
        if !path.is_file() {
            issues.push(PrecheckIssue {
                relative_path: rel.clone(),
                severity: "error".into(),
                code: "missing".into(),
                message: "来源文件不存在".into(),
            });
            continue;
        }
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > MAX_SOURCE_BYTES {
            issues.push(PrecheckIssue {
                relative_path: rel.clone(),
                severity: "error".into(),
                code: "too_large".into(),
                message: format!("超过单文件交付上限（{:.0} MB）", MAX_SOURCE_BYTES as f64 / 1024.0 / 1024.0),
            });
            continue;
        }
        files.push(SourceFile {
            relative_path: rel.clone(),
            sha256: sha256_file(&path)?,
            size: meta.len() as i64,
        });

        let format = crate::format::detect_format(rel.rsplit('/').next().unwrap_or(rel));
        if format == "markdown" {
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            let document_dir = path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| root.to_path_buf());
            let resolver = checks::link_resolver(root, &document_dir);
            for issue in checks::check_markdown(&content, &resolver) {
                if issue.severity == checks::Severity::Info {
                    continue;
                }
                issues.push(PrecheckIssue {
                    relative_path: rel.clone(),
                    severity: format!("{:?}", issue.severity).to_lowercase(),
                    code: issue.code,
                    message: issue.message,
                });
            }
        } else if let Ok(text) = crate::office::extract_text(&path, format) {
            for hit in crate::sensitive::scan(&text) {
                issues.push(PrecheckIssue {
                    relative_path: rel.clone(),
                    severity: "error".into(),
                    code: format!("sensitive_{}", hit.kind),
                    message: format!("疑似敏感信息（{}）: {}", hit.label, hit.masked),
                });
            }
        }
    }

    let can_proceed = !issues.iter().any(|i| i.severity == "error") && !files.is_empty();
    Ok(PrecheckReport { can_proceed, files, issues })
}

// ---------------------------------------------------------------------------
// 执行交付
// ---------------------------------------------------------------------------

pub struct DeliveryOutcome {
    pub output_dir: PathBuf,
    pub outputs: Vec<String>,
}

/// 执行交付：临时目录生成 → 验证 → 原子改名落盘。返回最终输出目录与产物清单。
pub fn execute(
    root: &Path,
    report: &PrecheckReport,
    formats: &[String],
    target_dir: &Path,
) -> Result<DeliveryOutcome, String> {
    if !report.can_proceed {
        return Err("预检存在错误项，已按交付门禁阻止交付".into());
    }
    let pandoc = if formats.iter().any(|f| f == "html" || f == "docx" || f == "pdf") {
        Some(
            component_manager::detect_pandoc()
                .ok_or("未检测到 Pandoc 组件，无法生成 HTML/DOCX/PDF；可仅交付 Markdown 或 ZIP")?,
        )
    } else {
        None
    };
    let edge = if formats.iter().any(|f| f == "pdf") {
        Some(component_manager::detect_edge().ok_or("未检测到 Microsoft Edge，无法生成 PDF（HTML/CSS 打印管线）")?)
    } else {
        None
    };

    // 目标子目录：交付-YYYYMMDD-HHMMSS；临时目录同卷保证原子改名
    let stamp = chrono_stamp();
    let final_dir = target_dir.join(format!("交付-{stamp}"));
    let tmp_dir = target_dir.join(format!(".tmp-delivery-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建临时目录失败: {e}"))?;

    let result = generate_all(root, report, formats, &tmp_dir, pandoc.as_deref(), edge.as_deref());
    match result {
        Ok(outputs) => {
            // 产物验证：清单文件与格式产物均存在且非空
            for name in &outputs {
                let p = tmp_dir.join(name);
                let ok = p.is_file() && std::fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false);
                if !ok {
                    let _ = std::fs::remove_dir_all(&tmp_dir);
                    return Err(format!("产物验证失败：{name} 缺失或为空"));
                }
            }
            std::fs::rename(&tmp_dir, &final_dir).map_err(|e| {
                let _ = std::fs::remove_dir_all(&tmp_dir);
                format!("落盘失败: {e}")
            })?;
            Ok(DeliveryOutcome {
                output_dir: final_dir,
                outputs,
            })
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            Err(e)
        }
    }
}

fn generate_all(
    root: &Path,
    report: &PrecheckReport,
    formats: &[String],
    tmp_dir: &Path,
    pandoc: Option<&Path>,
    edge: Option<&Path>,
) -> Result<Vec<String>, String> {
    let mut outputs = Vec::new();

    // 1. Markdown 原文复制（冲突时加前缀目录）
    for src in &report.files {
        let src_path = root.join(&src.relative_path);
        let name = src.relative_path.rsplit('/').next().unwrap_or(&src.relative_path).to_string();
        let mut dest = tmp_dir.join(&name);
        let mut n = 1;
        while dest.exists() {
            dest = tmp_dir.join(format!("{n}-{name}"));
            n += 1;
        }
        std::fs::copy(&src_path, &dest).map_err(|e| format!("复制 {name} 失败: {e}"))?;
    }
    outputs.push(format!("Markdown 原文 × {}", report.files.len()));

    // 2. Pandoc 管线：合并转换为 HTML / DOCX；HTML 再经 Edge 打印为 PDF
    let html_for_pdf = tmp_dir.join("交付文档.html");
    let mut html_built = false;
    if formats.iter().any(|f| f == "html" || f == "pdf") {
        build_pandoc_command(pandoc.expect("pandoc"), root, report, true, "html", &html_for_pdf)?;
        verify_nonempty(&html_for_pdf)?;
        outputs.push("交付文档.html".to_string());
        html_built = true;
    }
    if formats.iter().any(|f| f == "docx") {
        let docx_path = tmp_dir.join("交付文档.docx");
        build_pandoc_command(pandoc.expect("pandoc"), root, report, false, "docx", &docx_path)?;
        verify_zip(&docx_path)?;
        outputs.push("交付文档.docx".to_string());
    }
    if formats.iter().any(|f| f == "pdf") {
        let pdf_path = tmp_dir.join("交付文档.pdf");
        let html = if html_built {
            html_for_pdf.clone()
        } else {
            build_pandoc_command(pandoc.expect("pandoc"), root, report, true, "html", &html_for_pdf)?;
            verify_nonempty(&html_for_pdf)?;
            html_for_pdf.clone()
        };
        print_pdf_with_edge(edge.expect("edge"), &html, &pdf_path)?;
        outputs.push("交付文档.pdf".to_string());
    }

    // 3. 交付清单（含来源哈希，冻结来源状态）
    let manifest_name = "交付清单.md";
    let manifest = build_manifest(report, formats, &outputs);
    std::fs::write(tmp_dir.join(manifest_name), manifest).map_err(|e| format!("写入清单失败: {e}"))?;
    outputs.push(manifest_name.to_string());

    // 4. ZIP 打包全部已生成内容
    if formats.iter().any(|f| f == "zip") {
        let zip_name = "交付包.zip";
        let zip_path = tmp_dir.join(zip_name);
        let file = std::fs::File::create(&zip_path).map_err(|e| format!("创建 ZIP 失败: {e}"))?;
        let mut zip = zip::ZipWriter::new(file);
        for rel in std::fs::read_dir(tmp_dir)
            .map_err(|e| e.to_string())?
            .flatten()
        {
            let name = rel.file_name().to_string_lossy().to_string();
            if name.ends_with(".zip") {
                continue;
            }
            if rel.file_type().map(|t| t.is_file()).unwrap_or(false) {
                zip.start_file(&name, zip::write::SimpleFileOptions::default())
                    .map_err(|e| e.to_string())?;
                let bytes = std::fs::read(rel.path()).map_err(|e| e.to_string())?;
                zip.write_all(&bytes).map_err(|e| e.to_string())?;
            }
        }
        zip.finish().map_err(|e| e.to_string())?;
        verify_nonempty(&zip_path)?;
        outputs.push(zip_name.to_string());
    }

    Ok(outputs)
}

/// Pandoc 合并转换：以库根为工作目录（保证相对图片路径成立），来源按预检顺序合并。
/// HTML 输出内联中文样式（供 Edge 打印）。
fn build_pandoc_command(
    pandoc: &Path,
    root: &Path,
    report: &PrecheckReport,
    standalone: bool,
    to: &str,
    out: &Path,
) -> Result<(), String> {
    let mut cmd = std::process::Command::new(pandoc);
    cmd.current_dir(root).args(["-f", "gfm", "-t", to]);
    if standalone {
        cmd.arg("-s")
            .arg("--metadata")
            .arg("title=交付文档")
            .arg("--include-in-header")
            .arg(header_css_file(root)?);
    }
    for src in &report.files {
        cmd.arg(root.join(&src.relative_path));
    }
    cmd.arg("-o").arg(out);
    let result = run_with_timeout(&mut cmd, Duration::from_secs(120))
        .map(|_| ())
        .map_err(|e| format!("Pandoc 生成 {to} 失败: {e}"));
    // 清理临时头文件
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(".markflow-header-") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    result
}

/// 生成临时 CSS 头文件（HTML 内联样式），写入库根（Pandoc 相对引用），用后删除。
fn header_css_file(root: &Path) -> Result<PathBuf, String> {
    let path = root.join(format!(".markflow-header-{}.html", uuid::Uuid::new_v4()));
    let css = "<style>body{font-family:'Microsoft YaHei',sans-serif;margin:40px auto;max-width:800px;line-height:1.9;color:#111;}table{border-collapse:collapse;width:100%;}td,th{border:1px solid #999;padding:4px 10px;}img{max-width:100%;}code{background:#f3f4f6;padding:1px 4px;border-radius:3px;}</style>";
    std::fs::write(&path, css).map_err(|e| e.to_string())?;
    Ok(path)
}

fn print_pdf_with_edge(edge: &Path, html: &Path, pdf_out: &Path) -> Result<(), String> {
    let url = format!("file:///{}", html.to_string_lossy().replace('\\', "/"));
    let mut cmd = std::process::Command::new(edge);
    cmd.args([
        "--headless",
        "--disable-gpu",
        "--no-pdf-header-footer",
        "--virtual-time-budget=10000",
        &format!("--print-to-pdf={}", pdf_out.to_string_lossy()),
        &url,
    ]);
    let out = run_with_timeout(&mut cmd, Duration::from_secs(90)).map_err(|e| format!("Edge 打印 PDF 失败: {e}"));
    let _ = out;
    if pdf_out.is_file() {
        Ok(())
    } else {
        Err("Edge 未生成 PDF".into())
    }
}

fn verify_nonempty(path: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("产物验证失败: {e}"))?;
    if meta.len() == 0 {
        return Err(format!("产物为空: {}", path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()));
    }
    Ok(())
}

fn verify_zip(path: &Path) -> Result<(), String> {
    verify_nonempty(path)?;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    zip::ZipArchive::new(file).map_err(|e| format!("DOCX 验证失败（非有效 OOXML）: {e}"))?;
    Ok(())
}

fn build_manifest(report: &PrecheckReport, formats: &[String], outputs: &[String]) -> String {
    let mut md = String::new();
    md.push_str("# 交付清单\n\n");
    md.push_str(&format!("- 交付时间：{}\n", chrono_stamp()));
    md.push_str(&format!("- 交付格式：{}\n", formats.join(" / ")));
    md.push_str(&format!("- 产物：{}\n\n", outputs.join("、")));
    md.push_str("## 来源清单（SHA-256 冻结）\n\n");
    md.push_str("| 来源文件 | 大小 | SHA-256 |\n|---|---|---|\n");
    for f in &report.files {
        md.push_str(&format!("| {} | {} 字节 | `{}` |\n", f.relative_path, f.size, f.sha256));
    }
    if !report.issues.is_empty() {
        md.push_str("\n## 预检提示（已知情放行）\n\n");
        for i in &report.issues {
            md.push_str(&format!("- [{}] {} {}\n", i.severity, i.relative_path, i.message));
        }
    }
    md
}

fn chrono_stamp() -> String {
    // 无 chrono 依赖：用 UNIX 时间构造本地可读性尚可的时间戳（UTC）
    let secs = now_millis() / 1000;
    let days = secs / 86400;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // 简化的自 1970 起天数 → 日期（ civil_from_days 算法）
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}{month:02}{d:02}-{h:02}{m:02}{s:02}")
}

// ---------------------------------------------------------------------------
// 交付记录持久化
// ---------------------------------------------------------------------------

pub fn insert_record(conn: &Connection, record: &DeliveryRecord) -> Result<(), String> {
    conn.execute(
        "INSERT INTO export_jobs
         (id, library_id, sources_json, formats_json, target_dir, output_dir, status, error, outputs_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            record.id,
            record.library_id,
            serde_json::to_string(&record.sources).map_err(|e| e.to_string())?,
            serde_json::to_string(&record.formats).map_err(|e| e.to_string())?,
            record.target_dir,
            record.output_dir,
            record.status,
            record.error,
            serde_json::to_string(&record.outputs).map_err(|e| e.to_string())?,
            record.created_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn update_record(
    conn: &Connection,
    id: &str,
    status: &str,
    error: Option<&str>,
    output_dir: Option<&str>,
    outputs: &[String],
) -> Result<(), String> {
    conn.execute(
        "UPDATE export_jobs SET status = ?1, error = ?2, output_dir = ?3, outputs_json = ?4 WHERE id = ?5",
        params![
            status,
            error,
            output_dir,
            serde_json::to_string(outputs).map_err(|e| e.to_string())?,
            id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_records(conn: &Connection, library_id: &str, limit: i64) -> Result<Vec<DeliveryRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, library_id, sources_json, formats_json, target_dir, output_dir, status, error, outputs_json, created_at
             FROM export_jobs WHERE library_id = ?1 ORDER BY created_at DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![library_id, limit], |row| {
            let sources_json: String = row.get(2)?;
            let formats_json: String = row.get(3)?;
            let outputs_json: String = row.get(8)?;
            Ok(DeliveryRecord {
                id: row.get(0)?,
                library_id: row.get(1)?,
                sources: serde_json::from_str(&sources_json).unwrap_or_default(),
                formats: serde_json::from_str(&formats_json).unwrap_or_default(),
                target_dir: row.get(4)?,
                output_dir: row.get(5)?,
                status: row.get(6)?,
                error: row.get(7)?,
                outputs: serde_json::from_str(&outputs_json).unwrap_or_default(),
                created_at: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

use rusqlite::{params, Connection};
