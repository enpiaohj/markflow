import { useMemo } from "react";
import { diffLines } from "diff";
import { Check, Loader2, TriangleAlert, X } from "lucide-react";

/**
 * AI 差异审阅对话框（设计文档 §8.7）：
 * 行级差异预览 → 用户选择「应用」或「放弃」；应用后由保存闭环自动创建快照。
 */
export default function DiffDialog({
  title,
  original,
  modified,
  loading,
  onApply,
  onCancel,
}: {
  title: string;
  original: string;
  modified: string;
  loading: boolean;
  onApply: (polished: string) => void;
  onCancel: () => void;
}) {
  const diff = useMemo(() => (loading ? null : diffLines(original, modified)), [original, modified, loading]);
  const changed = useMemo(
    () => diff?.some((part) => part.added || part.removed) ?? false,
    [diff],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="flex h-[80vh] w-[860px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-5 py-3">
          <div>
            <h3 className="text-[15px] font-semibold text-gray-900">{title}</h3>
            <p className="mt-0.5 text-xs text-gray-400">
              差异审阅 · 应用后保存时会自动创建当前内容的快照，可随时恢复
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-gray-50 px-5 py-4 font-mono text-xs leading-6">
          {loading ? (
            <div className="flex h-full items-center justify-center text-gray-400">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="ml-2">AI 正在处理，请稍候…</span>
            </div>
          ) : (
            <div className="rounded-lg border border-gray-200 bg-white p-3">
              {diff?.map((part, i) => (
                <pre
                  key={i}
                  className={`whitespace-pre-wrap break-words font-sans ${
                    part.added
                      ? "rounded bg-emerald-50 text-emerald-800"
                      : part.removed
                        ? "rounded bg-red-50 text-red-700 line-through decoration-red-300"
                        : "text-gray-600"
                  }`}
                >
                  {part.value}
                </pre>
              ))}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-gray-200 px-5 py-3">
          <p className="flex items-center gap-1.5 text-xs text-gray-400">
            {loading ? null : changed ? (
              <>
                <TriangleAlert className="h-3.5 w-3.5 text-amber-400" />
                AI 结果与原文存在差异，请逐段确认
              </>
            ) : (
              <>AI 未对内容做出修改</>
            )}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="h-9 rounded-lg border border-gray-200 px-4 text-[13px] text-gray-600 hover:bg-gray-50"
            >
              放弃
            </button>
            <button
              type="button"
              disabled={loading || !changed}
              onClick={() => onApply(modified)}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-primary-600 px-4 text-[13px] font-medium text-white hover:bg-primary-700 disabled:opacity-40"
            >
              <Check className="h-4 w-4" />
              应用修改
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
