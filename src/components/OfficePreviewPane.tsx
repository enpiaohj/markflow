import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ExternalLink,
  FileSpreadsheet,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { useLibrary } from "./LibraryContext";
import * as api from "../lib/api";
import type { OfficePreview } from "../lib/types";

/**
 * Office 快速预览（设计文档 §5.2 L4，OOXML 安全解析）：
 * DOCX 段落流 / XLSX 工作表网格 / PPTX 幻灯片大纲；
 * 深度编辑走「系统打开」，高保真版式预览按可选组件路线交付。
 */
export default function OfficePreviewPane() {
  const { current, viewerFile, closeViewer } = useLibrary();
  const [preview, setPreview] = useState<OfficePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeSheet, setActiveSheet] = useState(0);

  const rel = viewerFile?.relativePath ?? "";

  useEffect(() => {
    if (!current || !viewerFile || viewerFile.kind !== "office") return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setPreview(null);
    setActiveSheet(0);
    api
      .getOfficePreview(current.id, viewerFile.relativePath)
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [current, viewerFile]);

  if (!current || !viewerFile) return null;

  const openInSystem = () => void api.openPathInSystem(current.id, rel);

  return (
    <div className="flex h-full min-h-0 flex-col bg-gray-50">
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
        <FileSpreadsheet className="h-4 w-4 shrink-0 text-gray-400" />
        <span className="min-w-0 truncate text-[13px] font-medium text-gray-800">{rel}</span>
        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500">快速预览 · 提取文本</span>
        <div className="ml-auto">
          <button
            type="button"
            onClick={openInSystem}
            title="使用系统默认应用打开（Word / Excel / WPS / PowerPoint）"
            className="flex h-8 items-center gap-1.5 rounded-lg bg-primary-600 px-3 text-xs font-medium text-white hover:bg-primary-700"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            使用系统应用打开
          </button>
        </div>
      </div>

      {/* 内容 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-full flex-col items-center justify-center text-gray-400">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="mt-3 text-sm">正在解析 Office 文档…</p>
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center px-6">
            <TriangleAlert className="h-7 w-7 text-amber-400" />
            <p className="mt-3 max-w-md break-all text-center text-sm text-gray-500">{error}</p>
            <button
              type="button"
              onClick={openInSystem}
              className="mt-4 flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              使用系统应用打开
            </button>
          </div>
        ) : preview?.kind === "docx" ? (
          <div className="px-6 py-6">
            <div className="mx-auto min-h-[60%] w-full max-w-[820px] rounded-lg bg-white px-14 py-12 shadow-sm ring-1 ring-gray-200/60">
              {preview.paragraphs.map((p, i) => (
                <p key={i} className="text-[15px] leading-[1.9] text-gray-800">
                  {i === 0 ? <span className="block pb-2 text-2xl font-bold">{p}</span> : p}
                </p>
              ))}
            </div>
            <p className="mt-4 text-center text-[11px] text-gray-400">
              快速预览仅呈现提取文本；版式与图片请使用系统应用打开。
            </p>
          </div>
        ) : preview?.kind === "xlsx" ? (
          <div className="flex h-full min-h-0 flex-col px-6 py-5">
            {/* 工作表标签 */}
            <div className="flex shrink-0 gap-1 border-b border-gray-200">
              {preview.sheets.map((sheet, i) => (
                <button
                  key={sheet.name}
                  type="button"
                  onClick={() => setActiveSheet(i)}
                  className={`rounded-t-lg px-3.5 py-1.5 text-[13px] transition-colors ${
                    i === activeSheet
                      ? "border border-b-0 border-gray-200 bg-white font-medium text-primary-700"
                      : "text-gray-500 hover:bg-gray-100"
                  }`}
                >
                  {sheet.name}
                  {sheet.totalRows > sheet.rows.length && (
                    <span className="ml-1 text-[10px] text-gray-400">（前 {sheet.rows.length} 行）</span>
                  )}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-auto rounded-b-lg rounded-tr-lg border border-t-0 border-gray-200 bg-white">
              {preview.sheets[activeSheet] && (
                <table className="w-full border-collapse text-left text-[13px]">
                  <tbody>
                    {preview.sheets[activeSheet].rows.map((row, ri) => (
                      <tr key={ri} className={ri === 0 ? "bg-gray-50 font-medium" : "hover:bg-gray-50/60"}>
                        <td className="w-10 border-b border-r border-gray-100 px-2 py-1.5 text-center text-[11px] text-gray-400">
                          {ri + 1}
                        </td>
                        {row.map((cell, ci) => (
                          <td key={ci} className="max-w-56 truncate border-b border-gray-100 px-3 py-1.5 text-gray-700">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        ) : preview?.kind === "pptx" ? (
          <div className="mx-auto max-w-3xl space-y-4 px-6 py-6">
            {preview.slides.map((slide) => (
              <div key={slide.number} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                <p className="flex items-baseline gap-2.5">
                  <span className="rounded bg-primary-50 px-2 py-0.5 text-[11px] font-medium text-primary-700">
                    第 {slide.number} 页
                  </span>
                  <span className="text-[15px] font-semibold text-gray-900">{slide.title}</span>
                </p>
                <ul className="mt-3 space-y-1.5">
                  {slide.texts.slice(1).map((t, i) => (
                    <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-gray-600">
                      <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-gray-300" />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="pb-4 text-center text-[11px] text-gray-400">
              幻灯片大纲视图；完整版式请使用系统应用打开。
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
