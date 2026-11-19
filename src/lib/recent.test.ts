import { beforeEach, describe, expect, it, vi } from "vitest";

const clearMock = vi.fn(async () => {});
vi.mock("./api", () => ({ clearRecentFiles: () => clearMock() }));

import { confirmClearRecentFiles } from "./recent";

beforeEach(() => clearMock.mockClear());

describe("confirmClearRecentFiles", () => {
  it("确认后清空，并在文案里说明不会删除文件", async () => {
    const confirm = vi.fn(async (_o: { title?: string; message: string; confirmText?: string }) => true);
    expect(await confirmClearRecentFiles({ confirm })).toBe(true);
    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0].message).toContain("不会删除任何文件");
  });

  it("取消则不清空", async () => {
    const confirm = vi.fn(async (_o: { message: string }) => false);
    expect(await confirmClearRecentFiles({ confirm })).toBe(false);
    expect(clearMock).not.toHaveBeenCalled();
  });
});
