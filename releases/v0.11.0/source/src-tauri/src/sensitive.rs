//! 敏感信息扫描（设计文档 §8.9 质量检查、§8.6 AI 上下文门禁、§12 安全）：
//! 在 AI 发送前与文档检查时识别疑似凭据/隐私，命中即拦截或提示。
//! 规则为启发式：宁可误报提示，不可漏报静默外发。

use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SensitiveHit {
    /// 规则标识
    pub kind: String,
    /// 中文说明
    pub label: String,
    /// 所属文件（相对路径）；用户输入等非文件来源为空
    pub file: String,
    /// 命中行号（1-based，相对所属文件）
    pub line: usize,
    /// 脱敏后的命中片段（中间打码，不回传完整内容）
    pub masked: String,
}

struct Rule {
    kind: &'static str,
    label: &'static str,
    pattern: &'static str,
}

// 注意：Rust 的 `` 是 Unicode 感知的，CJK 字符也算单词字符，
// 「手机号13812345678」「密钥sk-…」这类紧贴中文的内容会漏报，
// 因此改用显式的 ASCII 边界（首个捕获组即命中内容）。
const RULES: &[Rule] = &[
    Rule { kind: "openai_key", label: "OpenAI 风格 API Key", pattern: r"(?:^|[^A-Za-z0-9_-])(sk-[A-Za-z0-9_-]{20,})" },
    Rule { kind: "aws_key", label: "AWS Access Key", pattern: r"(?:^|[^A-Za-z0-9])(AKIA[0-9A-Z]{16})(?:[^A-Za-z0-9]|$)" },
    Rule { kind: "google_key", label: "Google API Key", pattern: r"(?:^|[^A-Za-z0-9_-])(AIza[0-9A-Za-z_-]{30,})" },
    Rule { kind: "jwt", label: "JWT Token", pattern: r"(?:^|[^A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})" },
    Rule { kind: "private_key", label: "私钥块", pattern: r"(-----BEGIN [A-Z ]*PRIVATE KEY-----)" },
    Rule { kind: "generic_secret", label: "代码中的密钥赋值", pattern: r#"(?i)(?:^|[^A-Za-z0-9_])((?:api[_-]?key|secret|token|passwd|password)\s*[:=]\s*['"][^'"]{8,}['"])"# },
    Rule { kind: "conn_str", label: "数据库连接串（含口令）", pattern: r#"(?i)(?:^|[^A-Za-z0-9_])((?:password|pwd)=\S{4,})"# },
    Rule { kind: "phone", label: "手机号", pattern: r"(?:^|[^0-9])(1[3-9]\d{9})(?:[^0-9]|$)" },
    Rule { kind: "id_card", label: "身份证号", pattern: r"(?:^|[^0-9])(\d{17}[\dXx])(?:[^0-9Xx]|$)" },
];

fn compile_rules() -> &'static Vec<(Regex, &'static str, &'static str)> {
    static COMPILED: OnceLock<Vec<(Regex, &'static str, &'static str)>> = OnceLock::new();
    COMPILED.get_or_init(|| {
        RULES
            .iter()
            .filter_map(|r| Regex::new(r.pattern).ok().map(|re| (re, r.kind, r.label)))
            .collect()
    })
}

/// 脱敏：保留前后 25% 字符，中间以 *** 代替。
fn mask(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    if n <= 8 {
        return "*".repeat(n);
    }
    let keep = (n / 4).max(2);
    let head: String = chars[..keep].iter().collect();
    let tail: String = chars[n - keep..].iter().collect();
    format!("{head}***{tail}")
}

/// 扫描文本，返回命中列表（每行每规则只报一条，避免刷屏）。
pub fn scan(text: &str) -> Vec<SensitiveHit> {
    scan_named(text, "")
}

/// 扫描并标注来源文件名。
pub fn scan_named(text: &str, file: &str) -> Vec<SensitiveHit> {
    let compiled = compile_rules();
    let mut hits = Vec::new();
    for (line_no, line) in text.lines().enumerate() {
        for (re, kind, label) in compiled {
            if let Some(caps) = re.captures(line) {
                let m = caps.get(1).or_else(|| caps.get(0)).map(|m| m.as_str()).unwrap_or("");
                hits.push(SensitiveHit {
                    kind: kind.to_string(),
                    label: label.to_string(),
                    file: file.to_string(),
                    line: line_no + 1,
                    masked: mask(m),
                });
            }
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_common_credentials() {
        let text = "配置如下：\nOPENAI_KEY=sk-abcdefghij0123456789ABCDEFGHIJ\n登录手机 13912345678。\n-----BEGIN RSA PRIVATE KEY-----";
        let hits = scan(text);
        let kinds: Vec<&str> = hits.iter().map(|h| h.kind.as_str()).collect();
        assert!(kinds.contains(&"openai_key"));
        assert!(kinds.contains(&"phone"));
        assert!(kinds.contains(&"private_key"));
        // 命中行号正确（1-based）
        let openai = hits.iter().find(|h| h.kind == "openai_key").unwrap();
        assert_eq!(openai.line, 2);
        // 脱敏不回传完整密钥
        assert!(!openai.masked.contains("abcdefghij0123456789"));
        assert!(openai.masked.contains("***"));
    }

    #[test]
    fn clean_text_passes() {
        let text = "# 正常文档\n\n这是一段普通的技术说明，不包含任何敏感凭据。电话是 0371-88888888。";
        assert!(scan(text).is_empty());
    }

    #[test]
    fn jwt_and_password_patterns() {
        let text = "token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4\ndb: postgres://u:password=Secret123@host/db";
        let hits = scan(text);
        let kinds: Vec<&str> = hits.iter().map(|h| h.kind.as_str()).collect();
        assert!(kinds.contains(&"jwt"));
        assert!(kinds.contains(&"conn_str"));
    }
}

#[cfg(test)]
mod cjk_tests {
    use super::*;

    #[test]
    fn detects_when_adjacent_to_cjk() {
        assert_eq!(scan("手机号13812345678").len(), 1);
        assert_eq!(scan("联系电话：13812345678。").len(), 1);
        assert_eq!(scan("密钥sk-abcdefghijklmnopqrstuv").len(), 1);
        assert_eq!(scan("身份证11010519491231002X").len(), 1);
    }

    #[test]
    fn ignores_longer_digit_runs_and_normal_text() {
        assert_eq!(scan("订单号 913812345678901").len(), 0);
        assert_eq!(scan("普通文本，没有敏感信息").len(), 0);
        let hits = scan_named("a
password = \"hunter2hunter2\"", "配置.md");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].file, "配置.md");
        assert_eq!(hits[0].line, 2);
    }
}
