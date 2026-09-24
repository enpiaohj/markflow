// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const getFileIcons = vi.fn();
vi.mock("../lib/api", () => ({ getFileIcons: (keys: string[]) => getFileIcons(keys) }));

// 图标缓存是模块级状态：每个用例重新加载模块，互不污染
let FileTypeIcon: typeof import("./FileTypeIcon").default;
beforeEach(async () => {
  vi.resetModules();
  getFileIcons.mockReset();
  FileTypeIcon = (await import("./FileTypeIcon")).default;
});
afterEach(cleanup);

describe("FileTypeIcon", () => {
  it("系统图标取到之前先显示内置图标，取到后换成系统图标", async () => {
    getFileIcons.mockResolvedValue({ docx: "data:image/png;base64,AAAA" });
    const { container } = render(<FileTypeIcon format="word" name="报告.docx" />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA"));
  });

  it("系统没有对应图标时保持内置图标，且同一扩展名不重复请求", async () => {
    getFileIcons.mockResolvedValue({});
    const { container, rerender } = render(<FileTypeIcon format="other" name="a.zzz" />);
    await waitFor(() => expect(getFileIcons).toHaveBeenCalledTimes(1));
    rerender(<FileTypeIcon format="other" name="b.zzz" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(getFileIcons).toHaveBeenCalledTimes(1);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("同一轮渲染里的多个新扩展名合并为一次请求", async () => {
    getFileIcons.mockResolvedValue({});
    render(
      <>
        <FileTypeIcon format="text" name="a.txt" />
        <FileTypeIcon format="markdown" name="b.md" />
        <FileTypeIcon format="text" name="c.txt" />
      </>,
    );
    await waitFor(() => expect(getFileIcons).toHaveBeenCalledTimes(1));
    expect([...getFileIcons.mock.calls[0][0]].sort()).toEqual(["md", "txt"]);
  });

  it("请求失败时回退内置图标，不抛错", async () => {
    getFileIcons.mockRejectedValue(new Error("ipc 失败"));
    const { container } = render(<FileTypeIcon format="pdf" name="a.pdf" />);
    await waitFor(() => expect(getFileIcons).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("不传文件名时只用内置图标，不请求系统图标", async () => {
    render(<FileTypeIcon format="markdown" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(getFileIcons).not.toHaveBeenCalled();
  });

  it("文件夹使用系统文件夹图标键", async () => {
    getFileIcons.mockResolvedValue({ "<folder>": "data:image/png;base64,BBBB" });
    const { container } = render(<FileTypeIcon format="directory" />);
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    expect(getFileIcons).toHaveBeenCalledWith(["<folder>"]);
  });
});
