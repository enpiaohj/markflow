import { invoke } from "@tauri-apps/api/core";
import type {
  Annotation,
  AiChatRequest,
  AiTestResult,
  CheckIssue,
  ComponentStatus,
  ContextPreview,
  ConversionPrecheck,
  ConvertResult,
  CreateLibraryRequest,
  FileEntry,
  PrecheckReport,
  ProviderConfig,
  ProviderSaveRequest,
  DeliveryRecord,
  OfficePreview,
  AiChatOutcome,
  OpenTarget,
  RecentFile,
  LibraryMeta,
  QuickScanResult,
  SaveOutcome,
  SearchHit,
  TaskInfo,
  TextFileContent,
  VersionInfo,
} from "./types";

/** 打开任意文件：定位所属文档库，或进入单文件模式 */
export function openFilePath(path: string): Promise<OpenTarget> {
  return invoke("open_file_path", { path });
}

/** 取走启动参数 / 二次启动传来的待打开文件 */
export function takePendingOpenPaths(): Promise<string[]> {
  return invoke("take_pending_open_paths");
}

export function listRecentFiles(): Promise<RecentFile[]> {
  return invoke("list_recent_files");
}

/** 文件当前磁盘 mtime（窗口聚焦时检测外部修改） */
export function statFileMtime(libraryId: string, relativePath: string): Promise<number> {
  return invoke("stat_file_mtime", { libraryId, relativePath });
}

export function appInfo(): Promise<{ name: string; version: string }> {
  return invoke("app_info");
}

export function listLibraries(): Promise<LibraryMeta[]> {
  return invoke("list_libraries");
}

export function quickScanLibrary(
  rootPath: string,
  excludeDirs: string[],
): Promise<QuickScanResult> {
  return invoke("quick_scan_library", { rootPath, excludeDirs });
}

export function createLibrary(request: CreateLibraryRequest): Promise<LibraryMeta> {
  return invoke("create_library", { request });
}

export function openLibrary(id: string): Promise<LibraryMeta> {
  return invoke("open_library", { id });
}

export function removeLibrary(id: string): Promise<void> {
  return invoke("remove_library", { id });
}

export function listChildren(libraryId: string, relativePath: string): Promise<FileEntry[]> {
  return invoke("list_children", { libraryId, relativePath });
}

export function getFileDetail(libraryId: string, relativePath: string): Promise<FileEntry> {
  return invoke("get_file_detail", { libraryId, relativePath });
}

export function searchLibrary(
  libraryId: string,
  query: string,
  limit = 50,
): Promise<SearchHit[]> {
  return invoke("search_library", { libraryId, query, limit });
}

/** libraryId 传空字符串表示停止监听 */
export function setWatchedLibrary(libraryId: string): Promise<void> {
  return invoke("set_watched_library", { libraryId });
}

export function listTasks(): Promise<TaskInfo[]> {
  return invoke("list_tasks");
}

export function cancelTask(id: string): Promise<boolean> {
  return invoke("cancel_task", { id });
}

export function clearFinishedTasks(): Promise<number> {
  return invoke("clear_finished_tasks");
}

// ---------------------------------------------------------------------------
// 原生编辑（v0.2）
// ---------------------------------------------------------------------------

export function readTextFile(libraryId: string, relativePath: string): Promise<TextFileContent> {
  return invoke("read_text_file", { libraryId, relativePath });
}

export function saveTextFile(
  libraryId: string,
  relativePath: string,
  content: string,
  baseMtime: number,
  force: boolean,
): Promise<SaveOutcome> {
  return invoke("save_text_file", { libraryId, relativePath, content, baseMtime, force });
}

export function listFileVersions(libraryId: string, relativePath: string): Promise<VersionInfo[]> {
  return invoke("list_file_versions", { libraryId, relativePath });
}

export function listRecentVersions(libraryId: string, limit = 100): Promise<VersionInfo[]> {
  return invoke("list_recent_versions", { libraryId, limit });
}

export function restoreFileVersion(
  libraryId: string,
  relativePath: string,
  versionId: number,
): Promise<SaveOutcome> {
  return invoke("restore_file_version", { libraryId, relativePath, versionId });
}

// ---------------------------------------------------------------------------
// 预览与系统打开（v0.3）
// ---------------------------------------------------------------------------

export function getOfficePreview(libraryId: string, relativePath: string): Promise<OfficePreview> {
  return invoke("get_office_preview", { libraryId, relativePath });
}

/** 二进制 IPC：返回 ArrayBuffer（供 PDF.js 使用） */
export function readFileBytes(libraryId: string, relativePath: string): Promise<ArrayBuffer> {
  return invoke("read_file_bytes", { libraryId, relativePath });
}

export function openPathInSystem(libraryId: string, relativePath: string): Promise<void> {
  return invoke("open_path_in_system", { libraryId, relativePath });
}

// ---------------------------------------------------------------------------
// 转换与导入（v0.3 第二批）
// ---------------------------------------------------------------------------

export function listComponents(): Promise<ComponentStatus[]> {
  return invoke("list_components");
}

export function docxPrecheck(libraryId: string, relativePath: string): Promise<ConversionPrecheck> {
  return invoke("docx_precheck", { libraryId, relativePath });
}

export function convertDocxToMarkdown(libraryId: string, relativePath: string): Promise<ConvertResult> {
  return invoke("convert_docx_to_markdown", { libraryId, relativePath });
}

