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

/** 主视图切换请求：Shell 监听 nonce 变化后切换到 target 视图 */
export type ViewRequestTarget = "library" | "search" | "tasks";

interface LibraryContextValue {
  /** 索引数据库中的全部文档库（按最近打开排序） */
  libraries: LibraryMeta[];
  /** 当前打开的文档库；null 表示未打开 */
  current: LibraryMeta | null;
  /** 最近一次扫描状态（驱动状态栏展示） */
  scanStatus: ScanStatus;
  /** 建库向导是否打开 */
  wizardOpen: boolean;
  /** 视图切换请求（切换/创建文档库、点击标题栏搜索框、Ctrl+K 时发出） */
  viewRequest: { target: ViewRequestTarget; nonce: number };
  /** 内容版本号：文件监听重扫 / 扫描完成后自增，驱动文档库视图刷新 */
  contentVersion: number;
  /** 搜索结果点击后的聚焦请求：文档库视图跳转并选中该文件 */
  focusFile: { relativePath: string; nonce: number } | null;
  /** 当前在编辑器中打开的文件；null 表示编辑器关闭 */
  openFile: { relativePath: string; nonce: number } | null;
  /** 正式交付中心是否打开 */
  deliveryOpen: boolean;
  /** 当前在只读查看器中打开的文件（PDF / Office 快速预览 / LibreOffice 高保真） */
  viewerFile: {
    relativePath: string;
    kind: "pdf" | "office" | "hifi";
    nonce: number;
    /** hifi 模式：LibreOffice 转出的 PDF 字节 */
    bytes?: ArrayBuffer;
  } | null;
  openWizard: () => void;
  closeWizard: () => void;
  requestSearchView: () => void;
  requestTasksView: () => void;
  /** 打开（切换到）指定文档库并刷新列表 */
  switchToLibrary: (id: string) => Promise<void>;
  /** 创建完成后调用：刷新列表、切到新库 */
  libraryCreated: (id: string) => Promise<void>;
  /** 从索引中移除文档库（不删除磁盘文件） */
  removeLibrary: (id: string) => Promise<void>;
  /** 回到未打开状态 */
  closeCurrentLibrary: () => void;
  /** 聚焦到文档库中的某个文件（父目录 + 选中详情） */
  requestFocusFile: (relativePath: string) => void;
  /** 在编辑器中打开文本文件 */
  openInEditor: (relativePath: string) => void;
  /** 关闭编辑器，返回文档库视图 */
  closeFile: () => void;
  /** 在只读查看器中打开文件 */
  openInViewer: (relativePath: string, kind: "pdf" | "office" | "hifi", bytes?: ArrayBuffer) => void;
  /** 关闭查看器 */
  closeViewer: () => void;
  openDelivery: () => void;
  closeDelivery: () => void;
}

const LibraryContext = createContext<LibraryContextValue | null>(null);

