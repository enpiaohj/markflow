import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as api from "../lib/api";
import type { RecentFile } from "../lib/types";
import { useDialog } from "./DialogContext";
import { useLibrary } from "./LibraryContext";
import type { LibraryMeta } from "../lib/types";
import { useZoom } from "./ZoomContext";

/** 编辑器等组件通过该事件响应菜单命令（保存等） */
export const MENU_SAVE_EVENT = "markflow:save";

interface MenuItem {
  label?: string;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  separator?: boolean;
  /** 子菜单（最近打开的文件） */
  children?: MenuItem[];
}

interface Menu {
  label: string;
  items: MenuItem[];
}

const SHORTCUTS_HELP = [
  "Ctrl + O　打开文件",
  "Ctrl + N　新建文档（在当前文档库根目录）",
  "Ctrl + S　保存",
  "Ctrl + W　关闭当前文档",
  "Ctrl + K　搜索",
  "Ctrl + + / Ctrl + − / Ctrl + 0　放大 / 缩小 / 实际大小",
  "Ctrl + 鼠标滚轮　缩放文档视图",
  "F11　全屏",
].join("\n");

function fileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

/**
 * 应用菜单栏（文件 / 编辑 / 查看 / 帮助）：窗口为无边框自绘，所以菜单也由应用自己提供。
 * 同时注册全局快捷键（Ctrl+O 打开文件、Ctrl+N 新建、缩放快捷键）。
 */
