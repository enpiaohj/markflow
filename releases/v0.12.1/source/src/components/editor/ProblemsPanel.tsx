import { CircleAlert, TriangleAlert, CircleCheck } from "lucide-react";
import type { CodeIssue } from "./CodeEditor";

/**
 * 问题面板：列出当前文件的语法诊断（来自 lib/diagnostics.ts 的适配器），点击定位到出错位置。
 */
export default function ProblemsPanel({
  issues,
  supported,
  onGoto,
}: {
  issues: CodeIssue[];
  /** 当前语言是否有校验器（没有则说明「暂无诊断」而不是「没有问题」） */
  supported: boolean;
  onGoto: (offset: number) => void;
}) {
  return (
    <div className="flex h-full flex-col bg-white">
      <div className="border-b border-gray-100 px-4 py-3">
        <p className="text-[13px] font-semibold text-gray-900">问题</p>
        <p className="mt-0.5 text-[11px] text-gray-400">语法诊断（JSON / JSONC / YAML / XML），随输入自动刷新</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!supported ? (
          <p className="px-4 py-6 text-center text-xs text-gray-400">当前语言暂无语法诊断。可在状态栏切换语言。</p>
        ) : issues.length === 0 ? (
          <p className="flex items-center justify-center gap-1.5 px-4 py-6 text-xs text-emerald-600">
            <CircleCheck className="h-4 w-4" />
            没有发现问题
          </p>
        ) : (
          <ul>
            {issues.map((i, idx) => (
              <li key={`${i.from}-${idx}`}>
                <button
                  type="button"
                  onClick={() => onGoto(i.from)}
                  className="flex w-full items-start gap-2 border-b border-gray-50 px-4 py-2.5 text-left hover:bg-gray-50"
                >
                  {i.severity === "error" ? (
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                  ) : (
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  )}
                  <span className="min-w-0">
                    <span className="block break-words text-[12.5px] leading-snug text-gray-800">{i.message}</span>
                    <span className="mt-0.5 block text-[11px] text-gray-400">
                      第 {i.line} 行，第 {i.col} 列
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
