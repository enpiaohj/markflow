mod ai;
mod annotations;
mod checks;
mod component_manager;
mod convert;
mod delivery;
mod editor;
mod format;
mod fsops;
mod library;
mod ocr;
mod office;
mod selfwrite;
mod sensitive;
mod tasks;
mod textenc;
mod watch;

use library::{AppState, CreateLibraryRequest};
use std::path::PathBuf;
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

/// 列出库内全部文件（AI 上下文选择用）。
#[tauri::command]
fn list_library_files(
    state: State<'_, AppState>,
    library_id: String,
    limit: Option<i64>,
) -> Result<Vec<library::FileEntryDto>, String> {
    library::list_all_files(&state.0.lock().unwrap(), &library_id, limit.unwrap_or(500))
}

/// 可选组件（Pandoc / LibreOffice）健康状态。
#[tauri::command]
fn list_components() -> Vec<component_manager::ComponentStatus> {
    component_manager::list_components()
}

/// DOCX 转换前预检（加密/宏/修订/批注）。
#[tauri::command]
fn docx_precheck(
    state: State<'_, AppState>,
    library_id: String,
    relative_path: String,
) -> Result<convert::ConversionPrecheck, String> {
    let path = library_file_path(&state, &library_id, &relative_path)?;
    Ok(convert::precheck_docx(&path))
}

/// DOCX → Markdown 可编辑副本（Pandoc sidecar）：原文件不动，
/// 副本写入源目录；完成后全量重扫并让文件监听接管。
#[tauri::command]
fn convert_docx_to_markdown(
    app: AppHandle,
    state: State<'_, AppState>,
    tasks: State<'_, tasks::TaskManager>,
    library_id: String,
    relative_path: String,
) -> Result<convert::ConvertResult, String> {
    let Some(pandoc) = component_manager::detect_pandoc() else {
        return Err("未检测到 Pandoc 组件，请在设置中查看组件状态并安装后重试。".into());
    };
    let (root, format) = {
        let conn = state.0.lock().unwrap();
        let meta = library::get_library(&conn, &library_id)?;
        let format: String = conn
            .query_row(
                "SELECT format FROM files WHERE library_id = ?1 AND relative_path = ?2 AND is_dir = 0",
                rusqlite::params![library_id, relative_path],
                |row| row.get(0),
            )
            .map_err(|_| "文件不存在于文档库索引")?;
        (meta.root_path, format)
    };
    if format != "word" {
        return Err("仅 Word（DOCX）支持转换为可编辑副本".into());
    }
    let src = std::path::Path::new(&root).join(&relative_path);
    let dest_dir = src.parent().ok_or("源文件路径无效")?.to_path_buf();

    let task_id = tasks.begin(
        tasks::TaskKind::Scan,
        &format!("转换为可编辑副本 · {}", relative_path.rsplit('/').next().unwrap_or(&relative_path)),
    );
    tasks::emit_tasks(&app, &tasks);
    let result = convert::convert_to_markdown(&pandoc, &src, &dest_dir, "docx");
    match &result {
        Ok(out) => tasks.finish(
            &task_id,
            tasks::TaskStatus::Completed,
            Some(format!("生成 {}（附件 {} 个）", out.md_relative_path, out.media_count)),
            None,
        ),
        Err(e) => tasks.finish(&task_id, tasks::TaskStatus::Failed, None, Some(e.clone())),
    }
    tasks::emit_tasks(&app, &tasks);

    let out = result?;

    // 副本入库：全量重扫（复用任务中心的扫描任务与事件）
    let meta = library::get_library(&state.0.lock().unwrap(), &library_id)?;
    library::spawn_full_scan(
        app,
        state.inner().clone(),
        tasks.inner().clone(),
        meta.id.clone(),
        meta.name.clone(),
        meta.root_path.clone().into(),
        library::excludes_from(&meta.settings),
    );
    Ok(out)
}

