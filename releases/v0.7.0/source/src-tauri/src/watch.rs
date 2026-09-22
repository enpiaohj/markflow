//! 文件监听（设计文档 §5.4 外部应用编辑闭环、§8.4 索引与内容提取）：
//! 外部程序修改文档库后自动重新索引。
//! 策略：notify 递归监听工作区中所有已打开的库（每库一个 watcher） → 事件去抖（1.2 秒静默）→ 全量重扫 → `library:changed` 事件。
//! 文件被 Excel 等程序占用时扫描逐条跳过（见 library.rs），等待写入稳定后自然恢复。

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::library::{self, AppState};

/// 防抖静默窗口：事件停止后等待该时长再重扫，避免复制大文件/连续保存触发多次扫描。
const DEBOUNCE: Duration = Duration::from_millis(1200);

/// 全局监听会话：按库 ID 保存，工作区内每个已打开的库一个 watcher。
pub struct WatchState(pub Mutex<HashMap<String, WatchSession>>);

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

/// 同步监听集合：只保留 `library_ids` 中的库（新增的启动，多余的停止，已存在的保持不动）。
/// 单个库启动失败（如文件夹不存在）不影响其他库，错误合并后返回。
pub fn sync_watching(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    slots: &Mutex<HashMap<String, WatchSession>>,
    library_ids: Vec<String>,
) -> Result<(), String> {
    {
        let mut map = slots.lock().unwrap();
        let stale: Vec<String> = map
            .keys()
            .filter(|id| !library_ids.contains(id))
            .cloned()
            .collect();
        for id in stale {
            if let Some(session) = map.remove(&id) {
                session.cancel.store(true, Ordering::Relaxed);
            }
        }
    }
    let mut errors = Vec::new();
    for id in library_ids {
        if slots.lock().unwrap().contains_key(&id) {
            continue;
        }
        if let Err(e) = start_watching(app, conn, slots, id) {
            errors.push(e);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

/// 开始监听指定文档库。
fn start_watching(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    slots: &Mutex<HashMap<String, WatchSession>>,
    library_id: String,
) -> Result<(), String> {

    let meta = library::get_library(conn, &library_id)?;
    if crate::openfile::is_adhoc_library(&meta) {
        return Ok(()); // 单文件模式不监听整个文件夹（外部修改由窗口聚焦时检测）
    }
    let root = std::path::PathBuf::from(&meta.root_path);
    if !root.is_dir() {
        return Err(format!("文档库文件夹不存在，停止监听: {}", meta.root_path));
    }

    let (tx, rx) = mpsc::channel::<()>();
    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                let relevant = event
                    .paths
                    .iter()
                    .any(|p| !is_ignored_path(p) && !crate::selfwrite::is_recent(p));
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

    slots.lock().unwrap().insert(session.library_id.clone(), session);
    Ok(())
}

/// 防抖到期：登记任务 → 重扫当前库 → 发送变更事件。
fn rescan_current(app: &AppHandle, library_id: &str) {
    let state = app.state::<AppState>().inner().clone();
    let tasks = app.state::<crate::tasks::TaskManager>();
    let Ok(meta) = library::get_library(&state.0.lock().unwrap(), library_id) else {
        return;
    };
    let exclude = library::excludes_from(&meta.settings);
    let root = std::path::PathBuf::from(&meta.root_path);

    let task_id = tasks.begin(
        crate::tasks::TaskKind::Rescan,
        &format!("自动重扫 · {}", meta.name),
    );
    let cancel = tasks.attach_cancel(&task_id);
    crate::tasks::emit_tasks(app, &tasks);

    let mgr = tasks.inner().clone();
    let progress = |processed: u64| {
        mgr.progress(&task_id, processed);
    };
    match library::scan_library_locked(
        &state,
        library_id,
        &root,
        &exclude,
        library::ScanOptions { cancel: Some(&cancel), on_progress: Some(&progress) },
    ) {
        Ok(outcome) => {
            mgr.finish(
                &task_id,
                crate::tasks::TaskStatus::Completed,
                Some(format!("{} 个文件 · {} 项跳过", outcome.file_count, outcome.skipped)),
                None,
            );
            let _ = app.emit(
                "library:changed",
                serde_json::json!({
                    "libraryId": library_id,
                    "fileCount": outcome.file_count,
                    "skipped": outcome.skipped,
                }),
            );
        }
        Err(err) if err == library::ERR_CANCELED => {
            mgr.finish(&task_id, crate::tasks::TaskStatus::Canceled, None, None);
        }
        Err(err) => {
            mgr.finish(&task_id, crate::tasks::TaskStatus::Failed, None, Some(err.clone()));
            let _ = app.emit(
                "library:rescan_failed",
                serde_json::json!({ "libraryId": library_id, "error": err }),
            );
        }
    }
    crate::tasks::emit_tasks(app, &mgr);
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
