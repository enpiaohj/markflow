//! Office 文档高保真预览（设计文档 §5.2 L4 / §10.2）：
//! 优先使用本机已安装的 Microsoft Office（Word / Excel / PowerPoint）在后台无界面地导出 PDF，
//! 版式与 Office 中完全一致；没有 Office 时由调用方回退到 LibreOffice，再回退到文本快速预览。
//!
//! 安全与隔离：
//! - 源文件以只读方式打开，结果写入临时文件后再读取，绝不修改源文件；
//! - 强制禁用宏（AutomationSecurity = ForceDisable）；
//! - 脚本内容固定，源 / 目标路径只作为参数传入，不拼接命令行；
//! - 若用户的 Office 应用已在运行，只关闭我们打开的文档，不退出用户的应用，也不改变其可见性；
//! - 带超时与 CREATE_NO_WINDOW，超时即杀死 PowerShell 子进程。

use crate::component_manager::run_with_timeout;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

/// 同一时间只允许一个导出任务（Office 应用实例与用户操作互不抢占）。
static EXPORT_LOCK: Mutex<()> = Mutex::new(());

const EXPORT_TIMEOUT: Duration = Duration::from_secs(120);
/// 缓存上限：文件数与总大小，超出时删除最旧的。
const CACHE_MAX_FILES: usize = 60;
const CACHE_MAX_BYTES: u64 = 400 * 1024 * 1024;

/// 固定的导出脚本（纯 ASCII，路径通过参数传入）。
const EXPORT_SCRIPT: &str = r#"
param([string]$Kind, [string]$In, [string]$Out)
$ErrorActionPreference = 'Stop'
$procName = @{ word = 'WINWORD'; excel = 'EXCEL'; powerpoint = 'POWERPNT' }[$Kind]
$pre = [bool](Get-Process -Name $procName -ErrorAction SilentlyContinue)
$app = $null
try {
  switch ($Kind) {
    'word' {
      $app = New-Object -ComObject Word.Application
      if (-not $pre) { $app.Visible = $false; $app.DisplayAlerts = 0 }
      $app.AutomationSecurity = 3
      $doc = $app.Documents.Open($In, $false, $true, $false)
      try { $doc.ExportAsFixedFormat($Out, 17) } finally { $doc.Close(0) }
    }
    'excel' {
      $app = New-Object -ComObject Excel.Application
      if (-not $pre) { $app.Visible = $false; $app.DisplayAlerts = $false }
      $app.AutomationSecurity = 3
      $wb = $app.Workbooks.Open($In, 0, $true)
      try {
        # 只读工作簿：在内存中把每个工作表设为「按页宽缩放」（不保存，不改源文件），避免宽表格被切成很多碎页
        try { $app.PrintCommunication = $false } catch {}
        foreach ($ws in $wb.Worksheets) {
          try { $ps = $ws.PageSetup; $ps.Zoom = $false; $ps.FitToPagesWide = 1; $ps.FitToPagesTall = $false } catch {}
        }
        try { $app.PrintCommunication = $true } catch {}
        $wb.ExportAsFixedFormat(0, $Out)
      } finally { $wb.Close($false) }
    }
    'powerpoint' {
      $app = New-Object -ComObject PowerPoint.Application
      $app.AutomationSecurity = 3
      $pres = $app.Presentations.Open($In, -1, 0, 0)
      try { $pres.SaveAs($Out, 32) } finally { $pres.Close() }
    }
    default { throw "unsupported kind: $Kind" }
  }
} finally {
  if ($app -ne $null -and -not $pre) { try { $app.Quit() } catch {} }
}
"#;

/// 由格式 id 得到 Office 应用类别与 COM ProgID。
fn kind_of(format: &str) -> Option<(&'static str, &'static str)> {
    match format {
        "word" => Some(("word", "Word.Application")),
        "excel" => Some(("excel", "Excel.Application")),
        "powerpoint" => Some(("powerpoint", "PowerPoint.Application")),
        _ => None,
    }
}

/// 本机是否安装了该格式对应的 Office 应用（只查注册表，不启动任何 Office 程序）。
pub fn office_available(format: &str) -> bool {
    let Some((_, prog_id)) = kind_of(format) else { return false };
    let mut cmd = Command::new("reg");
    cmd.args(["query", &format!("HKCR\\{prog_id}\\CLSID"), "/ve"]);
    run_with_timeout(&mut cmd, Duration::from_secs(5)).is_ok()
}

/// 获取全局导出锁（PDF 与幻灯片导出共用，同一时间只有一个 Office 导出任务）。
pub fn export_lock() -> std::sync::MutexGuard<'static, ()> {
    EXPORT_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// 缓存键：路径 + 修改时间 + 大小；文件变化后自动失效。
