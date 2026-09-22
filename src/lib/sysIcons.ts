/** 系统（资源管理器）标准文件类型图标缓存：启动时从后端提取一次，提取失败的格式回退内置 SVG。 */

const cache = new Map<string, string>();
let loaded = false;
let loading: Promise<void> | null = null;

/** 已提取则返回 data URL，否则 undefined（调用方先用内置图标，加载完成事件后重渲染） */
export function getSysIcon(format: string): string | undefined {
  return cache.get(format);
}

export function sysIconsLoaded(): boolean {
  return loaded;
}

/** 启动时调用一次；完成（或失败）后广播 `markflow:sysicons-loaded` */
export function loadSysIcons(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const { getSysFileTypeIcons } = await import("./api");
      const map = await getSysFileTypeIcons();
      for (const [k, v] of Object.entries(map)) cache.set(k, v);
    } catch {
      /* 提取失败：全部回退内置图标 */
    } finally {
      loaded = true;
      window.dispatchEvent(new CustomEvent("markflow:sysicons-loaded"));
    }
  })();
  return loading;
}
