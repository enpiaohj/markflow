import { FolderOpen } from "lucide-react";

/** 「文档库」页：目录树、文件列表与详情面板的空状态 */
export default function LibraryView() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-100 text-gray-400">
        <FolderOpen className="h-8 w-8" />
      </span>
      <h2 className="mt-4 text-lg font-semibold text-gray-900">尚未打开文档库</h2>
      <p className="mt-2 max-w-sm text-center text-[13px] leading-relaxed text-gray-500">
        MarkFlow 以普通本地文件夹为基础创建文档库：
        不移动、不复制、不修改你的任何文件，所有内容始终保存在原位置。
      </p>
      <button
        type="button"
        title="建库向导将在 v0.1 后续迭代实现"
        className="mt-6 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
      >
        创建文档库
      </button>
    </div>
  );
}
