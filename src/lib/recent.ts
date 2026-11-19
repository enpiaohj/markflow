import * as api from "./api";

interface ConfirmDialog {
  confirm: (options: { title?: string; message: string; confirmText?: string }) => Promise<boolean>;
}

/** 确认后清空「最近打开的文件」；只清除列表记录，不删除任何文件。返回是否已清空。 */
export async function confirmClearRecentFiles(dialog: ConfirmDialog): Promise<boolean> {
  const ok = await dialog.confirm({
    title: "清空最近打开的文件",
    message: "将清除「最近打开的文件」列表中的所有记录。\n\n只清除列表，不会删除任何文件。",
    confirmText: "清空",
  });
  if (!ok) return false;
  await api.clearRecentFiles();
  return true;
}
