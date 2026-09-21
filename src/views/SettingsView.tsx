import { useEffect, useState } from "react";
import {
  Bot,
  Braces,
  CheckCircle2,
  Database,
  Download,
  Monitor,
  Palette,
  Pencil,
  Plus,
  ShieldCheck,
  Stamp,
  Trash2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useDialog } from "../components/DialogContext";
import * as api from "../lib/api";
import { getAutosave, setAutosave } from "../lib/prefs";
import type { AiTestResult, ComponentStatus, ProviderConfig } from "../lib/types";

interface SettingSection {
  name: string;
  description: string;
  icon: LucideIcon;
}

/** 设置分区对应设计文档第 15 节（组件与 AI 为实时状态，其余骨架占位） */
const sections: SettingSection[] = [
  { name: "常规", description: "启动、最近库、语言、更新", icon: Monitor },
  { name: "外观", description: "浅色 / 深色、密度、字号、页面背景", icon: Palette },
  { name: "文档库", description: "排除规则、索引、缓存、便携元数据", icon: Database },
  { name: "审阅", description: "状态、检查规则、交付门禁", icon: Stamp },
];

/** 「设置」页：组件与 AI Provider 为实时状态，其余分区占位 */
export default function SettingsView() {
  const dialog = useDialog();
  const [autosave, setAutosaveState] = useState(getAutosave());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [components, setComponents] = useState<ComponentStatus[] | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", baseUrl: "", model: "", apiKey: "" });
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, AiTestResult>>({});

  function loadProviders() {
    void api
      .aiListProviders()
      .then(setProviders)
      .catch(() => setProviders([]));
  }

  useEffect(() => {
    void api.listComponents().then(setComponents).catch(() => setComponents([]));
    loadProviders();
  }, []);

  function startEdit(p: ProviderConfig) {
    setEditingId(p.id);
    setForm({ name: p.name, baseUrl: p.baseUrl, model: p.model, apiKey: "" });
    setAdding(true);
  }

  function closeForm() {
    setAdding(false);
    setEditingId(null);
    setForm({ name: "", baseUrl: "", model: "", apiKey: "" });
  }

  async function saveProvider() {
    const keyRequired = editingId === null;
    if (!form.name.trim() || !form.baseUrl.trim() || !form.model.trim() || (keyRequired && !form.apiKey.trim())) {
      await dialog.alert(
        keyRequired ? "请完整填写名称、接口地址、模型与 API Key。" : "名称、接口地址与模型不能为空。",
        "信息不完整",
      );
      return;
    }
    if (/^http:\/\//i.test(form.baseUrl.trim()) && !/localhost|127\.0\.0\.1/.test(form.baseUrl)) {
      const ok = await dialog.confirm({
        title: "使用明文 HTTP 地址",
        message: "该接口地址是明文 HTTP：文档内容与 API Key 在传输中可能被窃听。\n除本机服务外，建议改用 https。仍要保存吗？",
        confirmText: "仍然保存",
        danger: true,
      });
      if (!ok) return;
    }
    try {
      if (editingId) await api.aiUpdateProvider(editingId, form);
      else await api.aiSaveProvider(form);
      closeForm();
      loadProviders();
    } catch (err) {
      await dialog.alert(`保存失败：${err}`, "保存失败");
    }
  }

  async function testProvider(id: string) {
    setTesting(id);
    try {
      const result = await api.aiTestProvider(id);
      setTestResult((prev) => ({ ...prev, [id]: result }));
    } finally {
      setTesting(null);
    }
  }

  async function deleteProvider(id: string) {
    const ok = await dialog.confirm({
      title: "删除 Provider",
      message: "删除该 Provider？其 API Key 将同步从系统凭据库移除。",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    await api.aiDeleteProvider(id);
    loadProviders();
  }

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

      <p className="mb-2 mt-6 flex items-center justify-between text-xs font-medium uppercase tracking-wide text-gray-400">
        <span>AI Provider（OpenAI 兼容）</span>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 text-[11px] font-normal normal-case text-primary-600 hover:underline"
          >
            <Plus className="h-3.5 w-3.5" />
            添加 Provider
          </button>
        )}
      </p>

      {adding && (
        <div className="mb-3 space-y-2 rounded-xl border border-gray-200 bg-white p-4">
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="名称，如 DeepSeek"
              className="h-9 rounded-lg border border-gray-200 px-3 text-sm outline-none focus:border-primary-500"
            />
            <input
              type="text"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder="模型名，如 deepseek-chat"
              className="h-9 rounded-lg border border-gray-200 px-3 text-sm outline-none focus:border-primary-500"
            />
          </div>
          <input
            type="text"
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            placeholder="接口地址（OpenAI 兼容，通常以 /v1 结尾）"
            className="h-9 w-full rounded-lg border border-gray-200 px-3 text-sm outline-none focus:border-primary-500"
          />
          <input
            type="password"
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            placeholder={editingId ? "API Key（留空表示不修改）" : "API Key（保存到 Windows 凭据库，不写入文档库）"}
            className="h-9 w-full rounded-lg border border-gray-200 px-3 text-sm outline-none focus:border-primary-500"
          />
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={closeForm}
              className="h-8 rounded-lg border border-gray-200 px-3 text-[13px] text-gray-600 hover:bg-gray-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void saveProvider()}
              className="h-8 rounded-lg bg-primary-600 px-3 text-[13px] font-medium text-white hover:bg-primary-700"
            >
              保存
            </button>
          </div>
        </div>
      )}

      <ul className="mb-2 divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
        {providers.length === 0 && (
          <li className="px-4 py-3 text-xs text-gray-400">
            尚未添加 Provider。添加后即可在编辑器「AI 助手」中使用对话与润色。
          </li>
        )}
        {providers.map((p) => {
          const result = testResult[p.id];
          return (
            <li key={p.id} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
                  <Bot className="h-4.5 w-4.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-gray-900">{p.name}</span>
                  <span className="block truncate text-xs text-gray-500">
                    {p.model} · {p.baseUrl}
                  </span>
                  {result && (
                    <span className={`mt-1 inline-flex items-center gap-1 text-[11px] ${result.ok ? "text-emerald-600" : "text-red-500"}`}>
                      {result.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                      {result.message}
                    </span>
                  )}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    disabled={testing === p.id}
                    onClick={() => void testProvider(p.id)}
                    className="rounded-md border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                  >
                    {testing === p.id ? "测试中…" : "测试连接"}
                  </button>
                  <button
                    type="button"
                    onClick={() => startEdit(p)}
                    title="编辑"
                    className="rounded-md p-1.5 text-gray-300 hover:bg-gray-100 hover:text-gray-600"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteProvider(p.id)}
                    title="删除（密钥同步移除）"
                    className="rounded-md p-1.5 text-gray-300 hover:bg-red-50 hover:text-red-500"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mb-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-gray-400">
        <Download className="mt-0.5 h-3 w-3 shrink-0" />
        API Key 仅保存在 Windows 凭据库；AI 发送前会扫描上下文敏感信息，命中需你确认放行。
      </p>

      <p className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-gray-400">
        应用设置
      </p>
      <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
        <li className="flex items-center gap-3 px-4 py-3.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
            <Braces className="h-4.5 w-4.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-gray-900">自动保存</span>
            <span className="block text-xs text-gray-500">
              编辑器停止输入 3 秒后自动保存（每次保存前仍会自动创建历史快照；异常退出的草稿始终会保留）
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={autosave}
            onClick={() => {
              setAutosave(!autosave);
              setAutosaveState(!autosave);
            }}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${autosave ? "bg-primary-600" : "bg-gray-300"}`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${autosave ? "left-[18px]" : "left-0.5"}`}
            />
          </button>
        </li>
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
