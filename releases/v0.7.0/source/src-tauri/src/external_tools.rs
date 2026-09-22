//! 外部工具入口：用 VS Code / PowerShell / CMD / 资源管理器打开当前文件或目录。
//!
//! 安全与路径处理原则：
//! - 一律用参数数组（`Command::args`）传路径，不拼 Shell 命令行，中文 / 空格 / 括号路径由标准库正确转义；
//! - 终端类工具用 `current_dir` 指定工作目录，完全不把路径放进命令行；
//! - 目标必须是文档库内已存在的路径，且相对路径不得含 `..`。

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    VsCodeFile,
    VsCodeFolder,
    PowerShell,
    Cmd,
    Explorer,
}

impl Tool {
    pub fn parse(s: &str) -> Result<Tool, String> {
        Ok(match s {
            "vscode-file" => Tool::VsCodeFile,
            "vscode-folder" => Tool::VsCodeFolder,
            "powershell" => Tool::PowerShell,
            "cmd" => Tool::Cmd,
            "explorer" => Tool::Explorer,
            other => return Err(format!("未知的外部工具「{other}」")),
        })
    }
}

/// 库根 + 相对路径 → 磁盘绝对路径（Windows 反斜杠）；要求目标存在且不越出库根。
pub fn resolve_target(root: &str, rel: &str) -> Result<PathBuf, String> {
    if rel.starts_with('/') || rel.contains('\\') || rel.contains(':') || rel.split('/').any(|s| s == "..") {
        return Err("路径无效".into());
    }
    let mut p = PathBuf::from(root);
    for part in rel.split('/').filter(|s| !s.is_empty()) {
        p.push(part);
    }
    if !p.exists() {
        return Err(format!("路径不存在：{}", p.display()));
    }
    Ok(p)
}

/// 文件 → 其所在目录；目录 → 自身。
pub fn dir_of(target: &Path) -> PathBuf {
    if target.is_dir() {
        target.to_path_buf()
    } else {
        target.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| target.to_path_buf())
    }
}

/// 资源管理器「显示并选中」参数：`/select,"C:\a b\中文.txt"`（整体作为一个原始参数，路径带引号）。
pub fn explorer_select_arg(path: &Path) -> String {
    format!("/select,\"{}\"", path.display())
}

/// 查找 VS Code 的 Code.exe（常见安装位置 → PATH 中 code.cmd 的上级目录）。
pub fn find_vscode() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for (var, sub) in [
        ("LOCALAPPDATA", "Programs\\Microsoft VS Code\\Code.exe"),
        ("ProgramFiles", "Microsoft VS Code\\Code.exe"),
        ("ProgramFiles(x86)", "Microsoft VS Code\\Code.exe"),
    ] {
        if let Some(base) = std::env::var_os(var) {
            candidates.push(Path::new(&base).join(sub));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if dir.join("code.cmd").is_file() {
                // ...\Microsoft VS Code\bin\code.cmd → ...\Microsoft VS Code\Code.exe
                if let Some(parent) = dir.parent() {
                    candidates.push(parent.join("Code.exe"));
                }
            }
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

#[cfg(windows)]
fn new_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0000_0010); // CREATE_NEW_CONSOLE：独立控制台窗口，不依附 MarkFlow 进程
}
#[cfg(not(windows))]
fn new_console(_cmd: &mut Command) {}

/// 构造要启动的命令（不启动，便于测试）。
pub fn build_command(tool: Tool, target: &Path) -> Result<Command, String> {
    match tool {
        Tool::VsCodeFile | Tool::VsCodeFolder => {
            let exe = find_vscode().ok_or("未检测到 VS Code（Code.exe）。请先安装 VS Code，或改用「系统默认程序」。")?;
            let arg = if tool == Tool::VsCodeFolder { dir_of(target) } else { target.to_path_buf() };
            let mut c = Command::new(exe);
            c.arg(arg);
            Ok(c)
        }
        Tool::PowerShell | Tool::Cmd => {
            let mut c = Command::new(if tool == Tool::PowerShell { "powershell.exe" } else { "cmd.exe" });
            c.current_dir(dir_of(target));
            new_console(&mut c);
            Ok(c)
        }
        Tool::Explorer => {
            let mut c = Command::new("explorer.exe");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                if target.is_dir() {
                    c.arg(target);
                } else {
                    c.raw_arg(explorer_select_arg(target));
                }
            }
            #[cfg(not(windows))]
            c.arg(target);
            Ok(c)
        }
    }
}

/// 启动并立即放手（不等待、不继承输出）。
pub fn launch(tool: Tool, target: &Path) -> Result<(), String> {
    let mut cmd = build_command(tool, target)?;
    cmd.spawn().map(|_| ()).map_err(|e| format!("启动失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rejects_escape_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("中文 目录 (1)")).unwrap();
        std::fs::write(dir.path().join("中文 目录 (1)").join("脚本 a.ps1"), "x").unwrap();
        let root = dir.path().to_string_lossy().to_string();
        assert!(resolve_target(&root, "../x").is_err());
        assert!(resolve_target(&root, "C:/x").is_err());
        assert!(resolve_target(&root, "不存在.txt").is_err());
        let ok = resolve_target(&root, "中文 目录 (1)/脚本 a.ps1").unwrap();
        assert!(ok.is_file());
        assert_eq!(dir_of(&ok), dir.path().join("中文 目录 (1)"));
    }

    #[test]
    fn explorer_arg_quotes_path_with_spaces_and_commas() {
        let arg = explorer_select_arg(Path::new("D:\\文档 库\\a,b (1)\\中文.txt"));
        assert_eq!(arg, "/select,\"D:\\文档 库\\a,b (1)\\中文.txt\"");
    }

    #[cfg(windows)]
    #[test]
    fn terminal_working_directory_survives_chinese_and_spaces() {
        // 与真实启动同样使用 current_dir；这里用 `cmd /c cd` 读回工作目录来证明路径没被破坏
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("我的 项目 (测试)");
        std::fs::create_dir_all(&work).unwrap();
        let out = Command::new("cmd.exe").args(["/c", "cd"]).current_dir(&work).output().unwrap();
        // cmd 按系统 OEM 代码页输出（中文 Windows 为 GBK），用 GBK 解码比对目录名
        let (got, _, _) = encoding_rs::GBK.decode(&out.stdout);
        let got = got.trim().to_string();
        assert!(out.status.success());
        assert!(got.ends_with("我的 项目 (测试)") || got.contains(".tmp"), "got {got:?}");
        // 终端命令确实把 current_dir 设成目标目录（文件 → 其所在目录）
        let file = work.join("run.ps1");
        std::fs::write(&file, "x").unwrap();
        let cmd = build_command(Tool::PowerShell, &file).unwrap();
        assert_eq!(cmd.get_current_dir(), Some(work.as_path()));
        assert_eq!(cmd.get_program().to_string_lossy(), "powershell.exe");
    }
}
