import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import * as api from "../../lib/api";
import { useDialog } from "../DialogContext";
import { friendlyOfficeError, installSafeLinks } from "./safeLinks";

/** 内置渲染的文件大小上限（与后端 Office 解析上限一致） */
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Word 内置渲染（docx-preview，Apache-2.0）：不依赖 Office / LibreOffice，把 DOCX 渲染成带分页、
 * 样式、表格、图片、页眉页脚的页面。渲染在应用内完成，文档内容不会被执行；超链接经确认后才打开。
 * 保真度低于 Office 导出的 PDF（字体缺失时用系统字体替代、自动分页只近似），但零依赖、几乎即时。
 */
export default function DocxWebView({
  libraryId,
  relativePath,
  reloadKey,
  headings,
  zoom,
  onFail,
}: {
  libraryId: string;
  relativePath: string;
  reloadKey: number;
  headings: { level: number; text: string }[];
  zoom: number;
  onFail: (message: string) => void;
}) {
  const dialog = useDialog();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const styleRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const failRef = useRef(onFail);
  failRef.current = onFail;
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;

  useEffect(() => {
    let disposed = false;
    const host = hostRef.current;
    const styles = styleRef.current;
    if (!host || !styles) return;
    setLoading(true);
    host.replaceChildren();
    styles.replaceChildren();
    const removeLinks = installSafeLinks(host, (url) =>
      dialogRef.current.confirm({
        title: "打开外部链接",
        message: `文档中的链接将用系统默认程序打开：\n${url}\n\n请只打开你信任的链接。`,
        confirmText: "打开",
      }),
    );
    (async () => {
      try {
        const bytes = await api.readFileBytes(libraryId, relativePath);
        if (disposed) return;
        if (bytes.byteLength > MAX_BYTES) throw new Error(`文件超过内置预览上限（${MAX_BYTES / 1024 / 1024} MB）`);
        const { renderAsync } = await import("docx-preview");
        if (disposed) return;
        await renderAsync(bytes, host, styles, {
          className: "docx",
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          useBase64URL: true,
        });
        if (!disposed) setLoading(false);
      } catch (err) {
        if (!disposed) failRef.current(friendlyOfficeError(String(err instanceof Error ? err.message : err)));
      }
    })();
    return () => {
      disposed = true;
      removeLinks();
      host.replaceChildren();
      styles.replaceChildren();
    };
  }, [libraryId, relativePath, reloadKey]);

  // 目录点击：在渲染结果里按顺序找到与标题文字相同的段落并滚动到它
  function goToHeading(i: number) {
    const host = hostRef.current;
    if (!host) return;
    const target = headings[i]?.text;
    if (!target) return;
    const seen = headings.slice(0, i).filter((h) => h.text === target).length;
    const nodes = Array.from(host.querySelectorAll("p, h1, h2, h3, h4, h5, h6")).filter(
      (n) => (n.textContent ?? "").trim().slice(0, 120) === target,
    );
    nodes[seen]?.scrollIntoView({ block: "start" });
  }

  return (
    <div className="flex h-full min-h-0">
      {headings.length > 0 && (
        <nav className="hidden w-56 shrink-0 overflow-y-auto border-r border-gray-200 bg-white px-3 py-4 md:block">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">目录</p>
          {headings.map((h, i) => (
            <button
              key={i}
              type="button"
              onClick={() => goToHeading(i)}
              title={h.text}
              className="block w-full truncate rounded px-2 py-1 text-left text-[12px] text-gray-600 hover:bg-gray-100 hover:text-primary-700"
              style={{ paddingLeft: 8 + (Math.min(h.level, 5) - 1) * 12 }}
            >
              {h.text}
            </button>
          ))}
        </nav>
      )}
      <div className="relative min-w-0 flex-1 overflow-auto bg-gray-200/70">
        {loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-gray-100/80 text-gray-400">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="mt-3 text-sm">正在渲染文档…</p>
          </div>
        )}
        {/* 库默认的深灰页面背景与应用风格不符：改为透明，由外层浅灰承托 */}
        <style>{`.mf-docx-host .docx-wrapper{background:transparent!important;padding:20px 0!important}.mf-docx-host .docx-wrapper>section.docx{margin-bottom:16px!important}`}</style>
        <div ref={styleRef} />
        <div ref={hostRef} style={{ zoom }} className="mf-docx-host" />
      </div>
    </div>
  );
}
