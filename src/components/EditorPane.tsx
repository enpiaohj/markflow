import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "tiptap-markdown";
import {
  ArrowLeft,
  ExternalLink,
  FolderOpen,
  Terminal,
  ListChecks,
  Bold,
  Check,
  ChevronDown,
  Code2,
  Eye,
  FileCode,
  History,
  ImagePlus,
  Italic,
  Link2,
  Minus,
  Strikethrough,
  Code,
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
import { useEditorStatus } from "./EditorStatusContext";
import { LocalImage, makeImageResolver } from "./editor/LocalImage";
import { open as openImageDialog } from "@tauri-apps/plugin-dialog";
import { countText } from "../lib/wordCount";
import * as api from "../lib/api";
import { getAutosave, getEditorWrap, getLargeFileMb, getMaxEditMb } from "../lib/prefs";
import CodeEditor, { type CodeEditorApi, type CodeIssue } from "./editor/CodeEditor";
import ProblemsPanel from "./editor/ProblemsPanel";
import { LANGUAGES, detectIndent, detectLanguage, languageById } from "../lib/codeLanguages";
import type { CheckIssue } from "../lib/types";
import { EDITABLE_FORMATS, formatSize, formatTime } from "../lib/format";
import type { FileEntry, VersionInfo } from "../lib/types";

type SaveState = "saved" | "dirty" | "saving" | "error";

/** 拆出 Front Matter：可视化编辑器不理解它，编辑正文时原样保护、保存时拼回。 */
function splitFrontMatter(text: string): { front: string; body: string } {
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? { front: m[0], body: text.slice(m[0].length) } : { front: "", body: text };
}

/** 同一个列表里既有 `- [ ]` 任务项又有普通项：可视化模式会拆成两个列表并多出一个空任务项。 */
function hasMixedTaskList(body: string): boolean {
  let hasTask = false;
  let hasPlain = false;
  const flush = () => hasTask && hasPlain;
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*[-*+]\s+(\[[ xX]\]\s)?/.exec(line);
    if (m) {
      if (m[1]) hasTask = true;
      else hasPlain = true;
    } else if (line.trim() !== "" && !/^\s+\S/.test(line)) {
      // 遇到非列表、非缩进的正文：一个列表块结束
      if (flush()) return true;
      hasTask = false;
      hasPlain = false;
    }
  }
  return flush();
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
  if (hasMixedTaskList(noCode)) risks.push("任务项与普通项混排的列表");
  return risks;
}

/** 草稿键：崩溃 / 断电后的恢复依据（存于 WebView 本地存储，不写入文档库）。 */
const draftKey = (libraryId: string, rel: string) => `mf-draft:${libraryId}:${rel}`;

// ---------------------------------------------------------------------------
// 可视化编辑器（Tiptap / ProseMirror，Markdown 为持久化真源）
// ---------------------------------------------------------------------------

