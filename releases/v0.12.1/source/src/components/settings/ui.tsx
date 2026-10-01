import type { ReactNode } from "react";

/** 设置页统一的行：左边名称 + 一句说明，右边是控件；行与行用分隔线隔开 */
export function SettingRow({
  label,
  description,
  children,
  stacked,
}: {
  label: string;
  description?: ReactNode;
  children?: ReactNode;
  /** 控件较宽时放在说明下方 */
  stacked?: boolean;
}) {
  return (
    <div className={`px-4 py-3.5 ${stacked ? "" : "flex items-center gap-6"}`}>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-900">{label}</p>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-gray-500">{description}</p>}
      </div>
      {children && <div className={stacked ? "mt-2.5" : "shrink-0"}>{children}</div>}
    </div>
  );
}

/** 一组设置：小标题 + 圆角卡片，行之间自动分隔 */
export function SettingGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      {title && <h3 className="mb-2 px-1 text-xs font-medium tracking-wide text-gray-400">{title}</h3>}
      <div className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">{children}</div>
    </section>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${checked ? "bg-primary-600" : "bg-gray-300"}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { key: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-gray-200 p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
          className={`rounded-md px-3 py-1 text-xs transition-colors ${
            value === o.key ? "bg-primary-50 font-medium text-primary-700" : "text-gray-500 hover:bg-gray-50"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
