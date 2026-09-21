//! PowerPoint 逐页图片预览（设计文档 §5.2 L4）：
//! 用本机 Microsoft PowerPoint 后台只读、禁宏、无窗口地把每张幻灯片导出为 PNG，
//! 导出一页就能显示一页（边导边看），并按「路径 + 修改时间 + 大小」缓存。
//! 源文件不被修改；用户已运行的 PowerPoint 只关闭我们打开的那份演示文稿，不退出应用。

use crate::component_manager::run_with_timeout;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const EXPORT_TIMEOUT: Duration = Duration::from_secs(300);
/// 导出图片的像素宽度（高度按幻灯片比例计算）
const SLIDE_WIDTH: u32 = 1600;
/// 缓存目录数量上限（每个演示文稿一个目录）
const CACHE_MAX_DIRS: usize = 30;

const SLIDE_SCRIPT: &str = r#"
param([string]$In, [string]$OutDir, [int]$Width)
$ErrorActionPreference = 'Stop'
$pre = [bool](Get-Process -Name POWERPNT -ErrorAction SilentlyContinue)
$app = $null
try {
  $app = New-Object -ComObject PowerPoint.Application
  $app.AutomationSecurity = 3
  $pres = $app.Presentations.Open($In, -1, 0, 0)
  try {
    $w = [double]$pres.PageSetup.SlideWidth
    $h = [double]$pres.PageSetup.SlideHeight
    $height = [int][math]::Round($Width * $h / $w)
    $n = [int]$pres.Slides.Count
    $meta = '{"count":' + $n + ',"width":' + $Width + ',"height":' + $height + '}'
    [System.IO.File]::WriteAllText((Join-Path $OutDir 'meta.json'), $meta)
    for ($i = 1; $i -le $n; $i++) {
      $pres.Slides.Item($i).Export((Join-Path $OutDir ("s" + $i + ".png")), 'PNG', $Width, $height)
    }
    [System.IO.File]::WriteAllText((Join-Path $OutDir 'done'), 'ok')
  } finally { $pres.Close() }
} finally {
  if ($app -ne $null -and -not $pre) { try { $app.Quit() } catch {} }
}
"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlidesMeta {
    pub key: String,
    pub count: usize,
    pub width: u32,
    pub height: u32,
}

/// 导出进度：`ready` 张已可显示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlidesProgress {
    pub key: String,
    pub count: usize,
    pub width: u32,
    pub height: u32,
    pub ready: usize,
}

pub fn slides_root(cache_dir: &Path) -> PathBuf {
    cache_dir.join("slides")
}

fn read_meta(dir: &Path) -> Option<(usize, u32, u32)> {
    let text = std::fs::read_to_string(dir.join("meta.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some((
        v["count"].as_u64()? as usize,
        v["width"].as_u64()? as u32,
        v["height"].as_u64()? as u32,
    ))
}

/// 已完整导出的缓存（存在 `done` 标记）。
fn cached(dir: &Path, key: &str) -> Option<SlidesMeta> {
    if !dir.join("done").is_file() {
        return None;
    }
    let (count, width, height) = read_meta(dir)?;
    Some(SlidesMeta { key: key.to_string(), count, width, height })
}

/// 当前有多少张已完整写出（第 N 张在 N+1 张出现或整体完成后才算完整，避免读到写了一半的文件）。
fn ready_count(dir: &Path, count: usize) -> usize {
    let done = dir.join("done").is_file();
    let mut ready = 0;
    for i in 1..=count {
        let exists = dir.join(format!("s{i}.png")).is_file();
        let next_exists = i < count && dir.join(format!("s{}.png", i + 1)).is_file();
        if exists && (next_exists || done) {
            ready = i;
        } else {
            break;
        }
    }
    ready
}

fn prune(root: &Path) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    let mut dirs: Vec<(PathBuf, std::time::SystemTime)> = rd
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            m.is_dir().then(|| (e.path(), m.modified().unwrap_or(std::time::UNIX_EPOCH)))
        })
        .collect();
    dirs.sort_by_key(|d| d.1);
    while dirs.len() > CACHE_MAX_DIRS {
        let (p, _) = dirs.remove(0);
        let _ = std::fs::remove_dir_all(p);
    }
}

