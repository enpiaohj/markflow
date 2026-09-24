import { useCallback, useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  FileText,
  Loader2,
  ShieldCheck,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import FileTypeIcon from "../components/FileTypeIcon";
import { useLibrary } from "../components/LibraryContext";
import * as api from "../lib/api";
import { formatTime } from "../lib/format";
import type { DeliveryRecord, FileEntry, PrecheckReport } from "../lib/types";

const FORMAT_OPTIONS = [
  { key: "md", label: "Markdown 原文", need: "" },
  { key: "html", label: "HTML（Pandoc）", need: "pandoc" },
  { key: "docx", label: "Word（Pandoc）", need: "pandoc" },
  { key: "pdf", label: "PDF（Edge 打印管线）", need: "msedge" },
  { key: "zip", label: "ZIP 交付包", need: "" },
] as const;

const SEVERITY_META: Record<string, { label: string; cls: string }> = {
  error: { label: "错误", cls: "bg-red-50 text-red-600" },
  warning: { label: "警告", cls: "bg-amber-50 text-amber-600" },
};

/** 来源文档列表的读取上限（大库也能完整选择；列表带筛选框，不会因数量多而难用） */
const MAX_SOURCE_FILES = 20000;

/** 正式交付中心（设计文档 §8.12，概念图「正式交付中心与任务状态」） */
export default function DeliveryView() {
  const { current, closeDelivery } = useLibrary();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [fileFilter, setFileFilter] = useState("");
  const [formats, setFormats] = useState<string[]>(["md", "zip"]);
  const [targetDir, setTargetDir] = useState("");
  const [componentNames, setComponentNames] = useState<string[]>([]);
  const [precheck, setPrecheck] = useState<PrecheckReport | null>(null);
  const [prechecking, setPrechecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<DeliveryRecord[]>([]);
  const [completedDir, setCompletedDir] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    if (!current) return;
    try {
      setHistory(await api.listDeliveryHistory(current.id, 20));
    } catch {
      setHistory([]);
    }
  }, [current]);

  useEffect(() => {
    if (!current) return;
    void api.listLibraryFiles(current.id, MAX_SOURCE_FILES).then(setFiles);
    void api.listComponents().then((list) => setComponentNames(list.filter((c) => c.found).map((c) => c.name)));
    void loadHistory();
  }, [current, loadHistory]);

  useEffect(() => {
    const un = listen<{ id: string; ok: boolean }>("delivery:completed", () => {
      void loadHistory();
    });
    return () => {
      void un.then((f) => f());
    };
  }, [loadHistory]);

  function toggleFormat(key: string) {
    setFormats((prev) => (prev.includes(key) ? prev.filter((f) => f !== key) : [...prev, key]));
  }

  async function browseTarget() {
    const dir = await openFileDialog({ directory: true });
    if (dir) setTargetDir(dir);
  }

  async function runPrecheck() {
    if (!current || files.length === 0) return;
    setPrechecking(true);
    setError("");
    setCompletedDir(null);
    try {
      setPrecheck(await api.deliveryPrecheck(current.id, selectedPaths));
    } catch (err) {
      setError(String(err));
    } finally {
      setPrechecking(false);
    }
  }

  async function start() {
    if (!current || !precheck || !targetDir) return;
    setStarting(true);
    setError("");
    try {
      await api.deliveryStart(current.id, precheck.files.map((f) => f.relativePath), formats, targetDir);
      setCompletedDir("pending");
    } catch (err) {
      setError(String(err));
    } finally {
      setStarting(false);
    }
  }

  if (!current) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <FileText className="h-8 w-8 text-gray-300" />
        <p className="mt-3 text-sm text-gray-500">请先打开文档库</p>
      </div>
    );
  }

  const keyword = fileFilter.trim().toLowerCase();
  const visibleFiles = keyword ? files.filter((f) => f.relativePath.toLowerCase().includes(keyword)) : files;
  const selectedSet = new Set(selectedPaths);
  const missingDeps = (need: string) => need !== "" && !componentNames.includes(need);

  return (
    <div className="flex h-full min-h-0 flex-col bg-gray-50">
      {/* 工具栏 */}
      <div className="flex h-11 shrink-0 items-center gap-2 whitespace-nowrap border-b border-gray-200 bg-white px-3">
        <button
          type="button"
          onClick={closeDelivery}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-gray-500 hover:bg-gray-100"
        >
          <ArrowLeft className="h-4 w-4" />
          文档库
        </button>
        <span className="h-4 w-px bg-gray-200" />
        <span className="text-[14px] font-semibold text-gray-900">正式交付中心</span>
        <span className="text-xs text-gray-400">来源冻结哈希 → 质量门禁 → 多格式生成 → 验证 → 原子落盘</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-3xl space-y-5">
          {/* 1 来源 */}
          <section className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-gray-900">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary-600 text-[11px] text-white">1</span>
              来源文档（{files.length} 个可选{selectedPaths.length > 0 ? `，已选 ${selectedPaths.length} 个` : ""}）
            </p>
            <input
              type="text"
              value={fileFilter}
              onChange={(e) => setFileFilter(e.target.value)}
              placeholder="按路径筛选来源文档"
              className="mt-2.5 w-full rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-700 outline-none focus:border-primary-500"
            />
            <div className="mt-2 max-h-52 overflow-y-auto rounded-lg border border-gray-100">
              {visibleFiles.length === 0 && (
                <p className="px-3 py-3 text-xs text-gray-400">没有符合筛选条件的文档</p>
              )}
              {visibleFiles.map((f) => {
                const checked = selectedSet.has(f.relativePath);
                return (
                  <label key={f.relativePath} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelectedPaths((prev) =>
                          checked ? prev.filter((p) => p !== f.relativePath) : [...prev, f.relativePath],
                        )
                      }
                      className="accent-primary-600"
                    />
                    <FileTypeIcon format={f.format} name={f.relativePath} size="sm" />
                    <span className="truncate">{f.relativePath}</span>
                  </label>
                );
              })}
            </div>
          </section>

          {/* 2 格式 */}
          <section className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-gray-900">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary-600 text-[11px] text-white">2</span>
              交付格式
            </p>
            <div className="mt-2.5 grid grid-cols-2 gap-2">
              {FORMAT_OPTIONS.map(({ key, label, need }) => {
                const unavailable = missingDeps(need);
                return (
                  <label
                    key={key}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px] ${
                      unavailable ? "cursor-not-allowed border-gray-100 text-gray-300" : "cursor-pointer border-gray-200 text-gray-700 hover:bg-gray-50"
                    }`}
                    title={unavailable ? "缺少组件：请安装后在设置页确认" : undefined}
                  >
                    <input
                      type="checkbox"
                      disabled={unavailable}
                      checked={formats.includes(key)}
                      onChange={() => toggleFormat(key)}
                      className="accent-primary-600"
                    />
                    {label}
                    {unavailable && <span className="ml-auto text-[10px] text-gray-300">缺组件</span>}
                  </label>
                );
              })}
            </div>
          </section>

          {/* 3 目标目录 + 预检 */}
          <section className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-gray-900">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary-600 text-[11px] text-white">3</span>
              目标目录与预检
            </p>
            <div className="mt-2.5 flex gap-2">
              <input
                type="text"
                readOnly
                value={targetDir}
                onClick={browseTarget}
                placeholder="选择交付输出目录（将创建「交付-时间戳」子目录）"
                className="h-9 min-w-0 flex-1 cursor-pointer rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm text-gray-700 outline-none placeholder:text-gray-400"
              />
              <button type="button" onClick={browseTarget} className="h-9 shrink-0 rounded-lg border border-gray-200 bg-white px-3.5 text-sm text-gray-700 hover:bg-gray-50">
                浏览…
              </button>
              <button
                type="button"
                onClick={() => void runPrecheck()}
                disabled={prechecking || selectedPaths.length === 0 || !targetDir}
                className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40"
              >
                {prechecking ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                交付预检
              </button>
            </div>

            {precheck && (
              <div className="mt-3 rounded-lg border border-gray-200 p-3">
                <p className={`flex items-center gap-1.5 text-[13px] font-medium ${precheck.canProceed ? "text-emerald-600" : "text-red-600"}`}>
                  {precheck.canProceed ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                  {precheck.canProceed ? "预检通过，可以交付" : "存在错误项，已按门禁阻止交付"}
                  <span className="ml-2 font-normal text-gray-400">来源哈希已冻结（{precheck.files.length} 个文件）</span>
                </p>
                {precheck.issues.length > 0 && (
                  <ul className="mt-2 max-h-36 space-y-1 overflow-y-auto">
                    {precheck.issues.map((issue, i) => {
                      const meta = SEVERITY_META[issue.severity] ?? SEVERITY_META.warning;
                      return (
                        <li key={i} className="flex items-center gap-2 text-[11px]">
                          <span className={`shrink-0 rounded px-1 py-0.5 ${meta.cls}`}>{meta.label}</span>
                          <span className="shrink-0 truncate text-gray-400">{issue.relativePath}</span>
                          <span className="truncate text-gray-600">{issue.message}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </section>

          {/* 4 执行 */}
          <section className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-gray-900">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary-600 text-[11px] text-white">4</span>
              开始交付
            </p>
            <button
              type="button"
              disabled={!precheck?.canProceed || !targetDir || starting}
              onClick={() => void start()}
              className="mt-2.5 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary-600 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {starting ? "生成与验证中…" : "开始交付（生成 → 验证 → 原子落盘）"}
            </button>
            {completedDir === "pending" && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-primary-600">
                <Loader2 className="h-3 w-3 animate-spin" />
                交付任务已提交，完成后自动出现在下方历史（任务中心可见进度）。
              </p>
            )}
            {error && (
              <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {error}
              </p>
            )}
          </section>

          {/* 5 历史 */}
          <section className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-gray-900">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary-600 text-[11px] text-white">5</span>
              交付历史
            </p>
            {history.length === 0 ? (
              <p className="mt-2 text-xs text-gray-400">暂无交付记录</p>
            ) : (
              <ul className="mt-2 divide-y divide-gray-100">
                {history.map((rec) => (
                  <li key={rec.id} className="flex items-center gap-3 py-2.5 text-xs">
                    {rec.status === "completed" ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                    ) : rec.status === "failed" ? (
                      <XCircle className="h-4 w-4 shrink-0 text-red-400" />
                    ) : (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary-500" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-gray-700">
                        {rec.sources.map((s) => s.relativePath.split("/").pop()).join("、")} · {rec.formats.join("/")}
                      </p>
                      <p className="truncate text-[11px] text-gray-400" title={rec.error ?? rec.outputDir ?? undefined}>
                        {formatTime(rec.createdAt)}
                        {rec.outputDir ? ` · ${rec.outputDir}` : rec.error ? ` · ${rec.error}` : ""}
                      </p>
                    </div>
                    {rec.outputDir && (
                      <button
                        type="button"
                        onClick={() => void api.openDirectory(rec.outputDir!)}
                        className="flex shrink-0 items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50"
                      >
                        <ExternalLink className="h-3 w-3" />
                        打开文件夹
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
