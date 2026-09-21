import { useCallback, useEffect, useState } from "react";
import { FolderOpen, History, Loader2, Undo2 } from "lucide-react";
import { useDialog } from "../components/DialogContext";
import { useLibrary } from "../components/LibraryContext";
import * as api from "../lib/api";
import { formatSize, formatTime } from "../lib/format";
import type { VersionInfo } from "../lib/types";

/**
 * 「历史」视图（设计文档 §8.14 历史与恢复，v0.2 文本快照恢复中心）：
 * 保存前自动快照；此处可按库浏览并一键恢复。
 */
export default function HistoryView() {
  const { current, contentVersion } = useLibrary();
  const dialog = useDialog();
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);

  const reload = useCallback(async () => {
    if (!current) return;
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

  if (!current) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6">
        <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-100 text-gray-400">
          <History className="h-8 w-8" />
        </span>
        <h2 className="mt-4 text-lg font-semibold text-gray-900">尚未打开文档库</h2>
        <p className="mt-2 text-center text-[13px] text-gray-500">历史快照按文档库存放，请先打开一个文档库。</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-6 py-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">历史与恢复</h2>
        <p className="mt-0.5 text-[13px] text-gray-500">
          「{current.name}」最近的保存快照。每次保存前自动创建；每个文件保留最近 20 个版本（仅文本类文件）。
        </p>
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        {versions === null ? (
          <div className="flex h-full items-center justify-center text-gray-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : versions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-gray-200 text-gray-400">
            <FolderOpen className="h-8 w-8" />
            <p className="mt-3 text-sm">暂无历史快照</p>
            <p className="mt-1 text-xs">在编辑器中保存文件后会自动生成</p>
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
    </div>
  );
}
