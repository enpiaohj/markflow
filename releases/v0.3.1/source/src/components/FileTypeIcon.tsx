import { Folder } from "lucide-react";
import { formatStyle } from "../lib/format";

/** 文件类型徽标：目录显示文件夹图标，文件显示格式色块（对应概念图配色） */
export default function FileTypeIcon({ format, size = "md" }: { format: string; size?: "sm" | "md" }) {
  const cls = size === "sm" ? "h-6 w-6 text-[9px]" : "h-8 w-8 text-[10px]";
  if (format === "directory") {
    return (
      <span className={`${cls} flex shrink-0 items-center justify-center`}>
        <Folder className="h-5 w-5 fill-amber-400 text-amber-400" />
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
