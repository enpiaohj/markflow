//! 文件监听（设计文档 §5.4 外部应用编辑闭环、§8.4 索引与内容提取）：
//! 外部程序修改文档库后自动重新索引。
//! 策略：notify 递归监听当前库 → 事件去抖（1.2 秒静默）→ 全量重扫 → `library:changed` 事件。
//! 文件被 Excel 等程序占用时扫描逐条跳过（见 library.rs），等待写入稳定后自然恢复。

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::library::{self, AppState};

/// 防抖静默窗口：事件停止后等待该时长再重扫，避免复制大文件/连续保存触发多次扫描。
const DEBOUNCE: Duration = Duration::from_millis(1200);

/// 全局监听会话：同一时间只监听一个库（当前打开的库）。
pub struct WatchState(pub Mutex<Option<WatchSession>>);

pub struct WatchSession {
    #[allow(dead_code)] // 字段仅用于标识与调试，drop watcher 本身即停止监听
    pub library_id: String,
    pub cancel: std::sync::Arc<AtomicBool>,
    /// drop 即关闭监听并断开通知通道，防抖线程随之退出
    _watcher: RecommendedWatcher,
}

/// 判断路径是否位于排除目录/隐藏目录内（过滤构建产物噪声）。
fn is_ignored_path(path: &Path) -> bool {
    for comp in path.components() {
        let name = comp.as_os_str().to_string_lossy();
        if name.len() > 1 && name.starts_with('.') {
            return true;
        }
        if library::DEFAULT_EXCLUDE_DIRS
            .iter()
            .any(|d| d.eq_ignore_ascii_case(&name))
        {
            return true;
        }
    }
    false
}

/// 开始监听指定文档库；`library_id` 为空表示停止监听。
pub fn start_watching(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    slot: &Mutex<Option<WatchSession>>,
    library_id: String,
) -> Result<(), String> {
    stop_watching(slot);
    if library_id.is_empty() {
        return Ok(());
    }

    let meta = library::get_library(conn, &library_id)?;
    let root = std::path::PathBuf::from(&meta.root_path);
    if !root.is_dir() {
        return Err(format!("文档库文件夹不存在，停止监听: {}", meta.root_path));
    }

    let (tx, rx) = mpsc::channel::<()>();
    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                let relevant = event.paths.iter().any(|p| !is_ignored_path(p));
                if relevant {
                    let _ = tx.send(());
                }
            }
        })
        .map_err(|e| format!("无法启动文件监听: {e}"))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("文件监听启动失败: {e}"))?;

    let cancel = std::sync::Arc::new(AtomicBool::new(false));
    let session = WatchSession {
        library_id: library_id.clone(),
        cancel: cancel.clone(),
        _watcher: watcher,
    };

    let app = app.clone();
    std::thread::spawn(move || {
        let mut pending = false;
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(()) => pending = true,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if cancel.load(Ordering::Relaxed) {
                        return;
                    }
                    if pending {
                        pending = false;
                        rescan_current(&app, &library_id);
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });

    *slot.lock().unwrap() = Some(session);
    Ok(())
}

/// 停止监听（幂等）。
pub fn stop_watching(slot: &Mutex<Option<WatchSession>>) {
    if let Some(session) = slot.lock().unwrap().take() {
        session.cancel.store(true, Ordering::Relaxed);
        // session drop → watcher 关闭 → 通道断开 → 防抖线程退出
    }
}

/// 防抖到期：重扫当前库并发送变更事件。
fn rescan_current(app: &AppHandle, library_id: &str) {
    let state = app.state::<AppState>();
    let conn = state.0.lock().unwrap();
    let Ok(meta) = library::get_library(&conn, library_id) else {
        return;
    };
    let exclude = library::excludes_from(&meta.settings);
    let root = std::path::PathBuf::from(&meta.root_path);
    match library::scan_library_now(&conn, library_id, &root, &exclude) {
        Ok(outcome) => {
            drop(conn);
            let _ = app.emit(
                "library:changed",
                serde_json::json!({
                    "libraryId": library_id,
                    "fileCount": outcome.file_count,
                    "skipped": outcome.skipped,
                }),
            );
        }
        Err(err) => {
            drop(conn);
            let _ = app.emit(
                "library:rescan_failed",
                serde_json::json!({ "libraryId": library_id, "error": err }),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignored_paths_are_filtered() {
        assert!(is_ignored_path(Path::new("D:/lib/node_modules/pkg/index.js")));
        assert!(is_ignored_path(Path::new("D:/lib/.git/objects/ab/cd")));
        assert!(is_ignored_path(Path::new("D:/lib/target/debug/app.exe")));
        assert!(!is_ignored_path(Path::new("D:/lib/03_技术方案/设计.md")));
        assert!(!is_ignored_path(Path::new("D:/lib/README.md")));
    }
}
