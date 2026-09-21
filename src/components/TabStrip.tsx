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

/** 已打开文档的标签页：文档一直保留，直到点 × 关闭（有未保存修改会先确认） */
export default function TabStrip() {
  const { tabs, activeTabId, activateTab, closeTab, dirtyTabs } = useLibrary();
  if (tabs.length === 0) return null;
  const multiLib = new Set(tabs.map((t) => t.lib.id)).size > 1;

  return (
    <div role="tablist" className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-gray-200 bg-gray-100 px-2 pt-1">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const name = tab.kind === "delivery" ? "正式交付" : (tab.relativePath.split("/").pop() ?? tab.relativePath);
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
            className={`group flex h-8 max-w-[220px] shrink-0 cursor-default items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-[12.5px] ${
              active ? "border-gray-200 bg-white text-gray-900" : "border-transparent text-gray-500 hover:bg-gray-200/70"
            }`}
          >
            {tabIcon(tab)}
            <span className="truncate">{name}</span>
            {multiLib && <span className="shrink-0 rounded bg-primary-50 px-1 text-[10px] text-primary-700">{tab.lib.name}</span>}
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
