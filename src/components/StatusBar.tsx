import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { useLibrary } from "./LibraryContext";

/**
 * 底部状态栏：当前库、索引进度与本地优先提示（对应概念图主界面底部）。
 */
export default function StatusBar() {
  const { current, scanStatus } = useLibrary();

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
        {scanNode}
        <span aria-hidden="true">|</span>
        <span>本地优先 · 文件保存在原位置</span>
      </div>
      <div className="flex items-center gap-3">
        <span>v0.1.0</span>
      </div>
    </footer>
  );
}
