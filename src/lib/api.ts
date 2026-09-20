import { invoke } from "@tauri-apps/api/core";
import type {
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
  LibraryMeta,
  QuickScanResult,
  SaveOutcome,
  SearchHit,
  TaskInfo,
  TextFileContent,
  VersionInfo,
} from "./types";

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
): Promise<{ model: string; sensitiveHitCount: number }> {
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
