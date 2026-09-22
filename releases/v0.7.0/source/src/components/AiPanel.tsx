import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  FileText,
  Loader2,
  Save,
  Send,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import { useDialog } from "./DialogContext";
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

interface ChatItem extends AiChatMessage {
  /** 助手回答的实际生成方（回退后如实标注） */
  meta?: { providerName: string; model: string; usedFallback: boolean };
}

/** 【来源 n】引用：可点击，跳转到对应文件 */
function SourceText({ text, onOpen }: { text: string; onOpen: (n: number) => void }) {
  const parts = text.split(/(【来源 \d+】)/g);
  return (
    <span className="whitespace-pre-wrap break-words">
      {parts.map((part, i) => {
        const m = /^【来源 (\d+)】$/.exec(part);
        return m ? (
          <button
            key={i}
            type="button"
            title="点击打开该来源文件"
            onClick={() => onOpen(Number(m[1]))}
            className="rounded bg-primary-50 px-1 font-medium text-primary-700 hover:bg-primary-100"
          >
            {part}
          </button>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </span>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * AI 助手面板（设计文档 §8.6）：
 * 上下文门禁（首次 / 范围变化时展示文件、Token、Provider 并确认；敏感命中必须放行）
 * → 流式对话（可取消、可回退到备用 Provider）→ 结果存为文档。
 */
export default function AiPanel({ currentPath }: { currentPath: string }) {
  const { current, openPath } = useLibrary();
  const dialog = useDialog();
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [providerId, setProviderId] = useState("");
  const [fallbackId, setFallbackId] = useState("");
  const [libraryFiles, setLibraryFiles] = useState<FileEntry[]>([]);
  const [fileFilter, setFileFilter] = useState("");
  const [contextPaths, setContextPaths] = useState<string[]>([currentPath]);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState("");
  const [sensitiveConfirm, setSensitiveConfirm] = useState<{ hits: SensitiveHit[]; pendingText: string } | null>(null);
  const [sendConfirm, setSendConfirm] = useState<{ preview: ContextPreview; pendingText: string } | null>(null);
  /** 已确认发送的范围指纹：范围 / Provider 不变时同一会话内不再重复询问 */
  const [confirmedKey, setConfirmedKey] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const provider = providers.find((p) => p.id === providerId);
  const fallback = providers.find((p) => p.id === fallbackId);
  const scopeKey = `${providerId}|${fallbackId}|${contextPaths.join("\n")}`;

  useEffect(() => {
    void api.aiListProviders().then((list) => {
      setProviders(list);
      if (list.length > 0 && !providerId) setProviderId(list[0].id);
    });
  }, []);

  useEffect(() => {
    if (!current) return;
    void api.listLibraryFiles(current.id, 20000).then(setLibraryFiles);
  }, [current]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText]);

  const filteredFiles = useMemo(() => {
    const q = fileFilter.trim().toLowerCase();
    const list = q ? libraryFiles.filter((f) => f.relativePath.toLowerCase().includes(q)) : libraryFiles;
    return list.slice(0, 300);
  }, [libraryFiles, fileFilter]);

  async function runChat(userText: string, allowSensitive: boolean, skipConfirm = false) {
    if (!current || !providerId) return;
    setError("");
    const history: ChatItem[] = [...messages, { role: "user", content: userText }];

    // 门禁第一步：上下文预览（范围 + Token 估算 + 敏感扫描），不发送
    let preview: ContextPreview;
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
    // 发送前确认：首次或范围 / Provider 变化时显示将发送的内容与去向
    if (!skipConfirm && confirmedKey !== scopeKey) {
      setSendConfirm({ preview, pendingText: userText });
      return;
    }

    setMessages(history.map((m) => ({ role: m.role, content: m.content, meta: m.meta })));
    setInput("");
    setStreaming(true);
    setStreamText("");
    let full = "";
    try {
      const outcome = await api.aiChat(
        {
          providerId,
          libraryId: current.id,
          contextPaths,
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          allowSensitive,
          fallbackProviderId: fallbackId || undefined,
        },
        (chunk) => {
          full += chunk;
          setStreamText(full);
        },
      );
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: full || "（空响应）",
          meta: { providerName: outcome.providerName, model: outcome.model, usedFallback: outcome.usedFallback },
        },
      ]);
      setStreamText("");
    } catch (err) {
      const message = String(err);
      if (message.startsWith("SENSITIVE::")) {
        const hits = JSON.parse(message.slice("SENSITIVE::".length)) as SensitiveHit[];
        setSensitiveConfirm({ hits, pendingText: userText });
      } else if (message.includes("已取消")) {
        // 保留已生成的部分内容
        if (full) setMessages((prev) => [...prev, { role: "assistant", content: `${full}\n\n（已取消生成）` }]);
        setStreamText("");
      } else {
        // 保留已收到的部分内容，避免用户看到的回答凭空消失
        if (full) setMessages((prev) => [...prev, { role: "assistant", content: `${full}\n\n（生成中断）` }]);
        setStreamText("");
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
    const name = await dialog.prompt({
      title: "保存为新文档",
      label: `文件名（保存到文档库「${current.name}」中当前文件所在目录）`,
      defaultValue: defaultName,
      validate: (v) => (v.trim() ? null : "文件名不能为空"),
    });
    if (!name) return;
    try {
      const parent = currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/")) : "";
      const finalName = /\.[A-Za-z0-9]+$/.test(name.trim()) ? name.trim() : `${name.trim()}.md`;
      await api.createTextFile(current.id, parent, finalName, answer);
      await dialog.alert(`已保存为 ${parent ? parent + "/" : ""}${finalName}`, "已保存");
    } catch (err) {
      await dialog.alert(`保存失败：${err}`, "保存失败");
    }
  }

  function openSource(n: number) {
    const rel = contextPaths[n - 1];
    if (!rel || !current) return;
    void openPath(`${current.rootPath.replace(/[\\/]+$/, "")}/${rel}`);
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
        {providers.length > 1 && (
          <select
            value={fallbackId}
            onChange={(e) => setFallbackId(e.target.value)}
            title="主 Provider 网络失败 / 超时 / 429 / 5xx 且尚无输出时，才会把同样内容发送到备用 Provider"
            className="mt-1.5 h-7 w-full rounded-lg border border-gray-200 bg-white px-2 text-[11px] text-gray-500 outline-none focus:border-primary-500"
          >
            <option value="">不使用备用 Provider</option>
            {providers
              .filter((p) => p.id !== providerId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  备用：{p.name} · {p.model}
                </option>
              ))}
          </select>
        )}

        {/* 上下文选择 */}
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowFilePicker((v) => !v)}
            className="flex w-full items-center justify-between rounded-lg bg-gray-50 px-2.5 py-1.5 text-left text-[11px] text-gray-500 hover:bg-gray-100"
          >
            <span className="flex items-center gap-1.5">
              <FileText className="h-3 w-3" />
              上下文（{contextPaths.length} 个文件，发送前会确认并扫描敏感信息）
            </span>
            <span className="text-gray-400">{showFilePicker ? "收起" : "管理"}</span>
          </button>
          {showFilePicker && (
            <div className="mt-1 rounded-lg border border-gray-200">
              <input
                value={fileFilter}
                onChange={(e) => setFileFilter(e.target.value)}
                placeholder="筛选文件…"
                className="h-7 w-full rounded-t-lg border-b border-gray-100 px-2.5 text-[11px] outline-none"
              />
              <div className="max-h-44 overflow-y-auto">
                {filteredFiles.map((f) => {
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
                {filteredFiles.length === 0 && <p className="px-2.5 py-2 text-[11px] text-gray-400">没有匹配的文件</p>}
                {libraryFiles.length > filteredFiles.length && !fileFilter && (
                  <p className="px-2.5 py-1.5 text-[10px] text-gray-400">仅显示前 300 个，请用上方筛选缩小范围</p>
                )}
              </div>
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
              AI 回答会标注可点击的【来源 n】引用。
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
                  <SourceText text={m.content} onOpen={openSource} />
                  <div className="mt-2 flex items-center gap-3 border-t border-gray-100 pt-1.5">
                    <button
                      type="button"
                      onClick={() => void saveAnswerAsDoc(m.content)}
                      className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-primary-600"
                    >
                      <Save className="h-3 w-3" />
                      存为文档
                    </button>
                    {m.meta && (
                      <span
                        className={`text-[10px] ${m.meta.usedFallback ? "font-medium text-amber-600" : "text-gray-300"}`}
                        title={m.meta.usedFallback ? "主 Provider 失败，本回答由备用 Provider 生成" : undefined}
                      >
                        {m.meta.usedFallback ? "备用 · " : ""}
                        {m.meta.providerName} · {m.meta.model}
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <span className="whitespace-pre-wrap break-words">{m.content}</span>
              )}
            </div>
          </div>
        ))}
        {streaming && (
          <div className="inline-block max-w-full rounded-xl bg-gray-50 px-3 py-2 text-left text-xs leading-relaxed text-gray-800 ring-1 ring-gray-100">
            {streamText ? <SourceText text={streamText} onOpen={openSource} /> : <span className="text-gray-400">正在连接…</span>}
            <Loader2 className="ml-1 inline h-3 w-3 animate-spin text-gray-300" />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 发送前确认：范围 / Token / 去向 */}
      {sendConfirm && provider && (
        <div className="shrink-0 border-t border-primary-100 bg-primary-50/60 px-3 py-2.5">
          <p className="text-[11px] font-medium text-primary-700">即将发送到 AI Provider，请确认：</p>
          <p className="mt-1 text-[11px] text-gray-600">
            去向：{provider.name} · {provider.model}（{hostOf(provider.baseUrl)}）
            {fallback ? `；失败时回退到 ${fallback.name}（${hostOf(fallback.baseUrl)}）` : ""}
          </p>
          {/^http:\/\//i.test(provider.baseUrl) && !/localhost|127\.0\.0\.1/.test(provider.baseUrl) && (
            <p className="mt-1 text-[11px] font-medium text-red-600">该地址使用明文 HTTP，内容与 API Key 可能被窃听。</p>
          )}
          <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto text-[10px] text-gray-500">
            {sendConfirm.preview.files.map((f, i) => (
              <li key={i} className="truncate">
                【来源 {i + 1}】{f.relativePath} ·{" "}
                {f.skipped ? <span className="text-amber-600">未包含：{f.skipped}</span> : `${f.chars.toLocaleString()} 字符${f.truncated ? "（已截断）" : ""}`}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[10px] text-gray-500">
            合计约 {sendConfirm.preview.totalChars.toLocaleString()} 字符 / {sendConfirm.preview.estimatedTokens.toLocaleString()} Token（估算）。敏感信息扫描：未发现。
          </p>
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setSendConfirm(null)}
              className="h-6.5 rounded-md border border-gray-200 bg-white px-2 text-[11px] text-gray-600 hover:bg-gray-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => {
                const text = sendConfirm.pendingText;
                setConfirmedKey(scopeKey);
                setSendConfirm(null);
                void runChat(text, false, true);
              }}
              className="h-6.5 rounded-md bg-primary-600 px-2 text-[11px] font-medium text-white hover:bg-primary-700"
            >
              确认发送
            </button>
          </div>
        </div>
      )}

      {/* 敏感信息放行确认 */}
      {sensitiveConfirm && (
        <div className="shrink-0 border-t border-amber-200 bg-amber-50 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber-700">
            <ShieldAlert className="h-3.5 w-3.5" />
            上下文中发现 {sensitiveConfirm.hits.length} 处疑似敏感信息：
          </p>
          <ul className="mt-1 max-h-20 space-y-0.5 overflow-y-auto text-[10px] text-amber-600">
            {sensitiveConfirm.hits.slice(0, 8).map((h, i) => (
              <li key={i} className="truncate">
                {h.file || "（输入内容）"} · 第 {h.line} 行 · {h.label} · {h.masked}
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
                setConfirmedKey(scopeKey);
                void runChat(text, true, true);
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
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="基于所选上下文提问…（Enter 发送，Shift + Enter 换行）"
            className="max-h-28 min-h-[38px] flex-1 resize-y rounded-lg border border-gray-200 px-2.5 py-2 text-xs outline-none placeholder:text-gray-300 focus:border-primary-500"
          />
          {streaming ? (
            <button
              type="button"
              onClick={() => void api.aiCancel()}
              title="停止生成"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-700 text-white hover:bg-gray-800"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!input.trim()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-40"
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
