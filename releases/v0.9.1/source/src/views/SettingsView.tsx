import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  CheckCircle2,
  Eye,
  Info,
  Palette,
  PenLine,
  Pencil,
  Plus,
  Puzzle,
  Search,
  SlidersHorizontal,
  Trash2,
  User,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { SettingGroup, SettingRow, Segmented, Toggle } from "../components/settings/ui";
import { useDialog } from "../components/DialogContext";
import { useLibrary } from "../components/LibraryContext";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "../lib/api";
import {
  getAutosave,
  getOfficeEngine,
  getTheme,
  getLibraryLayout,
  getMaxListRender,
  setMaxListRender,
  getEditorWrap,
  getLargeFileMb,
  getMaxEditMb,
  setEditorSizeLimits,
  setEditorWrap,
  setLibraryLayout,
  type LibraryLayoutPref,
  setAutosave,
  setOfficeEngine,
  setTheme,
  type OfficeEnginePref,
  type ThemePref,
} from "../lib/prefs";
import type { AiTestResult, ComponentStatus, ProviderConfig } from "../lib/types";

type SectionId = "general" | "appearance" | "editor" | "preview" | "ai" | "components" | "about";

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon; keywords: string }[] = [
  { id: "general", label: "通用", icon: SlidersHorizontal, keywords: "启动 开机 自启 托盘 通知区域 关闭 最小化 后台" },
  { id: "appearance", label: "外观", icon: Palette, keywords: "主题 深色 浅色 暗色 夜间 跟随系统 颜色" },
  { id: "editor", label: "编辑器", icon: PenLine, keywords: "自动保存 保存 草稿 换行 折行" },
  { id: "preview", label: "预览", icon: Eye, keywords: "Word PowerPoint Office 内置渲染 引擎 版式 docx pptx" },
  { id: "ai", label: "AI", icon: Bot, keywords: "provider 模型 密钥 api key 接口 大模型" },
  { id: "components", label: "组件", icon: Puzzle, keywords: "pandoc libreoffice edge 转换 检测" },
  { id: "about", label: "关于", icon: Info, keywords: "版本 快捷键 数据 位置 隐私" },
];

const SHORTCUTS = [
  ["Ctrl + O", "打开文件"],
  ["Ctrl + N", "新建文档"],
  ["Ctrl + S", "保存"],
  ["Ctrl + W", "关闭当前文档"],
  ["Ctrl + K", "搜索（在可视化编辑器内为插入 / 编辑链接）"],
  ["Ctrl + Shift + F", "搜索（任何位置都可用）"],
  ["Ctrl + + / − / 0", "放大 / 缩小 / 实际大小（也可 Ctrl + 滚轮）"],
  ["F11", "全屏"],
];

interface SimpleRow {
  section: SectionId;
  label: string;
  description: string;
  keywords: string;
  node: ReactNode;
}

function AboutRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-4">
      <dt className="w-20 shrink-0 text-gray-500">{label}</dt>
      <dd className="min-w-0 break-all">{children}</dd>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => void openUrl(href).catch(() => {})}
      className="text-primary-600 hover:underline"
    >
      {children}
    </button>
  );
}

