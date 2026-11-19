//! Office 快速解析（设计文档 §5.2 能力分级 L4 快速预览、§8.4 内容提取）：
//! DOCX / XLSX / PPTX 本质是 OOXML（ZIP + XML），此处只做安全文本提取，
//! 用于全文索引与快速预览；不渲染版式、不执行宏、不修改源文件。
//! 高保真预览与格式转换由可选 LibreOffice / Pandoc 组件按路线交付。

use roxmltree::Node;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

/// Office 文件处理大小上限。
pub const MAX_OFFICE_BYTES: u64 = 20 * 1024 * 1024;

/// 单个 ZIP 条目解压后的大小上限（防 ZIP 炸弹）。
const MAX_ENTRY_BYTES: u64 = 32 * 1024 * 1024;

/// 预览表格的行列上限。
const PREVIEW_MAX_ROWS: usize = 200;
const PREVIEW_MAX_COLS: usize = 30;
/// 全文提取的字符上限。
const MAX_TEXT_CHARS: usize = 500_000;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum OfficePreview {
    /// Word：段落流 + 目录（标题）
    Docx { paragraphs: Vec<String>, headings: Vec<Heading> },
    /// Excel：工作表网格
    Xlsx { sheets: Vec<SheetPreview> },
    /// PowerPoint：幻灯片文本
    Pptx { slides: Vec<SlidePreview> },
}

