import { mainNavItems, secondaryNavItems, type NavItem, type ViewId } from "../navigation";

function NavButton({
  item,
  active,
  onSelect,
}: {
  item: NavItem;
  active: boolean;
  onSelect: (id: ViewId) => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      title={item.label}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(item.id)}
      className={`flex h-11 w-11 items-center justify-center rounded-lg transition-colors ${
        active
          ? "bg-primary-50 text-primary-600"
          : "text-gray-500 hover:bg-gray-100 hover:text-gray-700"
      }`}
    >
      <Icon className="h-5 w-5" strokeWidth={active ? 2.2 : 2} />
    </button>
  );
}

/** 左侧常驻活动栏，宽度遵循设计文档 7.2 节（48–56 px） */
export default function ActivityBar({
  activeView,
  onSelect,
}: {
  activeView: ViewId;
  onSelect: (id: ViewId) => void;
}) {
  return (
    <nav className="flex w-[52px] shrink-0 flex-col items-center justify-between border-r border-gray-200 bg-white py-3">
      <div className="flex flex-col items-center gap-1">
        {mainNavItems.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={activeView === item.id}
            onSelect={onSelect}
          />
        ))}
      </div>
      <div className="flex flex-col items-center gap-1">
        {secondaryNavItems.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={activeView === item.id}
            onSelect={onSelect}
          />
        ))}
      </div>
    </nav>
  );
}
