import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  Import,
  Pencil,
  Link2,
  Loader2,
  Plus,
  ShieldCheck,
  Star,
  Trash2,
  TriangleAlert,
  X,
  Check,
} from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import FileTypeIcon from "../components/FileTypeIcon";
import { useLibrary } from "../components/LibraryContext";
import * as api from "../lib/api";
import { EDITABLE_FORMATS, formatSize, formatTime, openRouteFor } from "../lib/format";
import { getLibraryLayout, getOfficeEngine } from "../lib/prefs";
import { useDialog } from "../components/DialogContext";
import type { FileEntry, LibraryMeta } from "../lib/types";

type SortKey = "name" | "mtime" | "size";

/** 激活其他库后需要延后执行的动作可用的回调（取自新库渲染后的最新版本） */
interface PendingHandlers {
  handleSelect: (entry: FileEntry) => void;
  openEntry: (entry: FileEntry) => void;
  navigate: (path: string) => void;
  openInEditor: (relativePath: string) => void;
}

const SMART_COLLECTIONS = [
  { label: "最近使用", icon: Clock },
  { label: "收藏", icon: Star },
  { label: "待审阅", icon: FilePlus2 },
  { label: "未关联", icon: Link2 },
] as const;

// ---------------------------------------------------------------------------
// 目录树（懒加载）
// ---------------------------------------------------------------------------

interface TreeCtx {
  expanded: Set<string>;
  cache: Map<string, FileEntry[]>;
  toggle: (entry: FileEntry) => void;
  selectedPath: string | null;
  onSelect: (entry: FileEntry) => void;
  onOpen: (entry: FileEntry) => void;
  onContextMenu: (entry: FileEntry, x: number, y: number) => void;
}

function TreeNode({ entry, depth, ctx }: { entry: FileEntry; depth: number; ctx: TreeCtx }) {
  const isOpen = ctx.expanded.has(entry.relativePath);
  const children = ctx.cache.get(entry.relativePath);
  const selected = ctx.selectedPath === entry.relativePath;

  return (
    <div>
      <div
        className={`flex w-full items-center gap-0.5 rounded-md pr-2 text-left text-[13px] transition-colors ${
          selected ? "bg-primary-50 text-primary-700" : "hover:bg-gray-100"
        }`}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
        onContextMenu={(e) => {
          e.preventDefault();
          ctx.onContextMenu(entry, e.clientX, e.clientY);
        }}
      >
        {/* 箭头：单击即展开 / 收起（目录专用） */}
        <button
          type="button"
          aria-label={isOpen ? "收起" : "展开"}
          title={isOpen ? "收起" : "展开"}
          onClick={(e) => {
            e.stopPropagation();
            if (entry.isDir) ctx.toggle(entry);
          }}
          className="flex h-6 w-4 shrink-0 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-600"
        >
          {entry.isDir && (isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />)}
        </button>
        {/* 名称区：单击选中（目录同时切换列表），双击打开 */}
        <button
          type="button"
          onClick={() => ctx.onSelect(entry)}
          onDoubleClick={() => {
            if (entry.isDir) ctx.toggle(entry);
            else ctx.onOpen(entry);
          }}
          title={entry.isDir ? "单击查看 · 点箭头展开 · 双击打开" : "双击打开（编辑 / 预览）"}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 pr-2"
        >
          <FileTypeIcon format={entry.format} size="sm" />
          <span className="truncate">{entry.name}</span>
        </button>
      </div>
      {entry.isDir && isOpen && (
        <div>
          {children === null && (
            <p className="py-1 text-xs text-gray-400" style={{ paddingLeft: `${(depth + 1) * 14 + 26}px` }}>
              加载中…
            </p>
          )}
          {children?.map((child) => (
            <TreeNode key={child.relativePath} entry={child} depth={depth + 1} ctx={ctx} />
          ))}
        </div>
      )}
    </div>
  );
}


/**
 * 工作区中的一个文档库：库名行（可折叠）+ 该库的目录树。
 * 每个库自己持有目录缓存；折叠时不加载，展开后才读取根目录。
 */
