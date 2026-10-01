import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronDown, Check, FolderOpen, FolderPlus, Minus, Search, Square, Trash2, X } from "lucide-react";
import * as api from "../lib/api";
import { useDialog } from "./DialogContext";
import { useLibrary } from "./LibraryContext";
import TabStrip from "./TabStrip";
import MenuBar from "./MenuBar";

const appWindow = getCurrentWindow();

function WindowButton({
  onClick,
  label,
  danger,
  children,
}: {
  onClick: () => void;
  label: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-full w-11 items-center justify-center text-gray-500 transition-colors ${
        danger ? "hover:bg-red-500 hover:text-white" : "hover:bg-gray-100"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * 自定义标题栏：文档库切换、全局搜索入口与窗口控制。
 * 窗口在 tauri.conf.json 中配置为 decorations: false。
 */
export default function TitleBar() {
  const { libraries, current, switchToLibrary, removeLibrary, openWizard, closeCurrentLibrary, requestSearchView, tabs } = useLibrary();
  const [version, setVersion] = useState("");
  useEffect(() => {
    void api.appInfo().then((i) => setVersion(i.version)).catch(() => {});
  }, []);
  const dialog = useDialog();
  const [menuOpen, setMenuOpen] = useState(false);

  async function handleSwitch(id: string) {
    setMenuOpen(false);
    try {
      await switchToLibrary(id);
    } catch (err) {
      console.error("切换文档库失败", err);
    }
  }

  async function handleRemove(id: string) {
    const ok = await dialog.confirm({
      title: "移除文档库",
      message: "确定从 MarkFlow 移除该文档库的索引记录吗？\n\n磁盘上的原文件不会被删除或修改。",
      confirmText: "移除",
      danger: true,
    });
    if (!ok) return;
    try {
      await removeLibrary(id);
    } catch (err) {
      console.error("移除文档库失败", err);
    }
  }

  return (
    <header
      data-tauri-drag-region
      className="flex h-12 shrink-0 items-center border-b border-gray-200 bg-white"
    >
      {/* 产品标识与文档库切换 */}
      <div data-tauri-drag-region className="relative flex h-full min-w-0 shrink items-center gap-2.5 pl-3 pr-2">
        <img src="/markflow.png" alt="MarkFlow" className="h-6 w-6 shrink-0" draggable={false} />
        <span data-tauri-drag-region className="shrink-0 whitespace-nowrap text-[15px] font-semibold text-gray-900">
          MarkFlow
        </span>
        {version && (
          <span data-tauri-drag-region className="hidden shrink-0 whitespace-nowrap text-[11px] text-gray-400 xl:inline" title={`MarkFlow v${version}`}>
            v{version}
          </span>
        )}
        <span className="mx-1 h-4 w-px shrink-0 bg-gray-200" aria-hidden="true" />
        <MenuBar />
        <span className="mx-1 h-4 w-px shrink-0 bg-gray-200" aria-hidden="true" />
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="flex min-w-0 max-w-[220px] items-center gap-1.5 rounded-md px-2 py-1 text-sm text-gray-500 hover:bg-gray-100"
        >
          <span className="truncate">
            {current ? (current.settings?.adhoc ? `单文件 · ${current.name}` : current.name) : "未打开文档库"}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </button>

        {menuOpen && (
          <>
            {/* 点击遮罩关闭菜单 */}
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div className="absolute left-3 top-11 z-50 w-80 rounded-xl border border-gray-200 bg-white py-1.5 shadow-xl">
              <p className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                文档库（{libraries.length}）
              </p>
              {libraries.length === 0 && (
                <p className="px-3 py-2 text-[13px] text-gray-400">尚未添加文档库</p>
              )}
              {libraries.map((lib) => (
                <div
                  key={lib.id}
                  className="group flex items-center gap-1 px-1.5 hover:bg-gray-50"
                >
                  <button
                    type="button"
                    onClick={() => handleSwitch(lib.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left"
                  >
                    <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-[13px] font-medium text-gray-800">
                        <span className="truncate">{lib.name}</span>
                        {current?.id === lib.id && <Check className="h-3.5 w-3.5 shrink-0 text-primary-600" />}
                      </span>
                      <span className="block truncate text-[11px] text-gray-400">{lib.rootPath}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    title="从 MarkFlow 移除索引（不删除原文件）"
                    onClick={() => handleRemove(lib.id)}
                    className="rounded-md p-1.5 text-gray-300 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <div className="my-1 h-px bg-gray-100" />
              {current && (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    closeCurrentLibrary();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3.5 py-2 text-[13px] text-gray-600 hover:bg-gray-50"
                >
                  <X className="h-4 w-4 text-gray-400" />
                  关闭当前文档库
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  openWizard();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3.5 py-2 text-[13px] text-gray-700 hover:bg-gray-50"
              >
                <FolderPlus className="h-4 w-4 text-primary-600" />
                添加文档库…
              </button>
            </div>
          </>
        )}
      </div>

      {/* 全局搜索入口：点击或 Ctrl+K 进入搜索视图 */}
      <TabStrip />
      <div data-tauri-drag-region className={`flex min-w-0 justify-center px-2 ${tabs.length > 0 ? "shrink" : "flex-1"}`}>
        <button
          type="button"
          onClick={requestSearchView}
          title="搜索文件名与正文（Ctrl + K）"
          className={`flex h-8 max-w-full items-center rounded-lg border border-gray-200 bg-gray-50 text-sm text-gray-400 hover:border-gray-300 hover:bg-white ${
            tabs.length > 0
              ? "w-8 shrink-0 justify-center 2xl:w-[200px] 2xl:justify-start 2xl:gap-2 2xl:px-3" // 有标签时优先把宽度让给标签栏：窄屏收成图标
              : "w-[420px] gap-2 px-3"
          }`}
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className={`min-w-0 flex-1 truncate text-left ${tabs.length > 0 ? "hidden 2xl:inline" : ""}`}>搜索文档、内容、标签…</span>
          <kbd className={`${tabs.length > 0 ? "hidden" : "hidden xl:inline"} shrink-0 rounded border border-gray-200 bg-white px-1.5 py-0.5 font-sans text-[11px] text-gray-400`}>
            Ctrl + K
          </kbd>
        </button>
      </div>

      {/* 窗口控制：始终完整显示，不被其他内容挤出窗口 */}
      <div className="flex h-full shrink-0 items-center">
        <WindowButton onClick={() => appWindow.minimize()} label="最小化">
          <Minus className="h-4 w-4" />
        </WindowButton>
        <WindowButton onClick={() => appWindow.toggleMaximize()} label="最大化 / 还原">
          <Square className="h-3.5 w-3.5" />
        </WindowButton>
        <WindowButton onClick={() => appWindow.close()} label="关闭" danger>
          <X className="h-4 w-4" />
        </WindowButton>
      </div>
    </header>
  );
}
