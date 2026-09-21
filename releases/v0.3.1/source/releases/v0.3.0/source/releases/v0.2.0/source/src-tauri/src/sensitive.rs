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
    /// 命中行号（1-based）
    pub line: usize,
    /// 脱敏后的命中片段（中间打码，不回传完整内容）
    pub masked: String,
}

struct Rule {
    kind: &'static str,
    label: &'static str,
    pattern: &'static str,
}

const RULES: &[Rule] = &[
    Rule { kind: "openai_key", label: "OpenAI 风格 API Key", pattern: r"\bsk-[A-Za-z0-9_-]{20,}" },
    Rule { kind: "aws_key", label: "AWS Access Key", pattern: r"\bAKIA[0-9A-Z]{16}\b" },
    Rule { kind: "google_key", label: "Google API Key", pattern: r"\bAIza[0-9A-Za-z_-]{30,}\b" },
    Rule { kind: "jwt", label: "JWT Token", pattern: r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}" },
    Rule { kind: "private_key", label: "私钥块", pattern: r"-----BEGIN [A-Z ]*PRIVATE KEY-----" },
    Rule { kind: "generic_secret", label: "代码中的密钥赋值", pattern: r#"(?i)\b(api[_-]?key|secret|token|passwd|password)\s*[:=]\s*['"][^'"]{8,}['"]"# },
    Rule { kind: "conn_str", label: "数据库连接串（含口令）", pattern: r#"(?i)\b(password|pwd)=\S{4,}"# },
    Rule { kind: "phone", label: "手机号", pattern: r"\b1[3-9]\d{9}\b" },
    Rule { kind: "id_card", label: "身份证号", pattern: r"\b\d{17}[\dXx]\b" },
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
    let compiled = compile_rules();
    let mut hits = Vec::new();
    for (line_no, line) in text.lines().enumerate() {
        for (re, kind, label) in compiled {
            if let Some(m) = re.find(line) {
                hits.push(SensitiveHit {
                    kind: kind.to_string(),
                    label: label.to_string(),
                    line: line_no + 1,
                    masked: mask(m.as_str()),
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
