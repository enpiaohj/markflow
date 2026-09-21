import {
  FolderOpen,
  History,
  Home,
  ListTodo,
  Search,
  Settings,
  Share2,
  type LucideIcon,
} from "lucide-react";

/** 一级导航标识，对应设计文档 7.1 节信息架构 */
export type ViewId =
  | "home"
  | "library"
  | "search"
  | "graph"
  | "tasks"
  | "history"
  | "settings";

export interface NavItem {
  id: ViewId;
  label: string;
  icon: LucideIcon;
}

/** 活动栏上部分组：主要工作区 */
export const mainNavItems: NavItem[] = [
  { id: "home", label: "开始", icon: Home },
  { id: "library", label: "文档库", icon: FolderOpen },
  { id: "search", label: "搜索", icon: Search },
  { id: "graph", label: "关系图", icon: Share2 },
];

/** 活动栏下部分组：任务与系统 */
export const secondaryNavItems: NavItem[] = [
  { id: "tasks", label: "任务", icon: ListTodo },
  { id: "history", label: "历史", icon: History },
  { id: "settings", label: "设置", icon: Settings },
];
