//! XLSX 原生表格视图（设计文档 §5.2 L4）：
//! 直接解析 OOXML 得到「像 Excel 一样」的网格——列宽 / 行高、合并单元格、冻结窗格、
//! 字体（粗体 / 斜体 / 颜色 / 字号）、填充色、边框、对齐、数字格式（日期 / 百分比 / 千分位 / 货币）。
//! 公式不重算，直接使用文件里缓存的计算结果；不执行宏，不修改源文件。

use roxmltree::{Document, Node};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

/// 文件大小上限与条目上限沿用 office.rs 的安全边界。
const MAX_FILE_BYTES: u64 = crate::office::MAX_OFFICE_BYTES;
const MAX_ENTRY_BYTES: u64 = 48 * 1024 * 1024;
const MAX_SHEETS: usize = 20;
const MAX_ROWS: usize = 2000;
const MAX_COLS: usize = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxView {
    pub sheets: Vec<XSheet>,
    pub styles: Vec<XStyle>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct XSheet {
    pub name: String,
    pub rows: Vec<XRow>,
    /// 每列宽度（px，长度 = 实际列数）；0 表示隐藏列
    pub col_widths: Vec<f64>,
    /// 合并区域 [首行, 首列, 末行, 末列]（0 起）
    pub merges: Vec<[u32; 4]>,
    pub frozen_rows: u32,
    pub frozen_cols: u32,
    /// 文件里设置的自动筛选范围 [首行, 首列, 末行, 末列]（0 起；首行是表头行）
    pub auto_filter: Option<[u32; 4]>,
    pub show_grid: bool,
    /// 实际列数 / 已读取行数 / 文件中的总行数
    pub col_count: u32,
    pub total_rows: u32,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XRow {
    pub r: u32,
    /// 行高（px），未自定义时为 None
    pub h: Option<f64>,
    pub cells: Vec<XCell>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XCell {
    pub c: u32,
    /// 已按数字格式格式化的显示文本
    pub v: String,
    /// 样式索引（对应 `XlsxView.styles`）
    pub s: u32,
    /// 是否为数值（默认右对齐）
    pub num: bool,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct XStyle {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub color: Option<String>,
    pub bg: Option<String>,
    pub size: Option<f64>,
    /// left / center / right
    pub align: Option<String>,
    /// top / center / bottom
    pub valign: Option<String>,
    pub wrap: bool,
    /// 边框位：上 1、右 2、下 4、左 8
    pub border: u8,
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

pub fn load(path: &Path) -> Result<XlsxView, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读取文件失败: {e}"))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!("文件超过处理上限（{:.0} MB）", MAX_FILE_BYTES as f64 / 1024.0 / 1024.0));
    }
    let file = std::fs::File::open(path).map_err(|e| format!("打开文件失败: {e}"))?;
    // 旧版 .xls 与加密的 Office 文件是 OLE2 复合文档（.xlsx 是 zip 包），提前按魔数识别并给出
    // 可读提示，不让用户看到「缺少 xl/workbook.xml」这类内部结构报错
    let mut magic = [0u8; 8];
    let mut file = file;
    match std::io::Read::read_exact(&mut file, &mut magic) {
        Ok(()) if magic == [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] => {
            return Err(
                "这是旧版 .xls 二进制格式（或已加密的 Office 文件），内置表格视图只支持 .xlsx。\
                 可安装 LibreOffice 或 Microsoft Office 后使用工具栏的「打印版式预览」查看，\
                 或使用系统应用打开，也可以在 Office 中另存为 .xlsx 后再打开。"
                    .to_string(),
            );
        }
        _ => {}
    }
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("OOXML 包打开失败: {e}"))?;

    let theme = read(&mut zip, "xl/theme/theme1.xml").map(|x| parse_theme(&x)).unwrap_or_default();
    let styles_xml = read(&mut zip, "xl/styles.xml").unwrap_or_default();
    let (styles, xf_formats) = parse_styles(&styles_xml, &theme);
    let shared = read(&mut zip, "xl/sharedStrings.xml").map(|x| parse_shared(&x)).unwrap_or_default();

    // OpenDocument（.ods）是 zip 包但结构完全不同（content.xml 而非 xl/），同样给出可读提示
    let workbook = match read(&mut zip, "xl/workbook.xml") {
        Some(x) => x,
        None if read(&mut zip, "content.xml").is_some() => {
            return Err(
                "这是 OpenDocument（.ods）表格格式，内置表格视图只支持 .xlsx。\
                 可安装 LibreOffice 或 Microsoft Office 后使用工具栏的「打印版式预览」查看，\
                 或使用系统应用打开，也可以另存为 .xlsx 后再打开。"
                    .to_string(),
            );
        }
        None => return Err("缺少 xl/workbook.xml".to_string()),
    };
    let wb = Document::parse(&workbook).map_err(|e| format!("workbook.xml 解析失败: {e}"))?;
    let date1904 = wb
        .descendants()
        .find(|n| n.tag_name().name() == "workbookPr")
        .and_then(|n| n.attribute("date1904"))
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);
    let mut refs: Vec<(String, String)> = Vec::new();
    for n in wb.descendants().filter(|n| n.tag_name().name() == "sheet") {
        if matches!(n.attribute("state"), Some("hidden") | Some("veryHidden")) {
            continue;
        }
        if let (Some(name), Some(rid)) = (n.attribute("name"), attr_local(n, "id")) {
            refs.push((name.to_string(), rid.to_string()));
        }
    }
    let rels = read(&mut zip, "xl/_rels/workbook.xml.rels").ok_or("缺少 workbook 关系表")?;
    let rd = Document::parse(&rels).map_err(|e| format!("rels 解析失败: {e}"))?;
    let mut targets: HashMap<String, String> = HashMap::new();
    for n in rd.descendants().filter(|n| n.tag_name().name() == "Relationship") {
        if let (Some(id), Some(t)) = (n.attribute("Id"), n.attribute("Target")) {
            targets.insert(id.to_string(), t.to_string());
        }
    }

    let mut sheets = Vec::new();
    for (name, rid) in refs.into_iter().take(MAX_SHEETS) {
        let Some(target) = targets.get(&rid) else { continue };
        let entry = if let Some(t) = target.strip_prefix('/') { t.to_string() } else { format!("xl/{target}") };
        let Some(xml) = read(&mut zip, &entry) else { continue };
        let table_filter = read_table_auto_filter(&mut zip, &entry);
        sheets.push(parse_sheet(&xml, &name, &shared, &xf_formats, date1904, table_filter)?);
    }
    Ok(XlsxView { sheets, styles })
}

/// 工作表本身没有 `<autoFilter>` 时的兜底：用 Excel「套用表格格式」（表格 / ListObject）插入的表格
/// 会把筛选范围记在 `xl/tables/tableN.xml` 里，而不是工作表根节点上——按工作表的关系文件
/// （`xl/worksheets/_rels/sheetN.xml.rels`）找到引用的表格定义并取其 `autoFilter`（或表格自身 `ref`）。
/// 一个工作表里有多张独立表格时只取第一张（当前只支持单一筛选范围）。
fn read_table_auto_filter(zip: &mut zip::ZipArchive<std::fs::File>, sheet_entry: &str) -> Option<[u32; 4]> {
    let (dir, file) = sheet_entry.rsplit_once('/')?;
    let rels_xml = read(zip, &format!("{dir}/_rels/{file}.rels"))?;
    let rd = Document::parse(&rels_xml).ok()?;
    for rel in rd.descendants().filter(|n| n.tag_name().name() == "Relationship") {
        if !rel.attribute("Type").unwrap_or("").ends_with("/table") {
            continue;
        }
        let Some(target) = rel.attribute("Target") else { continue };
        let table_xml = read(zip, &resolve_relative(dir, target))?;
        let td = Document::parse(&table_xml).ok()?;
        let root = td.root_element();
        let r = root
            .children()
            .find(|n| n.is_element() && n.tag_name().name() == "autoFilter")
            .and_then(|n| n.attribute("ref"))
            .or_else(|| root.attribute("ref"))?;
        let (a, b) = r.split_once(':').unwrap_or((r, r));
        let (r1, c1) = col_index(a);
        let (r2, c2) = col_index(b);
        if (r1 as usize) < MAX_ROWS && (c1 as usize) < MAX_COLS {
            return Some([r1, c1, r2.min(MAX_ROWS as u32 - 1), c2.min(MAX_COLS as u32 - 1)]);
        }
    }
    None
}

/// 按 ZIP 内路径解析相对引用（rels 里的 `Target` 常见为 `../tables/table1.xml` 这类相对路径）。
fn resolve_relative(base_dir: &str, target: &str) -> String {
    if let Some(t) = target.strip_prefix('/') {
        return t.to_string();
    }
    let mut parts: Vec<&str> = base_dir.split('/').collect();
    for seg in target.split('/') {
        match seg {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            _ => parts.push(seg),
        }
    }
    parts.join("/")
}

fn read(zip: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let mut e = zip.by_name(name).ok()?;
    if e.size() > MAX_ENTRY_BYTES {
        return None;
    }
    let mut buf = Vec::with_capacity(e.size() as usize);
    e.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).to_string())
}