/// LibreOffice 高保真预览：Office → PDF 字节（临时目录隔离，用后即清）。
#[tauri::command]
fn convert_office_to_pdf(
    state: State<'_, AppState>,
    library_id: String,
    relative_path: String,
) -> Result<tauri::ipc::Response, String> {
    let Some(soffice) = component_manager::detect_soffice() else {
        return Err("未检测到 LibreOffice 组件。安装 LibreOffice 后即可使用高保真预览（当前为提取文本快速预览）。".into());
    };
    let path = library_file_path(&state, &library_id, &relative_path)?;
    let bytes = convert::office_to_pdf_bytes(&soffice, &path)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 导入外部文件：DOCX/HTML 转 Markdown 副本（附件随迁），其余格式原样复制进库。
#[tauri::command]
fn import_file(
    app: AppHandle,
    state: State<'_, AppState>,
    tasks: State<'_, tasks::TaskManager>,
    library_id: String,
    target_dir: String,
    source_path: String,
) -> Result<String, String> {
    let Some(pandoc) = component_manager::detect_pandoc() else {
        return Err("未检测到 Pandoc 组件，DOCX/HTML 导入转 Markdown 需要该组件；其他格式导入不受影响。".into());
    };
    let root = library::get_library(&state.0.lock().unwrap(), &library_id)?.root_path;
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err(format!("源文件不存在: {source_path}"));
    }
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let dest_dir = if target_dir.is_empty() {
        PathBuf::from(&root)
    } else {
        PathBuf::from(&root).join(&target_dir)
    };
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("创建目标目录失败: {e}"))?;

    let task_id = tasks.begin(
        tasks::TaskKind::Scan,
        &format!("导入 · {}", src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()),
    );
    tasks::emit_tasks(&app, &tasks);

    let import_result = (|| -> Result<String, String> {
        match ext.as_str() {
            "docx" => {
                let out = convert::convert_to_markdown(&pandoc, &src, &dest_dir, "docx")?;
                Ok(out.md_relative_path)
            }
            "html" | "htm" => {
                let out = convert::convert_to_markdown(&pandoc, &src, &dest_dir, "html")?;
                Ok(out.md_relative_path)
            }
            _ => {
                let name = src.file_name().ok_or("源文件名无效")?;
                let mut dest = dest_dir.join(name);
                // 同名冲突：追加时间戳，不覆盖库内已有文件
                if dest.exists() {
                    let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                    let ext2 = src.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
                    dest = dest_dir.join(format!("{stem}-导入{}",
                        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)));
                    dest.set_extension(ext2.trim_start_matches('.'));
                }
                std::fs::copy(&src, &dest).map_err(|e| format!("复制文件失败: {e}"))?;
                Ok(dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())
            }
        }
    })();

    match &import_result {
        Ok(name) => tasks.finish(&task_id, tasks::TaskStatus::Completed, Some(format!("已导入 {name}")), None),
        Err(e) => tasks.finish(&task_id, tasks::TaskStatus::Failed, None, Some(e.clone())),
    }
    tasks::emit_tasks(&app, &tasks);

    let imported_name = import_result?;
    let meta = library::get_library(&state.0.lock().unwrap(), &library_id)?;
    library::spawn_full_scan(
        app,
        state.inner().clone(),
        tasks.inner().clone(),
        meta.id.clone(),
        meta.name.clone(),
        meta.root_path.clone().into(),
        library::excludes_from(&meta.settings),
    );
    Ok(if target_dir.is_empty() { imported_name } else { format!("{target_dir}/{imported_name}") })
}

/// AI Provider 列表（不含密钥）。
#[tauri::command]
fn ai_list_providers(state: State<'_, AppState>) -> Vec<ai::ProviderConfig> {
    ai::list_providers(&state.0.lock().unwrap())
}

/// 保存 Provider：API Key 写入系统凭据库（不落库、不回传前端）。
#[tauri::command]
fn ai_save_provider(
    state: State<'_, AppState>,
    request: ai::ProviderSaveRequest,
) -> Result<ai::ProviderConfig, String> {
    ai::save_provider(&state.0.lock().unwrap(), request)
}

