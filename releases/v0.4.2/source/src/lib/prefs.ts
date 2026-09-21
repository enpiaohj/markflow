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
