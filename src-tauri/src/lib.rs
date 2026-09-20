mod editor;
mod format;
mod library;
mod office;
mod tasks;
mod watch;

use library::{AppState, CreateLibraryRequest};
use tauri::{AppHandle, Emitter, Manager, State};
use watch::WatchState;

/// 返回应用基础信息，供前端关于信息使用。
#[tauri::command]
fn app_info() -> serde_json::Value {
    serde_json::json!({
        "name": env!("CARGO_PKG_NAME"),
        "version": env!("CARGO_PKG_VERSION"),
    })
}

#[tauri::command]
fn list_libraries(state: State<'_, AppState>) -> Result<Vec<library::LibraryMeta>, String> {
    library::list_libraries(&state.0.lock().unwrap())
}

#[tauri::command]
fn quick_scan_library(root_path: String, exclude_dirs: Vec<String>) -> Result<library::QuickScanResult, String> {
    library::quick_scan(std::path::Path::new(&root_path), &exclude_dirs)
}

/// 创建文档库并立即在后台线程启动完整扫描，通过 `scan:completed` / `scan:failed` 事件通知前端。
#[tauri::command]
fn create_library(
    app: AppHandle,
    state: State<'_, AppState>,
    tasks: State<'_, tasks::TaskManager>,
    request: CreateLibraryRequest,
) -> Result<library::LibraryMeta, String> {
    let meta = library::create_library(&state.0.lock().unwrap(), request)?;
    let exclude = library::excludes_from(&meta.settings);
    library::spawn_full_scan(
        app,
        state.inner().clone(),
        tasks.inner().clone(),
        meta.id.clone(),
        meta.name.clone(),
        meta.root_path.clone().into(),
        exclude,
    );
    Ok(meta)
}

#[tauri::command]
fn open_library(state: State<'_, AppState>, id: String) -> Result<library::LibraryMeta, String> {
    library::open_library(&state.0.lock().unwrap(), &id)
}

/// 从 MarkFlow 移除文档库索引记录（不删除磁盘上的任何原文件）。
#[tauri::command]
fn remove_library(state: State<'_, AppState>, id: String) -> Result<(), String> {
    library::remove_library(&state.0.lock().unwrap(), &id)
}

/// 列出某目录直接子项；`relative_path` 传 "" 表示库根目录。
#[tauri::command]
fn list_children(
    state: State<'_, AppState>,
    library_id: String,
    relative_path: String,
) -> Result<Vec<library::FileEntryDto>, String> {
    library::list_children(&state.0.lock().unwrap(), &library_id, &relative_path)
}

#[tauri::command]
fn get_file_detail(
    state: State<'_, AppState>,
    library_id: String,
    relative_path: String,
) -> Result<library::FileEntryDto, String> {
    library::get_file_detail(&state.0.lock().unwrap(), &library_id, &relative_path)
}