function VisualEditor({
  initial,
  libraryId,
  docPath,
  readOnly,
  onChange,
  onPolish,
  registerSelection,
}: {
  initial: string;
  libraryId: string;
  docPath: string;
  readOnly: boolean;
  onChange: (md: string) => void;
  onPolish: () => void;
  registerSelection: (fn: () => string) => void;
}) {
  const { config: zoomConfig } = useZoom();
  const dialog = useDialog();
  const docDir = docPath.includes("/") ? docPath.slice(0, docPath.lastIndexOf("/")) : "";
  const docDirRef = useRef(docDir);
  docDirRef.current = docDir;
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);

  /** 把图片文件保存到文档旁的 assets/ 并插入编辑器（相对路径写进 Markdown） */
  async function insertImageFromBytes(bytes: ArrayBuffer, stem: string, ext: string) {
    try {
      const rel = await api.saveImageBytes(libraryId, docDirRef.current, stem, ext, bytes);
      editorRef.current?.chain().focus().setImage({ src: rel, alt: stem }).run();
    } catch (err) {
      await dialog.alert(`插入图片失败：${err}`, "插入失败");
    }
  }

  async function pickImage() {
    const picked = await openImageDialog({
      multiple: false,
      title: "插入图片",
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"] }],
    });
    if (!picked || Array.isArray(picked)) return;
    try {
      const rel = await api.importImageAsset(libraryId, docDirRef.current, picked);
      const stem = rel.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
      editorRef.current?.chain().focus().setImage({ src: rel, alt: stem }).run();
    } catch (err) {
      await dialog.alert(`插入图片失败：${err}`, "插入失败");
    }
  }
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
    // 工具栏要随光标所在位置更新（标题级别 / 表格操作 / 高亮状态）
    shouldRerenderOnTransaction: true,
    editable: !readOnly,
    editorProps: {
      // Ctrl+K：插入 / 编辑链接（全局搜索改用 Ctrl+Shift+F，见 App.tsx）
      handleKeyDown: (_view, event) => {
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "k") {
          event.preventDefault();
          if (editorRef.current) void onLink(editorRef.current);
          return true;
        }
        return false;
      },
      // 粘贴图片（如截图）：保存到 assets/ 并插入
      handlePaste: (_view, event) => {
        const item = [...(event.clipboardData?.items ?? [])].find((i) => i.kind === "file" && i.type.startsWith("image/"));
        const file = item?.getAsFile();
        if (!file) return false;
        event.preventDefault();
        const ext = file.type.split("/")[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg") || "png";
        void file.arrayBuffer().then((buf) => insertImageFromBytes(buf, `image-${Date.now()}`, ext));
        return true;
      },
    },
    extensions: [
      StarterKit,
      LocalImage.configure({ inline: true, resolve: makeImageResolver(libraryId, docDir, (id, path) => api.readFileBytes(id, path)) }),
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

  editorRef.current = editor;

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
        <button type="button" className={btn(editor.isActive("strike"))} title="删除线"
          onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough className="h-3.5 w-3.5" /></button>
        <button type="button" className={btn(editor.isActive("code"))} title="行内代码"
          onClick={() => editor.chain().focus().toggleCode().run()}><Code className="h-3.5 w-3.5" /></button>
        <span className="mx-1 h-4 w-px bg-gray-200" />
        <select
          aria-label="段落样式"
          title="段落样式（标题 1–6 / 正文）"
          value={([1, 2, 3, 4, 5, 6] as const).find((l) => editor.isActive("heading", { level: l })) ?? 0}
          onChange={(e) => {
            const level = Number(e.target.value) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
            if (level === 0) editor.chain().focus().setParagraph().run();
            else editor.chain().focus().setHeading({ level }).run();
          }}
          className="h-7 rounded-md border border-gray-200 bg-white px-1.5 text-[12px] text-gray-600 outline-none hover:bg-gray-50"
        >
          <option value={0}>正文</option>
          {[1, 2, 3, 4, 5, 6].map((l) => (
            <option key={l} value={l}>标题 {l}</option>
          ))}
        </select>
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
        <button type="button" className={btn(editor.isActive("link"))} title="插入 / 编辑链接（Ctrl+K）"
          onClick={() => void onLink(editor)}>
          <Link2 className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={btn(false)} title="插入图片（也可直接粘贴截图；保存到文档旁的 assets/）"
          onClick={() => void pickImage()}>
          <ImagePlus className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={btn(false)} title="分割线"
          onClick={() => editor.chain().focus().setTextSelection(editor.state.selection.to).setHorizontalRule().run()}>
          <Minus className="h-3.5 w-3.5" />
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

      {/* 表格操作：光标在表格内时出现 */}
      {editor.isActive("table") && (
        <div className="flex flex-wrap items-center gap-1 border-b border-gray-200 bg-primary-50/40 px-4 py-1 text-[12px] text-gray-600">
          <span className="mr-1 text-gray-400">表格</span>
          {[
            ["上方加行", () => editor.chain().focus().addRowBefore().run()],
            ["下方加行", () => editor.chain().focus().addRowAfter().run()],
            ["左侧加列", () => editor.chain().focus().addColumnBefore().run()],
            ["右侧加列", () => editor.chain().focus().addColumnAfter().run()],
            ["删除行", () => editor.chain().focus().deleteRow().run()],
            ["删除列", () => editor.chain().focus().deleteColumn().run()],
          ].map(([label, run]) => (
            <button key={label as string} type="button" onClick={run as () => void}
              className="rounded-md border border-gray-200 bg-white px-2 py-0.5 hover:bg-gray-50">
              {label as string}
            </button>
          ))}
          <button type="button" onClick={() => editor.chain().focus().deleteTable().run()}
            className="rounded-md border border-red-100 bg-white px-2 py-0.5 text-red-600 hover:bg-red-50">
            删除表格
          </button>
        </div>
      )}

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
// 编辑器主面板
// ---------------------------------------------------------------------------

export default function EditorPane() {
  const { current, openFile, closeFile, setEditorDirty, confirmDiscard, tabActive } = useLibrary();
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
  const [sidePanel, setSidePanel] = useState<"ai" | "notes" | "problems" | null>(null);
  // 代码编辑：文件属性、语言、缩进、显式转换、诊断
  const [fileMeta, setFileMeta] = useState({ size: 0, readOnly: false, crlf: false });
  const [firstLine, setFirstLine] = useState("");
  const [langOverride, setLangOverride] = useState<string | null>(null);
  const [indent, setIndent] = useState<{ kind: "tab" | "space"; width: number }>({ kind: "space", width: 4 });
  const [encodingOverride, setEncodingOverride] = useState<string | null>(null);
  const [eolOverride, setEolOverride] = useState<"crlf" | "lf" | null>(null);
  const [codeIssues, setCodeIssues] = useState<CodeIssue[]>([]);
  const [limits, setLimits] = useState({ large: getLargeFileMb(), max: getMaxEditMb() });
  const [showExternal, setShowExternal] = useState(false);
  const [vscodeOk, setVscodeOk] = useState<boolean | null>(null);
  const editorApiRef = useRef<CodeEditorApi | null>(null);
  const selectionFnRef = useRef<(() => string) | null>(null);
  const [issues, setIssues] = useState<CheckIssue[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [diff, setDiff] = useState<{ original: string; polished: string; loading: boolean } | null>(null);
  const [aiProviderId, setAiProviderId] = useState<string | null>(null);
  const [aiProviderLabel, setAiProviderLabel] = useState("");
  const [autosave, setAutosaveOn] = useState(getAutosave());
  const [wrap, setWrapOn] = useState(getEditorWrap());
  const [cursor, setCursor] = useState<{ line: number; col: number } | null>(null);
  const { publish: publishStatus } = useEditorStatus();

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
    const onPrefs = () => {
      setAutosaveOn(getAutosave());
      setWrapOn(getEditorWrap());
      setLimits({ large: getLargeFileMb(), max: getMaxEditMb() });
    };
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
          setLoadError(`无法在编辑器中打开「${detail.formatLabel}」文件，请返回文档库双击该文件，以正确方式打开。`);
          return;
        }
        return api.readTextFile(current.id, openFile.relativePath, getMaxEditMb() * 1024 * 1024).then((file) => {
          setSavedText(file.content);
          setEditText(file.content);
          setBaseMtime(file.baseMtime);
          setEncoding(file.encoding);
          applyFileMeta(file);
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

  /** 读到文件后记录属性（大小 / 只读 / 换行符），并重置语言覆盖、缩进推断与显式转换。 */
  function applyFileMeta(file: { content: string; size: number; readOnly: boolean; crlf: boolean }) {
    setFileMeta({ size: file.size, readOnly: file.readOnly, crlf: file.crlf });
    setFirstLine(file.content.split("\n", 1)[0]);
    setIndent(detectIndent(file.content));
    setLangOverride(null);
    setEncodingOverride(null);
    setEolOverride(null);
    setCodeIssues([]);
  }

  const doSave = useCallback(
    async (force: boolean) => {
      if (!current || !openFile) return;
      if (fileMeta.readOnly) {
        setSaveError("文件带有只读属性，无法保存。请在系统中取消只读，或用外部工具编辑。");
        setSaveState("error");
        return;
      }
      setSaveState("saving");
      setSaveError("");
      try {
        const out = await api.saveTextFile(current.id, rel, editText, baseMtime, force, {
          encoding: encodingOverride,
          eol: eolOverride,
        });
        // 显式转换已生效：磁盘编码 / 换行符随之改变
        if (encodingOverride) setEncoding(encodingOverride);
        if (eolOverride) setFileMeta((m) => ({ ...m, crlf: eolOverride === "crlf" }));
        setEncodingOverride(null);
        setEolOverride(null);
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
    [current, openFile, rel, editText, baseMtime, fileMeta.readOnly, encodingOverride, eolOverride],
  );

  // Ctrl+S 保存
  useEffect(() => {
    // 多个文档标签同时挂载：只有激活的标签响应保存
    const onKey = (e: KeyboardEvent) => {
      if (!tabActive) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) void doSave(false);
      }
    };
    const onMenuSave = () => {
      if (tabActive && dirty) void doSave(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(MENU_SAVE_EVENT, onMenuSave);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(MENU_SAVE_EVENT, onMenuSave);
    };
  }, [saveState, doSave, tabActive]);

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
      const file = await api.readTextFile(current.id, rel, getMaxEditMb() * 1024 * 1024);
      setSavedText(file.content);
      setEditText(file.content);
      setBaseMtime(file.baseMtime);
      setEncoding(file.encoding);
      applyFileMeta(file);
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
          confirmText: "仍要发送",
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

  // 向全局上报未保存状态（活动栏切换时用于离开确认）
  const dirty = editText !== savedText || encodingOverride !== null || eolOverride !== null;
  const language = useMemo(() => (langOverride ? languageById(langOverride) : detectLanguage(rel, firstLine)), [langOverride, rel, firstLine]);
  const largeMode = fileMeta.size > limits.large * 1024 * 1024;
  const errorCount = codeIssues.filter((i) => i.severity === "error").length;
  const warningCount = codeIssues.length - errorCount;

  async function pickLanguage() {
    const id = await dialog.pick({
      title: "选择语言",
      message: "仅影响语法高亮与诊断，不修改文件。",
      items: LANGUAGES.map((l) => ({ value: l.id, label: l.label })),
      defaultValue: language.id,
    });
    if (id) setLangOverride(id);
  }

  async function pickEncoding() {
    const target = await dialog.pick({
      title: "保存编码",
      message: `磁盘当前编码：${encoding}。默认保存时保持原编码；选择其他编码后，下次保存才会转换（含目标编码无法表示的字符时会中止保存，不会损坏文件）。`,
      items: [
        { value: "__keep", label: `保持原编码（${encoding}）` },
        ...["UTF-8", "UTF-8 BOM", "GBK", "UTF-16 LE", "UTF-16 BE"].filter((e) => e !== encoding).map((e) => ({ value: e, label: `转换为 ${e}` })),
      ],
      defaultValue: encodingOverride ?? "__keep",
      confirmText: "确定",
    });
    if (target) setEncodingOverride(target === "__keep" ? null : target);
  }

  async function pickEol() {
    const cur = fileMeta.crlf ? "CRLF" : "LF";
    const target = await dialog.pick({
      title: "保存换行符",
      message: `磁盘当前换行符：${cur}。默认保存时保持原样；选择转换后，下次保存才会统一改写全文换行符。`,
      items: [
        { value: "__keep", label: `保持原样（${cur}）` },
        ...(fileMeta.crlf ? [{ value: "lf", label: "转换为 LF" }] : [{ value: "crlf", label: "转换为 CRLF" }]),
      ],
      defaultValue: eolOverride ?? "__keep",
      confirmText: "确定",
    });
    if (target) setEolOverride(target === "__keep" ? null : (target as "crlf" | "lf"));
  }

  async function openExternal(tool: api.ExternalTool) {
    setShowExternal(false);
    if (!current) return;
    try {
      if (tool === "vscode-file" || tool === "vscode-folder") {
        if (!(await api.vscodeAvailable())) {
          await dialog.alert("未检测到 VS Code。请先安装 VS Code，或改用「系统默认程序」。", "无法打开");
          return;
        }
      }
      await api.openWithExternal(current.id, rel, tool);
    } catch (err) {
      await dialog.alert(String(err), "无法打开");
    }
  }

  // 字数（Front Matter 不计）、光标位置与代码编辑信息发布到状态栏；仅激活的标签发布，离开时清除
  useEffect(() => {
    if (!tabActive || loadState !== "ok") return;
    const c = countText(splitFrontMatter(editText).body);
    publishStatus({
      total: c.total,
      chars: c.chars,
      ...(mode === "source" && cursor ? { line: cursor.line, col: cursor.col } : {}),
      code: {
        language: language.label,
        encoding,
        pendingEncoding: encodingOverride,
        eol: fileMeta.crlf ? "CRLF" : "LF",
        pendingEol: eolOverride ? (eolOverride === "crlf" ? "CRLF" : "LF") : null,
        indent: indent.kind === "tab" ? "制表符" : `空格 ${indent.width}`,
        readOnly: fileMeta.readOnly,
        largeMode,
        saveState: saveState === "saving" ? "saving" : saveState === "error" ? "error" : dirty ? "dirty" : "saved",
        errors: errorCount,
        warnings: warningCount,
        onPickLanguage: () => void pickLanguage(),
        onPickEncoding: () => void pickEncoding(),
        onPickEol: () => void pickEol(),
        onShowProblems: () => setSidePanel("problems"),
      },
    });
    return () => publishStatus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabActive, loadState, editText, mode, cursor, publishStatus, language, encoding, encodingOverride, eolOverride, fileMeta, indent, largeMode, saveState, dirty, errorCount, warningCount]);

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
    const onDiscard = (e: Event) => {
      const d = (e as CustomEvent<{ libraryId: string; relativePath: string } | undefined>).detail;
      if (d && (d.libraryId !== current.id || d.relativePath !== rel)) return;
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
      <div className="flex h-11 shrink-0 items-center gap-2 whitespace-nowrap border-b border-gray-200 bg-white px-3">
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
          {language.validator && (
            <button
              type="button"
              onClick={() => setSidePanel((v) => (v === "problems" ? null : "problems"))}
              title="问题面板：语法诊断"
              className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors ${
                sidePanel === "problems"
                  ? "border-primary-200 bg-primary-50 text-primary-700"
                  : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              <ListChecks className="h-3.5 w-3.5" />
              问题
              {codeIssues.length > 0 && (
                <span className={`rounded px-1 text-[10px] ${errorCount > 0 ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-600"}`}>{codeIssues.length}</span>
              )}
            </button>
          )}

          {/* 外部工具：VS Code / 系统默认程序 / PowerShell / CMD / 资源管理器 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setShowExternal((v) => !v);
                if (vscodeOk === null) void api.vscodeAvailable().then(setVscodeOk).catch(() => setVscodeOk(false));
              }}
              title="用外部工具打开"
              className="flex h-8 items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              打开方式
              <ChevronDown className="h-3 w-3" />
            </button>
            {showExternal && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowExternal(false)} />
                <div className="absolute right-0 top-9 z-50 w-64 rounded-xl border border-gray-200 bg-white py-1.5 text-[13px] shadow-xl">
                  {(
                    [
                      ["vscode-file", "用 VS Code 打开文件", ExternalLink, vscodeOk === false],
                      ["vscode-folder", "用 VS Code 打开所在目录", FolderOpen, vscodeOk === false],
                    ] as const
                  ).map(([tool, label, Icon, disabled]) => (
                    <button key={tool} type="button" disabled={disabled} onClick={() => void openExternal(tool)}
                      title={disabled ? "未检测到 VS Code" : undefined}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-50 disabled:text-gray-300 disabled:hover:bg-transparent">
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </button>
                  ))}
                  <div className="my-1 h-px bg-gray-100" />
                  <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-50"
                    onClick={() => {
                      setShowExternal(false);
                      if (current) void api.openPathInSystem(current.id, rel).catch((e) => dialog.alert(String(e), "无法打开"));
                    }}>
                    <ExternalLink className="h-3.5 w-3.5" />
                    用系统默认程序打开
                  </button>
                  <button type="button" onClick={() => void openExternal("powershell")}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-50">
                    <Terminal className="h-3.5 w-3.5" />
                    在 PowerShell 中打开所在目录
                  </button>
                  <button type="button" onClick={() => void openExternal("cmd")}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-50">
                    <Terminal className="h-3.5 w-3.5" />
                    在 CMD 中打开所在目录
                  </button>
                  <button type="button" onClick={() => void openExternal("explorer")}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-50">
                    <FolderOpen className="h-3.5 w-3.5" />
                    在资源管理器中显示
                  </button>
                </div>
              </>
            )}
          </div>

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

      {fileMeta.readOnly && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-700">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          此文件带有只读属性：可以查看和复制，但无法保存。请在系统中取消只读后重新打开，或用「打开方式」交给外部工具。
        </div>
      )}

      {largeMode && (
        <div className="border-b border-sky-100 bg-sky-50 px-4 py-1.5 text-[11px] text-sky-700">
          文件较大（{(fileMeta.size / 1024 / 1024).toFixed(1)} MB）：已进入保护模式——关闭语法高亮、折叠和诊断以保证输入流畅，仍可正常编辑与保存。
          可在「设置 → 编辑器」调整阈值。
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
              libraryId={current.id}
              docPath={rel}
              readOnly={fileMeta.readOnly}
              initial={splitFrontMatter(editText).body}
              onChange={(md) => setEditText(splitFrontMatter(editText).front + md)}
              onPolish={() => void startPolish()}
              registerSelection={(fn) => (selectionFnRef.current = fn)}
            />
          ) : (
            <CodeEditor
              key={`s-${modeEpoch}`}
              initial={editText}
              language={language}
              wrap={wrap}
              readOnly={fileMeta.readOnly}
              largeMode={largeMode}
              indent={indent}
              onCursor={(line, col) => setCursor({ line, col })}
              onChange={setEditText}
              onIssues={setCodeIssues}
              registerSelection={(fn) => (selectionFnRef.current = fn)}
              registerApi={(api2) => (editorApiRef.current = api2)}
            />
          )}
        </div>
      )}
        </div>
        {sidePanel && (
          <aside className="w-96 shrink-0 border-l border-gray-200">
            {sidePanel === "ai" ? (
              <AiPanel currentPath={rel} />
            ) : sidePanel === "problems" ? (
              <ProblemsPanel
                issues={codeIssues}
                supported={!!language.validator}
                onGoto={(offset) => {
                  if (mode !== "source") void switchMode("source").then(() => setTimeout(() => editorApiRef.current?.gotoOffset(offset), 150));
                  else editorApiRef.current?.gotoOffset(offset);
                }}
              />
            ) : (
              <AnnotationsPanel currentPath={rel} getSelection={() => selectionFnRef.current?.() ?? ""} />
            )}
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