/// 文档目录项（来自标题样式 / 大纲级别）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Heading {
    pub level: u8,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetPreview {
    pub name: String,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlidePreview {
    pub number: usize,
    pub title: String,
    pub texts: Vec<String>,
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/// 解析并返回结构化预览数据。
pub fn preview(path: &Path, format: &str) -> Result<OfficePreview, String> {
    match format {
        "word" => docx_preview(path),
        "excel" => xlsx_preview(path),
        "powerpoint" => pptx_preview(path),
        other => Err(format!("格式 {other} 不是可快速预览的 Office 格式")),
    }
}

/// 提取纯文本（写入 extracted_content 与 FTS）。
pub fn extract_text(path: &Path, format: &str) -> Result<String, String> {
    let text = match preview(path, format)? {
        OfficePreview::Docx { paragraphs, .. } => paragraphs.join("\n"),
        OfficePreview::Xlsx { sheets } => {
            let mut out = String::new();
            for sheet in sheets {
                out.push('【');
                out.push_str(&sheet.name);
                out.push_str("】\n");
                for row in &sheet.rows {
                    out.push_str(&row.join("\t"));
                    out.push('\n');
                }
            }
            out
        }
        OfficePreview::Pptx { slides } => {
            let mut out = String::new();
            for slide in slides {
                out.push_str(&format!("【第 {} 页】{}\n", slide.number, slide.title));
                for t in &slide.texts {
                    out.push_str(t);
                    out.push('\n');
                }
            }
            out
        }
    };
    Ok(text.chars().take(MAX_TEXT_CHARS).collect())
}

// ---------------------------------------------------------------------------
// DOCX：word/document.xml 中的 w:p / w:t
// ---------------------------------------------------------------------------

/// styles.xml：样式 id → 标题级别（按样式名 heading N / 标题 N 识别，兼容中文版 Word 的数字样式 id）。
fn docx_heading_styles(path: &Path) -> HashMap<String, u8> {
    let mut map = HashMap::new();
    let Ok(xml) = read_zip_entry(path, "word/styles.xml") else { return map };
    let Ok(doc) = roxmltree::Document::parse(&xml) else { return map };
    for style in doc.descendants().filter(|n| is_w_tag(*n, "style")) {
        let Some(id) = style.attribute((W_NS, "styleId")) else { continue };
        let name = style
            .children()
            .find(|c| is_w_tag(*c, "name"))
            .and_then(|c| c.attribute((W_NS, "val")))
            .unwrap_or("")
            .to_lowercase();
        let level = name
            .strip_prefix("heading ")
            .or_else(|| name.strip_prefix("标题 "))
            .or_else(|| name.strip_prefix("标题"))
            .and_then(|n| n.trim().parse::<u8>().ok());
        if let Some(l) = level.filter(|l| (1..=9).contains(l)) {
            map.insert(id.to_string(), l);
        }
    }
    map
}

fn docx_preview(path: &Path) -> Result<OfficePreview, String> {
    let xml = read_zip_entry(path, "word/document.xml")?;
    let doc = roxmltree::Document::parse(&xml).map_err(|e| format!("document.xml 解析失败: {e}"))?;
    let heading_styles = docx_heading_styles(path);
    let mut paragraphs = Vec::new();
    let mut headings: Vec<Heading> = Vec::new();
    // 只处理 WordprocessingML 命名空间下的 w:p 段落
    for node in doc.descendants() {
        if !is_w_tag(node, "p") {
            continue;
        }
        let mut text = String::new();
        for child in node.descendants() {
            match node_tag(child) {
                Some("t") => {
                    if let Some(t) = child.text() {
                        text.push_str(t);
                    }
                }
                Some("tab") => text.push('\t'),
                Some("br") => text.push('\n'),
                _ => {}
            }
        }
        if !text.trim().is_empty() {
            // 标题：段落样式命中标题样式，或段落自带大纲级别 w:outlineLvl（0 起）
            let ppr = node.children().find(|c| is_w_tag(*c, "pPr"));
            let by_style = ppr
                .and_then(|p| p.children().find(|c| is_w_tag(*c, "pStyle")))
                .and_then(|s| s.attribute((W_NS, "val")))
                .and_then(|id| heading_styles.get(id).copied());
            let by_outline = ppr
                .and_then(|p| p.children().find(|c| is_w_tag(*c, "outlineLvl")))
                .and_then(|o| o.attribute((W_NS, "val")))
                .and_then(|v| v.parse::<u8>().ok())
                .filter(|l| *l < 9)
                .map(|l| l + 1);
            if let Some(level) = by_style.or(by_outline) {
                if headings.len() < 300 {
                    headings.push(Heading { level, text: text.trim().chars().take(120).collect() });
                }
            }
            paragraphs.push(text);
        }
    }
    Ok(OfficePreview::Docx { paragraphs, headings })
}

// ---------------------------------------------------------------------------
// XLSX：sharedStrings + workbook + sheets
// ---------------------------------------------------------------------------

fn xlsx_preview(path: &Path) -> Result<OfficePreview, String> {
    let shared = read_shared_strings(path)?;

    // workbook.xml → sheet 名称与 r:id
    let workbook_xml = read_entry_string(&mut open_archive(path)?, "xl/workbook.xml")?;
    let doc = roxmltree::Document::parse(&workbook_xml).map_err(|e| format!("workbook.xml 解析失败: {e}"))?;
    let mut sheet_refs: Vec<(String, String)> = Vec::new(); // (name, rid)
    for node in doc.descendants() {
        if is_w_tag(node, "sheet") || node_tag(node) == Some("sheet") {
            if let (Some(name), Some(rid)) = (node.attribute("name"), node.attribute((R_NS, "id"))) {
                sheet_refs.push((name.to_string(), rid.to_string()));
            }
        }
    }

    // rels → rid 到 worksheet 路径
    let rels_xml = read_entry_string(&mut open_archive(path)?, "xl/_rels/workbook.xml.rels")?;
    let rels_doc = roxmltree::Document::parse(&rels_xml).map_err(|e| format!("rels 解析失败: {e}"))?;
    let mut targets: HashMap<String, String> = HashMap::new();
    for node in rels_doc.descendants() {
        if node_tag(node) == Some("Relationship") {
            if let (Some(id), Some(target)) = (node.attribute("Id"), node.attribute("Target")) {
                targets.insert(id.to_string(), target.trim_start_matches('/').to_string());
            }
        }
    }

    let mut sheets = Vec::new();
    for (name, rid) in sheet_refs {
        let target = targets.get(&rid).cloned().unwrap_or_default();
        let entry_path = if target.starts_with("xl/") {
            target
        } else {
            format!("xl/{target}")
        };
        let sheet_xml = match read_entry_string(&mut open_archive(path)?, &entry_path) {
            Ok(x) => x,
            Err(_) => continue,
        };
        sheets.push(parse_sheet(&sheet_xml, &name, &shared)?);
        if sheets.len() >= 8 {
            break; // 预览最多 8 个工作表
        }
    }
    Ok(OfficePreview::Xlsx { sheets })
}

fn parse_sheet(xml: &str, name: &str, shared: &[String]) -> Result<SheetPreview, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("工作表解析失败: {e}"))?;
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut total_rows = 0usize;
    for node in doc.descendants() {
        if node_tag(node) != Some("row") {
            continue;
        }
        total_rows += 1;
        if rows.len() >= PREVIEW_MAX_ROWS {
            continue;
        }
        let mut cells: Vec<(usize, String)> = Vec::new();
        for cell in node.descendants() {
            if node_tag(cell) != Some("c") {
                continue;
            }
            let col = cell
                .attribute("r")
                .map(cell_column_index)
                .unwrap_or(cells.len());
            let cell_type = cell.attribute("t").unwrap_or("n");
            let mut value = String::new();
            for v in cell.descendants() {
                match node_tag(v) {
                    Some("v") => {
                        if let Some(t) = v.text() {
                            value = t.to_string();
                        }
                    }
                    Some("t") if cell_type == "inlineStr" => {
                        if let Some(t) = v.text() {
                            value = t.to_string();
                        }
                    }
                    _ => {}
                }
            }
            if cell_type == "s" {
                if let Ok(idx) = value.parse::<usize>() {
                    if let Some(s) = shared.get(idx) {
                        value = s.clone();
                    }
                }
            }
            cells.push((col, value));
        }
        cells.sort_by_key(|(col, _)| *col);
        let mut row: Vec<String> = Vec::new();
        let mut expect = 0usize;
        for (col, value) in cells {
            while expect < col && expect < PREVIEW_MAX_COLS {
                row.push(String::new());
                expect += 1;
            }
            if expect < PREVIEW_MAX_COLS {
                row.push(value);
                expect += 1;
            }
        }
        if row.iter().any(|v| !v.is_empty()) {
            rows.push(row);
        }
    }
    Ok(SheetPreview { name: name.to_string(), rows, total_rows })
}

