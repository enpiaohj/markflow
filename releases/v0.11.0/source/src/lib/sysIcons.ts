/**
 * 系统（资源管理器）标准文件图标缓存：按扩展名向后端取图标（PNG data URL）。
 *
 * - 组件首次渲染某扩展名时登记，同一帧内的请求合并为一次 IPC；
 * - 通过 useSyncExternalStore 订阅，只有图标真正变化的组件才重渲染；
 * - 系统没有图标或提取失败的扩展名记为「无」，组件回退内置 SVG，不再重复请求。
 */
import { useSyncExternalStore } from "react";

/** 文件夹图标的键（与后端 sysicon::FOLDER_KEY 一致） */
export const FOLDER_KEY = "<folder>";

/** 启动时预取的常见扩展名，减少首屏图标由内置图标切换为系统图标的闪动 */
const PRELOAD = [FOLDER_KEY, "txt", "md", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "pdf", "png", "jpg", "zip", "json", "csv", "xml", "html", "log"];

/** 键 → data URL；null 表示已请求但系统没有可用图标 */
const icons = new Map<string, string | null>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let flushScheduled = false;

function notify() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function flush() {
  flushScheduled = false;
  const keys = [...pending];
  pending.clear();
  if (keys.length === 0) return;
  void import("./api")
    .then(({ getFileIcons }) => getFileIcons(keys))
    .then((map) => {
      for (const k of keys) icons.set(k, map[k] ?? null);
    })
    .catch(() => {
      for (const k of keys) icons.set(k, null);
    })
    .finally(notify);
}

function request(key: string) {
  if (icons.has(key) || pending.has(key)) return;
  pending.add(key);
  if (!flushScheduled) {
    flushScheduled = true;
    // 合并同一轮渲染中所有新出现的扩展名
    setTimeout(flush, 0);
  }
}

/** 文件名 → 扩展名键（小写、无点；无扩展名或以点开头的隐藏文件为空串） */
export function iconKeyForName(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : "";
}

/** 取某扩展名的系统图标（尚未取到或没有时为 undefined），并在首次使用时触发请求 */
export function useSysIcon(key: string | null): string | undefined {
  const url = useSyncExternalStore(subscribe, () => (key === null ? null : icons.get(key)));
  if (key !== null && !icons.has(key)) request(key);
  return url ?? undefined;
}

/** 应用启动时预取常见扩展名 */
export function preloadSysIcons(): void {
  for (const k of PRELOAD) request(k);
}
