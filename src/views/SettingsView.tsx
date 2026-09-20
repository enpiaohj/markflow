import { useEffect, useState } from "react";
import {
  Bot,
  Braces,
  CheckCircle2,
  Database,
  Download,
  Monitor,
  Palette,
  ShieldCheck,
  Stamp,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import * as api from "../lib/api";
import type { ComponentStatus } from "../lib/types";

interface SettingSection {
  name: string;
  description: string;
  icon: LucideIcon;
}

/** 设置分区对应设计文档第 15 节（组件分区为实时状态，其余骨架占位） */
const sections: SettingSection[] = [
  { name: "常规", description: "启动、最近库、语言、更新", icon: Monitor },
  { name: "外观", description: "浅色 / 深色、密度、字号、页面背景", icon: Palette },
  { name: "文档库", description: "排除规则、索引、缓存、便携元数据", icon: Database },
  { name: "编辑器", description: "自动保存、换行符、Markdown 方言、快捷键", icon: Braces },
  { name: "AI", description: "Provider、模型能力、主备策略、隐私与敏感信息", icon: Bot },
  { name: "审阅", description: "状态、检查规则、交付门禁", icon: Stamp },
];

/** 「设置」页：组件管理为实时状态，其余分区占位 */
export default function SettingsView() {
  const [components, setComponents] = useState<ComponentStatus[] | null>(null);

  useEffect(() => {
    void api.listComponents().then(setComponents).catch(() => setComponents([]));
  }, []);

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h2 className="text-lg font-semibold text-gray-900">设置</h2>
      <p className="mt-1 text-[13px] text-gray-500">
        用户设置与库设置分层；库设置可进入版本控制，密钥不进入共享文件。
      </p>

      <p className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-gray-400">
        组件（可选能力）
      </p>
      <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
        {(components ?? []).map((c) => (
          <li key={c.name} className="flex items-center gap-3 px-4 py-3.5">
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                c.found ? "bg-emerald-50 text-emerald-600" : "bg-gray-50 text-gray-400"
              }`}
            >
              {c.found ? <CheckCircle2 className="h-4.5 w-4.5" /> : <XCircle className="h-4.5 w-4.5" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-gray-900">{c.label}</span>
              <span className="block truncate text-xs text-gray-500" title={c.path}>
                {c.found ? `${c.version} · ${c.path}` : "未安装——对应能力将以降级方式运行"}
              </span>
            </span>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${
                c.found ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-400"
              }`}
            >
              {c.found ? "可用" : "未安装"}
            </span>
          </li>
        ))}
        {components === null && (
          <li className="px-4 py-3.5 text-xs text-gray-400">正在检测组件…</li>
        )}
        {components?.some((c) => !c.found) && (
          <li className="flex items-start gap-2 px-4 py-3 text-xs leading-relaxed text-gray-400">
            <Download className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            未安装的组件不影响文档库核心能力；安装 Pandoc 后可用「转换为可编辑文档」与
            DOCX/HTML 导入，安装 LibreOffice 后可用 Office 高保真预览。
          </li>
        )}
      </ul>

      <p className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-gray-400">
        应用设置
      </p>
      <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
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
        <li className="flex items-center gap-3 px-4 py-3.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-gray-500">
            <ShieldCheck className="h-4.5 w-4.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-gray-900">组件</span>
            <span className="block truncate text-xs text-gray-500">
              Pandoc、LibreOffice、OCR 引擎版本与健康状态（见上方实时状态）
            </span>
          </span>
        </li>
      </ul>
    </div>
  );
}
