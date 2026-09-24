import { describe, expect, it } from "vitest";
import { iconKeyForName } from "./sysIcons";

describe("iconKeyForName", () => {
  it("取小写扩展名；无扩展名 / 隐藏文件 / 以点结尾返回空串", () => {
    expect(iconKeyForName("报告.DOCX")).toBe("docx");
    expect(iconKeyForName("a.tar.gz")).toBe("gz");
    expect(iconKeyForName("README")).toBe("");
    expect(iconKeyForName(".gitignore")).toBe("");
    expect(iconKeyForName("weird.")).toBe("");
  });
});
