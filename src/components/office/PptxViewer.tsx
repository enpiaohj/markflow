import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import * as api from "../../lib/api";
import type { SlidesMeta, SlidesProgress } from "../../lib/types";

/**
 * PowerPoint 幻灯片查看器：缩略图导航 + 单页大图。
 * 图片由本机 PowerPoint 后台逐页导出，导出一页就显示一页（边导边看），已缓存的演示文稿秒开。
 */
export default function PptxViewer({
  libraryId,
  relativePath,
  reloadKey,
  titles,
  zoom,
  onFail,
}: {
  libraryId: string;
  relativePath: string;
  reloadKey: number;
  /** 文本提取得到的每页标题（导出未完成时的占位） */
  titles: string[];
  zoom: number;
  onFail: (message: string) => void;
}) {
  const [progress, setProgress] = useState<SlidesProgress | null>(null);
  const [meta, setMeta] = useState<SlidesMeta | null>(null);
  const [index, setIndex] = useState(1);
  const [urls, setUrls] = useState<Record<number, string>>({});
  const urlsRef = useRef<Record<number, string>>({});
  const inflight = useRef<Set<number>>(new Set());
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const failRef = useRef(onFail);
  failRef.current = onFail;

  // 启动导出并监听进度
  useEffect(() => {
    let disposed = false;
    const requestId = crypto.randomUUID();
    setProgress(null);
    setMeta(null);
    setIndex(1);
    for (const u of Object.values(urlsRef.current)) URL.revokeObjectURL(u);
    urlsRef.current = {};
    inflight.current.clear();
    setUrls({});
    const un = listen<{ requestId: string; progress: SlidesProgress }>("pptx:progress", (e) => {
      if (!disposed && e.payload.requestId === requestId) setProgress(e.payload.progress);
    });
    api
      .pptxExportSlides(requestId, libraryId, relativePath)
      .then((m) => {
        if (!disposed) {
          setMeta(m);
          setProgress({ key: m.key, count: m.count, width: m.width, height: m.height, ready: m.count });
        }
      })
      .catch((err) => {
        if (!disposed) failRef.current(String(err));
      });
    return () => {
      disposed = true;
      void un.then((f) => f());
    };
  }, [libraryId, relativePath, reloadKey]);

  // 卸载时释放所有 Blob URL
  useEffect(
    () => () => {
      for (const u of Object.values(urlsRef.current)) URL.revokeObjectURL(u);
      urlsRef.current = {};
    },
    [],
  );

  const load = useCallback(async (key: string, i: number) => {
    if (urlsRef.current[i] || inflight.current.has(i)) return;
    inflight.current.add(i);
    try {
      const bytes = await api.readPreviewSlide(key, i);
      const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
      urlsRef.current = { ...urlsRef.current, [i]: url };
      setUrls(urlsRef.current);
    } catch {
      /* 稍后随进度事件重试 */
    } finally {
      inflight.current.delete(i);
    }
  }, []);

  // 加载图片：当前页优先，其次按顺序加载其余已就绪的页
  useEffect(() => {
    if (!progress) return;
    const order = [index, ...Array.from({ length: progress.ready }, (_, k) => k + 1).filter((k) => k !== index)];
    for (const i of order) {
      if (i <= progress.ready) void load(progress.key, i);
    }
  }, [progress, index, load]);

  // 容器尺寸 → 大图自适应
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    setBox({ w: el.clientWidth, h: el.clientHeight });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const count = progress?.count ?? titles.length;
  const go = (n: number) => setIndex(Math.min(Math.max(n, 1), Math.max(count, 1)));
  const fit =
    progress && box.w > 0 ? Math.min((box.w - 48) / progress.width, (box.h - 48) / progress.height) * zoom : 0;
  const ready = progress?.ready ?? 0;

  return (
    <div
      className="flex h-full min-h-0 outline-none"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown") {
          e.preventDefault();
          go(index + 1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") {
          e.preventDefault();
          go(index - 1);
        } else if (e.key === "Home") go(1);
        else if (e.key === "End") go(count);
      }}
    >
      {/* 缩略图导航 */}
      <div className="w-[188px] shrink-0 overflow-y-auto border-r border-gray-200 bg-white/70 p-2">
        {Array.from({ length: count }, (_, k) => k + 1).map((i) => (
          <button
            key={i}
            type="button"
            onClick={() => go(i)}
            className={`mb-2 flex w-full gap-1.5 rounded-md p-1 text-left ${i === index ? "bg-primary-100 ring-1 ring-primary-300" : "hover:bg-gray-100"}`}
          >
            <span className="w-4 shrink-0 pt-0.5 text-right text-[10px] text-gray-500">{i}</span>
            {urls[i] ? (
              <img src={urls[i]} alt={`第 ${i} 页`} className="w-full rounded-sm bg-white shadow-sm ring-1 ring-gray-200" draggable={false} />
            ) : (
              <span
                className="flex w-full items-center justify-center rounded-sm bg-white px-1 text-center text-[10px] leading-tight text-gray-400 shadow-sm ring-1 ring-gray-200"
                style={{ aspectRatio: progress ? `${progress.width} / ${progress.height}` : "16 / 9" }}
              >
                {i <= ready ? <Loader2 className="h-3 w-3 animate-spin" /> : (titles[i - 1] ?? "").slice(0, 28) || "…"}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* 大图 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={boxRef} className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-gray-200/60 p-6">
          {progress && urls[index] && fit > 0 ? (
            <img
              src={urls[index]}
              alt={`第 ${index} 页`}
              className="shrink-0 bg-white shadow-lg ring-1 ring-gray-300/70"
              style={{ width: progress.width * fit, height: progress.height * fit }}
              draggable={false}
            />
          ) : (
            <div className="flex flex-col items-center text-gray-400">
              <Loader2 className="h-6 w-6 animate-spin" />
              <p className="mt-3 text-sm">{progress ? `正在生成第 ${index} 页…` : "正在启动 PowerPoint 导出幻灯片…"}</p>
              {titles[index - 1] && <p className="mt-2 max-w-sm truncate text-xs text-gray-500">{titles[index - 1]}</p>}
            </div>
          )}
        </div>
        <div className="flex h-9 shrink-0 items-center justify-center gap-3 border-t border-gray-200 bg-white text-xs text-gray-600">
          <button type="button" disabled={index <= 1} onClick={() => go(index - 1)} className="rounded p-1 hover:bg-gray-100 disabled:opacity-30">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="tabular-nums">
            {index} / {count || "—"}
          </span>
          <button type="button" disabled={index >= count} onClick={() => go(index + 1)} className="rounded p-1 hover:bg-gray-100 disabled:opacity-30">
            <ChevronRight className="h-4 w-4" />
          </button>
          {!meta && progress && (
            <span className="flex items-center gap-1.5 text-primary-600">
              <Loader2 className="h-3 w-3 animate-spin" />
              已生成 {ready} / {progress.count} 页
            </span>
          )}
          <span className="text-gray-400">← → 翻页</span>
        </div>
      </div>
    </div>
  );
}
