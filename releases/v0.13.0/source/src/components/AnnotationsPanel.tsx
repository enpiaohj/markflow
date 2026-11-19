import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ListChecks, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useDialog } from "./DialogContext";
import { useLibrary } from "./LibraryContext";
import * as api from "../lib/api";
import { formatTime } from "../lib/format";
import type { Annotation } from "../lib/types";

/**
 * 批注面板（设计文档 §8.8 子集）：
 * 引用编辑器选中文本添加批注；列表时检测引用是否仍可定位（内容变化后提示）。
 */
export default function AnnotationsPanel({
  currentPath,
  getSelection,
}: {
  currentPath: string;
  getSelection: () => string;
}) {
  const { current } = useLibrary();
  const dialog = useDialog();
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [quote, setQuote] = useState("");
  const [body, setBody] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!current) return;
    try {
      setAnnotations(await api.listAnnotations(current.id, currentPath));
    } catch {
      setAnnotations([]);
    } finally {
      setLoading(false);
    }
  }, [current, currentPath]);

  useEffect(() => {
    setLoading(true);
    setQuote("");
    setBody("");
    void load();
  }, [load]);

  function captureSelection() {
    const selected = getSelection().trim();
    if (selected) setQuote(selected);
    else void dialog.alert("请先在编辑器中选中要批注的文本");
  }

  async function submit() {
    if (!current || !quote.trim() || !body.trim()) return;
    setAdding(true);
    try {
      await api.addAnnotation(current.id, currentPath, quote, body);
      setBody("");
      await load();
    } catch (err) {
      await dialog.alert(`添加批注失败：${err}`, "添加失败");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* 添加批注 */}
      <div className="shrink-0 space-y-2 border-b border-gray-100 px-3 py-3">
        <p className="text-[11px] font-medium text-gray-400">新建批注</p>
        <button
          type="button"
          onClick={captureSelection}
          className="w-full rounded-lg bg-gray-50 px-2.5 py-1.5 text-left text-[11px] text-gray-600 hover:bg-gray-100"
        >
          {quote ? (
            <span className="line-clamp-2 italic">「{quote.slice(0, 60)}{quote.length > 60 ? "…" : ""}」</span>
          ) : (
            "① 在编辑器中选中文本，点此引用"
          )}
        </button>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          placeholder="② 输入批注意见…"
          className="w-full resize-y rounded-lg border border-gray-200 px-2.5 py-2 text-xs outline-none placeholder:text-gray-300 focus:border-primary-500"
        />
        <button
          type="button"
          disabled={!quote.trim() || !body.trim() || adding}
          onClick={() => void submit()}
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-primary-600 text-xs font-medium text-white hover:bg-primary-700 disabled:opacity-40"
        >
          {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          添加批注
        </button>
      </div>

      {/* 批注列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-gray-400">
          <ListChecks className="h-3 w-3" />
          批注列表（{annotations.length}）
        </p>
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-gray-300" />
        ) : annotations.length === 0 ? (
          <p className="text-xs text-gray-400">当前文件暂无批注</p>
        ) : (
          <ul className="space-y-2.5">
            {annotations.map((a) => (
              <li
                key={a.id}
                className={`rounded-lg border p-2.5 text-xs ${
                  a.resolved ? "border-gray-100 bg-gray-50 opacity-60" : "border-gray-200"
                }`}
              >
                <p className="italic leading-relaxed text-gray-500">
                  「{a.quote.slice(0, 80)}{a.quote.length > 80 ? "…" : ""}」
                </p>
                <p className={`mt-1.5 leading-relaxed ${a.resolved ? "text-gray-400" : "text-gray-800"}`}>{a.body}</p>
                <div className="mt-2 flex items-center gap-2 border-t border-gray-100 pt-1.5">
                  <span className="text-[10px] text-gray-300">{formatTime(a.createdAt)}</span>
                  {a.quotePresent === false && (
                    <span className="rounded bg-amber-50 px-1 py-0.5 text-[10px] text-amber-600" title="原文内容变化后引用无法重新定位">
                      位置已变
                    </span>
                  )}
                  <div className="ml-auto flex gap-1">
                    <button
                      type="button"
                      title={a.resolved ? "重新打开" : "标记已解决"}
                      onClick={async () => {
                        await api.setAnnotationResolved(a.id, !a.resolved);
                        await load();
                      }}
                      className="rounded p-1 text-gray-300 hover:bg-emerald-50 hover:text-emerald-600"
                    >
                      {a.resolved ? <RotateCcw className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
                    </button>
                    <button
                      type="button"
                      title="删除批注"
                      onClick={async () => {
                        await api.deleteAnnotation(a.id);
                        await load();
                      }}
                      className="rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
