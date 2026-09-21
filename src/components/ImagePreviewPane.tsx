import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, Loader2, ScanText, TriangleAlert } from "lucide-react";
import { useLibrary } from "./LibraryContext";
import { useZoom } from "./ZoomContext";
import * as api from "../lib/api";
import { formatSize } from "../lib/format";

/** 图片查看器 + Windows OCR 文字识别（§8.10，识别文本入全文索引） */
export default function ImagePreviewPane() {
  const { current, viewerFile, closeViewer } = useLibrary();
  const { config: zoomConfig, configure: configureZoom } = useZoom();
  const [url, setUrl] = useState("");
  const [size, setSize] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [ocrError, setOcrError] = useState("");

  const rel = viewerFile?.relativePath ?? "";

  useEffect(() => {
    if (!current || !viewerFile || viewerFile.kind !== "image") return;
    let objectUrl = "";
    configureZoom({ visible: true, min: 0.25, max: 5, step: 0.25, value: 1 });
    setLoading(true);
    setError("");
    setOcrText(null);
    setOcrError("");
    api
      .readFileBytes(current.id, viewerFile.relativePath)
      .then((bytes: ArrayBuffer) => {
        objectUrl = URL.createObjectURL(new Blob([bytes]));
        setSize(bytes.byteLength);
        setUrl(objectUrl);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      configureZoom({ visible: false });
    };
  }, [current, viewerFile]);

  async function runOcr() {
    if (!current) return;
    setOcrRunning(true);
    setOcrError("");
    try {
      const result = await api.ocrFile(current.id, rel);
      setOcrText(result.text);
    } catch (err) {
      setOcrError(String(err));
    } finally {
      setOcrRunning(false);
    }
  }

  if (!current || !viewerFile) return null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-gray-100/70">
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
        <span className="min-w-0 truncate text-[13px] font-medium text-gray-800">{rel}</span>
        <span className="text-xs text-gray-400">{size > 0 && formatSize(size)}</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void runOcr()}
            disabled={ocrRunning}
            title="使用 Windows OCR 识别图片文字（结果进入全文索引，可被搜索）"
            className="flex h-8 items-center gap-1.5 rounded-lg bg-primary-600 px-3 text-xs font-medium text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {ocrRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanText className="h-3.5 w-3.5" />}
            OCR 识别
          </button>
          <button
            type="button"
            onClick={() => void api.openPathInSystem(current.id, rel)}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs text-gray-600 hover:bg-gray-50"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            系统打开
          </button>
        </div>
      </div>

      {ocrError && (
        <p className="flex items-start gap-1.5 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-700">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {ocrError}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 图片区 */}
        <div className="flex min-w-0 flex-1 items-center justify-center overflow-auto p-6">
          {loading ? (
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          ) : error ? (
            <p className="max-w-md break-all text-center text-sm text-gray-500">{error}</p>
          ) : (
            <img
              src={url}
              alt={rel}
              style={{ zoom: zoomConfig.value }}
              className="max-h-full max-w-full rounded-lg bg-white object-contain shadow-md ring-1 ring-gray-300/60"
            />
          )}
        </div>

        {/* OCR 结果侧栏 */}
        {ocrText !== null && (
          <aside className="flex w-96 shrink-0 flex-col border-l border-gray-200 bg-white">
            <p className="border-b border-gray-100 px-4 py-2.5 text-xs font-medium text-gray-600">
              OCR 识别结果（已进入全文索引，可被搜索）
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {ocrText.trim() === "" ? (
                <p className="text-xs text-gray-400">未识别到文字内容</p>
              ) : (
                <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-gray-700">{ocrText}</pre>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
