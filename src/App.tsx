import { useEffect, useState } from "react";
import { FolderOpen, ListTodo, Search, Share2 } from "lucide-react";
import TitleBar from "./components/TitleBar";
import ActivityBar from "./components/ActivityBar";
import StatusBar from "./components/StatusBar";
import CreateLibraryWizard from "./components/CreateLibraryWizard";
import { LibraryProvider, useLibrary } from "./components/LibraryContext";
import HomeView from "./views/HomeView";
import LibraryView from "./views/LibraryView";
import PlaceholderView from "./views/PlaceholderView";
import SettingsView from "./views/SettingsView";
import type { ViewId } from "./navigation";

const placeholderViews: Record<
  string,
  { icon: typeof Search; title: string; description: string }
> = {
  search: {
    icon: Search,
    title: "统一搜索",
    description:
      "文件名、正文、PDF 文本层、Office 文本、OCR 与转写的本地统一检索：组合语法筛选、命中片段高亮、定位到页 / 工作表 / 行。",
  },
  graph: {
    icon: Share2,
    title: "关系图",
    description:
      "跨文档关联：Markdown 链接、手动关联与自动建议形成知识网络，支持图谱与列表视图，文件移动后按稳定 ID 恢复关系。",
  },
  tasks: {
    icon: ListTodo,
    title: "后台任务中心",
    description:
      "统一管理索引、OCR、转写、AI、转换与导出任务：排队、运行、暂停、取消、失败原因与重试入口。",
  },
  history: {
    icon: FolderOpen,
    title: "历史与恢复",
    description:
      "保存前、AI 应用前、批量操作前自动快照；内容寻址存储去重；崩溃后提供恢复中心与数据库备份恢复。",
  },
};

/** 应用外壳：标题栏 + 活动栏 + 主视图 + 状态栏 + 建库向导 */
function Shell() {
  const [activeView, setActiveView] = useState<ViewId>("home");
  const { viewRequest } = useLibrary();

  // 切换/创建文档库后自动跳到「文档库」视图
  useEffect(() => {
    if (viewRequest > 0) setActiveView("library");
  }, [viewRequest]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-gray-50 text-gray-900">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <ActivityBar activeView={activeView} onSelect={setActiveView} />
        <main className="min-w-0 flex-1 overflow-hidden">
          {activeView === "home" && <HomeView />}
          {activeView === "library" && <LibraryView />}
          {activeView === "settings" && <SettingsView />}
          {placeholderViews[activeView] && (
            <PlaceholderView {...placeholderViews[activeView]} />
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
    <LibraryProvider>
      <Shell />
    </LibraryProvider>
  );
}
