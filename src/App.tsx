import { useEffect, useState } from "react";
import { Share2 } from "lucide-react";
import TitleBar from "./components/TitleBar";
import ActivityBar from "./components/ActivityBar";
import StatusBar from "./components/StatusBar";
import CreateLibraryWizard from "./components/CreateLibraryWizard";
import EditorPane from "./components/EditorPane";
import ImagePreviewPane from "./components/ImagePreviewPane";
import PdfViewer from "./components/PdfViewer";
import OfficePreviewPane from "./components/OfficePreviewPane";
import { LibraryProvider, useLibrary } from "./components/LibraryContext";
import { ZoomProvider } from "./components/ZoomContext";
import { TasksProvider } from "./components/TasksContext";
import DeliveryView from "./views/DeliveryView";
import HomeView from "./views/HomeView";
import LibraryView from "./views/LibraryView";
import SearchView from "./views/SearchView";
import TasksView from "./views/TasksView";
import HistoryView from "./views/HistoryView";
import PlaceholderView from "./views/PlaceholderView";
import SettingsView from "./views/SettingsView";
import type { ViewId } from "./navigation";

const placeholderViews: Record<
  "graph",
  { icon: typeof Share2; title: string; description: string }
> = {
  graph: {
    icon: Share2,
    title: "关系图",
    description:
      "跨文档关联：Markdown 链接、手动关联与自动建议形成知识网络，支持图谱与列表视图，文件移动后按稳定 ID 恢复关系。",
  },
};

/** 应用外壳：标题栏 + 活动栏 + 主视图 + 状态栏 + 建库向导 */
function Shell() {
  const [activeView, setActiveView] = useState<ViewId>("home");
  const { viewRequest, requestSearchView, openFile, viewerFile, deliveryOpen, editorDirty, closeFile, closeViewer, current } = useLibrary();

  /** 统一的视图切换入口：编辑器/查看器打开时先关闭（有未保存修改则确认） */
  function selectView(id: ViewId) {
    if (openFile && editorDirty && !window.confirm("当前文档有未保存的修改，离开将丢失这些修改。\n确定继续吗？")) {
      return;
    }
    if (openFile) closeFile();
    if (viewerFile) closeViewer();
    setActiveView(id);
  }

  // 视图切换请求：切换/创建文档库 → 文档库；标题栏搜索框 / Ctrl+K → 搜索
  useEffect(() => {
    if (viewRequest.nonce > 0) selectView(viewRequest.target);
    // 仅响应 viewRequest 变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewRequest]);

  // 全局快捷键 Ctrl+K 打开搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        requestSearchView();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestSearchView]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-gray-50 text-gray-900">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <ActivityBar activeView={activeView} onSelect={selectView} />
        <main className="min-w-0 flex-1 overflow-hidden">
          {openFile && current ? (
            <EditorPane />
          ) : deliveryOpen && current ? (
            <DeliveryView />
          ) : viewerFile && current ? (
            viewerFile.kind === "pdf" ? (
              <PdfViewer />
            ) : viewerFile.kind === "hifi" ? (
              <PdfViewer external={{ bytes: viewerFile.bytes ?? new ArrayBuffer(0), title: viewerFile.relativePath }} />
            ) : viewerFile.kind === "image" ? (
              <ImagePreviewPane />
            ) : (
              <OfficePreviewPane />
            )
          ) : (
            <>
              {activeView === "home" && <HomeView />}
              {activeView === "library" && <LibraryView />}
              {activeView === "search" && <SearchView />}
              {activeView === "tasks" && <TasksView />}
              {activeView === "history" && <HistoryView />}
              {activeView === "settings" && <SettingsView />}
              {placeholderViews[activeView as "graph"] && (
                <PlaceholderView {...placeholderViews[activeView as "graph"]} />
              )}
            </>
          )}
        </main>
      </div>
      <StatusBar />
      <CreateLibraryWizard />
    </div>
  );
}

export default function App() {
  return (
    <ZoomProvider>
      <LibraryProvider>
        <TasksProvider>
          <Shell />
        </TasksProvider>
      </LibraryProvider>
    </ZoomProvider>
  );
}
