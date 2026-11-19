import { describe, expect, it } from "vitest";
import { parseUpdateNotes } from "./updateNotes";

describe("parseUpdateNotes", () => {
  it("标题译成中文，去掉 Markdown 标记（粗体 / 反引号 / 链接）", () => {
    const md = "### Added\n\n- **最近文件可移除**：新增 `remove_recent_file`，详见 [说明](https://example.com)。";
    expect(parseUpdateNotes(md)).toEqual([
      { kind: "heading", text: "新增" },
      { kind: "bullet", text: "最近文件可移除：新增 remove_recent_file，详见 说明。" },
    ]);
  });

  it("缩进的续行并入上一条：中文直接连接，英文补空格", () => {
    const md = "- **滚动条**：悬浮滚动条\n  只在滚动时出现\n- fix the\n  scrollbar";
    expect(parseUpdateNotes(md)).toEqual([
      { kind: "bullet", text: "滚动条：悬浮滚动条只在滚动时出现" },
      { kind: "bullet", text: "fix the scrollbar" },
    ]);
  });

  it("未知标题保留原文；嵌套项作为独立条目；空行忽略", () => {
    const md = "### Something Else\n\n- 外层\n  - 内层一\n  - 内层二\n\n普通说明";
    expect(parseUpdateNotes(md)).toEqual([
      { kind: "heading", text: "Something Else" },
      { kind: "bullet", text: "外层" },
      { kind: "bullet", text: "内层一" },
      { kind: "bullet", text: "内层二" },
      { kind: "text", text: "普通说明" },
    ]);
  });

  it("空内容返回空数组", () => {
    expect(parseUpdateNotes("")).toEqual([]);
    expect(parseUpdateNotes("\n  \n")).toEqual([]);
  });
});
