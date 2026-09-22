import { useEffect, useState } from "react";
import { FolderOpen, FolderPlus, Clock, FileText } from "lucide-react";
import FileTypeIcon from "../components/FileTypeIcon";
import { useLibrary } from "../components/LibraryContext";
import * as api from "../lib/api";
import { formatTime } from "../lib/format";
import type { RecentFile } from "../lib/types";

/** 「开始」页：最近文档库与快速动作 */
export default function HomeView() {
  const { libraries, current, switchToLibrary, openWizard, pickAndOpenFile, openPath } = useLibrary();
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);

  useEffect(() => {
    void api.listRecentFiles().then(setRecentFiles).catch(() => setRecentFiles([]));
  }, []);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-6 py-10">
      <div className="flex items-center gap-4">
        <img src="/markflow.png" alt="" className="h-12 w-12" draggable={false} />
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
          添加文档库
        </button>
        <button
          type="button"
          onClick={() => void pickAndOpenFile()}
          title="直接打开并编辑任意文件（Ctrl + O），无需先建立文档库"
          className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          <FileText className="h-4 w-4" />
          打开文件…
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
            添加文档库后，MarkFlow 会以普通文件夹为基础建立统一索引，
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

      {recentFiles.length > 0 && (
        <>
          <p className="mb-3 mt-8 flex items-center gap-1.5 text-sm font-medium text-gray-700">
            <FileText className="h-4 w-4 text-gray-400" />
            最近打开的文件
          </p>
          <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
            {recentFiles.slice(0, 6).map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => void openPath(f.path)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-primary-50/50"
                >
                  <FileTypeIcon format="other" name={f.path.split(/[\\/]/).pop() ?? f.path} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-gray-900">{f.path.replace(/\\/g, "/").split("/").pop()}</span>
                    <span className="block truncate text-xs text-gray-400">{f.path}</span>
                  </span>
                  <span className="shrink-0 text-xs text-gray-400">{formatTime(f.openedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="mt-auto pt-8 text-center text-xs leading-relaxed text-gray-400">
        本地优先：文件始终保存在原位置，MarkFlow 只保存索引与元数据。
        <br />
        可通过「文件 → 打开文件」直接编辑任意文件，也可添加文档库获得统一搜索与管理。
      </p>
    </div>
  );
}