export default function MenuBar() {
  const {
    current,
    workspace,
    openFile,
    openWizard,
    pickAndOpenFile,
    openPath,
    requestView,
    requestSearchView,
    closeCurrentLibrary,
    openManager,
    viewerFile,
    deliveryOpen,
    closeDocument,
    confirmDiscard,
  } = useLibrary();
  const dialog = useDialog();
  const { config: zoom, zoomIn, zoomOut, reset } = useZoom();
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const newDocument = useCallback(async () => {
    // 多个文档库并列时先选定目标库（用库名区分）；只有一个库则直接使用它
    let lib: LibraryMeta | null = current && !current.settings?.adhoc ? current : (workspace[0] ?? null);
    if (workspace.length > 1) {
      const id = await dialog.pick({
        title: "新建文档",
        message: "选择要在哪个文档库中创建",
        items: workspace.map((l) => ({ value: l.id, label: l.name, hint: l.rootPath })),
        defaultValue: current?.id,
        confirmText: "下一步",
      });
      if (!id) return;
      lib = workspace.find((l) => l.id === id) ?? null;
    }
    if (!lib) {
      await dialog.alert("请先打开或创建一个文档库，再新建文档。也可以通过「文件 → 打开文件」直接编辑任意文件。");
      return;
    }
    const name = await dialog.prompt({
      title: `新建文档 · ${lib.name}`,
      label: `文件名（在「${lib.name}」的库根目录创建）`,
      defaultValue: "未命名.md",
      validate: (v) => (v.trim() ? null : "文件名不能为空"),
    });
    if (!name) return;
    try {
      const finalName = /\.[A-Za-z0-9]+$/.test(name.trim()) ? name.trim() : `${name.trim()}.md`;
      await api.createTextFile(lib.id, "", finalName, "");
      await openPath(`${lib.rootPath.replace(/[\\/]+$/, "")}/${finalName}`);
    } catch (err) {
      await dialog.alert(String(err), "新建失败");
    }
  }, [current, workspace, dialog, openPath]);

  const save = useCallback(() => window.dispatchEvent(new CustomEvent(MENU_SAVE_EVENT)), []);

  // 全局快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        void toggleFullscreen();
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "o") {
        e.preventDefault();
        void pickAndOpenFile();
      } else if (k === "w") {
        e.preventDefault();
        void closeDocument();
      } else if (k === "n") {
        e.preventDefault();
        void newDocument();
      } else if (k === "=" || k === "+") {
        if (zoom.visible) {
          e.preventDefault();
          zoomIn();
        }
      } else if (k === "-") {
        if (zoom.visible) {
          e.preventDefault();
          zoomOut();
        }
      } else if (k === "0") {
        if (zoom.visible) {
          e.preventDefault();
          reset();
        }
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !zoom.visible) return;
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel);
    };
  }, [pickAndOpenFile, newDocument, closeDocument, zoom.visible, zoomIn, zoomOut, reset]);

  // 打开「文件」菜单时刷新最近文件
  useEffect(() => {
    if (openMenu === 0) void api.listRecentFiles().then(setRecent).catch(() => setRecent([]));
  }, [openMenu]);

  // 点击菜单外部 / Esc 关闭
  useEffect(() => {
    if (openMenu === null) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [openMenu]);

  const exec = (cmd: string) => () => {
    document.execCommand(cmd);
  };

  const menus: Menu[] = [
    {
      label: "文件",
      items: [
        { label: "打开文件…", shortcut: "Ctrl+O", onClick: () => void pickAndOpenFile() },
        {
          label: "最近打开的文件",
          disabled: recent.length === 0,
          children: recent.map((r) => ({
            label: fileName(r.path),
            onClick: () => void openPath(r.path),
          })),
        },
        { separator: true },
        { label: "新建文档库…", onClick: openWizard },
        { label: "新建文档", shortcut: "Ctrl+N", onClick: () => void newDocument(), disabled: !current },
        { separator: true },
        { label: "保存", shortcut: "Ctrl+S", onClick: save, disabled: !openFile },
        { label: "关闭文档", shortcut: "Ctrl+W", onClick: () => void closeDocument(), disabled: !openFile && !viewerFile && !deliveryOpen },
        { label: "关闭当前文档库（保留在列表）", onClick: closeCurrentLibrary, disabled: !current },
        { label: "管理文档库…", onClick: () => { requestView("library"); openManager(); } },
        { separator: true },
        // 「退出」是真正退出（开启「关闭时最小化到通知区域」后，窗口的关闭按钮只会隐藏窗口）
        { label: "退出", shortcut: "Alt+F4", onClick: () => void confirmDiscard().then(async (ok) => { if (ok) await api.quitApp(); }) },
      ],
    },
    {
      label: "编辑",
      items: [
        { label: "撤销", shortcut: "Ctrl+Z", onClick: exec("undo") },
        { label: "重做", shortcut: "Ctrl+Y", onClick: exec("redo") },
        { separator: true },
        { label: "剪切", shortcut: "Ctrl+X", onClick: exec("cut") },
        { label: "复制", shortcut: "Ctrl+C", onClick: exec("copy") },
        { label: "粘贴", shortcut: "Ctrl+V", onClick: exec("paste") },
        { label: "全选", shortcut: "Ctrl+A", onClick: exec("selectAll") },
        { separator: true },
        { label: "在文档库中搜索…", shortcut: "Ctrl+K", onClick: requestSearchView },
      ],
    },
    {
      label: "查看",
      items: [
        { label: "开始", onClick: () => requestView("home") },
        { label: "文档库", onClick: () => requestView("library") },
        { label: "搜索", onClick: () => requestView("search") },
        { label: "任务", onClick: () => requestView("tasks") },
        { label: "历史", onClick: () => requestView("history") },
        { label: "设置", onClick: () => requestView("settings") },
        { separator: true },
        { label: "放大", shortcut: "Ctrl++", onClick: zoomIn, disabled: !zoom.visible },
        { label: "缩小", shortcut: "Ctrl+−", onClick: zoomOut, disabled: !zoom.visible },
        { label: "实际大小", shortcut: "Ctrl+0", onClick: reset, disabled: !zoom.visible },
        { separator: true },
        { label: "全屏", shortcut: "F11", onClick: () => void toggleFullscreen() },
      ],
    },
    {
      label: "帮助",
      items: [
        { label: "快捷键", onClick: () => void dialog.alert(SHORTCUTS_HELP, "快捷键") },
        {
          label: "关于 MarkFlow",
          onClick: () =>
            void api
              .appInfo()
              .then((info) =>
                dialog.alert(
                  `MarkFlow v${info.version}\n多格式本地文档库桌面应用\n\n本地优先 · 文件为真源 · 操作可恢复`,
                  "关于 MarkFlow",
                ),
              ),
        },
      ],
    },
  ];

  return (
    <div ref={rootRef} className="flex h-full items-center">
      {menus.map((menu, i) => (
        <div key={menu.label} className="relative">
          <button
            type="button"
            onClick={() => setOpenMenu(openMenu === i ? null : i)}
            onMouseEnter={() => openMenu !== null && setOpenMenu(i)}
            className={`h-7 rounded-md px-2.5 text-[13px] ${
              openMenu === i ? "bg-gray-100 text-gray-900" : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            {menu.label}
          </button>
          {openMenu === i && (
            <div className="absolute left-0 top-8 z-50 w-60 rounded-lg border border-gray-200 bg-white py-1 shadow-xl">
              {menu.items.map((item, j) =>
                item.separator ? (
                  <div key={j} className="my-1 h-px bg-gray-100" />
                ) : item.children ? (
                  <div key={j} className="group relative">
                    <div
                      className={`flex items-center justify-between px-3 py-1.5 text-[13px] ${
                        item.disabled ? "text-gray-300" : "text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      {item.label}
                      <span className="text-gray-400">›</span>
                    </div>
                    {!item.disabled && (
                      <div className="absolute left-full top-0 hidden max-h-80 w-64 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-xl group-hover:block">
                        {item.children.map((c, k) => (
                          <button
                            key={k}
                            type="button"
                            onClick={() => {
                              setOpenMenu(null);
                              c.onClick?.();
                            }}
                            className="block w-full truncate px-3 py-1.5 text-left text-[13px] text-gray-700 hover:bg-gray-50"
                          >
                            {c.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    key={j}
                    type="button"
                    disabled={item.disabled}
                    onClick={() => {
                      setOpenMenu(null);
                      item.onClick?.();
                    }}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px] text-gray-700 hover:bg-gray-50 disabled:text-gray-300 disabled:hover:bg-transparent"
                  >
                    <span>{item.label}</span>
                    {item.shortcut && <span className="ml-4 text-[11px] text-gray-400">{item.shortcut}</span>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

async function toggleFullscreen() {
  const win = getCurrentWindow();
  await win.setFullscreen(!(await win.isFullscreen()));
}
