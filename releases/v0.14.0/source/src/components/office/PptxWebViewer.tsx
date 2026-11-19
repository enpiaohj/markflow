import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { PptxViewer as PptxViewerType, SlideHandle } from "@aiden0z/pptx-renderer";
import * as api from "../../lib/api";
import { useDialog } from "../DialogContext";
import { friendlyOfficeError, installSafeLinks } from "./safeLinks";

const MAX_BYTES = 20 * 1024 * 1024;

/** 缩略图：进入视口时才渲染，离开后释放 */
function Thumb({ viewer, index, active, onClick, root }: { viewer: PptxViewerType; index: number; active: boolean; onClick: () => void; root: HTMLElement | null }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<SlideHandle | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(
      (entries) => {
        const on = entries.some((e) => e.isIntersecting);
        if (on && !handleRef.current) {
          try {
            handleRef.current = viewer.renderThumbnailToContainer(index, el, { width: 140 });
          } catch {
            /* 单页渲染失败不影响整体 */
          }
        } else if (!on && handleRef.current) {
          handleRef.current.dispose();
          handleRef.current = null;
          el.replaceChildren();
        }
      },
      { root, rootMargin: "300px 0px" },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, [viewer, index, root]);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-2 flex w-full gap-1.5 rounded-md p-1 text-left ${active ? "bg-primary-100 ring-1 ring-primary-300" : "hover:bg-gray-100"}`}
    >
      <span className="w-4 shrink-0 pt-0.5 text-right text-[10px] text-gray-500">{index + 1}</span>
      <div ref={boxRef} className="min-h-[60px] min-w-0 flex-1 overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-gray-200" />
    </button>
  );
}

/**
 * PowerPoint 内置渲染（@aiden0z/pptx-renderer，Apache-2.0）：不依赖 Office / LibreOffice，
 * 把 PPTX 渲染成连续滚动的幻灯片列表（窗口化挂载，大文稿也流畅）+ 缩略图导航。
 * 文字、形状、图片、表格、常见图表可用；不含动画 / 切换效果，SmartArt 与 3D 版式只是近似，缺字体用系统字体替代。
 */
export default function PptxWebViewer({
  libraryId,
  relativePath,
  reloadKey,
  zoom,
  onFail,
}: {
  libraryId: string;
  relativePath: string;
  reloadKey: number;
  zoom: number;
  onFail: (message: string) => void;
}) {
  const dialog = useDialog();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<PptxViewerType | null>(null);
  const [viewer, setViewer] = useState<PptxViewerType | null>(null);
  const [thumbRoot, setThumbRoot] = useState<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const failRef = useRef(onFail);
  failRef.current = onFail;
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    let disposed = false;
    const host = hostRef.current;
    const scroll = scrollRef.current;
    if (!host || !scroll) return;
    setLoading(true);
    setViewer(null);
    setCount(0);
    setIndex(0);
    host.replaceChildren();
    const removeLinks = installSafeLinks(host, (url) =>
      dialogRef.current.confirm({
        title: "打开外部链接",
        message: `演示文稿中的链接将用系统默认程序打开：\n${url}\n\n请只打开你信任的链接。`,
        confirmText: "打开",
      }),
    );
    (async () => {
      try {
        const bytes = await api.readFileBytes(libraryId, relativePath);
        if (disposed) return;
        if (bytes.byteLength > MAX_BYTES) throw new Error(`文件超过内置预览上限（${MAX_BYTES / 1024 / 1024} MB）`);
        const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import("@aiden0z/pptx-renderer");
        if (disposed) return;
        const v = await PptxViewer.open(bytes, host, {
          zipLimits: RECOMMENDED_ZIP_LIMITS,
          lazySlides: true,
          lazyMedia: true,
          fitMode: "contain",
          zoomPercent: Math.round(zoomRef.current * 100),
          scrollContainer: scroll,
          listOptions: { windowed: true, batchSize: 8, initialSlides: 4, overscanViewport: 1.5 },
          onSlideChange: (i) => setIndex(i),
        });
        if (disposed) {
          v.destroy();
          return;
        }
        viewerRef.current = v;
        setViewer(v);
        setCount(v.slideCount);
        setLoading(false);
      } catch (err) {
        if (!disposed) failRef.current(friendlyOfficeError(String(err instanceof Error ? err.message : err)));
      }
    })();
    return () => {
      disposed = true;
      removeLinks();
      try {
        viewerRef.current?.destroy();
      } catch {
        /* 销毁失败不影响切换 */
      }
      viewerRef.current = null;
      host.replaceChildren();
    };
  }, [libraryId, relativePath, reloadKey]);

  // 缩放
  useEffect(() => {
    if (viewer) void viewer.setZoom(Math.round(zoom * 100)).catch(() => {});
  }, [viewer, zoom]);

  function go(i: number) {
    if (!viewer) return;
    const n = Math.min(Math.max(i, 0), Math.max(count - 1, 0));
    setIndex(n);
    void viewer.goToSlide(n).catch(() => {});
  }

  return (
    <div
      className="flex h-full min-h-0 outline-none"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          go(index + 1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          go(index - 1);
        } else if (e.key === "Home") go(0);
        else if (e.key === "End") go(count - 1);
      }}
    >
      {viewer && count > 1 && (
        <div ref={setThumbRoot} className="w-[176px] shrink-0 overflow-y-auto overflow-x-hidden border-r border-gray-200 bg-white/70 p-2">
          {Array.from({ length: count }, (_, i) => (
            <Thumb key={i} viewer={viewer} index={i} active={i === index} onClick={() => go(i)} root={thumbRoot} />
          ))}
        </div>
      )}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-gray-200/60 p-4">
          {loading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-gray-100/80 text-gray-400">
              <Loader2 className="h-6 w-6 animate-spin" />
              <p className="mt-3 text-sm">正在渲染演示文稿…</p>
            </div>
          )}
          <div ref={hostRef} className="mf-pptx-host" />
        </div>
        <div className="flex h-8 shrink-0 items-center justify-center gap-3 border-t border-gray-200 bg-white text-xs text-gray-500">
          <span className="tabular-nums">{count ? `${index + 1} / ${count}` : "—"}</span>
          <span className="text-gray-400">← → 翻页 · 内置渲染（无动画）</span>
        </div>
      </div>
    </div>
  );
}
