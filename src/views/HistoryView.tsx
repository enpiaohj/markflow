import { useCallback, useEffect, useState } from "react";
import { FileText, FolderOpen, History, Loader2, Undo2 } from "lucide-react";
import { useDialog } from "../components/DialogContext";
import { useLibrary } from "../components/LibraryContext";
import * as api from "../lib/api";
import { formatSize, formatTime } from "../lib/format";
import type { RecentFile, VersionInfo } from "../lib/types";

/**
 * 「历史」视图（设计文档 §8.14 历史与恢复）：
 * ① 最近打开的文档（不依赖文档库，点击直接打开）；
 * ② 当前库的保存快照恢复中心（保存前自动快照，可一键恢复）。
 */
export default function HistoryView() {
  const { current, contentVersion, openPath } = useLibrary();
  const dialog = useDialog();
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [recent, setRecent] = useState<RecentFile[] | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);

  const reload = useCallback(async () => {
    if (!current) {
      setVersions([]);
      return;
    }
    try {
      setVersions(await api.listRecentVersions(current.id, 100));
    } catch (err) {
      console.error("加载历史失败", err);
      setVersions([]);
    }
  }, [current]);

  useEffect(() => {
    setVersions(null);
    void reload();
  }, [reload, contentVersion]);

  useEffect(() => {
    void api
      .listRecentFiles()
      .then(setRecent)
      .catch(() => setRecent([]));
  }, [current]);

  async function restore(v: VersionInfo) {
    if (!current || v.relativePath === null) return;
    const ok = await dialog.confirm({
      title: "恢复历史版本",
      message: `恢复「${v.relativePath}」到 ${formatTime(v.createdAt)} 的版本？\n\n当前内容会先自动保存为新的快照，可再次恢复回来。`,
      confirmText: "恢复",
    });
    if (!ok) return;
    setRestoring(v.id);
    try {
      await api.restoreFileVersion(current.id, v.relativePath, v.id);
      await reload();
    } catch (err) {
      await dialog.alert(`恢复失败：${err}`, "恢复失败");
    } finally {
      setRestoring(null);
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col overflow-y-auto px-6 py-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">历史与恢复</h2>
        <p className="mt-0.5 text-[13px] text-gray-500">最近打开的文档，以及每次保存前自动创建的快照。</p>
      </div>

      {/* 最近打开的文档 */}
      <p className="mb-2 mt-5 flex items-center gap-1.5 text-sm font-medium text-gray-700">
        <FileText className="h-4 w-4 text-gray-400" />
        最近打开的文档
      </p>
      {recent === null ? (
        <div className="flex h-16 items-center justify-center text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : recent.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-center text-xs text-gray-400">
          还没有打开过文档。打开文档后会出现在这里，点击即可再次打开。
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
          {recent.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => void openPath(f.path)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-primary-50/50"
              >
                <FileText className="h-4 w-4 shrink-0 text-gray-400" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-gray-800">
                    {f.path.replace(/\\/g, "/").split("/").pop()}
                  </span>
                  <span className="block truncate text-[11px] text-gray-400">{f.path}</span>
                </span>
                <span className="shrink-0 text-[11px] text-gray-400">{formatTime(f.openedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 保存快照 */}
      <p className="mb-2 mt-7 flex items-center gap-1.5 text-sm font-medium text-gray-700">
        <History className="h-4 w-4 text-gray-400" />
        保存快照{current ? `（${current.name}）` : ""}
      </p>
      {!current ? (
        <div className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-center text-xs text-gray-400">
          快照按文档库存放，请先打开一个文档库。
        </div>
      ) : versions === null ? (
        <div className="flex h-16 items-center justify-center text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : versions.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-200 px-4 py-8 text-gray-400">
          <FolderOpen className="h-7 w-7" />
          <p className="mt-2 text-sm">暂无保存快照</p>
          <p className="mt-1 text-xs">在编辑器中修改并保存文本类文件后，会自动生成（每个文件保留最近 20 个版本）</p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
          {versions.map((v) => (
            <li key={v.id} className="flex items-center gap-3 px-4 py-2.5">
              <History className="h-4 w-4 shrink-0 text-gray-300" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-gray-800">{v.relativePath}</p>
                <p className="text-[11px] text-gray-400">
                  {formatTime(v.createdAt)} · {formatSize(v.size)}
                </p>
              </div>
              <button
                type="button"
                disabled={restoring !== null}
                onClick={() => void restore(v)}
                className="flex shrink-0 items-center gap-1 rounded-md border border-gray-200 px-2.5 py-1 text-[11px] text-gray-600 hover:border-primary-200 hover:bg-primary-50 hover:text-primary-700 disabled:opacity-40"
              >
                {restoring === v.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
                恢复
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
