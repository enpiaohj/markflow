import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import * as api from "./lib/api";
import { Loader2, Share2 } from "lucide-react";
import TitleBar from "./components/TitleBar";
import ActivityBar from "./components/ActivityBar";
import StatusBar from "./components/StatusBar";
import CreateLibraryWizard from "./components/CreateLibraryWizard";
import ErrorBoundary from "./components/ErrorBoundary";
import { DialogProvider, useDialog } from "./components/DialogContext";
import { LibraryProvider, TabScope, useLibrary } from "./components/LibraryContext";
import { EditorStatusProvider } from "./components/EditorStatusContext";
import { ZoomProvider, ZoomScope } from "./components/ZoomContext";
import { TasksProvider } from "./components/TasksContext";
import HomeView from "./views/HomeView";
import LibraryView from "./views/LibraryView";
import PlaceholderView from "./views/PlaceholderView";
import type { ViewId } from "./navigation";

// 首屏只加载外壳、开始页与文档库；编辑器（Tiptap / CodeMirror）、PDF.js、Office 查看器、交付与设置等
// 较重的模块按需加载，缩短启动时间（首次打开对应视图时加载一次，之后命中缓存）
const EditorPane = lazy(() => import("./components/EditorPane"));
const ImagePreviewPane = lazy(() => import("./components/ImagePreviewPane"));
const PdfViewer = lazy(() => import("./components/PdfViewer"));
const OfficePreviewPane = lazy(() => import("./components/OfficePreviewPane"));
const DeliveryView = lazy(() => import("./views/DeliveryView"));
const SearchView = lazy(() => import("./views/SearchView"));
const TasksView = lazy(() => import("./views/TasksView"));
const HistoryView = lazy(() => import("./views/HistoryView"));
const SettingsView = lazy(() => import("./views/SettingsView"));

/** 按需加载模块时的占位 */
function PaneLoading() {
  return (
    <div className="flex h-full items-center justify-center text-gray-400">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}

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
  const { viewRequest, requestSearchView, tabs, activeTabId, showMain, editorDirty } = useLibrary();
  const dialog = useDialog();

  /** 统一的视图切换入口：切到一级视图（文档标签保留） */
  async function selectView(id: ViewId) {
    showMain(); // 打开的文档保留为标签页，只是回到主视图
    setActiveView(id);
  }

  // 窗口关闭前：存在未保存修改时确认，避免直接丢失
  const dirtyRef = useRef(false);
  dirtyRef.current = editorDirty;
  useEffect(() => {
    const win = getCurrentWindow();
    const un = win.onCloseRequested(async (event) => {
      // 开启「关闭时最小化到通知区域」：后端只隐藏窗口，编辑内容仍在内存中，无需「放弃修改」确认
      try {
        if ((await api.getShellPrefs()).closeToTray) {
          // 必须 preventDefault：否则前端库在处理完关闭事件后会主动销毁窗口，把后端刚隐藏的窗口关掉
          event.preventDefault();
          return;
        }
      } catch {
        /* 读取失败按普通关闭处理 */
      }
      if (!dirtyRef.current) return;
      event.preventDefault();
      const ok = await dialog.confirm({
        title: "退出 MarkFlow？",
        message: "当前文档有未保存的修改，退出将丢失这些修改。\n（下次打开同一文件时可从恢复草稿找回最近的编辑内容。）",
        confirmText: "仍然退出",
        danger: true,
      });
      if (ok) {
        dirtyRef.current = false;
        await win.destroy();
      }
    });
    // 通知区域菜单「退出」：真正退出前先确认未保存修改
    const unQuit = listen("request-quit", async () => {
      if (dirtyRef.current) {
        const ok = await dialog.confirm({
          title: "退出 MarkFlow？",
          message: "当前文档有未保存的修改，退出将丢失这些修改。\n（下次打开同一文件时可从恢复草稿找回最近的编辑内容。）",
          confirmText: "仍然退出",
          danger: true,
        });
        if (!ok) return;
      }
      await api.quitApp();
    });
    return () => {
      void un.then((f) => f());
      void unQuit.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 视图切换请求：切换/添加文档库 → 文档库；标题栏搜索框 / Ctrl+K → 搜索
  useEffect(() => {
    if (viewRequest.nonce > 0) selectView(viewRequest.target);
    // 仅响应 viewRequest 变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewRequest]);

  // 全局快捷键 Ctrl+K 打开搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isK = (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "k";
      const isShiftF = (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f";
      // 可视化编辑器内 Ctrl+K 用于插入链接，不触发全局搜索；Ctrl+Shift+F 在任何位置都能搜索
      const inVisualEditor = e.target instanceof Element && !!e.target.closest(".ProseMirror");
      if ((isK && !inVisualEditor) || isShiftF) {
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
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1">
          {/* 打开的文档：全部保持挂载（显示 / 隐藏切换），保留未保存编辑与滚动位置 */}
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <div key={tab.id} className="h-full" style={{ display: active ? "block" : "none" }}>
                <TabScope tab={tab} active={active}>
                  <ZoomScope active={active}>
                    <ErrorBoundary scope="此文档">
                    <Suspense fallback={<PaneLoading />}>
                    {tab.kind === "editor" ? (
                      <EditorPane />
                    ) : tab.kind === "delivery" ? (
                      <DeliveryView />
                    ) : tab.kind === "pdf" ? (
                      <PdfViewer />
                    ) : tab.kind === "hifi" ? (
                      <PdfViewer external={{ bytes: tab.bytes ?? new ArrayBuffer(0), title: tab.relativePath }} />
                    ) : tab.kind === "image" ? (
                      <ImagePreviewPane />
                    ) : (
                      <OfficePreviewPane />
                    )}
                    </Suspense>
                    </ErrorBoundary>
                  </ZoomScope>
                </TabScope>
              </div>
            );
          })}
          <div className="h-full" style={{ display: activeTabId ? "none" : "block" }}>
            <ErrorBoundary key={activeView} scope="此视图">
            <Suspense fallback={<PaneLoading />}>
            {activeView === "home" && <HomeView />}
            {activeView === "library" && <LibraryView />}
            {activeView === "search" && <SearchView />}
            {activeView === "tasks" && <TasksView />}
            {activeView === "history" && <HistoryView />}
            {activeView === "settings" && <SettingsView />}
            {placeholderViews[activeView as "graph"] && (
              <PlaceholderView {...placeholderViews[activeView as "graph"]} />
            )}
            </Suspense>
            </ErrorBoundary>
          </div>
          </div>
        </main>
      </div>
      <StatusBar />
      <CreateLibraryWizard />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary scope="MarkFlow 界面">
      <DialogProvider>
        <ZoomProvider>
          <LibraryProvider>
            <TasksProvider>
              <EditorStatusProvider>
                <Shell />
              </EditorStatusProvider>
            </TasksProvider>
          </LibraryProvider>
        </ZoomProvider>
      </DialogProvider>
    </ErrorBoundary>
  );
}