fn read_shared_strings(path: &Path) -> Result<Vec<String>, String> {
    let Ok(mut archive) = open_archive(path) else {
        return Ok(Vec::new()); // 无共享字符串表也允许（全 inline）
    };
    let Ok(xml) = read_entry_string(&mut archive, "xl/sharedStrings.xml") else {
        return Ok(Vec::new());
    };
    let doc = roxmltree::Document::parse(&xml).map_err(|e| format!("sharedStrings 解析失败: {e}"))?;
    let mut strings = Vec::new();
    for node in doc.descendants() {
        if node_tag(node) == Some("si") {
            let mut text = String::new();
            for t in node.descendants() {
                if node_tag(t) == Some("t") {
                    if let Some(s) = t.text() {
                        text.push_str(s);
                    }
                }
            }
            strings.push(text);
        }
    }
    Ok(strings)
}

/// "B3" → 列号 1（0-based）
fn cell_column_index(cell_ref: &str) -> usize {
    let mut col = 0usize;
    for ch in cell_ref.chars() {
        if ch.is_ascii_uppercase() {
            col = col * 26 + (ch as usize - 'A' as usize + 1);
        } else {
            break;
        }
    }
    col.saturating_sub(1)
}

// ---------------------------------------------------------------------------
// PPTX：ppt/slides/slideN.xml 中的 a:t
// ---------------------------------------------------------------------------

