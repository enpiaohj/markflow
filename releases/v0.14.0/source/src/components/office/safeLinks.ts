import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * 文档内容里的超链接必须拦截：直接点击会让应用窗口导航到外部页面（或执行 javascript: 之类的地址）。
 * 这里只允许 http / https / mailto，且需要用户确认后才交给系统默认程序打开；其余（含页内锚点）一律忽略。
 */
export function installSafeLinks(
  container: HTMLElement,
  confirmOpen: (url: string) => Promise<boolean>,
): () => void {
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a");
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const href = a.getAttribute("href") ?? "";
    if (!/^(https?:|mailto:)/i.test(href)) return;
    void confirmOpen(href).then((ok) => {
      if (ok) void openUrl(href).catch(() => {});
    });
  };
  // 捕获阶段拦截，确保先于库自己的点击处理
  container.addEventListener("click", onClick, true);
  return () => container.removeEventListener("click", onClick, true);
}

/** 旧版二进制 Office 格式 / 加密文件在内置预览中无法解析时的友好提示 */
export function friendlyOfficeError(raw: string): string {
  if (/OOXML|zip|Zip|central directory|End of central|corrupted|not a valid|Invalid|encrypted|password/i.test(raw)) {
    return "内置预览只支持新版格式（.docx / .xlsx / .pptx）。这个文件是旧版二进制格式（.doc / .xls / .ppt）、已加密，或已损坏。可以安装 Microsoft Office / LibreOffice 后预览，或另存为新格式，也可以使用系统应用打开。";
  }
  return raw;
}
