import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { Download, Loader2 } from "lucide-react";
import { useDialog } from "./DialogContext";
import { useLibrary } from "./LibraryContext";
import {
  getAutoUpdateCheck,
  getLastUpdateCheck,
  getSkippedUpdateVersion,
  setLastUpdateCheck,
  setSkippedUpdateVersion,
} from "../lib/prefs";
import { isSkippedVersion, shouldAutoCheck } from "../lib/updatePolicy";

export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "installing";

interface UpdateInfo {
  version: string;
  notes: string;
  date: string | null;
}

interface UpdateApi {
  status: UpdateStatus;
  /** 有可用的新版本（含正在下载） */
  info: UpdateInfo | null;
  /** 手动检查：无更新 / 失败都会给出明确提示 */
  checkNow: () => Promise<void>;
  openDialog: () => void;
}

const UpdateContext = createContext<UpdateApi | null>(null);

export function useUpdate(): UpdateApi {
  const ctx = useContext(UpdateContext);
  if (!ctx) throw new Error("useUpdate 必须在 UpdateProvider 内使用");
  return ctx;
}

/** 启动后延迟这么久再做自动检查，避免与首屏加载争用。 */
const AUTO_CHECK_DELAY_MS = 8000;

export function UpdateProvider({ children }: { children: ReactNode }) {
  const dialog = useDialog();
  const { editorDirty } = useLibrary();
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const updateRef = useRef<Update | null>(null);
  const busyRef = useRef(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = editorDirty;

  const runCheck = useCallback(
    async (manual: boolean) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setStatus("checking");
      try {
        const update = await check();
        setLastUpdateCheck(Date.now());
        if (!update) {
          setStatus("idle");
          if (manual) await dialog.alert("当前已是最新版本。", "检查更新");
          return;
        }
        updateRef.current = update;
        setInfo({ version: update.version, notes: update.body ?? "", date: update.date ?? null });
        setStatus("available");
        if (manual || !isSkippedVersion(getSkippedUpdateVersion(), update.version)) setDialogOpen(true);
      } catch (err) {
        console.error("检查更新失败", err);
        setStatus("idle");
        if (manual) await dialog.alert("无法检查更新，请检查网络连接后重试。", "检查更新");
      } finally {
        busyRef.current = false;
      }
    },
    [dialog],
  );

  useEffect(() => {
    if (!shouldAutoCheck(getAutoUpdateCheck(), getLastUpdateCheck(), Date.now())) return;
    const t = window.setTimeout(() => void runCheck(false), AUTO_CHECK_DELAY_MS);
    return () => window.clearTimeout(t);
    // 仅启动时检查一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function install() {
    const update = updateRef.current;
    if (!update || busyRef.current) return;
    if (dirtyRef.current) {
      const ok = await dialog.confirm({
        title: "有未保存的修改",
        message: "更新安装时会关闭并重新启动 MarkFlow，当前文档的未保存修改将丢失。\n（下次打开同一文件时可从恢复草稿找回最近的编辑内容。）\n\n建议先保存。仍要现在更新吗？",
        confirmText: "仍然更新",
        danger: true,
      });
      if (!ok) return;
    }
    busyRef.current = true;
    setStatus("downloading");
    setProgress(0);
    try {
      let total = 0;
      let received = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          if (total > 0) setProgress(Math.min(received / total, 1));
        } else if (event.event === "Finished") {
          setStatus("installing");
          setProgress(1);
        }
      });
    } catch (err) {
      console.error("安装更新失败", err);
      busyRef.current = false;
      setStatus("available");
      setProgress(null);
      await dialog.alert("更新失败，当前版本未受影响。请检查网络连接后重试，或到 GitHub 发布页手动下载安装包。", "更新失败");
    }
  }

  function skip() {
    if (info) setSkippedUpdateVersion(info.version);
    setDialogOpen(false);
  }

  const api = useMemo<UpdateApi>(
    () => ({ status, info, checkNow: () => runCheck(true), openDialog: () => info && setDialogOpen(true) }),
    [status, info, runCheck],
  );

  const working = status === "downloading" || status === "installing";

  return (
    <UpdateContext.Provider value={api}>
      {children}
      {dialogOpen && info && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => !working && setDialogOpen(false)}>
          <div className="w-[480px] max-w-[92vw] rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <Download className="h-5 w-5 text-primary-600" />
              <h2 className="text-base font-semibold text-gray-900">发现新版本 v{info.version}</h2>
            </div>
            <p className="mt-1 text-xs text-gray-400">
              {info.date ? `发布于 ${info.date.slice(0, 10)} · ` : ""}更新包经签名校验，下载后自动安装并重新启动，文档库与设置不受影响。
            </p>
            {info.notes && (
              <div className="mt-3 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[13px] leading-relaxed text-gray-700">
                {info.notes}
              </div>
            )}
            {working && (
              <div className="mt-4">
                <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
                  <div className="h-full rounded-full bg-primary-600 transition-all" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
                </div>
                <p className="mt-1.5 flex items-center gap-1.5 text-xs text-gray-500">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {status === "installing" ? "正在安装，应用将自动重新启动…" : `正在下载… ${Math.round((progress ?? 0) * 100)}%`}
                </p>
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" disabled={working} onClick={skip} className="rounded-lg px-3 py-1.5 text-[13px] text-gray-500 hover:bg-gray-100 disabled:opacity-40">
                跳过此版本
              </button>
              <button type="button" disabled={working} onClick={() => setDialogOpen(false)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50 disabled:opacity-40">
                稍后提醒
              </button>
              <button type="button" disabled={working} onClick={() => void install()} className="rounded-lg bg-primary-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-primary-700 disabled:opacity-60">
                立即更新
              </button>
            </div>
          </div>
        </div>
      )}
    </UpdateContext.Provider>
  );
}