fn pptx_preview(path: &Path) -> Result<OfficePreview, String> {
    let mut archive = open_archive(path)?;
    let mut slide_names: Vec<(usize, String)> = Vec::new();
    for names in archive.file_names().map(|s| s.to_string()).collect::<Vec<_>>() {
        if let Some(rest) = names.strip_prefix("ppt/slides/slide") {
            if let Some(num_str) = rest.strip_suffix(".xml") {
                if let Ok(num) = num_str.parse::<usize>() {
                    slide_names.push((num, names));
                }
            }
        }
    }
    slide_names.sort_by_key(|(num, _)| *num);

    let mut slides = Vec::new();
    for (idx, (_, name)) in slide_names.iter().enumerate().take(30) {
        let xml = read_entry_string(&mut archive, name)?;
        let doc = roxmltree::Document::parse(&xml).map_err(|e| format!("{name} 解析失败: {e}"))?;
        let mut texts: Vec<String> = Vec::new();
        for node in doc.descendants() {
            if node_tag(node) == Some("t") {
                if let Some(t) = node.text() {
                    let t = t.trim();
                    if !t.is_empty() {
                        texts.push(t.to_string());
                    }
                }
            }
        }
        let title = texts.first().cloned().unwrap_or_default();
        slides.push(SlidePreview { number: idx + 1, title, texts });
    }
    Ok(OfficePreview::Pptx { slides })
}

// ---------------------------------------------------------------------------
// ZIP 与 XML 工具
// ---------------------------------------------------------------------------

const W_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn open_archive(path: &Path) -> Result<zip::ZipArchive<std::fs::File>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读取文件失败: {e}"))?;
    if meta.len() > MAX_OFFICE_BYTES {
        return Err(format!("文件超过处理上限（{:.0} MB）", MAX_OFFICE_BYTES as f64 / 1024.0 / 1024.0));
    }
    let file = std::fs::File::open(path).map_err(|e| format!("打开文件失败: {e}"))?;
    zip::ZipArchive::new(file).map_err(|e| format!("OOXML 包打开失败: {e}"))
}

fn read_zip_entry(path: &Path, name: &str) -> Result<String, String> {
    read_entry_string(&mut open_archive(path)?, name)
}

fn read_entry_string(archive: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Result<String, String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|e| format!("缺少 OOXML 条目 {name}: {e}"))?;
    if entry.size() > MAX_ENTRY_BYTES {
        return Err(format!("条目 {name} 超过大小上限"));
    }
    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取条目 {name} 失败: {e}"))?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}

fn node_tag(node: Node<'_, '_>) -> Option<&'static str> {
    match node.tag_name().name() {
        "p" => Some("p"),
        "t" => Some("t"),
        "tab" => Some("tab"),
        "br" => Some("br"),
        "row" => Some("row"),
        "c" => Some("c"),
        "v" => Some("v"),
        "si" => Some("si"),
        "sheet" => Some("sheet"),
        "Relationship" => Some("Relationship"),
        _ => None,
    }
}

