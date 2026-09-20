/** 后端命令与事件的 TypeScript 类型镜像（与 Rust serde camelCase 输出对应） */

export interface LibraryMeta {
  id: string;
  name: string;
  rootPath: string;
  fileCount: number;
  createdAt: number;
  lastOpenedAt: number;
  settings: LibrarySettings | null;
}

export interface LibrarySettings {
  excludeDirs: string[];
  fullTextIndex: boolean;
  ocrEnabled: boolean;
  portableMeta: boolean;
}

export interface FileEntry {
  id: number;
  name: string;
  /** 以 '/' 分隔的相对路径；根目录子项的 parentPath 为 "" */
  relativePath: string;
  parentPath: string;
  isDir: boolean;
  /** 格式 id，见 src/lib/format.ts；目录为 "directory" */
  format: string;
  /** 格式显示名（后端格式注册表提供） */
  formatLabel: string;
  size: number;
  mtime: number;
}

export interface QuickScanResult {
  fileCount: number;
  dirCount: number;
  totalSize: number;
}

export interface CreateLibraryRequest {
  rootPath: string;
  name?: string;
  excludeDirs: string[];
  fullTextIndex: boolean;
  ocrEnabled: boolean;
  portableMeta: boolean;
}

/** scan:progress / scan:completed / scan:failed 事件载荷 */
export interface ScanProgressEvent {
  libraryId: string;
  fileCount: number;
  durationMs: number;
}

export interface ScanFailedEvent {
  libraryId: string;
  error: string;
}