const IDLE_SCAN: ScanStatus = { phase: "idle", libraryId: null, fileCount: 0, error: null };
const INITIAL_VIEW: { target: ViewRequestTarget; nonce: number } = { target: "library", nonce: 0 };

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [libraries, setLibraries] = useState<LibraryMeta[]>([]);
  const [current, setCurrent] = useState<LibraryMeta | null>(null);
  const [scanStatus, setScanStatus] = useState<ScanStatus>(IDLE_SCAN);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [viewRequest, setViewRequest] = useState(INITIAL_VIEW);
  const [contentVersion, setContentVersion] = useState(0);
  const [focusFile, setFocusFile] = useState<{ relativePath: string; nonce: number } | null>(null);
  const [openFile, setOpenFile] = useState<{ relativePath: string; nonce: number } | null>(null);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [viewerFile, setViewerFile] = useState<{
    relativePath: string;
    kind: "pdf" | "office" | "hifi";
    nonce: number;
    bytes?: ArrayBuffer;
  } | null>(null);

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

  // 后台扫描与文件监听事件
  useEffect(() => {
    const unlisteners: Promise<() => void>[] = [];
    unlisteners.push(
      listen<{ libraryId: string; fileCount: number }>("scan:completed", (event) => {
        setScanStatus({ phase: "done", libraryId: event.payload.libraryId, fileCount: event.payload.fileCount, error: null });
        setCurrent((prev) =>
          prev && prev.id === event.payload.libraryId ? { ...prev, fileCount: event.payload.fileCount } : prev,
        );
        setContentVersion((v) => v + 1);
        void refreshLibraries();
      }),
    );
    unlisteners.push(
      listen<{ libraryId: string; error: string }>("scan:failed", (event) => {
        setScanStatus({ phase: "failed", libraryId: event.payload.libraryId, fileCount: 0, error: event.payload.error });
        void refreshLibraries();
      }),
    );
    unlisteners.push(
      listen<{ libraryId: string; fileCount: number }>("library:changed", (event) => {
        setCurrent((prev) =>
          prev && prev.id === event.payload.libraryId ? { ...prev, fileCount: event.payload.fileCount } : prev,
        );
        setContentVersion((v) => v + 1);
        void refreshLibraries();
      }),
    );
    unlisteners.push(
      listen<{ libraryId: string; relativePath: string }>("file:saved", () => {
        setContentVersion((v) => v + 1);
      }),
    );
    unlisteners.push(
      listen<{ libraryId: string }>("scan:canceled", (event) => {
        setScanStatus((prev) =>
          prev.libraryId === event.payload.libraryId
            ? { phase: "idle", libraryId: event.payload.libraryId, fileCount: prev.fileCount, error: null }
            : prev,
        );
      }),
    );
    unlisteners.push(
      listen<{ libraryId: string; error: string }>("library:rescan_failed", (event) => {
        console.error("文件监听重扫失败", event.payload.error);
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
    setFocusFile(null);
    setViewRequest({ target: "library", nonce: Date.now() });
    api.setWatchedLibrary(id).catch((err) => console.error("启动文件监听失败", err));
  }, []);

  const libraryCreated = useCallback(async (id: string) => {
    setWizardOpen(false);
    const meta = await api.openLibrary(id);
    setLibraries((prev) => [meta, ...prev.filter((l) => l.id !== id)]);
    setCurrent(meta);
    setScanStatus({ phase: "scanning", libraryId: meta.id, fileCount: 0, error: null });
    setFocusFile(null);
    setViewRequest({ target: "library", nonce: Date.now() });
    api.setWatchedLibrary(id).catch((err) => console.error("启动文件监听失败", err));
  }, []);

  const removeLibrary = useCallback(
    async (id: string) => {
      await api.removeLibrary(id);
      if (current?.id === id) {
        setCurrent(null);
        setScanStatus(IDLE_SCAN);
        api.setWatchedLibrary("").catch(() => {});
      }
      await refreshLibraries();
    },
    [current, refreshLibraries],
  );

  const requestSearchView = useCallback(() => {
    setViewRequest({ target: "search", nonce: Date.now() });
  }, []);

  const requestTasksView = useCallback(() => {
    setViewRequest({ target: "tasks", nonce: Date.now() });
  }, []);

  const requestFocusFile = useCallback((relativePath: string) => {
    setFocusFile({ relativePath, nonce: Date.now() });
    setViewRequest({ target: "library", nonce: Date.now() });
  }, []);

  const value = useMemo<LibraryContextValue>(
    () => ({
      libraries,
      current,
      scanStatus,
      wizardOpen,
      viewRequest,
      contentVersion,
      focusFile,
      openFile,
      deliveryOpen,
      viewerFile,
      openWizard: () => setWizardOpen(true),
      closeWizard: () => setWizardOpen(false),
      requestSearchView,
      requestTasksView,
      switchToLibrary,
      libraryCreated,
      removeLibrary,
      closeCurrentLibrary: () => {
        setCurrent(null);
        setScanStatus(IDLE_SCAN);
        setFocusFile(null);
        api.setWatchedLibrary("").catch(() => {});
      },
      requestFocusFile,
      openInEditor: (relativePath: string) => {
        setFocusFile(null);
        setOpenFile({ relativePath, nonce: Date.now() });
      },
      closeFile: () => setOpenFile(null),
      openInViewer: (relativePath: string, kind: "pdf" | "office" | "hifi", bytes?: ArrayBuffer) => {
        setOpenFile(null);
        setViewerFile({ relativePath, kind, nonce: Date.now(), bytes });
      },
      closeViewer: () => setViewerFile(null),
      openDelivery: () => {
        setOpenFile(null);
        setDeliveryOpen(true);
      },
      closeDelivery: () => setDeliveryOpen(false),
    }),
    [libraries, current, scanStatus, wizardOpen, viewRequest, contentVersion, focusFile, openFile, deliveryOpen, viewerFile, requestSearchView, requestTasksView, switchToLibrary, libraryCreated, removeLibrary, requestFocusFile],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error("useLibrary 必须在 LibraryProvider 内使用");
  return ctx;
}
