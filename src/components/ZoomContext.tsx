import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export interface ZoomConfig {
  value: number;
  min: number;
  max: number;
  step: number;
  /** 当前主视图是否支持缩放（决定状态栏是否显示控件） */
  visible: boolean;
}

interface ZoomContextValue {
  config: ZoomConfig;
  /** 视图挂载时声明自己的缩放能力与范围 */
  configure: (patch: Partial<ZoomConfig>) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  setValue: (value: number) => void;
  /** 复位为 100% */
  reset: () => void;
}

const ZoomContext = createContext<ZoomContextValue | null>(null);

const DEFAULT_CONFIG: ZoomConfig = { value: 1, min: 0.5, max: 3, step: 0.1, visible: false };

const round = (v: number) => Math.round(v * 100) / 100;

/** 文档视图缩放（对应 Word 状态栏右下角缩放控件）：
 *  视图负责 configure 声明范围并在卸载时隐藏；StatusBar 负责渲染控件。 */
export function ZoomProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ZoomConfig>(DEFAULT_CONFIG);

  const configure = useCallback((patch: Partial<ZoomConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      next.value = Math.min(next.max, Math.max(next.min, round(next.value)));
      return next;
    });
  }, []);

  const zoomIn = useCallback(() => {
    setConfig((c) => ({ ...c, value: Math.min(c.max, round(c.value + c.step)) }));
  }, []);

  const zoomOut = useCallback(() => {
    setConfig((c) => ({ ...c, value: Math.max(c.min, round(c.value - c.step)) }));
  }, []);

  const setValue = useCallback((value: number) => {
    setConfig((c) => ({ ...c, value: Math.min(c.max, Math.max(c.min, round(value))) }));
  }, []);

  const reset = useCallback(() => {
    setConfig((c) => ({ ...c, value: 1 }));
  }, []);

  const value = useMemo(
    () => ({ config, configure, zoomIn, zoomOut, setValue, reset }),
    [config, configure, zoomIn, zoomOut, setValue, reset],
  );

  return <ZoomContext.Provider value={value}>{children}</ZoomContext.Provider>;
}

export function useZoom(): ZoomContextValue {
  const ctx = useContext(ZoomContext);
  if (!ctx) throw new Error("useZoom 必须在 ZoomProvider 内使用");
  return ctx;
}
