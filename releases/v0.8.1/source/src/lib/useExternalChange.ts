import { useEffect, useRef } from "react";
import * as api from "./api";

/**
 * 外部修改检测：窗口重新获得焦点时比较文件 mtime，变化则调用 onChange（如 Word / Excel 保存后回到 MarkFlow）。
 * 基线在挂载时读取；触发后基线更新，避免重复触发。
 */
export function useExternalChange(libraryId: string | undefined, relativePath: string, onChange: () => void, enabled = true) {
  const baseRef = useRef<number | null>(null);
  const cbRef = useRef(onChange);
  cbRef.current = onChange;

  useEffect(() => {
    if (!enabled || !libraryId || !relativePath) return;
    let disposed = false;
    baseRef.current = null;
    void api
      .statFileMtime(libraryId, relativePath)
      .then((m) => {
        if (!disposed) baseRef.current = m;
      })
      .catch(() => {});
    const onFocus = () => {
      void api
        .statFileMtime(libraryId, relativePath)
        .then((m) => {
          if (disposed || m === 0 || baseRef.current === null) return;
          if (m !== baseRef.current) {
            baseRef.current = m;
            cbRef.current();
          }
        })
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [libraryId, relativePath, enabled]);
}
