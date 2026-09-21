import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { TriangleAlert, Info } from "lucide-react";

/**
 * 应用内对话框：替代原生 alert / confirm / prompt（与应用风格一致、可键盘操作、不阻塞 WebView）。
 * 用法：const dialog = useDialog(); if (await dialog.confirm({ message: "…" })) { … }
 */

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作：确认按钮使用警示色 */
  danger?: boolean;
}

interface PromptOptions {
  title?: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  /** 返回错误文案表示校验不通过（不关闭对话框） */
  validate?: (value: string) => string | null;
}

interface DialogApi {
  alert: (message: string, title?: string) => Promise<void>;
  confirm: (options: ConfirmOptions | string) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
}

type DialogRequest =
  | { kind: "alert"; title: string; message: string; resolve: () => void }
  | { kind: "confirm"; options: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void };

const DialogContext = createContext<DialogApi | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<DialogRequest[]>([]);

  const enqueue = useCallback((req: DialogRequest) => {
    setQueue((q) => [...q, req]);
  }, []);
  const dismiss = useCallback(() => setQueue((q) => q.slice(1)), []);

  const api = useMemo<DialogApi>(
    () => ({
      alert: (message, title = "提示") =>
        new Promise<void>((resolve) => enqueue({ kind: "alert", title, message, resolve })),
      confirm: (options) =>
        new Promise<boolean>((resolve) =>
          enqueue({
            kind: "confirm",
            options: typeof options === "string" ? { message: options } : options,
            resolve,
          }),
        ),
      prompt: (options) =>
        new Promise<string | null>((resolve) => enqueue({ kind: "prompt", options, resolve })),
    }),
    [enqueue],
  );

  const active = queue[0];

  return (
    <DialogContext.Provider value={api}>
      {children}
      {active && <DialogView key={queue.length + active.kind} request={active} onDone={dismiss} />}
    </DialogContext.Provider>
  );
}

function DialogView({ request, onDone }: { request: DialogRequest; onDone: () => void }) {
  const [value, setValue] = useState(request.kind === "prompt" ? (request.options.defaultValue ?? "") : "");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (request.kind === "prompt") {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      confirmRef.current?.focus();
    }
  }, [request.kind]);

  function finish(ok: boolean) {
    if (request.kind === "alert") {
      request.resolve();
    } else if (request.kind === "confirm") {
      request.resolve(ok);
    } else {
      if (ok) {
        const msg = request.options.validate?.(value) ?? null;
        if (msg) {
          setError(msg);
          return;
        }
        request.resolve(value);
      } else {
        request.resolve(null);
      }
    }
    onDone();
  }

  const title =
    request.kind === "alert"
      ? request.title
      : (request.options.title ?? (request.kind === "confirm" ? "请确认" : "输入"));
  const danger = request.kind === "confirm" && request.options.danger;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30"
      onKeyDown={(e) => {
        if (e.key === "Escape") finish(false);
      }}
    >
      <div role="dialog" aria-modal="true" className="w-[440px] max-w-[92vw] rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
              danger ? "bg-red-50 text-red-500" : "bg-primary-50 text-primary-600"
            }`}
          >
            {danger ? <TriangleAlert className="h-5 w-5" /> : <Info className="h-5 w-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold text-gray-900">{title}</h3>
            {request.kind !== "prompt" && (
              <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-gray-500">
                {request.kind === "alert" ? request.message : request.options.message}
              </p>
            )}
            {request.kind === "prompt" && (
              <div className="mt-2">
                {request.options.label && (
                  <label className="mb-1 block text-[13px] text-gray-500">{request.options.label}</label>
                )}
                <input
                  ref={inputRef}
                  value={value}
                  placeholder={request.options.placeholder}
                  onChange={(e) => {
                    setValue(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") finish(true);
                  }}
                  className="h-9 w-full rounded-lg border border-gray-200 px-3 text-sm outline-none focus:border-primary-500"
                />
                {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
              </div>
            )}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          {request.kind !== "alert" && (
            <button
              type="button"
              onClick={() => finish(false)}
              className="h-8 rounded-lg border border-gray-200 px-3 text-[13px] text-gray-600 hover:bg-gray-50"
            >
              {request.kind === "confirm" ? (request.options.cancelText ?? "取消") : "取消"}
            </button>
          )}
          <button
            ref={confirmRef}
            type="button"
            onClick={() => finish(true)}
            className={`h-8 rounded-lg px-3 text-[13px] font-medium text-white ${
              danger ? "bg-red-500 hover:bg-red-600" : "bg-primary-600 hover:bg-primary-700"
            }`}
          >
            {request.kind === "alert"
              ? "知道了"
              : request.kind === "confirm"
                ? (request.options.confirmText ?? "确定")
                : (request.options.confirmText ?? "确定")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog 必须在 DialogProvider 内使用");
  return ctx;
}
