import { Folder } from "lucide-react";
import { formatStyle } from "../lib/format";

/** Windows 11 文本文档风格图标：白色纸页 + 蓝色文字行 + 右上折角 */
function TextFileIcon() {
  return (
    <svg viewBox="0 0 32 32" className="h-full w-full" aria-hidden="true">
      <path
        d="M7.5 3.5h12.9L26.5 9.6v18a1.9 1.9 0 0 1-1.9 1.9H7.5a1.9 1.9 0 0 1-1.9-1.9V5.4a1.9 1.9 0 0 1 1.9-1.9z"
        fill="#ffffff"
        stroke="#c8cdd5"
        strokeWidth="1.2"
      />
      <path d="M20.4 3.5v5.2a1 1 0 0 0 1 1h5.1z" fill="#d8e4f4" stroke="#c8cdd5" strokeWidth="0.8" strokeLinejoin="round" />
      <rect x="10.2" y="14.2" width="11.6" height="1.9" rx="0.95" fill="#3b82f6" />
      <rect x="10.2" y="18.4" width="11.6" height="1.9" rx="0.95" fill="#3b82f6" />
      <rect x="10.2" y="22.6" width="7.4" height="1.9" rx="0.95" fill="#3b82f6" />
    </svg>
  );
}

/** 文件类型徽标：目录显示文件夹图标，文件显示格式色块（对应概念图配色）；文本格式用 Win11 纸页图标 */
export default function FileTypeIcon({ format, size = "md" }: { format: string; size?: "sm" | "md" }) {
  const cls = size === "sm" ? "h-6 w-6 text-[9px]" : "h-8 w-8 text-[10px]";
  if (format === "directory") {
    return (
      <span className={`${cls} flex shrink-0 items-center justify-center`}>
        <Folder className="h-5 w-5 fill-amber-400 text-amber-400" />
      </span>
    );
  }
  if (format === "text") {
    return (
      <span className={`${cls} flex shrink-0 items-center justify-center`} aria-hidden="true">
        <TextFileIcon />
      </span>
    );
  }
  const style = formatStyle(format);
  return (
    <span
      className={`${cls} ${style.badgeClass} flex shrink-0 items-center justify-center rounded-md font-bold text-white`}
      aria-hidden="true"
    >
      {style.badgeText}
    </span>
  );
}