/// 在当前文档库内搜索（文件名 + 正文）。
#[tauri::command]
fn search_library(
    state: State<'_, AppState>,
    library_id: String,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<library::SearchHitDto>, String> {
    library::search_library(
        &state.0.lock().unwrap(),
        &library_id,
        &query,
        limit.unwrap_or(50),
    )
}

/// 设置（或切换/停止）文件监听：`library_id` 传空字符串表示停止。
#[tauri::command]
fn set_watched_library(
    app: AppHandle,
    state: State<'_, AppState>,
    watch: State<'_, WatchState>,
    library_id: String,
) -> Result<(), String> {
    watch::start_watching(&app, &state.0.lock().unwrap(), &watch.0, library_id)
}

#[tauri::command]
fn list_tasks(tasks: State<'_, tasks::TaskManager>) -> Vec<tasks::TaskInfo> {
    tasks.list()
}

#[tauri::command]
fn cancel_task(
    app: AppHandle,
    tasks: State<'_, tasks::TaskManager>,
    id: String,
) -> bool {
    let canceled = tasks.cancel(&id);
    if canceled {
        tasks::emit_tasks(&app, &tasks);
    }
    canceled
}

#[tauri::command]
fn clear_finished_tasks(
    app: AppHandle,
    tasks: State<'_, tasks::TaskManager>,
) -> usize {
    let removed = tasks.clear_finished();
    tasks::emit_tasks(&app, &tasks);
    removed
}

/// Office 快速预览（DOCX 段落 / XLSX 工作表 / PPTX 幻灯片）。
#[tauri::command]
fn get_office_preview(
    state: State<'_, AppState>,
    library_id: String,
    relative_path: String,
) -> Result<office::OfficePreview, String> {
    let root = library::get_library(&state.0.lock().unwrap(), &library_id)?.root_path;
    let path = std::path::Path::new(&root).join(&relative_path);
    let format = crate::format::detect_format(
        relative_path.rsplit('/').next().unwrap_or(&relative_path),
    );
    office::preview(&path, format)
}

/// 读取已登记文件的原始字节（供 PDF.js 等前端渲染器使用，二进制 IPC）。
#[tauri::command]
fn read_file_bytes(
    state: State<'_, AppState>,
    library_id: String,
    relative_path: String,
) -> Result<tauri::ipc::Response, String> {
    let conn = state.0.lock().unwrap();
    let registered: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM files WHERE library_id = ?1 AND relative_path = ?2 AND is_dir = 0)",
            rusqlite::params![library_id, relative_path],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !registered {
        return Err("文件不存在于文档库索引".into());
    }
    let root = library::get_library(&conn, &library_id)?.root_path;
    drop(conn);
    let bytes = std::fs::read(std::path::Path::new(&root).join(&relative_path))
        .map_err(|e| format!("读取文件失败: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 使用系统默认应用打开已登记文件（Word/Excel/WPS 等）。
#[tauri::command]
fn open_path_in_system(
    state: State<'_, AppState>,
    library_id: String,
    relative_path: String,
) -> Result<(), String> {
    let root = library::get_library(&state.0.lock().unwrap(), &library_id)?.root_path;
    let path = std::path::Path::new(&root).join(&relative_path);
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| format!("系统打开失败: {e}"))
}

/// 读取可编辑文本文件（返回内容与冲突检测基线）。
#[tauri::command]
fn read_text_file(
    state: State<'_, AppState>,
    library_id: String,
    relative_path: String,
) -> Result<editor::TextFileContent, String> {
    editor::read_text_file(&state.0.lock().unwrap(), &library_id, &relative_path)
}

/// 保存文本文件：冲突检测 → 自动快照 → 原子写入 → 索引更新。保存后发送 `file:saved`。
#[tauri::command]
fn save_text_file(
    app: AppHandle,
    state: State<'_, AppState>,
    library_id: String,
    relative_path: String,
    content: String,
    base_mtime: i64,
    force: bool,
) -> Result<editor::SaveOutcome, String> {
    let outcome = editor::save_text_file(
        &state.0.lock().unwrap(),
        &library_id,
        &relative_path,
        &content,
        base_mtime,
        force,
    );
    if outcome.is_ok() {
        let _ = app.emit(
            "file:saved",
            serde_json::json!({
                "libraryId": library_id,
                "relativePath": relative_path,
            }),
        );
    }
    outcome
}

#[tauri::command]
fn list_file_versions(
    state: State<'_, AppState>,
    library_id: String,
    relative_path: String,
) -> Result<Vec<editor::VersionInfo>, String> {
    editor::list_file_versions(&state.0.lock().unwrap(), &library_id, &relative_path)
}

#[tauri::command]
fn list_recent_versions(
    state: State<'_, AppState>,
    library_id: String,
    limit: Option<i64>,
) -> Result<Vec<editor::VersionInfo>, String> {
    editor::list_recent_versions(&state.0.lock().unwrap(), &library_id, limit.unwrap_or(100))
}

/// 恢复历史版本（恢复前自动快照当前内容）。完成后发送 `file:saved`。
#[tauri::command]
fn restore_file_version(
    app: AppHandle,
    state: State<'_, AppState>,
    library_id: String,
    relative_path: String,
    version_id: i64,
) -> Result<editor::SaveOutcome, String> {
    let outcome = editor::restore_file_version(&state.0.lock().unwrap(), &library_id, &relative_path, version_id);
    if outcome.is_ok() {
        let _ = app.emit(
            "file:saved",
            serde_json::json!({
                "libraryId": library_id,
                "relativePath": relative_path,
            }),
        );
    }
    outcome
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let conn = library::init_db(app.handle())?;
            app.manage(AppState(std::sync::Arc::new(std::sync::Mutex::new(conn))));
            app.manage(WatchState(std::sync::Mutex::new(None)));
            app.manage(tasks::TaskManager::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            list_libraries,
            quick_scan_library,
            create_library,
            open_library,
            remove_library,
            list_children,
            get_file_detail,
            search_library,
            set_watched_library,
            list_tasks,
            cancel_task,
            clear_finished_tasks,
            read_text_file,
            save_text_file,
            get_office_preview,
            read_file_bytes,
            open_path_in_system,
            list_file_versions,
            list_recent_versions,
            restore_file_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
