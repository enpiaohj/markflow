import {
  Bot,
  Braces,
  Database,
  Monitor,
  Palette,
  ShieldCheck,
  Stamp,
  type LucideIcon,
} from "lucide-react";

interface SettingSection {
  name: string;
  description: string;
  icon: LucideIcon;
}

/** 设置分区对应设计文档第 15 节（骨架仅展示结构） */
const sections: SettingSection[] = [
  { name: "常规", description: "启动、最近库、语言、更新", icon: Monitor },
  { name: "外观", description: "浅色 / 深色、密度、字号、页面背景", icon: Palette },
  { name: "文档库", description: "排除规则、索引、缓存、便携元数据", icon: Database },
  { name: "编辑器", description: "自动保存、换行符、Markdown 方言、快捷键", icon: Braces },
  { name: "AI", description: "Provider、模型能力、主备策略、隐私与敏感信息", icon: Bot },
  { name: "审阅", description: "状态、检查规则、交付门禁", icon: Stamp },
  { name: "组件", description: "Pandoc、LibreOffice、OCR 引擎版本与健康状态", icon: ShieldCheck },
];

/** 「设置」页占位 */
export default function SettingsView() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h2 className="text-lg font-semibold text-gray-900">设置</h2>
      <p className="mt-1 text-[13px] text-gray-500">
        用户设置与库设置分层；库设置可进入版本控制，密钥不进入共享文件。
      </p>

      <ul className="mt-6 divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
        {sections.map(({ name, description, icon: Icon }) => (
          <li
            key={name}
            className="flex items-center gap-3 px-4 py-3.5"
            title="设置项将在后续迭代实现"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-gray-500">
              <Icon className="h-4.5 w-4.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-gray-900">{name}</span>
              <span className="block truncate text-xs text-gray-500">{description}</span>
            </span>
            <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-400">
              开发中
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
