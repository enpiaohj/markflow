//! 文档质量检查（设计文档 §8.9，v0.4 文本类子集）：
//! Markdown 结构、标题层级、断链、空章节、敏感信息；
//! 结果分错误 / 警告 / 建议，错误可阻止正式交付（交付门禁在 v0.5 接入）。

use crate::sensitive;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub severity: Severity,
    /// 1-based 行号；全文性问题为 0
    pub line: usize,
    /// 规则标识
    pub code: String,
    pub message: String,
}

/// 检查一个 Markdown 文件；`resolve_link` 用于校验相对链接是否存在。
pub fn check_markdown(content: &str, resolve_link: &dyn Fn(&str) -> bool) -> Vec<Issue> {
    let mut issues = Vec::new();

    let mut last_heading_level: Option<u8> = None;
    let mut in_code_block = false;
    let mut current_heading: Option<(usize, String, u8)> = None; // (行号, 标题文本, 层级)
    let mut had_content_since_heading = false;
    let mut empty_sections: Vec<(usize, String)> = Vec::new();

    for (idx, raw_line) in content.lines().enumerate() {
        let line_no = idx + 1;
        let trimmed = raw_line.trim();

        if trimmed.starts_with("```") {
            in_code_block = !in_code_block;
            continue;
        }
        if in_code_block {
            continue;
        }

        // 本地相对链接检查
        for caps in link_regex().captures_iter(trimmed) {
            let target = caps[1].trim();
            if target.starts_with("http://")
                || target.starts_with("https://")
                || target.starts_with('#')
                || target.starts_with("mailto:")
            {
                continue;
            }
            let clean = target.split('#').next().unwrap_or(target);
            if clean.is_empty() || !resolve_link(clean) {
                issues.push(Issue {
                    severity: Severity::Error,
                    line: line_no,
                    code: "broken_link".into(),
                    message: format!("链接目标不存在: {target}"),
                });
            }
        }

        // 标题
        if let Some(level) = heading_level(trimmed) {
            // 空章节判定：上一个标题之后没有任何正文，且新标题不是其子标题
            //（父标题下直接跟子标题属正常结构，不算空）
            if let Some((h_line, h_text, h_level)) = &current_heading {
                if !had_content_since_heading && level <= *h_level {
                    empty_sections.push((*h_line, h_text.clone()));
                }
            }
            if let Some(prev) = last_heading_level {
                if level > prev + 1 {
                    issues.push(Issue {
                        severity: Severity::Warning,
                        line: line_no,
                        code: "heading_jump".into(),
                        message: format!("标题层级跳跃：H{prev} 后直接出现 H{level}"),
                    });
                }
            }
            last_heading_level = Some(level);
            current_heading = Some((line_no, trimmed.trim_start_matches('#').trim().to_string(), level));
            had_content_since_heading = false;
            continue;
        }

        if !trimmed.is_empty() {
            had_content_since_heading = true;
        }
    }

    // 文末空章节
    if let Some((h_line, h_text, _level)) = &current_heading {
        if !had_content_since_heading {
            empty_sections.push((*h_line, h_text.clone()));
        }
    }
    for (line, text) in empty_sections {
        issues.push(Issue {
            severity: Severity::Warning,
            line,
            code: "empty_section".into(),
            message: format!("章节「{text}」没有正文内容"),
        });
    }

    // 建议级：首个标题不是 H1
    if let Some(level) = last_heading_level {
        let first_heading = content
            .lines()
            .find_map(|l| heading_level(l.trim()));
        if first_heading.is_some() && level >= 1 && first_heading != Some(1) && first_heading == Some(level) {
            issues.push(Issue {
                severity: Severity::Info,
                line: 0,
                code: "missing_h1".into(),
                message: "文档缺少一级标题（H1），建议以 H1 作为文档标题".into(),
            });
        }
    }

    // 敏感信息（复用扫描规则）
    for hit in sensitive::scan(content) {
        issues.push(Issue {
            severity: Severity::Error,
            line: hit.line,
            code: format!("sensitive_{}", hit.kind),
            message: format!("疑似敏感信息（{}）: {}", hit.label, hit.masked),
        });
    }

    issues.sort_by_key(|i| (i.line, i.code.clone()));
    issues
}

/// 相对链接解析器工厂：基于库根目录检查文件是否存在（支持 / 开头的库根相对路径）。
pub fn link_resolver<'a>(root: &'a Path, document_dir: &'a Path) -> impl Fn(&str) -> bool + 'a {
    move |target: &str| {
        let target_path = if let Some(stripped) = target.strip_prefix('/') {
            root.join(stripped)
        } else {
            document_dir.join(target)
        };
        // URL 解码最常见情形（空格）
        let decoded = target_path.to_string_lossy().replace("%20", " ");
        Path::new(&decoded).is_file()
    }
}

fn heading_level(line: &str) -> Option<u8> {
    let hashes = line.chars().take_while(|&c| c == '#').count();
    if (1..=6).contains(&hashes) {
        let rest = &line[hashes..];
        if rest.starts_with(' ') {
            return Some(hashes as u8);
        }
    }
    None
}

fn link_regex() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"\[[^\]]*\]\(([^)]+)\)").expect("link regex"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_heading_jump_and_broken_link() {
        let content = "# 标题\n\n正文。\n\n### 突然三级\n\n见 [详情](./不存在.md) 与 [外部](https://ok.com)。\n";
        let resolver = |target: &str| target.starts_with("https://");
        let issues = check_markdown(content, &resolver);

        assert!(issues.iter().any(|i| i.code == "heading_jump" && i.severity == Severity::Warning));
        assert!(issues.iter().any(|i| i.code == "broken_link" && i.severity == Severity::Error));
        assert!(!issues.iter().any(|i| i.message.contains("外部")));
    }

    #[test]
    fn detects_empty_sections_and_sensitive() {
        let content = "# 方案\n\n## 概述\n\n有正文。\n\n## 风险\n\n## 附则\n\n联系 13912345678\n";
        let resolver = |_: &str| true;
        let issues = check_markdown(content, &resolver);

        let empties: Vec<&Issue> = issues.iter().filter(|i| i.code == "empty_section").collect();
        assert_eq!(empties.len(), 1);
        assert!(empties[0].message.contains("风险"));
        assert!(issues.iter().any(|i| i.code.starts_with("sensitive_") && i.severity == Severity::Error));
    }

    #[test]
    fn code_blocks_are_ignored() {
        let content = "# 标题\n\n```markdown\n### 不是真标题\n[链接](./也不存在.md)\n```\n\n正文。\n";
        let resolver = |_: &str| false;
        let issues = check_markdown(content, &resolver);
        assert!(issues.iter().all(|i| i.code != "heading_jump" && i.code != "broken_link"));
    }

    #[test]
    fn heading_level_parses() {
        assert_eq!(heading_level("## 标题"), Some(2));
        assert_eq!(heading_level("#没有空格"), None);
        assert_eq!(heading_level("正文 # 标注"), None);
    }
}
