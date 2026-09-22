import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/** 编辑器向状态栏发布的信息：字数、光标位置（仅源码模式有行列） */
export interface EditorStatus {
  total: number;
  chars: number;
  line?: number;
  col?: number;
}

interface Ctx {
  status: EditorStatus | null;
  publish: (s: EditorStatus | null) => void;
}

const EditorStatusContext = createContext<Ctx | null>(null);

export function EditorStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<EditorStatus | null>(null);
  const publish = useCallback((s: EditorStatus | null) => setStatus(s), []);
  const value = useMemo(() => ({ status, publish }), [status, publish]);
  return <EditorStatusContext.Provider value={value}>{children}</EditorStatusContext.Provider>;
}

export function useEditorStatus(): Ctx {
  const ctx = useContext(EditorStatusContext);
  if (!ctx) throw new Error("useEditorStatus 必须在 EditorStatusProvider 内使用");
  return ctx;
}
