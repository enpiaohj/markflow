import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  FilePlus2,
  FolderOpen,
  Import,
  Link2,
  Loader2,
  Star,
  TriangleAlert,
} from "lucide-react";
import FileTypeIcon from "../components/FileTypeIcon";
import { useLibrary } from "../components/LibraryContext";
import * as api from "../lib/api";
import { EDITABLE_FORMATS, formatSize, formatTime } from "../lib/format";
import type { FileEntry } from "../lib/types";

type SortKey = "name" | "mtime" | "size";

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
}

function TreeNode({ entry, depth, ctx }: { entry: FileEntry; depth: number; ctx: TreeCtx }) {
  const isOpen = ctx.expanded.has(entry.relativePath);
  const children = ctx.cache.get(entry.relativePath);
  const selected = ctx.selectedPath === entry.relativePath;

  return (
    <div>
      <button
        type="button"
        onClick={() => ctx.onSelect(entry)}
        onDoubleClick={() => entry.isDir && ctx.toggle(entry)}
        title={entry.name}
        className={`flex w-full items-center gap-1 rounded-md py-1.5 pr-2 text-left text-[13px] transition-colors ${
          selected ? "bg-primary-50 text-primary-700" : "text-gray-700 hover:bg-gray-100"
        }`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-gray-400">
          {entry.isDir &&
            (isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />)}
        </span>
        <FileTypeIcon format={entry.format} size="sm" />
        <span className="truncate">{entry.name}</span>
      </button>
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

// ---------------------------------------------------------------------------

/**
 * 「文档库」视图（概念图「多格式文档库主界面」）：
 * 左侧目录树与智能集合 · 中央文件列表 · 右侧详情面板。
 */
export default function LibraryView() {
  const { current, scanStatus, openWizard, contentVersion, focusFile, openInEditor } = useLibrary();
  const [currentDir, setCurrentDir] = useState("");
  const [treeRoot, setTreeRoot] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [cache, setCache] = useState<Map<string, FileEntry[]>>(new Map());
  const [list, setList] = useState<FileEntry[]>([]);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });
  const [selected, setSelected] = useState<FileEntry | null>(null);

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

  // 切换文档库 / 扫描完成 / 文件监听重扫 → 重置并加载根目录
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    setCurrentDir("");
    setExpanded(new Set());
    setCache(new Map());
    setSelected(null);
    void loadDir(current.id, "").then((entries) => {
      if (!cancelled) {
        setTreeRoot(entries);
        setList(entries);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [current, scanStatus.phase, contentVersion, loadDir]);

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
  }, [current, currentDir, loadDir]);

  // 目录树展开 → 懒加载子目录
  const toggleDir = useCallback(
    async (entry: FileEntry) => {
      if (!current) return;
      const path = entry.relativePath;
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      if (!cache.has(path)) {
        const entries = await loadDir(current.id, path);
        setCache((prev) => new Map(prev).set(path, entries));
      }
    },
    [current, cache, loadDir],
  );

  function navigate(path: string) {
    setCurrentDir(path);
    setSelected(null);
  }

  function handleSelect(entry: FileEntry) {
    setSelected(entry);
    if (entry.isDir) setCurrentDir(entry.relativePath);
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

  if (!current) {
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

  const isScanning = scanStatus.phase === "scanning" && scanStatus.libraryId === current.id;
  const scanFailed = scanStatus.phase === "failed" && scanStatus.libraryId === current.id;
  const crumbs = currentDir === "" ? [] : currentDir.split("/");
  const treeCtx: TreeCtx = { expanded, cache, toggle: (e) => void toggleDir(e), selectedPath: selected?.relativePath ?? null, onSelect: handleSelect };

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
        <div className="border-b border-gray-100 px-4 py-3">
          <p className="truncate text-sm font-semibold text-gray-900">{current.name}</p>
          <p className="mt-0.5 text-xs text-gray-400">{current.fileCount.toLocaleString()} 个文件</p>
        </div>
        <div className="space-y-0.5 border-b border-gray-100 px-2 py-2">
          {SMART_COLLECTIONS.map(({ label, icon: Icon }) => (
            <button
              key={label}
              type="button"
              disabled
              title="智能集合将在后续迭代实现"
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-gray-400"
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
        <p className="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-gray-400">目录</p>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {treeRoot.map((entry) => (
            <TreeNode key={entry.relativePath} entry={entry} depth={0} ctx={treeCtx} />
          ))}
        </nav>
      </aside>

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
              disabled
              title="将在后续迭代实现"
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[13px] text-gray-400"
            >
              <FilePlus2 className="h-3.5 w-3.5" />
              新建文档
            </button>
            <button
              type="button"
              disabled
              title="将在后续迭代实现"
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[13px] text-gray-400"
            >
              <Import className="h-3.5 w-3.5" />
              导入文件
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
                    onDoubleClick={() =>
                      entry.isDir
                        ? navigate(entry.relativePath)
                        : EDITABLE_FORMATS.has(entry.format)
                          ? openInEditor(entry.relativePath)
                          : undefined
                    }
                    title={
                      entry.isDir
                        ? "双击进入目录"
                        : EDITABLE_FORMATS.has(entry.format)
                          ? "双击编辑（Markdown 支持可视化 / 源码模式）"
                          : "预览能力按 v0.3 路线交付"
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
              标签功能将在后续迭代提供
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
    </div>
  );
}
