import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Loader2,
  Search,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useLibrary } from "./LibraryContext";
import { useZoom } from "./ZoomContext";
import * as api from "../lib/api";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * PDF 阅读器（设计文档 §5.2 L3 深度阅读，PDF.js 渲染）：
 * 页面渲染 / 翻页 / 缩放 / 跨页文本搜索定位。
 * 批注与 OCR 按 §8.8 / §8.10 路线后续交付。
 */
export default function PdfViewer({ external }: { external?: { bytes: ArrayBuffer; title: string } }) {
  const { current, viewerFile, closeViewer, openInViewer } = useLibrary();
  const { config: zoomConfig, zoomIn, zoomOut, configure: configureZoom } = useZoom();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const docRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null);
  const renderTaskRef = useRef<ReturnType<pdfjsLib.PDFPageProxy["render"]> | null>(null);

  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [searching, setSearching] = useState(false);
  const [hitPages, setHitPages] = useState<number[] | null>(null);

  const rel = external?.title ?? viewerFile?.relativePath ?? "";

  // 加载文档：外部字节（高保真预览）或库内文件
  useEffect(() => {
    if (external) {
      let disposed = false;
      setLoading(true);
      setError("");
      pdfjsLib
        .getDocument({ data: new Uint8Array(external.bytes) })
        .promise.then((doc) => {
          if (disposed) return;
          docRef.current = doc;
          setNumPages(doc.numPages);
          setPage(1);
          setLoading(false);
        })
        .catch((err) => {
          if (!disposed) {
            setError(String(err));
            setLoading(false);
          }
        });
      return () => {
        disposed = true;
      };
    }
    if (!current || !viewerFile || viewerFile.kind !== "pdf") return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setHitPages(null);
    setKeyword("");
    configureZoom({ visible: true, min: 0.4, max: 4, step: 0.2, value: 1.2 });
    api
      .readFileBytes(current.id, viewerFile.relativePath)
      .then(async (bytes: ArrayBuffer) => {
        if (cancelled) return;
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
        loadingTaskRef.current = loadingTask;
        const doc = await loadingTask.promise;
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }
        docRef.current = doc;
        setNumPages(doc.numPages);
        setPage(1);
        setLoading(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      void loadingTaskRef.current?.destroy();
      docRef.current = null;
      loadingTaskRef.current = null;
      configureZoom({ visible: false });
    };
  }, [current, viewerFile]);

  // 渲染当前页
  useEffect(() => {
    const doc = docRef.current;
    if (!doc || loading || numPages === 0) return;
    let cancelled = false;
    (async () => {
      const pg = await doc.getPage(Math.min(Math.max(page, 1), numPages));
      if (cancelled) return;
      const dpr = window.devicePixelRatio || 1;
      const viewport = pg.getViewport({ scale: zoomConfig.value * dpr });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;
      renderTaskRef.current?.cancel();
      const task = pg.render({ canvas, canvasContext: context, viewport });
      renderTaskRef.current = task;
      try {
        await task.promise;
      } catch {
        /* 渲染被取消属于正常流程 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [page, zoomConfig.value, loading, numPages]);

  const runSearch = useCallback(async () => {
    const doc = docRef.current;
    const q = keyword.trim();
    if (!doc || !q) {
      setHitPages(null);
      return;
    }
    setSearching(true);
    try {
      const hits: number[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const pg = await doc.getPage(i);
        const content = await pg.getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? String(item.str) : ""))
          .join("");
        if (text.toLowerCase().includes(q.toLowerCase())) {
          hits.push(i);
          if (hits.length >= 50) break;
        }
      }
      setHitPages(hits);
      if (hits.length > 0) setPage(hits[0]);
    } catch (err) {
      console.error("PDF 搜索失败", err);
    } finally {
      setSearching(false);
    }
  }, [keyword]);

  if (!current || !viewerFile) return null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-gray-100/70">
      {/* 工具栏 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-3">
        <button
          type="button"
          onClick={closeViewer}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-gray-500 hover:bg-gray-100"
        >
          <ArrowLeft className="h-4 w-4" />
          文档库
        </button>
        <span className="h-4 w-px bg-gray-200" />
        <FileText className="h-4 w-4 shrink-0 text-red-400" />
        <span className="min-w-0 truncate text-[13px] font-medium text-gray-800">{rel}</span>

        {/* 翻页 */}
        <div className="ml-2 flex items-center gap-1 rounded-lg border border-gray-200 px-1 py-0.5">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded p-0.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="px-1 text-xs text-gray-600">
            {page} / {numPages || "—"}
          </span>
          <button
            type="button"
            disabled={page >= numPages}
            onClick={() => setPage((p) => Math.min(numPages, p + 1))}
            className="rounded p-0.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {/* 缩放 */}
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 px-1 py-0.5">
          <button type="button" onClick={zoomOut} disabled={zoomConfig.value <= zoomConfig.min} className="rounded p-0.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30">
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="px-1 text-xs text-gray-600">{Math.round(zoomConfig.value * 100)}%</span>
          <button type="button" onClick={zoomIn} disabled={zoomConfig.value >= zoomConfig.max} className="rounded p-0.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30">
            <ZoomIn className="h-4 w-4" />
          </button>
        </div>

        {/* 搜索 */}
        <div className="ml-auto flex items-center gap-2">
          <div className="flex h-8 w-64 items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-gray-400" />
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void runSearch()}
              placeholder="在 PDF 中搜索文本…"
              className="w-full bg-transparent text-xs outline-none placeholder:text-gray-400"
            />
          </div>
          <button
            type="button"
            onClick={() => void runSearch()}
            disabled={searching || !keyword.trim()}
            className="h-8 rounded-lg border border-gray-200 bg-white px-2.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
          >
            {searching ? "搜索中…" : "搜索"}
          </button>
          {external && (
            <button
              type="button"
              onClick={() => openInViewer(rel, "office", undefined, { preferText: true })}
              title="切换到文本快速预览（提取文字，可转换为可编辑文档）"
              className="flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              文本预览 / 转换
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (current) void api.openPathInSystem(current.id, rel);
            }}
            title="使用系统默认应用打开（Word/WPS/Adobe 等）"
            className="flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 text-xs text-gray-600 hover:bg-gray-50"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            系统打开
          </button>
        </div>
      </div>

      {/* 搜索结果条 */}
      {hitPages !== null && (
        <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 bg-primary-50/60 px-4 py-1.5 text-xs text-gray-600">
          {hitPages.length === 0 ? (
            <span>未找到「{keyword}」</span>
          ) : (
            <>
              <span>
                「{keyword}」命中 {hitPages.length} 页：
              </span>
              {hitPages.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPage(p)}
                  className={`rounded px-1.5 py-0.5 hover:bg-primary-100 ${p === page ? "bg-primary-100 font-medium text-primary-700" : ""}`}
                >
                  第 {p} 页
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {/* 画布区 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-full flex-col items-center justify-center text-gray-400">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="mt-3 text-sm">正在加载 PDF…</p>
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-gray-500">
            <FileText className="h-7 w-7" />
            <p className="mt-3 max-w-md break-all text-center text-sm">{error}</p>
            <button
              type="button"
              onClick={() => current && void api.openPathInSystem(current.id, rel)}
              className="mt-4 flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              使用系统应用打开
            </button>
          </div>
        ) : (
          <div className="flex justify-center px-4 py-5">
            <canvas ref={canvasRef} className="rounded-md bg-white shadow-md ring-1 ring-gray-300/60" />
          </div>
        )}
      </div>

      <p className="shrink-0 border-t border-gray-200 bg-white px-4 py-1 text-[11px] text-gray-400">
        v0.3 快速阅读：渲染 / 翻页 / 缩放 / 文本搜索；批注与 OCR 按 §8.8、§8.10 路线交付。
      </p>
    </div>
  );
}