/// 是否为 WordprocessingML 命名空间下的指定标签。
fn is_w_tag(node: Node<'_, '_>, tag: &str) -> bool {
    node.tag_name().name() == tag
        && node
            .tag_name()
            .namespace()
            .map(|ns| ns == W_NS)
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn build_zip(path: &Path, entries: &[(&str, &str)]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for (name, content) in entries {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn docx_extraction_and_preview() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("测试文档.docx");
        build_zip(
            &path,
            &[(
                "word/document.xml",
                r#"<?xml version="1.0" encoding="UTF-8"?>
                <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
                  <w:body>
                    <w:p><w:r><w:t>数据备份与恢复需求说明</w:t></w:r></w:p>
                    <w:p><w:r><w:t>采用增量备份，通过</w:t></w:r><w:r><w:tab/><w:t>负载均衡通道分发。</w:t></w:r></w:p>
                    <w:p><w:r><w:t>   </w:t></w:r></w:p>
                  </w:body>
                </w:document>"#,
            )],
        );
        let text = extract_text(&path, "word").unwrap();
        assert!(text.contains("数据备份与恢复需求说明"));
        assert!(text.contains("负载均衡通道分发"));
        match preview(&path, "word").unwrap() {
            OfficePreview::Docx { paragraphs, .. } => {
                assert_eq!(paragraphs.len(), 2);
                assert!(paragraphs[1].contains('\t'));
            }
            _ => panic!("应为 Docx 预览"),
        }
    }

    #[test]
    fn docx_headings_from_style_names_and_outline_levels() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("目录.docx");
        build_zip(
            &path,
            &[
                (
                    "word/styles.xml",
                    r#"<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
                      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
                      <w:style w:type="paragraph" w:styleId="2"><w:name w:val="标题 2"/></w:style>
                      <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
                    </w:styles>"#,
                ),
                (
                    "word/document.xml",
                    r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
                      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 概述</w:t></w:r></w:p>
                      <w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>正文段落</w:t></w:r></w:p>
                      <w:p><w:pPr><w:pStyle w:val="2"/></w:pPr><w:r><w:t>1.1 背景</w:t></w:r></w:p>
                      <w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>1.1.1 细节</w:t></w:r></w:p>
                    </w:body></w:document>"#,
                ),
            ],
        );
        match preview(&path, "word").unwrap() {
            OfficePreview::Docx { headings, paragraphs } => {
                assert_eq!(paragraphs.len(), 4);
                let got: Vec<(u8, &str)> = headings.iter().map(|h| (h.level, h.text.as_str())).collect();
                assert_eq!(got, vec![(1, "第一章 概述"), (2, "1.1 背景"), (3, "1.1.1 细节")]);
            }
            _ => panic!("应为 Docx 预览"),
        }
    }

    #[test]
    fn xlsx_extraction_with_shared_strings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("资产.xlsx");
        build_zip(
            &path,
            &[
                (
                    "xl/workbook.xml",
                    r#"<?xml version="1.0"?>
                    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
                              xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
                      <sheets><sheet name="服务器资产" sheetId="1" r:id="rId1"/></sheets>
                    </workbook>"#,
                ),
                (
                    "xl/_rels/workbook.xml.rels",
                    r#"<?xml version="1.0"?>
                    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                      <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
                    </Relationships>"#,
                ),
                (
                    "xl/sharedStrings.xml",
                    r#"<?xml version="1.0"?>
                    <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
                      <si><t>主机名</t></si><si><t>slb-01</t></si><si><t>负载均衡</t></si>
                    </sst>"#,
                ),
                (
                    "xl/worksheets/sheet1.xml",
                    r#"<?xml version="1.0"?>
                    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
                      <sheetData>
                        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
                        <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>2</v></c><c r="C2"><v>42</v></c></row>
                      </sheetData>
                    </worksheet>"#,
                ),
            ],
        );
        let text = extract_text(&path, "excel").unwrap();
        assert!(text.contains("服务器资产"));
        assert!(text.contains("负载均衡"));
        match preview(&path, "excel").unwrap() {
            OfficePreview::Xlsx { sheets } => {
                assert_eq!(sheets.len(), 1);
                assert_eq!(sheets[0].name, "服务器资产");
                assert_eq!(sheets[0].rows[0], vec!["主机名", "slb-01"]);
                assert_eq!(sheets[0].rows[1][2], "42"); // 数字单元格，列 C 补位
            }
            _ => panic!("应为 Xlsx 预览"),
        }
    }

    #[test]
    fn pptx_extraction_ordered_slides() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("介绍.pptx");
        build_zip(
            &path,
            &[
                (
                    "ppt/slides/slide1.xml",
                    r#"<?xml version="1.0"?>
                    <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                           xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                      <p:txBody><a:p><a:r><a:t>企业数字化平台项目介绍</a:t></a:r></a:p></p:txBody>
                    </p:sld>"#,
                ),
                (
                    "ppt/slides/slide2.xml",
                    r#"<?xml version="1.0"?>
                    <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                           xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                      <p:txBody><a:p><a:r><a:t>总体架构</a:t></a:r></a:p><a:p><a:r><a:t>负载均衡 + 多可用区</a:t></a:r></a:p></p:txBody>
                    </p:sld>"#,
                ),
            ],
        );
        match preview(&path, "powerpoint").unwrap() {
            OfficePreview::Pptx { slides } => {
                assert_eq!(slides.len(), 2);
                assert_eq!(slides[0].title, "企业数字化平台项目介绍");
                assert_eq!(slides[1].number, 2);
                assert!(slides[1].texts.contains(&"负载均衡 + 多可用区".to_string()));
            }
            _ => panic!("应为 Pptx 预览"),
        }
    }

    #[test]
    fn rejects_oversize_and_non_office() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.docx");
        std::fs::write(&path, b"not a zip").unwrap();
        assert!(preview(&path, "word").is_err());
        assert!(preview(&path, "pdf").is_err());
    }
}
