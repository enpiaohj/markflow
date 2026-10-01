/** 用户偏好（存于 WebView 本地存储；读写失败时回退默认值，不影响功能） */

const AUTOSAVE_KEY = "mf-pref-autosave";

export function getAutosave(): boolean {
  try {
    return localStorage.getItem(AUTOSAVE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAutosave(on: boolean): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, on ? "1" : "0");
    window.dispatchEvent(new CustomEvent("markflow:prefs-changed"));
  } catch {
    /* 存储不可用时忽略 */
  }
}

const OFFICE_ENGINE_KEY = "mf-pref-office-engine";

/**
 * Office 预览引擎偏好：builtin = 始终使用内置渲染（默认：即时显示、不启动 Office、有目录导航）；
 * auto = 有 Microsoft Office / LibreOffice 时优先用它们导出的精确版式。
 * 只有用户在设置里明确选过 auto 才使用 auto。
 */
export type OfficeEnginePref = "auto" | "builtin";

export function getOfficeEngine(): OfficeEnginePref {
  try {
    return localStorage.getItem(OFFICE_ENGINE_KEY) === "auto" ? "auto" : "builtin";
  } catch {
    return "builtin";
  }
}

export function setOfficeEngine(pref: OfficeEnginePref): void {
  try {
    localStorage.setItem(OFFICE_ENGINE_KEY, pref);
    window.dispatchEvent(new CustomEvent("markflow:prefs-changed"));
  } catch {
    /* 存储不可用时忽略 */
  }
}

const LARGE_MB_KEY = "mf-pref-editor-large-mb";
const MAX_MB_KEY = "mf-pref-editor-max-mb";

function readMb(key: string, fallback: number, min: number, max: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v >= min ? Math.min(v, max) : fallback;
  } catch {
    return fallback;
  }
}

/** 超过该大小（MB）进入「保护模式」：关闭语法高亮、折叠、括号联动与诊断，仍可编辑。默认 2MB。 */
export function getLargeFileMb(): number {
  return readMb(LARGE_MB_KEY, 2, 0.1, 200);
}

/** 超过该大小（MB）拒绝在应用内编辑，引导用外部工具。默认 50MB，硬上限 256MB。 */
export function getMaxEditMb(): number {
  return readMb(MAX_MB_KEY, 50, 1, 256);
}

export function setEditorSizeLimits(largeMb: number, maxMb: number): void {
  try {
    localStorage.setItem(LARGE_MB_KEY, String(largeMb));
    localStorage.setItem(MAX_MB_KEY, String(Math.max(maxMb, largeMb)));
    window.dispatchEvent(new CustomEvent("markflow:prefs-changed"));
  } catch {
    /* 存储不可用时忽略 */
  }
}

const WRAP_KEY = "mf-pref-editor-wrap";

/** 源码模式（含 .txt / 日志等纯文本）是否自动换行，默认开启 */
export function getEditorWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setEditorWrap(on: boolean): void {
  try {
    localStorage.setItem(WRAP_KEY, on ? "1" : "0");
    window.dispatchEvent(new CustomEvent("markflow:prefs-changed"));
  } catch {
    /* 存储不可用时忽略 */
  }
}

const LAYOUT_KEY = "mf-pref-library-layout";

/** 左侧文档库列表布局：selector 单库 + 顶部选择器（默认）/ side 并列多库（各库可折叠） */
export type LibraryLayoutPref = "selector" | "side";

export function getLibraryLayout(): LibraryLayoutPref {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "side" ? "side" : "selector";
  } catch {
    return "selector";
  }
}

export function setLibraryLayout(pref: LibraryLayoutPref): void {
  try {
    localStorage.setItem(LAYOUT_KEY, pref);
    window.dispatchEvent(new CustomEvent("markflow:prefs-changed"));
  } catch {
    /* 存储不可用时忽略 */
  }
}

const MAX_LIST_KEY = "mf-pref-max-list-render";
/** 「不限」的存储值：文件夹条目一次性渲染完，文件夹极大时可能明显卡顿，需用户主动选择 */
const MAX_LIST_UNLIMITED = "0";
const DEFAULT_MAX_LIST_RENDER = 2000;

/** 单个文件夹一次最多渲染的条目数（目录树 / 中央列表）；默认 2000，可调，也可选择不限（可能卡顿）。 */
export function getMaxListRender(): number {
  try {
    const v = localStorage.getItem(MAX_LIST_KEY);
    if (v === MAX_LIST_UNLIMITED) return Infinity;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_LIST_RENDER;
  } catch {
    return DEFAULT_MAX_LIST_RENDER;
  }
}

export function setMaxListRender(value: number): void {
  try {
    localStorage.setItem(MAX_LIST_KEY, value === Infinity ? MAX_LIST_UNLIMITED : String(Math.max(1, Math.round(value))));
    window.dispatchEvent(new CustomEvent("markflow:prefs-changed"));
  } catch {
    /* 存储不可用时忽略 */
  }
}

const DETAILS_PREVIEW_KEY = "mf-pref-details-preview";

/** 右侧详情面板是否显示所选文件的预览（图片 / PDF 首页 / 文本摘录），默认开启 */
export function getShowDetailsPreview(): boolean {
  try {
    return localStorage.getItem(DETAILS_PREVIEW_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setShowDetailsPreview(on: boolean): void {
  try {
    localStorage.setItem(DETAILS_PREVIEW_KEY, on ? "1" : "0");
    window.dispatchEvent(new CustomEvent("markflow:prefs-changed"));
  } catch {
    /* 存储不可用时忽略 */
  }
}

const THEME_KEY = "mf-pref-theme";

/** 主题：light 浅色（默认）/ dark 深色 / system 跟随系统 */
export type ThemePref = "light" | "dark" | "system";

export function getTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "dark" || v === "system" ? v : "light";
  } catch {
    return "light";
  }
}

/** 按偏好给 <html> 加 / 去 dark 类（深色主题通过重映射颜色变量实现，见 index.css） */
export function applyTheme(): void {
  const pref = getTheme();
  const dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function setTheme(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* 存储不可用时仍在本次会话生效 */
  }
  applyTheme();
}

/** 启动时调用：应用主题，并在「跟随系统」下响应系统主题切换 */
export function initTheme(): void {
  applyTheme();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (getTheme() === "system") applyTheme();
  });
}
