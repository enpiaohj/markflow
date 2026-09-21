import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../lib/api";
import { openRouteFor } from "../lib/format";
import type { LibraryMeta } from "../lib/types";
import { useDialog } from "./DialogContext";

export type ScanPhase = "idle" | "scanning" | "done" | "failed";

export interface ScanStatus {
  phase: ScanPhase;
  libraryId: string | null;
  fileCount: number;
  error: string | null;
}

/** 主视图切换请求：Shell 监听 nonce 变化后切换到 target 视图 */
export type ViewRequestTarget = "home" | "library" | "search" | "graph" | "tasks" | "history" | "settings";

interface LibraryContextValue {
  /** 索引数据库中的全部文档库（按最近打开排序） */
  libraries: LibraryMeta[];
  /** 当前（活动）文档库；中央列表 / 详情 / 搜索默认针对它；null 表示未打开 */
  current: LibraryMeta | null;
  /** 工作区：并列显示在左侧目录树中的已打开文档库，按名称排序 */
  workspace: LibraryMeta[];
  /** 左侧目录树中处于展开状态的文档库 ID（默认全部折叠，持久化） */
  expandedLibs: Set<string>;
  toggleLibExpanded: (id: string, expanded?: boolean) => void;
  /** 从工作区移除（不删除磁盘文件、不移出索引）；有未保存修改先确认 */
  closeLibraryInWorkspace: (id: string) => Promise<void>;
  /** 最近一次扫描状态（驱动状态栏展示） */
  scanStatus: ScanStatus;
  /** 建库向导是否打开 */
  wizardOpen: boolean;
  /** 视图切换请求（切换/创建文档库、点击标题栏搜索框、Ctrl+K 时发出） */
  viewRequest: { target: ViewRequestTarget; nonce: number };
  /** 关闭当前打开的文档（编辑器 / 查看器 / 交付中心）；有未保存修改会先确认 */
  closeDocument: () => Promise<void>;
  /** 编辑器中有未保存修改时弹出确认；返回 true 表示可以继续（已放弃修改或无修改） */
  confirmDiscard: () => Promise<boolean>;
  /** 打开任意文件（库内定位 / 单文件模式），按格式路由到编辑器或查看器 */
  openPath: (path: string) => Promise<void>;
  /** 弹出系统文件选择框并打开所选文件 */
  pickAndOpenFile: () => Promise<void>;
  /** 内容版本号：文件监听重扫 / 扫描完成后自增，驱动文档库视图刷新 */
  contentVersion: number;
  /** 搜索结果点击后的聚焦请求：文档库视图跳转并选中该文件 */
  focusFile: { relativePath: string; nonce: number } | null;
  /** 当前在编辑器中打开的文件；null 表示编辑器关闭 */
  openFile: { relativePath: string; nonce: number } | null;
  /** 编辑器是否存在未保存修改（切换视图时用于离开确认） */
  editorDirty: boolean;
  setEditorDirty: (dirty: boolean) => void;
  /** 正式交付中心是否打开 */
  deliveryOpen: boolean;
  /** 当前在只读查看器中打开的文件（PDF / Office 快速预览 / LibreOffice 高保真） */
  viewerFile: {
    relativePath: string;
    kind: "pdf" | "office" | "hifi" | "image";
    nonce: number;
    /** hifi 模式：Office / LibreOffice 转出的 PDF 字节 */
    bytes?: ArrayBuffer;
    /** 用户主动选择文本快速预览：不再自动切到版式预览 */
    preferText?: boolean;
    /** 从 Office 版式预览切回内置渲染：本次不再自动调用 Office */
    forceBuiltin?: boolean;
  } | null;
  openWizard: () => void;
  closeWizard: () => void;
  requestSearchView: () => void;
  /** 请求切换到任意一级视图（菜单栏使用） */
  requestView: (target: ViewRequestTarget) => void;
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
  requestFocusFile: (relativePath: string, libraryId?: string) => void;
  /** 在编辑器中打开文本文件 */
  openInEditor: (relativePath: string) => void;
  /** 关闭编辑器，返回文档库视图 */
  closeFile: () => void;
  /** 在只读查看器中打开文件 */
  openInViewer: (
    relativePath: string,
    kind: "pdf" | "office" | "hifi" | "image",
    bytes?: ArrayBuffer,
    opts?: { preferText?: boolean; forceBuiltin?: boolean },
  ) => void;
  /** 关闭查看器 */
  closeViewer: () => void;
  openDelivery: () => void;
  closeDelivery: () => void;
}

