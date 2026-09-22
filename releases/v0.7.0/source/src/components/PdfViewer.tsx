import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Loader2,
  PanelLeft,
  Search,
} from "lucide-react";
import { useLibrary } from "./LibraryContext";
import { useZoom } from "./ZoomContext";
import * as api from "../lib/api";
import { officeKind } from "../lib/format";
import { useExternalChange } from "../lib/useExternalChange";
import EngineSwitch from "./office/EngineSwitch";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/** 页面之间的间距（px） */
const PAGE_GAP = 12;
/** 视口上下各预渲染的距离（px）：滚动时页面已经就绪，离开后释放画布 */
const RENDER_MARGIN = 1600;

interface PageSize {
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// 单页：进入视口附近才渲染画布与文字层，远离后释放，长文档也不占内存
// ---------------------------------------------------------------------------

const PdfPage = memo(function PdfPage({
  doc,
  pageNumber,
  scale,
  size,
  keyword,
  root,
  register,
}: {
  doc: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  size: PageSize;
  keyword: string;
  root: HTMLDivElement | null;
  register: (n: number, el: HTMLDivElement | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(false);

  useLayoutEffect(() => {
    register(pageNumber, wrapRef.current);
    return () => register(pageNumber, null);
  }, [pageNumber, register]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !root) return;
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), {
      root,
      rootMargin: `${RENDER_MARGIN}px 0px`,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const textDiv = textRef.current;
    if (!canvas || !textDiv) return;
    if (!near) {
      // 释放画布内存与文字层
      canvas.width = 0;
      canvas.height = 0;
      textDiv.replaceChildren();
      return;
    }
    let cancelled = false;
    let renderTask: ReturnType<pdfjsLib.PDFPageProxy["render"]> | null = null;
    let textLayer: pdfjsLib.TextLayer | null = null;
    (async () => {
      const pg = await doc.getPage(pageNumber);
      if (cancelled) return;
      const dpr = window.devicePixelRatio || 1;
      const cssViewport = pg.getViewport({ scale });
      const pixelViewport = pg.getViewport({ scale: scale * dpr });
      canvas.width = Math.floor(pixelViewport.width);
      canvas.height = Math.floor(pixelViewport.height);
      canvas.style.width = `${cssViewport.width}px`;
      canvas.style.height = `${cssViewport.height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      renderTask = pg.render({ canvas, canvasContext: ctx, viewport: pixelViewport });
      try {
        await renderTask.promise;
      } catch {
        return; // 渲染被取消属于正常流程
      }
      if (cancelled) return;
      // 文字层：支持选中复制与搜索高亮
      textDiv.replaceChildren();
      textDiv.style.setProperty("--scale-factor", String(scale));
      textDiv.style.setProperty("--total-scale-factor", String(scale));
      textLayer = new pdfjsLib.TextLayer({
        textContentSource: pg.streamTextContent(),
        container: textDiv,
        viewport: cssViewport,
      });
      try {
        await textLayer.render();
      } catch {
        return;
      }
      if (cancelled || !keyword) return;
      const q = keyword.toLowerCase();
      textDiv.querySelectorAll("span").forEach((s) => {
        if ((s.textContent ?? "").toLowerCase().includes(q)) s.classList.add("mf-pdf-hit");
      });
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [near, doc, pageNumber, scale, keyword]);

  return (
    <div
      ref={wrapRef}
      data-page={pageNumber}
      className="relative shrink-0 bg-white shadow-md ring-1 ring-gray-300/60"
      style={{ width: size.w * scale, height: size.h * scale }}
    >
      <canvas ref={canvasRef} className="block" />
      <div ref={textRef} className="textLayer" />
    </div>
  );
});

// ---------------------------------------------------------------------------
// 缩略图：只在进入视口时渲染
// ---------------------------------------------------------------------------

const PdfThumb = memo(function PdfThumb({
  doc,
  pageNumber,
  active,
  root,
  onClick,
}: {
  doc: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  active: boolean;
  root: HTMLDivElement | null;
  onClick: () => void;
}) {
  const boxRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);
  const doneRef = useRef(false);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !root) return;
    const io = new IntersectionObserver((e) => setVisible(e.some((x) => x.isIntersecting)), { root, rootMargin: "300px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!visible || doneRef.current) return;
    let cancelled = false;
    (async () => {
      const pg = await doc.getPage(pageNumber);
      const base = pg.getViewport({ scale: 1 });
      const scale = 96 / base.width;
      const vp = pg.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx || cancelled) return;
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = "96px";
      canvas.style.height = `${(base.height * 96) / base.width}px`;
      try {
        await pg.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
        doneRef.current = true;
      } catch {
        /* 取消 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, doc, pageNumber]);

  return (
    <button
      ref={boxRef}
      type="button"
      onClick={onClick}
      className={`mx-auto mb-2 flex flex-col items-center rounded-md p-1 text-[10px] ${
        active ? "bg-primary-100 text-primary-700 ring-1 ring-primary-300" : "text-gray-500 hover:bg-gray-100"
      }`}
    >
      <canvas ref={canvasRef} className="bg-white shadow-sm ring-1 ring-gray-200" style={{ minHeight: 40, width: 96 }} />
      <span className="mt-0.5">{pageNumber}</span>
    </button>
  );
});

// ---------------------------------------------------------------------------
// 查看器
// ---------------------------------------------------------------------------

/**
 * PDF 阅读器（设计文档 §5.2 L3 深度阅读，PDF.js 渲染）：
 * 连续滚动（虚拟化页面）、可选中文字层、缩略图导航、自适应宽度 + 缩放、跨页搜索高亮。
 * 库内 PDF 与 Office 导出的版式预览（external）共用。
 */
export default function PdfViewer({ external }: { external?: { bytes: ArrayBuffer; title: string } }) {
  const { current, viewerFile, closeViewer, openInViewer } = useLibrary();
  const { config: zoomConfig, configure: configureZoom } = useZoom();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageEls = useRef<Map<number, HTMLDivElement>>(new Map());
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [thumbRoot, setThumbRoot] = useState<HTMLDivElement | null>(null);

  const [doc, setDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [activeKeyword, setActiveKeyword] = useState("");
  const [searching, setSearching] = useState(false);
  const [hitPages, setHitPages] = useState<number[] | null>(null);
  const [showThumbs, setShowThumbs] = useState(true);
  const [containerW, setContainerW] = useState(0);
  const [reloadNonce, setReloadNonce] = useState(0);

  const rel = external?.title ?? viewerFile?.relativePath ?? "";

  // 外部修改：库内 PDF 直接重新加载；Office 版式预览回到文本预览入口并重新导出
  useExternalChange(current?.id, rel, () => {
    if (external) openInViewer(rel, "office");
    else setReloadNonce((n) => n + 1);
  });

  const register = useCallback((n: number, el: HTMLDivElement | null) => {
    if (el) pageEls.current.set(n, el);
    else pageEls.current.delete(n);
  }, []);

  // 加载文档：外部字节（Office 版式预览）或库内文件
  useEffect(() => {
    if (!external && (!current || !viewerFile || viewerFile.kind !== "pdf")) return;
    let cancelled = false;
    let task: pdfjsLib.PDFDocumentLoadingTask | null = null;
    setLoading(true);
    setError("");
    setHitPages(null);
    setActiveKeyword("");
    setDoc(null);
    configureZoom({ visible: true, min: 0.5, max: 3, step: 0.1, value: 1, presets: [0.5, 0.75, 1, 1.25, 1.5, 2, 3] });
    (async () => {
      try {
        const bytes: ArrayBuffer = external ? external.bytes : await api.readFileBytes(current!.id, viewerFile!.relativePath);
        if (cancelled) return;
        task = pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)) });
        const d = await task.promise;
        if (cancelled) {
          void task.destroy();
          return;
        }
        // 先取第一页尺寸让界面立即可用，其余页尺寸后台补全（版式不一致的文档也能准确布局）
        const first = (await d.getPage(1)).getViewport({ scale: 1 });
        const initial: PageSize[] = Array.from({ length: d.numPages }, () => ({ w: first.width, h: first.height }));
        setSizes(initial);
        setNumPages(d.numPages);
        setDoc(d);
        setPage(1);
        setLoading(false);
        for (let start = 2; start <= d.numPages; start += 40) {
          const batch = initial.slice();
          for (let i = start; i < start + 40 && i <= d.numPages; i++) {
            const v = (await d.getPage(i)).getViewport({ scale: 1 });
            batch[i - 1] = { w: v.width, h: v.height };
          }
          if (cancelled) return;
          initial.splice(0, initial.length, ...batch);
          setSizes(batch);
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
      configureZoom({ visible: false });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, viewerFile, external, reloadNonce]);

  // 容器宽度：用于「自适应宽度」基准缩放
  useEffect(() => {
    if (!root) return;
    const ro = new ResizeObserver(() => setContainerW(root.clientWidth));
    setContainerW(root.clientWidth);
    ro.observe(root);
    return () => ro.disconnect();
  }, [root]);

  const firstW = sizes[0]?.w ?? 612;
  const fitScale = containerW > 0 ? Math.min(2.5, Math.max(0.4, (containerW - 64) / firstW)) : 1;
  const scale = fitScale * zoomConfig.value;

  // 滚动时更新当前页
  const updateCurrentPage = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const probe = el.scrollTop + el.clientHeight * 0.3;
    let best = 1;
    for (const [n, node] of pageEls.current) {
      if (node.offsetTop <= probe && n > best) best = n;
    }
    setPage(best);
    setPageInput(String(best));
  }, []);

  const rafRef = useRef(0);
  const onScroll = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      updateCurrentPage();
    });
  }, [updateCurrentPage]);

  const goTo = useCallback(
    (n: number) => {
      const target = Math.min(Math.max(n, 1), numPages || 1);
      const el = pageEls.current.get(target);
      if (el && scrollRef.current) scrollRef.current.scrollTo({ top: el.offsetTop - PAGE_GAP, behavior: "auto" });
      setPage(target);
      setPageInput(String(target));
    },
    [numPages],
  );

  const runSearch = useCallback(async () => {
    const q = keyword.trim();
    if (!doc || !q) {
      setHitPages(null);
      setActiveKeyword("");
      return;
    }
    setSearching(true);
    try {
      const hits: number[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const pg = await doc.getPage(i);
        const content = await pg.getTextContent();
        const text = content.items.map((item) => ("str" in item ? String(item.str) : "")).join("");
        if (text.toLowerCase().includes(q.toLowerCase())) {
          hits.push(i);
          if (hits.length >= 100) break;
        }
      }
      setHitPages(hits);
      setActiveKeyword(q);
      if (hits.length > 0) goTo(hits[0]);
    } catch (err) {
      console.error("PDF 搜索失败", err);
    } finally {
      setSearching(false);
    }
  }, [keyword, doc, goTo]);

  if (!external && (!current || !viewerFile)) return null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-gray-100/70">
      <style>{`.mf-pdf-hit{background:rgba(250,204,21,.45)!important;color:transparent}`}</style>
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

        <button
          type="button"
          onClick={() => setShowThumbs((v) => !v)}
          title="缩略图导航"
          className={`rounded p-1 ${showThumbs ? "bg-primary-50 text-primary-600" : "text-gray-400 hover:bg-gray-100"}`}
        >
          <PanelLeft className="h-4 w-4" />
        </button>

        {/* 页码 */}
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 px-1 py-0.5">
          <button type="button" disabled={page <= 1} onClick={() => goTo(page - 1)} className="rounded p-0.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <input
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && goTo(Number(pageInput) || 1)}
            onBlur={() => setPageInput(String(page))}
            className="w-9 rounded border border-transparent bg-transparent text-center text-xs text-gray-700 outline-none focus:border-primary-300 focus:bg-white"
          />
          <span className="text-xs text-gray-400">/ {numPages || "—"}</span>
          <button type="button" disabled={page >= numPages} onClick={() => goTo(page + 1)} className="rounded p-0.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <span className="text-[11px] text-gray-400" title="缩放请用状态栏、Ctrl + 滚轮或 Ctrl + +/−">
          {Math.round(zoomConfig.value * 100)}%
        </span>

        {/* 搜索 */}
        <div className="ml-auto flex items-center gap-2">
          <div className="flex h-8 w-64 items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-gray-400" />
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void runSearch()}
              placeholder="在文档中搜索文本…"
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
          {external && officeKind(rel) !== "excel" && (
            <EngineSwitch
              builtin={false}
              officeLabel="Office 版式"
              onBuiltin={() => openInViewer(rel, "office", undefined, { forceBuiltin: true })}
              onOffice={() => {}}
            />
          )}
          {external && officeKind(rel) === "excel" && (
            <button
              type="button"
              onClick={() => openInViewer(rel, "office")}
              title="回到原生表格视图"
              className="flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              原生表格
            </button>
          )}
          {external && officeKind(rel) !== "excel" && (
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
            title="使用系统默认应用打开并编辑（Word / WPS / Adobe 等）；保存后回到 MarkFlow 会自动刷新预览"
            className="flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 text-xs text-gray-600 hover:bg-gray-50"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            系统打开
          </button>
        </div>
      </div>

      {/* 搜索结果条 */}
      {hitPages !== null && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 bg-primary-50/60 px-4 py-1.5 text-xs text-gray-600">
          {hitPages.length === 0 ? (
            <span>未找到「{keyword}」</span>
          ) : (
            <>
              <span>「{activeKeyword}」命中 {hitPages.length} 页：</span>
              {hitPages.slice(0, 40).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => goTo(p)}
                  className={`rounded px-1.5 py-0.5 hover:bg-primary-100 ${p === page ? "bg-primary-100 font-medium text-primary-700" : ""}`}
                >
                  第 {p} 页
                </button>
              ))}
            </>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 缩略图导航 */}
        {showThumbs && doc && numPages > 1 && (
          <div ref={setThumbRoot} className="w-[124px] shrink-0 overflow-y-auto border-r border-gray-200 bg-white/70 py-2">
            {Array.from({ length: numPages }, (_, i) => (
              <PdfThumb key={i} doc={doc} pageNumber={i + 1} active={page === i + 1} root={thumbRoot} onClick={() => goTo(i + 1)} />
            ))}
          </div>
        )}

        {/* 连续滚动的页面区 */}
        <div
          ref={(el) => {
            scrollRef.current = el;
            if (el !== root) setRoot(el);
          }}
          onScroll={onScroll}
          tabIndex={0}
          className="relative min-w-0 flex-1 overflow-auto outline-none"
        >
          {loading ? (
            <div className="flex h-full flex-col items-center justify-center text-gray-400">
              <Loader2 className="h-6 w-6 animate-spin" />
              <p className="mt-3 text-sm">正在加载文档…</p>
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
          ) : doc ? (
            <div className="flex w-max min-w-full flex-col items-center px-8 py-4" style={{ gap: PAGE_GAP }}>
              {sizes.map((size, i) => (
                <PdfPage
                  key={i}
                  doc={doc}
                  pageNumber={i + 1}
                  scale={scale}
                  size={size}
                  keyword={activeKeyword}
                  root={root}
                  register={register}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
