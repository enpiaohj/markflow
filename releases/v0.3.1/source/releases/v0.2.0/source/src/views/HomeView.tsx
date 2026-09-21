import { FolderOpen, FolderPlus, Clock } from "lucide-react";
import { useLibrary } from "../components/LibraryContext";
import { formatTime } from "../lib/format";

/** 「开始」页：最近文档库与快速动作 */
export default function HomeView() {
  const { libraries, current, switchToLibrary, openWizard } = useLibrary();

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-6 py-10">
      <div className="flex items-center gap-4">
        <img src="/markflow.svg" alt="" className="h-12 w-12" draggable={false} />
        <div>
          <h1 className="text-xl font-bold text-gray-900">MarkFlow</h1>
          <p className="mt-0.5 text-[13px] text-gray-500">
            多格式本地文档库 · 专业写作 · AI 协作 · 正式交付
          </p>
        </div>
      </div>

      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={openWizard}
          className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-700"
        >
          <FolderPlus className="h-4 w-4" />
          创建文档库
        </button>
        {libraries.length > 0 && (
          <button
            type="button"
            disabled={!current}
            title={current ? undefined : "请先在下方选择一个文档库"}
            onClick={() => current && void switchToLibrary(current.id)}
            className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <FolderOpen className="h-4 w-4" />
            打开当前库
          </button>
        )}
      </div>

      <p className="mb-3 mt-9 flex items-center gap-1.5 text-sm font-medium text-gray-700">
        <Clock className="h-4 w-4 text-gray-400" />
        最近文档库（{libraries.length}）
      </p>
      {libraries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 px-6 py-10 text-center">
          <p className="text-sm text-gray-500">还没有文档库</p>
          <p className="mt-1 text-xs leading-relaxed text-gray-400">
            创建文档库后，MarkFlow 会以普通文件夹为基础建立统一索引，
            <br />
            文件保持原位置、无需上传。
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
          {libraries.map((lib) => (
            <li key={lib.id}>
              <button
                type="button"
                onClick={() => void switchToLibrary(lib.id)}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-primary-50/50 ${
                  current?.id === lib.id ? "bg-primary-50/60" : ""
                }`}
              >
                <FolderOpen className="h-5 w-5 shrink-0 text-amber-500" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-gray-900">
                    {lib.name}
                    {current?.id === lib.id && (
                      <span className="ml-2 rounded bg-primary-100 px-1.5 py-0.5 text-[11px] font-normal text-primary-700">
                        当前
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-gray-400">{lib.rootPath}</span>
                </span>
                <span className="shrink-0 text-right text-xs text-gray-400">
                  <span className="block">{lib.fileCount.toLocaleString()} 个文件</span>
                  <span className="block">{formatTime(lib.lastOpenedAt)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-auto pt-8 text-center text-xs leading-relaxed text-gray-400">
        当前为 v0.1：文档库核心（建库、扫描索引、浏览）已就绪。
        <br />
        原生编辑与全文搜索将按 v0.1–v0.5 路线逐步交付。
      </p>
    </div>
  );
}
