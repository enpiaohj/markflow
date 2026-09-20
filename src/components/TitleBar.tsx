import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronDown, Check, FolderOpen, FolderPlus, Minus, Search, Square, Trash2, X } from "lucide-react";
import { useLibrary } from "./LibraryContext";

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
  const { libraries, current, switchToLibrary, removeLibrary, openWizard, closeCurrentLibrary } = useLibrary();
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
    if (!confirm("确定从 MarkFlow 移除该文档库的索引记录吗？\n\n磁盘上的原文件不会被删除或修改。")) return;
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
      <div data-tauri-drag-region className="relative flex h-full items-center gap-2.5 pl-3 pr-2">
        <img src="/markflow.svg" alt="MarkFlow" className="h-6 w-6" draggable={false} />
        <span data-tauri-drag-region className="text-[15px] font-semibold text-gray-900">
          MarkFlow
        </span>
        <span className="mx-1 h-4 w-px bg-gray-200" aria-hidden="true" />
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="flex max-w-[220px] items-center gap-1.5 rounded-md px-2 py-1 text-sm text-gray-500 hover:bg-gray-100"
        >
          <span className="truncate">{current ? current.name : "未打开文档库"}</span>
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
                <p className="px-3 py-2 text-[13px] text-gray-400">尚未创建文档库</p>
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
                创建文档库…
              </button>
            </div>
          </>
        )}
      </div>

      {/* 全局搜索入口（占位） */}
      <div className="flex flex-1 justify-center">
        <div className="flex h-8 w-[420px] max-w-full items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm text-gray-400">
          <Search className="h-4 w-4 shrink-0" />
          <input
            type="text"
            readOnly
            placeholder="搜索文档、内容、标签…"
            title="全局搜索将在 v0.2 实现"
            className="w-full cursor-default bg-transparent outline-none placeholder:text-gray-400"
          />
          <kbd className="shrink-0 rounded border border-gray-200 bg-white px-1.5 py-0.5 font-sans text-[11px] text-gray-400">
            Ctrl + K
          </kbd>
        </div>
      </div>

      {/* 窗口控制 */}
      <div className="flex h-full items-center">
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
