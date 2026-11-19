import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface ZoomConfig {
  value: number;
  min: number;
  max: number;
  step: number;
  /** 当前主视图是否支持缩放（决定状态栏是否显示控件） */
  visible: boolean;
  /** 预置缩放档位（状态栏百分比下拉）；未指定时使用通用档位并按 min/max 过滤 */
  presets?: number[];
}

/** 通用预置档位（对应 Word 缩放对话框常用值） */
export const DEFAULT_ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function zoomPresets(config: ZoomConfig): number[] {
  const list = config.presets ?? DEFAULT_ZOOM_PRESETS;
  return list.filter((v) => v >= config.min - 1e-6 && v <= config.max + 1e-6);
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

/**
 * 标签作用域内的缩放：多个文档面板同时挂载时，只有激活标签的 configure 才作用到状态栏；
 * 非激活标签的声明先记下，切回该标签时重放，避免隐藏面板的挂载 / 卸载抢占状态栏的缩放控件。
 */
export function ZoomScope({ active, children }: { active: boolean; children: ReactNode }) {
  const base = useZoom();
  const lastRef = useRef<Partial<ZoomConfig> | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const baseConfigure = base.configure;

  const configure = useCallback(
    (patch: Partial<ZoomConfig>) => {
      lastRef.current = { ...(lastRef.current ?? {}), ...patch };
      if (activeRef.current) baseConfigure(patch);
    },
    [baseConfigure],
  );

  useEffect(() => {
    if (!active) return;
    if (lastRef.current) baseConfigure(lastRef.current);
    // 离开该标签（切走 / 关闭）时隐藏缩放控件，由下一个激活的标签重新声明
    return () => baseConfigure({ visible: false });
  }, [active, baseConfigure]);

  const value = useMemo(() => ({ ...base, configure }), [base, configure]);
  return <ZoomContext.Provider value={value}>{children}</ZoomContext.Provider>;
}
