import { FileText, FileImage, FileSpreadsheet, Presentation, ShieldCheck, X } from "lucide-react";
import { useLibrary, type DocTab } from "./LibraryContext";

function tabIcon(tab: DocTab) {
  const cls = "h-3.5 w-3.5 shrink-0";
  if (tab.kind === "delivery") return <ShieldCheck className={cls} />;
  if (tab.kind === "image") return <FileImage className={cls} />;
  const ext = tab.relativePath.split(".").pop()?.toLowerCase();
  if (ext === "xlsx" || ext === "xls" || ext === "csv") return <FileSpreadsheet className={cls} />;
  if (ext === "pptx" || ext === "ppt") return <Presentation className={cls} />;
  return <FileText className={cls} />;
}

/** 已打开文档的标签页（位于标题栏）：文档一直保留，直到点 × 关闭（有未保存修改会先确认） */
export default function TabStrip() {
  const { tabs, activeTabId, activateTab, closeTab, dirtyTabs } = useLibrary();
  if (tabs.length === 0) return null;
  const nameOf = (t: DocTab) => (t.kind === "delivery" ? "正式交付" : (t.relativePath.split("/").pop() ?? t.relativePath));
  // 库名默认隐藏（悬停标签的提示里有）；只有不同库里出现同名文件时才在标签内显示，避免分不清
  const names = tabs.map(nameOf);
  const dupName = (t: DocTab) => names.filter((n) => n === nameOf(t)).length > 1;

  return (
    <div role="tablist" data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none]">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const name = nameOf(tab);
        const dirty = dirtyTabs.has(tab.id);
        return (
          <div
            key={tab.id}
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
  );
}
