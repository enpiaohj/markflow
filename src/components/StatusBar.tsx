import { useState } from "react";
import { Check, Minus, Plus } from "lucide-react";
import { AlertCircle, CheckCircle2, ListTodo, Loader2 } from "lucide-react";
import { useLibrary } from "./LibraryContext";
import { useTasks } from "./TasksContext";
import { useZoom, zoomPresets } from "./ZoomContext";

/**
 * 底部状态栏：当前库、索引进度、后台任务与本地优先提示（对应概念图主界面底部）。
 */
export default function StatusBar() {
  const { current: activeLib, displayLibrary, scanStatus, requestTasksView } = useLibrary();
  const current = displayLibrary ?? activeLib;
  const { runningCount } = useTasks();
  const { config, zoomIn, zoomOut, setValue, reset } = useZoom();
  const [presetOpen, setPresetOpen] = useState(false);

  let scanNode: React.ReactNode;
  if (!current) {
    scanNode = <span>未打开文档库</span>;
  } else if (scanStatus.phase === "scanning" && scanStatus.libraryId === current.id) {
    scanNode = (
      <span className="flex items-center gap-1.5 text-primary-600">
        <Loader2 className="h-3 w-3 animate-spin" />
        正在索引…
      </span>
    );
  } else if (scanStatus.phase === "failed" && scanStatus.libraryId === current.id) {
    scanNode = (
      <span className="flex items-center gap-1.5 text-red-500" title={scanStatus.error ?? undefined}>
        <AlertCircle className="h-3 w-3" />
        索引失败
      </span>
    );
  } else {
    scanNode = (
      <span className="flex items-center gap-1.5">
        <CheckCircle2 className="h-3 w-3 text-emerald-500" />
        {current.fileCount.toLocaleString()} 个文件已索引
      </span>
    );
  }

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-gray-200 bg-white px-3 text-xs text-gray-500">
      <div className="flex items-center gap-3">
        {current && (
          <>
            <span className="max-w-[220px] truncate font-medium text-gray-600" title={current.rootPath}>
              {current.settings?.adhoc ? `单文件 · ${current.name}` : current.name}
            </span>
            <span aria-hidden="true">|</span>
          </>
        )}
        {scanNode}
        <span aria-hidden="true">|</span>
        <span>本地优先 · 文件保存在原位置</span>
      </div>
      <div className="flex items-center gap-3">
        {runningCount > 0 && (
          <button
            type="button"
            onClick={requestTasksView}
            className="flex items-center gap-1.5 text-primary-600 hover:text-primary-700"
          >
            <ListTodo className="h-3 w-3" />
            {runningCount} 个任务运行中
          </button>
        )}
        {config.visible && (
          <span className="flex items-center gap-1.5" title="缩放（Ctrl + 滚轮 / Ctrl + + / Ctrl + −）">
            <button
              type="button"
              onClick={zoomOut}
              disabled={config.value <= config.min}
              aria-label="缩小"
              className="flex h-4 w-4 items-center justify-center rounded text-gray-500 hover:bg-gray-100 disabled:opacity-30"
            >
              <Minus className="h-3 w-3" />
            </button>
            <input
              type="range"
              min={config.min * 100}
              max={config.max * 100}
              step={config.step * 100}
              value={Math.round(config.value * 100)}
              onChange={(e) => setValue(Number(e.target.value) / 100)}
              className="h-1 w-24 cursor-pointer accent-primary-600"
            />
            <button
              type="button"
              onClick={zoomIn}
              disabled={config.value >= config.max}
              aria-label="放大"
              className="flex h-4 w-4 items-center justify-center rounded text-gray-500 hover:bg-gray-100 disabled:opacity-30"
            >
              <Plus className="h-3 w-3" />
            </button>
            <span className="relative">
              <button
                type="button"
                onClick={() => setPresetOpen((v) => !v)}
                onDoubleClick={reset}
                title="选择缩放比例（双击复位 100%）"
                className="w-12 rounded px-1 text-right tabular-nums text-gray-600 hover:bg-gray-100 hover:text-primary-600"
              >
                {Math.round(config.value * 100)}%
              </button>
              {presetOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setPresetOpen(false)} />
                  <div className="absolute bottom-6 right-0 z-50 w-28 rounded-lg border border-gray-200 bg-white py-1 shadow-xl">
                    {zoomPresets(config).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => {
                          setValue(v);
                          setPresetOpen(false);
                        }}
                        className="flex w-full items-center justify-between px-3 py-1 text-left text-xs text-gray-700 hover:bg-gray-50"
                      >
                        <span className="tabular-nums">{Math.round(v * 100)}%</span>
                        {Math.abs(config.value - v) < 0.005 && <Check className="h-3 w-3 text-primary-600" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </span>
          </span>
        )}
      </div>
    </footer>
  );
}