const LibraryContext = createContext<LibraryContextValue | null>(null);

const LS_OPEN = "markflow.workspace.open";
const LS_ACTIVE = "markflow.workspace.active";
const LS_EXPANDED = "markflow.workspace.expanded";

function readIds(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeIds(key: string, ids: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    /* 存储不可用时仅本次有效 */
  }
}

const IDLE_SCAN: ScanStatus = { phase: "idle", libraryId: null, fileCount: 0, error: null };
const INITIAL_VIEW: { target: ViewRequestTarget; nonce: number } = { target: "library", nonce: 0 };

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [libraries, setLibraries] = useState<LibraryMeta[]>([]);
  const [current, setCurrent] = useState<LibraryMeta | null>(null);
  const [openIds, setOpenIds] = useState<string[]>(() => readIds(LS_OPEN));
  const [expandedLibs, setExpandedLibs] = useState<Set<string>>(() => new Set(readIds(LS_EXPANDED)));
  const [scanStatus, setScanStatus] = useState<ScanStatus>(IDLE_SCAN);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [viewRequest, setViewRequest] = useState(INITIAL_VIEW);
  const [contentVersion, setContentVersion] = useState(0);
  const [focusFile, setFocusFile] = useState<{ relativePath: string; nonce: number } | null>(null);
  const [openFile, setOpenFile] = useState<{ relativePath: string; nonce: number } | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [viewerFile, setViewerFile] = useState<{
    relativePath: string;
    kind: "pdf" | "office" | "hifi" | "image";
    nonce: number;
    bytes?: ArrayBuffer;
    preferText?: boolean;
    forceBuiltin?: boolean;
  } | null>(null);

  const dialog = useDialog();
  const dirtyRef = useRef(false);
  dirtyRef.current = editorDirty;

  const confirmDiscard = useCallback(async () => {
    if (!dirtyRef.current) return true;
    const ok = await dialog.confirm({
      title: "放弃未保存的修改？",
      message: "当前文档有未保存的修改，继续操作将丢失这些修改。",
      confirmText: "放弃修改",
      danger: true,
    });
    if (ok) window.dispatchEvent(new CustomEvent("markflow:discard-draft"));
    return ok;
  }, [dialog]);

  const refreshLibraries = useCallback(async () => {
    try {
      const list = await api.listLibraries();
      setLibraries(list);
      // 索引中已不存在的库（被移除 / 数据库重建）从工作区剔除
      setOpenIds((prev) => (prev.every((id) => list.some((l) => l.id === id)) ? prev : prev.filter((id) => list.some((l) => l.id === id))));
      return list;
    } catch (err) {
      console.error("加载文档库列表失败", err);
      return null;
    }
  }, []);

  const workspace = useMemo(
    () =>
      openIds
        .map((id) => libraries.find((l) => l.id === id))
        .filter((l): l is LibraryMeta => !!l)
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN") || a.id.localeCompare(b.id)),
    [openIds, libraries],
  );

  // 工作区与折叠状态持久化；工作区变化时同步文件监听集合
  const libsLoadedRef = useRef(false);
  useEffect(() => {
    if (!libsLoadedRef.current) return; // 列表尚未加载时 openIds 可能含未校验的旧 ID，避免误写
    writeIds(LS_OPEN, openIds);
    api.setWatchedLibraries(openIds).catch((err) => console.error("启动文件监听失败", err));
  }, [openIds]);
  useEffect(() => {
    writeIds(LS_EXPANDED, [...expandedLibs]);
  }, [expandedLibs]);

  const toggleLibExpanded = useCallback((id: string, expanded?: boolean) => {
    setExpandedLibs((prev) => {
      const has = prev.has(id);
      const want = expanded ?? !has;
      if (want === has) return prev;
      const next = new Set(prev);
      if (want) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const addToWorkspace = useCallback((meta: LibraryMeta) => {
    if (meta.settings?.adhoc) return; // 单文件模式的隐式库不进工作区
    setOpenIds((prev) => (prev.includes(meta.id) ? prev : [...prev, meta.id]));
  }, []);

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

  const switchLibraryCore = useCallback(async (id: string, navigate: boolean) => {
    const meta = await api.openLibrary(id);
    setOpenFile(null);
    setViewerFile(null);
    setEditorDirty(false);
    setCurrent(meta);
    addToWorkspace(meta);
    writeIds(LS_ACTIVE, meta.settings?.adhoc ? [] : [meta.id]);
    setScanStatus({
      phase: meta.fileCount > 0 ? "done" : "idle",
      libraryId: meta.id,
      fileCount: meta.fileCount,
      error: null,
    });
    setFocusFile(null);
    if (navigate) setViewRequest({ target: "library", nonce: Date.now() });
    // 打开 / 激活库时刷新索引（期间的磁盘变化）；单文件模式的隐式库只索引已打开的文件
    api.rescanLibrary(id).catch((err) => console.error("重扫失败", err));
  }, [addToWorkspace]);

  const switchToLibrary = useCallback(
    async (id: string) => {
      if (!(await confirmDiscard())) return;
      await switchLibraryCore(id, true);
    },
    [confirmDiscard, switchLibraryCore],
  );

  const libraryCreated = useCallback(async (id: string) => {
    if (!(await confirmDiscard())) return;
    setWizardOpen(false);
    const meta = await api.openLibrary(id);
    setLibraries((prev) => [meta, ...prev.filter((l) => l.id !== id)]);
    setOpenFile(null);
    setViewerFile(null);
    setEditorDirty(false);
    setCurrent(meta);
    addToWorkspace(meta);
    toggleLibExpanded(meta.id, true); // 刚创建的库展开一次，方便看到内容
    writeIds(LS_ACTIVE, [meta.id]);
    setScanStatus({ phase: "scanning", libraryId: meta.id, fileCount: 0, error: null });
    setFocusFile(null);
    setViewRequest({ target: "library", nonce: Date.now() });
  }, [confirmDiscard, addToWorkspace, toggleLibExpanded]);

  const removeLibrary = useCallback(
    async (id: string) => {
      if (current?.id === id && !(await confirmDiscard())) return;
      await api.removeLibrary(id);
      if (current?.id === id) {
        setOpenFile(null);
        setViewerFile(null);
        setEditorDirty(false);
        setCurrent(null);
        setScanStatus(IDLE_SCAN);
      }
      setOpenIds((prev) => prev.filter((x) => x !== id));
      await refreshLibraries();
    },
    [current, refreshLibraries, confirmDiscard],
  );

  // 启动时：加载列表后恢复上次的活动库（工作区本身已由 openIds 恢复，并补一次增量重扫）
  const restoredRef = useRef(false);
  useEffect(() => {
    void (async () => {
      const list = await refreshLibraries();
      libsLoadedRef.current = true;
      if (restoredRef.current || !list) return;
      restoredRef.current = true;
      const valid = readIds(LS_OPEN).filter((id) => list.some((l) => l.id === id));
      setOpenIds(valid);
      api.setWatchedLibraries(valid).catch((err) => console.error("启动文件监听失败", err));
      const active = readIds(LS_ACTIVE)[0];
      for (const id of valid) {
        if (id === active) continue;
        api.rescanLibrary(id).catch((err) => console.error("重扫失败", err));
      }
      if (active && valid.includes(active)) {
        try {
          await switchLibraryCoreRef.current(active, false);
        } catch (err) {
          console.error("恢复活动文档库失败", err);
        }
      }
    })();
  }, [refreshLibraries]);

  const closeLibraryInWorkspace = useCallback(
    async (id: string) => {
      if (current?.id === id) {
        if (!(await confirmDiscard())) return;
        setCurrent(null);
        setScanStatus(IDLE_SCAN);
        setFocusFile(null);
        setOpenFile(null);
        setViewerFile(null);
        setDeliveryOpen(false);
        setEditorDirty(false);
        writeIds(LS_ACTIVE, []);
      }
      setOpenIds((prev) => prev.filter((x) => x !== id));
    },
    [current, confirmDiscard],
  );

  const requestView = useCallback((target: ViewRequestTarget) => {
    setViewRequest({ target, nonce: Date.now() });
  }, []);

  const requestSearchView = useCallback(() => {
    setViewRequest({ target: "search", nonce: Date.now() });
  }, []);

  const requestTasksView = useCallback(() => {
    setViewRequest({ target: "tasks", nonce: Date.now() });
  }, []);

  const requestFocusFile = useCallback(
    (relativePath: string, libraryId?: string) => {
      void confirmDiscard().then(async (ok) => {
        if (!ok) return;
        if (libraryId && currentIdRef.current !== libraryId) {
          try {
            await switchLibraryCoreRef.current(libraryId, false);
          } catch (err) {
            await dialog.alert(String(err), "无法打开文档库");
            return;
          }
        }
        setOpenFile(null);
        setViewerFile(null);
        setFocusFile({ relativePath, nonce: Date.now() });
        setViewRequest({ target: "library", nonce: Date.now() });
      });
    },
    [confirmDiscard, dialog],
  );

  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = current?.id ?? null;
  const switchLibraryCoreRef = useRef(switchLibraryCore);
  switchLibraryCoreRef.current = switchLibraryCore;

  const closeDocument = useCallback(async () => {
    if (!(await confirmDiscard())) return;
    setOpenFile(null);
    setViewerFile(null);
    setDeliveryOpen(false);
    setEditorDirty(false);
  }, [confirmDiscard]);

  const openInEditorGuarded = useCallback(
    (relativePath: string) => {
      void confirmDiscard().then((ok) => {
        if (!ok) return;
        if (currentIdRef.current) void api.recordRecentOpen(currentIdRef.current, relativePath).catch(() => {});
        setFocusFile(null);
        setViewerFile(null);
        setDeliveryOpen(false);
        setOpenFile({ relativePath, nonce: Date.now() });
      });
    },
    [confirmDiscard],
  );

  const openInViewerGuarded = useCallback(
    (relativePath: string, kind: "pdf" | "office" | "hifi" | "image", bytes?: ArrayBuffer, opts?: { preferText?: boolean; forceBuiltin?: boolean }) => {
      void confirmDiscard().then((ok) => {
        if (!ok) return;
        if (kind !== "hifi" && currentIdRef.current) void api.recordRecentOpen(currentIdRef.current, relativePath).catch(() => {});
        setOpenFile(null);
        setDeliveryOpen(false);
        setFocusFile(null);
        setViewerFile({ relativePath, kind, nonce: Date.now(), bytes, preferText: opts?.preferText, forceBuiltin: opts?.forceBuiltin });
      });
    },
    [confirmDiscard],
  );

  const openPath = useCallback(
    async (path: string) => {
      try {
        const target = await api.openFilePath(path);
        if (!(await confirmDiscard())) return;
        if (currentIdRef.current !== target.libraryId) {
          await switchLibraryCore(target.libraryId, false);
        }
        setFocusFile(null);
        setDeliveryOpen(false);
        const route = openRouteFor(target.format);
        if (route === "editor") {
          setViewerFile(null);
          setOpenFile({ relativePath: target.relativePath, nonce: Date.now() });
        } else if (route === "system") {
          await api.openPathInSystem(target.libraryId, target.relativePath);
        } else {
          setOpenFile(null);
          setViewerFile({ relativePath: target.relativePath, kind: route, nonce: Date.now() });
        }
      } catch (err) {
        await dialog.alert(String(err), "无法打开文件");
      }
    },
    [confirmDiscard, dialog, switchLibraryCore],
  );

  const pickAndOpenFile = useCallback(async () => {
    const picked = await openFileDialog({
      multiple: false,
      title: "打开文件",
      filters: [
        { name: "文档与常见文件", extensions: ["md", "markdown", "txt", "json", "yaml", "yml", "xml", "csv", "log", "ini", "pdf", "docx", "xlsx", "pptx", "png", "jpg", "jpeg", "webp", "gif", "svg"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (!picked || Array.isArray(picked)) return;
    await openPath(picked);
  }, [openPath]);

  // 启动参数 / 文件关联双击 / 二次启动传来的待打开文件
  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;
  useEffect(() => {
    void api.takePendingOpenPaths().then((paths) => {
      if (paths.length > 0) void openPathRef.current(paths[0]);
    });
    const un = listen<string[]>("open-paths", (event) => {
      void api.takePendingOpenPaths().catch(() => []);
      if (event.payload.length > 0) void openPathRef.current(event.payload[0]);
    });
    // 把文件拖进窗口即可打开
    const unDrop = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop" && event.payload.paths.length > 0) {
        void openPathRef.current(event.payload.paths[0]);
      }
    });
    return () => {
      void un.then((f) => f());
      void unDrop.then((f) => f());
    };
  }, []);

  const value = useMemo<LibraryContextValue>(
    () => ({
      libraries,
      current,
      workspace,
      expandedLibs,
      toggleLibExpanded,
      closeLibraryInWorkspace,
      scanStatus,
      wizardOpen,
      viewRequest,
      contentVersion,
      focusFile,
      openFile,
      editorDirty,
      setEditorDirty,
      confirmDiscard,
      closeDocument,
      openPath,
      pickAndOpenFile,
      deliveryOpen,
      viewerFile,
      openWizard: () => setWizardOpen(true),
      closeWizard: () => setWizardOpen(false),
      requestSearchView,
      requestView,
      requestTasksView,
      switchToLibrary,
      libraryCreated,
      removeLibrary,
      closeCurrentLibrary: () => {
        if (current) void closeLibraryInWorkspace(current.id);
        else setOpenIds([]);
      },
      requestFocusFile,
      openInEditor: openInEditorGuarded,
      closeFile: () => setOpenFile(null),
      openInViewer: openInViewerGuarded,
      closeViewer: () => setViewerFile(null),
      openDelivery: () => {
        void confirmDiscard().then((ok) => {
          if (!ok) return;
          setOpenFile(null);
          setViewerFile(null);
          setFocusFile(null);
          setDeliveryOpen(true);
        });
      },
      closeDelivery: () => setDeliveryOpen(false),
    }),
    [libraries, current, workspace, expandedLibs, toggleLibExpanded, closeLibraryInWorkspace, scanStatus, wizardOpen, viewRequest, contentVersion, focusFile, openFile, editorDirty, deliveryOpen, viewerFile, requestSearchView, requestView, requestTasksView, switchToLibrary, libraryCreated, removeLibrary, requestFocusFile, confirmDiscard, closeDocument, openPath, pickAndOpenFile, openInEditorGuarded, openInViewerGuarded],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error("useLibrary 必须在 LibraryProvider 内使用");
  return ctx;
}