/// 取带命名空间前缀的属性（如 r:id）。
fn attr_local<'a>(n: Node<'a, '_>, local: &str) -> Option<&'a str> {
    n.attributes().find(|a| a.name() == local).map(|a| a.value())
}

fn child<'a, 'b>(n: Node<'a, 'b>, name: &str) -> Option<Node<'a, 'b>> {
    n.children().find(|c| c.is_element() && c.tag_name().name() == name)
}

fn on(n: Node<'_, '_>) -> bool {
    !matches!(n.attribute("val"), Some("0") | Some("false"))
}

// ---------------------------------------------------------------------------
// 主题色与颜色解析
// ---------------------------------------------------------------------------

fn parse_theme(xml: &str) -> Vec<String> {
    // 顺序：lt1 dk1 lt2 dk2 accent1-6 hlink folHlink（Excel 主题色索引 0..11）
    let mut map: HashMap<String, String> = HashMap::new();
    if let Ok(doc) = Document::parse(xml) {
        if let Some(scheme) = doc.descendants().find(|n| n.tag_name().name() == "clrScheme") {
            for c in scheme.children().filter(|c| c.is_element()) {
                // <a:sysClr val="windowText" lastClr="000000"/> 或 <a:srgbClr val="1F497D"/>
                let val = c
                    .children()
                    .find(|x| x.is_element())
                    .and_then(|x| x.attribute("lastClr").or_else(|| x.attribute("val")))
                    .unwrap_or("000000");
                map.insert(c.tag_name().name().to_string(), val.to_string());
            }
        }
    }
    ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"]
        .iter()
        .map(|k| map.get(*k).cloned().unwrap_or_else(|| "000000".into()))
        .collect()
}

const INDEXED: [&str; 64] = [
    "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF", "000000", "FFFFFF", "FF0000", "00FF00",
    "0000FF", "FFFF00", "FF00FF", "00FFFF", "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080",
    "9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF", "000080", "FF00FF", "FFFF00", "00FFFF",
    "800080", "800000", "008080", "0000FF", "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99",
    "3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696", "003366", "339966", "003300", "333300",
    "993300", "993366", "333399", "333333",
];

fn tint(hex: &str, t: f64) -> String {
    let p = |i: usize| u8::from_str_radix(hex.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0) as f64;
    let f = |c: f64| -> u8 {
        let v = if t < 0.0 { c * (1.0 + t) } else { c + (255.0 - c) * t };
        v.round().clamp(0.0, 255.0) as u8
    };
    format!("#{:02X}{:02X}{:02X}", f(p(0)), f(p(2)), f(p(4)))
}

/// `<color rgb|theme|indexed|auto tint>` → "#RRGGBB"
fn color_of(n: Node<'_, '_>, theme: &[String]) -> Option<String> {
    let t = n.attribute("tint").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    let base = if let Some(rgb) = n.attribute("rgb") {
        rgb.get(rgb.len().saturating_sub(6)..)?.to_string()
    } else if let Some(i) = n.attribute("theme").and_then(|v| v.parse::<usize>().ok()) {
        theme.get(i)?.clone()
    } else {
        // 无 rgb / theme 时只剩 indexed；auto（无任何属性）返回 None
        let i = n.attribute("indexed").and_then(|v| v.parse::<usize>().ok())?;
        match i {
            64 => "000000".to_string(),
            65 => "FFFFFF".to_string(),
            _ => INDEXED.get(i)?.to_string(),
        }
    };
    Some(if t == 0.0 { format!("#{}", base.to_uppercase()) } else { tint(&base, t) })
}

