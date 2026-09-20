import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronDown, Minus, Search, Square, X } from "lucide-react";

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
 * 自定义标题栏：库切换、全局搜索入口与窗口控制。
 * 窗口在 tauri.conf.json 中配置为 decorations: false。
 */
export default function TitleBar() {
  return (
    <header
      data-tauri-drag-region
      className="flex h-12 shrink-0 items-center border-b border-gray-200 bg-white"
    >
      {/* 产品标识与文档库切换 */}
      <div data-tauri-drag-region className="flex h-full items-center gap-2.5 pl-3 pr-2">
        <img src="/markflow.svg" alt="MarkFlow" className="h-6 w-6" draggable={false} />
        <span data-tauri-drag-region className="text-[15px] font-semibold text-gray-900">
          MarkFlow
        </span>
        <span className="mx-1 h-4 w-px bg-gray-200" aria-hidden="true" />
        <button
          type="button"
          title="文档库切换（将在 v0.1 后续迭代实现）"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-gray-500 hover:bg-gray-100"
        >
          未打开文档库
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
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