#[tauri::command]
fn ai_delete_provider(state: State<'_, AppState>, id: String) -> Result<(), String> {
    ai::delete_provider(&state.0.lock().unwrap(), &id)
}

/// 连通性测试：区分网络 / 认证 / 地址 / 服务端问题。
#[tauri::command]
async fn ai_test_provider(
    state: State<'_, AppState>,
    id: String,
) -> Result<ai::TestResult, String> {
    let (base_url, key) = {
        let conn = state.0.lock().unwrap();
        let provider = ai::read_providers(&conn)
            .into_iter()
            .find(|p| p.id == id)
            .ok_or("Provider 不存在")?;
        let key = ai::provider_key(&provider.id)?;
        (provider.base_url, key)
    };
    Ok(ai::test_provider(&base_url, &key).await)
}

/// 上下文门禁第一步：组装预览（范围 / 字符 / Token 估算 / 敏感扫描），不发送。
#[tauri::command]
fn ai_prepare_context(
    state: State<'_, AppState>,
    library_id: String,
    context_paths: Vec<String>,
) -> Result<ai::ContextPreview, String> {
    let root = library::get_library(&state.0.lock().unwrap(), &library_id)?.root_path;
    ai::prepare_context_with(&root, &context_paths)
}

/// 流式对话：上下文门禁（敏感命中需 allow_sensitive 放行）→ SSE 流 → Channel 推送。
#[tauri::command]
async fn ai_chat(
    state: State<'_, AppState>,
    channel: tauri::ipc::Channel<String>,
    request: ai::AiChatRequest,
) -> Result<ai::ChatOutcome, String> {
    let (root, providers) = {
        let conn = state.0.lock().unwrap();
        let all = ai::read_providers(&conn);
        let primary = all
            .iter()
            .find(|p| p.id == request.provider_id)
            .cloned()
            .ok_or("Provider 不存在")?;
        let mut providers = vec![(primary.clone(), ai::provider_key(&primary.id)?)];
        if let Some(fid) = request.fallback_provider_id.as_deref().filter(|f| *f != primary.id) {
            if let Some(fallback) = all.iter().find(|p| p.id == fid).cloned() {
                providers.push((fallback.clone(), ai::provider_key(&fallback.id)?));
            }
        }
        let root = library::get_library(&conn, &request.library_id)?.root_path;
        (root, providers)
    };
    ai::chat(&root, providers, channel, request).await
}

/// 取消正在进行的 AI 对话。
#[tauri::command]
fn ai_cancel() {
    ai::CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// 更新 Provider（API Key 留空表示不修改）。
#[tauri::command]
fn ai_update_provider(
    state: State<'_, AppState>,
    id: String,
    request: ai::ProviderSaveRequest,
) -> Result<ai::ProviderConfig, String> {
    ai::update_provider(&state.0.lock().unwrap(), &id, request)
}

/// 文档质量检查（Markdown：标题层级 / 断链 / 空章节 / 敏感信息）。
#[tauri::command]
fn check_document(
    state: State<'_, AppState>,
    library_id: String,
    relative_path: String,
) -> Result<Vec<checks::Issue>, String> {
    let root = library::get_library(&state.0.lock().unwrap(), &library_id)?.root_path;
    let path = std::path::Path::new(&root).join(&relative_path);
    let content = textenc::decode_lossy_for_index(&std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?);
    let document_dir = path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from(&root));
    let resolver = checks::link_resolver(std::path::Path::new(&root), &document_dir);
    Ok(checks::check_markdown(&content, &resolver))
}

