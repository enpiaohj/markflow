// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { apiMock, dialogMock } = vi.hoisted(() => ({
  apiMock: {
    listRecentFiles: vi.fn(),
    removeRecentFile: vi.fn(async (_p: string) => {}),
    clearRecentFiles: vi.fn(async () => {}),
  },
  dialogMock: { confirm: vi.fn(async () => true), alert: vi.fn(), prompt: vi.fn(), pick: vi.fn() },
}));
vi.mock("../lib/api", () => apiMock);
vi.mock("../components/DialogContext", () => ({ useDialog: () => dialogMock }));

vi.mock("../components/LibraryContext", () => ({
  useLibrary: () => ({
    libraries: [],
    current: null,
    switchToLibrary: vi.fn(),
    openWizard: vi.fn(),
    pickAndOpenFile: vi.fn(),
    openPath: vi.fn(),
    openManager: vi.fn(),
    requestView: vi.fn(),
  }),
}));
vi.mock("../components/FileTypeIcon", () => ({ default: () => <span /> }));

import HomeView from "./HomeView";

const recent = (names: string[]) => names.map((n, i) => ({ path: `D:/docs/${n}`, openedAt: 1_700_000_000_000 - i }));

beforeEach(() => {
  apiMock.listRecentFiles.mockReset();
  apiMock.removeRecentFile.mockClear();
  apiMock.clearRecentFiles.mockClear();
  dialogMock.confirm.mockReset();
  dialogMock.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

describe("开始页：最近打开的文件", () => {
  it("点移除只移除该项，并通知后端；其余保留", async () => {
    apiMock.listRecentFiles.mockResolvedValue(recent(["a.md", "b.md", "c.md"]));
    render(<HomeView />);
    await screen.findByText("a.md");
    fireEvent.click(screen.getAllByLabelText("从最近打开的文件中移除")[0]);
    await waitFor(() => expect(screen.queryByText("a.md")).toBeNull());
    expect(apiMock.removeRecentFile).toHaveBeenCalledWith("D:/docs/a.md");
    expect(screen.getByText("b.md")).toBeTruthy();
    expect(screen.getByText("c.md")).toBeTruthy();
  });

  it("超过 4 项时，移除一项后下一项补位显示", async () => {
    apiMock.listRecentFiles.mockResolvedValue(recent(["a.md", "b.md", "c.md", "d.md", "e.md"]));
    render(<HomeView />);
    await screen.findByText("a.md");
    expect(screen.queryByText("e.md")).toBeNull();
    fireEvent.click(screen.getAllByLabelText("从最近打开的文件中移除")[0]);
    await screen.findByText("e.md");
  });

  it("清空：确认后整个区块消失；取消则保持不变", async () => {
    apiMock.listRecentFiles.mockResolvedValue(recent(["a.md", "b.md"]));
    render(<HomeView />);
    await screen.findByText("a.md");

    dialogMock.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByText("清空"));
    await waitFor(() => expect(dialogMock.confirm).toHaveBeenCalled());
    expect(apiMock.clearRecentFiles).not.toHaveBeenCalled();
    expect(screen.getByText("a.md")).toBeTruthy();

    fireEvent.click(screen.getByText("清空"));
    await waitFor(() => expect(screen.queryByText("a.md")).toBeNull());
    expect(apiMock.clearRecentFiles).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("最近打开的文件")).toBeNull();
  });
});