// ---------------------------------------------------------------------------
// styles.xml
// ---------------------------------------------------------------------------

struct FontInfo {
    bold: bool,
    italic: bool,
    underline: bool,
    color: Option<String>,
    size: Option<f64>,
}

/// 返回（样式表，每个 xf 对应的数字格式代码）。
fn parse_styles(xml: &str, theme: &[String]) -> (Vec<XStyle>, Vec<String>) {
    let Ok(doc) = Document::parse(xml) else { return (vec![XStyle::default()], vec![String::new()]) };

    let mut num_fmts: HashMap<u32, String> = HashMap::new();
    if let Some(nf) = doc.descendants().find(|n| n.tag_name().name() == "numFmts") {
        for f in nf.children().filter(|c| c.tag_name().name() == "numFmt") {
            if let (Some(id), Some(code)) = (f.attribute("numFmtId").and_then(|v| v.parse().ok()), f.attribute("formatCode")) {
                num_fmts.insert(id, code.to_string());
            }
        }
    }

    let fonts: Vec<FontInfo> = doc
        .descendants()
        .find(|n| n.tag_name().name() == "fonts")
        .map(|fs| {
            fs.children()
                .filter(|c| c.is_element() && c.tag_name().name() == "font")
                .map(|f| FontInfo {
                    bold: child(f, "b").map(on).unwrap_or(false),
                    italic: child(f, "i").map(on).unwrap_or(false),
                    underline: child(f, "u").map(|u| u.attribute("val") != Some("none")).unwrap_or(false),
                    color: child(f, "color").and_then(|c| color_of(c, theme)),
                    size: child(f, "sz").and_then(|s| s.attribute("val")).and_then(|v| v.parse().ok()),
                })
                .collect()
        })
        .unwrap_or_default();

    let fills: Vec<Option<String>> = doc
        .descendants()
        .find(|n| n.tag_name().name() == "fills")
        .map(|fs| {
            fs.children()
                .filter(|c| c.is_element() && c.tag_name().name() == "fill")
                .map(|f| {
                    let p = child(f, "patternFill")?;
                    if p.attribute("patternType") != Some("solid") {
                        return None;
                    }
                    color_of(child(p, "fgColor")?, theme)
                })
                .collect()
        })
        .unwrap_or_default();

    let borders: Vec<u8> = doc
        .descendants()
        .find(|n| n.tag_name().name() == "borders")
        .map(|bs| {
            bs.children()
                .filter(|c| c.is_element() && c.tag_name().name() == "border")
                .map(|b| {
                    let has = |name: &str| {
                        child(b, name).and_then(|e| e.attribute("style")).map(|s| !s.is_empty() && s != "none").unwrap_or(false)
                    };
                    (has("top") as u8) | ((has("right") as u8) << 1) | ((has("bottom") as u8) << 2) | ((has("left") as u8) << 3)
                })
                .collect()
        })
        .unwrap_or_default();

    let mut styles = Vec::new();
    let mut formats = Vec::new();
    if let Some(xfs) = doc.descendants().find(|n| n.tag_name().name() == "cellXfs") {
        for xf in xfs.children().filter(|c| c.is_element() && c.tag_name().name() == "xf") {
            let idx = |a: &str| xf.attribute(a).and_then(|v| v.parse::<usize>().ok());
            let font = idx("fontId").and_then(|i| fonts.get(i));
            let align = child(xf, "alignment");
            let fmt_id = idx("numFmtId").unwrap_or(0) as u32;
            formats.push(num_fmts.get(&fmt_id).cloned().unwrap_or_else(|| builtin_format(fmt_id).to_string()));
            styles.push(XStyle {
                bold: font.map(|f| f.bold).unwrap_or(false),
                italic: font.map(|f| f.italic).unwrap_or(false),
                underline: font.map(|f| f.underline).unwrap_or(false),
                color: font.and_then(|f| f.color.clone()).filter(|c| c != "#000000"),
                bg: idx("fillId").and_then(|i| fills.get(i).cloned().flatten()),
                size: font.and_then(|f| f.size),
                align: align.and_then(|a| a.attribute("horizontal")).and_then(|h| match h {
                    "center" | "centerContinuous" => Some("center".to_string()),
                    "right" => Some("right".to_string()),
                    "left" => Some("left".to_string()),
                    _ => None,
                }),
                valign: align.and_then(|a| a.attribute("vertical")).map(|v| match v {
                    "center" => "center".to_string(),
                    "top" => "top".to_string(),
                    _ => "bottom".to_string(),
                }),
                wrap: align.and_then(|a| a.attribute("wrapText")).map(|v| v == "1" || v == "true").unwrap_or(false),
                border: idx("borderId").and_then(|i| borders.get(i).copied()).unwrap_or(0),
            });
        }
    }
    if styles.is_empty() {
        styles.push(XStyle::default());
        formats.push(String::new());
    }
    (styles, formats)
}

fn builtin_format(id: u32) -> &'static str {
    match id {
        1 => "0",
        2 => "0.00",
        3 => "#,##0",
        4 => "#,##0.00",
        9 => "0%",
        10 => "0.00%",
        11 => "0.00E+00",
        14 => "yyyy/m/d",
        15 => "d-mmm-yy",
        16 => "d-mmm",
        17 => "mmm-yy",
        18 => "h:mm AM/PM",
        19 => "h:mm:ss AM/PM",
        20 => "h:mm",
        21 => "h:mm:ss",
        22 => "yyyy/m/d h:mm",
        37 => "#,##0 ;(#,##0)",
        38 => "#,##0 ;(#,##0)",
        39 => "#,##0.00;(#,##0.00)",
        40 => "#,##0.00;(#,##0.00)",
        41 => "#,##0",
        42 => "¥#,##0",
        43 => "#,##0.00",
        44 => "¥#,##0.00",
        45 => "mm:ss",
        46 => "[h]:mm:ss",
        47 => "mm:ss.0",
        49 => "@",
        _ => "General",
    }
}

