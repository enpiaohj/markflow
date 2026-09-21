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
  Link2,
  List,
  MessageSquarePlus,
  ListOrdered,
  ListTodo,
  Loader2,
  Quote,
  Redo2,
  Save,
  Sparkles,
  Table2,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { Bot, ShieldCheck } from "lucide-react";
import AiPanel from "./AiPanel";
import AnnotationsPanel from "./AnnotationsPanel";
import DiffDialog from "./DiffDialog";
import { useDialog } from "./DialogContext";
import { useLibrary } from "./LibraryContext";
import { MENU_SAVE_EVENT } from "./MenuBar";
import { useZoom } from "./ZoomContext";
import * as api from "../lib/api";
import { getAutosave } from "../lib/prefs";
import type { CheckIssue } from "../lib/types";
import { EDITABLE_FORMATS, formatSize, formatTime } from "../lib/format";
import type { FileEntry, VersionInfo } from "../lib/types";

type SaveState = "saved" | "dirty" | "saving" | "error";

/** 拆出 Front Matter：可视化编辑器不理解它，编辑正文时原样保护、保存时拼回。 */
function splitFrontMatter(text: string): { front: string; body: string } {
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? { front: m[0], body: text.slice(m[0].length) } : { front: "", body: text };
}

/** 可视化模式无法无损往返的 Markdown 语法（切换前提示，避免静默改写 / 丢失）。 */
function detectVisualRisks(body: string): string[] {
  const noCode = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const risks: string[] = [];
  if (/<\/?[a-zA-Z][^>]*>/.test(noCode)) risks.push("HTML 标签");
  if (/<!--/.test(noCode)) risks.push("HTML 注释");
  if (/\[\^[^\]\s]+\]/.test(noCode)) risks.push("脚注");
  if (/\[\[[^\]]+\]\]/.test(noCode)) risks.push("Wiki 链接");
  if (/\$\$[\s\S]+?\$\$/.test(noCode)) risks.push("数学公式");
  if (/```mermaid/.test(body)) risks.push("Mermaid 图表");
  if (/^>\s*\[![A-Za-z]+\]/m.test(noCode)) risks.push("Callout 提示块");
  return risks;
}

/** 草稿键：崩溃 / 断电后的恢复依据（存于 WebView 本地存储，不写入文档库）。 */
const draftKey = (libraryId: string, rel: string) => `mf-draft:${libraryId}:${rel}`;

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
  const { config: zoomConfig } = useZoom();
  const dialog = useDialog();
  async function onLink(ed: NonNullable<ReturnType<typeof useEditor>>) {
    const previous = (ed.getAttributes("link").href as string | undefined) ?? "";
    const url = await dialog.prompt({
      title: "链接",
      label: "链接地址（留空并确定可移除链接）",
      defaultValue: previous,
      placeholder: "https://",
    });
    if (url === null) return;
    if (url.trim() === "") {
      ed.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      ed.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
    }
  }
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
        <button type="button" className={btn(false)} title="插入表格（3×3）"
          onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
          <Table2 className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={btn(editor.isActive("link"))} title="插入 / 编辑链接"
          onClick={() => void onLink(editor)}>
          <Link2 className="h-3.5 w-3.5" />
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
        <div
          className="mx-auto min-h-[60vh] w-full max-w-[820px] rounded-lg bg-white px-14 py-12 shadow-sm ring-1 ring-gray-200/60"
          style={{ zoom: zoomConfig.value }}
        >
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
  const { config: zoomConfig } = useZoom();
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

  return (
    <div
      ref={hostRef}
      className="h-full overflow-hidden bg-white"
      style={{ zoom: zoomConfig.value }}
    />
  );
}

// ---------------------------------------------------------------------------
// 编辑器主面板
// ---------------------------------------------------------------------------

export default function EditorPane() {
  const { current, openFile, closeFile, setEditorDirty, confirmDiscard } = useLibrary();
  const { configure: configureZoom } = useZoom();
  const dialog = useDialog();
  const [encoding, setEncoding] = useState("UTF-8");
  const [risks, setRisks] = useState<string[]>([]);
  const [externalChanged, setExternalChanged] = useState(false);
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
  const [aiProviderLabel, setAiProviderLabel] = useState("");
  const [autosave, setAutosaveOn] = useState(getAutosave());

  useEffect(() => {
    void api.aiListProviders().then((list) => {
      setAiProviderId(list[0]?.id ?? null);
      if (list[0]) {
        let host = list[0].baseUrl;
        try {
          host = new URL(list[0].baseUrl).host;
        } catch {
          /* 保持原样 */
        }
        setAiProviderLabel(`${list[0].name} · ${list[0].model}（${host}）`);
      }
    });
  }, [openFile]);

  useEffect(() => {
    const onPrefs = () => setAutosaveOn(getAutosave());
    window.addEventListener("markflow:prefs-changed", onPrefs);
    return () => window.removeEventListener("markflow:prefs-changed", onPrefs);
  }, []);

  /** AI 润色前明确告知去向：整篇文档将发送给哪个 Provider */
  async function startPolish() {
    if (!aiProviderId) {
      await dialog.alert("尚未配置 AI Provider，请在「设置 → AI」中添加。");
      return;
    }
    const ok = await dialog.confirm({
      title: "AI 润色",
      message: `将把当前文档全文（约 ${editText.replace(/\s/g, "").length.toLocaleString()} 字符）发送到：\n${aiProviderLabel}\n\n发送前会扫描敏感信息；润色结果会先进入差异审阅，不会直接覆盖文档。`,
      confirmText: "发送并润色",
    });
    if (ok) await runPolish(false);
  }

  const rel = openFile?.relativePath ?? "";

  useEffect(() => {
    configureZoom({ visible: true, min: 0.5, max: 2.5, step: 0.1, value: 1, presets: [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5] });
    return () => configureZoom({ visible: false });
  }, [configureZoom, openFile]);

  // 打开文件 → 读取内容与基线
  useEffect(() => {
    if (!current || !openFile) return;
    let cancelled = false;
    setLoadState("loading");
    setSaveError("");
    setConflict(null);
    setShowHistory(false);
    setVersions(null);
    setExternalChanged(false);
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
          setEncoding(file.encoding);
          const found = detail.format === "markdown" ? detectVisualRisks(splitFrontMatter(file.content).body) : [];
          setRisks(found);
          // 含无法无损往返的语法时默认进入源码模式，避免可视化编辑静默改写文档
          setMode(detail.format === "markdown" && found.length === 0 ? "visual" : "source");
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
        setExternalChanged(false);
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
    const onMenuSave = () => {
      if (dirty) void doSave(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(MENU_SAVE_EVENT, onMenuSave);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(MENU_SAVE_EVENT, onMenuSave);
    };
  }, [saveState, doSave]);

  // 切换模式时同步文本来源；切到可视化前提示无法无损保留的语法
  async function switchMode(next: "visual" | "source") {
    if (next === mode) return;
    if (next === "visual") {
      const found = detectVisualRisks(splitFrontMatter(editText).body);
      setRisks(found);
      if (found.length > 0) {
        const ok = await dialog.confirm({
          title: "可视化模式可能改写文档",
          message: `文档包含可视化编辑器无法无损保留的语法：${found.join("、")}。\n继续编辑后保存，这些内容可能被改写或丢失。建议使用源码模式。`,
          confirmText: "仍然切换",
          danger: true,
        });
        if (!ok) return;
      }
    }
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
      setEncoding(file.encoding);
      setExternalChanged(false);
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
    if (!current) return;
    const ok = await dialog.confirm({
      title: "恢复历史版本",
      message: "恢复到该历史版本？\n\n当前内容会先自动保存为新的历史快照，可再次恢复回来。",
      confirmText: "恢复",
    });
    if (!ok) return;
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
      await dialog.alert(`检查失败：${err}`);
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
          contextPaths: [],
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
        await dialog.alert("AI 未返回内容，请检查 Provider 配置或稍后重试。");
        setDiff(null);
        return;
      }
      setDiff({ original, polished, loading: false });
    } catch (err) {
      const message = String(err);
      setDiff(null);
      if (message.startsWith("SENSITIVE::")) {
        const ok = await dialog.confirm({
          title: "疑似敏感信息",
          message: "当前文档包含疑似敏感信息（详见「检查」面板）。\n确认将其发送给 AI Provider 进行润色吗？",
          confirmText: "知情并发送",
          danger: true,
        });
        if (ok) await runPolish(true);
      } else if (message.includes("Provider 不存在")) {
        await dialog.alert("尚未配置 AI Provider，请在「设置 → AI」中添加。");
      } else {
        await dialog.alert(message);
      }
    }
  }

  const isMarkdown = entry?.format === "markdown";
  const dirty = editText !== savedText;

  // 向全局上报未保存状态（活动栏切换时用于离开确认）
  useEffect(() => {
    setEditorDirty(dirty);
    return () => setEditorDirty(false);
  }, [dirty, setEditorDirty]);

  // 草稿：未保存内容防抖写入本地存储，崩溃 / 断电后可恢复；保存或放弃后清除
  const hadDirtyRef = useRef(false);
  useEffect(() => {
    hadDirtyRef.current = false;
  }, [current, rel]);
  useEffect(() => {
    if (!current || !rel || loadState !== "ok") return;
    const key = draftKey(current.id, rel);
    try {
      if (!dirty) {
        // 仅在「有过未保存修改 → 已保存」时清除草稿；刚载入时不能清，否则崩溃恢复草稿会被抹掉
        if (hadDirtyRef.current) localStorage.removeItem(key);
        hadDirtyRef.current = false;
        return;
      }
      hadDirtyRef.current = true;
      const t = window.setTimeout(() => {
        try {
          localStorage.setItem(key, JSON.stringify({ text: editText, savedAt: Date.now() }));
        } catch {
          /* 存储不可用时忽略 */
        }
      }, 800);
      return () => window.clearTimeout(t);
    } catch {
      /* 存储不可用时忽略 */
    }
  }, [current, rel, loadState, dirty, editText]);

  useEffect(() => {
    if (!current || !rel) return;
    const key = draftKey(current.id, rel);
    const onDiscard = () => {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("markflow:discard-draft", onDiscard);
    return () => window.removeEventListener("markflow:discard-draft", onDiscard);
  }, [current, rel]);

  // 自动保存（设置中开启）：停止输入 3 秒后保存；有冲突 / 外部修改时不自动覆盖
  useEffect(() => {
    if (!autosave || !dirty || loadState !== "ok" || saveState === "saving" || conflict || externalChanged) return;
    const t = window.setTimeout(() => void doSave(false), 3000);
    return () => window.clearTimeout(t);
  }, [autosave, dirty, editText, loadState, saveState, conflict, externalChanged, doSave]);

  // 载入完成后检查是否有可恢复的草稿
  useEffect(() => {
    if (!current || !rel || loadState !== "ok") return;
    const key = draftKey(current.id, rel);
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const draft = JSON.parse(raw) as { text: string; savedAt: number };
      if (draft.text === savedText) {
        localStorage.removeItem(key);
        return;
      }
      void dialog
        .confirm({
          title: "发现未保存的草稿",
          message: `检测到该文件在 ${formatTime(draft.savedAt)} 有未保存的编辑内容（可能因异常退出而丢失）。\n是否恢复？`,
          confirmText: "恢复草稿",
          cancelText: "丢弃草稿",
        })
        .then((ok) => {
          if (ok) {
            setEditText(draft.text);
            setModeEpoch((n) => n + 1);
          } else {
            try {
              localStorage.removeItem(key);
            } catch {
              /* ignore */
            }
          }
        });
    } catch {
      /* 草稿损坏则忽略 */
    }
    // 仅在文件载入完成时检查一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, rel, loadState]);

  // 窗口重新获得焦点时检查外部修改（Word / Excel / 其他编辑器保存后回到 MarkFlow）
  useEffect(() => {
    if (!current || !rel || loadState !== "ok") return;
    const onFocus = () => {
      void api
        .statFileMtime(current.id, rel)
        .then((mtime) => {
          if (mtime === baseMtime || mtime === 0) return;
          if (!dirty) void reloadFromDisk();
          else setExternalChanged(true);
        })
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, rel, loadState, baseMtime, dirty]);
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
          onClick={() => void confirmDiscard().then((ok) => ok && closeFile())}
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
                onClick={() => void switchMode(key)}
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

      {externalChanged && (
        <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-700">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">该文件已被外部程序修改，而你有未保存的编辑。</span>
          <button type="button" onClick={() => void reloadFromDisk()} className="rounded border border-amber-300 px-2 py-0.5 hover:bg-amber-100">
            放弃我的修改，载入外部版本
          </button>
          <button type="button" onClick={() => setExternalChanged(false)} className="rounded px-2 py-0.5 text-amber-600 hover:bg-amber-100">
            保留我的修改
          </button>
        </div>
      )}

      {mode === "source" && risks.length > 0 && entry?.format === "markdown" && (
        <div className="border-b border-sky-100 bg-sky-50 px-4 py-1.5 text-[11px] text-sky-700">
          文档包含 {risks.join("、")}，可视化模式无法无损保留，已默认使用源码模式。
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
          <button
            type="button"
            onClick={() => current && void api.openPathInSystem(current.id, rel).catch((e) => dialog.alert(String(e)))}
            className="mt-4 h-8 rounded-lg border border-gray-200 px-3 text-[13px] text-gray-600 hover:bg-gray-50"
          >
            使用系统应用打开
          </button>
        </div>
      )}
      {loadState === "ok" && (
        <div className="min-h-0 flex-1">
          {mode === "visual" ? (
            <VisualEditor
              key={`v-${modeEpoch}`}
              initial={splitFrontMatter(editText).body}
              onChange={(md) => setEditText(splitFrontMatter(editText).front + md)}
              onPolish={() => void startPolish()}
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
          {loadState === "ok" && (
            <div className="flex h-6 shrink-0 items-center gap-3 border-t border-gray-200 bg-white px-4 text-[11px] text-gray-500">
              <span>{editText.replace(/\s/g, "").length.toLocaleString()} 个字符</span>
              <span>{(editText.match(/\n/g)?.length ?? 0) + 1} 行</span>
              <span className={encoding === "UTF-8" ? "" : "font-medium text-amber-600"} title="保存时按原编码写回，不会改变文件编码">
                编码 {encoding}
              </span>
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
