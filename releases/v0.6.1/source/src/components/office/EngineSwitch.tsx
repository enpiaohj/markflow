import { Loader2 } from "lucide-react";

/**
 * Word / PowerPoint 预览引擎切换：内置渲染 ⇄ Office（或 LibreOffice）精确版式。
 * 只切换当前这份文档的显示方式；全局默认在「设置 → Word / PowerPoint 预览引擎」中选择。
 */
export default function EngineSwitch({
  builtin,
  officeLabel,
  busy,
  onBuiltin,
  onOffice,
}: {
  /** 当前是否为内置渲染 */
  builtin: boolean;
  /** 右侧按钮文案，如「Office 版式」「LibreOffice 版式」 */
  officeLabel: string;
  /** 精确版式正在后台生成 */
  busy?: boolean;
  onBuiltin: () => void;
  onOffice: () => void;
}) {
  const base = "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors";
  return (
    <div
      className="flex items-center rounded-lg border border-gray-200 bg-white p-0.5"
      title="切换预览方式（只影响当前文档；默认方式在「设置」中选择）"
      role="group"
      aria-label="预览方式"
    >
      <button
        type="button"
        onClick={onBuiltin}
        aria-pressed={builtin}
        className={`${base} ${builtin ? "bg-primary-50 font-medium text-primary-700" : "text-gray-500 hover:bg-gray-50"}`}
      >
        内置渲染
      </button>
      <button
        type="button"
        onClick={onOffice}
        aria-pressed={!builtin}
        className={`${base} ${!builtin ? "bg-primary-50 font-medium text-primary-700" : "text-gray-500 hover:bg-gray-50"}`}
      >
        {busy && <Loader2 className="h-3 w-3 animate-spin" />}
        {officeLabel}
      </button>
    </div>
  );
}
