import { invoke } from "@tauri-apps/api/core";
import type {
  CreateLibraryRequest,
  FileEntry,
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
