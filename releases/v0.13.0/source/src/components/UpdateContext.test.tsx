// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const checkMock = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: (...a: unknown[]) => checkMock(...a) }));

const dialogMock = { alert: vi.fn(async (_message: string, _title?: string) => {}), confirm: vi.fn(async () => true), prompt: vi.fn(), pick: vi.fn() };
vi.mock("./DialogContext", () => ({ useDialog: () => dialogMock }));

const libState = { editorDirty: false };
vi.mock("./LibraryContext", () => ({ useLibrary: () => libState }));

import { UpdateProvider, useUpdate } from "./UpdateContext";

function Probe() {
  const u = useUpdate();
  return (
    <div>
      <span data-testid="status">{u.status}</span>
      <span data-testid="ver">{u.info?.version ?? ""}</span>
      <button onClick={() => void u.checkNow()}>手动检查</button>
    </div>
  );
}

function renderIt() {
  return render(
    <UpdateProvider>
      <Probe />
    </UpdateProvider>,
  );
}

const fakeUpdate = (downloadAndInstall = vi.fn(async () => {})) => ({
  version: "9.9.9",
  body: "### 新增\n- 在线更新",
  date: "2026-12-01T00:00:00Z",
  downloadAndInstall,
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("mf-pref-auto-update-check", "0"); // 默认关闭启动自动检查，只测手动路径
  checkMock.mockReset();
  dialogMock.alert.mockClear();
  dialogMock.confirm.mockClear();
  libState.editorDirty = false;
});
afterEach(cleanup);

describe("UpdateProvider", () => {
  it("已是最新版本：手动检查给出明确提示，不弹更新对话框", async () => {
    checkMock.mockResolvedValue(null);
    renderIt();
    fireEvent.click(screen.getByText("手动检查"));
    await waitFor(() => expect(dialogMock.alert).toHaveBeenCalledWith("当前已是最新版本。", "检查更新"));
    expect(screen.queryByText(/发现新版本/)).toBeNull();
  });

  it("检查失败：手动检查提示友好文案，不暴露原始错误", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    checkMock.mockRejectedValue(new Error("404 internal detail"));
    renderIt();
    fireEvent.click(screen.getByText("手动检查"));
    await waitFor(() => expect(dialogMock.alert).toHaveBeenCalled());
    const msg = dialogMock.alert.mock.calls[0][0];
    expect(msg).toContain("无法检查更新");
    expect(msg).not.toContain("404");
  });

  it("发现新版本：显示版本与更新说明；跳过后记住该版本", async () => {
    checkMock.mockResolvedValue(fakeUpdate());
    renderIt();
    fireEvent.click(screen.getByText("手动检查"));
    await screen.findByText("发现新版本 v9.9.9");
    expect(screen.getByText(/在线更新/)).toBeTruthy();
    fireEvent.click(screen.getByText("跳过此版本"));
    expect(localStorage.getItem("mf-update-skipped-version")).toBe("9.9.9");
    expect(screen.queryByText("发现新版本 v9.9.9")).toBeNull();
    expect(screen.getByTestId("ver").textContent).toBe("9.9.9"); // 手动入口仍可再次打开
  });

  it("启动自动检查：已跳过的版本不再弹窗，但标题栏仍有可用更新信息", async () => {
    vi.useFakeTimers();
    localStorage.setItem("mf-pref-auto-update-check", "1");
    localStorage.setItem("mf-update-skipped-version", "9.9.9");
    checkMock.mockResolvedValue(fakeUpdate());
    renderIt();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8100);
    });
    vi.useRealTimers();
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("ver").textContent).toBe("9.9.9");
    expect(screen.queryByText("发现新版本 v9.9.9")).toBeNull();
  });

  it("有未保存修改时，更新前先确认；取消则不下载", async () => {
    const install = vi.fn(async () => {});
    checkMock.mockResolvedValue(fakeUpdate(install));
    libState.editorDirty = true;
    dialogMock.confirm.mockResolvedValueOnce(false);
    renderIt();
    fireEvent.click(screen.getByText("手动检查"));
    await screen.findByText("发现新版本 v9.9.9");
    fireEvent.click(screen.getByText("立即更新"));
    await waitFor(() => expect(dialogMock.confirm).toHaveBeenCalled());
    expect(install).not.toHaveBeenCalled();
  });

  it("安装失败：提示当前版本未受影响，可重试", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const install = vi.fn(async () => {
      throw new Error("signature mismatch");
    });
    checkMock.mockResolvedValue(fakeUpdate(install));
    renderIt();
    fireEvent.click(screen.getByText("手动检查"));
    await screen.findByText("发现新版本 v9.9.9");
    fireEvent.click(screen.getByText("立即更新"));
    await waitFor(() => expect(dialogMock.alert).toHaveBeenCalled());
    expect(dialogMock.alert.mock.calls[0][0]).toContain("当前版本未受影响");
    expect(screen.getByTestId("status").textContent).toBe("available");
  });
});
