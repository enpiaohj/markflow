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

/** 文档标签页：打开的文档一直保留，直到用户关闭 */
export type TabKind = "editor" | "pdf" | "office" | "hifi" | "image" | "delivery";

export interface DocTab {
  id: string;
  /** 所属文档库（打开时的快照，保证文档库切换后标签仍指向原库） */
  lib: LibraryMeta;
  relativePath: string;
  kind: TabKind;
  nonce: number;
  /** hifi 模式：Office / LibreOffice 转出的 PDF 字节 */
  bytes?: ArrayBuffer;
  preferText?: boolean;
  forceBuiltin?: boolean;
}

export function tabIdOf(libraryId: string, relativePath: string, kind: TabKind = "editor"): string {
  return kind === "delivery" ? `${libraryId}::#delivery` : `${libraryId}::${relativePath}`;
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
  /** 「管理文档库」对话框是否打开 */
  managerOpen: boolean;
  openManager: () => void;
  closeManager: () => void;
  /** 请求「设置」视图打开时直接定位到指定分类（如帮助菜单「关于」），消费后自动清空 */
  settingsSection: string | null;
  openSettingsSection: (section: string) => void;
  clearSettingsSection: () => void;
  /** 视图切换请求（切换/创建文档库、点击标题栏搜索框、Ctrl+K 时发出） */
  viewRequest: { target: ViewRequestTarget; nonce: number };
  /** 打开的文档标签页（按打开顺序）与当前激活的标签（null = 显示主视图） */
  tabs: DocTab[];
  activeTabId: string | null;
  activateTab: (id: string) => void;
  /** 隐藏文档回到主视图（标签保留） */
  showMain: () => void;
  /** 关闭指定标签；有未保存修改会先确认 */
  closeTab: (id: string) => Promise<void>;
  /** 文件被重命名 / 移动 / 删除后，关闭该路径（含子路径）下的标签 */
  closeTabsForPath: (libraryId: string, relativePath: string) => Promise<void>;
  /** 各标签的未保存状态 */
  dirtyTabs: Set<string>;
  /** 当前显示的文档所属的库（无文档时为活动库），供状态栏使用 */
  displayLibrary: LibraryMeta | null;
  /** 标签作用域内：本标签是否为激活标签（主视图区域内为 true） */
  tabActive: boolean;
  /** 关闭当前激活的标签（Ctrl+W）；有未保存修改会先确认 */
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
  /** 激活文档库但不切换主视图（在文档库视图内操作其他库时使用） */
  activateLibrary: (id: string) => Promise<void>;
  /** 创建完成后调用：刷新列表、切到新库 */
  libraryCreated: (id: string) => Promise<void>;
  /** 从索引中移除文档库（不删除磁盘文件） */
  removeLibrary: (id: string) => Promise<void>;
  /** 回到未打开状态 */
  closeCurrentLibrary: () => void;
  /** 聚焦到文档库中的某个文件（父目录 + 选中详情） */
  requestFocusFile: (relativePath: string, libraryId?: string) => void;
  /** 在指定文档库中打开（标签作用域内自动绑定为标签所属的库） */
  openInEditorIn: (lib: LibraryMeta, relativePath: string) => void;
  openInViewerIn: (
    lib: LibraryMeta,
    relativePath: string,
    kind: "pdf" | "office" | "hifi" | "image",
    bytes?: ArrayBuffer,
    opts?: { preferText?: boolean; forceBuiltin?: boolean },
  ) => void;
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
  const [managerOpen, setManagerOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const [viewRequest, setViewRequest] = useState(INITIAL_VIEW);
  const [contentVersion, setContentVersion] = useState(0);
  const [focusFile, setFocusFile] = useState<{ relativePath: string; nonce: number } | null>(null);
  const [tabs, setTabs] = useState<DocTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());

  const dialog = useDialog();
  const dirtyRef = useRef(dirtyTabs);
  dirtyRef.current = dirtyTabs;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) ?? null, [tabs, activeTabId]);
  const openFile = useMemo(
    () => (activeTab?.kind === "editor" ? { relativePath: activeTab.relativePath, nonce: activeTab.nonce } : null),
    [activeTab],
  );
  const viewerFile = useMemo(
    () =>
      activeTab && activeTab.kind !== "editor" && activeTab.kind !== "delivery"
        ? {
            relativePath: activeTab.relativePath,
            kind: activeTab.kind,
            nonce: activeTab.nonce,
            bytes: activeTab.bytes,
            preferText: activeTab.preferText,
            forceBuiltin: activeTab.forceBuiltin,
          }
        : null,
    [activeTab],
  );
  const deliveryOpen = activeTab?.kind === "delivery";
  const editorDirty = dirtyTabs.size > 0;

  /** 存在未保存修改的标签时确认（用于退出应用等会一并丢弃所有编辑的操作） */
  const confirmDiscard = useCallback(async () => {
    if (dirtyRef.current.size === 0) return true;
    return dialog.confirm({
      title: "放弃未保存的修改？",
      message: `有 ${dirtyRef.current.size} 个文档存在未保存的修改，继续操作将丢失这些修改。`,
      confirmText: "放弃修改",
      danger: true,
    });
  }, [dialog]);

  const setTabDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyTabs((prev) => {
      if (prev.has(id) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  /** 打开或切到标签：同一文件只有一个标签；类型不变时保持原状态（不重新加载，保留未保存编辑与滚动位置） */
  const upsertTab = useCallback((lib: LibraryMeta, relativePath: string, kind: TabKind, extra?: Partial<DocTab>) => {
    const id = tabIdOf(lib.id, relativePath, kind);
    setTabs((prev) => {
      const old = prev.find((t) => t.id === id);
      const sameKind = old && old.kind === kind && !extra?.bytes && !extra?.preferText && !extra?.forceBuiltin;
      if (sameKind) return prev;
      const tab: DocTab = { id, lib, relativePath, kind, nonce: Date.now(), ...extra };
      return old ? prev.map((t) => (t.id === id ? tab : t)) : [...prev, tab];
    });
    setActiveTabId(id);
  }, []);

  const closeTabsNow = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const all = tabsRef.current;
    const activeId = activeTabIdRef.current;
    const rest = all.filter((t) => !ids.includes(t.id));
    setTabs(rest);
    setDirtyTabs((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next.size === prev.size ? prev : next;
    });
    // 被关闭的是激活标签 → 切到相邻标签，没有则回到主视图
    if (activeId && ids.includes(activeId)) {
      const idx = all.findIndex((t) => t.id === activeId);
      const neighbor = rest[Math.min(idx, rest.length - 1)] ?? null;
      setActiveTabId(neighbor ? neighbor.id : null);
    }
  }, []);

  const confirmCloseTabs = useCallback(
    async (ids: string[]): Promise<boolean> => {
      const dirty = ids.filter((id) => dirtyRef.current.has(id));
      if (dirty.length === 0) return true;
      const names = dirty
        .map((id) => tabsRef.current.find((t) => t.id === id)?.relativePath ?? id)
        .join("\n");
      const ok = await dialog.confirm({
        title: "放弃未保存的修改？",
        message: `以下文档有未保存的修改，关闭将丢失这些修改：\n\n${names}`,
        confirmText: "放弃修改",
        danger: true,
      });
      if (ok) {
        for (const id of dirty) {
          const t = tabsRef.current.find((x) => x.id === id);
          if (t) window.dispatchEvent(new CustomEvent("markflow:discard-draft", { detail: { libraryId: t.lib.id, relativePath: t.relativePath } }));
        }
      }
      return ok;
    },
    [dialog],
  );

  const closeTab = useCallback(
    async (id: string) => {
      if (!(await confirmCloseTabs([id]))) return;
      closeTabsNow([id]);
    },
    [confirmCloseTabs, closeTabsNow],
  );

  const closeTabsForPath = useCallback(
    async (libraryId: string, relativePath: string) => {
      const ids = tabsRef.current
        .filter((t) => t.lib.id === libraryId && t.kind !== "delivery" && (t.relativePath === relativePath || t.relativePath.startsWith(relativePath + "/")))
        .map((t) => t.id);
      if (!(await confirmCloseTabs(ids))) return;
      closeTabsNow(ids);
    },
    [confirmCloseTabs, closeTabsNow],
  );

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
    return meta;
  }, [addToWorkspace]);

  const switchToLibrary = useCallback(
    async (id: string) => {
      await switchLibraryCore(id, true);
    },
    [confirmDiscard, switchLibraryCore],
  );

  const activateLibrary = useCallback(
    async (id: string) => {
      await switchLibraryCore(id, false);
    },
    [switchLibraryCore],
  );

  const libraryCreated = useCallback(async (id: string) => {
    setWizardOpen(false);
    const meta = await api.openLibrary(id);
    setLibraries((prev) => [meta, ...prev.filter((l) => l.id !== id)]);
    setCurrent(meta);
    addToWorkspace(meta);
    toggleLibExpanded(meta.id, true); // 刚创建的库展开一次，方便看到内容
    writeIds(LS_ACTIVE, [meta.id]);
    setScanStatus({ phase: "scanning", libraryId: meta.id, fileCount: 0, error: null });
    setFocusFile(null);
    setViewRequest({ target: "library", nonce: Date.now() });
  }, [addToWorkspace, toggleLibExpanded]);

  const removeLibrary = useCallback(
    async (id: string) => {
      // 该库的打开文档一并关闭（有未保存修改先确认）
      const ids = tabsRef.current.filter((t) => t.lib.id === id).map((t) => t.id);
      if (!(await confirmCloseTabs(ids))) return;
      closeTabsNow(ids);
      await api.removeLibrary(id);
      if (current?.id === id) {
        setCurrent(null);
        setScanStatus(IDLE_SCAN);
      }
      setOpenIds((prev) => prev.filter((x) => x !== id));
      await refreshLibraries();
    },
    [current, refreshLibraries, confirmCloseTabs, closeTabsNow],
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
        setCurrent(null);
        setScanStatus(IDLE_SCAN);
        setFocusFile(null);
        writeIds(LS_ACTIVE, []);
      }
      setOpenIds((prev) => prev.filter((x) => x !== id));
    },
    [current],
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
      void (async () => {
        if (libraryId && currentIdRef.current !== libraryId) {
          try {
            await switchLibraryCoreRef.current(libraryId, false);
          } catch (err) {
            await dialog.alert(String(err), "无法打开文档库");
            return;
          }
        }
        setFocusFile({ relativePath, nonce: Date.now() });
        setViewRequest({ target: "library", nonce: Date.now() });
      })();
    },
    [dialog],
  );

  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = current?.id ?? null;
  const switchLibraryCoreRef = useRef(switchLibraryCore);
  switchLibraryCoreRef.current = switchLibraryCore;

  const currentRef = useRef<LibraryMeta | null>(null);
  currentRef.current = current;

  const closeDocument = useCallback(async () => {
    const id = activeTabIdRef.current;
    if (id) await closeTab(id);
  }, [closeTab]);

  /** 在指定文档库中打开（标签内的操作必须用标签所属的库，而不是当前活动库） */
  const openInEditorIn = useCallback(
    (lib: LibraryMeta, relativePath: string) => {
      void api.recordRecentOpen(lib.id, relativePath).catch(() => {});
      setFocusFile(null);
      upsertTab(lib, relativePath, "editor");
    },
    [upsertTab],
  );

  const openInViewerIn = useCallback(
    (lib: LibraryMeta, relativePath: string, kind: "pdf" | "office" | "hifi" | "image", bytes?: ArrayBuffer, opts?: { preferText?: boolean; forceBuiltin?: boolean }) => {
      if (kind !== "hifi") void api.recordRecentOpen(lib.id, relativePath).catch(() => {});
      setFocusFile(null);
      upsertTab(lib, relativePath, kind, { bytes, preferText: opts?.preferText, forceBuiltin: opts?.forceBuiltin });
    },
    [upsertTab],
  );

  const openInEditorGuarded = useCallback(
    (relativePath: string) => {
      const lib = currentRef.current;
      if (lib) openInEditorIn(lib, relativePath);
    },
    [openInEditorIn],
  );

  const openInViewerGuarded = useCallback(
    (relativePath: string, kind: "pdf" | "office" | "hifi" | "image", bytes?: ArrayBuffer, opts?: { preferText?: boolean; forceBuiltin?: boolean }) => {
      const lib = currentRef.current;
      if (lib) openInViewerIn(lib, relativePath, kind, bytes, opts);
    },
    [openInViewerIn],
  );

  const openPath = useCallback(
    async (path: string) => {
      try {
        const target = await api.openFilePath(path);
        const lib =
          currentIdRef.current === target.libraryId && currentRef.current
            ? currentRef.current
            : await switchLibraryCore(target.libraryId, false);
        setFocusFile(null);
        const route = openRouteFor(target.format);
        if (route === "editor") {
          upsertTab(lib, target.relativePath, "editor");
        } else if (route === "system") {
          await api.openPathInSystem(target.libraryId, target.relativePath);
        } else {
          upsertTab(lib, target.relativePath, route);
        }
      } catch (err) {
        await dialog.alert(String(err), "无法打开文件");
      }
    },
    [dialog, switchLibraryCore, upsertTab],
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
      managerOpen,
      openManager: () => setManagerOpen(true),
      closeManager: () => setManagerOpen(false),
      settingsSection,
      openSettingsSection: (s: string) => setSettingsSection(s),
      clearSettingsSection: () => setSettingsSection(null),
      viewRequest,
      contentVersion,
      focusFile,
      openFile,
      editorDirty,
      setEditorDirty: () => {},
      confirmDiscard,
      tabs,
      activeTabId,
      activateTab: (id: string) => setActiveTabId(id),
      showMain: () => setActiveTabId(null),
      closeTab,
      closeTabsForPath,
      dirtyTabs,
      displayLibrary: activeTab?.lib ?? current,
      tabActive: true,
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
      activateLibrary,
      libraryCreated,
      removeLibrary,
      closeCurrentLibrary: () => {
        if (current) void closeLibraryInWorkspace(current.id);
        else setOpenIds([]);
      },
      requestFocusFile,
      openInEditorIn,
      openInViewerIn,
      openInEditor: openInEditorGuarded,
      closeFile: () => setActiveTabId(null),
      openInViewer: openInViewerGuarded,
      closeViewer: () => setActiveTabId(null),
      openDelivery: () => {
        if (!current) return;
        setFocusFile(null);
        upsertTab(current, "", "delivery");
      },
      closeDelivery: () => setActiveTabId(null),
    }),
    [libraries, current, workspace, expandedLibs, toggleLibExpanded, closeLibraryInWorkspace, scanStatus, wizardOpen, managerOpen, settingsSection, viewRequest, contentVersion, focusFile, openFile, editorDirty, deliveryOpen, viewerFile, tabs, activeTabId, activeTab, dirtyTabs, closeTab, closeTabsForPath, upsertTab, requestSearchView, requestView, requestTasksView, switchToLibrary, activateLibrary, libraryCreated, removeLibrary, requestFocusFile, confirmDiscard, closeDocument, openPath, pickAndOpenFile, openInEditorGuarded, openInViewerGuarded, openInEditorIn, openInViewerIn],
  );

  return (
    <LibraryContext.Provider value={value}>
      <SetTabDirtyContext.Provider value={setTabDirty}>{children}</SetTabDirtyContext.Provider>
    </LibraryContext.Provider>
  );
}

