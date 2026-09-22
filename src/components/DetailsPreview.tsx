import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import * as api from "../lib/api";
import { EDITABLE_FORMATS } from "../lib/format";
import type { FileEntry } from "../lib/types";

// 与 PdfViewer 相同的 worker 配置（重复赋值为同一地址，无副作用）
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

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

/** 文本摘录最多读取的字节数（超过则不显示文本预览，避免大文件无谓读入） */
const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;
/** 预览区固定高度，保证面板不因预览内容抖动 */
const PREVIEW_H = "h-40";

function ImagePreview({ libraryId, entry }: { libraryId: string; entry: FileEntry }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
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
  if (!url) return <div className={`${PREVIEW_H} animate-pulse rounded-lg bg-gray-100`} />;
  return (
    <div className={`${PREVIEW_H} flex items-center justify-center overflow-hidden rounded-lg border border-gray-200 bg-gray-50`}>
      <img src={url} alt="" className="max-h-full max-w-full object-contain" draggable={false} />
    </div>
  );
}

function PdfPreview({ libraryId, entry }: { libraryId: string; entry: FileEntry }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    (async () => {
      try {
        const bytes = await api.readFileBytes(libraryId, entry.relativePath);
        task = pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)) });
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
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [libraryId, entry.relativePath]);
  if (failed) return null;
  return (
    <div className={`${PREVIEW_H} flex items-start justify-center overflow-hidden rounded-lg border border-gray-200 bg-white`}>
      <canvas ref={canvasRef} />
    </div>
  );
}

function TextPreview({ libraryId, entry }: { libraryId: string; entry: FileEntry }) {
  const [text, setText] = useState("");
  useEffect(() => {
    let cancelled = false;
    api
      .readTextFile(libraryId, entry.relativePath, TEXT_PREVIEW_MAX_BYTES)
      .then((c) => {
        if (!cancelled) setText(c.content.split(/\r?\n/).slice(0, 12).join("\n"));
      })
      .catch(() => {
        /* 读取失败（如编码不受支持）就不显示预览 */
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, entry.relativePath]);
  if (!text) return null;
  return (
    <pre
      className={`${PREVIEW_H} overflow-hidden whitespace-pre-wrap break-all rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-gray-600`}
    >
      {text}
    </pre>
  );
}

/**
 * 右侧详情面板的文件预览：图片显示图片本体、PDF 渲染首页、文本类显示前 12 行摘录；
 * 其余格式（Office / 目录 / 未知）不显示预览。读取失败一律静默不显示，不影响面板其余信息。
 * 开关见「设置 → 外观 → 详情面板预览」（prefs: mf-pref-details-preview，默认开启）。
 */
export default function DetailsPreview({ libraryId, entry }: { libraryId: string; entry: FileEntry }) {
  if (entry.isDir) return null;
  if (entry.format === "image") return <ImagePreview libraryId={libraryId} entry={entry} />;
  if (entry.format === "pdf") return <PdfPreview libraryId={libraryId} entry={entry} />;
  if (EDITABLE_FORMATS.has(entry.format)) return <TextPreview libraryId={libraryId} entry={entry} />;
  return null;
}
