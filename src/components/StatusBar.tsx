/**
 * 底部状态栏：库状态、索引状态与版本信息（对应概念图主界面底部）。
 */
export default function StatusBar() {
  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-gray-200 bg-white px-3 text-xs text-gray-500">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-gray-300" aria-hidden="true" />
          未打开文档库
        </span>
        <span aria-hidden="true">|</span>
        <span>本地优先 · 文件保存在原位置</span>
      </div>
      <div className="flex items-center gap-3">
        <span>v0.1.0</span>
      </div>
    </footer>
  );
}
