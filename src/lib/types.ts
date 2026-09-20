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

/** scan:completed / scan:failed / library:changed 事件载荷 */
export interface ScanProgressEvent {
  libraryId: string;
  fileCount: number;
  durationMs: number;
}

export interface ScanFailedEvent {
  libraryId: string;
  error: string;
}

/** 搜索命中：FileEntry 展开字段 + 命中信息 */
export type SearchHit = FileEntry & {
  /** 命中片段，命中位置以【】标注；文件名命中时为空 */
  snippet: string;
  /** name = 文件名命中；body = 正文命中 */
  matchedIn: "name" | "body";
};

/** 后台任务（scan:completed / tasks:updated 载荷对应 Rust tasks.rs） */
export interface TaskInfo {
  id: string;
  kind: "scan" | "rescan";
  title: string;
  status: "running" | "completed" | "failed" | "canceled";
  processed: number;
  detail: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 文本文件读取结果（含冲突检测基线） */
export interface TextFileContent {
  content: string;
  baseMtime: number;
  size: number;
}

/** 保存/恢复结果 */
export interface SaveOutcome {
  mtime: number;
  size: number;
}

/** 历史快照 */
export interface VersionInfo {
  id: number;
  relativePath: string | null;
  size: number;
  createdAt: number;
}

/** Office 快速预览（对应 Rust office.rs，按 kind 判别） */
export type OfficePreview =
  | { kind: "docx"; paragraphs: string[] }
  | { kind: "xlsx"; sheets: SheetPreview[] }
  | { kind: "pptx"; slides: SlidePreview[] };

export interface SheetPreview {
  name: string;
  rows: string[][];
  totalRows: number;
}

export interface SlidePreview {
  number: number;
  title: string;
  texts: string[];
}