/// 在库内新建文本文件（AI 结果保存为新文档等）。
#[tauri::command]
fn create_text_file(
    app: AppHandle,
    state: State<'_, AppState>,
    library_id: String,
    parent_dir: String,
    file_name: String,
    content: String,
) -> Result<editor::SaveOutcome, String> {
    let outcome = editor::create_text_file(&state.0.lock().unwrap(), &library_id, &parent_dir, &file_name, &content);
    if outcome.is_ok() {
        let _ = app.emit(
            "file:saved",
            serde_json::json!({ "libraryId": library_id, "relativePath": format!("{parent_dir}/{file_name}") }),
        );
    }
    outcome
}

/// 交付预检（质量门禁 + 敏感扫描 + 来源冻结哈希）。
#[tauri::command]
fn delivery_precheck(
    state: State<'_, AppState>,
    library_id: String,
    sources: Vec<String>,
) -> Result<delivery::PrecheckReport, String> {
    let root = library::get_library(&state.0.lock().unwrap(), &library_id)?.root_path;
    delivery::precheck(std::path::Path::new(&root), &sources)
}

/// 启动交付：预检 → 冻结来源 → 后台生成/验证/原子落盘 → `delivery:completed` 事件。
#[tauri::command]
fn delivery_start(
    app: AppHandle,
    state: State<'_, AppState>,
    tasks: State<'_, tasks::TaskManager>,
    library_id: String,
    sources: Vec<String>,
    formats: Vec<String>,
    target_dir: String,
) -> Result<delivery::DeliveryRecord, String> {
    if sources.is_empty() {
        return Err("请至少选择一个交付来源文件".into());
    }
    if formats.is_empty() {
        return Err("请至少选择一种交付格式".into());
    }
    // 服务端强制预检：错误项直接阻止（交付门禁）
    let root = library::get_library(&state.0.lock().unwrap(), &library_id)?.root_path;
    let report = delivery::precheck(std::path::Path::new(&root), &sources)?;
    if !report.can_proceed {
        return Err("预检存在错误项（如敏感信息或质量错误），已按交付门禁阻止。请在来源侧修复后重试。".into());
    }

    let record = delivery::DeliveryRecord {
        id: uuid::Uuid::new_v4().to_string(),
        library_id: library_id.clone(),
        sources: report.files.clone(),
        formats: formats.clone(),
        target_dir: target_dir.clone(),
        output_dir: None,
        status: "running".into(),
        error: None,
        outputs: Vec::new(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    };
    delivery::insert_record(&state.0.lock().unwrap(), &record)?;

    let task_id = tasks.begin(tasks::TaskKind::Scan, "正式交付 · 多格式生成");
    tasks::emit_tasks(&app, &tasks);

    let app2 = app.clone();
    let tasks2 = tasks.inner().clone();
    let record_id = record.id.clone();
    let root2 = root.clone();
    let db = state.inner().0.clone();
    std::thread::spawn(move || {
        let result = delivery::execute(
            std::path::Path::new(&root2),
            &report,
            &formats,
            std::path::Path::new(&target_dir),
        );
        match &result {
            Ok(outcome) => {
                let dir = outcome.output_dir.to_string_lossy().to_string();
                let _ = delivery::update_record(
                    &db.lock().unwrap(),
                    &record_id,
                    "completed",
                    None,
                    Some(&dir),
                    &outcome.outputs,
                );
                tasks2.finish(
                    &task_id,
                    tasks::TaskStatus::Completed,
                    Some(format!("{} 个产物 → {}", outcome.outputs.len(), dir)),
                    None,
                );
            }
            Err(err) => {
                let _ = delivery::update_record(&db.lock().unwrap(), &record_id, "failed", Some(err), None, &[]);
                tasks2.finish(&task_id, tasks::TaskStatus::Failed, None, Some(err.clone()));
            }
        }
        tasks::emit_tasks(&app2, &tasks2);
        let _ = app2.emit(
            "delivery:completed",
            serde_json::json!({ "id": record_id, "ok": result.is_ok() }),
        );
    });
    Ok(record)
}

#[tauri::command]
fn list_delivery_history(
    state: State<'_, AppState>,
    library_id: String,
    limit: Option<i64>,
) -> Result<Vec<delivery::DeliveryRecord>, String> {
    delivery::list_records(&state.0.lock().unwrap(), &library_id, limit.unwrap_or(50))
}

fn library_file_path(
    state: &State<'_, AppState>,
    library_id: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let root = library::get_library(&state.0.lock().unwrap(), library_id)?.root_path;
    Ok(PathBuf::from(root).join(relative_path))
}

/// 用系统文件管理器打开目录（交付产物所在文件夹等，用户经目录选择器授权的路径）。
#[tauri::command]
fn open_directory(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).is_dir() {
        return Err("目录不存在".into());
    }
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| format!("打开目录失败: {e}"))
}


