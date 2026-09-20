import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "tiptap-markdown";
import { EditorState } from "@codemirror/state";
import { basicSetup, EditorView as CMEditorView } from "codemirror";
import type { ViewUpdate } from "@codemirror/view";
import { markdown as markdownLang } from "@codemirror/lang-markdown";
import { json as jsonLang } from "@codemirror/lang-json";
import { yaml as yamlLang } from "@codemirror/lang-yaml";
import {
  ArrowLeft,
  Bold,
  Check,
  ChevronDown,
  Code2,
  Eye,
  FileCode,
  History,
  Italic,
  List,
  MessageSquarePlus,
  ListOrdered,
  ListTodo,
  Loader2,
  Quote,
  Redo2,
  Save,
  Sparkles,
  Square,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { Bot, ShieldCheck } from "lucide-react";
import AiPanel from "./AiPanel";
import AnnotationsPanel from "./AnnotationsPanel";
import DiffDialog from "./DiffDialog";
import { useLibrary } from "./LibraryContext";
import * as api from "../lib/api";
import type { CheckIssue } from "../lib/types";
import { EDITABLE_FORMATS, formatSize, formatTime } from "../lib/format";
import type { FileEntry, VersionInfo } from "../lib/types";

type SaveState = "saved" | "dirty" | "saving" | "error";

// ---------------------------------------------------------------------------
// 可视化编辑器（Tiptap / ProseMirror，Markdown 为持久化真源）
// ---------------------------------------------------------------------------

function VisualEditor({
  initial,
  onChange,
  onPolish,
  registerSelection,
}: {
  initial: string;
  onChange: (md: string) => void;
  onPolish: () => void;
  registerSelection: (fn: () => string) => void;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Image,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ html: false, breaks: false }),
    ],
    content: initial,
    onUpdate: ({ editor }) => {
      const storage = editor.storage as unknown as {
        markdown?: { getMarkdown: () => string };
      };
      onChange(storage.markdown?.getMarkdown() ?? "");
    },
  });

  useEffect(() => {
    if (!editor) return;
    registerSelection(() => {
      const sel = editor.state.selection as unknown as { from: number; to: number; empty: boolean };
      return sel.empty ? "" : editor.state.doc.textBetween(sel.from, sel.to, " ");
    });
  }, [editor, registerSelection]);

  if (!editor) return null;

  const btn = (active: boolean) =>
    `flex h-7 w-7 items-center justify-center rounded-md text-[13px] transition-colors ${
      active ? "bg-primary-50 text-primary-700" : "text-gray-500 hover:bg-gray-100"
    }`;

  return (
    <div className="flex h-full flex-col">
      {/* 轻量格式工具栏（对应概念图 Ribbon，v0.2 精简版） */}
      <div className="flex flex-wrap items-center gap-0.5 border-b border-gray-200 bg-white px-4 py-1.5">
        <button type="button" className={btn(editor.isActive("bold"))} title="加粗"
          onClick={() => editor.chain().focus().toggleBold().run()}><Bold className="h-3.5 w-3.5" /></button>
        <button type="button" className={btn(editor.isActive("italic"))} title="斜体"
          onClick={() => editor.chain().focus().toggleItalic().run()}><Italic className="h-3.5 w-3.5" /></button>
        <span className="mx-1 h-4 w-px bg-gray-200" />
        <button type="button" className={btn(editor.isActive("heading", { level: 1 }))} title="标题 1"
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>H1</button>
        <button type="button" className={btn(editor.isActive("heading", { level: 2 }))} title="标题 2"
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</button>
        <button type="button" className={btn(editor.isActive("heading", { level: 3 }))} title="标题 3"
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>H3</button>
        <span className="mx-1 h-4 w-px bg-gray-200" />
        <button type="button" className={btn(editor.isActive("bulletList"))} title="无序列表"
          onClick={() => editor.chain().focus().toggleBulletList().run()}><List className="h-3.5 w-3.5" /></button>
        <button type="button" className={btn(editor.isActive("orderedList"))} title="有序列表"
          onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered className="h-3.5 w-3.5" /></button>
        <button type="button" className={btn(editor.isActive("taskList"))} title="任务列表"
          onClick={() => editor.chain().focus().toggleTaskList().run()}><ListTodo className="h-3.5 w-3.5" /></button>
        <button type="button" className={btn(editor.isActive("blockquote"))} title="引用"
          onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote className="h-3.5 w-3.5" /></button>
        <button type="button" className={btn(editor.isActive("codeBlock"))} title="代码块"
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}><Code2 className="h-3.5 w-3.5" /></button>
        <span className="mx-1 h-4 w-px bg-gray-200" />
        <button type="button" className={btn(false)} title="插入表格"
          onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
          <Square className="h-3 w-3" />
        </button>
        <span className="mx-1 h-4 w-px bg-gray-200" />
        <button type="button" className={btn(false)} title="撤销"
          onClick={() => editor.chain().focus().undo().run()}><Undo2 className="h-3.5 w-3.5" /></button>
        <button type="button" className={btn(false)} title="重做"
          onClick={() => editor.chain().focus().redo().run()}><Redo2 className="h-3.5 w-3.5" /></button>
        <span className="mx-1 h-4 w-px bg-gray-200" />
        <button
          type="button"
          className={`${btn(false)} w-auto gap-1 px-2`}
          title="AI 润色整篇文档（进入差异审阅）"
          onClick={onPolish}
        >
          <Sparkles className="h-3.5 w-3.5" />
          AI 润色
        </button>
      </div>

      {/* 分页文档画布 */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-gray-100/70 px-6 py-8">
        <div className="mx-auto min-h-[60vh] w-full max-w-[820px] rounded-lg bg-white px-14 py-12 shadow-sm ring-1 ring-gray-200/60">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 源码编辑器（CodeMirror 6）
// ---------------------------------------------------------------------------

function langExtension(format: string) {
  switch (format) {
    case "markdown":
      return markdownLang();
    case "json":
      return jsonLang();
    case "yaml":
      return yamlLang();
    default:
      return [];
  }
}

function SourceEditor({
  initial,
  format,
  onChange,
  registerSelection,
}: {
  initial: string;
  format: string;
  onChange: (text: string) => void;
  registerSelection: (fn: () => string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new CMEditorView({
      state: EditorState.create({
        doc: initial,
        extensions: [basicSetup, langExtension(format),
          CMEditorView.updateListener.of((update: ViewUpdate) => {
            if (update.docChanged) onChange(update.state.doc.toString());
          }),
        ],
      }),
      parent: hostRef.current,
    });
    registerSelection(() => {
      const sel = view.state.selection as unknown as { from: number; to: number };
      return view.state.sliceDoc(sel.from, sel.to);
    });
    return () => view.destroy();
    // initial 仅在挂载时使用；编辑中的变化通过 onChange 上抛，切换编辑器由 key 重建完成
  }, []);

  return <div ref={hostRef} className="h-full overflow-hidden bg-white" />;
}

// ---------------------------------------------------------------------------
// 编辑器主面板
// ---------------------------------------------------------------------------

export default function EditorPane() {
  const { current, openFile, closeFile } = useLibrary();
  const [entry, setEntry] = useState<FileEntry | null>(null);
  const [savedText, setSavedText] = useState("");
  const [baseMtime, setBaseMtime] = useState(0);
  const [editText, setEditText] = useState("");
  const [mode, setMode] = useState<"visual" | "source">("visual");
  const [modeEpoch, setModeEpoch] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ok" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [sidePanel, setSidePanel] = useState<"ai" | "notes" | null>(null);
  const selectionFnRef = useRef<(() => string) | null>(null);
  const [issues, setIssues] = useState<CheckIssue[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [diff, setDiff] = useState<{ original: string; polished: string; loading: boolean } | null>(null);
  const [aiProviderId, setAiProviderId] = useState<string | null>(null);

  useEffect(() => {
    void api.aiListProviders().then((list) => {
      setAiProviderId(list[0]?.id ?? null);
    });
  }, [openFile]);

  const rel = openFile?.relativePath ?? "";

  // 打开文件 → 读取内容与基线
  useEffect(() => {
    if (!current || !openFile) return;
    let cancelled = false;
    setLoadState("loading");
    setSaveError("");
    setConflict(null);
    setShowHistory(false);
    setVersions(null);
    api
      .getFileDetail(current.id, openFile.relativePath)
      .then((detail) => {
        if (cancelled) return;
        setEntry(detail);
        if (!EDITABLE_FORMATS.has(detail.format)) {
          setLoadState("error");
          setLoadError(`「${detail.formatLabel}」暂不支持编辑，预览能力按 v0.3 路线交付。`);
          return;
        }
        return api.readTextFile(current.id, openFile.relativePath).then((file) => {
          setSavedText(file.content);
          setEditText(file.content);
          setBaseMtime(file.baseMtime);
          setMode(detail.format === "markdown" ? "visual" : "source");
          setModeEpoch((n) => n + 1);
          setSaveState("saved");
          setLoadState("ok");
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadState("error");
          setLoadError(String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [current, openFile]);

  const doSave = useCallback(
    async (force: boolean) => {
      if (!current || !openFile) return;
      setSaveState("saving");
      setSaveError("");
      try {
        const out = await api.saveTextFile(current.id, rel, editText, baseMtime, force);
        setSavedText(editText);
        setBaseMtime(out.mtime);
        setSaveState("saved");
        setConflict(null);
      } catch (err) {
        const message = String(err);
        if (message.startsWith("FILE_CONFLICT")) {
          setConflict(message.split(":").slice(1).join(":"));
          setSaveState("dirty");
        } else {
          setSaveError(message);
          setSaveState("error");
        }
      }
    },
    [current, openFile, rel, editText, baseMtime],
  );

  // Ctrl+S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) void doSave(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveState, doSave]);

  // 切换模式时同步文本来源
  function switchMode(next: "visual" | "source") {
    if (next === mode) return;
    setMode(next);
    setModeEpoch((n) => n + 1);
  }

  async function reloadFromDisk() {
    if (!current || !openFile) return;
    setConflict(null);
    try {
      const file = await api.readTextFile(current.id, rel);
      setSavedText(file.content);
      setEditText(file.content);
      setBaseMtime(file.baseMtime);
      setModeEpoch((n) => n + 1);
      setSaveState("saved");
    } catch (err) {
      setSaveError(String(err));
    }
  }

  async function loadVersions() {
    if (!current) return;
    setShowHistory((v) => !v);
    if (!versions) setVersions(await api.listFileVersions(current.id, rel));
  }

  async function restoreVersion(v: VersionInfo) {
    if (!current || !confirm("恢复到该历史版本？\n\n当前内容会先自动保存为新的历史快照，可再次恢复回来。")) return;
    try {
      await api.restoreFileVersion(current.id, rel, v.id);
      await reloadFromDisk();
      setVersions(null);
      void loadVersions();
    } catch (err) {
      setSaveError(String(err));
    }
  }

  async function runCheck() {
    if (!current || !openFile) return;
    setChecking(true);
    try {
      setIssues(await api.checkDocument(current.id, rel));
    } catch (err) {
      alert(`检查失败：${err}`);
    } finally {
      setChecking(false);
    }
  }

  /** AI 润色当前文档 → 差异审阅（§8.7） */
  async function runPolish(allowSensitive: boolean) {
    if (!current || !openFile) return;
    const original = editText;
    setDiff({ original, polished: "", loading: true });
    let polished = "";
    try {
      await api.aiChat(
        {
          providerId: aiProviderId ?? "",
          libraryId: current.id,
          contextPaths: [rel],
          allowSensitive,
          messages: [
            {
              role: "user",
              content:
                "请润色以下 Markdown 文档：保持整体结构与语义不变，改进表达流畅度与用词准确性，" +
                "修正明显的错别字。直接输出润色后的完整 Markdown 文档，不要输出任何解释。\n\n" +
                original,
            },
          ],
        },
        (chunk) => {
          polished += chunk;
          setDiff({ original, polished, loading: true });
        },
      );
      if (!polished.trim()) {
        alert("AI 未返回内容，请检查 Provider 配置或稍后重试。");
        setDiff(null);
        return;
      }
      setDiff({ original, polished, loading: false });
    } catch (err) {
      const message = String(err);
      setDiff(null);
      if (message.startsWith("SENSITIVE::")) {
        if (confirm("当前文档包含疑似敏感信息（详见「检查」面板）。\n确认将其发送给 AI Provider 进行润色吗？")) {
          await runPolish(true);
        }
      } else if (message.includes("Provider 不存在")) {
        alert("尚未配置 AI Provider，请在「设置 → AI」中添加。");
      } else {
        alert(message);
      }
    }
  }

  const isMarkdown = entry?.format === "markdown";
  const dirty = editText !== savedText;
  // 展示状态：保存中/失败优先，其后由「文本是否变化」驱动
  const displayState: SaveState =
    saveState === "saving" ? "saving" : saveState === "error" ? "error" : dirty ? "dirty" : "saved";

  if (!current || !openFile) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部：返回、文件信息、模式切换、保存状态、历史 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-3">
        <button
          type="button"
          onClick={closeFile}
          title="关闭并返回文档库"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-gray-500 hover:bg-gray-100"
        >
          <ArrowLeft className="h-4 w-4" />
          文档库
        </button>
        <span className="h-4 w-px bg-gray-200" />
        <FileCode className="h-4 w-4 shrink-0 text-gray-400" />
        <span className="min-w-0 truncate text-[13px] font-medium text-gray-800">{rel}</span>

        {isMarkdown && (
          <div className="ml-3 flex items-center rounded-lg border border-gray-200 p-0.5">
            {(
              [
                { key: "visual", label: "可视化", icon: Eye },
                { key: "source", label: "源码", icon: Code2 },
              ] as const
            ).map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => switchMode(key)}
                className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition-colors ${
                  mode === key ? "bg-primary-50 text-primary-700" : "text-gray-500 hover:bg-gray-50"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-3">
          {displayState === "saving" && (
            <span className="flex items-center gap-1.5 text-xs text-gray-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              保存中…
            </span>
          )}
          {displayState === "saved" && (
            <span className="flex items-center gap-1 text-xs text-emerald-600">
              <Check className="h-3.5 w-3.5" />
              已保存
            </span>
          )}
          {displayState === "dirty" && (
            <span className="flex items-center gap-1.5 text-xs text-amber-600">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              未保存
            </span>
          )}
          {displayState === "error" && (
            <span className="flex items-center gap-1.5 text-xs text-red-500" title={saveError}>
              <TriangleAlert className="h-3.5 w-3.5" />
              保存失败
            </span>
          )}

          <button
            type="button"
            onClick={() => void runCheck()}
            disabled={checking || loadState !== "ok"}
            title="文档质量检查（标题层级 / 断链 / 空章节 / 敏感信息）"
            className="flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
          >
            {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            检查
            {issues && (
              <span
                className={`rounded px-1 text-[10px] ${
                  issues.some((i) => i.severity === "error")
                    ? "bg-red-50 text-red-600"
                    : issues.length > 0
                      ? "bg-amber-50 text-amber-600"
                      : "bg-emerald-50 text-emerald-600"
                }`}
              >
                {issues.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setSidePanel((v) => (v === "ai" ? null : "ai"))}
            title="AI 助手（对话 / 润色，基于上下文门禁）"
            className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors ${
              sidePanel === "ai"
                ? "border-primary-200 bg-primary-50 text-primary-700"
                : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            <Bot className="h-3.5 w-3.5" />
            AI 助手
          </button>
          <button
            type="button"
            onClick={() => setSidePanel((v) => (v === "notes" ? null : "notes"))}
            title="批注（基于编辑器选中文本）"
            className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors ${
              sidePanel === "notes"
                ? "border-primary-200 bg-primary-50 text-primary-700"
                : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            批注
          </button>

          {/* 历史快照下拉 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => void loadVersions()}
              title="历史快照"
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
            >
              <History className="h-3.5 w-3.5" />
              历史
              <ChevronDown className="h-3 w-3" />
            </button>
            {showHistory && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowHistory(false)} />
                <div className="absolute right-0 top-8 z-50 max-h-80 w-80 overflow-y-auto rounded-xl border border-gray-200 bg-white py-1.5 shadow-xl">
                  <p className="px-3 pb-1 pt-1 text-[11px] font-medium text-gray-400">历史快照（保存前自动创建）</p>
                  {versions === null && (
                    <p className="flex items-center gap-2 px-3 py-2 text-xs text-gray-400">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      加载中…
                    </p>
                  )}
                  {versions?.length === 0 && (
                    <p className="px-3 py-2 text-xs text-gray-400">暂无快照；保存后自动生成</p>
                  )}
                  {versions?.map((v) => (
                    <div key={v.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-gray-700">{formatTime(v.createdAt)}</p>
                        <p className="text-[11px] text-gray-400">{formatSize(v.size)}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void restoreVersion(v)}
                        className="rounded-md border border-gray-200 px-2 py-0.5 text-[11px] text-gray-600 hover:border-primary-200 hover:bg-primary-50 hover:text-primary-700"
                      >
                        恢复
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => dirty && void doSave(false)}
            disabled={!dirty || displayState === "saving"}
            title="保存（Ctrl + S）"
            className="flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Save className="h-3.5 w-3.5" />
            保存
          </button>
        </div>
      </div>

      {saveError && (
        <div className="flex items-start gap-2 border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="break-all">{saveError}</span>
        </div>
      )}

      {/* 冲突处理对话框（设计文档 §14：比较、重新载入、另存、合并的 v0.2 子集） */}
      {conflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-[440px] rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-500">
                <TriangleAlert className="h-5 w-5" />
              </span>
              <div>
                <h3 className="text-[15px] font-semibold text-gray-900">检测到外部修改</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-gray-500">{conflict}</p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConflict(null)}
                className="h-8 rounded-lg border border-gray-200 px-3 text-[13px] text-gray-600 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void reloadFromDisk()}
                className="h-8 rounded-lg border border-gray-200 px-3 text-[13px] text-gray-600 hover:bg-gray-50"
              >
                重新载入外部版本
              </button>
              <button
                type="button"
                onClick={() => void doSave(true)}
                className="h-8 rounded-lg bg-amber-500 px-3 text-[13px] font-medium text-white hover:bg-amber-600"
              >
                覆盖保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 检查结果面板 */}
      {issues && (
        <div className="max-h-44 shrink-0 overflow-y-auto border-b border-gray-200 bg-gray-50 px-4 py-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-xs font-medium text-gray-600">
              质量检查：{issues.length === 0 ? "未发现问题" : `${issues.length} 项`}
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={() => void runCheck()} className="text-[11px] text-primary-600 hover:underline">
                重新检查
              </button>
              <button type="button" onClick={() => setIssues(null)} className="text-[11px] text-gray-400 hover:text-gray-600">
                关闭
              </button>
            </div>
          </div>
          <ul className="space-y-1">
            {issues.map((issue, i) => (
              <li key={i} className="flex items-center gap-2 text-[11px]">
                <span
                  className={`shrink-0 rounded px-1 py-0.5 ${
                    issue.severity === "error"
                      ? "bg-red-50 text-red-600"
                      : issue.severity === "warning"
                        ? "bg-amber-50 text-amber-600"
                        : "bg-blue-50 text-blue-600"
                  }`}
                >
                  {issue.severity === "error" ? "错误" : issue.severity === "warning" ? "警告" : "建议"}
                </span>
                <span className="shrink-0 text-gray-400">
                  {issue.line > 0 ? `第 ${issue.line} 行` : "全文"}
                </span>
                <span className="truncate text-gray-600">{issue.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 编辑区 + AI 面板 */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
      {loadState === "loading" && (
        <div className="flex flex-1 flex-col items-center justify-center text-gray-400">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p className="mt-3 text-sm">正在打开文件…</p>
        </div>
      )}
      {loadState === "error" && (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-gray-400">
          <TriangleAlert className="h-7 w-7" />
          <p className="mt-3 max-w-md text-center text-sm leading-relaxed text-gray-500">{loadError}</p>
        </div>
      )}
      {loadState === "ok" && (
        <div className="min-h-0 flex-1">
          {mode === "visual" ? (
            <VisualEditor
              key={`v-${modeEpoch}`}
              initial={savedText}
              onChange={setEditText}
              onPolish={() => void runPolish(false)}
              registerSelection={(fn) => (selectionFnRef.current = fn)}
            />
          ) : (
            <SourceEditor
              key={`s-${modeEpoch}`}
              initial={editText}
              format={entry?.format ?? "text"}
              onChange={setEditText}
              registerSelection={(fn) => (selectionFnRef.current = fn)}
            />
          )}
        </div>
      )}
        </div>
        {sidePanel && (
          <aside className="w-96 shrink-0 border-l border-gray-200">
            {sidePanel === "ai" ? <AiPanel currentPath={rel} /> : <AnnotationsPanel currentPath={rel} getSelection={() => selectionFnRef.current?.() ?? ""} />}
          </aside>
        )}
      </div>

      {/* AI 差异审阅（§8.7） */}
      {diff && (
        <DiffDialog
          title="AI 润色 · 差异审阅"
          original={diff.original}
          modified={diff.polished}
          loading={diff.loading}
          onApply={(polished) => {
            setEditText(polished);
            setDiff(null);
          }}
          onCancel={() => setDiff(null)}
        />
      )}
    </div>
  );
}
