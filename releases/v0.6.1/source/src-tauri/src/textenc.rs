//! 文本编码与换行符处理：读取时检测编码（UTF-8 / UTF-8 BOM / UTF-16 / GBK），
//! 保存时按磁盘原编码与原换行符写回，避免非 UTF-8 文件被静默损坏。

use encoding_rs::{GBK, UTF_16BE, UTF_16LE};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Gbk,
}

impl Encoding {
    pub fn label(self) -> &'static str {
        match self {
            Encoding::Utf8 => "UTF-8",
            Encoding::Utf8Bom => "UTF-8 BOM",
            Encoding::Utf16Le => "UTF-16 LE",
            Encoding::Utf16Be => "UTF-16 BE",
            Encoding::Gbk => "GBK",
        }
    }
}

/// 解码结果：`text` 已去除 BOM，换行符保持原样。
pub struct Decoded {
    pub text: String,
    pub encoding: Encoding,
}

/// 检测编码并解码。无法无损解码（既非合法 UTF-8 也非合法 GBK）时返回 Err，
/// 由调用方决定只读或拒绝编辑，绝不静默替换为 U+FFFD。
pub fn decode(bytes: &[u8]) -> Result<Decoded, String> {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return match std::str::from_utf8(rest) {
            Ok(s) => Ok(Decoded { text: s.to_string(), encoding: Encoding::Utf8Bom }),
            Err(_) => Err("文件带有 UTF-8 BOM 但内容不是合法 UTF-8".into()),
        };
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let (s, had_errors) = UTF_16LE.decode_without_bom_handling(rest);
        return if had_errors {
            Err("UTF-16 内容不合法".into())
        } else {
            Ok(Decoded { text: s.into_owned(), encoding: Encoding::Utf16Le })
        };
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let (s, had_errors) = UTF_16BE.decode_without_bom_handling(rest);
        return if had_errors {
            Err("UTF-16 内容不合法".into())
        } else {
            Ok(Decoded { text: s.into_owned(), encoding: Encoding::Utf16Be })
        };
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return Ok(Decoded { text: s.to_string(), encoding: Encoding::Utf8 });
    }
    let (s, had_errors) = GBK.decode_without_bom_handling(bytes);
    if !had_errors {
        return Ok(Decoded { text: s.into_owned(), encoding: Encoding::Gbk });
    }
    Err("无法确定文件编码（既不是 UTF-8 也不是 GBK），为避免损坏文件，请使用系统应用打开。".into())
}

/// 有损解码：仅供全文索引 / 上下文提取使用（不会写回磁盘）。
pub fn decode_lossy_for_index(bytes: &[u8]) -> String {
    match decode(bytes) {
        Ok(d) => d.text,
        Err(_) => String::from_utf8_lossy(bytes).to_string(),
    }
}

/// 按指定编码编码文本；存在无法表示的字符时报错（不静默丢字）。
pub fn encode(text: &str, encoding: Encoding) -> Result<Vec<u8>, String> {
    match encoding {
        Encoding::Utf8 => Ok(text.as_bytes().to_vec()),
        Encoding::Utf8Bom => {
            let mut out = vec![0xEF, 0xBB, 0xBF];
            out.extend_from_slice(text.as_bytes());
            Ok(out)
        }
        Encoding::Utf16Le => {
            let mut out = vec![0xFF, 0xFE];
            for u in text.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
            Ok(out)
        }
        Encoding::Utf16Be => {
            let mut out = vec![0xFE, 0xFF];
            for u in text.encode_utf16() {
                out.extend_from_slice(&u.to_be_bytes());
            }
            Ok(out)
        }
        Encoding::Gbk => {
            let (bytes, _, had_unmappable) = GBK.encode(text);
            if had_unmappable {
                Err("内容包含 GBK 无法表示的字符（如 emoji），为避免文件损坏已中止保存。请改用「另存为」UTF-8 文档。".into())
            } else {
                Ok(bytes.into_owned())
            }
        }
    }
}

/// 该文本是否以 CRLF 为主要换行符。
pub fn uses_crlf(text: &str) -> bool {
    let crlf = text.matches("\r\n").count();
    if crlf == 0 {
        return false;
    }
    let lf = text.matches('\n').count();
    crlf * 2 >= lf
}

/// 将换行符统一为目标风格（编辑器内部一律使用 LF）。
pub fn apply_line_ending(text: &str, crlf: bool) -> String {
    let normalized = text.replace("\r\n", "\n");
    if crlf {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_and_gbk_roundtrip() {
        let d = decode("你好 world".as_bytes()).unwrap();
        assert_eq!(d.encoding, Encoding::Utf8);

        let (gbk, _, _) = GBK.encode("中文内容测试");
        let d = decode(&gbk).unwrap();
        assert_eq!(d.encoding, Encoding::Gbk);
        assert_eq!(d.text, "中文内容测试");
        assert_eq!(encode(&d.text, Encoding::Gbk).unwrap(), gbk.as_ref());
    }

    #[test]
    fn bom_is_preserved() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("abc".as_bytes());
        let d = decode(&bytes).unwrap();
        assert_eq!(d.encoding, Encoding::Utf8Bom);
        assert_eq!(d.text, "abc");
        assert_eq!(encode(&d.text, d.encoding).unwrap(), bytes);
    }

    #[test]
    fn undecodable_is_rejected_and_unmappable_blocks_save() {
        assert!(decode(&[0xFF, 0x00, 0xFF, 0x81]).is_err());
        assert!(encode("😀", Encoding::Gbk).is_err());
    }

    #[test]
    fn line_endings() {
        assert!(uses_crlf("a\r\nb\r\n"));
        assert!(!uses_crlf("a\nb\n"));
        assert_eq!(apply_line_ending("a\nb", true), "a\r\nb");
        assert_eq!(apply_line_ending("a\r\nb", false), "a\nb");
    }
}
