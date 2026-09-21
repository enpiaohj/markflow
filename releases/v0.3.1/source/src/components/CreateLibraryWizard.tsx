import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Check,
  Folder,
  FolderSearch,
  Image,
  FileText,
  Loader2,
  Lock,
  ShieldCheck,
  X,
  Zap,
} from "lucide-react";
import * as api from "../lib/api";
import type { QuickScanResult } from "../lib/types";
import { formatSize } from "../lib/format";
import { useLibrary } from "./LibraryContext";

const STEPS = ["选择文件夹", "索引设置", "确认创建"] as const;

function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5.5 w-10 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
        checked ? "bg-primary-600" : "bg-gray-200"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow transition-all ${
          checked ? "left-[calc(100%-1.25rem)]" : "left-0.5"
        }`}
      />
    </button>
  );
}

function PrivacyPoint({ icon: Icon, title, description }: { icon: typeof Zap; title: string; description: string }) {
  return (
    <div className="flex gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div>
        <p className="text-sm font-medium text-gray-900">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-gray-500">{description}</p>
      </div>
    </div>
  );
}

/**
 * 建库向导（设计文档 §6.2，概念图「创建文档库向导」）：
 * ① 选择文件夹（轻量扫描预览）→ ② 索引设置 → ③ 确认创建。
 * MarkFlow 只读取文件内容做索引，不移动、不复制、不修改任何文件。
 */
export default function CreateLibraryWizard() {
  const { wizardOpen, closeWizard, libraryCreated } = useLibrary();
  const [step, setStep] = useState(0);
  const [rootPath, setRootPath] = useState("");
  const [quick, setQuick] = useState<QuickScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullTextIndex, setFullTextIndex] = useState(true);
  const [ocrEnabled, setOcrEnabled] = useState(true);
  const [portableMeta, setPortableMeta] = useState(false);
  const [extraExcludes, setExtraExcludes] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (wizardOpen) {
      setStep(0);
      setRootPath("");
      setQuick(null);
      setError(null);
      setExtraExcludes("");
      setFullTextIndex(true);
      setOcrEnabled(true);
      setPortableMeta(false);
    }
  }, [wizardOpen]);

  if (!wizardOpen) return null;

  const parseExcludes = () =>
    extraExcludes
      .split(/[,，;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  async function pickFolder() {
    setError(null);
    setQuick(null);
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    setRootPath(selected);
    setScanning(true);
    try {
      const result = await api.quickScanLibrary(selected, parseExcludes());
      setQuick(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setScanning(false);
    }
  }

  async function reScanWithExcludes() {
    if (!rootPath) return;
    setScanning(true);
    setError(null);
    try {
      setQuick(await api.quickScanLibrary(rootPath, parseExcludes()));
    } catch (err) {
      setError(String(err));
    } finally {
      setScanning(false);
    }
  }

  async function submit() {
    setCreating(true);
    setError(null);
    try {
      const meta = await api.createLibrary({
        rootPath,
        excludeDirs: parseExcludes(),
        fullTextIndex,
        ocrEnabled,
        portableMeta,
      });
      await libraryCreated(meta.id);
    } catch (err) {
      setError(String(err));
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="flex max-h-[86vh] w-[720px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* 头部与步骤条 */}
        <div className="flex items-start justify-between px-7 pt-6">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">创建文档库</h2>
            <p className="mt-0.5 text-[13px] text-gray-500">
              选择本地文件夹，配置索引设置，快速创建专属文档库
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={closeWizard}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex items-center justify-center gap-3 px-7 pb-2 pt-5">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center gap-3">
              {i > 0 && <span className={`h-px w-16 ${i <= step ? "bg-primary-600" : "bg-gray-200"}`} />}
              <div className="flex items-center gap-2">
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-[13px] font-medium ${
                    i < step
                      ? "bg-primary-600 text-white"
                      : i === step
                        ? "bg-primary-600 text-white"
                        : "border border-gray-300 bg-white text-gray-400"
                  }`}
                >
                  {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </span>
                <span className={`text-sm ${i <= step ? "font-medium text-gray-900" : "text-gray-400"}`}>
                  {label}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* 步骤内容 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-7 py-4">
          {step === 0 && (
            <div className="grid grid-cols-[1fr_240px] gap-6">
              <div>
                <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-gray-700">
                  <FolderSearch className="h-4 w-4 text-primary-600" />
                  选择现有文件夹
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={rootPath}
                    placeholder="尚未选择文件夹"
                    onClick={pickFolder}
                    className="h-9 min-w-0 flex-1 cursor-pointer rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm text-gray-700 outline-none placeholder:text-gray-400"
                  />
                  <button
                    type="button"
                    onClick={pickFolder}
                    className="h-9 shrink-0 rounded-lg border border-gray-200 bg-white px-3.5 text-sm text-gray-700 hover:border-gray-300 hover:bg-gray-50"
                  >
                    浏览…
                  </button>
                </div>

                {scanning && (
                  <div className="mt-4 flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在扫描文件夹…
                  </div>
                )}

                {!scanning && quick && (
                  <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                    <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-600">
                      <span className="flex h-4.5 w-4.5 items-center justify-center rounded-full bg-emerald-500 text-white">
                        <Check className="h-3 w-3" />
                      </span>
                      已找到文件夹
                    </p>
                    <div className="mt-2 flex items-center gap-4 text-sm text-gray-600">
                      <span>{quick.fileCount.toLocaleString()} 个文件</span>
                      <span className="text-gray-300">|</span>
                      <span>{formatSize(quick.totalSize)}</span>
                      <span className="text-gray-300">|</span>
                      <span>本地磁盘</span>
                    </div>
                  </div>
                )}

                {error && (
                  <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-600">{error}</p>
                )}
              </div>

              <aside className="rounded-xl bg-primary-50/60 p-4">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-gray-800">
                  <Folder className="h-4 w-4 text-primary-600" />
                  →
                  <FileText className="h-4 w-4 text-primary-600" />
                  文件保持原位置
                </div>
                <p className="mt-2 text-xs leading-relaxed text-gray-500">
                  MarkFlow 只读取文件内容进行索引，不会移动、复制或修改您的任何文件。
                </p>
                <div className="mt-3 space-y-1 text-xs text-gray-500">
                  <p>· 无需上传，所有处理都在本地完成</p>
                  <p>· 不连接云端，不上传任何文件</p>
                  <p>· 配置完成后即可开始索引，支持随时调整</p>
                </div>
              </aside>
            </div>
          )}

          {step === 1 && (
            <div>
              <p className="mb-3 text-sm font-medium text-gray-700">索引能力</p>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3">
                  <div>
                    <p className="flex items-center gap-2 text-sm font-medium text-gray-900">
                      <FileText className="h-4 w-4 text-blue-600" />
                      全文索引
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      提取 Markdown、Office、PDF 等文档的文本内容（提取引擎将在后续迭代启用）
                    </p>
                  </div>
                  <Switch checked={fullTextIndex} onChange={setFullTextIndex} />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3">
                  <div>
                    <p className="flex items-center gap-2 text-sm font-medium text-gray-900">
                      <Image className="h-4 w-4 text-violet-500" />
                      图片 OCR
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      识别图片中的文字，如截图、扫描件（将在后续迭代启用）
                    </p>
                  </div>
                  <Switch checked={ocrEnabled} onChange={setOcrEnabled} />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3">
                  <div>
                    <p className="flex items-center gap-2 text-sm font-medium text-gray-900">
                      <ShieldCheck className="h-4 w-4 text-emerald-600" />
                      便携元数据
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      在文件夹内保存索引元数据文件，便于随库迁移（将在后续迭代启用）
                    </p>
                  </div>
                  <Switch checked={portableMeta} onChange={setPortableMeta} />
                </div>
              </div>

              <p className="mb-2 mt-5 text-sm font-medium text-gray-700">排除规则</p>
              <input
                type="text"
                value={extraExcludes}
                onChange={(e) => setExtraExcludes(e.target.value)}
                onBlur={reScanWithExcludes}
                placeholder="额外排除的目录名，逗号分隔，如：临时文件, 归档"
                className="h-9 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none placeholder:text-gray-400 focus:border-primary-500"
              />
              <p className="mt-1.5 text-xs text-gray-400">
                默认已排除 .git、node_modules、target、dist、__pycache__ 等目录与隐藏文件；
                修改后自动重新统计文件数量。
              </p>
              {error && (
                <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-600">{error}</p>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="grid grid-cols-[1fr_260px] gap-6">
              <div>
                <p className="text-sm font-medium text-gray-700">创建摘要</p>
                <dl className="mt-3 space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="shrink-0 text-gray-500">库文件夹</dt>
                    <dd className="break-all text-right text-gray-800">{rootPath}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="shrink-0 text-gray-500">文档规模</dt>
                    <dd className="text-gray-800">
                      {quick ? `${quick.fileCount.toLocaleString()} 个文件 · ${formatSize(quick.totalSize)}` : "—"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="shrink-0 text-gray-500">全文索引</dt>
                    <dd className="text-gray-800">{fullTextIndex ? "开启" : "关闭"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="shrink-0 text-gray-500">图片 OCR</dt>
                    <dd className="text-gray-800">{ocrEnabled ? "开启" : "关闭"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="shrink-0 text-gray-500">排除规则</dt>
                    <dd className="break-all text-right text-gray-800">
                      {parseExcludes().length > 0 ? parseExcludes().join("、") : "仅默认规则"}
                    </dd>
                  </div>
                </dl>
                {error && (
                  <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-600">{error}</p>
                )}
              </div>

              <aside className="space-y-4 rounded-xl bg-gray-50 p-4">
                <PrivacyPoint
                  icon={Folder}
                  title="文件保持原位置"
                  description="只读取文件内容进行索引，不移动、不复制、不修改任何文件。"
                />
                <PrivacyPoint icon={ShieldCheck} title="无需上传" description="所有处理都在本地完成，数据始终在本设备上。" />
                <PrivacyPoint icon={Lock} title="安全可控" description="不连接云端，不上传任何文件，完全由您掌控。" />
                <PrivacyPoint icon={Zap} title="快速创建" description="配置完成后即开始后台索引，支持随时调整设置。" />
              </aside>
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-end gap-2.5 border-t border-gray-100 px-7 py-4">
          {step > 0 && (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              className="h-9 rounded-lg border border-gray-200 bg-white px-4 text-sm text-gray-700 hover:bg-gray-50"
            >
              上一步
            </button>
          )}
          {step < 2 && (
            <button
              type="button"
              disabled={!rootPath || !quick || scanning}
              onClick={() => setStep((s) => s + 1)}
              className="h-9 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              下一步
            </button>
          )}
          {step === 2 && (
            <button
              type="button"
              disabled={creating}
              onClick={submit}
              className="flex h-9 items-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-60"
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              创建文档库
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
