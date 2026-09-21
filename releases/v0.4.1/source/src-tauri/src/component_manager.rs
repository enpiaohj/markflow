//! 组件管理（设计文档 §10.3 Component Manager、§10.6 Sidecar 安全）：
//! 探测可选外部组件（Pandoc / LibreOffice）的路径与版本，供转换与高保真预览使用。
//! 组件缺失时能力优雅降级，不阻断文档库使用。

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentStatus {
    pub name: String,
    pub label: String,
    pub found: bool,
    pub version: String,
    pub path: String,
}

/// 探测 pandoc.exe：PATH → 常见安装位置。
pub fn detect_pandoc() -> Option<PathBuf> {
    find_in_path("pandoc.exe")
        .or_else(|| known_locations(&[
            "%LOCALAPPDATA%\\Pandoc\\pandoc.exe",
            "C:\\Program Files\\Pandoc\\pandoc.exe",
            "C:\\Program Files (x86)\\Pandoc\\pandoc.exe",
        ]))
        .filter(|p| p.is_file())
}

/// 探测 soffice.exe（LibreOffice）：PATH → 常见安装位置。
pub fn detect_soffice() -> Option<PathBuf> {
    find_in_path("soffice.exe")
        .or_else(|| known_locations(&[
            "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
            "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
        ]))
        .filter(|p| p.is_file())
}

/// 探测 msedge.exe（PDF 打印管线，Windows 11 内置）。
pub fn detect_edge() -> Option<PathBuf> {
    find_in_path("msedge.exe")
        .or_else(|| known_locations(&[
            "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
            "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        ]))
        .filter(|p| p.is_file())
}

/// 汇总组件健康状态（供设置页与能力按钮）。
pub fn list_components() -> Vec<ComponentStatus> {
    let pandoc = detect_pandoc();
    let soffice = detect_soffice();
    let edge = detect_edge();
    vec![
        ComponentStatus {
            name: "pandoc".into(),
            label: "Pandoc（格式转换）".into(),
            found: pandoc.is_some(),
            version: pandoc.as_ref().map(|p| probe_version(p, &["--version"])).unwrap_or_default(),
            path: pandoc.map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        },
        ComponentStatus {
            name: "libreoffice".into(),
            label: "LibreOffice（高保真预览，可选）".into(),
            found: soffice.is_some(),
            version: soffice.as_ref().map(|p| probe_version(p, &["--version"])).unwrap_or_default(),
            path: soffice.map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        },
        ComponentStatus {
            name: "msedge".into(),
            label: "Microsoft Edge（PDF 输出管线）".into(),
            found: edge.is_some(),
            // 注意：绝不能执行 `msedge.exe --version`——Windows 上 Edge 不会打印版本，而是直接启动浏览器窗口。
            version: edge.as_ref().map(|p| edge_version(p)).unwrap_or_default(),
            path: edge.map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        },
    ]
}

/// 读取 Edge 版本而不启动它：安装目录下有以版本号命名的文件夹（如 `120.0.2210.91`），取最大者。
pub fn edge_version(exe: &Path) -> String {
    let Some(dir) = exe.parent() else { return String::new() };
    let mut best: Option<(Vec<u32>, String)> = None;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let parts: Vec<u32> = name.split('.').filter_map(|p| p.parse().ok()).collect();
            if parts.len() == 4 && name.split('.').count() == 4 && best.as_ref().map(|(b, _)| &parts > b).unwrap_or(true) {
                best = Some((parts, name));
            }
        }
    }
    best.map(|(_, n)| n).unwrap_or_default()
}

/// LibreOffice 是否可用（不执行任何程序，仅探测文件）。
pub fn libreoffice_available() -> bool {
    detect_soffice().is_some()
}

/// 带超时地运行外部命令并返回 stdout 首行（Sidecar 调用一律参数数组，不拼 Shell）。
pub fn probe_version(exe: &Path, args: &[&str]) -> String {
    let mut cmd = Command::new(exe);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::null());
    match run_with_timeout(&mut cmd, Duration::from_secs(8)) {
        Ok(output) => String::from_utf8_lossy(&output)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string(),
        Err(_) => String::new(),
    }
}

/// 带超时的外部命令执行：超时即杀死进程（§10.5 超时与子进程清理）。
/// 成功返回 stdout 字节；失败（非零退出/启动失败/超时）返回含 stderr 摘要的错误。
pub fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Result<Vec<u8>, String> {
    use std::io::Read;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    // 不为子进程创建控制台窗口（发布版是 GUI 程序，否则每次调用 Pandoc / LibreOffice 都会闪一个黑窗）
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("启动组件失败: {e}"))?;
    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");

    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = out_handle.join().unwrap_or_default();
                let stderr = err_handle.join().unwrap_or_default();
                if !status.success() {
                    let msg = String::from_utf8_lossy(&stderr);
                    return Err(format!("组件退出码 {:?}: {}", status.code(), msg.lines().next().unwrap_or("")));
                }
                return Ok(stdout);
            }
            Ok(None) => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("组件执行超时，已终止".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("等待组件失败: {e}")),
        }
    }
}

fn find_in_path(exe: &str) -> Option<PathBuf> {
    let path_env = std::env::var("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_env) {
        let candidate = dir.join(exe);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn known_locations(patterns: &[&str]) -> Option<PathBuf> {
    for pattern in patterns {
        let expanded = if let Some(rest) = pattern.strip_prefix("%LOCALAPPDATA%\\") {
            match std::env::var("LOCALAPPDATA") {
                Ok(base) => PathBuf::from(base).join(rest),
                Err(_) => continue,
            }
        } else {
            PathBuf::from(pattern)
        };
        if expanded.is_file() {
            return Some(expanded);
        }
    }
    None
}

#[cfg(test)]
mod edge_tests {
    use super::*;

    #[test]
    fn edge_version_read_from_folder_names_without_running_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("119.0.2151.44")).unwrap();
        std::fs::create_dir_all(dir.path().join("120.0.2210.91")).unwrap();
        std::fs::create_dir_all(dir.path().join("Installer")).unwrap();
        let exe = dir.path().join("msedge.exe");
        std::fs::write(&exe, b"not a real exe").unwrap(); // 若被执行会失败，证明没有执行
        assert_eq!(edge_version(&exe), "120.0.2210.91");
    }
}
