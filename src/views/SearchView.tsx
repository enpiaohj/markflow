import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FolderOpen, LocateFixed, Search, TriangleAlert } from "lucide-react";
import { useDialog } from "../components/DialogContext";
import FileTypeIcon from "../components/FileTypeIcon";
import { useLibrary } from "../components/LibraryContext";
import * as api from "../lib/api";
import { formatSize, formatTime, openRouteFor } from "../lib/format";
import type { SearchHit } from "../lib/types";

/** 把后端片段中的【…】命中标注渲染为高亮 */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(【[^】]*】)/g);
  return (
    <span>
      {parts.map((part, i) =>
        part.startsWith("【") && part.endsWith("】") ? (
          <mark key={i} className="rounded-sm bg-amber-100 px-0.5 text-amber-900">
            {part.slice(1, -1)}
          </mark>
        ) : (
          part
        ),
      )}
    </span>
  );
}

/** 每个文档库各自保留的搜索状态：切到其他页面再回来时恢复（视图组件卸载后不丢失） */
interface SavedSearch {
  query: string;
  lastQuery: string;
  hits: SearchHit[] | null;
  scrollTop: number;
}
const savedSearches = new Map<string, SavedSearch>();

/**
 * 「搜索」视图：当前文档库内文件名 + 正文统一检索（文本类与 Office 正文）。
 * 单击结果直接打开；搜索词、结果与滚动位置按文档库保留。
 */
