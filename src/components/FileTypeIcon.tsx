import type { ReactNode } from "react";
import { Folder } from "lucide-react";
import { FOLDER_KEY, iconKeyForName, useSysIcon } from "../lib/sysIcons";

/**
 * 内置回退图标套图（系统图标不可用时使用）：
 * 统一「白色纸页 + 右上折角」，按格式绘制彩色内容（文字行 / 表格 / 幻灯片 / 缩略图 / 拉链等）。
 * 仅在 24 / 32px 下显示，细节保持最简。
 */

function Page({ children, fold = "#d8e4f4" }: { children?: ReactNode; fold?: string }) {
  return (
    <svg viewBox="0 0 32 32" className="h-full w-full" aria-hidden="true">
      <path
        d="M7.5 3.5h12.9L26.5 9.6v18a1.9 1.9 0 0 1-1.9 1.9H7.5a1.9 1.9 0 0 1-1.9-1.9V5.4a1.9 1.9 0 0 1 1.9-1.9z"
        fill="#ffffff"
        stroke="#c8cdd5"
        strokeWidth="1.2"
      />
      <path d="M20.4 3.5v5.2a1 1 0 0 0 1 1h5.1z" fill={fold} stroke="#c8cdd5" strokeWidth="0.8" strokeLinejoin="round" />
      {children}
    </svg>
  );
}

const line = (y: number, w: number, fill: string, x = 10.2, h = 1.9) => <rect x={x} y={y} width={w} height={h} rx={h / 2} fill={fill} />;

/** 各格式在纸页上的内容（Win11 风格：彩色文字行 / 小图形） */
const CONTENT: Record<string, ReactNode> = {
  // 纯文本：三条蓝色文字行（Windows 11 文本文档样式）
  text: (
    <>
      {line(14.2, 11.6, "#3b82f6")}
      {line(18.4, 11.6, "#3b82f6")}
      {line(22.6, 7.4, "#3b82f6")}
    </>
  ),
  // Markdown：深色标题行 + 蓝色正文行
  markdown: (
    <>
      {line(13.6, 7.2, "#334155", 10.2, 2.3)}
      {line(18.6, 11.6, "#3b82f6")}
      {line(22.6, 7.4, "#3b82f6")}
    </>
  ),
  // Word：蓝色文档行（Office 蓝）
  word: (
    <>
      {line(13.4, 11.6, "#185abd", 10.2, 2.1)}
      {line(17.9, 11.6, "#185abd")}
      {line(21.4, 11.6, "#185abd")}
      {line(24.6, 7.4, "#185abd")}
    </>
  ),
  // Excel：绿色表格（表头填充）
  excel: (
    <>
      <rect x="10.2" y="13.8" width="11.6" height="10.4" fill="#e7f4ec" stroke="#107c41" strokeWidth="1.1" />
      <rect x="10.2" y="13.8" width="11.6" height="2.8" fill="#107c41" />
      <line x1="10.2" y1="19" x2="21.8" y2="19" stroke="#107c41" strokeWidth="1" />
      <line x1="16" y1="16.6" x2="16" y2="24.2" stroke="#107c41" strokeWidth="1" />
    </>
  ),
  // PowerPoint：橙色幻灯片 + 两行正文
  powerpoint: (
    <>
      <rect x="10.2" y="13.4" width="11.6" height="7.4" rx="0.9" fill="#c43e1c" />
      <rect x="11.9" y="15.1" width="6.2" height="1.5" rx="0.75" fill="#ffffff" />
      {line(23.2, 11.6, "#c43e1c")}
    </>
  ),
  // PDF：红色文字行 + 淡红折角
  pdf: (
    <>
      {line(14.2, 11.6, "#dc2626")}
      {line(18.4, 11.6, "#dc2626")}
      {line(22.6, 7.4, "#dc2626")}
    </>
  ),
  // CSV：绿色小数据表
  csv: (
    <>
      <rect x="10.2" y="14.2" width="11.6" height="9.6" fill="#ecfdf5" stroke="#059669" strokeWidth="1.1" />
      <line x1="10.2" y1="17.6" x2="21.8" y2="17.6" stroke="#059669" strokeWidth="1" />
      <line x1="16" y1="17.6" x2="16" y2="23.8" stroke="#059669" strokeWidth="1" />
    </>
  ),
  // 代码：</>
  code: (
    <g stroke="#475569" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <polyline points="12.8,14.2 9.2,17.6 12.8,21" />
      <polyline points="19.2,14.2 22.8,17.6 19.2,21" />
      <line x1="17.8" y1="12.8" x2="14.2" y2="22.4" />
    </g>
  ),
  // JSON：琥珀色花括号
  json: (
    <g stroke="#d97706" strokeWidth="1.8" strokeLinecap="round" fill="none">
      <path d="M14.9 12.6c-1.9 0-2.3 1-2.3 2.4v1.5c0 1-.6 1.6-1.6 1.8v.6c1 .2 1.6.8 1.6 1.8v1.5c0 1.4.4 2.4 2.3 2.4" />
      <path d="M17.1 12.6c1.9 0 2.3 1 2.3 2.4v1.5c0 1 .6 1.6 1.6 1.8v.6c-1 .2-1.6.8-1.6 1.8v1.5c0 1.4-.4 2.4-2.3 2.4" />
    </g>
  ),
  // YAML：两组「键 + 值」
  yaml: (
    <>
      <rect x="10.2" y="14.6" width="3.6" height="1.9" rx="0.5" fill="#ea580c" />
      {line(15.15, 6.6, "#fdba74", 15, 1.5)}
      <rect x="10.2" y="20" width="3.6" height="1.9" rx="0.5" fill="#ea580c" />
      {line(20.55, 6.6, "#fdba74", 15, 1.5)}
    </>
  ),
  // XML：青柠色尖括号
  xml: (
    <g stroke="#65a30d" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <polyline points="13.4,13.8 9.6,17.6 13.4,21.4" />
      <polyline points="18.6,13.8 22.4,17.6 18.6,21.4" />
    </g>
  ),
  // 配置：两条滑杆（带滑块圆点）
  config: (
    <>
      <g stroke="#78716c" strokeWidth="1.6" strokeLinecap="round">
        <line x1="10.2" y1="15.8" x2="21.8" y2="15.8" />
        <line x1="10.2" y1="21.2" x2="21.8" y2="21.2" />
      </g>
      <circle cx="14" cy="15.8" r="1.9" fill="#ffffff" stroke="#78716c" strokeWidth="1.4" />
      <circle cx="19" cy="21.2" r="1.9" fill="#ffffff" stroke="#78716c" strokeWidth="1.4" />
    </>
  ),
  // 压缩包：拉链
  archive: (
    <>
      {[13.2, 16, 18.8].map((y) => (
        <rect key={y} x="14.7" y={y} width="2.6" height="1.7" rx="0.4" fill="#a16207" />
      ))}
      <path d="M14.9 21.4h2.2l-1.1 2.6z" fill="#a16207" />
    </>
  ),
  // 图片：风景缩略图（山 + 太阳）
  image: (
    <>
      <rect x="10.2" y="13.4" width="11.6" height="10" rx="1" fill="#dbeafe" stroke="#93c5fd" strokeWidth="1" />
      <circle cx="18.6" cy="16.4" r="1.6" fill="#fbbf24" />
      <path d="M10.2 23.4l3.9-5.2 2.8 3.4 1.9-2.2 3 4z" fill="#34d399" />
    </>
  ),
  // 音频：音符
  audio: (
    <>
      <path d="M15.9 12.8v7.1a2.6 2.6 0 1 1-1.4-2.3V14l5-1.3v2.6z" fill="#ec4899" />
    </>
  ),
  // 视频：播放按钮
  video: (
    <>
      <rect x="10.2" y="14" width="11.6" height="8.4" rx="1.2" fill="#fecdd3" />
      <path d="M14.4 16.1v4.2l3.9-2.1z" fill="#e11d48" />
    </>
  ),
  // 其他未知格式：灰色文字行
  other: (
    <>
      {line(14.2, 11.6, "#94a3b8")}
      {line(18.4, 11.6, "#94a3b8")}
      {line(22.6, 7.4, "#94a3b8")}
    </>
  ),
};