/// 导出（或命中缓存）；`on_progress` 在每张新图片可用时回调。
pub fn export_slides(
    cache_dir: &Path,
    src: &Path,
    on_progress: &(dyn Fn(SlidesProgress) + Sync),
) -> Result<SlidesMeta, String> {
    let key = crate::officepdf::cache_key(src);
    let root = slides_root(cache_dir);
    let dir = root.join(&key);
    if let Some(meta) = cached(&dir, &key) {
        on_progress(SlidesProgress { key: key.clone(), count: meta.count, width: meta.width, height: meta.height, ready: meta.count });
        return Ok(meta);
    }

    // 与 PDF 导出共用同一把锁：同一时间只有一个 Office 导出任务
    let _guard = crate::officepdf::export_lock();
    if let Some(meta) = cached(&dir, &key) {
        on_progress(SlidesProgress { key: key.clone(), count: meta.count, width: meta.width, height: meta.height, ready: meta.count });
        return Ok(meta);
    }
    let _ = std::fs::remove_dir_all(&dir); // 清掉上次中断留下的半成品
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建预览缓存目录失败: {e}"))?;

    let script_dir = std::env::temp_dir().join(format!("markflow-pptx-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&script_dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
    let script = script_dir.join("slides.ps1");
    let stop = AtomicBool::new(false);

    let result = std::thread::scope(|scope| -> Result<(), String> {
        // 轮询目录，图片一张张出现就一张张通知前端
        let poller = scope.spawn(|| {
            let mut last = usize::MAX;
            while !stop.load(Ordering::Relaxed) {
                if let Some((count, width, height)) = read_meta(&dir) {
                    let ready = ready_count(&dir, count);
                    if ready != last {
                        last = ready;
                        on_progress(SlidesProgress { key: key.clone(), count, width, height, ready });
                    }
                }
                std::thread::sleep(Duration::from_millis(120));
            }
        });
        let run = (|| -> Result<(), String> {
            std::fs::write(&script, SLIDE_SCRIPT).map_err(|e| format!("写入导出脚本失败: {e}"))?;
            let mut cmd = Command::new("powershell.exe");
            cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(&script)
                .arg("-In")
                .arg(src)
                .arg("-OutDir")
                .arg(&dir)
                .args(["-Width", &SLIDE_WIDTH.to_string()]);
            run_with_timeout(&mut cmd, EXPORT_TIMEOUT).map_err(|e| {
                format!("Microsoft PowerPoint 导出幻灯片失败（文件可能受密码保护、已损坏，或 PowerPoint 正弹出对话框）：{e}")
            })?;
            Ok(())
        })();
        stop.store(true, Ordering::Relaxed);
        let _ = poller.join();
        run
    });
    let _ = std::fs::remove_dir_all(&script_dir);

    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&dir); // 失败不留半成品
        return Err(e);
    }
    let Some(meta) = cached(&dir, &key) else {
        let _ = std::fs::remove_dir_all(&dir);
        return Err("PowerPoint 未生成幻灯片图片".into());
    };
    // 最后一次通知：全部完成
    on_progress(SlidesProgress { key: key.clone(), count: meta.count, width: meta.width, height: meta.height, ready: meta.count });
    prune(&root);
    Ok(meta)
}

/// 读取某张幻灯片图片（key 与页码都做严格校验，只能读缓存目录内的 PNG）。
pub fn read_slide(cache_dir: &Path, key: &str, index: usize) -> Result<Vec<u8>, String> {
    if key.len() != 32 || !key.chars().all(|c| c.is_ascii_hexdigit()) || index == 0 || index > 5000 {
        return Err("无效的幻灯片请求".into());
    }
    std::fs::read(slides_root(cache_dir).join(key).join(format!("s{index}.png"))).map_err(|e| format!("读取幻灯片失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_count_waits_for_next_file_or_done() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("s1.png"), b"x").unwrap();
        assert_eq!(ready_count(dir.path(), 3), 0, "第 1 张可能还在写入");
        std::fs::write(dir.path().join("s2.png"), b"x").unwrap();
        assert_eq!(ready_count(dir.path(), 3), 1);
        std::fs::write(dir.path().join("s3.png"), b"x").unwrap();
        assert_eq!(ready_count(dir.path(), 3), 2);
        std::fs::write(dir.path().join("done"), b"ok").unwrap();
        assert_eq!(ready_count(dir.path(), 3), 3);
    }

    #[test]
    fn read_slide_rejects_bad_keys_and_indexes() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_slide(dir.path(), "../../etc/passwd", 1).is_err());
        assert!(read_slide(dir.path(), &"a".repeat(32), 0).is_err());
        assert!(read_slide(dir.path(), &"a".repeat(31), 1).is_err());
        assert!(read_slide(dir.path(), &"a".repeat(32), 1).is_err()); // 文件不存在
    }

    #[test]
    fn cached_requires_done_marker_and_meta() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("meta.json"), r#"{"count":2,"width":1600,"height":900}"#).unwrap();
        assert!(cached(dir.path(), "k").is_none());
        std::fs::write(dir.path().join("done"), b"ok").unwrap();
        let m = cached(dir.path(), "k").unwrap();
        assert_eq!((m.count, m.width, m.height), (2, 1600, 900));
    }

    /// 需要本机安装 PowerPoint（默认忽略）：`cargo test pptx_real -- --ignored`
    #[test]
    #[ignore]
    fn pptx_real_export() {
        let dir = tempfile::tempdir().unwrap();
        // 用 PowerPoint 自己生成一个 2 页的演示文稿
        let pptx = dir.path().join("t.pptx");
        let ps = format!(
            "$p = New-Object -ComObject PowerPoint.Application; $pr = $p.Presentations.Add(0); \
             $s = $pr.Slides.Add(1, 12); $t = $s.Shapes.AddTextbox(1, 50, 50, 400, 60); $t.TextFrame.TextRange.Text = 'one'; \
             $s2 = $pr.Slides.Add(2, 12); $pr.SaveAs('{}'); $pr.Close(); $p.Quit()",
            pptx.display()
        );
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &ps]);
        run_with_timeout(&mut cmd, Duration::from_secs(90)).expect("生成测试 pptx 失败");
        let cache = dir.path().join("cache");
        let seen = std::sync::Mutex::new(Vec::new());
        let meta = export_slides(&cache, &pptx, &|p| seen.lock().unwrap().push(p.ready)).expect("导出失败");
        assert_eq!(meta.count, 2);
        assert!(read_slide(&cache, &meta.key, 1).unwrap().starts_with(&[0x89, b'P', b'N', b'G']));
        assert_eq!(*seen.lock().unwrap().last().unwrap(), 2);
        // 第二次命中缓存
        let again = export_slides(&cache, &pptx, &|_| {}).unwrap();
        assert_eq!(again.count, 2);
    }
}
