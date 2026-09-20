import { useEffect, useRef, useState } from "react";
import {
  Bot,
  FileText,
  Loader2,
  Save,
  Send,
  ShieldAlert,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useLibrary } from "./LibraryContext";
import * as api from "../lib/api";
import { formatSize } from "../lib/format";
import type {
  AiChatMessage,
  ContextPreview,
  FileEntry,
  ProviderConfig,
  SensitiveHit,
} from "../lib/types";

/** 【来源 n】引用高亮 */
function SourceText({ text }: { text: string }) {
  const parts = text.split(/(【来源 \d+】)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^【来源 \d+】$/.test(part) ? (
          <span key={i} className="rounded bg-primary-50 px-1 font-medium text-primary-700">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

/**
 * AI 助手面板（设计文档 §8.6，概念图「多文件 AI 综合分析」「Markdown 编辑器·AI助手」）：
 * 上下文门禁（prepare → 范围/Token/敏感扫描展示 → 确认放行）→ 流式对话 → 结果存为文档。
 */
export default function AiPanel({ currentPath }: { currentPath: string }) {
  const { current } = useLibrary();
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [providerId, setProviderId] = useState("");
  const [libraryFiles, setLibraryFiles] = useState<FileEntry[]>([]);
  const [contextPaths, setContextPaths] = useState<string[]>([currentPath]);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState("");
  const [sensitiveConfirm, setSensitiveConfirm] = useState<{
    hits: SensitiveHit[];
    pendingText: string;
  } | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void api.aiListProviders().then((list) => {
      setProviders(list);
      if (list.length > 0 && !providerId) setProviderId(list[0].id);
    });
  }, []);

  useEffect(() => {
    if (!current) return;
    void api.listLibraryFiles(current.id, 500).then(setLibraryFiles);
  }, [current]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText]);

  async function runChat(userText: string, allowSensitive: boolean) {
    if (!current || !providerId) return;
    setError("");
    const history: AiChatMessage[] = [...messages, { role: "user", content: userText }];

    // 门禁第一步：上下文预览（范围 + Token 估算 + 敏感扫描），不发送
    let preview: ContextPreview | null = null;
    try {
      preview = await api.aiPrepareContext(current.id, contextPaths);
    } catch (err) {
      setError(String(err));
      return;
    }
    if (preview.sensitiveHits.length > 0 && !allowSensitive) {
      setSensitiveConfirm({ hits: preview.sensitiveHits, pendingText: userText });
      return;
    }

    setMessages(history);
    setInput("");
    setStreaming(true);
    setStreamText("");
    try {
      const outcome = await api.aiChat(
        {
          providerId,
          libraryId: current.id,
          contextPaths,
          messages: history,
          allowSensitive,
        },
        (chunk) => setStreamText((prev) => prev + chunk),
      );
      setStreamText((full) => {
        setMessages((prev) => [...prev, { role: "assistant", content: full || "（空响应）" }]);
        return "";
      });
      void outcome;
    } catch (err) {
      const message = String(err);
      if (message.startsWith("SENSITIVE::")) {
        const hits = JSON.parse(message.slice("SENSITIVE::".length)) as SensitiveHit[];
        setSensitiveConfirm({ hits, pendingText: userText });
      } else {
        setError(message);
      }
    } finally {
      setStreaming(false);
    }
  }

  function send() {
    const text = input.trim();
    if (!text || streaming) return;
    void runChat(text, false);
  }

  async function saveAnswerAsDoc(answer: string) {
    if (!current) return;
    const defaultName = `AI-回答-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "")}.md`;
    const name = prompt("保存为新文档（文件名）：", defaultName);
    if (!name) return;
    try {
      const parent = currentPath.includes("/")
        ? currentPath.slice(0, currentPath.lastIndexOf("/"))
        : "";
      await api.createTextFile(current.id, parent, name, answer);
      alert(`已保存为 ${parent ? parent + "/" : ""}${name}`);
    } catch (err) {
      alert(`保存失败：${err}`);
    }
  }

  if (!current) return null;

  if (providers.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-5 text-center">
        <Bot className="h-8 w-8 text-gray-300" />
        <p className="mt-3 text-sm text-gray-500">尚未配置 AI Provider</p>
        <p className="mt-1 text-xs leading-relaxed text-gray-400">
          在「设置 → AI」中添加 OpenAI 兼容 Provider
          （如 DeepSeek、通义、OpenAI）。API Key 保存在系统凭据库，不会写入文档库。
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* Provider 选择 */}
      <div className="shrink-0 border-b border-gray-100 px-3 py-2.5">
        <select
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
          className="h-8 w-full rounded-lg border border-gray-200 bg-white px-2 text-xs text-gray-700 outline-none focus:border-primary-500"
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.model}
            </option>
          ))}
        </select>

        {/* 上下文选择 */}
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowFilePicker((v) => !v)}
            className="flex w-full items-center justify-between rounded-lg bg-gray-50 px-2.5 py-1.5 text-left text-[11px] text-gray-500 hover:bg-gray-100"
          >
            <span className="flex items-center gap-1.5">
              <FileText className="h-3 w-3" />
              上下文（{contextPaths.length} 个文件，发送前会扫描敏感信息）
            </span>
            <span className="text-gray-400">{showFilePicker ? "收起" : "管理"}</span>
          </button>
          {showFilePicker && (
            <div className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-gray-200">
              {libraryFiles.map((f) => {
                const checked = contextPaths.includes(f.relativePath);
                return (
                  <label
                    key={f.relativePath}
                    className="flex cursor-pointer items-center gap-2 px-2.5 py-1 text-[11px] text-gray-600 hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setContextPaths((prev) =>
                          checked ? prev.filter((p) => p !== f.relativePath) : [...prev, f.relativePath],
                        )
                      }
                      className="accent-primary-600"
                    />
                    <span className="truncate">{f.relativePath}</span>
                    <span className="ml-auto shrink-0 text-gray-300">{formatSize(f.size)}</span>
                  </label>
                );
              })}
            </div>
          )}
          {contextPaths
            .filter((p) => p !== currentPath)
            .map((p) => (
              <p key={p} className="mt-1 flex items-center gap-1 truncate text-[10px] text-gray-400">
                <FileText className="h-2.5 w-2.5" />
                {p}
                <button
                  type="button"
                  onClick={() => setContextPaths((prev) => prev.filter((x) => x !== p))}
                  className="ml-auto text-gray-300 hover:text-red-400"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </p>
            ))}
        </div>
      </div>

      {/* 消息区 */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && !streaming && (
          <div className="mt-6 text-center">
            <Sparkles className="mx-auto h-6 w-6 text-gray-200" />
            <p className="mt-2 text-xs leading-relaxed text-gray-400">
              基于当前文档与所选上下文提问。
              <br />
              AI 回答会标注【来源 n】引用。
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <div
              className={`inline-block max-w-full rounded-xl px-3 py-2 text-left text-xs leading-relaxed ${
                m.role === "user"
                  ? "bg-primary-600 text-white"
                  : "bg-gray-50 text-gray-800 ring-1 ring-gray-100"
              }`}
            >
              {m.role === "assistant" ? (
                <>
                  <SourceText text={m.content} />
                  <div className="mt-2 border-t border-gray-100 pt-1.5">
                    <button
                      type="button"
                      onClick={() => void saveAnswerAsDoc(m.content)}
                      className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-primary-600"
                    >
                      <Save className="h-3 w-3" />
                      存为文档
                    </button>
                  </div>
                </>
              ) : (
                m.content
              )}
            </div>
          </div>
        ))}
        {streamText && (
          <div className="inline-block max-w-full rounded-xl bg-gray-50 px-3 py-2 text-left text-xs leading-relaxed text-gray-800 ring-1 ring-gray-100">
            <SourceText text={streamText} />
            <Loader2 className="ml-1 inline h-3 w-3 animate-spin text-gray-300" />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 敏感信息放行确认 */}
      {sensitiveConfirm && (
        <div className="shrink-0 border-t border-amber-200 bg-amber-50 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber-700">
            <ShieldAlert className="h-3.5 w-3.5" />
            上下文中发现 {sensitiveConfirm.hits.length} 处疑似敏感信息：
          </p>
          <ul className="mt-1 max-h-20 space-y-0.5 overflow-y-auto text-[10px] text-amber-600">
            {sensitiveConfirm.hits.slice(0, 5).map((h, i) => (
              <li key={i}>
                第 {h.line} 行 · {h.label} · {h.masked}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[10px] text-amber-600">确认后将连同这些内容一起发送给 Provider。</p>
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setSensitiveConfirm(null)}
              className="h-6.5 rounded-md border border-amber-300 px-2 text-[11px] text-amber-700 hover:bg-amber-100"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => {
                const text = sensitiveConfirm.pendingText;
                setSensitiveConfirm(null);
                void runChat(text, true);
              }}
              className="h-6.5 rounded-md bg-amber-500 px-2 text-[11px] font-medium text-white hover:bg-amber-600"
            >
              知情并继续发送
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="shrink-0 break-all border-t border-red-100 bg-red-50 px-3 py-1.5 text-[11px] text-red-600">
          {error}
        </p>
      )}

      {/* 输入区 */}
      <div className="shrink-0 border-t border-gray-100 p-2.5">
        <div className="flex items-end gap-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="基于所选上下文提问…（Enter 发送）"
            className="max-h-28 min-h-[38px] flex-1 resize-y rounded-lg border border-gray-200 px-2.5 py-2 text-xs outline-none placeholder:text-gray-300 focus:border-primary-500"
          />
          <button
            type="button"
            onClick={send}
            disabled={streaming || !input.trim()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-40"
          >
            {streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
