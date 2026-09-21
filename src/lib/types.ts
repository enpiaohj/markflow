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
  /** 单文件模式的隐式库（不出现在文档库列表） */
  adhoc?: boolean;
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
  /** 检测到的磁盘编码（UTF-8 / UTF-8 BOM / UTF-16 / GBK），保存时按原编码写回 */
  encoding: string;
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
  | { kind: "docx"; paragraphs: string[]; headings: DocxHeading[] }
  | { kind: "xlsx"; sheets: SheetPreview[] }
  | { kind: "pptx"; slides: SlidePreview[] };

/** XLSX 原生表格视图 */
export interface XlsxView {
  sheets: XSheet[];
  styles: XStyle[];
}

export interface XSheet {
  name: string;
  rows: XRow[];
  colWidths: number[];
  merges: [number, number, number, number][];
  frozenRows: number;
  frozenCols: number;
  showGrid: boolean;
  colCount: number;
  totalRows: number;
  truncated: boolean;
}

export interface XRow {
  r: number;
  h: number | null;
  cells: XCell[];
}

export interface XCell {
  c: number;
  v: string;
  s: number;
  num: boolean;
}

export interface XStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string | null;
  bg: string | null;
  size: number | null;
  align: string | null;
  valign: string | null;
  wrap: boolean;
  border: number;
}

export interface DocxHeading {
  level: number;
  text: string;
}

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

/** 可选组件状态（Pandoc / LibreOffice） */
export interface ComponentStatus {
  name: string;
  label: string;
  found: boolean;
  version: string;
  path: string;
}

/** 转换前预检结果 */
export interface ConversionPrecheck {
  ok: boolean;
  blocked: string | null;
  warnings: string[];
}

/** 转换结果 */
export interface ConvertResult {
  mdRelativePath: string;
  mediaRelativeDir: string;
  mediaCount: number;
}

// ---------------------------------------------------------------------------
// AI 工作台（v0.4）
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
}

export interface ProviderSaveRequest {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface AiTestResult {
  ok: boolean;
  category: "ok" | "network" | "auth" | "not_found" | "server";
  message: string;
}

export interface SensitiveHit {
  kind: string;
  label: string;
  /** 所属文件（相对路径）；用户输入为「（输入内容）」 */
  file: string;
  line: number;
  masked: string;
}

export interface ContextFile {
  relativePath: string;
  chars: number;
  truncated: boolean;
  skipped: string | null;
}

export interface ContextPreview {
  files: ContextFile[];
  totalChars: number;
  estimatedTokens: number;
  sensitiveHits: SensitiveHit[];
}

export interface AiChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiChatRequest {
  providerId: string;
  libraryId: string;
  contextPaths: string[];
  messages: AiChatMessage[];
  allowSensitive: boolean;
  /** 备用 Provider（可选；主 Provider 网络失败 / 429 / 5xx 且尚无输出时回退） */
  fallbackProviderId?: string;
}

export interface AiChatOutcome {
  model: string;
  providerName: string;
  usedFallback: boolean;
  sensitiveHitCount: number;
}

/** 打开任意文件的解析结果 */
export interface OpenTarget {
  libraryId: string;
  relativePath: string;
  format: string;
  /** 单文件模式：文件不在任何文档库内 */
  adhoc: boolean;
}

export interface RecentFile {
  path: string;
  openedAt: number;
}

/** 质量检查问题（§8.9：error 可阻止交付） */
export interface CheckIssue {
  severity: "error" | "warning" | "info";
  line: number;
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// 正式交付中心（v0.5）
// ---------------------------------------------------------------------------

export interface SourceFile {
  relativePath: string;
  sha256: string;
  size: number;
}

export interface PrecheckIssue {
  relativePath: string;
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface PrecheckReport {
  canProceed: boolean;
  files: SourceFile[];
  issues: PrecheckIssue[];
}

export interface DeliveryRecord {
  id: string;
  libraryId: string;
  sources: SourceFile[];
  formats: string[];
  targetDir: string;
  outputDir: string | null;
  status: "running" | "completed" | "failed";
  error: string | null;
  outputs: string[];
  createdAt: number;
}

export interface OcrResult {
  text: string;
}

export interface Annotation {
  id: number;
  relativePath: string;
  quote: string;
  body: string;
  resolved: boolean;
  createdAt: number;
  /** 引用文本当前是否仍存在于文件中；null 表示无法判断（如文件不可读） */
  quotePresent: boolean | null;
}
