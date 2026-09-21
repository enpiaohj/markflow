import { useMemo } from "react";
import { FolderOpen, FolderPlus, Trash2, X } from "lucide-react";
import { useLibrary } from "./LibraryContext";
import { useDialog } from "./DialogContext";

/**
 * 管理文档库：列出索引中的全部文档库。
 * 「关闭」只是从当前工作区拿掉（仍保留在列表里，随时可再打开）；
 * 「移除」是删除该库的索引记录（原文件不动；重新添加同一文件夹时，历史版本 / 批注 / 交付记录会恢复）。
 */
export default function LibraryManager() {
  const { managerOpen, closeManager, libraries, workspace, current, switchToLibrary, closeLibraryInWorkspace, removeLibrary, openWizard } = useLibrary();
  const dialog = useDialog();
  const list = useMemo(
    () => libraries.filter((l) => !l.settings?.adhoc).sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN") || a.id.localeCompare(b.id)),
    [libraries],
  );
  if (!managerOpen) return null;

  async function remove(id: string, name: string) {
    const ok = await dialog.confirm({
      title: `移除文档库「${name}」`,
      message:
        "将从 MarkFlow 中移除该文档库的索引记录。\n\n" +
        "· 磁盘上的原文件不会被删除或修改\n" +
        "· 之后可通过「添加文档库」重新选择该文件夹再次打开\n" +
        "· 历史版本、批注、交付记录会保留，重新添加同一文件夹后自动恢复",
      confirmText: "移除",
      danger: true,
    });
    if (!ok) return;
    try {
      await removeLibrary(id);
    } catch (err) {
      await dialog.alert(String(err), "移除失败");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={closeManager}>
      <div className="flex max-h-[80vh] w-[640px] max-w-[94vw] flex-col rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <div>
            <h3 className="text-[15px] font-semibold text-gray-900">管理文档库</h3>
            <p className="mt-0.5 text-xs text-gray-400">关闭只是从当前窗口拿掉；移除会删除索引记录（不删除原文件）。</p>
          </div>
          <button type="button" aria-label="关闭" onClick={closeManager} className="rounded p-1 text-gray-400 hover:bg-gray-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {list.length === 0 && <p className="py-10 text-center text-sm text-gray-400">还没有文档库</p>}
          {list.map((lib) => {
            const opened = workspace.some((w) => w.id === lib.id);
            const isCurrent = current?.id === lib.id;
            return (
              <div key={lib.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-gray-50">
                <FolderOpen className={`h-5 w-5 shrink-0 ${isCurrent ? "text-primary-600" : "text-gray-400"}`} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-[13px] font-semibold text-gray-900">
                    <span className="truncate">{lib.name}</span>
                    {isCurrent ? (
                      <span className="shrink-0 rounded bg-primary-50 px-1.5 text-[10px] font-medium text-primary-700">当前</span>
                    ) : opened ? (
                      <span className="shrink-0 rounded bg-gray-100 px-1.5 text-[10px] text-gray-500">已打开</span>
                    ) : null}
                  </p>
                  <p className="truncate text-[11px] text-gray-400" title={lib.rootPath}>
                    {lib.rootPath} · {lib.fileCount.toLocaleString()} 个文件
                  </p>
                </div>
                {!isCurrent && (
                  <button
                    type="button"
                    onClick={() => {
                      closeManager();
                      void switchToLibrary(lib.id);
                    }}
                    className="h-7 shrink-0 rounded-md border border-gray-200 px-2.5 text-[12px] text-gray-600 hover:bg-white"
                  >
                    打开
                  </button>
                )}
                {opened && (
                  <button
                    type="button"
                    onClick={() => void closeLibraryInWorkspace(lib.id)}
                    title="从当前窗口关闭（仍保留在文档库列表中）"
                    className="h-7 shrink-0 rounded-md border border-gray-200 px-2.5 text-[12px] text-gray-600 hover:bg-white"
                  >
                    关闭
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void remove(lib.id, lib.name)}
                  title="移除索引记录（不删除原文件）"
                  className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-red-100 px-2 text-[12px] text-red-600 hover:bg-red-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  移除
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex justify-between border-t border-gray-100 px-5 py-3">
          <button
            type="button"
            onClick={() => {
              closeManager();
              openWizard();
            }}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-primary-600 px-3 text-[13px] font-medium text-white hover:bg-primary-700"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            添加文档库
          </button>
          <button type="button" onClick={closeManager} className="h-8 rounded-lg border border-gray-200 px-3 text-[13px] text-gray-600 hover:bg-gray-50">
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
