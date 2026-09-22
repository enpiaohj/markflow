//! 系统（资源管理器）文件类型图标提取：
//! 用 PowerShell + .NET `Icon.ExtractAssociatedIcon` 从本机读取各扩展名的标准图标
//! （与资源管理器显示的完全一致，含 Office / Edge 等已装软件注册的图标），
//! 编码为 32×32 PNG data URL 供前端使用。不随应用分发任何图标资源；
//! 提取失败或系统没有对应图标时，前端回退到内置 SVG 套图。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

/// (前端格式 id, 探测用扩展名)
const PROBE: &[(&str, &str)] = &[
    ("text", ".txt"),
    ("markdown", ".md"),
    ("word", ".docx"),
    ("excel", ".xlsx"),
    ("powerpoint", ".pptx"),
    ("pdf", ".pdf"),
    ("image", ".png"),
    ("archive", ".zip"),
    ("audio", ".mp3"),
    ("video", ".mp4"),
    ("csv", ".csv"),
    ("json", ".json"),
    ("yaml", ".yaml"),
    ("xml", ".xml"),
    ("config", ".ini"),
    ("code", ".py"),
];

fn probe_dir() -> PathBuf {
    std::env::temp_dir().join("markflow-sysicon-probe")
}

static CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// 提取全部探测格式的图标（data URL）；进程内缓存，只提取一次。
pub fn cached() -> HashMap<String, String> {
    let mut guard = CACHE.lock().unwrap();
    if let Some(map) = guard.as_ref() {
        return map.clone();
    }
    let map = extract_all().unwrap_or_default();
    *guard = Some(map.clone());
    map
}

fn extract_all() -> Result<HashMap<String, String>, String> {
    let dir = probe_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建探测目录失败: {e}"))?;

    let mut ps = String::from("Add-Type -AssemblyName System.Drawing; $r=@{};");
    let mut tmp = Vec::new();
    for (i, (_, ext)) in PROBE.iter().enumerate() {
        let p = dir.join(format!("probe{i}{ext}"));
        std::fs::write(&p, b"").map_err(|e| format!("创建探测文件失败: {e}"))?;
        tmp.push(p.clone());
        let path = p.to_string_lossy().replace('\'', "''");
        ps.push_str(&format!(
            "try{{ $ic=[System.Drawing.Icon]::ExtractAssociatedIcon('{path}'); \
             if($ic){{ $m=New-Object System.IO.MemoryStream; \
             $ic.ToBitmap().Save($m,[System.Drawing.Imaging.ImageFormat]::Png); \
             $r['{i}']=[Convert]::ToBase64String($m.ToArray()); }} }} catch {{ }};"
        ));
    }
    ps.push_str("$r | ConvertTo-Json -Compress");

    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &ps]);
    let stdout = crate::component_manager::run_with_timeout(&mut cmd, Duration::from_secs(20))?;

    let _ = tmp.iter().for_each(|p| {
        let _ = std::fs::remove_file(p);
    });

    let raw = String::from_utf8_lossy(&stdout).trim().to_string();
    let parsed: HashMap<String, String> = if raw.is_empty() {
        HashMap::new()
    } else {
        serde_json::from_str(&raw).unwrap_or_default()
    };

    let mut out = HashMap::new();
    for (i, (format, _)) in PROBE.iter().enumerate() {
        if let Some(b64) = parsed.get(&i.to_string()) {
            out.insert(format.to_string(), format!("data:image/png;base64,{b64}"));
        }
    }
    Ok(out)
}
