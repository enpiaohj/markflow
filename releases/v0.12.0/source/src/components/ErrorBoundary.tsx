import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";

/**
 * 错误边界：子树渲染出错时只在该区域显示提示，不让整个窗口白屏。
 * 用在每个文档标签、主视图区与应用最外层——某个文档或视图出错时，其他标签与导航照常可用。
 * 「重试」重新渲染该区域；按需加载的模块下载失败（如开发中切换版本）时用「重新加载」。
 */
export default class ErrorBoundary extends Component<
  { children: ReactNode; /** 区域名称，用于提示文案，如「此文档」「此视图」 */ scope?: string },
  { error: Error | null; showDetail: boolean }
> {
  state = { error: null as Error | null, showDetail: false };

  static getDerivedStateFromError(error: Error) {
    return { error, showDetail: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("界面渲染出错", error, info.componentStack);
  }

  render() {
    const { error, showDetail } = this.state;
    if (!error) return this.props.children;
    const scope = this.props.scope ?? "此区域";
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <TriangleAlert className="h-8 w-8 text-amber-400" />
        <p className="mt-3 text-sm font-medium text-gray-800">{scope}暂时无法显示</p>
        <p className="mt-1 max-w-md text-xs leading-relaxed text-gray-500">
          出现了意外错误，其他文档与功能不受影响。可以重试；如仍无法显示，请重新加载窗口。
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-primary-600 px-3 text-xs font-medium text-white hover:bg-primary-700"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            重试
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="h-8 rounded-lg border border-gray-200 bg-white px-3 text-xs text-gray-600 hover:bg-gray-50"
          >
            重新加载窗口
          </button>
        </div>
        <button
          type="button"
          onClick={() => this.setState({ showDetail: !showDetail })}
          className="mt-4 text-[11px] text-gray-400 hover:text-gray-600"
        >
          {showDetail ? "隐藏技术详情" : "查看技术详情"}
        </button>
        {showDetail && (
          <pre className="mt-2 max-h-40 max-w-xl overflow-auto whitespace-pre-wrap break-all rounded-lg bg-gray-50 px-3 py-2 text-left text-[11px] text-gray-500">
            {error.message}
          </pre>
        )}
      </div>
    );
  }
}