/** 标签作用域：把 current / openFile / viewerFile 等改写为「本标签」的视图，使各文档面板同时保持挂载、互不干扰 */
const TabScopeContext = createContext<{ tab: DocTab; active: boolean } | null>(null);

export function TabScope({ tab, active, children }: { tab: DocTab; active: boolean; children: ReactNode }) {
  const value = useMemo(() => ({ tab, active }), [tab, active]);
  return <TabScopeContext.Provider value={value}>{children}</TabScopeContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error("useLibrary 必须在 LibraryProvider 内使用");
  const scope = useContext(TabScopeContext);
  const { tab, active } = scope ?? { tab: null, active: true };
  const { closeTab, showMain, activateTab, dirtyTabs } = ctx;
  const setDirty = useContext(SetTabDirtyContext);
  // openFile / viewerFile 对象引用必须只随标签本身变化：各面板把它们放在 effect 依赖里，引用变化会触发重新加载并丢掉未保存的编辑
  const view = useMemo(() => {
    if (!tab) return null;
    const isViewer = tab.kind !== "editor" && tab.kind !== "delivery";
    return {
      setEditorDirty: (dirty: boolean) => setDirty(tab.id, dirty),
      openFile: tab.kind === "editor" ? { relativePath: tab.relativePath, nonce: tab.nonce } : null,
      viewerFile: isViewer
        ? { relativePath: tab.relativePath, kind: tab.kind as "pdf" | "office" | "hifi" | "image", nonce: tab.nonce, bytes: tab.bytes, preferText: tab.preferText, forceBuiltin: tab.forceBuiltin }
        : null,
    };
  }, [tab, setDirty]);
  return useMemo(() => {
    if (!tab || !view) return ctx;
    return {
      ...ctx,
      current: tab.lib,
      tabActive: active,
      openFile: view.openFile,
      viewerFile: view.viewerFile,
      deliveryOpen: tab.kind === "delivery",
      editorDirty: dirtyTabs.has(tab.id),
      setEditorDirty: view.setEditorDirty,
      // 标签内的「返回」只是回到主视图，标签保留；真正关闭用标签页上的 ×
      confirmDiscard: async () => true,
      closeFile: showMain,
      closeViewer: showMain,
      closeDelivery: showMain,
      closeDocument: () => closeTab(tab.id),
      activateTab,
      // 标签里发起的「打开」始终针对标签所属的库（转换出的副本、版式预览切换等），与当前活动库无关
      openInEditor: (rel: string) => ctx.openInEditorIn(tab.lib, rel),
      openInViewer: (rel: string, kind: "pdf" | "office" | "hifi" | "image", bytes?: ArrayBuffer, opts?: { preferText?: boolean; forceBuiltin?: boolean }) =>
        ctx.openInViewerIn(tab.lib, rel, kind, bytes, opts),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, tab, view, active, dirtyTabs, setDirty, closeTab, showMain, activateTab]);
}

const SetTabDirtyContext = createContext<(id: string, dirty: boolean) => void>(() => {});
