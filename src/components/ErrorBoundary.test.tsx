// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ErrorBoundary from "./ErrorBoundary";

afterEach(cleanup);

/** 受控的「会出错的子组件」：boom.current 为 true 时渲染抛错 */
const boom = { current: true };
function Bomb() {
  if (boom.current) throw new Error("渲染炸了：内部细节");
  return <p>正常内容</p>;
}

describe("ErrorBoundary", () => {
  it("子树正常时原样渲染", () => {
    boom.current = false;
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText("正常内容")).toBeTruthy();
  });

  it("子树出错时显示友好提示（带区域名），不暴露原始错误，技术详情默认折叠", () => {
    boom.current = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary scope="此文档">
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText("此文档暂时无法显示")).toBeTruthy();
    expect(screen.queryByText(/内部细节/)).toBeNull();
    fireEvent.click(screen.getByText("查看技术详情"));
    expect(screen.getByText(/内部细节/)).toBeTruthy();
    fireEvent.click(screen.getByText("隐藏技术详情"));
    expect(screen.queryByText(/内部细节/)).toBeNull();
  });

  it("点击「重试」后问题消除则恢复显示", () => {
    boom.current = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText("此区域暂时无法显示")).toBeTruthy();
    boom.current = false;
    fireEvent.click(screen.getByText("重试"));
    expect(screen.getByText("正常内容")).toBeTruthy();
  });
});