function LibrarySection({
  lib,
  flat,
  active,
  expanded,
  contentVersion,
  selectedPath,
  onToggle,
  onActivate,
  onClose,
  onNewFile,
  onNewFolder,
  onSelect,
  onOpen,
  onContextMenu,
}: {
  lib: LibraryMeta;
  /** 单库选择器模式：不画库名行，目录树始终展开 */
  flat?: boolean;
  active: boolean;
  expanded: boolean;
  contentVersion: number;
  selectedPath: string | null;
  onToggle: () => void;
  onActivate: () => void;
  onClose: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onSelect: (entry: FileEntry) => void;
  onOpen: (entry: FileEntry) => void;
  onContextMenu: (entry: FileEntry, x: number, y: number) => void;
}) {
  const [treeRoot, setTreeRoot] = useState<FileEntry[]>([]);
  const [dirExpanded, setDirExpanded] = useState<Set<string>>(new Set());
  const [cache, setCache] = useState<Map<string, FileEntry[]>>(new Map());
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  const load = useCallback(async (dir: string): Promise<FileEntry[]> => {
    try {
      return await api.listChildren(lib.id, dir);
    } catch (err) {
      console.error("加载目录失败", err);
      return [];
    }
  }, [lib.id]);

  // 展开 / 内容变化 → 刷新根目录与已展开目录（保留展开状态）
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    (async () => {
      const root = await load("");
      if (cancelled) return;
      setTreeRoot(root);
      for (const p of [...cacheRef.current.keys()]) {
        const children = await load(p);
        if (cancelled) return;
        setCache((prev) => new Map(prev).set(p, children));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, contentVersion, load]);

  const toggleDir = useCallback(
    async (entry: FileEntry) => {
      const path = entry.relativePath;
      setDirExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      if (!cacheRef.current.has(path)) {
        const entries = await load(path);
        setCache((prev) => new Map(prev).set(path, entries));
      }
    },
    [load],
  );

  const ctx: TreeCtx = {
    expanded: dirExpanded,
    cache,
    toggle: (e) => void toggleDir(e),
    selectedPath,
    onSelect,
    onOpen,
    onContextMenu,
  };

  if (flat) {
    return (
      <div>
        {treeRoot.length === 0 ? (
          <p className="py-2 text-center text-xs text-gray-400">（空）</p>
        ) : (
          treeRoot.map((entry) => <TreeNode key={entry.relativePath} entry={entry} depth={0} ctx={ctx} />)
        )}
      </div>
    );
  }

  return (
    <div className="mb-1">
      <div
        className={`group flex items-center gap-0.5 rounded-md pr-1 ${active ? "bg-primary-50" : "hover:bg-gray-100"}`}
        title={lib.rootPath}
      >
        <button
          type="button"
          aria-label={expanded ? "折叠文档库" : "展开文档库"}
          onClick={onToggle}
          className="flex h-7 w-5 shrink-0 items-center justify-center rounded text-gray-400 hover:text-gray-600"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={onActivate}
          onDoubleClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
        >
          <FolderOpen className={`h-4 w-4 shrink-0 ${active ? "text-primary-600" : "text-gray-400"}`} />
          <span className={`truncate text-[13px] font-semibold ${active ? "text-primary-700" : "text-gray-800"}`}>{lib.name}</span>
          <span className="shrink-0 text-[11px] text-gray-400">{lib.fileCount.toLocaleString()}</span>
        </button>
        <span className="hidden shrink-0 gap-0.5 group-hover:flex">
          <button type="button" title={`在「${lib.name}」根目录新建文档`} onClick={onNewFile}
            className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-primary-600">
            <FilePlus2 className="h-3.5 w-3.5" />
          </button>
          <button type="button" title={`在「${lib.name}」根目录新建文件夹`} onClick={onNewFolder}
            className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-primary-600">
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
          <button type="button" title={`从工作区关闭「${lib.name}」（不删除文件）`} onClick={onClose}
            className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-red-600">
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      {expanded && (
        <div className="ml-2 border-l border-gray-100 pl-1">
          {treeRoot.length === 0 ? (
            <p className="py-1 pl-4 text-xs text-gray-400">（空）</p>
          ) : (
            treeRoot.map((entry) => <TreeNode key={entry.relativePath} entry={entry} depth={0} ctx={ctx} />)
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * 「文档库」视图（概念图「多格式文档库主界面」）：
 * 左侧目录树与智能集合 · 中央文件列表 · 右侧详情面板。
 */
export default function LibraryView() {
  const { libraries, requestView, current, workspace, expandedLibs, toggleLibExpanded, closeLibraryInWorkspace, activateLibrary, scanStatus, openWizard, contentVersion, focusFile, openInEditor, openInViewer, openDelivery, closeTabsForPath } = useLibrary();
  const appDialog = useDialog();
  const [importing, setImporting] = useState(false);
  const [layout, setLayout] = useState(getLibraryLayout());
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => {
    const f = () => setLayout(getLibraryLayout());
    window.addEventListener("markflow:prefs-changed", f);
    return () => window.removeEventListener("markflow:prefs-changed", f);
  }, []);
  /** 选择器里可选的库：索引中的全部库（不含单文件隐式库），按名称排序 */
  const pickable = useMemo(
    () => libraries.filter((l) => !l.settings?.adhoc).sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN") || a.id.localeCompare(b.id)),
    [libraries],
  );
  const selectorLib = current && !current.settings?.adhoc ? current : null;
  const [currentDir, setCurrentDir] = useState("");
  const [list, setList] = useState<FileEntry[]>([]);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });
  const [selected, setSelected] = useState<FileEntry | null>(null);

  // 预热：选中 Word / PowerPoint 后稍等片刻（避免快速浏览时频繁触发），后台提前生成版式预览缓存
  useEffect(() => {
    if (!current || !selected || selected.isDir) return;
    if (selected.format !== "word" && selected.format !== "powerpoint") return;
    if (getOfficeEngine() === "builtin") return; // 偏好内置渲染时不启动 Office 预热
    const t = window.setTimeout(() => {
      void api.prewarmOfficePreview(current.id, selected.relativePath).catch(() => {});
    }, 700);
    return () => window.clearTimeout(t);
  }, [current, selected]);
  /** 右键菜单位置与目标 */
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry; lib: LibraryMeta } | null>(null);
  /** 对话框：新建文件 / 新建文件夹 / 重命名 / 移动；`lib` 明确记录操作所属的文档库 */
  const [dialog, setDialog] = useState<
    | { kind: "new-file"; dir: string; lib: LibraryMeta }
    | { kind: "new-folder"; dir: string; lib: LibraryMeta }
    | { kind: "rename"; entry: FileEntry; lib: LibraryMeta }
    | { kind: "move"; entry: FileEntry; lib: LibraryMeta }
    | null
  >(null);
  const [dirOptions, setDirOptions] = useState<string[]>([]);
  const [nameInput, setNameInput] = useState("");
  const [moveTarget, setMoveTarget] = useState("");
  const [busy, setBusy] = useState(false);

  const loadDir = useCallback(
    async (libraryId: string, dir: string): Promise<FileEntry[]> => {
      try {
        return await api.listChildren(libraryId, dir);
      } catch (err) {
        console.error("加载目录失败", err);
        return [];
      }
    },
    [],
  );

  // 切换文档库 → 整体重置并加载根目录（仅在库 ID 变化时触发，重扫不重置）
  const libraryId = current?.id;
  useEffect(() => {
    if (!libraryId) return;
    setCurrentDir("");
    setSelected(null);
    setList([]);
  }, [libraryId]);

  // 在非活动库的目录树里操作时：先激活该库，待其渲染完成后再执行（此时 current / 各回调都已是新库的）
  const pendingRef = useRef<{ libId: string; run: (h: PendingHandlers) => void } | null>(null);
  const handlersRef = useRef<PendingHandlers>(null as unknown as PendingHandlers);
  useEffect(() => {
    const p = pendingRef.current;
    if (p && p.libId === libraryId) {
      pendingRef.current = null;
      p.run(handlersRef.current);
    }
  }, [libraryId]);

  /** 对 `lib` 中的条目执行动作：本库直接执行，其他库先激活再执行 */
  function inLibrary(lib: LibraryMeta, run: (h: PendingHandlers) => void) {
    if (current?.id === lib.id) {
      run(handlersRef.current);
      return;
    }
    pendingRef.current = { libId: lib.id, run };
    void activateLibrary(lib.id).catch((err) => {
      if (pendingRef.current?.libId === lib.id) pendingRef.current = null;
      void appDialog.alert(String(err), "无法打开文档库");
    });
  }
  const currentDirRef = useRef(currentDir);
  currentDirRef.current = currentDir;

  // 搜索结果点击聚焦：跳到文件所在目录并选中
  useEffect(() => {
    if (!current || !focusFile) return;
    let cancelled = false;
    api
      .getFileDetail(current.id, focusFile.relativePath)
      .then((detail) => {
        if (!cancelled) {
          setCurrentDir(detail.parentPath);
          setSelected(detail);
        }
      })
      .catch((err) => console.error("定位文件失败", err));
    return () => {
      cancelled = true;
    };
  }, [current, focusFile]);

  // 进入目录 → 加载该目录子项作为中央列表
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    void loadDir(current.id, currentDir).then((entries) => {
      if (!cancelled) setList(entries);
    });
    return () => {
      cancelled = true;
    };
  }, [current, currentDir, contentVersion, loadDir]);

  function navigate(path: string) {
    setCurrentDir(path);
    setSelected(null);
  }

  function handleSelect(entry: FileEntry) {
    setSelected(entry);
    if (entry.isDir) setCurrentDir(entry.relativePath);
  }

  handlersRef.current = { handleSelect, openEntry, navigate, openInEditor };

  /** 统一打开路由：目录进入；PDF/Office/图片进查看器；文本类进编辑器 */
  function openEntry(entry: FileEntry) {
    if (entry.isDir) {
      navigate(entry.relativePath);
      return;
    }
    const route = openRouteFor(entry.format);
    if (route === "editor") {
      openInEditor(entry.relativePath);
    } else if (route === "system") {
      // 无内置查看器的格式：交给系统默认应用（不再是「双击没反应」）
      if (current) void api.openPathInSystem(current.id, entry.relativePath).catch((err) => appDialog.alert(String(err), "无法打开"));
    } else {
      openInViewer(entry.relativePath, route);
    }
  }

  async function startImport() {
    if (!current) return;
    const selected = await openFileDialog({
      multiple: false,
      filters: [
        { name: "可导入文件", extensions: ["docx", "html", "htm", "md", "markdown", "txt", "png", "jpg", "jpeg", "csv", "json", "yaml", "yml"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (!selected || Array.isArray(selected)) return;
    setImporting(true);
    try {
      const importedPath = await api.importFile(current.id, currentDir, selected);
      // 导入后跳到目标目录（列表会随重扫完成自动刷新）
      setCurrentDir(importedPath.includes("/") ? importedPath.slice(0, importedPath.lastIndexOf("/")) : "");
    } catch (err) {
      await appDialog.alert(`导入失败：${err}`, "导入失败");
    } finally {
      setImporting(false);
    }
  }

  // ---- 目录树文件操作（§6.3：冲突校验 + 操作后自动重扫） ----

  function openContext(entry: FileEntry, x: number, y: number, lib: LibraryMeta) {
    if (current?.id === lib.id) setSelected(entry);
    setMenu({ x, y, entry, lib });
  }

  function openNewFile(dir: string, lib: LibraryMeta) {
    setNameInput("新建文档.md");
    setDialog({ kind: "new-file", dir, lib });
  }

  function openNewFolder(dir: string, lib: LibraryMeta) {
    setNameInput("新建文件夹");
    setDialog({ kind: "new-folder", dir, lib });
  }

  function openRename(entry: FileEntry, lib: LibraryMeta) {
    setNameInput(entry.name);
    setDialog({ kind: "rename", entry, lib });
  }

  async function openMove(entry: FileEntry, lib: LibraryMeta) {
    setDialog({ kind: "move", entry, lib });
    try {
      const dirs = await api.listLibraryDirs(lib.id);
      setDirOptions(dirs);
      setMoveTarget(entry.parentPath);
    } catch (err) {
      await appDialog.alert(`加载目录失败：${err}`, "加载失败");
    }
  }

  async function runOperation(action: () => Promise<unknown>, successHint?: string) {
    setBusy(true);
    try {
      await action();
      setDialog(null);
      setMenu(null);
      if (successHint) console.log(successHint);
    } catch (err) {
      await appDialog.alert(`${err}`, "操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(entry: FileEntry, lib: LibraryMeta) {
    const ok = await appDialog.confirm({
      title: "删除到回收站",
      message:
        `确定删除「${lib.name}」中的「${entry.relativePath}」吗？\n\n` +
        (entry.isDir ? "整个文件夹（含全部内容）将" : "文件将") +
        "移入系统回收站，可从回收站还原；MarkFlow 索引会自动更新。",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    void runOperation(async () => {
      await api.deleteLibraryEntry(lib.id, entry.relativePath);
      await closeTabsForPath(lib.id, entry.relativePath);
    });
  }

  function toggleSort(key: SortKey) {
    setSort((prev) => (prev.key === key ? { key, asc: !prev.asc } : { key, asc: true }));
  }

  const sortedList = useMemo(() => {
    const dirs = list.filter((e) => e.isDir);
    const files = list.filter((e) => !e.isDir);
    const by = (a: FileEntry, b: FileEntry) => {
      switch (sort.key) {
        case "mtime":
          return (a.mtime - b.mtime) * (sort.asc ? 1 : -1);
        case "size":
          return (a.size - b.size) * (sort.asc ? 1 : -1);
        default:
          return a.name.localeCompare(b.name, "zh-Hans-CN") * (sort.asc ? 1 : -1);
      }
    };
    return [...dirs.sort(by), ...files.sort(by)];
  }, [list, sort]);

  if (!current && (layout === "side" ? workspace.length === 0 : libraries.length === 0)) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6">
        <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-100 text-gray-400">
          <FolderOpen className="h-8 w-8" />
        </span>
        <h2 className="mt-4 text-lg font-semibold text-gray-900">尚未打开文档库</h2>
        <p className="mt-2 max-w-sm text-center text-[13px] leading-relaxed text-gray-500">
          从标题栏或「开始」页打开文档库，或创建一个新的文档库。
        </p>
        <button
          type="button"
          onClick={openWizard}
          className="mt-6 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
        >
          创建文档库
        </button>
      </div>
    );
  }

  const isScanning = !!current && scanStatus.phase === "scanning" && scanStatus.libraryId === current.id;
  const scanFailed = !!current && scanStatus.phase === "failed" && scanStatus.libraryId === current.id;
  const crumbs = currentDir === "" ? [] : currentDir.split("/");

  const sortIcon = (key: SortKey) =>
    sort.key !== key ? null : sort.asc ? (
      <ChevronUp className="h-3 w-3" />
    ) : (
      <ChevronDown className="h-3 w-3" />
    );

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧：库信息、智能集合、目录树 */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-gray-200 bg-white">
        {layout === "selector" ? (
          <>
            {/* 文档库选择器：一次只显示一个库的目录树 */}
            <div className="relative border-b border-gray-100 px-2 py-2">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPickerOpen((v) => !v)}
                  title={selectorLib ? selectorLib.rootPath : "选择文档库"}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-left hover:bg-gray-50"
                >
                  <FolderOpen className="h-4 w-4 shrink-0 text-primary-600" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-gray-900">
                    {selectorLib ? selectorLib.name : "选择文档库"}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                </button>
                {selectorLib && (
                  <>
                    <button type="button" title={`在「${selectorLib.name}」根目录新建文档`} onClick={() => openNewFile("", selectorLib)}
                      className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-primary-600">
                      <FilePlus2 className="h-4 w-4" />
                    </button>
                    <button type="button" title={`在「${selectorLib.name}」根目录新建文件夹`} onClick={() => openNewFolder("", selectorLib)}
                      className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-primary-600">
                      <FolderPlus className="h-4 w-4" />
                    </button>
                  </>
                )}
              </div>
              {pickerOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setPickerOpen(false)} />
                  <div className="absolute left-2 right-2 top-full z-40 mt-1 max-h-72 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-xl">
                    {pickable.length === 0 && <p className="px-3 py-2 text-xs text-gray-400">还没有文档库</p>}
                    {pickable.map((lib) => (
                      <button
                        key={lib.id}
                        type="button"
                        onClick={() => {
                          setPickerOpen(false);
                          if (lib.id !== current?.id) inLibrary(lib, (h) => h.navigate(""));
                        }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-50"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-gray-800">{lib.name}</span>
                          <span className="block truncate text-[11px] text-gray-400">{lib.rootPath}</span>
                        </span>
                        {lib.id === current?.id && <Check className="h-3.5 w-3.5 shrink-0 text-primary-600" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div className="flex gap-1 border-b border-gray-100 px-2 py-1.5 text-[12.5px]">
              <span className="rounded-md bg-primary-50 px-2.5 py-1 font-medium text-primary-700">文件</span>
              <span title="按路线图后续交付" className="cursor-not-allowed rounded-md px-2.5 py-1 text-gray-300">大纲</span>
              <span title="按路线图后续交付" className="cursor-not-allowed rounded-md px-2.5 py-1 text-gray-300">引用</span>
            </div>
            <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {selectorLib ? (
                <LibrarySection
                  key={selectorLib.id}
                  lib={selectorLib}
                  flat
                  active
                  expanded
                  contentVersion={contentVersion}
                  selectedPath={selected?.relativePath ?? null}
                  onToggle={() => {}}
                  onActivate={() => {}}
                  onClose={() => {}}
                  onNewFile={() => {}}
                  onNewFolder={() => {}}
                  onSelect={(entry) => inLibrary(selectorLib, (h) => h.handleSelect(entry))}
                  onOpen={(entry) => inLibrary(selectorLib, (h) => h.openEntry(entry))}
                  onContextMenu={(entry, x, y) => openContext(entry, x, y, selectorLib)}
                />
              ) : (
                <p className="px-2 py-4 text-center text-xs text-gray-400">从上方选择器选择一个文档库</p>
              )}
            </nav>
            <div className="space-y-0.5 border-t border-gray-100 px-2 py-2 text-[13px]">
              <button type="button" onClick={openWizard}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-gray-600 hover:bg-gray-100">
                <Plus className="h-3.5 w-3.5" />
                添加文档库
              </button>
              <button type="button" onClick={() => requestView("home")}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-gray-600 hover:bg-gray-100">
                <FolderOpen className="h-3.5 w-3.5" />
                管理文档库
              </button>
            </div>
          </>
        ) : (
          <>
        <div className="space-y-0.5 border-b border-gray-100 px-2 py-2">
          {SMART_COLLECTIONS.map(({ label, icon: Icon }) => (
            <button
              key={label}
              type="button"
              disabled
              title="智能集合尚未开放，按路线图后续交付"
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-gray-400"
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
              <span className="ml-auto rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-400">未开放</span>
            </button>
          ))}
        </div>
        <p className="flex items-center justify-between px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-gray-400">
          文档库（{workspace.length}）
          <button
            type="button"
            title="创建或打开另一个文档库，并列显示在此处"
            onClick={openWizard}
            className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-primary-600"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </p>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {workspace.map((lib) => (
            <LibrarySection
              key={lib.id}
              lib={lib}
              active={current?.id === lib.id}
              expanded={expandedLibs.has(lib.id)}
              contentVersion={contentVersion}
              selectedPath={current?.id === lib.id ? (selected?.relativePath ?? null) : null}
              onToggle={() => toggleLibExpanded(lib.id)}
              onActivate={() => inLibrary(lib, (h) => h.navigate(""))}
              onClose={() => void closeLibraryInWorkspace(lib.id)}
              onNewFile={() => openNewFile("", lib)}
              onNewFolder={() => openNewFolder("", lib)}
              onSelect={(entry) => inLibrary(lib, (h) => h.handleSelect(entry))}
              onOpen={(entry) => inLibrary(lib, (h) => h.openEntry(entry))}
              onContextMenu={(entry, x, y) => openContext(entry, x, y, lib)}
            />
          ))}
        </nav>
          </>
        )}
      </aside>

      {!current && (
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center text-gray-400">
          <FolderOpen className="h-8 w-8" />
          <p className="mt-3 text-sm">在左侧选择一个文档库</p>
        </div>
      )}
      {current && (<>
      {/* 中央：面包屑 + 文件列表 */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-gray-200 bg-white px-4 py-2 text-[13px]">
          <button
            type="button"
            onClick={() => navigate("")}
            className="max-w-[200px] truncate font-medium text-gray-800 hover:text-primary-600"
          >
            {current.name}
          </button>
          {crumbs.map((seg, i) => {
            const path = crumbs.slice(0, i + 1).join("/");
            const isLast = i === crumbs.length - 1;
            return (
              <span key={path} className="flex min-w-0 items-center gap-1">
                <span className="text-gray-300">/</span>
                <button
                  type="button"
                  disabled={isLast}
                  onClick={() => navigate(path)}
                  className={`max-w-[180px] truncate ${isLast ? "font-medium text-gray-800" : "text-gray-500 hover:text-primary-600"}`}
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => openNewFile(currentDir, current)}
              title={`在「${current.name}」的当前目录新建 Markdown 文档`}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[13px] text-gray-600 hover:bg-gray-50"
            >
              <FilePlus2 className="h-3.5 w-3.5" />
              新建文档
            </button>
            <button
              type="button"
              disabled={importing || !current}
              title="选择本地文件导入当前目录：DOCX/HTML 自动转为 Markdown 副本，其余原样复制"
              onClick={() => void startImport()}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[13px] text-gray-600 hover:bg-gray-50 disabled:opacity-40"
            >
              <Import className="h-3.5 w-3.5" />
              {importing ? "导入中…" : "导入文件"}
            </button>
            <button
              type="button"
              disabled={!current}
              title="正式交付中心：多格式导出与交付历史"
              onClick={openDelivery}
              className="flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-primary-700 disabled:opacity-40"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              交付
            </button>
          </div>
          <span className="text-xs text-gray-400">{sortedList.length} 项</span>
        </div>

        {scanFailed && (
          <div className="flex items-start gap-2 bg-red-50 px-4 py-2.5 text-[13px] text-red-600">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-all">{scanStatus.error}</span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isScanning && list.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-gray-400">
              <Loader2 className="h-7 w-7 animate-spin" />
              <p className="mt-3 text-sm">正在扫描文档库，文件将在此出现…</p>
            </div>
          ) : sortedList.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-gray-400">
              <FolderOpen className="h-7 w-7" />
              <p className="mt-3 text-sm">此文件夹为空</p>
            </div>
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead className="sticky top-0 z-10 bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-4 py-2 font-medium">
                    <button type="button" onClick={() => toggleSort("name")} className="flex items-center gap-0.5 hover:text-gray-700">
                      名称 {sortIcon("name")}
                    </button>
                  </th>
                  <th className="w-28 px-3 py-2 font-medium">类型</th>
                  <th className="w-44 px-3 py-2 font-medium">
                    <button type="button" onClick={() => toggleSort("mtime")} className="flex items-center gap-0.5 hover:text-gray-700">
                      修改时间 {sortIcon("mtime")}
                    </button>
                  </th>
                  <th className="w-24 px-3 py-2 font-medium">
                    <button type="button" onClick={() => toggleSort("size")} className="flex items-center gap-0.5 hover:text-gray-700">
                      大小 {sortIcon("size")}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedList.map((entry) => (
                  <tr
                    key={entry.relativePath}
                    onClick={() => setSelected(entry)}
                    onDoubleClick={() => openEntry(entry)}
                    title={
                      entry.isDir
                        ? "双击进入目录"
                        : entry.format === "pdf"
                          ? "双击阅读（PDF.js）"
                          : entry.format === "word" || entry.format === "excel" || entry.format === "powerpoint"
                            ? "双击快速预览（提取文本 / 工作表 / 幻灯片）"
                            : entry.format === "image"
                              ? "双击查看图片（支持 OCR 文字识别）"
                            : EDITABLE_FORMATS.has(entry.format)
                              ? "双击编辑（Markdown 支持可视化 / 源码模式）"
                              : "使用系统应用打开（详见右侧详情）"
                    }
                    className={`cursor-default border-b border-gray-50 transition-colors ${
                      selected?.relativePath === entry.relativePath ? "bg-primary-50" : "hover:bg-gray-50"
                    }`}
                  >
                    <td className="max-w-0 px-4 py-2">
                      <span className="flex items-center gap-2.5">
                        <FileTypeIcon format={entry.format} size="sm" />
                        <span className="truncate text-gray-800">{entry.name}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-500">
                      {entry.formatLabel}
                    </td>
                    <td className="px-3 py-2 text-gray-500">{entry.isDir ? "—" : formatTime(entry.mtime)}</td>
                    <td className="px-3 py-2 text-gray-500">{entry.isDir ? "—" : formatSize(entry.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* 右侧：详情面板 */}
      <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-gray-200 bg-white">
        {selected ? (
          <div className="px-5 py-4">
            <div className="flex items-start gap-3">
              <FileTypeIcon format={selected.format} />
              <div className="min-w-0">
                <p className="break-all text-sm font-semibold text-gray-900">{selected.name}</p>
                <p className="mt-0.5 text-xs text-gray-400">
                  {selected.formatLabel}
                  {!selected.isDir && ` · ${formatSize(selected.size)}`}
                </p>
              </div>
            </div>

            <p className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-gray-400">基本信息</p>
            <dl className="space-y-2 text-[13px]">
              <div className="flex justify-between gap-3">
                <dt className="shrink-0 text-gray-500">类型</dt>
                <dd className="text-right text-gray-800">
                  {selected.formatLabel}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="shrink-0 text-gray-500">大小</dt>
                <dd className="text-right text-gray-800">{selected.isDir ? "—" : formatSize(selected.size)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="shrink-0 text-gray-500">修改时间</dt>
                <dd className="text-right text-gray-800">{selected.isDir ? "—" : formatTime(selected.mtime)}</dd>
              </div>
              <div>
                <dt className="text-gray-500">位置</dt>
                <dd className="mt-1 break-all rounded-lg bg-gray-50 px-2.5 py-1.5 text-xs leading-relaxed text-gray-600">
                  {selected.relativePath === ""
                    ? current.rootPath
                    : `${current.rootPath}\\${selected.relativePath.split("/").join("\\")}`}
                </dd>
              </div>
            </dl>

            <p className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-gray-400">标签</p>
            <div className="rounded-lg border border-dashed border-gray-200 px-3 py-3 text-center text-xs text-gray-400">
              标签功能尚未开放（按路线图后续交付）
            </div>

            <p className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-gray-400">相关文档</p>
            <div className="rounded-lg border border-dashed border-gray-200 px-3 py-3 text-center text-xs text-gray-400">
              尚未建立关联，文档关联与关系图按路线图交付
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center text-gray-400">
            <FolderOpen className="h-7 w-7" />
            <p className="mt-3 text-sm">选择文件或文件夹查看详情</p>
          </div>
        )}
      </aside>

      </>)}

      {/* 右键菜单 */}
      {menu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="fixed z-50 w-44 rounded-lg border border-gray-200 bg-white py-1 text-[13px] shadow-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            <p className="truncate px-3 pb-1 pt-0.5 text-[11px] text-gray-400">{menu.lib.name}</p>
            {menu.entry.isDir && (
              <>
                <MenuItem icon={<FilePlus2 className="h-3.5 w-3.5" />} label="新建文档"
                  onClick={() => { const d = menu.entry.relativePath; const l = menu.lib; setMenu(null); openNewFile(d, l); }} />
                <MenuItem icon={<FolderPlus className="h-3.5 w-3.5" />} label="新建文件夹"
                  onClick={() => { const d = menu.entry.relativePath; const l = menu.lib; setMenu(null); openNewFolder(d, l); }} />
                <MenuDivider />
              </>
            )}
            <MenuItem icon={<Pencil className="h-3.5 w-3.5" />} label="重命名"
              onClick={() => { const e2 = menu.entry; const l = menu.lib; setMenu(null); openRename(e2, l); }} />
            <MenuItem icon={<Import className="h-3.5 w-3.5" />} label="移动到…"
              onClick={() => { const e2 = menu.entry; const l = menu.lib; setMenu(null); void openMove(e2, l); }} />
            <MenuDivider />
            <MenuItem icon={<Trash2 className="h-3.5 w-3.5" />} label="删除（进回收站）" danger
              onClick={() => { const e2 = menu.entry; const l = menu.lib; setMenu(null); void confirmDelete(e2, l); }} />
          </div>
        </>
      )}

      {/* 操作对话框（新建 / 重命名 / 移动） */}
      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setDialog(null)}>
          <div className="w-[420px] rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {(dialog.kind === "new-file" || dialog.kind === "new-folder") && (
              <NameDialog
                title={dialog.kind === "new-file" ? "新建文档" : "新建文件夹"}
                libName={dialog.lib.name}
                location={dialog.dir || "库根目录"}
                value={nameInput}
                onChange={setNameInput}
                okLabel="创建"
                disabled={!nameInput.trim() || busy}
                onCancel={() => setDialog(null)}
                onOk={() => {
                  const dir = dialog.dir;
                  const name = nameInput.trim();
                  void runOperation(async () => {
                    if (dialog.kind === "new-file") {
                      await api.createTextFile(dialog.lib.id, dir, name, "# 新建文档");
                      const rel = dir ? dir + "/" + name : name;
                      inLibrary(dialog.lib, (h) => h.openInEditor(rel));
                    } else {
                      await api.createLibraryDirectory(dialog.lib.id, dir, name);
                    }
                  });
                }}
              />
            )}
            {dialog.kind === "rename" && (
              <NameDialog
                title="重命名"
                libName={dialog.lib.name}
                location={dialog.entry.relativePath}
                value={nameInput}
                onChange={setNameInput}
                okLabel="重命名"
                disabled={!nameInput.trim() || nameInput === dialog.entry.name || busy}
                onCancel={() => setDialog(null)}
                onOk={() => {
                  const e2 = dialog.entry;
                  const name = nameInput.trim();
                  void runOperation(async () => {
                    await api.renameLibraryEntry(dialog.lib.id, e2.relativePath, name);
                    await closeTabsForPath(dialog.lib.id, e2.relativePath);
                  });
                }}
              />
            )}
            {dialog.kind === "move" && (
              <>
                <h3 className="text-[15px] font-semibold text-gray-900">
                  移动到…
                  <LibBadge name={dialog.lib.name} />
                </h3>
                <p className="mt-1 text-xs text-gray-400">{dialog.entry.relativePath}</p>
                <select
                  value={moveTarget}
                  onChange={(e) => setMoveTarget(e.target.value)}
                  className="mt-4 h-9 w-full rounded-lg border border-gray-200 bg-white px-2 text-sm text-gray-700 outline-none focus:border-primary-500"
                >
                  <option value="">库根目录</option>
                  {dirOptions
                    .filter((d) => d !== dialog.entry.relativePath && !d.startsWith(dialog.entry.relativePath + "/"))
                    .map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                </select>
                <DialogButtons
                  onCancel={() => setDialog(null)}
                  okLabel="移动"
                  disabled={moveTarget === dialog.entry.parentPath || busy}
                  onOk={() => {
                    const e2 = dialog.entry;
                    const target = moveTarget;
                    void runOperation(async () => {
                      await api.moveLibraryEntry(dialog.lib.id, e2.relativePath, target);
                      await closeTabsForPath(dialog.lib.id, e2.relativePath);
                    });
                  }}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MenuDivider() {
  return <div className="my-1 h-px bg-gray-100" />;
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-50 ${
        danger ? "text-red-600 hover:bg-red-50" : "text-gray-700"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function LibBadge({ name }: { name: string }) {
  return (
    <span className="ml-2 inline-flex max-w-[200px] items-center gap-1 truncate rounded-md bg-primary-50 px-1.5 py-0.5 align-middle text-xs font-medium text-primary-700">
      <FolderOpen className="h-3 w-3 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

function NameDialog({
  title,
  libName,
  location,
  value,
  onChange,
  okLabel,
  onCancel,
  onOk,
  disabled,
}: {
  title: string;
  libName: string;
  location?: string;
  value: string;
  onChange: (v: string) => void;
  okLabel: string;
  onCancel: () => void;
  onOk: () => void;
  disabled?: boolean;
}) {
  return (
    <>
      <h3 className="text-[15px] font-semibold text-gray-900">
        {title}
        <LibBadge name={libName} />
        {location && <span className="ml-1.5 text-xs font-normal text-gray-400">位置：{location}</span>}
      </h3>
      <input
        autoFocus
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !disabled && onOk()}
        className="mt-4 h-9 w-full rounded-lg border border-gray-200 px-3 text-sm outline-none focus:border-primary-500"
      />
      <DialogButtons onCancel={onCancel} onOk={onOk} okLabel={okLabel} disabled={disabled} />
    </>
  );
}

function DialogButtons({
  onCancel,
  onOk,
  okLabel,
  disabled,
}: {
  onCancel: () => void;
  onOk: () => void;
  okLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <button type="button" onClick={onCancel} className="h-8 rounded-lg border border-gray-200 px-3 text-[13px] text-gray-600 hover:bg-gray-50">
        取消
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onOk}
        className="h-8 rounded-lg bg-primary-600 px-3 text-[13px] font-medium text-white hover:bg-primary-700 disabled:opacity-40"
      >
        {okLabel}
      </button>
    </div>
  );
}