export default function SearchView() {
  const { current, requestFocusFile, openInEditor, openInViewer } = useLibrary();
  const dialog = useDialog();

  /** 单击结果：按格式打开（编辑器 / PDF / Office / 图片查看器；无内置查看器的交给系统应用），与文档库双击一致 */
  function openHit(hit: SearchHit) {
    if (!current) return;
    const route = openRouteFor(hit.format);
    if (route === "editor") openInEditor(hit.relativePath);
    else if (route === "system")
      void api.openPathInSystem(current.id, hit.relativePath).catch((err) => dialog.alert(String(err), "无法打开"));
    else openInViewer(hit.relativePath, route);
  }
  const libId = current?.id ?? "";
  const restored = savedSearches.get(libId);
  const [query, setQuery] = useState(restored?.query ?? "");
  const [hits, setHits] = useState<SearchHit[] | null>(restored?.hits ?? null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState(restored?.lastQuery ?? "");
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const scrollTopRef = useRef(restored?.scrollTop ?? 0);

  // 切换文档库：换成该库自己保存的搜索状态
  const shownLibRef = useRef(libId);
  useEffect(() => {
    if (shownLibRef.current === libId) return;
    shownLibRef.current = libId;
    const st = savedSearches.get(libId);
    setQuery(st?.query ?? "");
    setHits(st?.hits ?? null);
    setLastQuery(st?.lastQuery ?? "");
    setError(null);
    scrollTopRef.current = st?.scrollTop ?? 0;
  }, [libId]);

  // 保存状态（每次变化即写入，离开页面时无需额外处理）
  useEffect(() => {
    if (libId) savedSearches.set(libId, { query, lastQuery, hits, scrollTop: scrollTopRef.current });
  }, [libId, query, lastQuery, hits]);

  // 恢复滚动位置（首次渲染出保存的结果后）
  useLayoutEffect(() => {
    if (resultsRef.current && scrollTopRef.current > 0) resultsRef.current.scrollTop = scrollTopRef.current;
    // 仅在挂载时恢复
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 回到搜索页时用同一关键词静默刷新结果（期间文件可能有增删改），保持列表与索引一致
  useEffect(() => {
    const st = savedSearches.get(libId);
    if (!libId || !st?.lastQuery) return;
    let cancelled = false;
    void api
      .searchLibrary(libId, st.lastQuery)
      .then((fresh) => {
        if (!cancelled) setHits(fresh);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [libId]);

  async function runSearch() {
    if (!current || !query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      setLastQuery(query.trim());
      setHits(await api.searchLibrary(current.id, query));
      scrollTopRef.current = 0;
      if (resultsRef.current) resultsRef.current.scrollTop = 0;
    } catch (err) {
      setError(String(err));
      setHits(null);
    } finally {
      setSearching(false);
    }
  }

  if (!current) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6">
        <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-100 text-gray-400">
          <Search className="h-8 w-8" />
        </span>
        <h2 className="mt-4 text-lg font-semibold text-gray-900">尚未打开文档库</h2>
        <p className="mt-2 max-w-sm text-center text-[13px] leading-relaxed text-gray-500">
          搜索范围是当前打开的文档库，请先从「开始」页或标题栏打开一个文档库。
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col px-8 py-6">
      {/* 搜索框 */}
      <div className="flex gap-2">
        <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3.5 focus-within:border-primary-500">
          <Search className="h-4 w-4 shrink-0 text-gray-400" />
          <input
            type="text"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void runSearch()}
            placeholder={`在「${current.name}」中搜索文件名与正文…`}
            className="w-full bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400"
          />
        </div>
        <button
          type="button"
          onClick={() => void runSearch()}
          disabled={searching || !query.trim()}
          className="h-10 shrink-0 rounded-lg bg-primary-600 px-5 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {searching ? "搜索中…" : "搜索"}
        </button>
      </div>
      <p className="mt-2 text-xs text-gray-400">
        检索文件名与正文（Markdown、文本、代码、JSON、YAML、CSV，以及 Word / Excel / PowerPoint 正文；PDF 正文暂不支持）。
        不足 3 个字符时使用逐文件的子串匹配，大库中速度会慢于长关键词。
      </p>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg bg-red-50 px-3.5 py-2.5 text-[13px] text-red-600">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}

      {/* 结果区 */}
      <div
        ref={resultsRef}
        onScroll={(e) => {
          scrollTopRef.current = e.currentTarget.scrollTop;
          const st = savedSearches.get(libId);
          if (st) st.scrollTop = e.currentTarget.scrollTop;
        }}
        className="mt-4 min-h-0 flex-1 overflow-y-auto"
      >
        {hits === null ? (
          !error && (
            <div className="flex h-full flex-col items-center justify-center text-gray-400">
              <FolderOpen className="h-7 w-7" />
              <p className="mt-3 text-sm">输入关键词开始搜索</p>
            </div>
          )
        ) : hits.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-gray-400">
            <Search className="h-7 w-7" />
            <p className="mt-3 text-sm">未找到与「{lastQuery}」匹配的内容</p>
            <p className="mt-1 text-xs text-gray-400">
              请检查关键词，或确认文件已完成索引（状态栏显示「已索引」后即可搜索）
            </p>
          </div>
        ) : (
          <>
            <p className="mb-2 text-xs text-gray-500">
              找到 {hits.length} 个结果（{lastQuery}）
            </p>
            <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
              {hits.map((hit) => (
                <li key={hit.relativePath} className="group flex items-start transition-colors hover:bg-gray-50">
                  <button
                    type="button"
                    onClick={() => openHit(hit)}
                    title="单击打开"
                    className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left"
                  >
                    <FileTypeIcon format={hit.format} name={hit.name} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-[13px] font-medium text-gray-900">{hit.name}</span>
                        <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500">
                          {hit.matchedIn === "name" ? "文件名" : "正文"}
                        </span>
                      </span>
                      {hit.snippet && (
                        <span className="mt-1 block truncate text-xs leading-relaxed text-gray-600">
                          <Snippet text={hit.snippet} />
                        </span>
                      )}
                      <span className="mt-1 block truncate text-[11px] text-gray-400">
                        {hit.parentPath || "库根目录"} · {formatSize(hit.size)} · {formatTime(hit.mtime)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => requestFocusFile(hit.relativePath)}
                    title="在文档库中定位"
                    aria-label="在文档库中定位"
                    className="mr-3 mt-3 shrink-0 rounded-md p-1.5 text-gray-400 opacity-0 transition-opacity hover:bg-gray-200 hover:text-primary-600 focus:opacity-100 group-hover:opacity-100"
                  >
                    <LocateFixed className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