fn parse_shared(xml: &str) -> Vec<String> {
    let Ok(doc) = Document::parse(xml) else { return Vec::new() };
    let mut out = Vec::new();
    for si in doc.descendants().filter(|n| n.tag_name().name() == "si") {
        let mut text = String::new();
        // 只取 <t> 与 <r><t>，跳过拼音注释 <rPh>
        for c in si.children().filter(|c| c.is_element()) {
            match c.tag_name().name() {
                "t" => text.push_str(c.text().unwrap_or("")),
                "r" => {
                    if let Some(t) = child(c, "t") {
                        text.push_str(t.text().unwrap_or(""));
                    }
                }
                _ => {}
            }
        }
        out.push(text);
    }
    out
}

// ---------------------------------------------------------------------------
// 工作表
// ---------------------------------------------------------------------------

fn col_index(cell_ref: &str) -> (u32, u32) {
    let mut col = 0u32;
    let mut row = 0u32;
    for ch in cell_ref.chars() {
        if ch.is_ascii_alphabetic() {
            col = col * 26 + (ch.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
        } else if let Some(d) = ch.to_digit(10) {
            row = row * 10 + d;
        }
    }
    (row.saturating_sub(1), col.saturating_sub(1))
}

fn parse_sheet(
    xml: &str,
    name: &str,
    shared: &[String],
    xf_formats: &[String],
    date1904: bool,
    table_auto_filter: Option<[u32; 4]>,
) -> Result<XSheet, String> {
    let doc = Document::parse(xml).map_err(|e| format!("工作表 {name} 解析失败: {e}"))?;
    let mut sheet = XSheet { name: name.to_string(), show_grid: true, ..Default::default() };

    if let Some(view) = doc.descendants().find(|n| n.tag_name().name() == "sheetView") {
        sheet.show_grid = view.attribute("showGridLines").map(|v| v != "0" && v != "false").unwrap_or(true);
        if let Some(pane) = child(view, "pane") {
            if pane.attribute("state") == Some("frozen") || pane.attribute("state") == Some("frozenSplit") {
                sheet.frozen_cols = pane.attribute("xSplit").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) as u32;
                sheet.frozen_rows = pane.attribute("ySplit").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) as u32;
            }
        }
    }

    let default_w = doc
        .descendants()
        .find(|n| n.tag_name().name() == "sheetFormatPr")
        .and_then(|n| n.attribute("defaultColWidth"))
        .and_then(|v| v.parse::<f64>().ok())
        .map(|w| w * 7.0 + 5.0)
        .unwrap_or(64.0);

    // 列宽：<col min max width hidden>
    let mut widths: HashMap<u32, f64> = HashMap::new();
    if let Some(cols) = doc.descendants().find(|n| n.tag_name().name() == "cols") {
        for c in cols.children().filter(|c| c.tag_name().name() == "col") {
            let min = c.attribute("min").and_then(|v| v.parse::<u32>().ok()).unwrap_or(1);
            let max = c.attribute("max").and_then(|v| v.parse::<u32>().ok()).unwrap_or(min).min(MAX_COLS as u32);
            let hidden = c.attribute("hidden").map(|v| v == "1" || v == "true").unwrap_or(false);
            let w = c.attribute("width").and_then(|v| v.parse::<f64>().ok()).map(|w| (w * 7.0 + 5.0).round()).unwrap_or(default_w);
            for i in min..=max {
                widths.insert(i - 1, if hidden { 0.0 } else { w });
            }
        }
    }

    if let Some(mc) = doc.descendants().find(|n| n.tag_name().name() == "mergeCells") {
        for m in mc.children().filter(|c| c.tag_name().name() == "mergeCell") {
            if let Some(r) = m.attribute("ref") {
                let (a, b) = r.split_once(':').unwrap_or((r, r));
                let (r1, c1) = col_index(a);
                let (r2, c2) = col_index(b);
                if (r1 as usize) < MAX_ROWS && (c1 as usize) < MAX_COLS {
                    sheet.merges.push([r1, c1, r2.min(MAX_ROWS as u32 - 1), c2.min(MAX_COLS as u32 - 1)]);
                }
            }
        }
    }

    // 自动筛选范围：<autoFilter ref="A2:D30"/>（工作表级）
    if let Some(r) = doc
        .root_element()
        .children()
        .find(|n| n.is_element() && n.tag_name().name() == "autoFilter")
        .and_then(|n| n.attribute("ref"))
    {
        let (a, b) = r.split_once(':').unwrap_or((r, r));
        let (r1, c1) = col_index(a);
        let (r2, c2) = col_index(b);
        if (r1 as usize) < MAX_ROWS && (c1 as usize) < MAX_COLS {
            sheet.auto_filter = Some([r1, c1, r2.min(MAX_ROWS as u32 - 1), c2.min(MAX_COLS as u32 - 1)]);
        }
    }
    // 工作表根节点没有自己的筛选范围时，回退到「套用表格格式」的表格筛选范围（见 read_table_auto_filter）。
    if sheet.auto_filter.is_none() {
        sheet.auto_filter = table_auto_filter;
    }

    let mut max_col = 0u32;
    let mut total_rows = 0u32;
    if let Some(data) = doc.descendants().find(|n| n.tag_name().name() == "sheetData") {
        for row in data.children().filter(|c| c.tag_name().name() == "row") {
            total_rows += 1;
            let r = row.attribute("r").and_then(|v| v.parse::<u32>().ok()).map(|v| v - 1).unwrap_or(total_rows - 1);
            if (r as usize) >= MAX_ROWS {
                sheet.truncated = true;
                continue;
            }
            if row.attribute("hidden").map(|v| v == "1" || v == "true").unwrap_or(false) {
                continue;
            }
            let h = row.attribute("ht").and_then(|v| v.parse::<f64>().ok()).map(|pt| (pt * 96.0 / 72.0).round());
            let mut cells = Vec::new();
            for c in row.children().filter(|c| c.tag_name().name() == "c") {
                let (_, col) = c.attribute("r").map(col_index).unwrap_or((0, cells.len() as u32));
                if (col as usize) >= MAX_COLS {
                    sheet.truncated = true;
                    continue;
                }
                let s = c.attribute("s").and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
                let t = c.attribute("t").unwrap_or("n");
                let raw = child(c, "v").and_then(|v| v.text()).unwrap_or("");
                let (text, num) = match t {
                    "s" => (raw.parse::<usize>().ok().and_then(|i| shared.get(i).cloned()).unwrap_or_default(), false),
                    "inlineStr" => (
                        child(c, "is")
                            .map(|is| is.descendants().filter(|n| n.tag_name().name() == "t").filter_map(|n| n.text()).collect::<String>())
                            .unwrap_or_default(),
                        false,
                    ),
                    "b" => ((if raw == "1" { "TRUE" } else { "FALSE" }).to_string(), false),
                    "str" | "e" | "d" => (raw.to_string(), false),
                    _ => {
                        let code = xf_formats.get(s as usize).map(String::as_str).unwrap_or("");
                        (format_number(raw, code, date1904), raw.parse::<f64>().is_ok())
                    }
                };
                // 无内容且无样式的单元格不必传输
                if text.is_empty() && s == 0 {
                    continue;
                }
                max_col = max_col.max(col + 1);
                cells.push(XCell { c: col, v: text, s, num });
            }
            if !cells.is_empty() || h.is_some() {
                cells.sort_by_key(|c| c.c);
                sheet.rows.push(XRow { r, h, cells });
            }
        }
    }
    for m in &sheet.merges {
        max_col = max_col.max(m[3] + 1);
    }
    sheet.col_count = max_col.min(MAX_COLS as u32);
    sheet.col_widths = (0..sheet.col_count).map(|i| widths.get(&i).copied().unwrap_or(default_w)).collect();
    sheet.total_rows = total_rows;
    Ok(sheet)
}

