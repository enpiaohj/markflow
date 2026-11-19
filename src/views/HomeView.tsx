import { useEffect, useState } from "react";
import { FolderOpen, FolderPlus, Clock, FileText, X } from "lucide-react";
import FileTypeIcon from "../components/FileTypeIcon";
import { useDialog } from "../components/DialogContext";
import { useLibrary } from "../components/LibraryContext";
import * as api from "../lib/api";
import { formatTime } from "../lib/format";
import { confirmClearRecentFiles } from "../lib/recent";
import type { RecentFile } from "../lib/types";

/** 开始页每个区块最多显示的条数：常见窗口高度下首屏完整显示、不裁切；更多内容经「查看全部」进入对应页面 */
const MAX_LIBRARIES = 5;
const MAX_RECENT_FILES = 4;

/** 「开始」页：最近文档库与快速动作 */
export default function HomeView() {
  const { libraries, current, switchToLibrary, openWizard, pickAndOpenFile, openPath, openManager, requestView } = useLibrary();
  const dialog = useDialog();
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);

  useEffect(() => {
    void api.listRecentFiles().then(setRecentFiles).catch(() => setRecentFiles([]));
  }, []);

  async function removeRecent(path: string) {
    setRecentFiles((list) => list.filter((r) => r.path !== path));
    await api.removeRecentFile(path).catch((err) => console.error("移除最近文件失败", err));
  }

  async function clearRecent() {
    try {
      if (await confirmClearRecentFiles(dialog)) setRecentFiles([]);
    } catch (err) {
      console.error("清空最近文件失败", err);
    }
  }

  return (
    <div className="h-full overflow-y-auto">
    <div className="mx-auto flex min-h-full max-w-3xl flex-col px-6 py-8">
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

      <p className="mb-2.5 mt-7 flex items-center gap-1.5 text-sm font-medium text-gray-700">
        <Clock className="h-4 w-4 text-gray-400" />
        最近文档库（{libraries.length}）
        {libraries.length > MAX_LIBRARIES && (
          <button
            type="button"
            onClick={() => {
              openManager();
              requestView("library");
            }}
            className="ml-auto text-xs font-normal text-primary-600 hover:underline"
          >
            查看全部
          </button>
        )}
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
        <ul className="shrink-0 divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
          {libraries.slice(0, MAX_LIBRARIES).map((lib) => (
            <li key={lib.id}>
              <button
                type="button"
                onClick={() => void switchToLibrary(lib.id)}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-primary-50/50 ${
                  current?.id === lib.id ? "bg-primary-50/60" : ""
                }`}
              >
                <FileTypeIcon format="directory" size="sm" />
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
          <p className="mb-2.5 mt-6 flex items-center gap-1.5 text-sm font-medium text-gray-700">
            <FileText className="h-4 w-4 text-gray-400" />
            最近打开的文件
            <span className="ml-auto flex items-center gap-3 text-xs font-normal">
              {recentFiles.length > MAX_RECENT_FILES && (
                <button type="button" onClick={() => requestView("history")} className="text-primary-600 hover:underline">
                  查看全部
                </button>
              )}
              <button type="button" onClick={() => void clearRecent()} title="清空列表（不会删除文件）" className="text-gray-400 hover:text-gray-600 hover:underline">
                清空
              </button>
            </span>
          </p>
          <ul className="shrink-0 divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
            {recentFiles.slice(0, MAX_RECENT_FILES).map((f) => (
              <li key={f.path} className="group flex items-center hover:bg-primary-50/50">
                <button
                  type="button"
                  onClick={() => void openPath(f.path)}
                  className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left"
                >
                  <FileTypeIcon format="other" name={f.path.split(/[\\/]/).pop() ?? f.path} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-gray-900">{f.path.replace(/\\/g, "/").split("/").pop()}</span>
                    <span className="block truncate text-xs text-gray-400">{f.path}</span>
                  </span>
                  <span className="shrink-0 text-xs text-gray-400">{formatTime(f.openedAt)}</span>
                </button>
                <button
                  type="button"
                  title="从列表移除（不会删除文件）"
                  aria-label="从最近打开的文件中移除"
                  onClick={() => void removeRecent(f.path)}
                  className="mr-2 shrink-0 rounded-md p-1.5 text-gray-300 opacity-0 transition-opacity hover:bg-gray-100 hover:text-gray-600 focus:opacity-100 group-hover:opacity-100"
                >
                  <X className="h-3.5 w-3.5" />
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
    </div>
  );
}