pub fn cache_key(src: &Path) -> String {
    let (mtime, size) = std::fs::metadata(src)
        .map(|m| (crate::library::file_mtime(src), m.len()))
        .unwrap_or((0, 0));
    let mut h = Sha256::new();
    h.update(b"v2"); // 导出方式变化（如 Excel 按页宽缩放）时递增，使旧缓存失效
    h.update(src.to_string_lossy().to_lowercase().as_bytes());
    h.update(mtime.to_le_bytes());
    h.update(size.to_le_bytes());
    h.finalize().iter().take(16).map(|b| format!("{b:02x}")).collect()
}

fn prune_cache(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(PathBuf, std::time::SystemTime, u64)> = rd
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            m.is_file().then(|| (e.path(), m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len()))
        })
        .collect();
    files.sort_by_key(|f| f.1); // 最旧在前
    let mut total: u64 = files.iter().map(|f| f.2).sum();
    let mut count = files.len();
    for (path, _, size) in files {
        if count <= CACHE_MAX_FILES && total <= CACHE_MAX_BYTES {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            count -= 1;
            total = total.saturating_sub(size);
        }
    }
}

/// 用本机 Office 把文档导出为 PDF 字节（命中缓存则直接返回）。
pub fn office_pdf_bytes(cache_dir: &Path, src: &Path, format: &str) -> Result<Vec<u8>, String> {
    let (kind, _) = kind_of(format).ok_or("该格式不支持 Office 版式预览")?;
    std::fs::create_dir_all(cache_dir).map_err(|e| format!("创建预览缓存目录失败: {e}"))?;
    let cached = cache_dir.join(format!("{}.pdf", cache_key(src)));
    if cached.is_file() {
        if let Ok(bytes) = std::fs::read(&cached) {
            if bytes.starts_with(b"%PDF") {
                return Ok(bytes);
            }
        }
    }

    // 串行化导出；排队期间同一文件可能已被其他任务导出完成，拿到锁后再查一次缓存
    let _guard = export_lock();
    if let Ok(bytes) = std::fs::read(&cached) {
        if bytes.starts_with(b"%PDF") {
            return Ok(bytes);
        }
    }

    let work = std::env::temp_dir().join(format!("markflow-office-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work).map_err(|e| format!("创建临时目录失败: {e}"))?;
    let script = work.join("export.ps1");
    let out = work.join("out.pdf");
    let result = (|| -> Result<Vec<u8>, String> {
        std::fs::write(&script, EXPORT_SCRIPT).map_err(|e| format!("写入导出脚本失败: {e}"))?;
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .args(["-Kind", kind, "-In"])
            .arg(src)
            .arg("-Out")
            .arg(&out);
        run_with_timeout(&mut cmd, EXPORT_TIMEOUT).map_err(|e| {
            format!("Microsoft Office 导出 PDF 失败（文件可能受密码保护、已损坏，或 Office 正弹出对话框）：{e}")
        })?;
        let bytes = std::fs::read(&out).map_err(|_| "Microsoft Office 未生成 PDF".to_string())?;
        if !bytes.starts_with(b"%PDF") {
            return Err("Microsoft Office 生成的文件不是有效 PDF".into());
        }
        Ok(bytes)
    })();
    let _ = std::fs::remove_dir_all(&work);

    let bytes = result?;
    // 写缓存失败不影响预览
    if std::fs::write(&cached, &bytes).is_ok() {
        prune_cache(cache_dir);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_changes_with_content_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.docx");
        std::fs::write(&f, b"one").unwrap();
        let k1 = cache_key(&f);
        assert_eq!(k1, cache_key(&f));
        std::fs::write(&f, b"longer content").unwrap();
        assert_ne!(k1, cache_key(&f));
    }

    #[test]
    fn unsupported_formats_are_rejected_without_running_anything() {
        assert!(!office_available("markdown"));
        let dir = tempfile::tempdir().unwrap();
        assert!(office_pdf_bytes(dir.path(), &dir.path().join("x.md"), "markdown").is_err());
    }

    #[test]
    fn cache_prune_removes_oldest_beyond_limit() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..(CACHE_MAX_FILES + 5) {
            std::fs::write(dir.path().join(format!("{i}.pdf")), b"%PDF-x").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        prune_cache(dir.path());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), CACHE_MAX_FILES);
    }

    /// 需要本机安装 Word：真实导出一个最小 docx（默认忽略，手动运行 `cargo test word_real -- --ignored`）。
    #[test]
    #[ignore]
    fn word_real_export() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        let dir = tempfile::tempdir().unwrap();
        let docx = dir.path().join("t.docx");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&docx).unwrap());
        for (name, body) in [
            ("[Content_Types].xml", r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#),
            ("_rels/.rels", r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#),
            ("word/document.xml", r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>版式预览测试</w:t></w:r></w:p></w:body></w:document>"#),
        ] {
            zip.start_file(name, SimpleFileOptions::default()).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        assert!(office_available("word"));
        let cache = dir.path().join("cache");
        let bytes = office_pdf_bytes(&cache, &docx, "word").expect("Word 导出失败");
        assert!(bytes.starts_with(b"%PDF"));
        // 第二次应命中缓存
        let again = office_pdf_bytes(&cache, &docx, "word").unwrap();
        assert_eq!(bytes.len(), again.len());
    }
}
