import { useState } from "react";
import { FolderOpen, Search, TriangleAlert } from "lucide-react";
import FileTypeIcon from "../components/FileTypeIcon";
import { useLibrary } from "../components/LibraryContext";
import * as api from "../lib/api";
import { formatSize, formatTime } from "../lib/format";
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

/**
 * 「搜索」视图（概念图「跨格式统一搜索」，v0.1 当前库范围）：
 * 文件名 + 正文（Markdown/文本/代码/JSON/YAML/CSV 等）统一检索。
 */
export default function SearchView() {
  const { current, requestFocusFile } = useLibrary();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState("");

  async function runSearch() {
    if (!current || !query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      setLastQuery(query.trim());
      setHits(await api.searchLibrary(current.id, query));
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
    <div className="mx-auto flex h-full max-w-4xl flex-col px-6 py-5">
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
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
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
              {lastQuery.length < 3
                ? "短关键词匹配范围有限，试试更长的关键词可获得更完整的正文检索结果"
                : "请检查关键词，或确认文件已完成索引"}
            </p>
          </div>
        ) : (
          <>
            <p className="mb-2 text-xs text-gray-500">
              找到 {hits.length} 个结果（{lastQuery}）
            </p>
            <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
              {hits.map((hit) => (
                <li key={hit.relativePath}>
                  <button
                    type="button"
                    onClick={() => requestFocusFile(hit.relativePath)}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-50"
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
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
