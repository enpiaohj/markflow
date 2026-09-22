import { describe, expect, it } from "vitest";
import { lineColOf, offsetOf, validateDocument } from "./diagnostics";

describe("位置换算", () => {
  it("行列 ↔ 偏移互逆", () => {
    const t = "ab\ncde\nf";
    expect(offsetOf(t, 2, 2)).toBe(4);
    expect(lineColOf(t, 4)).toEqual({ line: 2, col: 2 });
    expect(lineColOf(t, 0)).toEqual({ line: 1, col: 1 });
    expect(offsetOf(t, 99, 1)).toBe(t.length);
  });
});

describe("JSON / JSONC", () => {
  it("合法 JSON 无问题，空文档无问题", async () => {
    expect(await validateDocument("json", '{"a": [1, 2, {"b": null}]}')).toEqual([]);
    expect(await validateDocument("json", "  \n")).toEqual([]);
  });

  it("错误带行列定位", async () => {
    const text = '{\n  "a": 1,\n  "b": ,\n}';
    const issues = await validateDocument("json", text);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].message).toMatch(/第 3 行，第 8 列/);
    expect(text.slice(issues[0].from, issues[0].to)).toBe(",");
  });

  it("JSONC 容忍注释与尾逗号；字符串里的 // 不是注释；严格 JSON 不容忍", async () => {
    const text = '{\n  // 注释\n  "a": 1, /* x */\n  "b": [1, 2,],\n}';
    expect(await validateDocument("jsonc", text)).toEqual([]);
    expect(await validateDocument("jsonc", '{"url": "http://a.b/c"}')).toEqual([]);
    expect((await validateDocument("json", text)).length).toBe(1);
  });
});

describe("JSON 各类错误都能定位", () => {
  const first = async (text: string, kind: "json" | "jsonc" = "json") => (await validateDocument(kind, text))[0];

  it("常见错误类型", async () => {
    expect((await first('{"a": 1')).message).toMatch(/文件结尾/);
    expect((await first("{'a': 1}")).message).toMatch(/期望属性名/);
    expect((await first('{"a" 1}')).message).toMatch(/期望「:」/);
    expect((await first("[1 2]")).message).toMatch(/期望「,」或「]」/);
    expect((await first('{"a": 1} x')).message).toMatch(/多余内容/);
    expect((await first('{"a": "未闭合}')).message).toMatch(/字符串没有闭合/);
    expect((await first('{"a": tru}')).message).toMatch(/意外的/);
    expect((await first('{"a": "\\q"}')).message).toMatch(/转义/);
    expect((await first('{"a": 1 /* 未闭合', "jsonc")).message).toMatch(/注释未闭合/);
  });

  it("大文档定位仍然准确", async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => `  {"id": ${i}, "名称": "项目${i}"}`).join(",\n");
    const text = `[\n${rows},\n  {"id": }\n]`;
    const issue = (await validateDocument("json", text))[0];
    expect(lineColOf(text, issue.from).line).toBe(2002);
  });
});

describe("YAML", () => {
  it("合法无问题；错误带位置", async () => {
    expect(await validateDocument("yaml", "a: 1\nb:\n  - x\n  - y\n")).toEqual([]);
    const bad = await validateDocument("yaml", "a: 1\na: 2\nb: [1, 2\n");
    expect(bad.length).toBeGreaterThan(0);
    expect(bad[0].message).toMatch(/YAML/);
    expect(bad[0].message).toMatch(/第 \d+ 行/);
  });
});

describe("适配器边界", () => {
  it("没有校验器的语言不产生问题", async () => {
    expect(await validateDocument(undefined, "任何内容 {{{")).toEqual([]);
  });
});
