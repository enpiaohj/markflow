import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { EDITABLE_FORMATS } from "../lib/format";
import type { FileEntry } from "../lib/types";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/** 超过这些大小不做预览：预览需要把整个文件读入内存，只为显示一张小图不值得 */
const IMAGE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
const PDF_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
/** 文本摘录最多读取的字节数与显示字符数（单行极长的压缩 JSON / 日志也只渲染开头） */
const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;
const TEXT_PREVIEW_MAX_CHARS = 2000;
/** 选择停留多久后才开始读取（快速点击 / 方向键浏览时不为每个经过的文件读盘） */
const SELECT_DEBOUNCE_MS = 180;
/** 预览区固定高度，保证面板不因预览内容抖动 */
const PREVIEW_H = "h-40";

type PdfJs = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfJs> | null = null;

/** pdf.js 按需加载（不进入首屏包）；worker 地址与 PdfViewer 一致 */
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(
    ([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    },
  );
  return pdfjsPromise;
}

function Skeleton() {
  return <div className={`${PREVIEW_H} animate-pulse rounded-lg bg-gray-100`} />;
}

function ImagePreview({ libraryId, entry }: { libraryId: string; entry: FileEntry }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    setUrl("");
    setFailed(false);
    api
      .readFileBytes(libraryId, entry.relativePath)
      .then((bytes) => {
        if (cancelled) return;
        const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: IMAGE_MIME[ext] ?? "image/png" }));
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [libraryId, entry.relativePath, entry.name]);
  if (failed) return null;
  if (!url) return <Skeleton />;
  return (
    <div className={`${PREVIEW_H} flex items-center justify-center overflow-hidden rounded-lg border border-gray-200 bg-gray-50`}>
      <img src={url} alt="" className="max-h-full max-w-full object-contain" draggable={false} onError={() => setFailed(true)} />
    </div>
  );
}

function PdfPreview({ libraryId, entry }: { libraryId: string; entry: FileEntry }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<"loading" | "done" | "failed">("loading");
  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<PdfJs["getDocument"]> | null = null;
    setState("loading");
    (async () => {
      try {
        const [pdfjs, bytes] = await Promise.all([loadPdfJs(), api.readFileBytes(libraryId, entry.relativePath)]);
        if (cancelled) return;
        task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
        const doc = await task.promise;
        const pg = await doc.getPage(1);
        const base = pg.getViewport({ scale: 1 });
        const targetW = 288; // 详情面板内容宽度
        const vp = pg.getViewport({ scale: (targetW / base.width) * (window.devicePixelRatio || 1) });
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx || cancelled) return;
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.width = `${targetW}px`;
        canvas.style.height = `${Math.round((base.height * targetW) / base.width)}px`;
        await pg.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
        if (!cancelled) setState("done");
      } catch {
        if (!cancelled) setState("failed");
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [libraryId, entry.relativePath]);
  if (state === "failed") return null;
  return (
    <div className={`${PREVIEW_H} relative flex items-start justify-center overflow-hidden rounded-lg border border-gray-200 bg-white`}>
      {state === "loading" && <div className="absolute inset-0 animate-pulse bg-gray-100" />}
      <canvas ref={canvasRef} />
    </div>
  );
}

function TextPreview({ libraryId, entry }: { libraryId: string; entry: FileEntry }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setText(null);
    api
      .readTextFile(libraryId, entry.relativePath, TEXT_PREVIEW_MAX_BYTES)
      .then((c) => {
        if (!cancelled) setText(c.content.slice(0, TEXT_PREVIEW_MAX_CHARS).split(/\r?\n/).slice(0, 12).join("\n"));
      })
      .catch(() => {
        if (!cancelled) setText(""); // 读取失败（如编码不受支持）就不显示预览
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, entry.relativePath]);
  if (text === null) return <Skeleton />;
  if (!text.trim()) return null;
  return (
    <pre
      className={`${PREVIEW_H} overflow-hidden whitespace-pre-wrap break-all rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-gray-600`}
    >
      {text}
    </pre>
  );
}

/** 该文件是否有预览（决定是否显示「预览」小节） */
export function hasDetailsPreview(entry: FileEntry): boolean {
  if (entry.isDir) return false;
  if (entry.format === "image") return entry.size <= IMAGE_PREVIEW_MAX_BYTES;
  if (entry.format === "pdf") return entry.size <= PDF_PREVIEW_MAX_BYTES;
  if (EDITABLE_FORMATS.has(entry.format)) return entry.size > 0 && entry.size <= TEXT_PREVIEW_MAX_BYTES;
  return false;
}

/**
 * 右侧详情面板的文件预览：图片显示图片本体、PDF 渲染首页、文本类显示前 12 行摘录；
 * 其余格式、空文件与超大文件不预览（见 hasDetailsPreview）。选择停留片刻后才读取，读取失败静默不显示。
 * 开关见「设置 → 外观 → 详情面板预览」（prefs: mf-pref-details-preview，默认开启）。
 */
export default function DetailsPreview({ libraryId, entry }: { libraryId: string; entry: FileEntry }) {
  const [settled, setSettled] = useState<FileEntry | null>(null);
  useEffect(() => {
    setSettled(null);
    const t = window.setTimeout(() => setSettled(entry), SELECT_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [entry]);

  if (!hasDetailsPreview(entry)) return null;
  if (!settled || settled.relativePath !== entry.relativePath) return <Skeleton />;
  if (entry.format === "image") return <ImagePreview key={settled.relativePath} libraryId={libraryId} entry={settled} />;
  if (entry.format === "pdf") return <PdfPreview key={settled.relativePath} libraryId={libraryId} entry={settled} />;
  return <TextPreview key={settled.relativePath} libraryId={libraryId} entry={settled} />;
}
