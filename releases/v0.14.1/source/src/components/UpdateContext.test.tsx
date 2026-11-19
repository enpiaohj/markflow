// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const checkMock = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: (...a: unknown[]) => checkMock(...a) }));

const dialogMock = { alert: vi.fn(async (_message: string, _title?: string) => {}), confirm: vi.fn(async () => true), prompt: vi.fn(), pick: vi.fn() };
vi.mock("./DialogContext", () => ({ useDialog: () => dialogMock }));

vi.mock("../lib/updatePolicy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/updatePolicy")>()),
  CHECK_RETRY_DELAYS_MS: [0, 0], // 测试里重试不真等待
}));

const libState = { editorDirty: false };
vi.mock("./LibraryContext", () => ({ useLibrary: () => libState }));

import { UpdateProvider, useUpdate } from "./UpdateContext";

function Probe() {
  const u = useUpdate();
  return (
    <div>
      <span data-testid="status">{u.status}</span>
      <span data-testid="ver">{u.info?.version ?? ""}</span>
      <span data-testid="notify">{String(u.notify)}</span>
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
    expect(checkMock).toHaveBeenCalledTimes(3); // 共 3 次尝试后才判定失败
  });

  it("偶发网络失败：自动重试后成功，不向用户报错", async () => {
    checkMock.mockRejectedValueOnce(new Error("抖动")).mockRejectedValueOnce(new Error("再抖")).mockResolvedValue(null);
    renderIt();
    fireEvent.click(screen.getByText("手动检查"));
    await waitFor(() => expect(dialogMock.alert).toHaveBeenCalledWith("当前已是最新版本。", "检查更新"));
    expect(checkMock).toHaveBeenCalledTimes(3);
    expect(dialogMock.alert).toHaveBeenCalledTimes(1);
  });

  it("发现新版本：显示版本与更新说明；跳过后记住该版本", async () => {
    checkMock.mockResolvedValue(fakeUpdate());
    renderIt();
    fireEvent.click(screen.getByText("手动检查"));
    await screen.findByText("发现新版本 v9.9.9");
    expect(screen.getByText(/在线更新/)).toBeTruthy();
    expect(screen.getByTestId("notify").textContent).toBe("true");
    fireEvent.click(screen.getByText("不再提示此版本"));
    expect(localStorage.getItem("mf-update-skipped-version")).toBe("9.9.9");
    expect(screen.queryByText("发现新版本 v9.9.9")).toBeNull();
    expect(screen.getByTestId("ver").textContent).toBe("9.9.9"); // 版本信息仍在，手动入口可再次打开
    expect(screen.getByTestId("notify").textContent).toBe("false"); // 但标题栏不再提示
  });

  it("启动自动检查：被跳过的版本不在标题栏提示（版本信息仍保留给「关于」页）", async () => {
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
    expect(screen.getByTestId("notify").textContent).toBe("false");
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

describe("UpdateProvider：更新说明显示", () => {
  it("对话框显示整理后的说明：标题译成中文、无 Markdown 标记", async () => {
    checkMock.mockResolvedValue({
      ...fakeUpdate(),
      body: ["### Added", "", "- **在线更新**：新增 `latest.json` 清单。", "### Fixed", "- 修复若干问题"].join("\n"),
    });
    renderIt();
    fireEvent.click(screen.getByText("手动检查"));
    await screen.findByText("发现新版本 v9.9.9");
    expect(screen.getByText("新增")).toBeTruthy();
    expect(screen.getByText("修复")).toBeTruthy();
    expect(screen.getByText("在线更新：新增 latest.json 清单。")).toBeTruthy();
    expect(document.body.textContent).not.toContain("###");
    expect(document.body.textContent).not.toContain("**");
  });
});

describe("UpdateProvider：自动检查时机", () => {
  afterEach(() => vi.useRealTimers());

  it("启动必检：即使刚检查过（1 分钟前）也会检查；发现新版本只亮标记，不弹对话框", async () => {
    vi.useFakeTimers();
    localStorage.setItem("mf-pref-auto-update-check", "1");
    localStorage.setItem("mf-update-last-check", String(Date.now() - 60_000));
    checkMock.mockResolvedValue(fakeUpdate());
    renderIt();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8100);
    });
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("notify").textContent).toBe("true");
    expect(screen.queryByText("发现新版本 v9.9.9")).toBeNull();
  });

  it("关闭自动检查：启动与复检都不检查", async () => {
    vi.useFakeTimers();
    localStorage.setItem("mf-pref-auto-update-check", "0");
    renderIt();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000);
    });
    expect(checkMock).not.toHaveBeenCalled();
  });

  it("运行期间每 6 小时复检：发现新版本只亮标记（info 有值），不弹对话框打断编辑", async () => {
    vi.useFakeTimers();
    localStorage.setItem("mf-pref-auto-update-check", "1");
    checkMock.mockResolvedValueOnce(null).mockResolvedValue(fakeUpdate());
    renderIt();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8100); // 启动检查：已是最新
    });
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("ver").textContent).toBe("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000); // 5 小时：未满周期
    });
    expect(checkMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(76 * 60 * 1000); // 累计超过 6 小时，并越过下一次 15 分钟轮询
    });
    expect(checkMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("ver").textContent).toBe("9.9.9");
    expect(screen.getByTestId("notify").textContent).toBe("true");
    expect(screen.queryByText("发现新版本 v9.9.9")).toBeNull();
  });

  it("自动检查进行中用户手动点检查：不被忽略，等检查结束后给出结果", async () => {
    vi.useFakeTimers();
    localStorage.setItem("mf-pref-auto-update-check", "1");
    let finish: (v: null) => void = () => {};
    checkMock.mockReturnValue(new Promise<null>((resolve) => (finish = resolve)));
    renderIt();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8100); // 自动检查开始，尚未返回
    });
    fireEvent.click(screen.getByText("手动检查"));
    expect(dialogMock.alert).not.toHaveBeenCalled();
    expect(checkMock).toHaveBeenCalledTimes(1); // 没有并发发起第二个请求
    await act(async () => {
      finish(null);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(dialogMock.alert).toHaveBeenCalledWith("当前已是最新版本。", "检查更新");
  });
});
