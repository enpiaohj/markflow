import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ShieldCheck, X } from "lucide-react";
import FileTypeIcon from "./FileTypeIcon";
import { useLibrary, type DocTab } from "./LibraryContext";

/** 标签图标：文档用与文件列表一致的系统文件图标，交付中心用盾牌 */
function tabIcon(tab: DocTab) {
  if (tab.kind === "delivery") return <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-primary-600" />;
  return <FileTypeIcon format="other" name={tab.relativePath.split("/").pop() ?? tab.relativePath} size="xs" />;
}

/** 标签栏两端的滚动箭头：只在标签超出可见宽度时出现，滚到头时置灰 */
function ScrollArrow({ dir, disabled, onClick }: { dir: "left" | "right"; disabled: boolean; onClick: () => void }) {
  const Icon = dir === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={dir === "left" ? "向左滚动标签" : "向右滚动标签"}
      title={dir === "left" ? "向左滚动标签" : "向右滚动标签"}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:cursor-default disabled:text-gray-300 disabled:hover:bg-transparent"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

/**
 * 已打开文档的标签页（位于标题栏）：文档一直保留，直到点 × 关闭（有未保存修改会先确认）。
 * 标签超出可见宽度时两端出现左右箭头；鼠标滚轮在标签栏上横向滚动；激活的标签自动滚入可见区域。
 */
export default function TabStrip() {
  const { tabs, activeTabId, activateTab, closeTab, dirtyTabs } = useLibrary();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ overflow: false, atStart: true, atEnd: true });

  /** 根据滚动位置与内容宽度更新箭头状态 */
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 容差：标签栏两端有内边距，滚到头时仍会差几个像素
    const EDGE = 8;
    const next = {
      overflow: el.scrollWidth > el.clientWidth + 1,
      atStart: el.scrollLeft <= EDGE,
      atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - EDGE,
    };
    setEdges((prev) => (prev.overflow === next.overflow && prev.atStart === next.atStart && prev.atEnd === next.atEnd ? prev : next));
  }, []);

  // 标签增减、窗口 / 标题栏宽度变化时重新计算
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, tabs.length]);

  // 激活的标签（含新打开的文档）自动滚入可见区域
  useEffect(() => {
    if (!activeTabId) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTabId)}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [activeTabId, tabs.length]);

  if (tabs.length === 0) return null;
  const nameOf = (t: DocTab) => (t.kind === "delivery" ? "正式交付" : (t.relativePath.split("/").pop() ?? t.relativePath));
  // 库名默认隐藏（悬停标签的提示里有）；只有不同库里出现同名文件时才在标签内显示，避免分不清
  const names = tabs.map(nameOf);
  const dupName = (t: DocTab) => names.filter((n) => n === nameOf(t)).length > 1;

  const scrollByPage = (sign: 1 | -1) => {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: sign * Math.max(160, el.clientWidth * 0.7), behavior: "smooth" });
  };

  return (
    <div className="flex h-full min-w-0 flex-1 items-center">
      {edges.overflow && <ScrollArrow dir="left" disabled={edges.atStart} onClick={() => scrollByPage(-1)} />}
      <div
        ref={scrollRef}
        role="tablist"
        data-tauri-drag-region
        onScroll={measure}
        onWheel={(e) => {
          // 普通鼠标只有纵向滚轮：在标签栏上滚动时改为横向滚动标签
          const el = scrollRef.current;
          if (el && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
        }}
        className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none]"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const name = nameOf(tab);
          const dirty = dirtyTabs.has(tab.id);
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              role="tab"
              aria-selected={active}
              title={`${tab.lib.name} / ${tab.kind === "delivery" ? "正式交付" : tab.relativePath}`}
              onClick={() => activateTab(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) void closeTab(tab.id);
              }}
              className={`group flex h-8 max-w-[200px] shrink-0 cursor-default items-center gap-1.5 rounded-md px-2.5 text-[12.5px] ${
                active ? "bg-gray-100 font-medium text-gray-900" : "text-gray-500 hover:bg-gray-100"
              }`}
            >
              {tabIcon(tab)}
              <span className="truncate">{name}</span>
              {dupName(tab) && <span className="max-w-[70px] shrink-0 truncate text-[11px] text-gray-400">· {tab.lib.name}</span>}
              {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" title="有未保存的修改" />}
              <button
                type="button"
                aria-label="关闭"
                title="关闭（Ctrl+W）"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTab(tab.id);
                }}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-700"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
      {edges.overflow && <ScrollArrow dir="right" disabled={edges.atEnd} onClick={() => scrollByPage(1)} />}
    </div>
  );
}
