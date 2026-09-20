import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../lib/api";
import type { LibraryMeta } from "../lib/types";

export type ScanPhase = "idle" | "scanning" | "done" | "failed";

export interface ScanStatus {
  phase: ScanPhase;
  libraryId: string | null;
  fileCount: number;
  error: string | null;
}

interface LibraryContextValue {
  /** 索引数据库中的全部文档库（按最近打开排序） */
  libraries: LibraryMeta[];
  /** 当前打开的文档库；null 表示未打开 */
  current: LibraryMeta | null;
  /** 最近一次扫描状态（驱动状态栏展示） */
  scanStatus: ScanStatus;
  /** 建库向导是否打开 */
  wizardOpen: boolean;
  /** 切换/创建文档库后自增；Shell 监听它把主视图切到「文档库」 */
  viewRequest: number;
  openWizard: () => void;
  closeWizard: () => void;
  /** 打开（切换到）指定文档库并刷新列表 */
  switchToLibrary: (id: string) => Promise<void>;
  /** 创建完成后调用：刷新列表、切到新库 */
  libraryCreated: (id: string) => Promise<void>;
  /** 从索引中移除文档库（不删除磁盘文件） */
  removeLibrary: (id: string) => Promise<void>;
  /** 回到未打开状态 */
  closeCurrentLibrary: () => void;
}

const LibraryContext = createContext<LibraryContextValue | null>(null);

const IDLE_SCAN: ScanStatus = { phase: "idle", libraryId: null, fileCount: 0, error: null };

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [libraries, setLibraries] = useState<LibraryMeta[]>([]);
  const [current, setCurrent] = useState<LibraryMeta | null>(null);
  const [scanStatus, setScanStatus] = useState<ScanStatus>(IDLE_SCAN);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [viewRequest, setViewRequest] = useState(0);

  const refreshLibraries = useCallback(async () => {
    try {
      setLibraries(await api.listLibraries());
    } catch (err) {
      console.error("加载文档库列表失败", err);
    }
  }, []);

  useEffect(() => {
    void refreshLibraries();
  }, [refreshLibraries]);

  // 后台扫描事件：驱动状态栏与列表刷新
  useEffect(() => {
    const unlisteners: Promise<() => void>[] = [];
    unlisteners.push(
      listen<{ libraryId: string; fileCount: number }>("scan:completed", (event) => {
        setScanStatus({ phase: "done", libraryId: event.payload.libraryId, fileCount: event.payload.fileCount, error: null });
        setCurrent((prev) =>
          prev && prev.id === event.payload.libraryId ? { ...prev, fileCount: event.payload.fileCount } : prev,
        );
        void refreshLibraries();
      }),
    );
    unlisteners.push(
      listen<{ libraryId: string; error: string }>("scan:failed", (event) => {
        setScanStatus({ phase: "failed", libraryId: event.payload.libraryId, fileCount: 0, error: event.payload.error });
        void refreshLibraries();
      }),
    );
    return () => {
      for (const p of unlisteners) void p.then((un) => un());
    };
  }, [refreshLibraries]);

  const switchToLibrary = useCallback(async (id: string) => {
    const meta = await api.openLibrary(id);
    setCurrent(meta);
    setScanStatus({
      phase: meta.fileCount > 0 ? "done" : "idle",
      libraryId: meta.id,
      fileCount: meta.fileCount,
      error: null,
    });
    setViewRequest((n) => n + 1);
  }, []);

  const libraryCreated = useCallback(async (id: string) => {
    setWizardOpen(false);
    const meta = await api.openLibrary(id);
    setLibraries((prev) => [meta, ...prev.filter((l) => l.id !== id)]);
    setCurrent(meta);
    setScanStatus({ phase: "scanning", libraryId: meta.id, fileCount: 0, error: null });
    setViewRequest((n) => n + 1);
  }, []);

  const removeLibrary = useCallback(
    async (id: string) => {
      await api.removeLibrary(id);
      if (current?.id === id) {
        setCurrent(null);
        setScanStatus(IDLE_SCAN);
      }
      await refreshLibraries();
    },
    [current, refreshLibraries],
  );

  const value = useMemo<LibraryContextValue>(
    () => ({
      libraries,
      current,
      scanStatus,
      wizardOpen,
      viewRequest,
      openWizard: () => setWizardOpen(true),
      closeWizard: () => setWizardOpen(false),
      switchToLibrary,
      libraryCreated,
      removeLibrary,
      closeCurrentLibrary: () => {
        setCurrent(null);
        setScanStatus(IDLE_SCAN);
      },
    }),
    [libraries, current, scanStatus, wizardOpen, viewRequest, switchToLibrary, libraryCreated, removeLibrary],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error("useLibrary 必须在 LibraryProvider 内使用");
  return ctx;
}
