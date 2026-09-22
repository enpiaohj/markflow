import type { LucideIcon } from "lucide-react";

/** 通用占位视图：用于 v0.1 尚未实现的导航页，说明规划中的能力 */
export default function PlaceholderView({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-100 text-gray-400">
        <Icon className="h-8 w-8" />
      </span>
      <h2 className="mt-4 text-lg font-semibold text-gray-900">{title}</h2>
      <p className="mt-2 max-w-md text-center text-[13px] leading-relaxed text-gray-500">
        {description}
      </p>
      <span className="mt-4 rounded-full bg-gray-100 px-2.5 py-1 text-[11px] text-gray-500">
        规划中，按路线图后续交付
      </span>
    </div>
  );
}
