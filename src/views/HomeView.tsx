import { FolderOpen, FolderPlus } from "lucide-react";

function ActionCard({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof FolderPlus;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      title="建库向导将在 v0.1 后续迭代实现"
      className="group w-56 rounded-xl border border-gray-200 bg-white p-5 text-left shadow-sm transition-colors hover:border-primary-200 disabled:cursor-default"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
        <Icon className="h-5 w-5" />
      </span>
      <span className="mt-3 block text-[15px] font-semibold text-gray-900">{title}</span>
      <span className="mt-1 block text-[13px] leading-relaxed text-gray-500">{description}</span>
      <span className="mt-3 inline-block rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500">
        v0.1 迭代中
      </span>
    </button>
  );
}

/** 「开始」页：最近文档库与快速动作（当前为骨架占位） */
export default function HomeView() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <img src="/markflow.svg" alt="" className="h-14 w-14" draggable={false} />
      <h1 className="mt-4 text-2xl font-bold text-gray-900">MarkFlow</h1>
      <p className="mt-2 text-sm text-gray-500">
        多格式本地文档库 · 专业写作 · AI 协作 · 正式交付
      </p>

      <div className="mt-8 flex gap-4">
        <ActionCard
          icon={FolderPlus}
          title="创建文档库"
          description="选择本地文件夹，配置索引与 OCR 策略，文件保持原位置。"
        />
        <ActionCard
          icon={FolderOpen}
          title="打开文档库"
          description="打开已有的 MarkFlow 文档库或 Obsidian Vault。"
        />
      </div>

      <p className="mt-10 max-w-md text-center text-xs leading-relaxed text-gray-400">
        当前为 v0.1 工程骨架。功能将按《产品设计与技术实施方案》沿
        文档库 → 编辑 → 搜索 → AI → 交付 的主线逐步交付。
      </p>
    </div>
  );
}
