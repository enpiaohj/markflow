import { invoke } from "@tauri-apps/api/core";
import type {
  CreateLibraryRequest,
  FileEntry,
  LibraryMeta,
  QuickScanResult,
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
