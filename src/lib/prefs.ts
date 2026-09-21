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