/// Windows OCR 是否可用。
#[tauri::command]
fn ocr_available() -> bool {
    ocr::available()
}

/// 识别库内图片：结果写入提取缓存与 FTS（搜索可命中图片文字），返回文本与置信度。
#[tauri::command]
async fn ocr_file(
    state: State<'_, AppState>,
    library_id: String,
    relative_path: String,
) -> Result<ocr::OcrResult, String> {
    let (root, file_id, name): (String, i64, String) = {
        let conn = state.0.lock().unwrap();
        let root = library::get_library(&conn, &library_id)?.root_path;
        let (file_id, name): (i64, String) = conn
            .query_row(
                "SELECT id, name FROM files WHERE library_id = ?1 AND relative_path = ?2 AND is_dir = 0",
                rusqlite::params![library_id, relative_path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| "图片不存在于文档库索引")?;
        (root, file_id, name)
    };
    let bytes = std::fs::read(std::path::Path::new(&root).join(&relative_path))
        .map_err(|e| format!("读取图片失败: {e}"))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("图片超过 OCR 大小上限（10 MB）".into());
    }
        let result = tauri::async_runtime::spawn_blocking(move || ocr::recognize_bytes(&bytes))
        .await
        .map_err(|e| format!("OCR 线程失败: {e}"))??;
    {
        let conn = state.0.lock().unwrap();
        library::clear_extraction(&conn, file_id).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO extracted_content (file_id, extractor_version, status, text) VALUES (?1, 'ocr-win', 'ok', ?2)",
            rusqlite::params![file_id, result.text],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO search_fts (file_id, name, body) VALUES (?1, ?2, ?3)",
            rusqlite::params![file_id, name, result.text],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(result)
}

/// 添加批注（引用选中文本）。
#[tauri::command]
fn add_annotation(
    state: State<'_, AppState>,
    library_id: String,
    relative_path: String,
    quote: String,
    body: String,
) -> Result<annotations::Annotation, String> {
    annotations::add(&state.0.lock().unwrap(), &library_id, &relative_path, &quote, &body)
}

#[tauri::command]
fn list_annotations(
    state: State<'_, AppState>,
    library_id: String,
    relative_path: String,
) -> Result<Vec<annotations::Annotation>, String> {
    annotations::list_for_file(&state.0.lock().unwrap(), &library_id, &relative_path)
}

#[tauri::command]
fn set_annotation_resolved(state: State<'_, AppState>, id: i64, resolved: bool) -> Result<(), String> {
    annotations::set_resolved(&state.0.lock().unwrap(), id, resolved)
}

#[tauri::command]
fn delete_annotation(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    annotations::delete(&state.0.lock().unwrap(), id)
}

/// 手动触发指定文档库的全量重扫（如重新打开库时刷新索引）。
#[tauri::command]
fn rescan_library(
    app: AppHandle,
    state: State<'_, AppState>,
    tasks: State<'_, tasks::TaskManager>,
    library_id: String,
) -> Result<(), String> {
    rescan_library_bg(&app, &state, &tasks, &library_id)
}

/// 新建文件夹。
#[tauri::command]
fn create_library_directory(
    app: AppHandle,
    state: State<'_, AppState>,
    tasks: State<'_, tasks::TaskManager>,
    library_id: String,
    parent_dir: String,
    name: String,
) -> Result<(), String> {
    let root = library::get_library(&state.0.lock().unwrap(), &library_id)?.root_path;
    fsops::create_directory(&root, &parent_dir, &name)?;
    rescan_library_bg(&app, &state, &tasks, &library_id)?;
    Ok(())
}

/// 重命名文件或文件夹。
#[tauri::command]
fn rename_library_entry(
    app: AppHandle,
    state: State<'_, AppState>,
    tasks: State<'_, tasks::TaskManager>,
    library_id: String,
    relative_path: String,
    new_name: String,
) -> Result<String, String> {
    let root = library::get_library(&state.0.lock().unwrap(), &library_id)?.root_path;
    let new_rel = fsops::rename_entry(&root, &relative_path, &new_name)?;
    library::migrate_path_refs(&state.0.lock().unwrap(), &library_id, &relative_path, &new_rel)?;
    rescan_library_bg(&app, &state, &tasks, &library_id)?;
    Ok(new_rel)
}

/// 移动文件或文件夹到目标目录。
#[tauri::command]
fn move_library_entry(
    app: AppHandle,
    state: State<'_, AppState>,
    tasks: State<'_, tasks::TaskManager>,
    library_id: String,
    relative_path: String,
    target_dir: String,
) -> Result<String, String> {
    let root = library::get_library(&state.0.lock().unwrap(), &library_id)?.root_path;
    let new_rel = fsops::move_entry(&root, &relative_path, &target_dir)?;
    library::migrate_path_refs(&state.0.lock().unwrap(), &library_id, &relative_path, &new_rel)?;
    rescan_library_bg(&app, &state, &tasks, &library_id)?;
    Ok(new_rel)
}

/// 删除文件或文件夹（进系统回收站，可还原）。
#[tauri::command]
fn delete_library_entry(
    app: AppHandle,
    state: State<'_, AppState>,
    tasks: State<'_, tasks::TaskManager>,
    library_id: String,
    relative_path: String,
) -> Result<(), String> {
    let root = library::get_library(&state.0.lock().unwrap(), &library_id)?.root_path;
    fsops::delete_entry(&root, &relative_path)?;
    rescan_library_bg(&app, &state, &tasks, &library_id)?;
    Ok(())
}

/// 列出库内全部目录（移动目标选择用）。
#[tauri::command]
fn list_library_dirs(state: State<'_, AppState>, library_id: String) -> Result<Vec<String>, String> {
    let conn = state.0.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT relative_path FROM files WHERE library_id = ?1 AND is_dir = 1
             ORDER BY relative_path COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![library_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

/// 后台全量重扫（文件操作后由调用方触发，走任务中心与事件）。
fn rescan_library_bg(
    app: &AppHandle,
    state: &State<'_, AppState>,
    tasks: &State<'_, tasks::TaskManager>,
    library_id: &str,
) -> Result<(), String> {
    let meta = library::get_library(&state.0.lock().unwrap(), library_id)?;
    library::spawn_full_scan(
        app.clone(),
        state.inner().clone(),
        tasks.inner().clone(),
        meta.id.clone(),
        meta.name.clone(),
        meta.root_path.clone().into(),
        library::excludes_from(&meta.settings),
    );
    Ok(())
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
            list_components,
            docx_precheck,
            ai_list_providers,
            ai_save_provider,
            ai_delete_provider,
            ai_test_provider,
            ai_prepare_context,
            ai_chat,
            ai_cancel,
            ai_update_provider,
            check_document,
            create_text_file,
            list_library_files,
            list_library_dirs,
            rescan_library,
            create_library_directory,
            rename_library_entry,
            move_library_entry,
            delete_library_entry,
            ocr_available,
            ocr_file,
            add_annotation,
            list_annotations,
            set_annotation_resolved,
            delete_annotation,
            delivery_precheck,
            delivery_start,
            list_delivery_history,
            open_directory,
            convert_docx_to_markdown,
            convert_office_to_pdf,
            import_file,
            list_file_versions,
            list_recent_versions,
            restore_file_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