/** LibreOffice 高保真预览：返回 PDF 字节 */
export function convertOfficeToPdf(libraryId: string, relativePath: string): Promise<ArrayBuffer> {
  return invoke("convert_office_to_pdf", { libraryId, relativePath });
}

/** 导入外部文件：DOCX/HTML 转 Markdown，其余原样复制；返回入库后的相对路径 */
export function importFile(libraryId: string, targetDir: string, sourcePath: string): Promise<string> {
  return invoke("import_file", { libraryId, targetDir, sourcePath });
}

// ---------------------------------------------------------------------------
// AI 工作台（v0.4）
// ---------------------------------------------------------------------------

export function aiListProviders(): Promise<ProviderConfig[]> {
  return invoke("ai_list_providers");
}

export function aiSaveProvider(request: ProviderSaveRequest): Promise<ProviderConfig> {
  return invoke("ai_save_provider", { request });
}

export function aiUpdateProvider(id: string, request: ProviderSaveRequest): Promise<ProviderConfig> {
  return invoke("ai_update_provider", { id, request });
}

export function aiCancel(): Promise<void> {
  return invoke("ai_cancel");
}

export function aiDeleteProvider(id: string): Promise<void> {
  return invoke("ai_delete_provider", { id });
}

export function aiTestProvider(id: string): Promise<AiTestResult> {
  return invoke("ai_test_provider", { id });
}

export function aiPrepareContext(libraryId: string, contextPaths: string[]): Promise<ContextPreview> {
  return invoke("ai_prepare_context", { libraryId, contextPaths });
}

/** 流式对话：通过 Tauri Channel 逐段回调 */
export async function aiChat(
  request: AiChatRequest,
  onChunk: (text: string) => void,
): Promise<AiChatOutcome> {
  const { Channel } = await import("@tauri-apps/api/core");
  const channel = new Channel<string>();
  channel.onmessage = onChunk;
  return invoke("ai_chat", { channel, request });
}

export function checkDocument(libraryId: string, relativePath: string): Promise<CheckIssue[]> {
  return invoke("check_document", { libraryId, relativePath });
}

export function createTextFile(
  libraryId: string,
  parentDir: string,
  fileName: string,
  content: string,
): Promise<{ mtime: number; size: number }> {
  return invoke("create_text_file", { libraryId, parentDir, fileName, content });
}

export function listLibraryFiles(libraryId: string, limit = 500): Promise<FileEntry[]> {
  return invoke("list_library_files", { libraryId, limit });
}

// ---------------------------------------------------------------------------
// 正式交付中心（v0.5）
// ---------------------------------------------------------------------------

export function deliveryPrecheck(libraryId: string, sources: string[]): Promise<PrecheckReport> {
  return invoke("delivery_precheck", { libraryId, sources });
}

export function deliveryStart(
  libraryId: string,
  sources: string[],
  formats: string[],
  targetDir: string,
): Promise<DeliveryRecord> {
  return invoke("delivery_start", { libraryId, sources, formats, targetDir });
}

export function listDeliveryHistory(libraryId: string, limit = 50): Promise<DeliveryRecord[]> {
  return invoke("list_delivery_history", { libraryId, limit });
}

export function openDirectory(path: string): Promise<void> {
  return invoke("open_directory", { path });
}

// ---------------------------------------------------------------------------
// OCR 与批注（v0.4 收尾）
// ---------------------------------------------------------------------------

export function ocrAvailable(): Promise<boolean> {
  return invoke("ocr_available");
}

export function ocrFile(libraryId: string, relativePath: string): Promise<{ text: string }> {
  return invoke("ocr_file", { libraryId, relativePath });
}

export function addAnnotation(
  libraryId: string,
  relativePath: string,
  quote: string,
  body: string,
): Promise<Annotation> {
  return invoke("add_annotation", { libraryId, relativePath, quote, body });
}

export function listAnnotations(libraryId: string, relativePath: string): Promise<Annotation[]> {
  return invoke("list_annotations", { libraryId, relativePath });
}

export function setAnnotationResolved(id: string | number, resolved: boolean): Promise<void> {
  return invoke("set_annotation_resolved", { id, resolved: resolved ? 1 : 0 });
}

export function deleteAnnotation(id: string | number): Promise<void> {
  return invoke("delete_annotation", { id });
}

// ---------------------------------------------------------------------------
// 目录树文件操作（v0.2.0 后追加）
// ---------------------------------------------------------------------------

export function createLibraryDirectory(libraryId: string, parentDir: string, name: string): Promise<void> {
  return invoke("create_library_directory", { libraryId, parentDir, name });
}

export function renameLibraryEntry(libraryId: string, relativePath: string, newName: string): Promise<string> {
  return invoke("rename_library_entry", { libraryId, relativePath, newName });
}

export function moveLibraryEntry(libraryId: string, relativePath: string, targetDir: string): Promise<string> {
  return invoke("move_library_entry", { libraryId, relativePath, targetDir });
}

/** 删除进系统回收站（可还原），不物理删除 */
export function deleteLibraryEntry(libraryId: string, relativePath: string): Promise<void> {
  return invoke("delete_library_entry", { libraryId, relativePath });
}

export function listLibraryDirs(libraryId: string): Promise<string[]> {
  return invoke("list_library_dirs", { libraryId });
}

/** 手动触发指定文档库全量重扫 */
export function rescanLibrary(libraryId: string): Promise<void> {
  return invoke("rescan_library", { libraryId });
}
