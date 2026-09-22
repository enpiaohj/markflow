//! 格式注册表（设计文档 §10.4）：
//! 每类格式注册识别规则与显示名；未知格式退化为 other，不阻断文档库使用。
//! 图标与配色由前端按 format id 映射（src/lib/format.ts）。

pub struct FormatDef {
    pub id: &'static str,
    pub label: &'static str,
    pub extensions: &'static [&'static str],
}

pub const FORMATS: &[FormatDef] = &[
    FormatDef {
        id: "markdown",
        label: "Markdown",
        extensions: &["md", "markdown", "mdx"],
    },
    FormatDef {
        id: "text",
        label: "文本",
        extensions: &["txt", "log", "text"],
    },
    FormatDef {
        id: "code",
        label: "代码",
        extensions: &[
            "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "kt", "kts",
            "swift", "c", "h", "cpp", "hpp", "cc", "cs", "rb", "php", "sh", "bash", "zsh",
            "ps1", "bat", "cmd", "sql", "lua", "dart", "scala", "r", "vue", "svelte", "zig",
        ],
    },
    FormatDef {
        id: "json",
        label: "JSON",
        extensions: &["json", "jsonc", "json5"],
    },
    FormatDef {
        id: "yaml",
        label: "YAML",
        extensions: &["yaml", "yml"],
    },
    FormatDef {
        id: "xml",
        label: "XML",
        extensions: &["xml", "xaml", "xhtml", "plist"],
    },
    FormatDef {
        id: "config",
        label: "配置",
        extensions: &["ini", "toml", "conf", "cfg", "properties", "env", "editorconfig"],
    },
    FormatDef {
        id: "csv",
        label: "CSV",
        extensions: &["csv", "tsv"],
    },
    FormatDef {
        id: "word",
        label: "Word",
        extensions: &["docx", "doc", "docm", "odt", "rtf"],
    },
    FormatDef {
        id: "excel",
        label: "Excel",
        extensions: &["xlsx", "xls", "xlsm", "ods"],
    },
    FormatDef {
        id: "powerpoint",
        label: "PowerPoint",
        extensions: &["pptx", "ppt", "pptm", "odp"],
    },
    FormatDef {
        id: "pdf",
        label: "PDF",
        extensions: &["pdf"],
    },
    FormatDef {
        id: "image",
        label: "图片",
        extensions: &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "tif", "tiff"],
    },
    FormatDef {
        id: "archive",
        label: "压缩包",
        extensions: &["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst"],
    },
    FormatDef {
        id: "audio",
        label: "音频",
        extensions: &["mp3", "wav", "flac", "ogg", "m4a", "aac", "wma"],
    },
    FormatDef {
        id: "video",
        label: "视频",
        extensions: &["mp4", "mkv", "avi", "mov", "webm", "flv", "wmv", "m4v"],
    },
];

/// 按整个文件名识别的格式（无扩展名 / 以点开头的约定文件）。
const FILENAME_FORMATS: &[(&str, &str)] = &[
    ("dockerfile", "code"),
    ("makefile", "code"),
    ("gnumakefile", "code"),
    ("jenkinsfile", "code"),
    ("vagrantfile", "code"),
    (".gitignore", "config"),
    (".gitattributes", "config"),
    (".dockerignore", "config"),
    (".npmrc", "config"),
    (".env", "config"),
    (".bashrc", "code"),
    (".zshrc", "code"),
    (".prettierrc", "json"),
    (".eslintrc", "json"),
];

pub const OTHER_FORMAT_ID: &str = "other";
pub const OTHER_FORMAT_LABEL: &str = "其他";

/// 从文件名检测格式 id（按最后一个扩展名，大小写不敏感）。
pub fn detect_format(file_name: &str) -> &'static str {
    // 无扩展名（或整个文件名就是约定名）的脚本 / 配置文件：先按文件名识别
    let lower = file_name.to_ascii_lowercase();
    if let Some(id) = FILENAME_FORMATS.iter().find(|(n, _)| *n == lower.as_str()).map(|(_, id)| *id) {
        return id;
    }
    let ext = match file_name.rsplit_once('.') {
        Some((_, ext)) if !ext.is_empty() => ext.to_ascii_lowercase(),
        _ => return OTHER_FORMAT_ID,
    };
    for def in FORMATS {
        if def.extensions.contains(&ext.as_str()) {
            return def.id;
        }
    }
    OTHER_FORMAT_ID
}

/// 格式 id → 显示名（未知 id 返回「其他」）。
pub fn format_label(format_id: &str) -> &'static str {
    for def in FORMATS {
        if def.id == format_id {
            return def.label;
        }
    }
    OTHER_FORMAT_LABEL
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_common_formats() {
        assert_eq!(detect_format("技术实施方案.md"), "markdown");
        assert_eq!(detect_format("README.MARKDOWN"), "markdown");
        assert_eq!(detect_format("数据库设计.docx"), "word");
        assert_eq!(detect_format("技术选型对比.xlsx"), "excel");
        assert_eq!(detect_format("部署方案.pptx"), "powerpoint");
        assert_eq!(detect_format("网络架构设计.pdf"), "pdf");
        assert_eq!(detect_format("系统架构图.png"), "image");
        assert_eq!(detect_format("部署脚本.sh"), "code");
        assert_eq!(detect_format("Dockerfile"), "code");
        assert_eq!(detect_format(".gitignore"), "config");
        assert_eq!(detect_format(".env"), "config");
        assert_eq!(detect_format("系统配置.json"), "json");
        assert_eq!(detect_format("docker-compose.yml"), "yaml");
        assert_eq!(detect_format("服务器清单.csv"), "csv");
        assert_eq!(detect_format("素材.zip"), "archive");
        assert_eq!(detect_format("会议录音.m4a"), "audio");
    }

    #[test]
    fn detect_fallbacks() {
        assert_eq!(detect_format("无扩展名"), "other");
        assert_eq!(detect_format("未知格式.xyz123"), "other");
        assert_eq!(detect_format(".unknownrc"), "other"); // 只有约定名（.gitignore / Dockerfile 等）才按文件名识别
        assert_eq!(detect_format("archive.tar.gz"), "archive");
    }

    #[test]
    fn labels_match_ids() {
        assert_eq!(format_label("markdown"), "Markdown");
        assert_eq!(format_label("word"), "Word");
        assert_eq!(format_label("不存在的id"), "其他");
    }
}
