import { describe, expect, it, vi } from "vitest";
import { RECHECK_INTERVAL_MS, isRecheckDue, isSkippedVersion, withRetry } from "./updatePolicy";

describe("isRecheckDue", () => {
  const now = 1_000_000_000_000;
  it("关闭自动检查时从不复检", () => {
    expect(isRecheckDue(false, null, now)).toBe(false);
  });
  it("从未成功检查过则复检", () => {
    expect(isRecheckDue(true, null, now)).toBe(true);
  });
  it("周期内不复检，满周期后复检", () => {
    expect(isRecheckDue(true, now - RECHECK_INTERVAL_MS + 1, now)).toBe(false);
    expect(isRecheckDue(true, now - RECHECK_INTERVAL_MS, now)).toBe(true);
  });
  it("上次检查时间在未来（时钟回拨）按需要复检处理", () => {
    expect(isRecheckDue(true, now + 5000, now)).toBe(true);
  });
});

describe("isSkippedVersion", () => {
  it("只跳过被点过的同一版本", () => {
    expect(isSkippedVersion("0.13.0", "0.13.0")).toBe(true);
    expect(isSkippedVersion("0.13.0", "0.13.1")).toBe(false);
    expect(isSkippedVersion(null, "0.13.0")).toBe(false);
  });
});

describe("withRetry", () => {
  const noSleep = async () => {};

  it("第一次成功就不重试", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await withRetry(fn, [10, 20], noSleep)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("偶发失败后重试成功，按间隔等待", async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("网络抖动")).mockRejectedValueOnce(new Error("再抖一次")).mockResolvedValue("ok");
    const sleep = vi.fn(async (_ms: number) => {});
    expect(await withRetry(fn, [10, 20], sleep)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 20]);
  });

  it("全部失败才抛出最后一次的错误", async () => {
    const fn = vi.fn(async () => {
      throw new Error("一直失败");
    });
    await expect(withRetry(fn, [10, 20], noSleep)).rejects.toThrow("一直失败");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
