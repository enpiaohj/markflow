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
import {
  CHECK_RETRY_DELAYS_MS,
  CHECK_TIMEOUT_MS,
  RECHECK_POLL_MS,
  STARTUP_CHECK_DELAY_MS,
  isRecheckDue,
  isSkippedVersion,
  withRetry,
} from "../lib/updatePolicy";
import { parseUpdateNotes } from "../lib/updateNotes";

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
  /** 是否在标题栏提示新版本：有新版本，且用户没有对该版本点过「跳过此版本」 */
  notify: boolean;
  /** 手动检查：无更新 / 失败都会给出明确提示 */
  checkNow: () => Promise<void>;
  /** 上次成功完成检查的时间（毫秒时间戳），从未成功为 null */
  lastCheckedAt: number | null;
  openDialog: () => void;
}

const UpdateContext = createContext<UpdateApi | null>(null);

export function useUpdate(): UpdateApi {
  const ctx = useContext(UpdateContext);
  if (!ctx) throw new Error("useUpdate 必须在 UpdateProvider 内使用");
  return ctx;
}

export function UpdateProvider({ children }: { children: ReactNode }) {
  const dialog = useDialog();
  const { editorDirty } = useLibrary();
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(getLastUpdateCheck());
  const [skipped, setSkipped] = useState<string | null>(getSkippedUpdateVersion());
  const updateRef = useRef<Update | null>(null);
  const busyRef = useRef(false);
  /** 本次检查是否需要给出结果提示（手动触发，或自动检查进行中用户又手动点了检查） */
  const wantFeedbackRef = useRef(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = editorDirty;

  const runCheck = useCallback(
    async (manual: boolean) => {
      if (busyRef.current) {
        // 已有检查在进行（自动检查或安装中）：手动点击不能被静默忽略，等它结束后给出结果
        if (manual) wantFeedbackRef.current = true;
        return;
      }
      busyRef.current = true;
      wantFeedbackRef.current = manual;
      setStatus("checking");
      try {
        // 网络偶发抖动时自动重试，并带超时，避免一直卡在「正在检查」
        const update = await withRetry(() => check({ timeout: CHECK_TIMEOUT_MS, headers: { "Cache-Control": "no-cache" } }), CHECK_RETRY_DELAYS_MS);
        const now = Date.now();
        setLastUpdateCheck(now);
        setLastCheckedAt(now);
        if (!update) {
          updateRef.current = null;
          setInfo(null);
          setStatus("idle");
          if (wantFeedbackRef.current) await dialog.alert("当前已是最新版本。", "检查更新");
          return;
        }
        updateRef.current = update;
        setInfo({ version: update.version, notes: update.body ?? "", date: update.date ?? null });
        setStatus("available");
        // 只有手动检查才弹出更新对话框；自动检查（启动 / 运行中复检）只亮标题栏标记，不打断用户
        if (wantFeedbackRef.current) setDialogOpen(true);
      } catch (err) {
        console.error("检查更新失败", err);
        setStatus("idle");
        if (wantFeedbackRef.current) await dialog.alert("无法检查更新，请检查网络连接后重试。", "检查更新");
      } finally {
        busyRef.current = false;
        wantFeedbackRef.current = false;
      }
    },
    [dialog],
  );

  // 启动后检查一次；之后每隔一段时间复检（应用常驻通知区域、很久不重启时也能发现新版本）
  useEffect(() => {
    const startup = window.setTimeout(() => {
      if (getAutoUpdateCheck()) void runCheck(false);
    }, STARTUP_CHECK_DELAY_MS);
    const poll = window.setInterval(() => {
      if (isRecheckDue(getAutoUpdateCheck(), getLastUpdateCheck(), Date.now())) void runCheck(false);
    }, RECHECK_POLL_MS);
    return () => {
      window.clearTimeout(startup);
      window.clearInterval(poll);
    };
    // 仅在挂载时建立定时器
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
    if (info) {
      setSkippedUpdateVersion(info.version);
      setSkipped(info.version);
    }
    setDialogOpen(false);
  }

  const api = useMemo<UpdateApi>(
    () => ({
      status,
      info,
      notify: info !== null && !isSkippedVersion(skipped, info.version),
      lastCheckedAt,
      checkNow: () => runCheck(true),
      openDialog: () => info && setDialogOpen(true),
    }),
    [status, info, skipped, lastCheckedAt, runCheck],
  );

  const working = status === "downloading" || status === "installing";
  const noteLines = useMemo(() => (info ? parseUpdateNotes(info.notes) : []), [info]);

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
            {noteLines.length > 0 && (
              <div className="mt-3 max-h-56 space-y-1 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[13px] leading-relaxed text-gray-700">
                {noteLines.map((line, i) =>
                  line.kind === "heading" ? (
                    <p key={i} className="mt-2 text-xs font-semibold text-gray-500 first:mt-0">
                      {line.text}
                    </p>
                  ) : line.kind === "bullet" ? (
                    <p key={i} className="flex gap-1.5">
                      <span className="text-gray-400">•</span>
                      <span className="min-w-0 flex-1">{line.text}</span>
                    </p>
                  ) : (
                    <p key={i}>{line.text}</p>
                  ),
                )}
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
                不再提示此版本
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