/** 「设置」页：左侧分类 + 右侧内容；每项「名称 + 说明 | 控件」，改动立即生效；顶部搜索。 */
export default function SettingsView() {
  const dialog = useDialog();
  const { settingsSection, clearSettingsSection } = useLibrary();
  const [section, setSection] = useState<SectionId>("general");
  const [query, setQuery] = useState("");

  // 外部请求直接定位到某个分类（如帮助菜单「关于」），消费后清空，不影响后续正常导航
  useEffect(() => {
    if (!settingsSection) return;
    setSection(settingsSection as SectionId);
    clearSettingsSection();
  }, [settingsSection, clearSettingsSection]);

  // ---- 偏好 ----
  const [theme, setThemeState] = useState<ThemePref>(getTheme());
  const [wrap, setWrapState] = useState(getEditorWrap());
  const [largeMb, setLargeMb] = useState(getLargeFileMb());
  const [maxMb, setMaxMb] = useState(getMaxEditMb());
  const [layout, setLayoutState] = useState<LibraryLayoutPref>(getLibraryLayout());
  const [maxListRender, setMaxListRenderState] = useState(getMaxListRender());
  const [autosave, setAutosaveState] = useState(getAutosave());
  const [officeEngine, setOfficeEngineState] = useState<OfficeEnginePref>(getOfficeEngine());
  const [shell, setShell] = useState<{ closeToTray: boolean; autostart: boolean } | null>(null);
  const [shellBusy, setShellBusy] = useState(false);

  useEffect(() => {
    void api.getShellPrefs().then(setShell).catch(() => setShell({ closeToTray: false, autostart: false }));
  }, []);

  async function changeShell(key: "closeToTray" | "autostart", value: boolean) {
    if (!shell) return;
    setShellBusy(true);
    try {
      if (key === "closeToTray") await api.setCloseToTray(value);
      else await api.setAutostart(value);
      setShell({ ...shell, [key]: value });
    } catch (err) {
      await dialog.alert(String(err), "设置失败");
    } finally {
      setShellBusy(false);
    }
  }

  // ---- AI Provider ----
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", baseUrl: "", model: "", apiKey: "" });
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, AiTestResult>>({});

  function loadProviders() {
    void api.aiListProviders().then(setProviders).catch(() => setProviders([]));
  }

  // ---- 组件 / 关于 ----
  const [components, setComponents] = useState<ComponentStatus[] | null>(null);
  const [version, setVersion] = useState("");

  useEffect(() => {
    loadProviders();
    void api.listComponents().then(setComponents).catch(() => setComponents([]));
    void api.appInfo().then((i) => setVersion(i.version)).catch(() => {});
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
      await dialog.alert(keyRequired ? "请完整填写名称、接口地址、模型与 API Key。" : "名称、接口地址与模型不能为空。", "信息不完整");
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

  // ---- 简单设置行（可被搜索）----
  const AUTOSTART_DESC = "登录 Windows 后自动启动 MarkFlow（在后台启动：开启「关闭时最小化到通知区域」则驻留通知区域，否则最小化到任务栏）。";
  const TRAY_DESC = "点击关闭按钮只隐藏窗口，应用继续在后台运行；点击通知区域图标恢复，右键菜单选择「退出」才会真正退出。";
  const THEME_DESC = "浅色为默认；深色适合弱光环境；跟随系统会随 Windows 的应用模式自动切换。文档页面（Word / Excel / PPT / PDF）始终保持白纸底色。";
  const AUTOSAVE_DESC = "编辑器停止输入 3 秒后自动保存（保存前仍会创建历史快照；异常退出的草稿始终会保留）。";
  const ENGINE_DESC =
    "内置渲染（默认）：即时显示、有目录导航，不启动 Office，保真度略低。自动：装有 Microsoft Office / LibreOffice 时优先用它们导出的精确版式（首次需几秒）。Excel 始终使用原生表格；预览工具栏的「内置渲染 | Office 版式」可随时对当前文档切换。";

  const rows: SimpleRow[] = [
    {
      section: "general",
      label: "开机启动",
      description: AUTOSTART_DESC,
      keywords: "自启 登录 启动 autostart",
      node: (
        <SettingRow key="autostart" label="开机启动" description={AUTOSTART_DESC}>
          <Toggle label="开机启动" checked={shell?.autostart ?? false} disabled={!shell || shellBusy} onChange={(v) => void changeShell("autostart", v)} />
        </SettingRow>
      ),
    },
    {
      section: "general",
      label: "关闭窗口时最小化到通知区域",
      description: TRAY_DESC,
      keywords: "托盘 tray 关闭 最小化 后台 通知区域",
      node: (
        <SettingRow key="tray" label="关闭窗口时最小化到通知区域" description={TRAY_DESC}>
          <Toggle
            label="关闭窗口时最小化到通知区域"
            checked={shell?.closeToTray ?? false}
            disabled={!shell || shellBusy}
            onChange={(v) => void changeShell("closeToTray", v)}
          />
        </SettingRow>
      ),
    },
    {
      section: "appearance",
      label: "主题",
      description: THEME_DESC,
      keywords: "深色 浅色 暗色 夜间 跟随系统 dark light",
      node: (
        <SettingRow key="theme" label="主题" description={THEME_DESC}>
          <Segmented
            value={theme}
            options={[
              { key: "light", label: "浅色" },
              { key: "dark", label: "深色" },
              { key: "system", label: "跟随系统" },
            ]}
            onChange={(v) => {
              setTheme(v);
              setThemeState(v);
            }}
          />
        </SettingRow>
      ),
    },
    {
      section: "appearance",
      label: "文档库列表",
      description: "单库：左侧顶部用选择器切换文档库，只显示当前库的目录树；并列：所有已打开的库并排显示，可折叠。",
      keywords: "文档库 布局 选择器 并列 多库 折叠 侧栏",
      node: (
        <SettingRow key="layout" label="文档库列表" description="单库：左侧顶部用选择器切换文档库，只显示当前库的目录树；并列：所有已打开的库并排显示，可折叠。">
          <Segmented
            value={layout}
            options={[
              { key: "selector", label: "单库（选择器）" },
              { key: "side", label: "并列多库" },
            ]}
            onChange={(v) => {
              setLibraryLayout(v);
              setLayoutState(v);
            }}
          />
        </SettingRow>
      ),
    },
    {
      section: "appearance",
      label: "单个文件夹显示上限",
      description: "目录树与中央列表都会一次性渲染文件夹里的所有条目；文件夹超大时（几千项以上）会明显卡顿，超出上限的部分不显示，可用搜索定位。也可选择不限，但超大文件夹可能卡顿。",
      keywords: "文件夹 文件数 上限 卡顿 性能 虚拟滚动 渲染 不限",
      node: (
        <SettingRow
          key="maxListRender"
          label="单个文件夹显示上限"
          description="目录树与中央列表都会一次性渲染文件夹里的所有条目；文件夹超大时（几千项以上）会明显卡顿，超出上限的部分不显示，可用搜索定位。也可选择不限，但超大文件夹可能卡顿。"
        >
          <div className="flex items-center gap-2">
            <Segmented
              value={Number.isFinite(maxListRender) ? "limit" : "unlimited"}
              options={[
                { key: "limit", label: "限制" },
                { key: "unlimited", label: "不限" },
              ]}
              onChange={(v) => {
                const next = v === "unlimited" ? Infinity : 2000;
                setMaxListRender(next);
                setMaxListRenderState(next);
              }}
            />
            {Number.isFinite(maxListRender) && (
              <input
                type="number"
                min={100}
                step={100}
                value={maxListRender}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isFinite(v) || v < 1) return;
                  setMaxListRender(v);
                  setMaxListRenderState(v);
                }}
                className="h-7 w-24 rounded-md border border-gray-200 bg-white px-2 text-right text-sm text-gray-800 outline-none focus:border-primary-500"
              />
            )}
          </div>
        </SettingRow>
      ),
    },
    {
      section: "editor",
      label: "大文件保护",
      description: "大文件保护：超过「保护模式」大小的文件会关闭语法高亮、折叠、括号联动与诊断以保证输入流畅，仍可编辑；超过「拒绝编辑」大小则不在应用内打开，引导使用 VS Code 等外部工具。",
      keywords: "大文件 保护模式 阈值 大小 限制 MB 性能 卡顿 拒绝编辑",
      node: (
        <SettingRow key="large" label="大文件保护" description="大文件保护：超过「保护模式」大小的文件会关闭语法高亮、折叠、括号联动与诊断以保证输入流畅，仍可编辑；超过「拒绝编辑」大小则不在应用内打开，引导使用 VS Code 等外部工具。">
          <div className="flex flex-col items-end gap-1.5 text-xs text-gray-500">
            <label className="flex items-center gap-2">
              保护模式大于
              <input
                type="number"
                min={0.1}
                step={0.5}
                value={largeMb}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isFinite(v) || v <= 0) return;
                  setLargeMb(v);
                  setEditorSizeLimits(v, maxMb);
                  setMaxMb(getMaxEditMb());
                }}
                className="h-7 w-20 rounded-md border border-gray-200 bg-white px-2 text-right text-sm text-gray-800 outline-none focus:border-primary-500"
              />
              MB
            </label>
            <label className="flex items-center gap-2">
              拒绝编辑大于
              <input
                type="number"
                min={1}
                max={256}
                step={10}
                value={maxMb}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isFinite(v) || v < 1) return;
                  setMaxMb(v);
                  setEditorSizeLimits(largeMb, v);
                  setMaxMb(getMaxEditMb());
                }}
                className="h-7 w-20 rounded-md border border-gray-200 bg-white px-2 text-right text-sm text-gray-800 outline-none focus:border-primary-500"
              />
              MB
            </label>
          </div>
        </SettingRow>
      ),
    },
    {
      section: "editor",
      label: "源码模式自动换行",
      description: "开启后，源码模式与纯文本（.txt、日志等）中过长的行自动折行显示，不再需要左右拖动；关闭则保持单行并横向滚动。",
      keywords: "换行 折行 长文本 横向滚动 源码 文本 wrap",
      node: (
        <SettingRow key="wrap" label="源码模式自动换行" description="开启后，源码模式与纯文本（.txt、日志等）中过长的行自动折行显示，不再需要左右拖动；关闭则保持单行并横向滚动。">
          <Toggle
            label="源码模式自动换行"
            checked={wrap}
            onChange={(v) => {
              setEditorWrap(v);
              setWrapState(v);
            }}
          />
        </SettingRow>
      ),
    },
    {
      section: "editor",
      label: "自动保存",
      description: AUTOSAVE_DESC,
      keywords: "保存 草稿 快照",
      node: (
        <SettingRow key="autosave" label="自动保存" description={AUTOSAVE_DESC}>
          <Toggle
            label="自动保存"
            checked={autosave}
            onChange={(v) => {
              setAutosave(v);
              setAutosaveState(v);
            }}
          />
        </SettingRow>
      ),
    },
    {
      section: "preview",
      label: "Word / PowerPoint 预览引擎",
      description: ENGINE_DESC,
      keywords: "Office 内置渲染 引擎 版式 docx pptx word powerpoint libreoffice",
      node: (
        <SettingRow key="engine" stacked label="Word / PowerPoint 预览引擎" description={ENGINE_DESC}>
          <Segmented
            value={officeEngine}
            options={[
              { key: "builtin", label: "内置渲染（默认）" },
              { key: "auto", label: "自动（有 Office 优先）" },
            ]}
            onChange={(v) => {
              setOfficeEngine(v);
              setOfficeEngineState(v);
            }}
          />
        </SettingRow>
      ),
    },
  ];

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return null;
    const simple = rows.filter((r) => `${r.label} ${r.description} ${r.keywords}`.toLowerCase().includes(q));
    const custom = SECTIONS.filter((s) => ["ai", "components", "about"].includes(s.id) && `${s.label} ${s.keywords}`.toLowerCase().includes(q));
    return { simple, custom };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, theme, layout, maxListRender, wrap, largeMb, maxMb, autosave, officeEngine, shell, shellBusy]);

  const sectionLabel = (id: SectionId) => SECTIONS.find((s) => s.id === id)?.label ?? "";

  // ---- 内容 ----
  function renderSection(id: SectionId): ReactNode {
    if (id === "ai") {
      return (
        <>
          <SettingGroup title="OPENAI 兼容 PROVIDER">
            {providers.length === 0 && !adding && (
              <p className="px-4 py-4 text-xs text-gray-400">尚未添加 Provider。添加后即可在编辑器「AI 助手」中使用对话与润色。</p>
            )}
            {providers.map((p) => {
              const result = testResult[p.id];
              return (
                <div key={p.id} className="flex items-center gap-3 px-4 py-3">
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
                    <button type="button" onClick={() => startEdit(p)} title="编辑" className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteProvider(p.id)}
                      title="删除（密钥同步移除）"
                      className="rounded-md p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
            {adding && (
              <div className="space-y-2 bg-gray-50 p-4">
                <p className="text-xs font-medium text-gray-600">{editingId ? "编辑 Provider" : "添加 Provider"}</p>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="名称，如 DeepSeek"
                    className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none focus:border-primary-500"
                  />
                  <input
                    type="text"
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    placeholder="模型名，如 deepseek-chat"
                    className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none focus:border-primary-500"
                  />
                </div>
                <input
                  type="text"
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                  placeholder="接口地址（OpenAI 兼容，通常以 /v1 结尾）"
                  className="h-9 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none focus:border-primary-500"
                />
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  placeholder={editingId ? "API Key（留空表示不修改）" : "API Key（保存到 Windows 凭据库，不写入文档库）"}
                  className="h-9 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none focus:border-primary-500"
                />
                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={closeForm} className="h-8 rounded-lg border border-gray-200 bg-white px-3 text-[13px] text-gray-600 hover:bg-gray-50">
                    取消
                  </button>
                  <button type="button" onClick={() => void saveProvider()} className="h-8 rounded-lg bg-primary-600 px-3 text-[13px] font-medium text-white hover:bg-primary-700">
                    保存
                  </button>
                </div>
              </div>
            )}
          </SettingGroup>
          {!adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="mb-4 flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs text-primary-600 hover:bg-gray-50"
            >
              <Plus className="h-3.5 w-3.5" />
              添加 Provider
            </button>
          )}
          <p className="text-[11px] leading-relaxed text-gray-400">API Key 仅保存在 Windows 凭据库；AI 发送前会扫描上下文敏感信息，命中需你确认放行。</p>
        </>
      );
    }
    if (id === "components") {
      return (
        <>
          <SettingGroup title="可选组件">
            {(components ?? []).map((c) => (
              <div key={c.name} className="flex items-center gap-3 px-4 py-3.5">
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
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${c.found ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-400"}`}>
                  {c.found ? "可用" : "未安装"}
                </span>
              </div>
            ))}
            {components === null && <p className="px-4 py-3.5 text-xs text-gray-400">正在检测组件…</p>}
          </SettingGroup>
          <p className="text-[11px] leading-relaxed text-gray-400">
            未安装的组件不影响文档库核心能力：安装 Pandoc 后可用「转换为 Markdown」与 DOCX / HTML 导入；安装 LibreOffice 后可作为 Office 版式预览的备选引擎；Edge 用于 PDF 交付。
          </p>
        </>
      );
    }
    if (id === "about") {
      return (
        <>
          <div className="mb-6 flex items-baseline gap-2.5">
            <span className="text-xl font-semibold text-gray-900">MarkFlow</span>
            <span className="text-xs text-gray-400">多格式本地文档库 · 本地优先 · 文件为真源</span>
          </div>
          <dl className="space-y-3 text-sm">
            <AboutRow label="版本">
              <span className="tabular-nums text-gray-800">{version ? `v${version}` : "—"}</span>
            </AboutRow>
            <AboutRow label="开发者">
              <span className="inline-flex items-center gap-1 text-gray-800">
                <User className="h-3.5 w-3.5 text-gray-400" />
                enpiaohj
              </span>
              <ExternalLink href="https://github.com/enpiaohj">（GitHub）</ExternalLink>
            </AboutRow>
            <AboutRow label="源码仓库">
              <ExternalLink href="https://github.com/enpiaohj/markflow">https://github.com/enpiaohj/markflow</ExternalLink>
            </AboutRow>
            <AboutRow label="许可证">
              <span className="text-gray-800">GPL-3.0-only</span>
            </AboutRow>
          </dl>
          <p className="mt-3 text-xs leading-relaxed text-gray-400">
            本应用按 GPL-3.0 许可证发布：随源码分发的第三方组件清单见仓库 THIRD-PARTY-NOTICES.md（Word / PowerPoint 内置渲染使用 Apache-2.0 许可的 docx-preview 与 pptx-renderer，PDF 阅读使用 PDF.js）。
          </p>
          <div className="my-6 h-px bg-gray-200" />
          <h3 className="text-sm font-semibold text-gray-900">隐私与数据</h3>
          <p className="mt-2 text-xs leading-relaxed text-gray-500">
            MarkFlow 不收集遥测、崩溃报告或使用统计，不会向开发者或任何第三方发送使用数据。你的文档始终保存在原位置；
            索引数据库与预览缓存保存在本机应用数据目录（%APPDATA%\com.markflow.app）。唯一的对外请求来自 AI 功能：
            只有当你在「AI」中配置了 Provider 并主动使用时，才会把你选择的上下文发送到你配置的服务地址。
          </p>
          <div className="mt-8" />
          <SettingGroup title="快捷键">
            {SHORTCUTS.map(([keys, desc]) => (
              <div key={keys} className="flex items-center gap-4 px-4 py-2.5 text-sm">
                <kbd className="w-40 shrink-0 rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-center font-sans text-xs text-gray-600">{keys}</kbd>
                <span className="text-gray-600">{desc}</span>
              </div>
            ))}
          </SettingGroup>
        </>
      );
    }
    return <SettingGroup>{rows.filter((r) => r.section === id).map((r) => r.node)}</SettingGroup>;
  }

  return (
    <div className="flex h-full min-h-0">
      {/* 分类导航：窄、纯文字、底色略浅，作为图标栏之后的次级导航 */}
      <nav className="w-44 shrink-0 overflow-y-auto border-r border-gray-200 bg-gray-50 px-2 py-4" aria-label="设置分类">
        <h2 className="mb-3 px-2.5 text-base font-semibold text-gray-900">设置</h2>
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setSection(id);
              setQuery("");
            }}
            aria-current={!q && section === id ? "page" : undefined}
            className={`mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors ${
              !q && section === id ? "bg-white font-medium text-primary-700 shadow-sm ring-1 ring-gray-200" : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-8 py-6">
          <div className="mb-5 flex items-center gap-3">
            <h1 className="text-lg font-semibold text-gray-900">{q ? "搜索结果" : sectionLabel(section)}</h1>
            <div className="relative ml-auto w-56">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                placeholder="搜索设置"
                aria-label="搜索设置"
                className="h-8 w-full rounded-lg border border-gray-200 bg-white pl-8 pr-2.5 text-xs outline-none placeholder:text-gray-400 focus:border-primary-500"
              />
            </div>
          </div>

          {results ? (
            results.simple.length === 0 && results.custom.length === 0 ? (
              <p className="py-12 text-center text-sm text-gray-400">没有匹配「{query}」的设置</p>
            ) : (
              <>
                {results.simple.length > 0 && (
                  <SettingGroup>
                    {results.simple.map((r) => (
                      <div key={r.label}>
                        <p className="px-4 pt-2.5 text-[10px] tracking-wide text-gray-400">{sectionLabel(r.section)}</p>
                        {r.node}
                      </div>
                    ))}
                  </SettingGroup>
                )}
                {results.custom.length > 0 && (
                  <SettingGroup title="相关分类">
                    {results.custom.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          setSection(s.id);
                          setQuery("");
                        }}
                        className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-sm text-gray-700 hover:bg-gray-50"
                      >
                        <s.icon className="h-4 w-4 text-gray-400" />
                        {s.label}
                        <span className="ml-auto text-xs text-primary-600">前往</span>
                      </button>
                    ))}
                  </SettingGroup>
                )}
              </>
            )
          ) : (
            renderSection(section)
          )}
        </div>
      </div>
    </div>
  );
}
