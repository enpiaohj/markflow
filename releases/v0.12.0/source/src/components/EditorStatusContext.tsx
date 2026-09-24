import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/** 编辑器向状态栏发布的信息：字数、光标位置（仅源码模式有行列） */
export interface EditorStatus {
  total: number;
  chars: number;
  line?: number;
  col?: number;
  /** 代码编辑信息（仅文本 / 代码类文件） */
  code?: {
    language: string;
    encoding: string;
    /** 保存时将转换为该编码 / 换行符（用户显式选择后才有值） */
    pendingEncoding?: string | null;
    eol: "CRLF" | "LF";
    pendingEol?: "CRLF" | "LF" | null;
    indent: string;
    readOnly: boolean;
    largeMode: boolean;
    saveState: "saved" | "dirty" | "saving" | "error";
    errors: number;
    warnings: number;
    onPickLanguage: () => void;
    onPickEncoding: () => void;
    onPickEol: () => void;
    onShowProblems: () => void;
  };
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