/**
 * 文件图标：优先用本机（资源管理器）标准图标——按**扩展名**取（传入 `name` 时），文件夹用系统文件夹图标；
 * 系统没有对应图标、提取失败或未传文件名时，回退到内置 Win11 纸页风格套图（按格式区分）。
 */
export default function FileTypeIcon({
  format,
  name,
  size = "md",
}: {
  format: string;
  /** 文件名（用于按扩展名取系统图标）；不传时只用内置图标 */
  name?: string;
  size?: "sm" | "md";
}) {
  const cls = size === "sm" ? "h-6 w-6" : "h-8 w-8";
  const isDir = format === "directory";
  const sys = useSysIcon(isDir ? FOLDER_KEY : name !== undefined ? iconKeyForName(name) : null);

  if (sys) {
    return (
      <span className={`${cls} flex shrink-0 items-center justify-center`} aria-hidden="true">
        <img src={sys} alt="" className="h-full w-full object-contain" draggable={false} />
      </span>
    );
  }
  if (isDir) {
    return (
      <span className={`${cls} flex shrink-0 items-center justify-center`} aria-hidden="true">
        <Folder className="h-5 w-5 fill-amber-400 text-amber-400" />
      </span>
    );
  }
  const content = CONTENT[format] ?? CONTENT.other;
  const fold = format === "pdf" ? "#f3d1cf" : "#d8e4f4";
  return (
    <span className={`${cls} flex shrink-0 items-center justify-center`} aria-hidden="true">
      <Page fold={fold}>{content}</Page>
    </span>
  );
}
