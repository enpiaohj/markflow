import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  FileEdit,
  FileSpreadsheet,
  Loader2,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import type { ConversionPrecheck } from "../lib/types";
import { useDialog } from "./DialogContext";
import { useLibrary } from "./LibraryContext";
import { useZoom } from "./ZoomContext";
import * as api from "../lib/api";
import { officeKind } from "../lib/format";
import { useExternalChange } from "../lib/useExternalChange";
import PptxViewer from "./office/PptxViewer";
import XlsxGrid from "./office/XlsxGrid";
import type { OfficePreview } from "../lib/types";

/**
 * Office 快速预览（设计文档 §5.2 L4，OOXML 安全解析）：
 * DOCX 段落流 / XLSX 工作表网格 / PPTX 幻灯片大纲；
 * 深度编辑走「系统打开」，高保真版式预览按可选组件路线交付。
 */
export default function OfficePreviewPane() {
  const { current, viewerFile, closeViewer, openInViewer, openInEditor } = useLibrary();
  const dialog = useDialog();
  const { config: zoomConfig, configure: configureZoom } = useZoom();
  const [preview, setPreview] = useState<OfficePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeSheet, setActiveSheet] = useState(0);
  const [engine, setEngine] = useState<"office" | "libreoffice" | "" | null>(null);
  const [hifiError, setHifiError] = useState("");
  const [pptxText, setPptxText] = useState(false);
  const autoTriedRef = useRef(0);
  const hifiTicketRef = useRef(0);
  const aliveRef = useRef(true);
  const [reloadNonce, setReloadNonce] = useState(0);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const [precheck, setPrecheck] = useState<ConversionPrecheck | null>(null);
  const [converting, setConverting] = useState(false);
  const [hifiLoading, setHifiLoading] = useState(false);

  const rel = viewerFile?.relativePath ?? "";

  useEffect(() => {
    if (!viewerFile) return;
    setEngine(null);
    void api
      .officeHifiEngine(viewerFile.relativePath)
      .then(setEngine)
      .catch(() => setEngine(""));
    configureZoom({ visible: true, min: 0.5, max: 2.5, step: 0.1, value: 1 });
    return () => configureZoom({ visible: false });
  }, [configureZoom, viewerFile?.relativePath]);

  useEffect(() => {
    if (!current || !viewerFile || viewerFile.kind !== "office") return;
    // Excel 使用原生表格视图（自带解析），不需要文本预览数据
    if (officeKind(viewerFile.relativePath) === "excel") {
      setPreview(null);
      setError("");
      setLoading(false);
      return;
    }
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
  }, [current, viewerFile, reloadNonce]);

  // 有可用引擎时默认直接显示版式预览（与 Word / Excel / PowerPoint 中一致）；
  // 用户主动选择「文本预览」后不再自动切换。注意：必须在下面的提前 return 之前调用 Hook。
  useEffect(() => {
    if (!viewerFile || viewerFile.kind !== "office" || viewerFile.preferText || !engine) return;
    // Excel 默认使用原生表格网格（不转 PDF）；有 Office 的 PowerPoint 使用逐页图片查看器；
    // 这里对 Word 自动生成版式预览，只有 LibreOffice 时对 PowerPoint 也走 PDF
    const kind = officeKind(viewerFile.relativePath);
    if (kind !== "word" && !(kind === "powerpoint" && engine === "libreoffice")) return;
    const stamp = viewerFile.nonce * 1000 + reloadNonce;
    if (autoTriedRef.current === stamp) return;
    autoTriedRef.current = stamp;
    void openHifi(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, viewerFile, reloadNonce]);

  // Word / Excel 等外部程序保存后回到 MarkFlow：重新解析并重新生成版式预览
  useExternalChange(current?.id, rel, () => setReloadNonce((n) => n + 1), !!viewerFile);

  if (!current || !viewerFile) return null;

  const openInSystem = () => void api.openPathInSystem(current.id, rel);

  async function startConvert() {
    if (!current) return;
    setConverting(true);
    try {
      const check = await api.docxPrecheck(current.id, rel);
      setPrecheck(check);
    } catch (err) {
      await dialog.alert(`预检失败：${err}`, "预检失败");
    } finally {
      setConverting(false);
    }
  }

  async function confirmConvert() {
    if (!current) return;
    setConverting(true);
    try {
      const result = await api.convertDocxToMarkdown(current.id, rel);
      const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const mdPath = parent ? `${parent}/${result.mdRelativePath}` : result.mdRelativePath;
      setPrecheck(null);
      closeViewer();
      // 打开转换出的可编辑副本（重扫完成后即纳入索引与搜索）
      openInEditor(mdPath);
    } catch (err) {
      await dialog.alert(`转换失败：${err}`, "转换失败");
    } finally {
      setConverting(false);
    }
  }

  async function openHifi(auto = false) {
    if (!current) return;
    const ticket = ++hifiTicketRef.current;
    setHifiLoading(true);
    setHifiError("");
    try {
      const bytes = await api.convertOfficeToPdf(current.id, rel);
      // 用户已离开 / 取消 / 又发起了新的请求：丢弃结果，绝不在用户已关闭后再弹出查看器
      if (!aliveRef.current || ticket !== hifiTicketRef.current) return;
      openInViewer(rel, "hifi", bytes);
    } catch (err) {
      if (!aliveRef.current || ticket !== hifiTicketRef.current) return;
      // 自动模式失败时静默回退到文本快速预览，并在顶部说明原因；手动点击则弹窗
      if (auto) setHifiError(String(err));
      else await dialog.alert(String(err), "版式预览失败");
    } finally {
      if (aliveRef.current && ticket === hifiTicketRef.current) setHifiLoading(false);
    }
  }

  function cancelHifi() {
    hifiTicketRef.current++;
    setHifiLoading(false);
  }

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
        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500">
          {officeKind(rel) === "excel" ? "原生表格" : "文本快速预览"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {preview?.kind === "docx" && (
            <button
              type="button"
              onClick={() => void startConvert()}
              disabled={converting}
              title="转换为 Markdown 可编辑副本（Pandoc），原文件保持不变"
              className="flex h-8 items-center gap-1.5 rounded-lg bg-primary-600 px-3 text-xs font-medium text-white hover:bg-primary-700 disabled:opacity-50"
            >
              {converting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileEdit className="h-3.5 w-3.5" />}
              转换为可编辑文档
            </button>
          )}
          {officeKind(rel) === "powerpoint" && engine === "office" && (
            <button
              type="button"
              onClick={() => setPptxText((v) => !v)}
              title="在幻灯片图片与文本大纲之间切换"
              className="flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs text-gray-600 hover:bg-gray-50"
            >
              {pptxText ? "幻灯片" : "文本大纲"}
            </button>
          )}
          {engine && !(officeKind(rel) === "powerpoint" && engine === "office") && (
            <button
              type="button"
              onClick={() => void openHifi()}
              disabled={hifiLoading}
              title={`使用${engine === "office" ? " Microsoft Office" : " LibreOffice"} 渲染为 PDF 查看原始版式（只读，不修改源文件）`}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              {hifiLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {officeKind(rel) === "excel" ? "打印版式预览" : "版式预览"}
            </button>
          )}
          <button
            type="button"
            onClick={openInSystem}
            title="使用系统默认应用打开（Word / Excel / WPS / PowerPoint）"
            className="flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs text-gray-600 hover:bg-gray-50"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            系统打开
          </button>
        </div>
      </div>

      {hifiLoading && (
        <div className="flex items-center gap-2.5 border-b border-primary-100 bg-primary-50/70 px-4 py-2 text-xs text-primary-700">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          <span className="flex-1">
            正在用{engine === "libreoffice" ? " LibreOffice" : " Microsoft Office"}
            生成精确版式（后台只读打开并导出，不会修改原文件；首次需要几秒，之后使用缓存）。生成完成后自动切换，下方先显示目录与文字内容。
          </span>
          <button type="button" onClick={cancelHifi} className="rounded border border-primary-200 bg-white px-2 py-0.5 text-primary-700 hover:bg-primary-50">
            取消
          </button>
        </div>
      )}

      {hifiError && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-700">
          <span className="font-medium">版式预览失败，已回退到文本快速预览：</span>
          <span className="break-all">{hifiError}</span>
        </div>
      )}

      {/* 转换预检对话框（设计文档 §5.3：预检 → 知情确认 → 副本） */}
      {precheck && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-[480px] rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-[15px] font-semibold text-gray-900">转换为可编辑文档</h3>
            {!precheck.ok ? (
              <>
                <p className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-[13px] text-red-600">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  {precheck.blocked}
                </p>
                <div className="mt-5 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setPrecheck(null)}
                    className="h-8 rounded-lg border border-gray-200 px-3 text-[13px] text-gray-600 hover:bg-gray-50"
                  >
                    知道了
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="mt-2 flex items-center gap-1.5 text-[13px] text-emerald-600">
                  <CheckCircle2 className="h-4 w-4" />
                  预检通过，可以转换
                </p>
                {precheck.warnings.length > 0 && (
                  <ul className="mt-3 space-y-1.5">
                    {precheck.warnings.map((w, i) => (
                      <li key={i} className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
                        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {w}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-500">
                  将在源文件同目录生成「同名 .md」可编辑副本（附件存入同名 .media 目录）。
                  <span className="font-medium text-gray-700">原文件不会被修改。</span>
                </p>
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setPrecheck(null)}
                    className="h-8 rounded-lg border border-gray-200 px-3 text-[13px] text-gray-600 hover:bg-gray-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={converting}
                    onClick={() => void confirmConvert()}
                    className="flex h-8 items-center gap-1.5 rounded-lg bg-primary-600 px-3 text-[13px] font-medium text-white hover:bg-primary-700 disabled:opacity-50"
                  >
                    {converting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    创建副本并打开
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 内容 */}
      <div
        className="min-h-0 flex-1 overflow-auto"
        style={officeKind(rel) === "powerpoint" && engine === "office" && !pptxText ? undefined : { zoom: zoomConfig.value }}
      >
        {officeKind(rel) === "excel" ? (
          <XlsxGrid libraryId={current.id} relativePath={rel} reloadKey={reloadNonce} />
        ) : officeKind(rel) === "powerpoint" && engine === "office" && !viewerFile.preferText && !pptxText ? (
          <PptxViewer
            libraryId={current.id}
            relativePath={rel}
            reloadKey={reloadNonce}
            titles={preview?.kind === "pptx" ? preview.slides.map((s) => s.title) : []}
            zoom={zoomConfig.value}
            onFail={(msg) => {
              setHifiError(msg);
              setPptxText(true);
            }}
          />
        ) : loading ? (
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
          <DocxQuickView paragraphs={preview.paragraphs} headings={preview.headings} />
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

/** Word 文本快速预览：左侧目录（标题样式提取）+ 正文提取文字，标题按级别加粗放大。 */
function DocxQuickView({ paragraphs, headings }: { paragraphs: string[]; headings: { level: number; text: string }[] }) {
  // 段落与标题按顺序对齐：文本相同的按出现顺序一一对应
  const items = useMemo(() => {
    let h = 0;
    return paragraphs.map((text) => {
      const trimmed = text.trim().slice(0, 120);
      if (h < headings.length && headings[h].text === trimmed) {
        return { text, level: headings[h++].level, anchor: h - 1 };
      }
      return { text, level: 0, anchor: -1 };
    });
  }, [paragraphs, headings]);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const sizeClass = (level: number) =>
    level === 1 ? "mt-5 text-2xl font-bold" : level === 2 ? "mt-4 text-xl font-bold" : level === 3 ? "mt-3 text-lg font-semibold" : "mt-2 text-base font-semibold";

  return (
    <div className="flex h-full min-h-0">
      {headings.length > 0 && (
        <nav className="hidden w-60 shrink-0 overflow-y-auto border-r border-gray-200 bg-white px-3 py-4 md:block">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">目录</p>
          {headings.map((h, i) => (
            <button
              key={i}
              type="button"
              onClick={() => bodyRef.current?.querySelector(`[data-anchor="${i}"]`)?.scrollIntoView({ block: "start" })}
              title={h.text}
              className="block w-full truncate rounded px-2 py-1 text-left text-[12px] text-gray-600 hover:bg-gray-100 hover:text-primary-700"
              style={{ paddingLeft: 8 + (Math.min(h.level, 5) - 1) * 12 }}
            >
              {h.text}
            </button>
          ))}
        </nav>
      )}
      <div ref={bodyRef} className="min-w-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-[820px] rounded-lg bg-white px-14 py-12 shadow-sm ring-1 ring-gray-200/60">
          {items.map((it, i) =>
            it.level > 0 ? (
              <p key={i} data-anchor={it.anchor} className={`${sizeClass(it.level)} text-gray-900`}>
                {it.text}
              </p>
            ) : (
              <p key={i} className="whitespace-pre-wrap text-[15px] leading-[1.9] text-gray-800">
                {it.text}
              </p>
            ),
          )}
        </div>
        <p className="mt-4 text-center text-[11px] text-gray-400">
          文本快速预览仅呈现提取文字与目录；精确版式会在后台生成完成后自动显示，也可点右上「版式预览」。
        </p>
      </div>
    </div>
  );
}
