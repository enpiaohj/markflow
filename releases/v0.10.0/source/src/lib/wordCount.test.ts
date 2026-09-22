import { describe, expect, it } from "vitest";
import { countText } from "./wordCount";

describe("countText", () => {
  it("中文逐字、英文按词、忽略空白", () => {
    expect(countText("你好，世界").total).toBe(4);
    expect(countText("hello world foo_bar 123").total).toBe(4);
    expect(countText("MarkFlow 支持 12 种格式").total).toBe(1 + 2 + 1 + 3);
    expect(countText(" \n\t ").total).toBe(0);
  });
  it("chars 为非空白字符数", () => {
    expect(countText("a b\nc").chars).toBe(3);
  });
});
