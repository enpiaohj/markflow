/** 格式 id → 显示名 / 图标配色映射（与 Rust format.rs 的注册表对应） */

export interface FormatStyle {
  /** 徽标背景色（Tailwind 类） */
  badgeClass: string;
  /** 徽标文字（大多数格式用首字母） */
  badgeText: string;
}

const FORMAT_STYLES: Record<string, FormatStyle> = {
  markdown: { badgeClass: "bg-sky-500", badgeText: "M" },
  text: { badgeClass: "bg-gray-400", badgeText: "T" },
  code: { badgeClass: "bg-slate-600", badgeText: "</>" },
  json: { badgeClass: "bg-amber-500", badgeText: "{}" },
  yaml: { badgeClass: "bg-orange-400", badgeText: "Y" },
  xml: { badgeClass: "bg-lime-600", badgeText: "X" },
  config: { badgeClass: "bg-stone-500", badgeText: "C" },
  csv: { badgeClass: "bg-emerald-600", badgeText: "C" },
  word: { badgeClass: "bg-blue-600", badgeText: "W" },
  excel: { badgeClass: "bg-green-600", badgeText: "X" },
  powerpoint: { badgeClass: "bg-orange-500", badgeText: "P" },
  pdf: { badgeClass: "bg-red-500", badgeText: "PDF" },
  image: { badgeClass: "bg-violet-500", badgeText: "IMG" },
  archive: { badgeClass: "bg-yellow-600", badgeText: "ZIP" },
  audio: { badgeClass: "bg-pink-500", badgeText: "♪" },
  video: { badgeClass: "bg-rose-500", badgeText: "▶" },
  directory: { badgeClass: "bg-amber-400", badgeText: "D" },
  other: { badgeClass: "bg-gray-300", badgeText: "?" },
};

export function formatStyle(format: string): FormatStyle {
  return FORMAT_STYLES[format] ?? FORMAT_STYLES.other;
}

/** 字节数 → 人类可读大小 */
export function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

/** epoch 毫秒 → 本地日期时间 */
export function formatTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 支持在 MarkFlow 中直接编辑的格式（与 Rust TEXT_FORMATS 一致） */
export const EDITABLE_FORMATS: ReadonlySet<string> = new Set([
  "markdown",
  "text",
  "code",
  "json",
  "yaml",
  "xml",
  "config",
  "csv",
]);

/** 双击 / 打开文件时的统一路由：内置查看器、编辑器，或交给系统应用 */
export type OpenRoute = "pdf" | "office" | "image" | "editor" | "system";

export function openRouteFor(format: string): OpenRoute {
  if (format === "pdf") return "pdf";
  if (format === "word" || format === "excel" || format === "powerpoint") return "office";
  if (format === "image") return "image";
  if (EDITABLE_FORMATS.has(format)) return "editor";
  return "system";
}

/** 由文件名判断 Office 应用类别 */
export function officeKind(name: string): "word" | "excel" | "powerpoint" | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["docx", "doc", "docm", "odt", "rtf"].includes(ext)) return "word";
  if (["xlsx", "xls", "xlsm", "ods"].includes(ext)) return "excel";
  if (["pptx", "ppt", "pptm", "odp"].includes(ext)) return "powerpoint";
  return null;
}