// ---------------------------------------------------------------------------
// 数字格式
// ---------------------------------------------------------------------------

/// 按 Excel 数字格式代码格式化单元格数值；无法解析为数字时原样返回。
pub fn format_number(raw: &str, code: &str, date1904: bool) -> String {
    let Ok(v) = raw.trim().parse::<f64>() else { return raw.to_string() };
    let code = code.trim();
    if code.is_empty() || code.eq_ignore_ascii_case("general") {
        return general(v);
    }
    if code == "@" {
        return raw.to_string();
    }
    let sections = split_sections(code);
    let (section, neg_handled) = if v < 0.0 && sections.len() >= 2 {
        (sections[1].as_str(), true)
    } else if v == 0.0 && sections.len() >= 3 {
        (sections[2].as_str(), false)
    } else {
        (sections[0].as_str(), false)
    };
    if is_date_format(section) {
        return format_date(v, section, date1904);
    }
    let body = format_numeric(v.abs(), section);
    if v < 0.0 && !neg_handled && !body.is_empty() {
        format!("-{body}")
    } else {
        body
    }
}

fn general(v: f64) -> String {
    if v == v.trunc() && v.abs() < 1e11 {
        return format!("{}", v as i64);
    }
    if v.abs() >= 1e11 || (v != 0.0 && v.abs() < 1e-9) {
        let s = format!("{:.5E}", v);
        // 1.23457E11 → 1.23457E+11
        if let Some((m, e)) = s.split_once('E') {
            let m = m.trim_end_matches('0').trim_end_matches('.');
            let sign = if e.starts_with('-') { "-" } else { "+" };
            return format!("{m}E{sign}{:0>2}", e.trim_start_matches('-'));
        }
        return s;
    }
    let s = format!("{:.10}", v);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn split_sections(code: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut in_quote = false;
    let mut escape = false;
    for ch in code.chars() {
        if escape {
            out.last_mut().unwrap().push(ch);
            escape = false;
            continue;
        }
        match ch {
            '\\' => {
                escape = true;
                out.last_mut().unwrap().push(ch);
            }
            '"' => {
                in_quote = !in_quote;
                out.last_mut().unwrap().push(ch);
            }
            ';' if !in_quote => out.push(String::new()),
            _ => out.last_mut().unwrap().push(ch),
        }
    }
    out
}

/// 是否为日期 / 时间格式：引号与方括号之外出现 y d h s（或 m 与其他日期字符并存 / AM/PM）。
fn is_date_format(section: &str) -> bool {
    let mut in_quote = false;
    let mut in_bracket = false;
    let mut escape = false;
    let mut has_m = false;
    let mut other = false;
    for ch in section.chars() {
        if escape {
            escape = false;
            continue;
        }
        match ch {
            '\\' => escape = true,
            '"' => in_quote = !in_quote,
            '[' if !in_quote => in_bracket = true,
            ']' if !in_quote => in_bracket = false,
            _ if in_quote || in_bracket => {}
            'y' | 'Y' | 'd' | 'D' | 'h' | 'H' | 's' | 'S' => other = true,
            'm' | 'M' => has_m = true,
            _ => {}
        }
    }
    // [h]:mm 这类方括号内的 h 也属于时间
    let elapsed = section.contains("[h") || section.contains("[H") || section.contains("[m") || section.contains("[s");
    other || elapsed || (has_m && !section.contains('0') && !section.contains('#'))
}

/// 数值格式：前缀 / 后缀字面量 + 数字掩码（小数位、千分位、百分号、前导零）。
fn format_numeric(v: f64, section: &str) -> String {
    let mut prefix = String::new();
    let mut suffix = String::new();
    let mut mask = String::new();
    let mut seen_digit = false;
    let mut percent = false;
    let mut in_quote = false;
    let mut chars = section.chars().peekable();
    while let Some(ch) = chars.next() {
        if in_quote {
            if ch == '"' {
                in_quote = false;
            } else {
                (if seen_digit { &mut suffix } else { &mut prefix }).push(ch);
            }
            continue;
        }
        match ch {
            '"' => in_quote = true,
            '\\' => {
                if let Some(n) = chars.next() {
                    (if seen_digit { &mut suffix } else { &mut prefix }).push(n);
                }
            }
            '_' => {
                chars.next();
                (if seen_digit { &mut suffix } else { &mut prefix }).push(' ');
            }
            '*' => {
                chars.next();
            }
            '[' => {
                // [$¥-804] → ¥；[Red] 等颜色 / 条件忽略
                let mut inner = String::new();
                for c in chars.by_ref() {
                    if c == ']' {
                        break;
                    }
                    inner.push(c);
                }
                if let Some(rest) = inner.strip_prefix('$') {
                    let sym = rest.split('-').next().unwrap_or("");
                    (if seen_digit { &mut suffix } else { &mut prefix }).push_str(sym);
                }
            }
            '0' | '#' | '?' => {
                seen_digit = true;
                mask.push(ch);
            }
            '.' | ',' if seen_digit && suffix.is_empty() => mask.push(ch),
            '%' => {
                percent = true;
                suffix.push('%');
            }
            'E' | 'e' if seen_digit && matches!(chars.peek(), Some('+') | Some('-')) => {
                // 科学计数法：简化为通用科学计数
                return format!("{prefix}{}{suffix}", sci(v, &mask));
            }
            _ => (if seen_digit { &mut suffix } else { &mut prefix }).push(ch),
        }
    }
    let v = if percent { v * 100.0 } else { v };
    let (int_mask, frac_mask) = mask.split_once('.').unwrap_or((mask.as_str(), ""));
    let decimals = frac_mask.chars().filter(|c| matches!(c, '0' | '#' | '?')).count();
    let thousands = int_mask.contains(',');
    let min_int = int_mask.chars().filter(|c| *c == '0').count();
    let mut s = format!("{:.*}", decimals, v);
    // '#' 小数位：去掉尾部多余的 0
    let optional = frac_mask.chars().rev().take_while(|c| *c == '#').count();
    for _ in 0..optional {
        if s.ends_with('0') && s.contains('.') {
            s.pop();
        }
    }
    if s.ends_with('.') {
        s.pop();
    }
    let (int_part, frac_part) = s.split_once('.').map(|(a, b)| (a.to_string(), format!(".{b}"))).unwrap_or((s.clone(), String::new()));
    let mut int_part = int_part;
    while int_part.len() < min_int {
        int_part.insert(0, '0');
    }
    if int_part == "0" && min_int == 0 && !frac_part.is_empty() {
        int_part.clear();
    }
    if thousands {
        let digits: Vec<char> = int_part.chars().collect();
        let mut out = String::new();
        for (i, d) in digits.iter().enumerate() {
            if i > 0 && (digits.len() - i).is_multiple_of(3) {
                out.push(',');
            }
            out.push(*d);
        }
        int_part = out;
    }
    format!("{prefix}{int_part}{frac_part}{suffix}")
}

fn sci(v: f64, mask: &str) -> String {
    let decimals = mask.split_once('.').map(|(_, f)| f.chars().filter(|c| matches!(c, '0' | '#')).count()).unwrap_or(2);
    let s = format!("{:.*E}", decimals, v);
    match s.split_once('E') {
        Some((m, e)) => {
            let sign = if e.starts_with('-') { "-" } else { "+" };
            format!("{m}E{sign}{:0>2}", e.trim_start_matches('-'))
        }
        None => s,
    }
}

const MONTHS_LONG: [&str; 12] = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
const WEEK_LONG: [&str; 7] = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const WEEK_SHORT: [&str; 7] = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/// 自 1970-01-01 起的天数 → (年, 月, 日)（Howard Hinnant 的 civil_from_days）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn format_date(serial: f64, section: &str, date1904: bool) -> String {
    let total_secs_all = (serial * 86_400.0).round() as i64;
    let mut days = (serial.floor()) as i64;
    let mut secs_of_day = total_secs_all - days * 86_400;
    if secs_of_day >= 86_400 {
        days += 1;
        secs_of_day -= 86_400;
    }
    // Excel 序列日 → Unix 天：1900 系统里序列 60 是虚构的 1900-02-29，之后整体偏移一天
    let unix_days = if date1904 {
        days - 24_107
    } else if days >= 61 {
        days - 25_569
    } else {
        days - 25_568
    };
    let (y, mo, d) = civil_from_days(unix_days);
    let weekday = (unix_days + 4).rem_euclid(7) as usize; // 1970-01-01 是周四
    let (hh, mi, ss) = ((secs_of_day / 3600) as u32, ((secs_of_day % 3600) / 60) as u32, (secs_of_day % 60) as u32);
    let ampm = section.to_uppercase().contains("AM/PM") || section.to_uppercase().contains("A/P");

    // 分词
    let chars: Vec<char> = section.chars().collect();
    let mut toks: Vec<(char, usize)> = Vec::new(); // (类型字符, 长度)；'"' 表示字面量在 lits 中
    let mut lits: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let lc = c.to_ascii_lowercase();
        match c {
            '"' => {
                let mut lit = String::new();
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    lit.push(chars[i]);
                    i += 1;
                }
                lits.push(lit);
                toks.push(('"', lits.len() - 1));
                i += 1;
            }
            '\\' => {
                if i + 1 < chars.len() {
                    lits.push(chars[i + 1].to_string());
                    toks.push(('"', lits.len() - 1));
                }
                i += 2;
            }
            '[' => {
                let mut inner = String::new();
                i += 1;
                while i < chars.len() && chars[i] != ']' {
                    inner.push(chars[i]);
                    i += 1;
                }
                i += 1;
                let il = inner.to_lowercase();
                if il.starts_with('h') || il.starts_with('m') || il.starts_with('s') {
                    toks.push(('E', il.chars().next().map(|c| c as usize).unwrap_or(0)));
                }
            }
            'y' | 'm' | 'd' | 'h' | 's' | 'Y' | 'M' | 'D' | 'H' | 'S' => {
                let mut n = 1;
                while i + n < chars.len() && chars[i + n].to_ascii_lowercase() == lc {
                    n += 1;
                }
                toks.push((lc, n));
                i += n;
            }
            'A' | 'a' if chars[i..].iter().collect::<String>().to_uppercase().starts_with("AM/PM") => {
                toks.push(('P', 5));
                i += 5;
            }
            'A' | 'a' if chars[i..].iter().collect::<String>().to_uppercase().starts_with("A/P") => {
                toks.push(('P', 3));
                i += 3;
            }
            '_' => {
                i += 2;
                lits.push(" ".into());
                toks.push(('"', lits.len() - 1));
            }
            '*' => i += 2,
            '.' if i + 1 < chars.len() && chars[i + 1] == '0' && toks.last().map(|t| t.0) == Some('s') => {
                i += 1;
                while i < chars.len() && chars[i] == '0' {
                    i += 1;
                }
            }
            _ => {
                lits.push(c.to_string());
                toks.push(('"', lits.len() - 1));
                i += 1;
            }
        }
    }

    let mut out = String::new();
    for (idx, (t, n)) in toks.iter().enumerate() {
        match t {
            '"' => out.push_str(&lits[*n]),
            'y' => out.push_str(&if *n <= 2 { format!("{:02}", y.rem_euclid(100)) } else { format!("{y:04}") }),
            'd' => match n {
                1 => out.push_str(&d.to_string()),
                2 => out.push_str(&format!("{d:02}")),
                3 => out.push_str(WEEK_SHORT[weekday]),
                _ => out.push_str(WEEK_LONG[weekday]),
            },
            'm' => {
                // 紧跟在 h 之后或紧接着 s 之前，表示「分」而非「月」
                let prev = toks[..idx].iter().rev().find(|t| t.0 != '"').map(|t| t.0);
                let next = toks[idx + 1..].iter().find(|t| t.0 != '"').map(|t| t.0);
                if prev == Some('h') || prev == Some('E') || next == Some('s') {
                    out.push_str(&if *n >= 2 { format!("{mi:02}") } else { mi.to_string() });
                } else {
                    match n {
                        1 => out.push_str(&mo.to_string()),
                        2 => out.push_str(&format!("{mo:02}")),
                        3 => out.push_str(&format!("{mo}月")),
                        _ => out.push_str(MONTHS_LONG[(mo - 1) as usize]),
                    }
                }
            }
            'h' => {
                let h = if ampm { if hh % 12 == 0 { 12 } else { hh % 12 } } else { hh };
                out.push_str(&if *n >= 2 { format!("{h:02}") } else { h.to_string() });
            }
            's' => out.push_str(&if *n >= 2 { format!("{ss:02}") } else { ss.to_string() }),
            'P' => out.push_str(if hh < 12 { "AM" } else { "PM" }),
            'E' => {
                // 累计小时 / 分 / 秒
                let total = total_secs_all;
                match char::from_u32(*n as u32) {
                    Some('h') => out.push_str(&(total / 3600).to_string()),
                    Some('m') => out.push_str(&(total / 60).to_string()),
                    _ => out.push_str(&total.to_string()),
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    #[test]
    fn numbers_percent_thousands_currency() {
        assert_eq!(format_number("1234567.891", "#,##0.00", false), "1,234,567.89");
        assert_eq!(format_number("0.256", "0.0%", false), "25.6%");
        assert_eq!(format_number("1234.5", "\"¥\"#,##0.00", false), "¥1,234.50");
        assert_eq!(format_number("1234.5", "[$¥-804]#,##0.00", false), "¥1,234.50");
        assert_eq!(format_number("-5", "#,##0", false), "-5");
        assert_eq!(format_number("-5", "#,##0;(#,##0)", false), "(5)");
        assert_eq!(format_number("7", "000", false), "007");
        assert_eq!(format_number("3.14159", "0.00", false), "3.14");
        assert_eq!(format_number("0.1", "General", false), "0.1");
        assert_eq!(format_number("42", "", false), "42");
        assert_eq!(format_number("0.30000000000000004", "", false), "0.3");
    }

    #[test]
    fn dates_and_times() {
        // 45000 = 2023-03-15
        assert_eq!(format_number("45000", "yyyy/m/d", false), "2023/3/15");
        assert_eq!(format_number("45000", "yyyy-mm-dd", false), "2023-03-15");
        assert_eq!(format_number("45000.5", "yyyy/m/d h:mm", false), "2023/3/15 12:00");
        assert_eq!(format_number("45000.75", "h:mm AM/PM", false), "6:00 PM");
        assert_eq!(format_number("45000", "yyyy\"年\"m\"月\"d\"日\"", false), "2023年3月15日");
        assert_eq!(format_number("1", "yyyy/m/d", false), "1900/1/1");
        assert_eq!(format_number("61", "yyyy/m/d", false), "1900/3/1");
        assert_eq!(format_number("0.5", "[h]:mm:ss", false), "12:00:00");
        assert_eq!(format_number("45000", "dddd", false), "星期三");
    }

    #[test]
    fn color_resolution_theme_indexed_tint() {
        let theme: Vec<String> = ["FFFFFF", "000000", "EEECE1", "1F497D", "4F81BD", "C0504D", "9BBB59", "8064A2", "4BACC6", "F79646", "0000FF", "800080"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let doc = Document::parse(r#"<color theme="4" tint="0.5"/>"#).unwrap();
        assert_eq!(color_of(doc.root_element(), &theme).unwrap(), "#A7C0DE");
        let doc = Document::parse(r#"<color indexed="2"/>"#).unwrap();
        assert_eq!(color_of(doc.root_element(), &theme).unwrap(), "#FF0000");
        let doc = Document::parse(r#"<color rgb="FF336699"/>"#).unwrap();
        assert_eq!(color_of(doc.root_element(), &theme).unwrap(), "#336699");
    }

    fn build_xlsx(path: &Path) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let entries: Vec<(&str, &str)> = vec![
            ("xl/workbook.xml", r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="资产" sheetId="1" r:id="rId1"/><sheet name="隐藏" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>"#),
            ("xl/_rels/workbook.xml.rels", r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>"#),
            ("xl/sharedStrings.xml", r#"<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>名称</t></si><si><r><t>服务</t></r><r><t>器</t></r><rPh><t>ふりがな</t></rPh></si></sst>"#),
            ("xl/styles.xml", r#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
                <numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>
                <fonts count="2"><font><sz val="11"/></font><font><b/><sz val="12"/><color rgb="FFFF0000"/></font></fonts>
                <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills>
                <borders count="2"><border/><border><top style="thin"/><bottom style="thin"/></border></borders>
                <cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="164" fontId="1" fillId="2" borderId="1"><alignment horizontal="center" wrapText="1"/></xf><xf numFmtId="14" fontId="0" fillId="0" borderId="0"/></cellXfs>
              </styleSheet>"#),
            ("xl/worksheets/sheet1.xml", r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView showGridLines="0"><pane xSplit="1" ySplit="1" state="frozen"/></sheetView></sheetViews>
                <cols><col min="1" max="1" width="20" customWidth="1"/><col min="3" max="3" hidden="1" width="10"/></cols>
                <sheetData>
                  <row r="1" ht="30"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
                  <row r="2"><c r="A2" s="1"><v>0.256</v></c><c r="B2" s="2"><v>45000</v></c><c r="C2" t="b"><v>1</v></c></row>
                </sheetData>
                <autoFilter ref="A2:B30"/><mergeCells count="1"><mergeCell ref="A3:C4"/></mergeCells></worksheet>"#),
            ("xl/worksheets/sheet2.xml", r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>"#),
        ];
        for (n, c) in entries {
            zip.start_file(n, SimpleFileOptions::default()).unwrap();
            zip.write_all(c.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn loads_styles_widths_merges_frozen_and_skips_hidden_sheets() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("资产.xlsx");
        build_xlsx(&p);
        let v = load(&p).unwrap();
        assert_eq!(v.sheets.len(), 1, "隐藏工作表不显示");
        let s = &v.sheets[0];
        assert_eq!(s.name, "资产");
        assert!(!s.show_grid);
        assert_eq!((s.frozen_rows, s.frozen_cols), (1, 1));
        assert_eq!(s.merges, vec![[2, 0, 3, 2]]);
        assert_eq!(s.auto_filter, Some([1, 0, 29, 1]), "自动筛选范围 A2:B30");
        assert_eq!(s.col_widths[0], 145.0); // 20 字符 → 145px
        assert_eq!(s.col_widths[2], 0.0); // 隐藏列
        let r1 = &s.rows[0];
        assert_eq!(r1.h, Some(40.0)); // 30pt → 40px
        assert_eq!(r1.cells[1].v, "服务器", "共享字符串取 <r><t>，跳过拼音 rPh");
        let r2 = &s.rows[1];
        assert_eq!(r2.cells[0].v, "25.6%");
        assert!(r2.cells[0].num);
        assert_eq!(r2.cells[1].v, "2023/3/15");
        assert_eq!(r2.cells[2].v, "TRUE");
        let st = &v.styles[r2.cells[0].s as usize];
        assert!(st.bold);
        assert_eq!(st.color.as_deref(), Some("#FF0000"));
        assert_eq!(st.bg.as_deref(), Some("#FFFF00"));
        assert_eq!(st.align.as_deref(), Some("center"));
        assert!(st.wrap);
        assert_eq!(st.border, 1 | 4);
    }

    /// Excel「套用表格格式」（插入表格 / ListObject）生成的工作簿：筛选范围只记在 `xl/tables/table1.xml`
    /// 里，工作表根节点没有自己的 `<autoFilter>`——此前会导致筛选功能形同消失（默认关闭且无法通过
    /// 「文件包含自动筛选范围」自动开启），修复后应从表格定义里取到同一个范围。
    #[test]
    fn auto_filter_falls_back_to_table_definition_when_worksheet_has_none() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("整改建议.xlsx");
        let file = std::fs::File::create(&p).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let entries: Vec<(&str, &str)> = vec![
            ("xl/workbook.xml", r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#),
            ("xl/_rels/workbook.xml.rels", r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#),
            (
                "xl/worksheets/sheet1.xml",
                r#"<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>
                  <x:row r="6"><x:c r="A6" t="str"><x:v>标题</x:v></x:c></x:row>
                  <x:row r="7"><x:c r="A7" t="str"><x:v>数据</x:v></x:c></x:row>
                </x:sheetData><x:tableParts count="1"><x:tablePart r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></x:tableParts></x:worksheet>"#,
            ),
            (
                "xl/worksheets/_rels/sheet1.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>"#,
            ),
            (
                "xl/tables/table1.xml",
                r#"<x:table xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="表1" ref="A6:A7" headerRowCount="1"><x:autoFilter ref="A6:A7"/></x:table>"#,
            ),
        ];
        for (n, c) in entries {
            zip.start_file(n, SimpleFileOptions::default()).unwrap();
            zip.write_all(c.as_bytes()).unwrap();
        }
        zip.finish().unwrap();

        let v = load(&p).unwrap();
        assert_eq!(v.sheets[0].auto_filter, Some([5, 0, 6, 0]), "取自 xl/tables/table1.xml 的 A6:A7");
    }

    /// 旧版 .xls（OLE2 复合文档，魔数 D0 CF 11 E0 A1 B1 1A E1，与真实旧格式文件一致）应得到
    /// 可读提示与建议操作，而不是「缺少 xl/workbook.xml」这类内部结构报错。
    #[test]
    fn legacy_ole2_file_gets_friendly_error() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("旧格式.xls");
        let mut f = std::fs::File::create(&p).unwrap();
        use std::io::Write as _;
        f.write_all(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]).unwrap();
        f.write_all(&[0u8; 32]).unwrap();
        drop(f);
        let err = load(&p).unwrap_err();
        assert!(err.contains("旧版 .xls"), "实际错误：{err}");
        assert!(err.contains("打印版式预览"), "应包含建议操作：{err}");
        assert!(!err.contains("xl/workbook.xml"));
    }

    /// OpenDocument（.ods）是 zip 但结构不同（content.xml），应得到可读提示而非「缺少 xl/workbook.xml」。
    #[test]
    fn odf_file_gets_friendly_error() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("文档.ods");
        let file = std::fs::File::create(&p).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("content.xml", SimpleFileOptions::default()).unwrap();
        zip.write_all(br#"<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>"#).unwrap();
        zip.finish().unwrap();
        let err = load(&p).unwrap_err();
        assert!(err.contains("OpenDocument"), "实际错误：{err}");
        assert!(!err.contains("缺少 xl/workbook.xml"));
    }
}
