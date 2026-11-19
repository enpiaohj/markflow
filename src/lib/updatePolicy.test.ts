import { describe, expect, it } from "vitest";
import { AUTO_CHECK_INTERVAL_MS, isSkippedVersion, shouldAutoCheck } from "./updatePolicy";

describe("shouldAutoCheck", () => {
  const now = 1_000_000_000_000;
  it("关闭自动检查时从不检查", () => {
    expect(shouldAutoCheck(false, null, now)).toBe(false);
  });
  it("从未检查过则检查", () => {
    expect(shouldAutoCheck(true, null, now)).toBe(true);
  });
  it("间隔内不重复检查，到达间隔后检查", () => {
    expect(shouldAutoCheck(true, now - AUTO_CHECK_INTERVAL_MS + 1, now)).toBe(false);
    expect(shouldAutoCheck(true, now - AUTO_CHECK_INTERVAL_MS, now)).toBe(true);
  });
  it("上次检查时间在未来（时钟回拨）按需要检查处理", () => {
    expect(shouldAutoCheck(true, now + 5000, now)).toBe(true);
  });
});

describe("isSkippedVersion", () => {
  it("只跳过被点过的同一版本", () => {
    expect(isSkippedVersion("0.13.0", "0.13.0")).toBe(true);
    expect(isSkippedVersion("0.13.0", "0.13.1")).toBe(false);
    expect(isSkippedVersion(null, "0.13.0")).toBe(false);
  });
});
