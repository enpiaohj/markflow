mod format;
mod library;
mod watch;

use library::{AppState, CreateLibraryRequest};
use tauri::{AppHandle, Manager, State};
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
    request: CreateLibraryRequest,
) -> Result<library::LibraryMeta, String> {
    let meta = library::create_library(&state.0.lock().unwrap(), request)?;
    let exclude = library::excludes_from(&meta.settings);
    library::spawn_full_scan(
        app,
        state.inner().clone(),
        meta.id.clone(),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let conn = library::init_db(app.handle())?;
            app.manage(AppState(std::sync::Arc::new(std::sync::Mutex::new(conn))));
            app.manage(WatchState(std::sync::Mutex::new(None)));
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
